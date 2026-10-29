/**
 * The session's live FILE-OPERATION stream — the signal the editor's
 * auto-refresh rides (#855).
 *
 * The model's file tools leave their calls in the session event log, and the
 * plugin's own `changes.ops` route ships that log's `tool/call` +
 * `tool/result` rows as a `seq > afterSeq` delta (see `src/index.ts`). This
 * module folds those deltas into "which file did the model just write or
 * edit", which is the whole question an open preview has to answer.
 *
 * Design constraints it exists to honour:
 *
 * - **One stream per session, not one per tab.** The native right sidebar
 *   keeps every visited tab body mounted (`keepMounted`), so an N-editor
 *   session would otherwise run N identical `changes.ops` subscriptions. A
 *   session's mounted editors elect ONE leader per session; that leader owns
 *   the single WS invalidation subscription and every member reads the same
 *   published state. Any member leaving re-elects, and the subscription
 *   stops when the last one goes.
 * - **WS-driven, no polling.** The stream advances on `/sidebar/ws/session`'s
 *   `ops` frames (see ./ops-push.ts): a coalesced bare invalidation of the
 *   session TREE — delegated agents write files in child sessions, so the
 *   watch set is the session plus its subagent descendants, and the same
 *   notice also serves the reconnect catch-up. The one-shot `changes.ops`
 *   delta pull is a fetch, not a poll — no timer drives it, and a dropped
 *   socket is answered with reconnects (1s → 15s, forever) plus one
 *   catch-up pull per re-open, never with HTTP asks. No `fs.watch`, no
 *   `fsRead` fingerprint polling either. The plugin's OWN saves go through
 *   `/sidebar/file` and leave no session event, so a reload can never
 *   re-trigger itself.
 * - **Settled successes only.** A `write`/`edit` call fires once its result
 *   landed without an error, so a half-written file never reaches a preview
 *   and a failed call never triggers a pointless reload.
 * - **Nothing historical fires.** The first pull of a fresh stream is the
 *   BASELINE: every op the session already settled is recorded as seen and
 *   published to nobody. Only an op that settles while someone is watching
 *   can refresh anything.
 * - **Session-scoped.** Streams are keyed by session id; a touch published
 *   for one session is invisible to every other session's editors.
 *
 * The stream record outlives its members (only the subscription stops): a
 * tab that becomes visible again re-joins, the leader resumes from the
 * persisted `seq` cursor, and the missed delta is folded then — so a file
 * the model rewrote while the tab was parked is still seen as touched.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context, SidebarSessionList, SidebarSessionEvent } from '../context-types.ts'
import { api, type SessionScope } from './api.ts'
import { extractFileOps, type FileOp } from './changes/ops.ts'
import { treeSessionIds } from './subagent-lineage.ts'
import { useSessionOps } from './ops-push.ts'
import { resolveSidebarPath } from './paths.ts'

/**
 * Events kept for cross-tick `tool/call` → `tool/result` pairing: a call may
 * be delivered in one delta and settle in the next. Only the tail matters
 * (a call that old has long since settled), and the bound is what keeps a
 * long session's fold cheap.
 */
const EVENT_WINDOW = 400

/**
 * Events kept once the last member goes away. The cursor, the baseline and
 * the published touches all survive, so a returning tab resumes the delta it
 * missed — but a session's tool traffic (write payloads, read results) must
 * not be pinned for the page's lifetime just because a tab was visited.
 */
const IDLE_EVENT_WINDOW = 32

/** Touched paths remembered per session (oldest insertion evicted past this). */
const TOUCH_WINDOW = 256

/** The op kinds that changed a file's bytes. */
export type FileOpTouchKind = 'write' | 'edit'

/** The newest settled write/edit of one path. */
export interface FileOpTouch {
  readonly kind: FileOpTouchKind
  /** The published revision this touch belongs to (compare with a baseline). */
  readonly revision: number
  /** The originating tool call's event time (epoch ms). */
  readonly time: number
}

/** What a member reads: the published state of its session's stream. */
export interface FileOpStreamState {
  /** Monotonic per-session counter, bumped once per published delta. */
  readonly revision: number
  /** Comparison key ({@link fileOpKey}) → that path's newest settled touch. */
  readonly touched: ReadonlyMap<string, FileOpTouch>
}

/** The state every session starts from (a stable identity: the store contract). */
const EMPTY_STATE: FileOpStreamState = { revision: 0, touched: new Map() }

/**
 * The comparison key of one path, so a model-spelled path and an editor tab's
 * absolute path meet: relative paths are resolved against the session cwd
 * ({@link resolveSidebarPath}), `.`/`..` segments are folded lexically, both
 * separators unify to '/', and Windows-style paths (drive letters, UNC
 * shares) fold case — the same file may be spelled either way there.
 * @param cwd - the session working directory (undefined = nothing to join onto).
 * @param path - an absolute or session-relative path.
 * @returns the comparison key (never a path to hand back to the host).
 */
export function fileOpKey(cwd: string | undefined, path: string): string {
  const unified = resolveSidebarPath(cwd, path).replace(/\\/g, '/')
  const windows = /^[A-Za-z]:\//.test(unified) || unified.startsWith('//')
  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const key = `${unified.startsWith('/') ? '/' : ''}${segments.join('/')}`
  return windows ? key.toLowerCase() : key
}

/** One stream member: an editor tab, and the way to tell it it leads now. */
interface Member {
  /** Become (true) or stop being (false) this session's subscription holder. */
  lead(leading: boolean): void
}

/** One session's stream: the shared cursor, the published state, the members. */
interface Stream {
  state: FileOpStreamState
  listeners: Set<() => void>
  members: Set<Member>
  leader: Member | undefined
  /** The delivered cursor (`0` = no cursor yet, so the next pull is the baseline). */
  seq: number
  /** Whether the baseline pull completed (only then may a delta publish). */
  primed: boolean
  events: SidebarSessionEvent[]
  /** callIds already accounted for: a settle must fire exactly once. */
  published: Set<string>
  /** The leader's cwd, used to resolve the model's own relative spellings. */
  cwd: string | undefined
  /** A delta pull in flight (notices landing now only re-arm the trailing pull). */
  pullInFlight: boolean
  /** A notice arrived while a pull was in flight — pull again right after it. */
  pullAgain: boolean
  /** The in-flight pull's abort controller (aborted when leadership moves on). */
  pullAbort: AbortController | undefined
}

/** Every session's stream, alive for the page (only its subscription stops). */
const streams = new Map<string, Stream>()

/** The stream record of one session, created on first use. */
function streamOf(sessionId: string): Stream {
  let stream = streams.get(sessionId)
  if (stream === undefined) {
    stream = {
      state: EMPTY_STATE,
      listeners: new Set(),
      members: new Set(),
      leader: undefined,
      seq: 0,
      primed: false,
      events: [],
      published: new Set(),
      cwd: undefined,
      pullInFlight: false,
      pullAgain: false,
      pullAbort: undefined,
    }
    streams.set(sessionId, stream)
  }
  return stream
}

/**
 * Drop one session's stream DATA (the 工作区切换释放 path — see
 * workspace-release.ts): the delivered touches, the retained event window
 * and the cursor all go, and an in-flight pull is aborted so its answer can
 * publish into a released session. A stream nobody holds is removed outright;
 * one with surviving members (a body a stub has not unmounted yet) is reset
 * in place — the next leader's pull re-baselines from seq 0, which is the
 * honest state of a released workspace anyway. Notified deliberately NOT:
 * the bodies this data fed are being torn down, and a fresh mount reads the
 * empty state directly.
 * @param sessionId - the released session whose stream dies.
 */
export function opsStreamReleaseSession(sessionId: string): void {
  const stream = streams.get(sessionId)
  if (stream === undefined) return
  stream.pullAbort?.abort()
  stream.pullInFlight = false
  stream.pullAgain = false
  stream.pullAbort = undefined
  stream.events = []
  stream.published.clear()
  stream.seq = 0
  stream.primed = false
  stream.cwd = undefined
  stream.state = EMPTY_STATE
  if (stream.members.size === 0 && stream.leader === undefined && stream.listeners.size === 0) {
    streams.delete(sessionId)
  }
}

/** Publish one delta's settled write/edit ops to every member of the stream. */
function publish(stream: Stream, ops: readonly FileOp[]): void {
  const revision = stream.state.revision + 1
  const touched = new Map(stream.state.touched)
  // `extractFileOps` orders newest first; walking it backwards leaves the
  // NEWEST op of this delta as the one recorded for a path touched twice.
  for (const op of [...ops].reverse()) {
    stream.published.add(op.callId)
    touched.set(fileOpKey(stream.cwd, op.path), { kind: op.kind as FileOpTouchKind, revision, time: op.time })
  }
  // Bound the memory of a long session. Map iteration is insertion order, and
  // re-touching a path keeps its original slot, so the evicted entry is not
  // strictly the oldest revision — a miss here only costs a stale preview
  // until the next write of that path, never wrong content.
  for (const key of touched.keys()) {
    if (touched.size <= TOUCH_WINDOW) break
    touched.delete(key)
  }
  stream.state = { revision, touched }
  for (const listener of stream.listeners) listener()
}

/**
 * Fold one delta (plus the retained window) into the stream.
 * @param baseline - true for a fresh stream's FIRST fold: everything already
 * settled predates the editors that are joining, so it marks state without
 * publishing anything.
 */
function fold(stream: Stream, events: readonly SidebarSessionEvent[], baseline: boolean): void {
  const merged = [...stream.events, ...events]
  stream.events = merged.length > EVENT_WINDOW ? merged.slice(merged.length - EVENT_WINDOW) : merged
  const ops = extractFileOps(stream.events)
  if (baseline) {
    for (const op of ops) stream.published.add(op.callId)
  } else {
    const settled = ops.filter(op => (op.kind === 'write' || op.kind === 'edit')
      && !op.running && !op.isError && !stream.published.has(op.callId))
    if (settled.length > 0) publish(stream, settled)
  }
  // Ops that scrolled out of the window cannot settle any more: drop their
  // marks so the set can never grow past what the window can hold.
  const present = new Set(ops.map(op => op.callId))
  for (const callId of stream.published) {
    if (!present.has(callId)) stream.published.delete(callId)
  }
}

/** One leader's delta pull: advance the cursor, then fold (or baseline) it. */
async function pullStream(stream: Stream, scope: SessionScope, signal: AbortSignal): Promise<void> {
  const { events, lastSeq } = await api.changesOps(scope, stream.seq, signal)
  // A torn-down run's answer must never publish state: the transport may
  // deliver an aborted response anyway.
  if (signal.aborted === true) return
  if (scope.cwd !== undefined && scope.cwd !== '') stream.cwd = scope.cwd
  if (lastSeq > stream.seq) stream.seq = lastSeq
  const baseline = !stream.primed
  stream.primed = true
  if (events.length > 0) fold(stream, events, baseline)
}

/**
 * Pull the stream's delta once — at most ONE request in flight per session,
 * and a notice landing mid-flight re-arms exactly one trailing pull, so a
 * burst of `ops` frames costs at most two requests and never loses a delta.
 * This is the timer-free replacement of the old self-scheduling poll loop:
 * nothing schedules the next pull, only a notice (or a reconnect catch-up)
 * does.
 */
async function requestPull(stream: Stream, scope: SessionScope): Promise<void> {
  if (stream.pullInFlight) {
    stream.pullAgain = true
    return
  }
  stream.pullInFlight = true
  try {
    do {
      stream.pullAgain = false
      const controller = new AbortController()
      stream.pullAbort = controller
      try {
        await pullStream(stream, scope, controller.signal)
      } catch (error) {
        stream.pullAgain = false
        // An aborted pull is a leadership handoff/teardown, not a failure —
        // its silence is designed (the next leader's initial pull owns the
        // stream). Offline / route unavailable otherwise: keep the last fold,
        // log the failure, and stop the chain — the next notice (or the
        // reconnect catch-up) retries, exactly like the old poll's next tick.
        if (!controller.signal.aborted) {
          console.error('[dsh-better-sidebar] file-op stream pull failed:', error)
        }
      }
    } while (stream.pullAgain)
  } finally {
    stream.pullInFlight = false
    stream.pullAbort = undefined
  }
}

/** The empty session list the watch resolver degrades to (no host face). */
const EMPTY_SESSION_LIST: SidebarSessionList = { byId: {} }

/**
 * The session's ops watch set: the session itself plus every subagent
 * descendant (delegated agents write files in CHILD logs, and `changes.ops`
 * folds the whole subtree). The root goes FIRST so the host's 64-session
 * watch guard always keeps it.
 */
function useTreeWatchIds(ctx: Context | undefined, sessionId: string): readonly string[] {
  const list = ctx?.sessions?.list
  const snapshot = useSyncExternalStore(
    useMemo(() => {
      if (list === undefined) return () => (): void => { /* no host face: nothing to observe */ }
      return (callback: () => void) => list.subscribe(callback)
    }, [list]),
    useMemo(() => {
      if (list === undefined) return () => EMPTY_SESSION_LIST
      return () => list.getSnapshot()
    }, [list]),
  )
  return useMemo(() => {
    const tree = treeSessionIds(snapshot.byId, sessionId)
    // A session whose row is still hydrating keeps its own id as the set —
    // the root's own events must always invalidate.
    return [...new Set([sessionId, ...tree])]
  }, [snapshot, sessionId])
}

/**
 * Join one session's file-operation stream while `enabled`, and read its
 * published state. Every mounted editor of a session calls this; exactly one
 * of them (the elected leader) holds the WS invalidation subscription.
 * @param scope - the session whose log is watched (sessionId + cwd).
 * @param enabled - whether this tab is on screen and holds a real file (a
 * parked tab must not keep watching, and a folder/path-less window has no file
 * to watch).
 * @param ctx - the client context (its session list feed resolves the tree
 *   watch set); optional, and a context without the face degrades to a
 *   root-only watch.
 * @returns the session's published touches, stable between deltas.
 */
export function useFileOpStream(
  scope: SessionScope,
  enabled: boolean,
  ctx?: Context,
): FileOpStreamState {
  const { sessionId } = scope
  const [leading, setLeading] = useState(false)
  // The session tree whose event appends invalidate this stream (root first;
  // children join the set as the session list learns of them).
  const watchIds = useTreeWatchIds(ctx, sessionId)

  useEffect(() => {
    if (!enabled || sessionId === '') {
      setLeading(false)
      return
    }
    const stream = streamOf(sessionId)
    const member: Member = { lead: (value: boolean) => { setLeading(value) } }
    stream.members.add(member)
    if (stream.leader === undefined) {
      stream.leader = member
      setLeading(true)
    }
    return () => {
      stream.members.delete(member)
      if (stream.members.size === 0 && stream.events.length > IDLE_EVENT_WINDOW) {
        // Nobody is watching: keep only what a settle landing right now would
        // still need to pair with. The cursor and the published touches stay,
        // so the missed delta is folded (and published) when a tab returns.
        stream.events = stream.events.slice(stream.events.length - IDLE_EVENT_WINDOW)
      }
      if (stream.leader !== member) return
      stream.leader = undefined
      setLeading(false)
      // The in-flight pull belongs to the leadership: abort it so its answer
      // cannot publish under whoever leads next.
      stream.pullAbort?.abort()
      // Hand the subscription to whoever is left: only a member's own hook
      // can run it.
      const next = stream.members.values().next().value as Member | undefined
      if (next !== undefined) {
        stream.leader = next
        next.lead(true)
      }
    }
  }, [enabled, sessionId])

  // Granular scope fields: the scope object's identity churns every render,
  // only its sessionId / cwd gate the request target.
  const cwd = scope.cwd
  const pull = useCallback(async (): Promise<void> => {
    await requestPull(streamOf(sessionId), { sessionId, cwd })
  }, [sessionId, cwd])

  // The leader's initial catch-up: on election — and on a scope change,
  // which used to restart the poll loop with an immediate tick — pull once.
  // The baseline case marks every already-settled op seen without publishing,
  // and a resumed cursor folds (and publishes) the delta the parking missed.
  useEffect(() => { if (leading) void pull() }, [leading, pull])

  // WS-driven invalidation (see ./ops-push.ts): an `ops` frame of the session
  // TREE — or the shared socket's re-open after a drop — pulls the delta
  // once. At most one request in flight per session; a notice mid-flight
  // re-arms one trailing pull. No timer drives any request.
  useSessionOps({
    sessionIds: leading ? watchIds : [],
    onInvalidate: () => { void pull() },
    onReconnect: () => { void pull() },
  })

  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      const stream = streamOf(sessionId)
      stream.listeners.add(listener)
      return () => { stream.listeners.delete(listener) }
    }, [sessionId]),
    useCallback(() => streams.get(sessionId)?.state ?? EMPTY_STATE, [sessionId]),
  )
}
