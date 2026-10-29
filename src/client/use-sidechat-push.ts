/**
 * Live push for Side Chat (feed channel `'sidechat'`): per-thread transcript
 * INVALIDATION notices plus the GLOBAL threads channel's census DATA.
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
 * The host's per-thread frames are INVALIDATION ONLY — `{ threadId }` says
 * "this thread's transcript is stale, re-pull `sidechat.events` with your
 * afterSeq". No event body ever crosses the socket, so the existing delta
 * pull stays the single source of transcript data and a dropped socket
 * self-heals through the same pull: the retries never stop, and the re-open
 * fires `onReconnect` so the view catches up on the outage — there is no
 * polling fallback, by design.
 *
 * The GLOBAL threads channel subscribes with `{ threads: true }` and is
 * AGGREGATED at module level: every subscribing tab shares ONE feed
 * subscription (a refcounted handle on that key), and each tab keeps only
 * its own listener — N tabs cost one wire subscription, not N. The census
 * ROOTS each view computes (its session list's top-level sessions) ride a
 * `watch` control frame on that SAME key — never the key itself, so a
 * changing session list re-arms the computation instead of tearing the
 * subscription. With roots reported, the host pushes the census itself:
 * `{ scope: 'threads', rows, degraded }` frames REPLACE the overlay
 * wholesale (`onThreadsRows`), and the host diffs before sending, so an
 * unchanged thread set costs zero bytes and ZERO HTTP — the old
 * "empty frame → debounced `sidechat.threads` POST per surface" round trip
 * is gone. Alignment is push-native: the host snapshots on the first
 * data-mode watch (join, re-open, roots update); a joining view is also
 * handed the module-level last-known rows at once, so it never starts
 * empty. Legacy frames without a `rows` array (an old host, or the
 * pre-watch milliseconds) are ignored here — the watch-triggered snapshot
 * is the alignment.
 *
 * Lifecycle: per-thread subscriptions follow the id list (a delta sub/unsub
 * on the shared socket per change), the shared threads handle lives while at
 * least one tab subscribes it, and a component with neither ids nor `threads`
 * holds nothing. Sidechat keys carry no session: the thread subscriptions
 * are cross-workspace and never ride the session-dimension release.
 */
import { useEffect, useMemo, useRef } from 'react'
import { feedSubscribe, type FeedSubscription } from './feed-hub.ts'
import type { SidechatGlobalThreadRow } from '../sidechat-core.ts'

/** One host frame: a watched thread whose transcript is stale (`threadId`),
 *  or the GLOBAL threads channel — legacy invalidation (`scope` alone) or
 *  the census data frame (`scope` + `rows` + `degraded`). `running` is the
 *  host's own run-state hint; it is deliberately not read here — the
 *  transcript re-read re-derives everything it shows. */
interface SidechatPushFrame {
  threadId?: unknown
  scope?: unknown
  running?: unknown
  rows?: unknown
  degraded?: unknown
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
   * re-pulls its bound thread instead of waiting for the next notice. Purely
   * an event callback: the retry timers stay inside the feed hub. The GLOBAL
   * threads channel needs no reconnect hook — the re-open replays its
   * `watch` and the host answers with a fresh census snapshot.
   */
  onReconnect?: () => void
  /**
   * Also join this view to the GLOBAL threads channel. The view keeps its
   * listener even with an empty `threadIds`; the wire subscription is shared
   * across every subscribing view.
   */
  threads?: boolean
  /**
   * This view's census roots: its session list's TOP-LEVEL session ids
   * (`origin !== 'subagent'`, capped at 64 both ends). Reported to the
   * shared channel's `watch` frame whenever their CONTENT changes — never
   * part of the subscription key. Absent/empty keeps the channel in its
   * (harmless) legacy mode until a view reports roots.
   */
  threadRoots?: readonly string[]
  /**
   * The GLOBAL census, pushed: the wholesale replacement of the history
   * popover's overlay. Fired with the module cache the moment this view
   * joins (its alignment), on every data frame, and — after a socket
   * re-open — on the snapshot the replayed watch triggers. `degraded: true`
   * means "cannot compute right now": the caller keeps its store-derived
   * groups (the conventional answer is an empty overlay).
   */
  onThreadsRows?: (rows: readonly SidechatGlobalThreadRow[], degraded: boolean) => void
}

/** The module-level shared `{threads:true}` feed subscription, plus whoever
 *  shares it. One wire subscription for every subscribing tab combined. */
let threadsSub: FeedSubscription | undefined
let threadsHandles = 0
const threadsRowListeners = new Set<(rows: readonly SidechatGlobalThreadRow[], degraded: boolean) => void>()
/** The last data frame's rows: a joining view's synchronous alignment (it
 *  would otherwise start from an empty overlay until the next push). */
let latestRows: readonly SidechatGlobalThreadRow[] | undefined
let latestDegraded = false
/** The roots the wire was last armed with (content-compared, so a repeated
 *  identical report sends nothing). Reset when the shared subscription dies,
 *  so its successor is armed again even for the same list. */
let reportedRoots: readonly string[] | undefined

/** Fan one census data frame out to every subscribing view (contained:
 *  a throwing listener never starves the rest). */
function fireThreadsRows(rows: readonly SidechatGlobalThreadRow[], degraded: boolean): void {
  for (const listener of [...threadsRowListeners]) {
    try {
      listener(rows, degraded)
    } catch (error) {
      console.error('[dsh-better-sidebar] sidechat threads listener error:', error)
    }
  }
}

/** Report this view's census roots to the shared channel: a `watch` frame on
 *  the SAME subscription key whenever the CONTENT changed (the host answers
 *  with the alignment snapshot, diffed — an unchanged world costs nothing). */
function reportThreadsRoots(roots: readonly string[]): void {
  const same = reportedRoots !== undefined
    && reportedRoots.length === roots.length
    && roots.every((id, index) => reportedRoots![index] === id)
  if (same) return
  reportedRoots = [...roots]
  threadsSub?.watch({ roots: [...roots] })
}

/** Test seam: tear the shared threads channel down (subscription, listeners
 *  and the alignment cache) so a spec whose probes do not always retire
 *  every handle starts each test clean. */
export function threadsChannelResetForTests(): void {
  threadsSub?.close()
  threadsSub = undefined
  threadsHandles = 0
  threadsRowListeners.clear()
  latestRows = undefined
  latestDegraded = false
  reportedRoots = undefined
}

/** Join this view to the shared global-threads channel (first join opens the
 *  one wire subscription); returns the leave disposer. */
function acquireThreadsChannel(onRows: (rows: readonly SidechatGlobalThreadRow[], degraded: boolean) => void): () => void {
  threadsRowListeners.add(onRows)
  threadsHandles += 1
  if (threadsSub === undefined) {
    threadsSub = feedSubscribe({
      channel: 'sidechat',
      args: { threads: true },
      onData: (data) => {
        if (data === null || typeof data !== 'object') return
        const frame = data as SidechatPushFrame
        if (frame.scope !== 'threads') return
        // A data frame REPLACES the overlay wholesale; the cache update
        // keeps future joins aligned without any pull. A frame without a
        // rows array is the LEGACY invalidation (old host, or the
        // milliseconds before our watch lands): nothing to apply — the
        // watch-triggered snapshot is the alignment.
        if (!Array.isArray(frame.rows)) return
        latestRows = frame.rows as readonly SidechatGlobalThreadRow[]
        latestDegraded = frame.degraded === true
        fireThreadsRows(latestRows, latestDegraded)
      },
      // No reconnect fire: the re-open replays the stored `watch` and the
      // host's alignment snapshot arrives as an ordinary data frame.
    })
  }
  // Join-time alignment from the shared cache: this view may have mounted
  // long after the last push, and it must not start from an empty overlay.
  if (latestRows !== undefined) onRows(latestRows, latestDegraded)
  return () => {
    threadsRowListeners.delete(onRows)
    threadsHandles -= 1
    if (threadsHandles === 0 && threadsSub !== undefined) {
      threadsSub.close()
      threadsSub = undefined
      // The successor subscription is a fresh one server-side: force the
      // next view's roots report through, whatever the list looks like.
      reportedRoots = undefined
    }
  }
}

/**
 * Follow the host's push for the given side-chat threads.
 * @param options - the watched ids, the census roots and the callbacks.
 */
export function useSidechatPush(options: SidechatPushOptions): void {
  const { threadIds, onInvalidate, onReconnect, threads = false, threadRoots, onThreadsRows } = options
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
  const threadsRowsRef = useRef(onThreadsRows)
  threadsRowsRef.current = onThreadsRows
  /** Read inside the subscription and roots effects (a mount-time constant
   *  in practice); the ref keeps the effects honest about option drift. */
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
        // The GLOBAL threads channel belongs to the shared `{threads:true}`
        // subscription alone (it fans out to every joined view itself) — a
        // per-thread subscription that also answered it would fire each
        // view's callback twice. Without the shared channel the view stays
        // silent (the host never sends these to a key that did not join;
        // the guard keeps the client total if one slips through).
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
      ? acquireThreadsChannel((rows, degraded) => { threadsRowsRef.current?.(rows, degraded) })
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

  // The census roots ride the shared channel's `watch` frame: reported when
  // their CONTENT changes, on the same key, never a resubscription. Declared
  // AFTER the subscription effect, so the shared handle exists when this
  // runs (the first mount reports through it directly).
  const rootsKey = (threadRoots ?? []).join('\u0000')
  const wantedRoots = useMemo(() => (rootsKey === '' ? [] : rootsKey.split('\u0000')), [rootsKey])
  const wantedRootsRef = useRef(wantedRoots)
  wantedRootsRef.current = wantedRoots
  useEffect(() => {
    if (!threadsRef.current) return
    reportThreadsRoots(wantedRootsRef.current)
  }, [rootsKey, threads])
}
