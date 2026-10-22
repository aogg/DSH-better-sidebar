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
   * Serve one accepted socket: read its watch frames, answer each newly
   * watched id with a snapshot, push job frames until it closes.
   * @param ws - the accepted WebSocket.
   * @param sessionId - the socket's session scope (the archive fence);
   *   undefined still serves transfer frames.
   */
  attach(ws: WebSocket, sessionId: string | undefined): void
  /** Fan one transfer status out to the sockets watching its id. */
  pushTransfer(status: TransferStatusView): void
  /** Fan one archive settle out to its session's sockets watching its id. */
  pushArchive(event: ArchiveSettleEvent): void
  /** Close every socket (idempotent). */
  dispose(): void
}

/**
 * Register the fs-jobs push hub.
 * @param deps - the warning sink and the two registry reads.
 * @returns the hub; `attach` per accepted socket, `dispose` on unload.
 */
export function createFsJobsPushHub(deps: FsJobsPushDeps): FsJobsPushHub {
  const sockets = new Set<FsJobsSocket>()

  return {
    attach: (ws, sessionId) => {
      const socket = new FsJobsSocket(ws, sessionId, {
        deps,
        detach: () => { sockets.delete(socket) },
      })
      sockets.add(socket)
    },
    pushTransfer: (status) => {
      for (const socket of [...sockets]) {
        if (!socket.watches(status.transferId)) continue
        socket.send({ kind: 'transfer', ...status })
      }
    },
    pushArchive: (event) => {
      for (const socket of [...sockets]) {
        if (socket.sessionId !== event.sessionId || !socket.watches(event.id)) continue
        socket.send({
          kind: 'archive',
          id: event.id,
          state: event.state,
          bytes: event.bytes,
          ...(event.error !== undefined ? { error: event.error } : {}),
        })
      }
    },
    dispose: () => {
      for (const socket of [...sockets]) socket.close()
    },
  }
}

/** The per-socket seam the hub hands each {@link FsJobsSocket}. */
interface FsJobsSocketHub {
  deps: FsJobsPushDeps
  /** Remove the socket from the hub's push set (its close path). */
  detach(): void
}

/**
 * Serve one socket's watched job set until it closes.
 *
 * Watch frames replace the whole set synchronously — job ids are opaque
 * tokens (`ar-…` / `t-…`), so unlike the git hub there is no async path
 * resolution and no serialization chain: a later frame simply observes the
 * previous one's set.
 */
class FsJobsSocket {
  readonly sessionId: string | undefined
  private readonly ws: WebSocket
  private readonly hub: FsJobsSocketHub
  /** The job ids this socket currently follows. */
  private readonly jobs = new Set<string>()
  private closed = false

  constructor(ws: WebSocket, sessionId: string | undefined, hub: FsJobsSocketHub) {
    this.ws = ws
    this.sessionId = sessionId
    this.hub = hub
    ws.on('message', (data: unknown) => { this.onMessage(data) })
    ws.on('close', () => { this.close() })
    ws.on('error', () => { this.close() })
  }

  /** Whether this socket follows the given job id. */
  watches(id: string): boolean {
    return !this.closed && this.jobs.has(id)
  }

  /** Push one frame (silently dropped once the socket is gone). */
  send(frame: FsJobsPushFrame): void {
    if (this.closed) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      // A send on a dying socket is expected; the close handler cleans up.
    }
  }

  /** Apply one watch frame (an unparseable frame is ignored, never fatal). */
  private onMessage(data: unknown): void {
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
    const next = new Set(list.slice(0, MAX_JOBS))
    // The subscribe-time snapshot: every id NEW to this socket is answered
    // with its current status, so a settle that raced the subscription is
    // still delivered. A snapshot for an id the registry no longer knows
    // (expired, retired, foreign) pushes nothing — the client's one-shot
    // fetches own that error surface.
    for (const id of next) {
      if (this.jobs.has(id)) continue
      this.snapshot(id)
    }
    this.jobs.clear()
    for (const id of next) this.jobs.add(id)
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

  /** Stop serving: no further frames apply, the hub forgets the socket. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.jobs.clear()
    this.hub.detach()
  }
}
