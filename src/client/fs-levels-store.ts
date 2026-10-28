/**
 * The file tree's Storage cache for `fs.trees` level listings.
 *
 * Without a dir watch (the tree no longer watches directories) and without a
 * cache, EVERY tree mount re-listed everything from the host. This store
 * persists one workspace's settled level listings under
 * `dsh-sidebar:fslevels:v1:<cwd>` and hands them back SYNCHRONOUSLY at mount
 * / expand time, so the tree paints instantly from cache while the usual
 * `fs.trees` refresh runs and overwrites both the tree's level cache and
 * this store.
 *
 * Shape: `{"version":1,"levels":{[dirPath]:{"listing":rows,"truncated"?,
 * "ts":number}}}`. The cwd is the raw key segment (an `ssh://` workspace is
 * a different string, so its bucket is naturally separate).
 *
 * Budgets (all enforced on the in-memory mirror before the flush):
 * - one level whose JSON exceeds 64 KB is not cached at all;
 * - one bucket keeps at most 100 levels, LRU by `ts` (the smallest ts is
 *   evicted first);
 * - the whole store keeps at most 20 cwd buckets, evicting the one whose
 *   newest level is oldest (its "last written" stamp, persisted so the
 *   choice survives reloads).
 *
 * Writes are batched: a put lands in the in-memory mirror at once and the
 * bucket is flushed to localStorage at most once per second. EVERY storage
 * touch is guarded: an unavailable store (privacy mode, quota exhausted,
 * Node's bare `localStorage` accessor) degrades to the in-memory mirror and
 * never breaks the tree — the listings always have the wire as their source
 * of truth, the cache is only the instant-paint head start. A corrupt or
 * wrong-version bucket on disk is dropped rather than merged.
 * @module dsh-better-sidebar/fs-levels-store
 */
import type { FsEntry } from './api.ts'

/** The key prefix; the cwd follows verbatim. */
const KEY_PREFIX = 'dsh-sidebar:fslevels:v1:'
/** The persisted schema version (a mismatch drops the bucket). */
const VERSION = 1
/** One level larger than this (JSON length) is not cached. */
const MAX_LEVEL_BYTES = 64 * 1024
/** One bucket's level cap (LRU by ts). */
const MAX_LEVELS_PER_BUCKET = 100
/** The whole store's bucket cap (evicted by the newest level's ts). */
const STORE_MAX_BUCKETS = 20
/** The flush throttle: at most one localStorage write per bucket per second. */
const FLUSH_MS = 1000

/** One cached level: the listing rows, the truncation flag, and the write stamp. */
interface StoredLevel {
  listing: readonly FsEntry[]
  truncated?: boolean
  ts: number
}

/** One workspace bucket as persisted. */
interface StoredBucket {
  version: number
  levels: Record<string, StoredLevel>
}

/** The in-memory mirror: every bucket read or written this run. */
const memory = new Map<string, StoredBucket>()
/** Buckets with pending writes (their localStorage copy is stale). */
const dirty = new Set<string>()
/** The pending flush timer (one for all buckets). */
let flushTimer: number | undefined

/** The storage key of one cwd bucket. */
function bucketKey(cwd: string): string {
  return `${KEY_PREFIX}${cwd}`
}

/** localStorage read guard: answers null when storage is unavailable. */
function rawGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    // Unavailable storage (privacy mode, disabled): the mirror alone serves.
    return null
  }
}

/** localStorage write guard: answers false when the write did not land. */
function rawSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, value)
    return true
  } catch {
    // Quota exhausted (or storage unavailable): the write is dropped, the
    // tree keeps working off the wire — the cache is a head start, never a
    // requirement.
    return false
  }
}

function rawRemove(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // Unavailable storage: nothing to remove, nothing to fail.
  }
}

/** Load one bucket from storage into the mirror (a corrupt or wrong-version
 *  bucket is dropped, not merged). */
function loadBucket(cwd: string): StoredBucket {
  const raw = rawGet(bucketKey(cwd))
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as StoredBucket
      if (
        parsed !== null && typeof parsed === 'object'
        && parsed.version === VERSION
        && parsed.levels !== null && typeof parsed.levels === 'object'
      ) {
        // Keep only well-formed levels (an array listing, a finite stamp).
        const levels: Record<string, StoredLevel> = {}
        for (const [path, level] of Object.entries(parsed.levels)) {
          if (level === null || typeof level !== 'object') continue
          if (!Array.isArray(level.listing)) continue
          if (typeof level.ts !== 'number' || !Number.isFinite(level.ts)) continue
          levels[path] = { listing: level.listing, truncated: level.truncated === true ? true : undefined, ts: level.ts }
        }
        const bucket: StoredBucket = { version: VERSION, levels }
        memory.set(cwd, bucket)
        return bucket
      }
    } catch {
      // Corrupt JSON: start the bucket fresh (the wire refresh re-fills it).
    }
  }
  const fresh: StoredBucket = { version: VERSION, levels: {} }
  memory.set(cwd, fresh)
  return fresh
}

/** The bucket for a cwd, loading it from storage on first touch. */
function bucketOf(cwd: string): StoredBucket {
  const existing = memory.get(cwd)
  if (existing !== undefined) return existing
  return loadBucket(cwd)
}

/** A bucket's recency stamp: its newest level's ts (persisted, so eviction
 *  order survives reloads). */
function bucketStamp(bucket: StoredBucket): number {
  let newest = 0
  for (const level of Object.values(bucket.levels)) {
    if (level.ts > newest) newest = level.ts
  }
  return newest
}

/** Enforce the bucket cap (LRU by ts) and the store's bucket cap (evict the
 *  stalest bucket) on the mirror. Evicted buckets leave storage too. */
function enforceCaps(cwd: string): void {
  const bucket = memory.get(cwd)
  if (bucket !== undefined) {
    const paths = Object.keys(bucket.levels)
    if (paths.length > MAX_LEVELS_PER_BUCKET) {
      paths.sort((a, b) => (bucket.levels[a]?.ts ?? 0) - (bucket.levels[b]?.ts ?? 0))
      for (const path of paths.slice(0, paths.length - MAX_LEVELS_PER_BUCKET)) {
        delete bucket.levels[path]
      }
    }
  }
  if (memory.size <= STORE_MAX_BUCKETS) return
  // Evict the buckets whose newest level is oldest; the bucket currently
  // being written is evicted last (it just earned its stamp).
  const order = [...memory.entries()].sort((a, b) => bucketStamp(a[1]) - bucketStamp(b[1]))
  for (const [stale] of order) {
    if (memory.size <= STORE_MAX_BUCKETS) break
    memory.delete(stale)
    dirty.delete(stale)
    rawRemove(bucketKey(stale))
  }
}

/** Flush every dirty bucket to storage. */
function flush(): void {
  flushTimer = undefined
  for (const cwd of [...dirty]) {
    dirty.delete(cwd)
    const bucket = memory.get(cwd)
    if (bucket === undefined) continue
    rawSet(bucketKey(cwd), JSON.stringify(bucket))
  }
}

/** Schedule the throttled flush (at most one per FLUSH_MS). */
function scheduleFlush(): void {
  if (flushTimer !== undefined) return
  flushTimer = window.setTimeout(flush, FLUSH_MS)
}

/**
 * Read one level synchronously (mount / expand time): the instant-paint
 * listing for a directory, or undefined when nothing usable is cached.
 * @param cwd - the workspace root (the bucket key segment).
 * @param path - the absolute directory path the tree keys levels by.
 */
export function fsLevelsGet(cwd: string, path: string): { listing: readonly FsEntry[]; truncated?: boolean } | undefined {
  if (cwd === '') return undefined
  const level = bucketOf(cwd).levels[path]
  if (level === undefined) return undefined
  return level.truncated === true ? { listing: level.listing, truncated: true } : { listing: level.listing }
}

/**
 * Cache one settled level (a successful `fs.trees` listing). The entry lands
 * in the mirror at once; the bucket flushes to localStorage within a second
 * (batched with the other puts of the same burst). A level whose JSON would
 * exceed 64 KB is not cached.
 * @param cwd - the workspace root (the bucket key segment).
 * @param path - the absolute directory path the level is about.
 * @param listing - the listing rows (a non-array is refused — only settled
 *   listings are cached, never error placeholders).
 * @param truncated - whether the host capped this listing.
 */
export function fsLevelsPut(cwd: string, path: string, listing: readonly FsEntry[], truncated?: boolean): void {
  if (cwd === '' || path === '' || !Array.isArray(listing)) return
  const ts = Date.now()
  const entry: StoredLevel = { listing, truncated: truncated === true ? true : undefined, ts }
  if (JSON.stringify(entry).length > MAX_LEVEL_BYTES) return
  const bucket = bucketOf(cwd)
  bucket.levels[path] = entry
  enforceCaps(cwd)
  if (memory.get(cwd) !== bucket) return
  dirty.add(cwd)
  scheduleFlush()
}

/**
 * Invalidate one workspace's whole bucket (the exclude list changed: every
 * cached level may now show entries the list removes, or miss entries it
 * hides — the same reason the tree wipes its own level cache). Drops both
 * the mirror entry and the persisted copy.
 * @param cwd - the workspace root whose cache dies.
 */
export function fsLevelsInvalidate(cwd: string): void {
  if (cwd === '') return
  memory.delete(cwd)
  dirty.delete(cwd)
  rawRemove(bucketKey(cwd))
}

/**
 * Flush any pending writes NOW (the throttled flush is a timer; tests and
 * page-hide paths want the storage state settled immediately).
 */
export function fsLevelsFlushForTests(): void {
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer)
    flush()
  }
}

/** Test seam: reset the mirror + timers (storage itself is the test's job). */
export function fsLevelsResetForTests(): void {
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer)
    flushTimer = undefined
  }
  memory.clear()
  dirty.clear()
}
