/**
 * The side conversations' per-thread READ WATERMARKS: a tiny module-level
 * store mapping thread id → epoch ms of the last moment the reader had the
 * thread on screen (tab mount, or any successful transcript pull).
 *
 * Why watermarks and not a badge counter: a thread's unread state must
 * survive reloads (localStorage) and answer for threads the reader has never
 * opened (watermark 0 = everything before "now" is unread), which a stored
 * count cannot do — the count would have to be recomputed anyway, and the
 * thread set changes behind the page (other windows, other hosts). The
 * comparison itself lives with the caller: `lastActivity > readAt(id)` against
 * the host's `updatedAt` (or the parent projection's catalog fallback).
 *
 * Deliberately timestamp-level, not seq-level: the client session list
 * exposes no per-thread seq cursor, and same-millisecond ties between a
 * message landing and a mark are tolerable — the mark writes `Date.now() + 1`
 * so an activity stamp from the SAME millisecond still reads as read.
 *
 * Memory is the source of truth; storage is loaded once (first snapshot =
 * page load) and written through on every mark. A mark whose write fails
 * (privacy mode / full quota) therefore still holds for this page — only the
 * cross-reload persistence is lost. Every storage error degrades silently:
 * nothing ever throws into a render path, and a corrupt payload reads as
 * "no marks yet".
 */

const STORAGE_KEY = 'dsh-sidebar:sidechat-read:v1'

/** The empty snapshot: a stable reference so useSyncExternalStore never loops. */
const EMPTY: Readonly<Record<string, number>> = {}

/** Parse one stored payload; anything malformed reads as "no marks". */
function parseReads(raw: string | null): Readonly<Record<string, number>> {
  if (raw === null) return EMPTY
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY
    const next: Record<string, number> = {}
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at) && at > 0) next[id] = at
    }
    return Object.keys(next).length === 0 ? EMPTY : next
  } catch {
    // A hand-edit / truncated write must never surface as an exception.
    return EMPTY
  }
}

class SidechatReadStore {
  private reads: Readonly<Record<string, number>> = EMPTY
  /** Storage is read exactly once (the first snapshot, i.e. page load):
   *  afterwards memory is authoritative and every mark writes through, so a
   *  failed write cannot clobber fresher in-memory marks on the next read. */
  private hydrated = false
  private listeners = new Set<() => void>()

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  getSnapshot = (): Readonly<Record<string, number>> => {
    if (!this.hydrated) {
      this.hydrated = true
      try {
        this.reads = parseReads(localStorage.getItem(STORAGE_KEY))
      } catch {
        // Storage unavailable (privacy mode / hardened embeds): start empty
        // rather than throwing into a render.
        this.reads = EMPTY
      }
    }
    return this.reads
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Stamp a thread as read at `now`. Marks only ever move forward: a
   *  backward or duplicate stamp is a no-op — which also keeps the write +
   *  notify churn off the hot path (every transcript pull calls this). */
  mark(threadId: string, now: number): void {
    if (!this.hydrated) this.getSnapshot()
    if ((this.reads[threadId] ?? 0) >= now) return
    this.reads = { ...this.reads, [threadId]: now }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.reads))
    } catch {
      // Quota / privacy mode: this page's marks still hold; persistence degrades.
    }
    this.notify()
  }
}

/** The page-level read-watermark registry (its subscribe/getSnapshot pair is
 *  the useSyncExternalStore contract; both are stable arrow properties). */
export const sidechatReadStore = new SidechatReadStore()

/** The stored watermark of one thread (0 = never read → anything active is unread). */
export function sidechatReadAt(threadId: string): number {
  return sidechatReadStore.getSnapshot()[threadId] ?? 0
}

/** Mark one thread read at `now` (default: the next millisecond, so an
 *  activity stamp from the SAME millisecond still counts as read). */
export function markSidechatThreadRead(threadId: string, now?: number): void {
  sidechatReadStore.mark(threadId, now ?? Date.now() + 1)
}
