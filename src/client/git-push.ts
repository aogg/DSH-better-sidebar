/**
 * `git` invalidation subscriptions per session (`/sidebar/ws/git`).
 *
 * Every git-domain consumer the phase-2 polling audit named — the shared
 * status store (`ui/git-status.ts`), the changes tab's Git lens
 * (`changes/GitLens.tsx`), the round-commits lens and the round-diff
 * lens — used to advance on a `usePolling` timer. They all react to the
 * SAME fact, "some checkout's git state moved", so they all subscribe to
 * the SAME signal instead: the host's `git` frame (see ../git-push.ts),
 * a debounced bare invalidation that names the worktree and says
 * "re-pull once". One frame never carries git output — the one-shot
 * `git.status` / `git.worktrees` / `git.log` / `git.diff-range` fetch
 * stays the single source of data, exactly the ops-push model. A
 * one-shot fetch on notice is NOT polling: no timer drives it.
 *
 * ONE CONNECTION PER SESSION — the endpoint's own fence: the host only
 * accepts `/sidebar/ws/git` with `?sessionId=` on the URL (a bare one
 * is answered with an immediate 1008 close) and resolves every watch
 * spelling against THAT session's cwd chain, so subscribers of
 * different sessions can never share a socket. Each session's hub is
 * the ops-push shape in miniature, keyed by sessionId: one connection
 * whose watch set is the UNION of that session's subscribers'
 * worktrees — typically the few checkouts of the session's repository —
 * re-announced through {@linkcode GitPushConnection.reconcile} whenever
 * a subscriber joins, leaves or changes its set. The FIRST subscriber
 * of a session opens its connection, every `git` frame of a watched
 * worktree fans out to the subscribers that named it, and a session's
 * LAST unsubscriber closes its connection. Sessions are fully
 * independent — each connection owns its own backoff bookkeeping, so
 * one session's drops and retries never disturb another's.
 *
 * Availability is each socket's own story: reconnects back off 1s → 15s
 * and never give up (openGitPush), there is NO timer-driven HTTP
 * fallback, and a successful re-open fires every subscriber's
 * `onReconnect` so each re-pulls what the outage swallowed. The
 * mount/visibility initial loads stay with the consumers (one-shot
 * fetches, unchanged).
 *
 * Two entry points share the hubs: the {@linkcode useGitWatch} hook for
 * React consumers (the lenses) and {@linkcode subscribeGitWatch} for the
 * status store, whose slot lifecycle is imperative (retain/release, not
 * mount/unmount).
 * @module dsh-better-sidebar/git-push
 */
import { useEffect, useMemo, useRef } from 'react'
import { hostWebSocketUrl } from './host-route-url.ts'

/** One host frame: the worktree it names changed (the client's own spelling).
 *  `paths`, when present, narrows the reaction: the worktree-relative POSIX
 *  paths the host's file watcher saw move inside its burst window (deduped,
 *  capped — an overflow degrades the field away). Absent on pure `.git`
 *  metadata events (stage / commit / checkout can move any path) and on
 *  overflow, which is the plain "something moved" notice every consumer
 *  already answers with a full re-pull. */
export interface GitPushFrame {
  kind: 'git'
  worktree: string
  paths?: string[]
}

/** Mirror of the host hub's own watch guard (MAX_WATCHED): the union never
 *  sends more paths than the host will keep. */
const MAX_WATCHED = 32

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/** A live git push connection: close it, or re-announce its watch set. */
export interface GitPushConnection {
  /**
   * Re-send the whole watch frame (a full replacement). For a getter-based
   * connection whose worktrees change mid-flight — a session hub's union
   * of subscriber sets — this is how a membership change reaches the host
   * without a reconnect.
   */
  reconcile(): void
  /** Close the connection and stop its retries (idempotent). */
  close(): void
}

/**
 * Open ONE session's git push socket for a mutable watch set.
 * @param sessionId - the session the endpoint is fenced on: it rides the
 *   URL (`?sessionId=` — without it the host closes with 1008) and every
 *   watch spelling resolves against that session's cwd chain.
 * @param worktrees - worktrees to watch, re-read on every open AND every
 *   {@linkcode GitPushConnection.reconcile} (the session hub feeds it the
 *   union of its subscribers' sets).
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal (observability; the hub
 *   stays connected either way — a drop just means frames pause until the
 *   next successful reconnect).
 * @returns the live connection (close it to tear down; idempotent).
 */
export function openGitPush(
  sessionId: string,
  worktrees: () => readonly string[],
  onFrame: (frame: GitPushFrame) => void,
  onState?: (open: boolean) => void,
): GitPushConnection {
  let socket: WebSocket | null = null
  let retry: number | undefined
  let closed = false
  let failures = 0

  /** Push the whole watch set (a full replacement, also after a reconnect). */
  const sendWatch = (): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'watch', worktrees: [...worktrees()].slice(0, MAX_WATCHED) }))
    }
  }

  const connect = (): void => {
    if (closed) return
    // The session fence rides the URL, exactly like fs-watch's and
    // agent-opens' sockets: a bare URL is refused with 1008 by the host.
    const url = hostWebSocketUrl('sidebar/ws/git')
    url.search = new URLSearchParams({ sessionId }).toString()
    socket = new WebSocket(url.toString())
    socket.onopen = () => {
      failures = 0
      onState?.(true)
      sendWatch()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let frame: GitPushFrame
      try {
        frame = JSON.parse(event.data) as GitPushFrame
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object') return
      // A malformed or foreign frame is a late/dirty notice, not an invalidation.
      if (frame.kind !== 'git' || typeof frame.worktree !== 'string' || frame.worktree === '') return
      onFrame(frame)
    }
    socket.onclose = () => {
      if (closed) return
      onState?.(false)
      failures += 1
      retry = window.setTimeout(connect, Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS))
    }
  }
  connect()

  return {
    reconcile: sendWatch,
    close: () => {
      closed = true
      if (retry !== undefined) window.clearTimeout(retry)
      socket?.close()
    },
  }
}

/** One subscriber: the worktrees it named, and what an invalidation does. */
interface GitSubscriber {
  /** Worktrees whose changes invalidate this subscriber (mutable set —
   *  the lenses re-point it as the inventory answer changes). */
  worktrees: ReadonlySet<string>
  /** One watched worktree's git state moved — re-pull once. `paths`
   *  narrows the pull to the paths the host saw move (absent = unknown:
   *  the full re-pull). */
  onGit(worktree: string, paths?: string[]): void
  /** The session's socket re-opened after a drop — catch up on the outage. */
  onReconnect(): void
}

/** One session's hub: one connection alive while at least one of that
 *  session's subscribers holds it. */
interface GitHub {
  subscribers: Set<GitSubscriber>
  /** Re-announce the union watch set (membership changed mid-connection). */
  reconcile(): void
  close(): void
}

/** The hubs, one per session — keyed by the endpoint's own fence: the
 *  sessionId the URL must carry and the host resolves watch paths against. */
const hubs = new Map<string, GitHub>()

/** Fan one `git` frame out to the subscribers that named the worktree. */
function fanOutGit(subscribers: ReadonlySet<GitSubscriber>, frame: GitPushFrame): void {
  for (const subscriber of [...subscribers]) {
    if (!subscriber.worktrees.has(frame.worktree)) continue
    // A throwing subscriber is CONTAINED, not allowed to starve the rest —
    // the same isolation turn-push.ts and ops-push.ts fan out with.
    try {
      subscriber.onGit(frame.worktree, frame.paths)
    } catch (error) {
      console.error('[dsh-better-sidebar] git subscriber error:', error)
    }
  }
}

/** Fan one reconnect out to every subscriber (each re-pulls on its own). */
function fanOutReconnect(subscribers: ReadonlySet<GitSubscriber>): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.onReconnect()
    } catch (error) {
      console.error('[dsh-better-sidebar] git reconnect error:', error)
    }
  }
}

/** The union of one session's subscribers' worktrees, capped like the host
 *  caps watches. */
function unionWorktrees(subscribers: ReadonlySet<GitSubscriber>): string[] {
  const paths = new Set<string>()
  for (const subscriber of subscribers) {
    for (const path of subscriber.worktrees) {
      paths.add(path)
      if (paths.size >= MAX_WATCHED) return [...paths]
    }
  }
  return [...paths]
}

/** Open (or return) one session's hub. */
function ensureHub(sessionId: string): GitHub {
  const existing = hubs.get(sessionId)
  if (existing !== undefined) return existing
  const subscribers = new Set<GitSubscriber>()
  // Reconnect bookkeeping: the FIRST open is not a reconnect (nothing was
  // missed — no frame ever arrived), only an open that follows a
  // successful connection's close is, because that gap swallowed frames.
  // The callbacks close over the LOCAL subscriber set, so a frame a dying
  // socket delivers after teardown fans out to nobody (the set emptied
  // with that session's last leave).
  let connectedOnce = false
  let dropped = false
  const connection = openGitPush(
    sessionId,
    () => unionWorktrees(subscribers),
    (frame: GitPushFrame) => { fanOutGit(subscribers, frame) },
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
  const hub: GitHub = { subscribers, reconcile: () => { connection.reconcile() }, close: () => { connection.close() } }
  hubs.set(sessionId, hub)
  return hub
}

/** Join a subscriber with a non-empty set; the session's first join opens
 *  its socket. */
function joinGitHub(sessionId: string, subscriber: GitSubscriber): void {
  const hub = ensureHub(sessionId)
  hub.subscribers.add(subscriber)
  hub.reconcile()
}

/** Leave the session's hub; the session's last leave tears its socket down. */
function leaveGitHub(sessionId: string, subscriber: GitSubscriber): void {
  const hub = hubs.get(sessionId)
  if (hub === undefined) return
  hub.subscribers.delete(subscriber)
  if (hub.subscribers.size === 0) {
    hubs.delete(sessionId)
    hub.close()
  }
}

/** What a consumer hands the hook. */
export interface GitWatchOptions {
  /**
   * The session whose connection this subscriber joins — the endpoint's
   * own fence: the URL carries it and the host resolves every watch
   * spelling against that session's cwd chain. `undefined` unsubscribes
   * (no socket of any session is held for the consumer).
   */
  sessionId: string | undefined
  /**
   * Worktrees whose changes invalidate. An empty list unsubscribes (no
   * socket at all when no subscriber remains) — pass `[]` while hidden to
   * park the consumer, exactly the `enabled: false` the old pollers took.
   */
  worktrees: readonly string[]
  /**
   * A watched worktree's git state moved — re-pull once (a one-shot fetch;
   * the timer-free replacement of the old poll tick).
   * @param worktree - the checkout the host named, always one of
   *  `worktrees` (the hub filters by set membership).
   * @param paths - the worktree-relative POSIX paths the host saw move,
   *  when it could name them (absent: pure `.git` metadata event or an
   *  overflow — the reaction is the full re-pull). A consumer may ignore
   *  it; the full pull stays correct in every case.
   */
  onInvalidate: (worktree: string, paths?: string[]) => void
  /**
   * The session's socket re-opened after at least one failed attempt —
   * the FIRST open never fires this. Every frame the outage swallowed is
   * gone, so the consumer re-pulls instead of waiting for the next notice.
   */
  onReconnect?: () => void
}

/**
 * Follow the host's `git` invalidations for the given worktrees on the
 * session's ONE push socket.
 * @param options - the session, the watched paths and the
 * invalidation/reconnect callbacks.
 */
export function useGitWatch(options: GitWatchOptions): void {
  const { sessionId, worktrees } = options
  // The path list is a fresh array on every render, so neither the
  // subscription effect nor the membership effect may depend on its
  // identity. The CONTENT key (NUL-joined — no path can contain one) is
  // what everything derives from, exactly like ops-push's session list.
  const setKey = worktrees.join('\u0000')
  const wanted = useMemo(() => (setKey === '' ? [] : setKey.split('\u0000')), [setKey])
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const invalidateRef = useRef(options.onInvalidate)
  invalidateRef.current = options.onInvalidate
  const reconnectRef = useRef(options.onReconnect)
  reconnectRef.current = options.onReconnect
  /** The subscriber this hook owns, while it is joined. */
  const subscriberRef = useRef<GitSubscriber | undefined>(undefined)
  /** Stable dependency: join/leave only when it gains or loses every path. */
  const subscribed = sessionId !== undefined && setKey !== ''

  useEffect(() => {
    if (!subscribed || sessionId === undefined) return
    const currentHub = ensureHub(sessionId)
    const subscriber: GitSubscriber = {
      worktrees: new Set(wantedRef.current),
      onGit: (worktree: string, paths?: string[]) => { invalidateRef.current(worktree, paths) },
      onReconnect: () => { reconnectRef.current?.() },
    }
    subscriberRef.current = subscriber
    currentHub.subscribers.add(subscriber)
    currentHub.reconcile()
    return () => {
      subscriberRef.current = undefined
      currentHub.subscribers.delete(subscriber)
      if (currentHub.subscribers.size === 0 && hubs.get(sessionId) === currentHub) {
        hubs.delete(sessionId)
        currentHub.close()
      }
    }
    // The session is part of the connection's identity: a session switch
    // tears the OLD session's subscription down (possibly closing its
    // socket when this was its last subscriber) and joins the new one's.
  }, [subscribed, sessionId])

  // A membership change on the SAME socket only swaps the set and re-sends
  // the watch frame (a newly created linked worktree joins the set once the
  // inventory answer names it; changes before that land are folded by the
  // NEXT notice after the reconcile, so the gap self-heals).
  useEffect(() => {
    void setKey
    const subscriber = subscriberRef.current
    if (subscriber === undefined) return
    subscriber.worktrees = new Set(wanted)
    const hub = sessionId === undefined ? undefined : hubs.get(sessionId)
    hub?.reconcile()
  }, [setKey, wanted, sessionId])
}

/** An imperative subscription (the status store's slot lifecycle). */
export interface GitWatchHandle {
  /** Replace the watched set (an empty set parks the subscription). */
  setWorktrees(worktrees: readonly string[]): void
  /** Unsubscribe (idempotent). */
  close(): void
}

/**
 * Follow the host's `git` invalidations without a React lifecycle — the
 * shared status store's slots retain/release outside any component.
 * @param sessionId - the session whose connection the subscription joins
 *   (the endpoint's fence; watch spellings resolve against its cwd chain).
 * @param worktrees - the worktrees to watch (empty: nothing is joined
 *   until {@linkcode GitWatchHandle.setWorktrees} names one).
 * @param onInvalidate - one watched worktree moved; re-pull once. The
 *   optional `paths` argument narrows the pull to what the host saw move.
 * @param onReconnect - the session's socket re-opened after a drop; catch up.
 * @returns the subscription handle (close it with the slot's release).
 */
export function subscribeGitWatch(
  sessionId: string,
  worktrees: readonly string[],
  onInvalidate: (worktree: string, paths?: string[]) => void,
  onReconnect?: () => void,
): GitWatchHandle {
  const subscriber: GitSubscriber = {
    worktrees: new Set(worktrees.slice(0, MAX_WATCHED)),
    onGit: (worktree: string, paths?: string[]) => { onInvalidate(worktree, paths) },
    onReconnect: () => { onReconnect?.() },
  }
  let joined = false
  /** Join lazily and leave on empty: an empty set must neither open nor
   * hold the session's socket (the hook's `subscribed` flag, imperatively). */
  const sync = (): void => {
    if (joined) {
      if (subscriber.worktrees.size === 0) {
        joined = false
        leaveGitHub(sessionId, subscriber)
        return
      }
      hubs.get(sessionId)?.reconcile()
      return
    }
    if (subscriber.worktrees.size === 0) return
    joined = true
    joinGitHub(sessionId, subscriber)
  }
  sync()
  return {
    setWorktrees: (next: readonly string[]) => {
      subscriber.worktrees = new Set(next.slice(0, MAX_WATCHED))
      sync()
    },
    close: () => {
      if (!joined) return
      joined = false
      leaveGitHub(sessionId, subscriber)
    },
  }
}
