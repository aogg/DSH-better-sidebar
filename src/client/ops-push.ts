/**
 * One shared `ops` invalidation subscription per client (`/sidebar/ws/session`'s
 * `ops` frames).
 *
 * Every consumer the phase-1 polling audit named — the changes tab's session
 * lens, the editor tabs' file-op stream, the Tasks page's subagent live rows
 * and workflow telemetry — used to advance on a `usePolling` timer. They all
 * poll the SAME underlying fact, "the session event log grew", so they all
 * subscribe to the SAME signal instead: the host's `ops` frame (see
 * ../session-push.ts), a coalesced bare invalidation that says "re-pull your
 * delta once". One frame never carries event bodies — the one-shot
 * `changes.ops` / `subagents.live` / `workflows.list` fetch stays the single
 * source of data, exactly the side-chat push model (use-sidechat-push.ts).
 * A one-shot fetch on notice is NOT polling: no timer drives it.
 *
 * One socket for the whole client, not one per consumer (the turn-push.ts
 * rule): the hub's watch set is the UNION of every subscriber's sessions —
 * typically one session tree, whatever mounts happen to watch it — re-announced
 * through {@linkcode SessionPushConnection.reconcile} whenever a subscriber
 * joins, leaves or changes its set. The FIRST subscriber opens the shared
 * connection, every `ops` frame of a watched session fans out to the
 * subscribers that named it, and the LAST unsubscriber closes it.
 *
 * Availability is the socket's own story: reconnects back off 1s → 15s and
 * never give up (openSessionPush), there is NO timer-driven HTTP fallback,
 * and a successful re-open fires every subscriber's `onReconnect` so each
 * re-pulls what the outage swallowed — the delta cursor makes the catch-up
 * exact. The mount/visibility initial loads stay with the consumers
 * (one-shot fetches, unchanged).
 * @module dsh-better-sidebar/ops-push
 */
import { useEffect, useMemo, useRef } from 'react'
import { openSessionPush, type SessionPushFrame } from './session-push.ts'

/** Mirror of the host hub's own watch guard (MAX_WATCHED): the union never
 *  sends more ids than the host will keep. */
const MAX_WATCHED = 64

/** One subscriber: the sessions it named, and what an invalidation does. */
interface OpsSubscriber {
  /** Sessions whose event appends invalidate this subscriber (mutable set —
   *  a tree grows as subagent children spawn). */
  ids: ReadonlySet<string>
  /** One watched session's log grew — re-pull the subscriber's delta once. */
  onOps(sessionId: string): void
  /** The shared socket re-opened after a drop — catch up on the outage. */
  onReconnect(): void
}

/** The singleton hub: one connection alive while at least one subscriber holds it. */
interface OpsHub {
  subscribers: Set<OpsSubscriber>
  /** Re-announce the union watch set (membership changed mid-connection). */
  reconcile(): void
  close(): void
}

/** The hub, created on the first subscriber and torn down with the last. */
let hub: OpsHub | undefined

/** Fan one `ops` frame out to the subscribers that named the session. */
function fanOutOps(subscribers: ReadonlySet<OpsSubscriber>, sessionId: string): void {
  for (const subscriber of [...subscribers]) {
    if (!subscriber.ids.has(sessionId)) continue
    // A throwing subscriber is CONTAINED, not allowed to starve the rest —
    // the same isolation turn-push.ts fans out with.
    try {
      subscriber.onOps(sessionId)
    } catch (error) {
      console.error('[dsh-better-sidebar] ops subscriber error:', error)
    }
  }
}

/** Fan one reconnect out to every subscriber (each re-pulls on its own). */
function fanOutReconnect(subscribers: ReadonlySet<OpsSubscriber>): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.onReconnect()
    } catch (error) {
      console.error('[dsh-better-sidebar] ops reconnect error:', error)
    }
  }
}

/** The union of every subscriber's sessions, capped like the host caps watches. */
function unionWatchIds(subscribers: ReadonlySet<OpsSubscriber>): string[] {
  const ids = new Set<string>()
  for (const subscriber of subscribers) {
    for (const id of subscriber.ids) {
      ids.add(id)
      if (ids.size >= MAX_WATCHED) return [...ids]
    }
  }
  return [...ids]
}

/** Open (or return) the singleton hub. */
function ensureHub(): OpsHub {
  if (hub !== undefined) return hub
  const subscribers = new Set<OpsSubscriber>()
  // Reconnect bookkeeping: the FIRST open is not a reconnect (nothing was
  // missed — no frame ever arrived), only an open that follows a successful
  // connection's close is, because that gap swallowed frames. The callbacks
  // close over the LOCAL subscriber set, so a frame a dying socket delivers
  // after teardown fans out to nobody (the set emptied with the last leave).
  let connectedOnce = false
  let dropped = false
  const connection = openSessionPush(
    () => unionWatchIds(subscribers),
    (frame: SessionPushFrame) => {
      // The wire also carries phase/cwd/history/history-seed/turn frames for
      // the hooks sharing the protocol — only `ops` is this hub's business.
      if (frame.kind !== 'ops' || typeof frame.sessionId !== 'string') return
      fanOutOps(subscribers, frame.sessionId)
    },
    (open: boolean) => {
      if (open) {
        const recovered = dropped
        dropped = false
        connectedOnce = true
        if (recovered) fanOutReconnect(subscribers)
        return
      }
      if (connectedOnce) dropped = true
    },
  )
  hub = { subscribers, reconcile: () => { connection.reconcile() }, close: () => { connection.close() } }
  return hub
}

/** What a consumer hands the hook. */
export interface SessionOpsOptions {
  /**
   * Sessions whose event appends invalidate: usually the whole topology tree
   * (root first — the union's cap keeps the head), because the consumers
   * fold `changes.ops` / `subagents.live` / `workflows.list` answers of the
   * ROOT'S SUBTREE, and delegated agents write in child sessions. An empty
   * list unsubscribes (no socket at all when no subscriber remains).
   */
  sessionIds: readonly string[]
  /**
   * A watched session's log grew — re-pull the subscriber's delta once
   * (one-shot fetch; the timer-free replacement of the old poll tick).
   * @param sessionId - the session the host named, always one of
   *   `sessionIds`.
   */
  onInvalidate: (sessionId: string) => void
  /**
   * The shared socket re-opened after at least one failed attempt — the
   * FIRST open never fires this. Every frame the outage swallowed is gone,
   * so the consumer re-pulls instead of waiting for the next notice.
   */
  onReconnect?: () => void
}

/**
 * Follow the host's `ops` invalidations for the given sessions on the ONE
 * shared push socket.
 * @param options - the watched ids and the invalidation/reconnect callbacks.
 */
export function useSessionOps(options: SessionOpsOptions): void {
  const { sessionIds } = options
  // The id list is a fresh array on every render, so neither the subscription
  // effect nor the membership effect may depend on its identity. The CONTENT
  // key (NUL-joined — no session id can contain one) is what everything
  // derives from, exactly like use-sidechat-push's thread list.
  const idsKey = sessionIds.join('\u0000')
  const wanted = useMemo(() => (idsKey === '' ? [] : idsKey.split('\u0000')), [idsKey])
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const invalidateRef = useRef(options.onInvalidate)
  invalidateRef.current = options.onInvalidate
  const reconnectRef = useRef(options.onReconnect)
  reconnectRef.current = options.onReconnect
  /** The subscriber this hook owns, while it is joined. */
  const subscriberRef = useRef<OpsSubscriber | undefined>(undefined)
  /** Stable dependency: join/leave only when it gains or loses every id. */
  const subscribed = idsKey !== ''

  useEffect(() => {
    if (!subscribed) return
    const currentHub = ensureHub()
    const subscriber: OpsSubscriber = {
      ids: new Set(wantedRef.current),
      onOps: (sessionId: string) => { invalidateRef.current(sessionId) },
      onReconnect: () => { reconnectRef.current?.() },
    }
    subscriberRef.current = subscriber
    currentHub.subscribers.add(subscriber)
    currentHub.reconcile()
    return () => {
      subscriberRef.current = undefined
      currentHub.subscribers.delete(subscriber)
      if (currentHub.subscribers.size === 0 && hub === currentHub) {
        hub = undefined
        currentHub.close()
      }
    }
  }, [subscribed])

  // A membership change on the SAME socket only swaps the set and re-sends
  // the watch frame (a newly spawned subagent child joins its tree's set;
  // events it emits before the session list learns of it are folded by the
  // cursor delta of the NEXT notice, so the gap self-heals).
  useEffect(() => {
    void idsKey
    const subscriber = subscriberRef.current
    if (subscriber === undefined) return
    subscriber.ids = new Set(wanted)
    hub?.reconcile()
  }, [idsKey, wanted])
}
