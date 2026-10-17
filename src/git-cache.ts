/**
 * Process-local cache for the git READ routes the changes tab hammers on every
 * open/refresh/poll: `git.worktrees`, `git.branch`, `git.log`,
 * `git.commit-diff` and `git.diff-range`. The wire protocol is untouched —
 * route names, payloads and response shapes stay byte-identical, so the client
 * neither knows nor cares whether an answer came from this cache.
 *
 * Three mechanisms, all best-effort with a direct-recompute fallback:
 *
 * - HEAD-guarded entries: every entry remembers the `git rev-parse HEAD` of the
 *   repository root it was computed at. A later request re-reads HEAD (through
 *   a 1.5 s micro-cache so a burst of routes shares one rev-parse) and serves
 *   the entry only while the sha matches. HEAD moved → recompute in the
 *   foreground, so a refresh never lags a commit that already happened.
 * - Volatile entries (`git.worktrees`, `git.diff-range`): their result depends
 *   on WORKTREE file content, not only on HEAD — change counts and the
 *   worktree-vs-rev patch move with every edit, commit or not. These add a
 *   10 s TTL and answer stale-while-revalidate once it expires: the previous
 *   answer goes out immediately (the lens keeps painting) while one background
 *   recompute backfills the cache for the next call.
 * - LRU bound + in-flight dedupe: at most {@link GIT_CACHE_MAX_ENTRIES}
 *   answers are held (a huge diff patch must not balloon the heap), and
 *   concurrent requests for one key share a single computation instead of
 *   stampeding `git` subprocesses.
 *
 * Mutating routes (`git.stage` / `git.unstage` / `git.commit` / `git.push` /
 * `git.pull` / `git.checkout` / `git.discard` / `git.revert` /
 * `git.cherry-pick`) drop every entry of the repository they ran on
 * ({@link invalidateGitCacheFor}), so a panel-driven change is visible on the
 * very next read. Out-of-band changes (the agent committing in a terminal) are
 * caught by the HEAD guard on the next read after the micro-cache window.
 *
 * Nothing here may break a route: every cache-machinery failure (a failed
 * rev-parse, an impossible state) falls back to calling the underlying git
 * function directly, which is exactly the pre-cache behavior.
 */
import { resolve } from 'node:path'
import * as git from './git.ts'

/** Entries held at most (one answer ≈ one route+repo+params key; a handful of
 *  worktrees × a few filters × paging pages stays far below this). */
const GIT_CACHE_MAX_ENTRIES = 64

/** How long a `rev-parse HEAD` answer is reused across requests. Short by
 *  design: it is the validity check every guarded route pays per call, and a
 *  longer window would delay noticing an out-of-band commit by that much. */
const HEAD_MICRO_TTL_MS = 1_500

/** TTL of the volatile routes (`git.worktrees`, `git.diff-range`): their
 *  answer follows the worktree's files, which no single sha captures, so a
 *  short window bounds staleness while keeping repeated polls off `git`.
 *  10 s matches the round-diff lens' own 10 s poll — every poll is answered
 *  from cache and revalidates in the background. */
const VOLATILE_TTL_MS = 10_000

/** One cached answer. `head` is `null` when `rev-parse HEAD` failed at compute
 *  time (an unborn or absent repository) — a legitimate state that must cache
 *  like any other, and that stops matching the moment HEAD is born. */
interface GitCacheEntry {
  /** Platform-normalized repository root the entry was computed for. */
  rootId: string
  value: unknown
  /** HEAD sha at compute time, or `null` when HEAD was unreadable. */
  head: string | null
  /** Age anchor for the volatile TTL (`Date.now()` at compute). */
  at: number
}

const cacheEntries = new Map<string, GitCacheEntry>()
/** One shared computation per key: concurrent same-key requests (a mount
 *  firing worktrees + branch + log at once, or a queued manual refresh) must
 *  not spawn duplicate git subprocesses. */
const computationsInFlight = new Map<string, Promise<unknown>>()
/** HEAD micro-cache, keyed per repository root. */
const headCache = new Map<string, { head: string | null; at: number }>()
const headInFlight = new Map<string, Promise<string | null>>()

/** Counters for manual verification — what the cache actually did. */
export interface GitCacheStats {
  entries: number
  /** Requests answered from a fresh entry (no git call beyond the HEAD probe). */
  hits: number
  /** Requests answered from an EXPIRED volatile entry while a background
   *  recompute was kicked off (stale-while-revalidate). */
  staleHits: number
  /** Requests that had to compute in the foreground (cold key, moved HEAD). */
  misses: number
  /** Background recomputes started for expired volatile entries. */
  revalidations: number
  /** Entries dropped by mutation invalidation. */
  dropped: number
}

const stats: GitCacheStats = { entries: 0, hits: 0, staleHits: 0, misses: 0, revalidations: 0, dropped: 0 }

/** A snapshot of the counters above (for tests and manual observation). */
export function gitCacheStats(): GitCacheStats {
  return { ...stats, entries: cacheEntries.size }
}

/** Reset the counters (tests / manual observation only; the cache itself stays). */
export function resetGitCacheStats(): void {
  stats.hits = 0
  stats.staleHits = 0
  stats.misses = 0
  stats.revalidations = 0
  stats.dropped = 0
}

/** Forget every cached answer and HEAD probe (tests). */
export function clearGitCache(): void {
  cacheEntries.clear()
  headCache.clear()
}

/** Platform-normalized identity of one repository root: the cache must not
 *  treat `C:\repo` and `c\repo\` (Windows) or a trailing slash as two repos. */
function rootIdentity(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** One cache key: the route name plus EVERY semantic parameter that changes
 *  the answer, joined by NUL (paths and revs cannot contain one). Callers pass
 *  already-resolved values — the path argument arrives resolved through
 *  `resolveStatusPath`, so two spellings of the same file share one entry. */
function cacheKey(parts: readonly (string | number | boolean | undefined)[]): string {
  return parts.map(part => String(part)).join('\u0000')
}

/**
 * HEAD of one repository root, shared across requests for
 * {@link HEAD_MICRO_TTL_MS}: one cheap subprocess per burst instead of one per
 * route, so the validity check never becomes the new serial cost of a refresh.
 * A failed rev-parse (unborn HEAD, not a repository) reads as `null` and is
 * cached like a value — the guard then compares `null === null`.
 */
async function headOf(root: string): Promise<string | null> {
  const id = rootIdentity(root)
  const cached = headCache.get(id)
  if (cached !== undefined && Date.now() - cached.at < HEAD_MICRO_TTL_MS) return cached.head
  const pending = headInFlight.get(id)
  if (pending !== undefined) return pending
  const promise = git.runGit(root, ['rev-parse', 'HEAD'])
    .then(sha => sha.trim())
    .catch(() => null)
    .then((head) => {
      headCache.set(id, { head, at: Date.now() })
      // A handful of repositories per process is the realistic bound; still,
      // never let the probe cache grow without a ceiling.
      if (headCache.size > 32) {
        const oldest = headCache.keys().next()
        if (!oldest.done) headCache.delete(oldest.value)
      }
      return head
    })
    .finally(() => { headInFlight.delete(id) })
  headInFlight.set(id, promise)
  return promise
}

/** Compute one answer, deduplicating concurrent same-key computations, and
 *  store it only on success (a failed git call must poison nothing). */
function computeAndStore<T>(key: string, root: string, compute: () => Promise<T>): Promise<T> {
  const pending = computationsInFlight.get(key)
  if (pending !== undefined) return pending as Promise<T>
  const promise = (async () => {
    const head = await headOf(root)
    const value = await compute()
    // LRU: refresh the key's position so the oldest entry is the one evicted.
    cacheEntries.delete(key)
    if (cacheEntries.size >= GIT_CACHE_MAX_ENTRIES) {
      const oldest = cacheEntries.keys().next()
      if (!oldest.done) cacheEntries.delete(oldest.value)
    }
    cacheEntries.set(key, { rootId: rootIdentity(root), value, head, at: Date.now() })
    return value
  })()
  computationsInFlight.set(key, promise)
  return promise.finally(() => { computationsInFlight.delete(key) })
}

/**
 * Read one git answer through the cache. `key` must carry the resolved
 * repository root and every semantic parameter (see {@link cacheKey});
 * `volatile` marks routes whose answer follows worktree file content, which
 * get the TTL + stale-while-revalidate treatment instead of the plain HEAD
 * guard.
 *
 * - fresh entry → served as-is (LRU-touched), no git call but the HEAD probe.
 * - volatile entry past its TTL → the previous answer goes out immediately and
 *   ONE background recompute backfills the cache; its failure is swallowed
 *   (the stale answer stays, the next request tries again).
 * - otherwise (cold key, or a HEAD-guarded entry whose HEAD moved) the answer
 *   is recomputed in the foreground: a refresh must not lag a commit that
 *   already happened.
 * - any cache-machinery failure falls back to `compute()` directly — the
 *   exact pre-cache behavior.
 */
export async function cachedGitRead<T>(
  root: string,
  key: string,
  compute: () => Promise<T>,
  volatile = false,
): Promise<T> {
  let entry: GitCacheEntry | undefined
  try {
    entry = cacheEntries.get(key)
    const head = await headOf(root)
    if (entry !== undefined
      && entry.head === head
      && (volatile !== true || Date.now() - entry.at < VOLATILE_TTL_MS)) {
      // Fresh: touch the LRU position and answer from the entry.
      cacheEntries.delete(key)
      cacheEntries.set(key, entry)
      stats.hits += 1
      return entry.value as T
    }
    if (entry !== undefined && volatile) {
      // Expired volatile: stale-while-revalidate. The old answer paints now;
      // the background pass backfills for the next call.
      stats.staleHits += 1
      stats.revalidations += 1
      void computeAndStore(key, root, compute).catch(() => { /* keep the stale answer */ })
      return entry.value as T
    }
  } catch {
    // Cache machinery itself failed: the route must behave exactly as before.
    return compute()
  }
  stats.misses += 1
  return computeAndStore(key, root, compute)
}

/**
 * Resolve the repository root a git route will operate on — the cache keys and
 * the invalidation must agree on this value, and keys MUST use the resolved
 * root (not the request's cwd): a cwd that is a subdirectory of the repository
 * would otherwise produce entries the mutation invalidation cannot find.
 * Discovery failures (a container workspace with no repository) fall back to
 * the cwd, mirroring `resolveStatusPath`'s own fallback.
 */
export async function gitCacheRootOf(cwd: string, selected?: string): Promise<string> {
  return git.repoRoot(cwd, selected).catch(() => cwd)
}

/**
 * Drop every cached answer computed against `root`'s repository (all routes,
 * all parameter shapes) and forget its HEAD probe — the probe must not outlive
 * the mutation either, or the freshly computed post-mutation entry would be
 * stored with a stale sha and instantly invalidated on the next read.
 * @returns how many entries were dropped.
 */
export function invalidateGitCache(root: string): number {
  const id = rootIdentity(root)
  let dropped = 0
  for (const [key, entry] of cacheEntries) {
    if (entry.rootId === id) {
      cacheEntries.delete(key)
      dropped += 1
    }
  }
  headCache.delete(id)
  stats.dropped += dropped
  return dropped
}

/**
 * The mutation routes' hook: resolve the repository the mutation ran on and
 * drop its cached answers. Best-effort — an unresolvable root (the repository
 * vanished mid-mutation) has nothing valid to invalidate.
 */
export async function invalidateGitCacheFor(cwd: string, selected?: string): Promise<void> {
  try {
    invalidateGitCache(await git.repoRoot(cwd, selected))
  } catch {
    // Not a repository (or gone): nothing was cached under a usable root.
  }
}

/** Build one read-route key from the route name and its semantic parameters. */
export function gitCacheKey(route: string, parts: readonly (string | number | boolean | undefined)[]): string {
  return cacheKey([route, ...parts])
}
