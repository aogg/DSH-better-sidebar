/**
 * parentSession-subtree merge for the changes route's `changes.ops`.
 *
 * Delegated sessions do their file writes in subagent child sessions (log
 * headers carry `parentSession` → the parent's id, `origin: 'subagent'`), so
 * the root session's own log never sees the write/edit calls the SessionLens
 * folds. These helpers let the route walk the stored-header list into the
 * root's transitive child set and merge every member's tool events into one
 * window. Pure — no host service, no I/O — so the walk and the merge are
 * unit-testable without a live host.
 *
 * The merged window renames `seq` to the event's wall-clock time: a child
 * session's seq counter restarts at 0, so child rows would collide with (and
 * sort below) the root's rows and, worse, make the client's `afterSeq` cursor
 * meaningless across sessions. Epoch-ms times are globally monotonic per log
 * and are what the client already sorts ops by, so time IS the merge cursor.
 */
import type { SidebarSessionEvent } from './context-types.ts'

/**
 * One stored session as the subtree walk reads it: the host `list()` row
 * shape, narrowed to the header this module consumes.
 */
export interface StoredSessionHeaderLike {
  readonly header: Record<string, unknown>
}

/**
 * One session's events inside a merged window. `isRoot` marks the requested
 * session itself (kept so callers can label parts; the merge treats every
 * part's events alike).
 */
export interface SubtreeEventPart {
  /** The session the events came from (root id or a descendant's). */
  readonly id: string
  /** True when this part is the requested root session. */
  readonly isRoot: boolean
  /** The session's raw event log (live snapshot or persisted read). */
  readonly events: readonly SidebarSessionEvent[]
}

/** The merged window `changes.ops` returns in subtree mode. */
export interface MergedSubtreeWindow {
  /** The renumbered tool events, oldest → newest, tail-capped. */
  readonly events: SidebarSessionEvent[]
  /** The next poll's cursor: the newest delivered renumbered seq. */
  readonly lastSeq: number
  /** Marks the window as time-ordered across sessions (vs a single log). */
  readonly merged: true
}

/**
 * Collect the transitive `parentSession` subtree of `rootId` from the stored
 * headers, root included. Breadth-first from the root, following every
 * header whose `parentSession` names a node already in the set.
 *
 * Defensive on purpose: the header list is host-owned wire data, so entries
 * without an object header and ids that are not non-empty strings are
 * ignored, and a missing/empty list degrades to `[rootId]` (single-session
 * behaviour). Cycles cannot occur — stored logs are append-only and a
 * session's parent is fixed at creation — but the visited set is kept anyway
 * so a pathological host list can at worst be walked once per node.
 * @param headers - every stored session's header (undefined = unavailable).
 * @param rootId - the requested session id.
 * @returns the subtree ids, root first, then in discovery order.
 */
export function collectSubtreeIds(
  headers: readonly StoredSessionHeaderLike[] | undefined,
  rootId: string,
): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const entry of headers ?? []) {
    const header = entry?.header
    if (header === null || typeof header !== 'object') continue
    const id = header.id
    const parentSession = header.parentSession
    // A row without a usable (id, parentSession) pair simply is not an edge.
    if (typeof id !== 'string' || id === '') continue
    if (typeof parentSession !== 'string' || parentSession === '') continue
    const children = childrenOf.get(parentSession)
    if (children === undefined) childrenOf.set(parentSession, [id])
    else children.push(id)
  }
  const visited = new Set<string>([rootId])
  const queue = [rootId]
  const ids: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    ids.push(id)
    for (const child of childrenOf.get(id) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      queue.push(child)
    }
  }
  return ids
}

/** The tool event types the client fold consumes (same set the route ships). */
const CHANGES_EVENT_TYPES = new Set(['tool/call', 'tool/result'])

/**
 * The merged window's event cap — the same recent-window bound the single
 * log path applies, so a long delegation bursts to the same payload size.
 */
const MERGED_EVENTS_CAP = 4000

/**
 * Merge the subtree's tool events into one delivery window.
 *
 * Every part's `tool/call`/`tool/result` rows are renumbered
 * `seq := event.time` (an event without a usable time keeps its original seq
 * — a local counter, so it may collide across sessions, but that is still a
 * better-ordered guess than dropping the row), sorted ascending by
 * (renumbered seq, original seq), narrowed to `seq >= afterSeq` and
 * tail-capped. The bound is CLOSED: the fold on the client is idempotent per
 * `callId` (a keyed fold, not an append), so re-sending the boundary event
 * costs one redundant row and can never duplicate an op — while a strict `>`
 * here could drop a settled call forever when two events share one
 * millisecond.
 * @param parts - one entry per readable subtree session (root included).
 * @param afterSeq - the client's returned cursor (absent = from the start).
 * @returns the merged window; `lastSeq` is the cursor to echo back.
 */
export function mergeSubtreeEvents(
  parts: readonly SubtreeEventPart[],
  afterSeq: number | undefined,
): MergedSubtreeWindow {
  // An absent cursor means "from the very first event": the floor sits below
  // every renumbered seq (epoch ms are large positives; the seq-fallback rows
  // are non-negative), matching the route's absent-cursor convention.
  const floor = afterSeq ?? -1
  const rows: { event: SidebarSessionEvent; originalSeq: number }[] = []
  for (const part of parts) {
    for (const event of part.events) {
      if (!CHANGES_EVENT_TYPES.has(event.type)) continue
      rows.push({
        // Copy before renumbering: a live `snapshotEvents()` array is the
        // session's own log, and mutating its seq in place would corrupt it.
        event: {
          ...event,
          seq: typeof event.time === 'number' ? event.time : event.seq,
        },
        originalSeq: event.seq,
      })
    }
  }
  // Stable where times tie (two events in one millisecond): the original
  // within-log order breaks the tie, so a call always sorts before its result.
  rows.sort((a, b) => a.event.seq - b.event.seq || a.originalSeq - b.originalSeq)
  const filtered = rows.filter(row => row.event.seq >= floor)
  const window = filtered.length > MERGED_EVENTS_CAP
    ? filtered.slice(filtered.length - MERGED_EVENTS_CAP)
    : filtered
  return {
    events: window.map(row => row.event),
    lastSeq: window.at(-1)?.event.seq ?? floor,
    merged: true,
  }
}
