/**
 * One shared file-tree background-job subscription per session
 * (`/sidebar/ws/fs-jobs`).
 *
 * The two background jobs the phase-3 polling audit named — the file tree's
 * zip-and-download build (FileTree.tsx, `archive.status` every 250ms) and
 * the paste/move progress card (transfer-client.ts,
 * `fs.transferStatus` every 400ms) — used to advance on timer-driven HTTP
 * polls. They both follow the SAME fact, "one job id's status moved", so
 * they both subscribe to the SAME signal instead: the host's `fs-jobs`
 * frame (see ../fs-jobs-push.ts) carrying that job's status snapshot —
 * progress and terminal states alike, so nothing degrades compared to the
 * polls it replaces. A one-shot fetch on notice is NOT polling: no timer
 * drives it.
 *
 * One socket per SESSION (the fs-watch model — archive frames are fenced to
 * the socket's `?sessionId=`), not one per consumer (the turn-push rule):
 * each hub's watch set is the UNION of its subscribers' job ids — one
 * archive build and one transfer card, at most — re-announced through
 * {@linkcode FsJobsPushConnection.reconcile} whenever a subscriber joins,
 * leaves or changes its set. The FIRST subscriber opens the shared
 * connection, every frame of a watched id fans out to the subscribers that
 * named it, and the LAST unsubscriber closes it.
 *
 * Availability is the socket's own story: reconnects back off 1s → 15s and
 * never give up, there is NO timer-driven HTTP fallback, and a successful
 * re-open after a drop fires every subscriber's `onReconnect` so each
 * re-pulls once — the frames the outage swallowed are gone, and the host's
 * subscribe-time snapshot alone must not be the only catch-up.
 *
 * Two entry points share each hub: the {@linkcode useFsJobsWatch} hook for
 * React consumers (the file tree's archive strip) and
 * {@linkcode subscribeFsJobsWatch} for the transfer card, whose lifecycle is
 * imperative (a module store, not a component).
 * @module dsh-better-sidebar/fs-jobs-push
 */
import { useEffect, useMemo, useRef } from 'react'
import { hostWebSocketUrl } from './host-route-url.ts'

/** One transfer job's status snapshot (the frame payload, never the bytes). */
export interface TransferPushStatus {
  transferId: string
  mode: 'copy' | 'move'
  state: 'running' | 'canceling' | 'done' | 'error' | 'canceled'
  totalFiles: number
  totalBytes: number
  filesDone: number
  bytesDone: number
  itemErrors: readonly string[]
  error?: string
}

/** One host frame: a followed job's status snapshot. */
export type FsJobsFrame =
  | { kind: 'archive'; id: string; state: 'building' | 'ready' | 'error'; bytes: number; error?: string }
  | { kind: 'transfer' } & TransferPushStatus

/** Mirror of the host hub's own guard (MAX_JOBS): the union never names
 *  more ids than the host will keep. */
const MAX_JOBS = 64

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/** The job id one frame is about, whichever registry holds it. */
function frameJobId(frame: FsJobsFrame): string {
  return frame.kind === 'archive' ? frame.id : frame.transferId
}

/** A live fs-jobs push connection: close it, or re-announce its watch set. */
export interface FsJobsPushConnection {
  /** Re-send the whole watch frame (a full replacement, also after a reconnect). */
  reconcile(): void
  /** Close the connection and stop its retries (idempotent). */
  close(): void
}

/**
 * Open the fs-jobs push socket of one session for a mutable watch set.
 * @param sessionId - the session scope (the archive fence; carried in the URL).
 * @param jobs - job ids to watch, re-read on every open AND every
 *   {@linkcode FsJobsPushConnection.reconcile} (the hub feeds it the union
 *   of its subscribers' sets).
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal (the hub derives its reconnect
 *   bookkeeping from it; it stays connected either way — a drop just means
 *   frames pause until the next successful reconnect).
 * @returns the live connection (close it to tear down; idempotent).
 */
export function openFsJobsPush(
  sessionId: string,
  jobs: () => readonly string[],
  onFrame: (frame: FsJobsFrame) => void,
  onState?: (open: boolean) => void,
): FsJobsPushConnection {
  let socket: WebSocket | null = null
  let retry: number | undefined
  let closed = false
  let failures = 0

  /** Push the whole watch set (a full replacement, also after a reconnect). */
  const sendWatch = (): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'watch', jobs: [...jobs()].slice(0, MAX_JOBS) }))
    }
  }

  const connect = (): void => {
    if (closed) return
    const url = hostWebSocketUrl('sidebar/ws/fs-jobs')
    url.search = new URLSearchParams({ sessionId }).toString()
    socket = new WebSocket(url.toString())
    socket.onopen = () => {
      failures = 0
      onState?.(true)
      sendWatch()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let frame: FsJobsFrame
      try {
        frame = JSON.parse(event.data) as FsJobsFrame
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object' || typeof frame.kind !== 'string') return
      // A malformed or foreign frame is noise, never a status update.
      if (frame.kind === 'archive') {
        if (typeof frame.id !== 'string' || frame.id === '') return
        if (frame.state !== 'building' && frame.state !== 'ready' && frame.state !== 'error') return
      } else if (frame.kind === 'transfer') {
        if (typeof frame.transferId !== 'string' || frame.transferId === '') return
      } else {
        return
      }
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

/** One subscriber: the job ids it named, and what a frame does. */
interface FsJobsSubscriber {
  /** Jobs whose frames reach this subscriber (terminal states shrink it). */
  jobs: ReadonlySet<string>
  /** One watched job's status moved — apply it (progress or terminal). */
  onFrame(frame: FsJobsFrame): void
  /** The shared socket re-opened after a drop — catch up with one fetch. */
  onReconnect(): void
}

/** One session's hub: one connection alive while at least one subscriber holds it. */
interface FsJobsHub {
  subscribers: Set<FsJobsSubscriber>
  /** Re-announce the union watch set (membership changed mid-connection). */
  reconcile(): void
  close(): void
}

/** One hub per session (archive frames are fenced to the socket's session). */
const hubs = new Map<string, FsJobsHub>()

/** Fan one frame out to the subscribers that named its job id. */
function fanOutFrame(subscribers: ReadonlySet<FsJobsSubscriber>, frame: FsJobsFrame): void {
  const id = frameJobId(frame)
  for (const subscriber of [...subscribers]) {
    if (!subscriber.jobs.has(id)) continue
    // A throwing subscriber is CONTAINED, not allowed to starve the rest —
    // the same isolation turn-push.ts and git-push.ts fan out with.
    try {
      subscriber.onFrame(frame)
    } catch (error) {
      console.error('[dsh-better-sidebar] fs-jobs subscriber error:', error)
    }
  }
}

/** Fan one reconnect out to every subscriber (each re-pulls on its own). */
function fanOutReconnect(subscribers: ReadonlySet<FsJobsSubscriber>): void {
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.onReconnect()
    } catch (error) {
      console.error('[dsh-better-sidebar] fs-jobs reconnect error:', error)
    }
  }
}

/** The union of every subscriber's job ids, capped like the host caps watches. */
function unionJobs(subscribers: ReadonlySet<FsJobsSubscriber>): string[] {
  const ids = new Set<string>()
  for (const subscriber of subscribers) {
    for (const id of subscriber.jobs) {
      ids.add(id)
      if (ids.size >= MAX_JOBS) return [...ids]
    }
  }
  return [...ids]
}

/** Open (or return) one session's hub. */
function ensureHub(sessionId: string): FsJobsHub {
  const existing = hubs.get(sessionId)
  if (existing !== undefined) return existing
  const subscribers = new Set<FsJobsSubscriber>()
  // Reconnect bookkeeping: the FIRST open is not a reconnect (nothing was
  // missed — no frame ever arrived), only an open that follows a successful
  // connection's close is, because that gap swallowed frames.
  let connectedOnce = false
  let dropped = false
  const connection = openFsJobsPush(
    sessionId,
    () => unionJobs(subscribers),
    (frame: FsJobsFrame) => { fanOutFrame(subscribers, frame) },
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
  const hub: FsJobsHub = {
    subscribers,
    reconcile: () => { connection.reconcile() },
    close: () => {
      connection.close()
      // Never unpublish a NEWER hub a re-entrant join may have registered.
      if (hubs.get(sessionId) === hub) hubs.delete(sessionId)
    },
  }
  hubs.set(sessionId, hub)
  return hub
}

/** Join a subscriber with a non-empty set; the first join opens the socket. */
function joinHub(sessionId: string, subscriber: FsJobsSubscriber): void {
  const hub = ensureHub(sessionId)
  hub.subscribers.add(subscriber)
  hub.reconcile()
}

/** Leave a hub; the last leave tears the shared socket down. */
function leaveHub(sessionId: string, subscriber: FsJobsSubscriber): void {
  const hub = hubs.get(sessionId)
  if (hub === undefined) return
  hub.subscribers.delete(subscriber)
  if (hub.subscribers.size === 0) hub.close()
}

/** What a consumer hands the hook. */
export interface FsJobsWatchOptions {
  /**
   * The session scope (the archive fence; transfers ride the same socket).
   * No socket at all while undefined.
   */
  sessionId: string | undefined
  /**
   * Job ids to follow. An empty list unsubscribes (no socket at all when no
   * subscriber of the session remains) — pass `[]` while parked.
   */
  jobs: readonly string[]
  /** One watched job's status snapshot arrived (progress or terminal). */
  onFrame: (frame: FsJobsFrame) => void
  /**
   * The shared socket re-opened after at least one failed attempt — the
   * FIRST open never fires this. Every frame the outage swallowed is gone,
   * so the consumer re-pulls the job's status once instead of waiting for
   * the next push.
   */
  onReconnect?: () => void
}

/**
 * Follow the host's `fs-jobs` frames for the given job ids on the session's
 * ONE shared push socket.
 * @param options - the session, the watched job ids, and the frame/reconnect
 *   callbacks.
 */
export function useFsJobsWatch(options: FsJobsWatchOptions): void {
  const { sessionId, jobs } = options
  // The id list is a fresh array on every render, so neither the
  // subscription effect nor the membership effect may depend on its
  // identity. The CONTENT key (NUL-joined — no id can contain one) is what
  // everything derives from, exactly like git-push's worktree list.
  const setKey = jobs.join('\u0000')
  const wanted = useMemo(() => (setKey === '' ? [] : setKey.split('\u0000')), [setKey])
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const frameRef = useRef(options.onFrame)
  frameRef.current = options.onFrame
  const reconnectRef = useRef(options.onReconnect)
  reconnectRef.current = options.onReconnect
  /** The subscriber this hook owns, while it is joined. */
  const subscriberRef = useRef<FsJobsSubscriber | undefined>(undefined)
  /** Stable dependency: join/leave only when it gains or loses every id. */
  const subscribed = sessionId !== undefined && setKey !== ''

  useEffect(() => {
    if (!subscribed) return
    const hub = ensureHub(sessionId!)
    const subscriber: FsJobsSubscriber = {
      jobs: new Set(wantedRef.current),
      onFrame: (frame: FsJobsFrame) => { frameRef.current(frame) },
      onReconnect: () => { reconnectRef.current?.() },
    }
    subscriberRef.current = subscriber
    hub.subscribers.add(subscriber)
    hub.reconcile()
    return () => {
      subscriberRef.current = undefined
      hub.subscribers.delete(subscriber)
      if (hub.subscribers.size === 0 && hubs.get(sessionId!) === hub) hub.close()
    }
  }, [subscribed, sessionId])

  // A membership change on the SAME socket only swaps the set and re-sends
  // the watch frame (the terminal frame of a job shrinks the set; a newly
  // started one grows it — and the host answers every NEW id with its
  // current snapshot, so the gap self-heals).
  useEffect(() => {
    void setKey
    const subscriber = subscriberRef.current
    if (subscriber === undefined) return
    subscriber.jobs = new Set(wanted)
    hubs.get(sessionId ?? '')?.reconcile()
  }, [setKey, wanted, sessionId])
}

/** An imperative subscription (the transfer card's module-store lifecycle). */
export interface FsJobsWatchHandle {
  /** Replace the watched set (an empty set parks the subscription). */
  setJobs(jobs: readonly string[]): void
  /** Unsubscribe (idempotent). */
  close(): void
}

/**
 * Follow the host's `fs-jobs` frames without a React lifecycle — the
 * transfer card's module store lives outside any component.
 * @param sessionId - the session scope of the socket that carries the job.
 * @param jobs - the job ids to watch (empty: nothing is joined until
 *   {@linkcode FsJobsWatchHandle.setJobs} names one).
 * @param onFrame - one watched job's status snapshot arrived.
 * @param onReconnect - the shared socket re-opened after a drop; re-pull once.
 * @returns the subscription handle (close it when the job settles).
 */
export function subscribeFsJobsWatch(
  sessionId: string,
  jobs: readonly string[],
  onFrame: (frame: FsJobsFrame) => void,
  onReconnect?: () => void,
): FsJobsWatchHandle {
  const subscriber: FsJobsSubscriber = {
    jobs: new Set(jobs.slice(0, MAX_JOBS)),
    onFrame: (frame: FsJobsFrame) => { onFrame(frame) },
    onReconnect: () => { onReconnect?.() },
  }
  let joined = false
  /** Join lazily and leave on empty: an empty set must neither open nor
   *  hold the shared socket (the hook's `subscribed` flag, imperatively). */
  const sync = (): void => {
    if (joined) {
      if (subscriber.jobs.size === 0) {
        joined = false
        leaveHub(sessionId, subscriber)
        return
      }
      hubs.get(sessionId)?.reconcile()
      return
    }
    if (subscriber.jobs.size === 0) return
    joined = true
    joinHub(sessionId, subscriber)
  }
  sync()
  return {
    setJobs: (next: readonly string[]) => {
      subscriber.jobs = new Set(next.slice(0, MAX_JOBS))
      sync()
    },
    close: () => {
      if (!joined) return
      joined = false
      leaveHub(sessionId, subscriber)
    },
  }
}
