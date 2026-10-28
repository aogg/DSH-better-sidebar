/**
 * Live invalidation push for Side Chat transcripts (feed channel `'sidechat'`).
 *
 * The transcript used to advance on a 2s poll while the thread ran, so a
 * claimed message, a settled assistant message or a finished tool call became
 * visible up to two seconds after the host wrote it. DSH's agent pipeline
 * offers no client-side event feed for a hidden child session, so the plugin
 * carries its own channel: one subscription per watched thread on the shared
 * feed socket (feed-hub.ts), not one socket per mounted side-chat tab — with
 * the host keeping every visited tab body mounted, per-tab sockets used to
 * multiply with the tab count.
 *
 * The host's frames are INVALIDATION ONLY — `{ threadId, running? }` says
 * "this thread's transcript is stale, re-pull `sidechat.events` with your
 * afterSeq". No event body ever crosses the socket, so the existing delta
 * pull stays the single source of transcript data and a dropped socket
 * self-heals through the same pull: the retries never stop, and the re-open
 * fires `onReconnect` so the view catches up on the outage — there is no
 * polling fallback, by design.
 *
 * The GLOBAL threads channel (`threads: true` + `onThreadsStale`) subscribes
 * to `{ scope: 'threads' }` frames — "some side thread anywhere may have
 * changed its running/title/last-activity", the freshness feed of the history
 * popover's 全局运行中 / 全局未读 groups. It is AGGREGATED at module level:
 * every subscribing tab shares ONE feed subscription (a refcounted handle on
 * the `{threads:true}` key), and each tab keeps only its own listener — N
 * tabs cost one wire subscription, not N. Same contract as the per-thread
 * channel: the frame carries no data, the view answers it with one
 * `sidechat.threads` pull (debounced, abort-guarded). Subscribe-and-pull
 * alignment: a tab fires `onThreadsStale` once when it JOINS (the shared
 * subscription may already be open — the join is its open event), and the
 * shared handle refires it on every socket re-open, because the frames the
 * outage swallowed are gone for good. Sidechat keys carry no session: the
 * thread subscriptions are cross-workspace and never ride the
 * session-dimension release.
 *
 * Lifecycle: per-thread subscriptions follow the id list (a delta sub/unsub
 * on the shared socket per change), the shared threads handle lives while at
 * least one tab subscribes it, and a component with neither ids nor `threads`
 * holds nothing.
 */
import { useEffect, useMemo, useRef } from 'react'
import { feedSubscribe, type FeedSubscription } from './feed-hub.ts'

/** One host frame: a watched thread whose transcript is stale (`threadId`),
 *  or the GLOBAL thread-set invalidation (`scope: 'threads'`). `running` is
 *  the host's own run-state hint; it is deliberately not read here — the
 *  panel re-reads both the transcript and `sidechat.info` on every notice. */
interface SidechatPushFrame {
  threadId?: unknown
  scope?: unknown
  running?: unknown
}

/** What the view hands the hook. */
export interface SidechatPushOptions {
  /** Threads to watch; an empty list holds no per-thread subscription. */
  threadIds: readonly string[]
  /**
   * A watched thread whose transcript should be re-pulled.
   * @param threadId - the thread the host named, always one of `threadIds`.
   */
  onInvalidate: (threadId: string) => void
  /**
   * The socket re-opened after at least one failed attempt — the FIRST open
   * never fires this. Every frame the outage swallowed is gone, so the view
   * re-pulls its threads instead of waiting for the next notice. Purely an
   * event callback: the retry timers stay inside the feed hub. With `threads`
   * subscribed, `onThreadsStale` fires on the same open, so a view that only
   * handles the bound thread here is still fully caught up on the overlay.
   */
  onReconnect?: () => void
  /**
   * Also join this view to the GLOBAL thread-set invalidation
   * (`{ scope: 'threads' }` frames + the join-time alignment below). The
   * view keeps its listeners even with an empty `threadIds`; the wire
   * subscription is shared across every subscribing view.
   */
  threads?: boolean
  /**
   * The GLOBAL thread set may be stale: re-pull the `sidechat.threads`
   * census. Fired when this view joins the shared channel (its alignment),
   * on every `{ scope: 'threads' }` frame AND once per re-open of the shared
   * socket while subscribed (reconnect catch-up). The caller debounces.
   */
  onThreadsStale?: () => void
}

/** The module-level shared `{threads:true}` feed subscription, plus whoever
 *  shares it. One wire subscription for every subscribing tab combined. */
let threadsSub: FeedSubscription | undefined
let threadsHandles = 0
const threadsStaleListeners = new Set<() => void>()

/** Fan one shared-channel event (a `threads` frame, a join alignment or a
 *  recovered open) out to every subscribing view. */
function fireThreadsStale(): void {
  for (const listener of [...threadsStaleListeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[dsh-better-sidebar] sidechat threads listener error:', error)
    }
  }
}

/** Join this view to the shared global-threads channel (first join opens the
 *  one wire subscription); returns the leave disposer. */
function acquireThreadsChannel(onStale: () => void): () => void {
  threadsStaleListeners.add(onStale)
  threadsHandles += 1
  if (threadsSub === undefined) {
    threadsSub = feedSubscribe({
      channel: 'sidechat',
      args: { threads: true },
      onData: (data) => {
        if (data === null || typeof data !== 'object') return
        if ((data as SidechatPushFrame).scope === 'threads') fireThreadsStale()
      },
      // The frames the outage swallowed are gone for good: every view
      // re-pulls the census on the recovered open (the caller debounces).
      onReconnect: () => { fireThreadsStale() },
    })
  }
  // Join-time alignment: the shared subscription may have been open long
  // before this view mounted, and the current global thread set would stay
  // unknown until the next host-side change. The caller debounces.
  onStale()
  return () => {
    threadsStaleListeners.delete(onStale)
    threadsHandles -= 1
    if (threadsHandles === 0 && threadsSub !== undefined) {
      threadsSub.close()
      threadsSub = undefined
    }
  }
}

/**
 * Follow the host's staleness notices for the given side-chat threads.
 * @param options - the watched ids and the invalidation/reconnect callbacks.
 */
export function useSidechatPush(options: SidechatPushOptions): void {
  const { threadIds, onInvalidate, onReconnect, threads = false, onThreadsStale } = options
  // The id list is a fresh array on every render, so neither the subscription
  // effect nor the invalidation callback may depend on its identity. The
  // CONTENT key (NUL-joined — no session id can contain one) is what
  // everything derives from.
  const idsKey = threadIds.join('\u0000')
  const wanted = useMemo(() => (idsKey === '' ? [] : idsKey.split('\u0000')), [idsKey])
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const invalidateRef = useRef(onInvalidate)
  invalidateRef.current = onInvalidate
  const reconnectRef = useRef(onReconnect)
  reconnectRef.current = onReconnect
  const threadsStaleRef = useRef(onThreadsStale)
  threadsStaleRef.current = onThreadsStale
  /** Read inside the subscription effect only (a mount-time constant in
   *  practice); the ref keeps the effect honest about option drift. */
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  /** Set by the subscription effect; applies the id-set delta on change. */
  const syncRef = useRef<() => void>(() => {})
  /** Stable dependency: subscribe only when it gains or loses every id —
   *  or when the threads channel appears or disappears. */
  const subscribed = idsKey !== '' || threads

  useEffect(() => {
    if (!subscribed) return
    /** One per-thread feed subscription, keyed by the thread id. */
    const subs = new Map<string, FeedSubscription>()
    const onData = (data: unknown): void => {
      if (data === null || typeof data !== 'object') return
      const frame = data as SidechatPushFrame
      if (frame.scope === 'threads') {
        // The GLOBAL thread-set invalidation belongs to the shared
        // `{threads:true}` channel alone (it fans out to every joined view
        // itself) — a per-thread subscription that also answered it would
        // fire each view's callback twice. Without the shared channel the
        // view stays silent (the host never sends these to a key that did
        // not join; the guard keeps the client total if one slips through).
        return
      }
      if (typeof frame.threadId !== 'string') return
      // Only watched ids: a frame for a thread this view no longer
      // subscribes to is a late notice, not an invalidation.
      if (!wantedRef.current.includes(frame.threadId)) return
      invalidateRef.current(frame.threadId)
    }
    /** Bring the per-thread subscriptions in line with the id set (a delta
     *  sub/unsub on the shared socket per change — no reconnect). */
    const sync = (): void => {
      const current = wantedRef.current
      for (const [id, sub] of [...subs]) {
        if (current.includes(id)) continue
        sub.close()
        subs.delete(id)
      }
      for (const id of current) {
        if (subs.has(id)) continue
        subs.set(id, feedSubscribe({ channel: 'sidechat', args: { threadId: id }, onData, onReconnect: () => { reconnectRef.current?.() } }))
      }
    }
    syncRef.current = sync
    sync()
    // The shared global-threads channel: one wire subscription for every
    // subscribing view combined (its leave runs on this effect's cleanup).
    const leaveThreads = threadsRef.current
      ? acquireThreadsChannel(() => { threadsStaleRef.current?.() })
      : undefined
    return () => {
      syncRef.current = () => {}
      leaveThreads?.()
      for (const sub of subs.values()) sub.close()
      subs.clear()
    }
  }, [subscribed])

  // A subscription change on the SAME socket only applies the id-set delta.
  useEffect(() => {
    void idsKey
    syncRef.current()
  }, [idsKey])
}
