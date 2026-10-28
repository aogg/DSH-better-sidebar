/**
 * One shared file-tree background-job subscription per session (feed channel
 * `'fs-jobs'`).
 *
 * The two background jobs the phase-3 polling audit named — the file tree's
 * zip-and-download build (FileTree.tsx, `archive.status` every 250ms) and
 * the paste/move progress card (transfer-client.ts,
 * `fs.transferStatus` every 400ms) — used to advance on timer-driven HTTP
 * polls. They both follow the SAME fact, "one job id's status moved", so
 * they both subscribe to the SAME signal instead: the host's `fs-jobs`
 * frame carrying that job's status snapshot — progress and terminal states
 * alike, so nothing degrades compared to the polls it replaces. A one-shot
 * fetch on notice is NOT polling: no timer drives it.
 *
 * ONE SUBSCRIPTION SET PER SESSION (archive frames are fenced to the
 * session), on the ONE multiplexed feed socket (feed-hub.ts): each hub's
 * `args` is the UNION of its subscribers' job ids — one archive build and
 * one transfer card, at most — re-pointed through
 * {@linkcode FeedSubscription.setArgs} whenever a subscriber joins, leaves
 * or changes its set (a delta on the wire, no reconnect). The FIRST
 * subscriber announces the session's key, every frame of a watched id fans
 * out to the subscribers that named it, and the LAST unsubscriber retires
 * the key.
 *
 * Availability is the socket's own story: reconnects back off 1s → 15s
 * (±30% jitter) and never give up, there is NO timer-driven HTTP fallback,
 * the re-open replays every `sub` (the host answers each watched id with
 * its current snapshot), and a recovery — a re-open after a drop, or a
 * session-dimension restore — fires every subscriber's `onReconnect` so
 * each re-pulls once: the frames the window swallowed are gone, and the
 * subscribe-time snapshot alone must not be the only catch-up.
 *
 * Two entry points share each hub: the {@linkcode useFsJobsWatch} hook for
 * React consumers (the file tree's archive strip) and
 * {@linkcode subscribeFsJobsWatch} for the transfer card, whose lifecycle is
 * imperative (a module store, not a component).
 * @module dsh-better-sidebar/fs-jobs-push
 */
import { useEffect, useMemo, useRef } from 'react'
import { feedSubscribe, type FeedSubscription } from './feed-hub.ts'

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

/** The job id one frame is about, whichever registry holds it. */
function frameJobId(frame: FsJobsFrame): string {
  return frame.kind === 'archive' ? frame.id : frame.transferId
}

/** A live fs-jobs push connection: re-point the watch set, or close it. */
export interface FsJobsPushConnection {
  /** Re-read the job union and re-point the session's feed subscription. */
  reconcile(): void
  /** Close the connection (retire the key with its last subscriber; idempotent). */
  close(): void
}

/**
 * Open the fs-jobs subscription of one session on the shared feed for a
 * mutable watch set.
 * @param sessionId - the session scope (the archive fence).
 * @param jobs - job ids to watch, re-read on every
 *   {@linkcode FsJobsPushConnection.reconcile} (the hub feeds it the union
 *   of its subscribers' sets).
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal of the shared feed socket
 *   (observability).
 * @param onReconnect - the socket re-opened after a drop, OR the session's
 *   key came back from a release; fires once per recovery.
 * @returns the live connection (close it to tear down; idempotent).
 */
export function openFsJobsPush(
  sessionId: string,
  jobs: () => readonly string[],
  onFrame: (frame: FsJobsFrame) => void,
  onState?: (open: boolean) => void,
  onReconnect?: () => void,
): FsJobsPushConnection {
  let sub: FeedSubscription | undefined
  const onData = (data: unknown): void => {
    if (data === null || typeof data !== 'object' || typeof (data as FsJobsFrame).kind !== 'string') return
    const frame = data as FsJobsFrame
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
  /** Join (or re-point) the session's key with the current union. */
  const sync = (): void => {
    const args = { jobs: [...jobs()].slice(0, MAX_JOBS) }
    if (sub === undefined) {
      sub = feedSubscribe({ channel: 'fs-jobs', sessionId, args, onData, onState, onReconnect })
      return
    }
    sub.setArgs(args)
  }
  sync()

  return {
    reconcile: sync,
    close: () => {
      sub?.close()
      sub = undefined
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

/** One session's hub: one feed key alive while at least one subscriber holds it. */
interface FsJobsHub {
  subscribers: Set<FsJobsSubscriber>
  /** Re-announce the union watch set (membership changed mid-connection). */
  reconcile(): void
  close(): void
}

/** One hub per session (archive frames are fenced to the session). */
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
  // Recovery is the DIRECT onReconnect line below: the hub fires it on a
  // re-open after a drop AND on a session-dimension restore — one fan-out
  // per recovery, never two. The open/close signal stays observability
  // only (nothing is bookkept off it).
  const connection = openFsJobsPush(
    sessionId,
    () => unionJobs(subscribers),
    (frame: FsJobsFrame) => { fanOutFrame(subscribers, frame) },
    undefined,
    // A re-open after a drop, or a session-dimension restore: the window
    // swallowed frames exactly like an outage did — every consumer re-pulls.
    () => { fanOutReconnect(subscribers) },
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

/** Join a subscriber with a non-empty set; the first join announces the key. */
function joinHub(sessionId: string, subscriber: FsJobsSubscriber): void {
  const hub = ensureHub(sessionId)
  hub.subscribers.add(subscriber)
  hub.reconcile()
}

/** Leave a hub; the last leave retires the shared key. */
function leaveHub(sessionId: string, subscriber: FsJobsSubscriber): void {
  const hub = hubs.get(sessionId)
  if (hub === undefined) return
  hub.subscribers.delete(subscriber)
  if (hub.subscribers.size === 0) hub.close()
}

/** What a consumer hands the hook. */
export interface FsJobsWatchOptions {
  /**
   * The session scope (the archive fence; transfers ride the same key).
   * No subscription at all while undefined.
   */
  sessionId: string | undefined
  /**
   * Job ids to follow. An empty list unsubscribes (no key at all when no
   * subscriber of the session remains) — pass `[]` while parked.
   */
  jobs: readonly string[]
  /** One watched job's status snapshot arrived (progress or terminal). */
  onFrame: (frame: FsJobsFrame) => void
  /**
   * The shared socket re-opened after at least one failed attempt — the
   * FIRST open never fires this. Every frame the outage swallowed is gone,
   * so the consumer re-pulls the job's status once instead of waiting for
   * the next push. A session-dimension restore fires it too.
   */
  onReconnect?: () => void
}

/**
 * Follow the host's `fs-jobs` frames for the given job ids on the session's
 * ONE shared feed key.
 * @param options - the session, the watched job ids, and the frame/reconnect
 *   callbacks.
 */
export function useFsJobsWatch(options: FsJobsWatchOptions): void {
  const { sessionId, jobs } = options
  // The id list is a fresh array on every render, so neither the subscription
  // effect nor the membership effect may depend on its identity. The CONTENT
  // key (NUL-joined — no id can contain one) is what everything derives from,
  // exactly like git-push's worktree list.
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

  // A membership change on the SAME key only swaps the set and re-points the
  // feed subscription (the terminal frame of a job shrinks the set; a newly
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
 * @param sessionId - the session scope of the feed key that carries the job.
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
   * hold the shared key (the hook's `subscribed` flag, imperatively). */
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
