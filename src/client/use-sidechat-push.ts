/**
 * Live invalidation push for Side Chat transcripts.
 *
 * The transcript used to advance on a 2s poll while the thread ran, so a
 * claimed message, a settled assistant message or a finished tool call became
 * visible up to two seconds after the host wrote it. DSH's agent pipeline
 * offers no client-side event feed for a hidden child session, so the plugin
 * carries its own channel: one socket per mounted side-chat tab, watching the
 * single thread that tab is bound to.
 *
 * The host's frames are INVALIDATION ONLY — `{ threadId, running? }` says
 * "this thread's transcript is stale, re-pull `sidechat.events` with your
 * afterSeq". No event body ever crosses this socket, so the existing delta
 * pull stays the single source of transcript data and a dropped socket
 * self-heals through the same pull: the retries never stop, and the re-open
 * fires `onReconnect` so the view catches up on the outage — there is no
 * polling fallback, by design.
 *
 * The GLOBAL threads channel (`threads: true` + `onThreadsStale`) subscribes
 * the same socket to `{ scope: 'threads' }` frames — "some side thread
 * anywhere may have changed its running/title/last-activity", the freshness
 * feed of the history popover's 全局运行中 / 全局未读 groups. Same contract
 * as the per-thread channel: the frame carries no data, the view answers it
 * with one `sidechat.threads` pull (debounced, abort-guarded). The FIRST
 * successful open also fires `onThreadsStale` — subscribe-and-pull
 * alignment, because the watch frame only tells the host what to watch from
 * NOW on, and the current thread set would stay unknown until the next
 * host-side change. A re-open after a drop fires it again (frames the outage
 * swallowed are gone for good), next to `onReconnect`.
 *
 * Lifecycle mirrors use-dir-watch: one socket for the component's lifetime,
 * a full `watch` frame re-announcing the subscription set whenever the id
 * list changes, exponential backoff (1s → 15s, forever) on a drop — whose
 * successful exit fires `onReconnect` — and no socket at all while the list
 * is empty, UNLESS `threads` keeps it alive: a tab with no bound thread must
 * still hear the global thread set (that is its history popover's live feed).
 */
import { useEffect, useMemo, useRef } from 'react'
import { hostWebSocketUrl } from './host-route-url.ts'

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
  /** Threads to watch; an empty list closes the socket entirely. */
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
   * event callback: the retry timers stay inside this hook. With `threads`
   * subscribed, `onThreadsStale` fires on the same open, so a view that only
   * handles the bound thread here is still fully caught up on the overlay.
   */
  onReconnect?: () => void
  /**
   * Also subscribe this socket to the GLOBAL thread-set invalidation
   * (`{ scope: 'threads' }` frames + the open-time alignment below). Keeps
   * the socket alive even with an empty `threadIds`.
   */
  threads?: boolean
  /**
   * The GLOBAL thread set may be stale: re-pull the `sidechat.threads`
   * census. Fired on every `{ scope: 'threads' }` frame AND once per
   * successful open while subscribed (first open = initial alignment, later
   * opens = the reconnect catch-up). The caller debounces.
   */
  onThreadsStale?: () => void
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/**
 * Follow the host's staleness notices for the given side-chat threads.
 * @param options - the watched ids and the invalidation/reconnect callbacks.
 */
export function useSidechatPush(options: SidechatPushOptions): void {
  const { threadIds, onInvalidate, onReconnect, threads = false, onThreadsStale } = options
  // The id list is a fresh array on every render, so neither the socket effect
  // nor the invalidation callback may depend on its identity. The CONTENT key
  // (NUL-joined — no session id can contain one) is what everything derives
  // from, exactly like use-dir-watch's expanded set.
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
  /** Read inside the socket effect only (a mount-time constant in practice);
   *  the ref keeps the effect honest about not re-opening on option drift. */
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  /** Set by the socket effect; re-announces the current subscription set. */
  const reconcileRef = useRef<() => void>(() => {})
  /** Stable dependency: re-open the socket only when it gains or loses every
   *  id — or when the threads channel appears or disappears. */
  const subscribed = idsKey !== '' || threads

  useEffect(() => {
    if (!subscribed) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0

    /** Push this socket's whole subscription set (a full replacement). */
    const reconcile = (): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          op: 'watch',
          threadIds: [...wantedRef.current],
          // Absent without the threads subscription: the host treats the
          // bare frame exactly as before (backward compatibility).
          ...(threadsRef.current ? { threads: true } : {}),
        }))
      }
    }
    reconcileRef.current = reconcile

    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(hostWebSocketUrl('sidebar/ws/sidechat').toString())
      socket.onopen = () => {
        // A re-open after a drop: report the recovery so the view re-pulls
        // what the outage swallowed. The first successful open is not a
        // reconnect, so it stays silent.
        const recovered = failures > 0
        failures = 0
        reconcile()
        if (recovered) reconnectRef.current?.()
        // Subscribe-and-pull alignment, on EVERY open (first = initial
        // alignment; a later open = the frames the outage swallowed are
        // gone): without this the current global thread set stays unknown
        // until the next host-side change. The caller's debounce folds this
        // together with the onReconnect catch-up on a recovered open.
        if (threadsRef.current) threadsStaleRef.current?.()
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        let frame: SidechatPushFrame
        try {
          frame = JSON.parse(event.data) as SidechatPushFrame
        } catch {
          return
        }
        if (frame === null || typeof frame !== 'object') return
        if (frame.scope === 'threads') {
          // The GLOBAL thread set may be stale — no thread id, no data. A
          // socket that never subscribed stays silent (the host promises not
          // to send these; the guard keeps the client total if one ever
          // slips through, symmetric with the watched-id check below).
          if (threadsRef.current) threadsStaleRef.current?.()
          return
        }
        if (typeof frame.threadId !== 'string') return
        // Only watched ids: a frame for a thread this socket no longer
        // subscribes to is a late notice, not an invalidation.
        if (!wantedRef.current.includes(frame.threadId)) return
        invalidateRef.current(frame.threadId)
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        retry = window.setTimeout(connect, Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS))
      }
    }
    connect()

    return () => {
      closed = true
      reconcileRef.current = () => {}
      if (retry !== undefined) window.clearTimeout(retry)
      socket?.close()
    }
  }, [subscribed])

  // A subscription change on the SAME socket only re-sends the watch frame.
  useEffect(() => {
    void idsKey
    reconcileRef.current()
  }, [idsKey])
}
