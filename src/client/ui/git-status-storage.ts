/**
 * The git-status store's per-slot SNAPSHOT CACHE in `localStorage` — the
 * "colors are already on when the page opens" layer.
 *
 * A fresh page load used to paint every file-tree row plain and wait for the
 * first `git.status` answer (five git processes, up to seconds on a cold or
 * busy checkout) before any badge appeared. The store now writes every
 * accepted snapshot through to this module, and a slot hydrates from it at
 * creation: the first paint carries the LAST answer's ink (badge tones, the
 * ignored overlay, the clean ✓), and the subscription attaches before the
 * calibration pull even returns, because the cached answer names the checkout
 * root the watch keys on.
 *
 * Shape: one key per slot identity (`sessionId` + `cwd`/`worktree` digest —
 * NUL, the slot key's own separator, never reaches the wire), one JSON
 * document with a write timestamp, the snapshot's root/branch/truncation
 * flags, the ignored list, and the entries in a compact array encoding:
 * `[path, xy]`, `[path, xy, +lines, -lines]` or `[path, xy, '-', '-']` for a
 * binary change — the exact three shapes `parseNumstat` distinguishes, so
 * "no counts" (untracked) and "binary" never collapse into a fabricated `0`.
 *
 * Degradation is total: storage unavailable (privacy mode, hardened embeds),
 * quota exceeded, or a corrupt payload each leave the store exactly where it
 * was — memory-first, cache second, live fetch the arbiter. A stale cache can
 * never stick: every retain still runs the calibration pull, so the cache
 * only ever decides how a page looks for its first instants, never what it
 * converges to.
 *
 * Growth is bounded by an LRU sweep on the `dsh-sidebar:v1:git-status:` key
 * prefix: at most {@link GIT_STATUS_STORE_LIMIT} slot documents survive (the
 * most recently WRITTEN ones — a slot the user stopped visiting ages away),
 * everything older is dropped on the next write. House style follows
 * `team-task-firstseen.ts` (`dsh-sidebar:v1:` root, silent catch-and-keep)
 * and `sidechat-unread.ts` (single JSON document, tolerant parse).
 * @module dsh-better-sidebar/git-status-storage
 */
import type { GitStatusResult } from '../api.ts'

/** localStorage namespace: the same `dsh-sidebar:v1:` root the layout store
 *  and team-task-firstseen use, then the store's own subtree. */
const STORAGE_PREFIX = 'dsh-sidebar:v1:git-status:'

/** Slot documents kept at most (the LRU sweep's cap): the handful of
 *  worktrees a session actually touches, not every cwd it ever visited. */
export const GIT_STATUS_STORE_LIMIT = 8

/** Stored document schema version — a shape change invalidates old rows. */
const SCHEMA_VERSION = 1

/** FNV-1a (32-bit) of one string, as 8 hex chars: a stable digest for the
 *  key's cwd/worktree part — deterministic across reloads (no salt), small
 *  (the key must stay readable in devtools), and collision-proof enough to
 *  split slots whose payload root would disagree anyway (the calibration
 *  pull is the arbiter, the cache only pre-colors). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The storage key of one slot identity (the slot key's collision-free
 *  parts, digested; `sessionId` stays readable for devtools). */
export function gitStatusStorageKey(sessionId: string, cwd: string | undefined, worktree: string | undefined): string {
  return `${STORAGE_PREFIX}${sessionId}:${fnv1a(`${cwd ?? ''}\u0000${worktree ?? ''}`)}`
}

/** One compact encoded entry: `[path, xy]` (no counts — untracked / no
 *  numstat row), `[path, xy, +, -]` (numeric line counts) or
 *  `[path, xy, '-', '-']` (a binary change — the numstat spelling, never a
 *  fabricated 0/0). */
type StoredEntry =
  | [path: string, xy: string]
  | [path: string, xy: string, plus: number, minus: number]
  | [path: string, xy: string, binary: '-', minus: '-']

interface StoredSnapshot {
  v: typeof SCHEMA_VERSION
  /** Epoch ms of the write — the LRU sweep's freshness anchor. */
  at: number
  root: string
  branch?: string
  truncated?: boolean
  ignoredTruncated?: boolean
  entries: StoredEntry[]
  ignored?: string[]
}

/**
 * Read one slot's cached snapshot. Every deviation from the schema — a
 * foreign key, a torn write, a hand-edit — reads as "no cache"; nothing
 * throws, and a non-repo snapshot was never stored so it is never returned.
 */
export function readGitStatusSnapshot(key: string): GitStatusResult | null {
  let raw: string | null
  try {
    if (typeof localStorage === 'undefined') return null
    raw = localStorage.getItem(key)
  } catch {
    // Storage itself unavailable (privacy mode / security policy).
    return null
  }
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (record.v !== SCHEMA_VERSION) return null
    if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at <= 0) return null
    if (typeof record.root !== 'string' || record.root === '') return null
    if (!Array.isArray(record.entries)) return null
    const entries: GitStatusResult['entries'] = []
    for (const item of record.entries) {
      if (!Array.isArray(item) || item.length < 2 || item.length > 4) return null
      const [path, xy, plus, minus] = item as unknown[]
      if (typeof path !== 'string' || path === '' || typeof xy !== 'string' || xy.length !== 2) return null
      if (item.length === 2) {
        entries.push({ path, xy })
        continue
      }
      if (plus === '-' && minus === '-') {
        entries.push({ path, xy, counts: { binary: true } })
        continue
      }
      if (typeof plus !== 'number' || typeof minus !== 'number' || !Number.isFinite(plus) || !Number.isFinite(minus)) return null
      entries.push({ path, xy, counts: { additions: plus, deletions: minus } })
    }
    const ignored = record.ignored === undefined ? undefined : record.ignored
    if (ignored !== undefined && !Array.isArray(ignored)) return null
    return {
      isRepo: true,
      root: record.root,
      ...(typeof record.branch === 'string' ? { branch: record.branch } : {}),
      entries,
      ...(record.truncated === true ? { truncated: true } : {}),
      ...(ignored !== undefined ? { ignored: ignored.filter((row): row is string => typeof row === 'string') } : {}),
      ...(record.ignoredTruncated === true ? { ignoredTruncated: true } : {}),
    }
  } catch {
    // A hand-edit / truncated write must never surface as an exception.
    return null
  }
}

/**
 * Write one slot's snapshot through. Non-repo snapshots carry nothing worth
 * pre-coloring, so they are skipped (and a previously cached document for
 * the slot is left to age out of the LRU rather than being half-rewritten).
 * Every failure — quota, privacy mode — is silent: persistence degrades,
 * the page's own memory copy stays authoritative.
 */
export function writeGitStatusSnapshot(key: string, snapshot: GitStatusResult): void {
  if (!snapshot.isRepo || snapshot.root === undefined) return
  const document: StoredSnapshot = {
    v: SCHEMA_VERSION,
    at: Date.now(),
    root: snapshot.root,
    ...(snapshot.branch !== undefined ? { branch: snapshot.branch } : {}),
    ...(snapshot.truncated === true ? { truncated: true } : {}),
    ...(snapshot.ignoredTruncated === true ? { ignoredTruncated: true } : {}),
    entries: snapshot.entries.map((entry): StoredEntry => entry.counts === undefined
      ? [entry.path, entry.xy]
      : 'binary' in entry.counts
        ? [entry.path, entry.xy, '-', '-']
        : [entry.path, entry.xy, entry.counts.additions, entry.counts.deletions]),
    ...(snapshot.ignored !== undefined ? { ignored: snapshot.ignored } : {}),
  }
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, JSON.stringify(document))
  } catch {
    // Quota / privacy mode: this page's snapshot still holds; only the
    // cross-reload persistence is lost.
    return
  }
  sweepGitStatusStore()
}

/**
 * The LRU sweep: at most {@link GIT_STATUS_STORE_LIMIT} documents survive
 * under the prefix, the oldest-written ones going first. Reads every key's
 * `at` (one JSON parse per stored slot — a bounded handful) and drops the
 * stalest overflow. Every failure is silent: an un-swept store only grows
 * until the next successful write, never breaks one.
 */
export function sweepGitStatusStore(limit = GIT_STATUS_STORE_LIMIT): void {
  try {
    if (typeof localStorage === 'undefined') return
    /** key → write time (unparseable rows read as 0: swept first). */
    const stamps = new Map<string, number>()
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null || !key.startsWith(STORAGE_PREFIX)) continue
      let at = 0
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '')
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          && typeof (parsed as Record<string, unknown>).at === 'number') {
          at = (parsed as Record<string, unknown>).at as number
        }
      } catch {
        // Torn row: `at` stays 0 — first out.
      }
      stamps.set(key, at)
    }
    if (stamps.size <= limit) return
    const stale = [...stamps.entries()].sort((left, right) => left[1] - right[1])
    for (const [key] of stale.slice(0, stamps.size - limit)) localStorage.removeItem(key)
  } catch {
    // Storage unavailable mid-sweep: nothing this page can do about it.
  }
}
