/**
 * File-tree background-job progress push behind `/sidebar/ws/fs-jobs`.
 *
 * The file tree's two background jobs — the zip-and-download build
 * (`archive.build` → `archive.status`) and the paste/move transfer
 * (`fs.transfer` → `fs.transferStatus`) — used to advance on client-side
 * poll timers (250 ms / 400 ms). This hub replaces both with the
 * session-push model: the CLIENT names the job ids it follows, and the HOST
 * pushes a frame per meaningful change — an archive's settle (a child
 * process reports nothing per entry, so `building` has no intermediate
 * state to push) and a transfer's coalesced progress plus its terminal
 * state (the coalescing window lives in fs-transfer.ts, the 规范's allowed
 * debounce — no server timer here at all).
 *
 * Frames are `{ op: 'watch', jobs: [...] }`, a FULL replacement (the
 * git-push model): a reconnect re-sends the whole set and a membership
 * change reconciles in place, one code path for both. Every newly watched
 * id is answered with its CURRENT status snapshot — a settle that lands
 * between the job's start and the subscription frame would otherwise be
 * lost to the void, and the one-shot fetches the client still runs (on job
 * start and after a reconnect) must not be the only guard against that
 * race. The snapshot is pushed on the SUBSCRIBE event, never on a timer.
 *
 * Scoping mirrors the registries the frames read: archive tasks are
 * session-fenced exactly like `archive.status` (a socket only hears the
 * settles of the session named in its `?sessionId=`), while transfers are
 * capability-scoped by their uuid id (the `fs.transferStatus` route itself
 * asks for no session) and reach any socket that names the id.
 *
 * No polling exists on either side of this socket: the host never runs a
 * status read on a timer, and the client answers a drop with the
 * connector's exponential-backoff reconnect plus ONE catch-up fetch.
 * @module dsh-better-sidebar/fs-jobs-push
 */
import type { WebSocket } from 'ws'
import type { ArchiveSettleEvent, ArchiveStatus } from './archive-route.ts'
import type { TransferStatusView } from './fs-transfer.ts'

/** The frames the host pushes: one followed job's status snapshot. */
export type FsJobsPushFrame =
  /**
   * An archive build's state. `building` only ever rides the
   * subscribe-time snapshot; a pushed change is always a settle.
   */
  | { kind: 'archive'; id: string; state: ArchiveStatus['state']; bytes: number; error?: string }
  /** A transfer's progress / terminal snapshot (the wire status verbatim). */
  | ({ kind: 'transfer' } & TransferStatusView)

/** The frame a client sends to replace its watched job set. */
interface WatchFrame {
  op?: unknown
  jobs?: unknown
}

/** Jobs one socket may watch (a resource guard, not a policy). */
const MAX_JOBS = 64

/** Warning sink: the hub never crashes a socket over one bad id. */
export type FsJobsWarn = (message: string, error?: unknown) => void

/** The registries the hub reads for a subscribe-time snapshot. */
export interface FsJobsPushDeps {
  warn: FsJobsWarn
  /** One transfer's current status, or undefined when the id is retired. */
  readTransfer(id: string): TransferStatusView | undefined
  /**
   * One archive's current status for THIS session, or undefined when the
   * id is unknown, expired, or another session's (the same fence
   * `archive.status` applies).
   */
  readArchive(id: string, sessionId: string): ArchiveStatus | undefined
}

/** The host-side push hub: shared sockets, no watchers of its own. */
export interface FsJobsPushHub {
  /**
   * Open one subscription: its watched job set is held until it closes,
   * its frames ride its own sink. The feed multiplexer opens one per
   * (channel, key); the legacy endpoint one per socket.
   * @param options - the session scope (the archive fence) and the frame
   *   sink; an undefined sessionId still serves transfer frames.
   */
  subscribe(options: FsJobsSubscribeOptions): FsJobsSubscription
  /**
   * Serve one accepted socket: read its watch frames, answer each newly
   * watched id with a snapshot, push job frames until it closes. A thin
   * shell over {@link subscribe} — the ws wiring around one subscription.
   * @param ws - the accepted WebSocket.
   * @param sessionId - the socket's session scope (the archive fence);
   *   undefined still serves transfer frames.
   */
  attach(ws: WebSocket, sessionId: string | undefined): void
  /** Fan one transfer status out to the subscriptions watching its id. */
  pushTransfer(status: TransferStatusView): void
  /** Fan one archive settle out to its session's subscriptions watching its id. */
  pushArchive(event: ArchiveSettleEvent): void
  /** Close every socket (idempotent). */
  dispose(): void
}

/** What one subscription contributes: its session scope and frame sink. */
export interface FsJobsSubscribeOptions {
  /** The archive fence's session scope; `undefined` still serves transfers. */
  sessionId?: string
  /** Receives this subscription's frames (never called after `close`). */
  onFrame: (frame: FsJobsPushFrame) => void
}

/** One subscription (a legacy endpoint socket, or one feed sub) of the hub. */
export interface FsJobsSubscription {
  /**
   * Full replacement of the watched job set: every id NEW to the
   * subscription is answered with its current snapshot.
   */
  setJobs(jobs: readonly string[]): void
  /** Release the subscription; no further frames. */
  close(): void
}

/**
 * Register the fs-jobs push hub.
 * @param deps - the warning sink and the two registry reads.
 * @returns the hub; `attach` per accepted socket, `dispose` on unload.
 */
export function createFsJobsPushHub(deps: FsJobsPushDeps): FsJobsPushHub {
  const subscriptions = new Set<FsJobsSubscriptionImpl>()

  const openSubscription = (options: FsJobsSubscribeOptions): FsJobsSubscriptionImpl => {
    const subscription = new FsJobsSubscriptionImpl(options, {
      deps,
      detach: () => { subscriptions.delete(subscription) },
    })
    subscriptions.add(subscription)
    return subscription
  }

  return {
    subscribe: (options) => openSubscription(options),
    attach: (ws, sessionId) => {
      // The endpoint shell: one subscription, its frames on the socket, its
      // lifetime the socket's — the feed opens the same shape per sub key.
      const subscription = openSubscription({
        sessionId,
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
    pushTransfer: (status) => {
      for (const subscription of [...subscriptions]) {
        if (!subscription.watches(status.transferId)) continue
        subscription.send({ kind: 'transfer', ...status })
      }
    },
    pushArchive: (event) => {
      for (const subscription of [...subscriptions]) {
        if (subscription.sessionId !== event.sessionId || !subscription.watches(event.id)) continue
        subscription.send({
          kind: 'archive',
          id: event.id,
          state: event.state,
          bytes: event.bytes,
          ...(event.error !== undefined ? { error: event.error } : {}),
        })
      }
    },
    dispose: () => {
      for (const subscription of [...subscriptions]) subscription.close()
    },
  }
}

/** The per-subscription seam the hub hands each {@link FsJobsSubscriptionImpl}. */
interface FsJobsSocketHub {
  deps: FsJobsPushDeps
  /** Remove the subscription from the hub's push set (its close path). */
  detach(): void
}

/**
 * Serve one subscription's watched job set until it closes.
 *
 * Job sets replace the whole set synchronously — job ids are opaque
 * tokens (`ar-…` / `t-…`), so unlike the git hub there is no async path
 * resolution and no serialization chain: a later set simply observes the
 * previous one's set. The transport lives outside (the legacy endpoint
 * wires a WebSocket, the feed multiplexer an envelope sink).
 */
class FsJobsSubscriptionImpl {
  readonly sessionId: string | undefined
  private readonly onFrame: (frame: FsJobsPushFrame) => void
  private readonly hub: FsJobsSocketHub
  /** The job ids this subscription currently follows. */
  private readonly jobs = new Set<string>()
  private closed = false

  constructor(options: FsJobsSubscribeOptions, hub: FsJobsSocketHub) {
    this.sessionId = options.sessionId
    this.onFrame = options.onFrame
    this.hub = hub
  }

  /** Whether this subscription follows the given job id. */
  watches(id: string): boolean {
    return !this.closed && this.jobs.has(id)
  }

  /** Push one frame (silently dropped once the subscription is gone). */
  send(frame: FsJobsPushFrame): void {
    if (this.closed) return
    this.onFrame(frame)
  }

  /** Apply one inbound frame (an unparseable frame is ignored, never fatal). */
  onMessage(data: unknown): void {
    if (this.closed) return
    let frame: WatchFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as WatchFrame
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object' || frame.op !== 'watch') return
    const list = Array.isArray(frame.jobs)
      ? frame.jobs.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    this.setJobs(list)
  }

  /**
   * Full replacement of the watched set. The subscribe-time snapshot: every
   * id NEW to this subscription is answered with its current status, so a
   * settle that raced the subscription is still delivered. A snapshot for an
   * id the registry no longer knows (expired, retired, foreign) pushes
   * nothing — the client's one-shot fetches own that error surface.
   */
  setJobs(next: readonly string[]): void {
    const ids = new Set(next.slice(0, MAX_JOBS))
    for (const id of ids) {
      if (this.jobs.has(id)) continue
      this.snapshot(id)
    }
    this.jobs.clear()
    for (const id of ids) this.jobs.add(id)
  }

  /** Push one id's current status, whichever registry holds it. */
  private snapshot(id: string): void {
    const transfer = this.hub.deps.readTransfer(id)
    if (transfer !== undefined) {
      this.send({ kind: 'transfer', ...transfer })
      return
    }
    if (this.sessionId !== undefined) {
      const archive = this.hub.deps.readArchive(id, this.sessionId)
      if (archive !== undefined) {
        this.send({
          kind: 'archive',
          id,
          state: archive.state,
          bytes: archive.bytes,
          ...(archive.error !== undefined ? { error: archive.error } : {}),
        })
      }
    }
  }

  /** Stop serving: no further frames apply, the hub forgets the subscription. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.jobs.clear()
    this.hub.detach()
  }
}
