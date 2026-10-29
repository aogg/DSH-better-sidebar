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
 * channel. It has TWO modes per subscription:
 *
 * - LEGACY (default, `threads: true` without rootIds): the coalescing
 *   window (THREADS_DEBOUNCE_MS=200ms) expires into a DATA-FREE
 *   invalidation `{ scope: 'threads' }` — the old client answers it with
 *   one `sidechat.threads` HTTP pull, so an old bundle keeps working
 *   unchanged.
 * - DATA (`threads: true` plus rootIds, reported via a `watch` control
 *   frame on the feed endpoint — the census input rides the SAME
 *   subscription key, so a changing session list never tears the wire
 *   subscription): the window expiry no longer pokes the client but
 *   COMPUTES the census here — the `sidechat.threads` route's enumeration
 *   core, injected as `threadsCensus` — shallow-diffs it against the rows
 *   this subscription last pushed (id/running/title/parentId/
 *   lastActivityAt, order included) and stays SILENT when nothing changed.
 *   A change ships the data frame `{ scope: 'threads', rows, degraded }`.
 *   Alignment is push-native: the first data-mode watch (first join, a feed
 *   socket re-open's fresh subscription, a rootIds update) computes once
 *   against a never-pushed baseline, so the client receives the current
 *   full snapshot without any join-time HTTP pull; before the roots are
 *   reported the subscription stays in legacy mode (empty frames), and the
 *   snapshot the watch triggers replaces that state milliseconds later.
 *
 *   Guard rails: at most ONE census per subscription is in flight — a
 *   trigger landing mid-computation only sets a dirty flag, and the pump
 *   recomputes once after it settles (no pile-up). Streaming is the worst
 *   case at one enumeration per ~200ms window per subscription: this
 *   collapses what used to be one HTTP POST per browser surface per window
 *   into one in-process computation on ONE wire subscription. An unexpected
 *   census throw is logged and answered as fully degraded — the degraded
 *   contract the route itself follows (its own per-root failures degrade
 *   inside the core).
 *
 * Triggers stay identical in both modes: session/event durable append,
 * agent/assistant-stream delta, and the routes' direct poke
 * (`notifyThreads()` — a brand-new thread may announce nothing through the
 * feeds for a while). In data mode the triggers only decide WHEN to
 * recompute; the diff decides WHETHER anything is sent.
 * @module dsh-better-sidebar/sidechat-push
 */
import type { WebSocket } from 'ws'
import type { Context } from './context-types.ts'
import type { SidechatGlobalThreadRow } from './sidechat-core.ts'

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
 * stale (`threadId`), or the GLOBAL thread-set channel (`scope`) — never
 * both. A `scope` frame is data-free in legacy mode; in data mode it
 * carries the census rows plus the degraded flag.
 */
export interface SidechatPushFrame {
  threadId?: string
  scope?: 'threads'
  /** Data mode only: the full census rows (a wholesale replacement). */
  rows?: SidechatGlobalThreadRow[]
  /** Data mode only: true when the census could not be computed at all. */
  degraded?: boolean
}

/**
 * The census the data mode drives: the `sidechat.threads` route's
 * enumeration core (sidechat-routes.ts `sidechatThreadsCensus`), injected
 * so this module stays free of the route table (which itself imports this
 * one). Never expected to throw — the core degrades internally — but the
 * hub treats a throw as fully degraded regardless.
 */
export type SidechatThreadsCensus = (
  rootIds: readonly string[],
) => Promise<{ rows: SidechatGlobalThreadRow[]; degraded: boolean }>

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
  /**
   * Open one subscription: its watch set is held until it closes, its
   * frames ride its own sink. The feed multiplexer opens one per (channel,
   * key); the legacy endpoint one per socket.
   */
  subscribe(options: SidechatSubscribeOptions): SidechatSubscription
  /** Attach one accepted socket — a thin shell over {@link subscribe}. */
  attach(ws: WebSocket): void
  /** Release the session feeds (socket teardown stays with the server). */
  dispose(): void
}

/** What one subscription contributes: its frame sink. */
export interface SidechatSubscribeOptions {
  /** Receives this subscription's frames (never called after `close`). */
  onFrame: (frame: SidechatPushFrame) => void
}

/** One subscription (a legacy endpoint socket, or one feed sub) of the hub. */
export interface SidechatSubscription {
  /**
   * Full replacement of the watch set: the watched thread ids, whether the
   * GLOBAL thread-set channel is subscribed (absent = not), and — data
   * mode only — the census ROOTS (absent/undefined = legacy mode: the
   * client has not reported them yet). The roots are computation input,
   * NOT part of any subscription identity: updating them re-arms the same
   * subscription instead of tearing it.
   */
  setWatch(threadIds: readonly string[], threads: boolean, rootIds?: readonly string[]): void
  /** Apply one raw client frame (the legacy endpoint socket's inbound feed). */
  onMessage(data: unknown): void
  /** Release the subscription; no further frames. */
  close(): void
}

/** Options of {@link createSidechatPushHub} beyond the context. */
export interface SidechatPushHubOptions {
  /**
   * The census the threads channel's DATA mode computes (the
   * `sidechat.threads` core). Absent — the bare legacy wiring — every
   * `threads: true` subscription runs in legacy mode and the census is
   * never consulted.
   */
  threadsCensus?: SidechatThreadsCensus
}

/**
 * Register the side-chat push feeds.
 * @param ctx - host plugin context (its `on` subscribes the append feed).
 * @param options - the threads-census injection enabling the data mode.
 * @returns the hub plus a disposer unbinding both listeners.
 */
export function createSidechatPushHub(ctx: Context, options: SidechatPushHubOptions = {}): SidechatPushHub {
  const threadsCensus = options.threadsCensus
  const subscriptions = new Set<SidechatSubscriptionImpl>()
  const noSubscription = (): SidechatSubscription => {
    const noop = (): void => {}
    return { setWatch: noop, onMessage: noop, close: noop }
  }
  const openSubscription = (subscribeOptions: SidechatSubscribeOptions): SidechatSubscription => {
    const subscription = new SidechatSubscriptionImpl(subscribeOptions, threadsCensus, () => { subscriptions.delete(subscription) })
    subscriptions.add(subscription)
    return subscription
  }
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API still accept sockets, which then
    // simply never hear anything.
    return { subscribe: noSubscription, attach: () => {}, dispose: () => {}, notifyThreads: () => {} }
  }
  const offEvent = ctx.on('session/event', (session) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    for (const subscription of subscriptions) {
      subscription.notify(sessionId, DURABLE_DEBOUNCE_MS)
      // ANY durable append may move the global groups: a turn/start or
      // turn/end flips `running`, any other append bumps last activity —
      // and both are exactly what the threads channel exists to announce.
      subscription.notifyThreads(THREADS_DEBOUNCE_MS)
    }
  })
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    const record = payload as { agent?: unknown } | null
    const session = (record?.agent as { session?: { id?: unknown } } | undefined)?.session
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    for (const subscription of subscriptions) {
      subscription.notify(sessionId, STREAM_DEBOUNCE_MS)
      // Stream deltas prove the thread is running RIGHT NOW — the strongest
      // possible 「全局运行中」 signal, so they ride the threads channel too.
      subscription.notifyThreads(THREADS_DEBOUNCE_MS)
    }
  })
  return {
    subscribe: (options) => openSubscription(options),
    attach: (ws) => {
      // The endpoint shell: one subscription, its frames on the socket, its
      // lifetime the socket's — the feed opens the same shape per sub key.
      const subscription = openSubscription({
        onFrame: (frame) => {
          try {
            ws.send(JSON.stringify(frame))
          } catch {
            // A send on a dying socket is expected; the close handler cleans up.
          }
        },
      })
      ws.on('message', (data: unknown) => { subscription.onMessage(data) })
      ws.on('close', () => { subscription.close() })
      ws.on('error', () => { subscription.close() })
    },
    notifyThreads: () => {
      // Route-driven poke (thread created / renamed / disposed): same
      // coalescing window, so a create that immediately streams folds into
      // the notice the feeds are already arming.
      for (const subscription of subscriptions) subscription.notifyThreads(THREADS_DEBOUNCE_MS)
    },
    dispose: () => {
      offEvent()
      offStream()
      for (const subscription of subscriptions) subscription.close()
      subscriptions.clear()
    },
  }
}

/** One subscription's watch set and per-channel coalescing timers. */
class SidechatSubscriptionImpl {
  private readonly onFrame: (frame: SidechatPushFrame) => void
  private readonly onClosed: () => void
  /** The data mode's census (absent = this hub was built legacy-only). */
  private readonly census: SidechatThreadsCensus | undefined
  private readonly watched = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Whether this subscription also hears the GLOBAL thread-set channel. */
  private threads = false
  /**
   * The census roots in DATA mode (undefined = legacy mode). Data mode is
   * `threads && roots !== undefined`: until the client reports roots the
   * channel behaves exactly like the legacy invalidation channel.
   */
  private threadsRoots: readonly string[] | undefined
  /** The armed threads-coalescing timer (one per subscription, not per thread). */
  private threadsTimer: ReturnType<typeof setTimeout> | undefined
  /** The rows this subscription last pushed (data mode's diff baseline;
   *  undefined = nothing pushed yet, so the first computation always ships). */
  private pushedRows: readonly SidechatGlobalThreadRow[] | undefined
  private pushedDegraded = false
  /** The data-mode pump: one census in flight at most, `dirty` collects the
   *  triggers that landed mid-computation for exactly one follow-up run. */
  private computing = false
  private dirty = false
  private closed = false

  /**
   * @param options - the subscription's frame sink.
   * @param census - the threads data mode's enumeration (may be absent).
   * @param onClosed - hub-side cleanup (idempotent).
   */
  constructor(
    options: SidechatSubscribeOptions,
    census: SidechatThreadsCensus | undefined,
    onClosed: () => void,
  ) {
    this.onFrame = options.onFrame
    this.census = census
    this.onClosed = onClosed
  }

  /** Apply one client frame (an unparseable frame is ignored, never fatal). */
  onMessage(data: unknown): void {
    if (this.closed) return
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
    this.setWatch(ids, frame.threads === true)
  }

  /**
   * Full replacement of the watch set. The threads channel is opt-in
   * (absent flag = not subscribed — the backward-compatible shape). The
   * census roots arm the DATA mode; a watch WITHOUT them drops back to
   * legacy (the pending notice dies with the mode, like an unwatched
   * thread's notice does). A data-mode watch — first report or a rootIds
   * update — starts the alignment computation at once (single-flight, so a
   * burst of updates costs one follow-up run at most).
   */
  setWatch(threadIds: readonly string[], threads: boolean, rootIds?: readonly string[]): void {
    if (this.closed) return
    this.watched.clear()
    for (const id of threadIds.slice(0, MAX_WATCHED)) this.watched.add(id)
    this.threads = threads
    this.threadsRoots = threads && rootIds !== undefined
      ? [...new Set(rootIds.filter(id => id !== ''))].slice(0, MAX_WATCHED)
      : undefined
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
    // Data-mode alignment: the current census is pushed WITHOUT waiting
    // for a feed trigger (the client just told us what it wants to know).
    if (this.threadsRoots !== undefined) this.requestThreadsCompute()
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
   * Coalesce ONE threads-channel trigger (first trigger's window wins,
   * exactly like the per-thread channel). Sockets that never subscribed
   * with `threads: true` stay silent — an old client must not start
   * receiving frames it does not know. What the window expiry produces
   * depends on the mode at expiry: legacy sends the data-free invalidation,
   * data mode recomputes the census (the diff then decides whether the
   * client hears anything at all).
   * @param delayMs - the threads coalescing window.
   */
  notifyThreads(delayMs: number): void {
    if (this.closed || !this.threads || this.threadsTimer !== undefined) return
    this.threadsTimer = setTimeout(() => {
      this.threadsTimer = undefined
      if (this.threadsRoots !== undefined) {
        // Data mode: the trigger only says WHEN to recompute.
        this.requestThreadsCompute()
        return
      }
      // Legacy mode (no roots reported — an old client): the data-free
      // invalidation it knows how to answer.
      this.send({ scope: 'threads' })
    }, delayMs)
  }

  /**
   * Start (or mark dirty) the data-mode census pump. At most ONE
   * computation per subscription is ever in flight: a trigger landing
   * mid-computation only sets the dirty flag, and the running pump runs
   * exactly one follow-up with the then-current roots — a burst of feeds
   * firing during a slow enumeration costs one recomputation, never a pile.
   */
  private requestThreadsCompute(): void {
    if (this.closed || !this.threads || this.threadsRoots === undefined) return
    if (this.computing) {
      this.dirty = true
      return
    }
    this.computing = true
    void this.drainThreads()
  }

  /**
   * The pump body: compute → diff → maybe push, repeating only while the
   * dirty flag says the world moved under the last computation. Exits when
   * the subscription died, left the threads channel or fell back to legacy.
   */
  private async drainThreads(): Promise<void> {
    try {
      for (;;) {
        this.dirty = false
        const roots = this.threadsRoots
        if (this.closed || !this.threads || roots === undefined) return
        let result: { rows: SidechatGlobalThreadRow[]; degraded: boolean }
        try {
          result = this.census !== undefined
            ? await this.census(roots)
            // No census injected (bare legacy wiring): a data-mode watch can
            // only be answered honestly as "cannot compute".
            : { rows: [], degraded: true }
        } catch (error) {
          // The census core degrades internally; a throw here is a wiring
          // bug, logged and answered as fully degraded — a push channel
          // must never die on its own data path.
          console.error('[dsh-better-sidebar] sidechat threads census failed:', error)
          result = { rows: [], degraded: true }
        }
        if (this.closed) return
        // Push only on a REAL change against this subscription's last
        // frame (order included): an unchanged census costs zero bytes on
        // the wire — exactly the point of computing server-side.
        if (!threadsRowsEqual(result.rows, this.pushedRows) || result.degraded !== this.pushedDegraded) {
          this.pushedRows = result.rows
          this.pushedDegraded = result.degraded
          this.send({ scope: 'threads', rows: result.rows, degraded: result.degraded })
        }
        if (!this.dirty) return
      }
    } finally {
      this.computing = false
    }
  }

  /** Push one notice (silently dropped once the subscription is gone). */
  private send(frame: SidechatPushFrame): void {
    if (this.closed) return
    this.onFrame(frame)
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
    this.threadsRoots = undefined
    this.onClosed()
  }
}

/**
 * Shallow row diff of the threads channel: two censuses are "the same"
 * only when every row matches on id/running/title/parentId/lastActivityAt,
 * in order (the client replaces its overlay wholesale, so order is part of
 * the frame's meaning). A never-pushed baseline (undefined) is never equal
 * — the first computation always ships the snapshot.
 */
function threadsRowsEqual(
  next: readonly SidechatGlobalThreadRow[],
  prev: readonly SidechatGlobalThreadRow[] | undefined,
): boolean {
  if (prev === undefined || prev.length !== next.length) return false
  return next.every((row, index) => {
    const old = prev[index]!
    return row.id === old.id
      && row.running === old.running
      && row.title === old.title
      && row.parentId === old.parentId
      && row.lastActivityAt === old.lastActivityAt
  })
}
