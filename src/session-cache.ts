/**
 * Process-local cache for the COLD session reads the changes tab's
 * `changes.ops` route makes: every poll for a session that is not live in
 * `ctx.sessions` used to re-open the persisted log and re-parse the whole
 * JSONL — for a finished session that parse returns the same bytes every
 * 2.5 s, forever. The wire protocol is untouched: route name, payload and
 * response shape stay byte-identical, so the client neither knows nor cares
 * whether an answer came from this cache.
 *
 * Two validation regimes, chosen per request by what the host exposes:
 *
 * - Revision-guarded entries (preferred): the host persistence service
 *   carries `stat(id)` — a lightweight observation whose `revision` is a
 *   backend-owned change token (dev:ino:size:mtimeNs:ctimeNs on the JSONL
 *   backend), documented by the host as existing "for derived read-model
 *   caches keyed off stat/list". Equal revision ⇒ unchanged log ⇒ the cached
 *   parse is served; unequal (or unreadable) ⇒ re-read in the foreground, so
 *   a refresh never lags an append that already happened. The plugin cannot
 *   stat the artifact itself — the service exposes no file path — so this
 *   sanctioned token IS the stat check. Revisions are comparable only within
 *   one service instance, which the per-service WeakMap below guarantees.
 * - TTL entries (fallback, hosts without `stat`): a 5-minute window. The
 *   reasoning: a session answered from here is BY DEFINITION not in
 *   `ctx.sessions` — the route checks the live snapshot first — and a session
 *   that is not live is one the host is not appending to. If it is ever
 *   revived, it returns to `ctx.sessions` and the live path bypasses this
 *   cache entirely, so the TTL can only go stale for a cross-process writer,
 *   which this single-process plugin does not otherwise observe either.
 *
 * Shared discipline with ./git-cache.ts: LRU-bounded (32 sessions — a parsed
 * log is a real memory footprint), in-flight deduped (the 2.5 s poll must not
 * stampede a slow parse), failures never cached, and ANY cache-machinery
 * failure falls back to the direct read — the exact pre-cache behavior.
 * Callers must treat the returned event array as immutable: it is shared
 * across polls (the route only `filter`s it, and the subtree merge copies
 * before renumbering).
 */
import { readPersistedSession, type PersistedSession } from './session-store.ts'
import type { SidebarSessionPersistenceService } from './context-types.ts'

/** Entries held at most per service (one entry ≈ one parsed session log; the
 *  changes tab polls one root plus its subtree — a few dozen at the extreme). */
const SESSION_CACHE_MAX_ENTRIES = 32

/** Fallback freshness window when the host has no `stat` to consult. Five
 *  minutes: long enough to make a finished session's idle polls free, short
 *  enough to bound any cross-process staleness this process cannot see. */
const SESSION_CACHE_TTL_MS = 5 * 60_000

/** One cached cold read. `revision` is `null` when the entry is TTL-validated
 *  (host without `stat`) or the token was unreadable at compute time — such
 *  entries fall back to the TTL window, never to "forever". */
interface SessionCacheEntry {
  session: PersistedSession
  /** The host revision token observed BEFORE the read (see module doc: token
   *  first, read second, so the entry's content is never older than its
   *  token and an equal re-check cannot serve a stale log). */
  revision: string | null
  /** Age anchor for the TTL fallback (`Date.now()` at compute). */
  at: number
}

/** Per-service cache state. A cordis service replacement yields a different
 *  service object and therefore a fresh state — the safest reading of "a
 *  revision is comparable only against revisions from the same instance". */
interface ServiceCacheState {
  entries: Map<string, SessionCacheEntry>
  /** One shared computation per session: concurrent polls (root + a subtree
   *  walk hitting the same child) must not parse the same log twice. */
  inflight: Map<string, Promise<PersistedSession>>
  /** Whether the host exposed `stat` (feature-detected once per service). */
  statAvailable: boolean
}

const serviceCaches = new WeakMap<SidebarSessionPersistenceService, ServiceCacheState>()

/** Counters for manual verification — what the cache actually did. */
export interface SessionCacheStats {
  services: number
  entries: number
  /** Requests answered from a validated entry (one `stat` call, no parse). */
  hits: number
  /** TTL-fresh answers on a host without `stat`. */
  ttlHits: number
  /** Requests that had to read + parse in the foreground. */
  misses: number
  /** Concurrent same-session reads that shared one in-flight computation. */
  deduped: number
}

const stats: SessionCacheStats = { services: 0, entries: 0, hits: 0, ttlHits: 0, misses: 0, deduped: 0 }

/** A snapshot of the counters above (for manual observation). */
export function sessionCacheStats(): SessionCacheStats {
  let entries = 0
  for (const state of serviceCaches.values()) entries += state.entries.size
  return { ...stats, services: serviceCaches.size, entries }
}

/** Forget every cached answer (manual observation only). */
export function clearSessionCache(): void {
  // A WeakMap cannot be cleared wholesale; drop each state's entries.
  for (const state of serviceCaches.values()) {
    state.entries.clear()
    state.inflight.clear()
  }
}

/** The cache state of one service, created (and counted) on first use. */
function stateOf(persistence: SidebarSessionPersistenceService): ServiceCacheState {
  let state = serviceCaches.get(persistence)
  if (state === undefined) {
    state = {
      entries: new Map(),
      inflight: new Map(),
      statAvailable: typeof (persistence as { stat?: unknown }).stat === 'function',
    }
    serviceCaches.set(persistence, state)
    stats.services += 1
  }
  return state
}

/**
 * The host's revision token for one session, read through the feature-detected
 * `stat`. Returns `null` when the host has no `stat`, the session is absent,
 * or the token is not a string — every case degrades the caller to the TTL
 * regime (or to a re-read).
 */
async function revisionOf(
  persistence: SidebarSessionPersistenceService,
  sessionId: string,
): Promise<string | null> {
  const stat = (persistence as { stat?: (id: string) => Promise<{ revision?: unknown } | undefined> }).stat
  if (typeof stat !== 'function') return null
  const snapshot = await stat.call(persistence, sessionId)
  if (snapshot === undefined || snapshot === null) return null
  return typeof snapshot.revision === 'string' ? snapshot.revision : null
}

/** Store one parsed session under the LRU discipline (refresh-then-evict, so
 *  the OLDEST key is the one dropped). */
function store(state: ServiceCacheState, sessionId: string, entry: SessionCacheEntry): void {
  state.entries.delete(sessionId)
  if (state.entries.size >= SESSION_CACHE_MAX_ENTRIES) {
    const oldest = state.entries.keys().next()
    if (!oldest.done) state.entries.delete(oldest.value)
  }
  state.entries.set(sessionId, entry)
}

/**
 * Read one persisted session through the cache — the drop-in twin of
 * {@link readPersistedSession} for the changes route's cold path.
 *
 * - A cached entry whose revision matches the host's current token is served
 *   as-is (LRU-touched): the poll pays one `stat`, not one JSONL parse.
 * - A cached entry without a revision (no `stat` on this host) is served
 *   while younger than {@link SESSION_CACHE_TTL_MS}.
 * - Anything else (cold session, moved revision, `stat` failure) re-reads in
 *   the foreground, deduplicating concurrent same-session reads.
 * - Any cache-machinery failure falls back to the direct read — the exact
 *   pre-cache behavior; a genuinely failed read still REJECTS, exactly like
 *   the uncached twin (the route's catch turns that into an empty window).
 */
export async function readPersistedSessionCached(
  persistence: SidebarSessionPersistenceService,
  sessionId: string,
): Promise<PersistedSession> {
  let state: ServiceCacheState
  try {
    state = stateOf(persistence)
  } catch {
    return readPersistedSession(persistence, sessionId)
  }
  const cached = state.entries.get(sessionId)
  if (cached !== undefined) {
    try {
      if (state.statAvailable) {
        const revision = await revisionOf(persistence, sessionId)
        // A null token here (absent session, `stat` hiccup) deliberately
        // misses: an absent session must re-reject like the direct read, and
        // a hiccuped check must not serve a log it could not validate.
        if (revision !== null && cached.revision === revision) {
          store(state, sessionId, cached)
          stats.hits += 1
          return cached.session
        }
      } else if (Date.now() - cached.at < SESSION_CACHE_TTL_MS) {
        store(state, sessionId, cached)
        stats.ttlHits += 1
        return cached.session
      }
    } catch {
      // Validation itself failed: fall through to the foreground read, which
      // is the pre-cache answer for "I cannot tell whether this changed".
    }
  }
  const pending = state.inflight.get(sessionId)
  if (pending !== undefined) {
    stats.deduped += 1
    return pending
  }
  stats.misses += 1
  const promise = (async () => {
    // Token FIRST, read second: the token then bounds the read from below, so
    // an equal re-check later can never serve a log that grew since. (The
    // storage contract is append-only — events are never rewritten.)
    const revision = await revisionOf(persistence, sessionId).catch(() => null)
    const session = await readPersistedSession(persistence, sessionId)
    store(state, sessionId, { session, revision, at: Date.now() })
    return session
  })()
  state.inflight.set(sessionId, promise)
  return promise.finally(() => { state.inflight.delete(sessionId) })
}
