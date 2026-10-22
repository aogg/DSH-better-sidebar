/**
 * Side-chat live push behind `/sidebar/ws/sidechat`.
 *
 * The side-chat transcript used to learn about new rows only by polling
 * `sidechat.events` every 2s while the thread ran, so a streaming answer, the
 * claim of a just-sent message, or a finished tool call could sit invisible for
 * up to two seconds. The host already knows the moment either happens: the
 * session append feed (`session/event`) carries every durable row, and the
 * process-local `agent/assistant-stream` frames carry in-flight model deltas
 * (they are deliberately NOT logged — see assistant-live.ts).
 *
 * This hub turns both feeds into per-thread INVALIDATION notices. A notice
 * never carries event bodies: the client re-pulls `sidechat.events` with its
 * `afterSeq`, so the transcript transport, its tail cap and its delta logic are
 * unchanged, a dropped socket self-heals, and there is exactly one source of
 * truth for what a thread contains.
 *
 * Two coalescing windows, shortest first: a durable append is worth telling the
 * reader about almost immediately (60ms), while stream deltas arrive tens of
 * times a second and are folded into one notice per 250ms — each notice costs
 * the client a pull that re-sends the CURRENT attempt's chunks, so faster would
 * only burn bandwidth.
 *
 * A third channel rides the same two feeds: the GLOBAL thread-set
 * invalidation (`{ scope: 'threads' }`). The history popover's cross-workspace
 * 「全局运行中 / 全局未读」 groups used to trust the client session-list store
 * alone, whose subagent rows lag arbitrarily on running/updatedAt flips; a
 * socket that subscribed with `threads: true` now also hears ONE coalesced
 * "the thread set may be stale" frame whenever ANY session appends durably
 * (turn/start and turn/end are appends — exactly the running flips), whenever
 * stream deltas flow (a running thread is producing), or when the sidechat
 * routes create / rename / dispose a thread (`notifyThreads()` — a brand-new
 * thread may announce nothing through the feeds for a while). The frame stays
 * data-free: the client answers it with one `sidechat.threads` pull, so the
 * route stays the single source of the tree's truth and a dropped socket
 * self-heals through the same pull. Its window (200ms) sits between the other
 * two: one turn flip usually fires BOTH feeds plus maybe a route poke, and
 * those must fold into a single re-pull, yet the flip has to read as
 * immediate.
 * @module dsh-better-sidebar/sidechat-push
 */
import type { WebSocket } from 'ws'
import type { Context } from './context-types.ts'

/** Coalescing window for durable session appends. */
const DURABLE_DEBOUNCE_MS = 60
/** Coalescing window for in-flight model deltas. */
const STREAM_DEBOUNCE_MS = 250
/**
 * Coalescing window for the GLOBAL thread-set invalidation. Deliberately
 * between the durable (60ms) and stream (250ms) windows: one running flip
 * typically hits the append feed AND the stream feed (plus a route poke on
 * create/rename), and they must fold into ONE overlay re-pull per socket —
 * while staying fast enough that 「全局运行中」 lights up without a
 * perceptible lag. Exported for the specs (they must advance THE window,
 * not a copied literal).
 */
export const THREADS_DEBOUNCE_MS = 200
/** Thread ids one socket may watch (a resource guard, not a policy). */
const MAX_WATCHED = 64

/**
 * One frame the host pushes. Either a watched thread whose transcript is
 * stale (`threadId`) or the GLOBAL thread-set invalidation (`scope`), never
 * both — and never any data body.
 */
export interface SidechatPushFrame {
  threadId?: string
  scope?: 'threads'
}

/** The frame the client sends to replace its watch set. Frames from before
 *  the threads channel carry no `threads` key and stay fully legal. */
interface WatchFrame {
  op?: unknown
  threadIds?: unknown
  threads?: unknown
}

/** The slice of the hub the sidechat routes poke when the thread SET changes
 *  (create / rename / dispose) — a change no session append may announce. */
export interface SidechatThreadsNotifier {
  notifyThreads(): void
}

/** The host-side push hub: one set of feeds, any number of sockets. */
export interface SidechatPushHub extends SidechatThreadsNotifier {
  /** Attach one accepted socket (reads its watch frames, pushes notices). */
  attach(ws: WebSocket): void
  /** Release the session feeds (socket teardown stays with the server). */
  dispose(): void
}

/**
 * Register the side-chat push feeds.
 * @param ctx - host plugin context (its `on` subscribes the append feed).
 * @returns the hub plus a disposer unbinding both listeners.
 */
export function createSidechatPushHub(ctx: Context): SidechatPushHub {
  const sockets = new Set<SidechatSocket>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API still accept sockets, which then
    // simply never hear anything.
    return { attach: () => {}, dispose: () => {}, notifyThreads: () => {} }
  }
  const offEvent = ctx.on('session/event', (session) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    for (const socket of sockets) {
      socket.notify(sessionId, DURABLE_DEBOUNCE_MS)
      // ANY durable append may move the global groups: a turn/start or
      // turn/end flips `running`, any other append bumps last activity —
      // and both are exactly what the threads channel exists to announce.
      socket.notifyThreads(THREADS_DEBOUNCE_MS)
    }
  })
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    const record = payload as { agent?: unknown } | null
    const session = (record?.agent as { session?: { id?: unknown } } | undefined)?.session
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    for (const socket of sockets) {
      socket.notify(sessionId, STREAM_DEBOUNCE_MS)
      // Stream deltas prove the thread is running RIGHT NOW — the strongest
      // possible 「全局运行中」 signal, so they ride the threads channel too.
      socket.notifyThreads(THREADS_DEBOUNCE_MS)
    }
  })
  return {
    attach: (ws) => {
      const socket = new SidechatSocket(ws, () => { sockets.delete(socket) })
      sockets.add(socket)
    },
    notifyThreads: () => {
      // Route-driven poke (thread created / renamed / disposed): same
      // coalescing window, so a create that immediately streams folds into
      // the notice the feeds are already arming.
      for (const socket of sockets) socket.notifyThreads(THREADS_DEBOUNCE_MS)
    },
    dispose: () => {
      offEvent()
      offStream()
      for (const socket of sockets) socket.close()
      sockets.clear()
    },
  }
}

/** One attached socket's watch set and per-channel coalescing timers. */
class SidechatSocket {
  private readonly socket: WebSocket
  private readonly onClosed: () => void
  private readonly watched = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Whether this socket also hears the GLOBAL thread-set channel. */
  private threads = false
  /** The armed threads-coalescing timer (one per socket, not per thread). */
  private threadsTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  /**
   * @param socket - the accepted WebSocket.
   * @param onClosed - hub-side cleanup (idempotent).
   */
  constructor(socket: WebSocket, onClosed: () => void) {
    this.socket = socket
    this.onClosed = onClosed
    socket.on('message', (data: unknown) => { this.onMessage(data) })
    socket.on('close', () => { this.close() })
    socket.on('error', () => { this.close() })
  }

  /** Apply one client frame (an unparseable frame is ignored, never fatal). */
  private onMessage(data: unknown): void {
    let frame: WatchFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as WatchFrame
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object' || frame.op !== 'watch') return
    const ids = Array.isArray(frame.threadIds)
      ? frame.threadIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    this.watched.clear()
    for (const id of ids.slice(0, MAX_WATCHED)) this.watched.add(id)
    // The threads channel is opt-in per watch frame (absent key = not
    // subscribed — the backward-compatible shape). Unsubscribing drops the
    // pending notice with its timer, like an unwatched thread does.
    this.threads = frame.threads === true
    if (!this.threads && this.threadsTimer !== undefined) {
      clearTimeout(this.threadsTimer)
      this.threadsTimer = undefined
    }
    // Threads no longer watched drop their pending notice with their timer.
    for (const [id, timer] of this.timers) {
      if (this.watched.has(id)) continue
      clearTimeout(timer)
      this.timers.delete(id)
    }
  }

  /**
   * Coalesce one notice for a thread. The FIRST trigger's window wins, so a
   * burst of deltas never postpones the notice it already scheduled.
   * @param threadId - the session whose transcript is stale.
   * @param delayMs - coalescing window for this trigger.
   */
  notify(threadId: string, delayMs: number): void {
    if (this.closed || !this.watched.has(threadId) || this.timers.has(threadId)) return
    this.timers.set(threadId, setTimeout(() => {
      this.timers.delete(threadId)
      this.send({ threadId })
    }, delayMs))
  }

  /**
   * Coalesce ONE notice for the GLOBAL thread set (first trigger's window
   * wins, exactly like the per-thread channel). Sockets that never
   * subscribed with `threads: true` stay silent — an old client must not
   * start receiving frames it does not know.
   * @param delayMs - the threads coalescing window.
   */
  notifyThreads(delayMs: number): void {
    if (this.closed || !this.threads || this.threadsTimer !== undefined) return
    this.threadsTimer = setTimeout(() => {
      this.threadsTimer = undefined
      this.send({ scope: 'threads' })
    }, delayMs)
  }

  /** Push one notice (silently dropped once the socket is gone). */
  private send(frame: SidechatPushFrame): void {
    if (this.closed) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      // A send on a dying socket is expected; the close handler cleans up.
    }
  }

  /** Release every timer and de-register (idempotent). */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.threadsTimer !== undefined) clearTimeout(this.threadsTimer)
    this.threadsTimer = undefined
    this.watched.clear()
    this.onClosed()
  }
}
