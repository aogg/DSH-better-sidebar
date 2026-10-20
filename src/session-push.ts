/**
 * Session-level push behind `/sidebar/ws/session`.
 *
 * The sidebar client learns two session-level facts by HTTP polling today:
 * whether the session is still blank (`session.phase`, 1s while blank) and
 * which workspace root the session is working in (`session.cwd`, 5s). The
 * host already knows the moment either changes: the session append feed
 * (`session/event`) carries every durable row, and a `user/message` /
 * `assistant/message` row is exactly the blank flip, while a `tool/call` row
 * is exactly the "the agent ran somewhere" signal the active-worktree scan
 * derives its answer from.
 *
 * This hub turns those events into per-session frames. The `phase` frame
 * stays a one-shot invalidation (`{kind:'phase', sessionId, blank:false}`):
 * "non-blank" is the answer, so the frame itself is all the client needs.
 * The cwd frame now carries the ANSWER: the hub resolves it through the
 * injected `resolveCwd` — wired to the very implementation the `session.cwd`
 * route serves, invoked with `fresh: true` so the 3s TTL cache is skipped —
 * and pushes `{kind:'cwd', sessionId, cwd, root, parent}`, both on a watch
 * (re)subscription (a reconnecting client re-subscribes on a fresh socket and
 * hears the current answer immediately) and at the end of the 250ms
 * tool/call coalescing window. A failed resolution, or a hub mounted without
 * a resolver, degrades to the legacy bare `{kind:'cwd', sessionId}`
 * invalidation, which the client answers with its own fresh re-ask — so the
 * HTTP route stays the same source of truth and a dropped socket still
 * self-heals through the same polls, now demoted to the offline fallback.
 *
 * Two frame kinds, two schedules: the blank flip is one-shot, so each socket
 * pushes at most one `phase` frame per session, ever (a burst of message
 * events must not spam the client's entry flip). A `tool/call` only means the
 * worktree scan MIGHT reach a different root, so it rides a 250ms coalescing
 * window (first trigger's window wins) and the frame's answer is resolved
 * with `fresh: true`, skipping the TTL cache the ordinary polls rely on.
 * @module dsh-better-sidebar/session-push
 */
import type { WebSocket } from 'ws'
import type { Context } from './context-types.ts'

/** Coalescing window for `tool/call` (cwd) notices. */
const CWD_DEBOUNCE_MS = 250
/** Session ids one socket may watch (a resource guard, not a policy). */
const MAX_WATCHED = 64

/** The frames the host pushes: which watched session, which fact — and, for cwd, the answer. */
export type SessionPushFrame =
  | { kind: 'phase'; sessionId: string; blank: false }
  /** Bare invalidation: no resolver, or the resolution failed — the client re-asks `session.cwd`. */
  | { kind: 'cwd'; sessionId: string }
  /** The answer itself, exactly what the `session.cwd` route would have returned. */
  | { kind: 'cwd'; sessionId: string; cwd: string; root: string; parent: string | null }

/** One resolved cwd answer, shaped like the `session.cwd` route's return value. */
export interface SessionCwdAnswer {
  sessionId: string
  cwd: string
  root: string
  parent: string | null
}

/** Hub options: where a cwd frame's answer comes from. */
export interface SessionPushHubOptions {
  /**
   * Resolve one session's live answer. Implementations should be the SAME
   * source as the `session.cwd` route (in index.ts the resolver literally
   * calls that route with `fresh: true`); a rejection degrades the frame to
   * the bare invalidation variant.
   */
  resolveCwd(sessionId: string): Promise<SessionCwdAnswer>
}

/** The frame the client sends to replace its watch set. */
interface WatchFrame {
  op?: unknown
  sessionIds?: unknown
}

/** The host-side push hub: one event feed, any number of sockets. */
export interface SessionPushHub {
  /** Attach one accepted socket (reads its watch frames, pushes notices). */
  attach(ws: WebSocket): void
  /** Release the event feed (socket teardown stays with the server). */
  dispose(): void
}

/**
 * Register the session push feed.
 * @param ctx - host plugin context (its `on` subscribes the append feed).
 * @param options - cwd answer source; omitted, the cwd frames stay bare
 *   invalidations (the pre-answer-wire format).
 * @returns the hub plus a disposer unbinding the listener.
 */
export function createSessionPushHub(ctx: Context, options?: SessionPushHubOptions): SessionPushHub {
  const sockets = new Set<SessionSocket>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API still accept sockets, which then
    // simply never hear anything.
    return { attach: () => {}, dispose: () => {} }
  }
  const offEvent = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    // Same verdict as the `session.phase` route: the first user/assistant
    // message is the flip out of blank.
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      for (const socket of sockets) socket.notifyPhase(sessionId)
      return
    }
    // A tool call only HINTS that the active root may have moved; the 250ms
    // window bounds the frequency, and the window's frame resolves the answer
    // itself (fresh), so the client never has to re-ask over HTTP.
    if (event.type === 'tool/call') {
      for (const socket of sockets) socket.notifyCwd(sessionId)
    }
  })
  return {
    attach: (ws) => {
      const socket = new SessionSocket(ws, () => { sockets.delete(socket) }, options?.resolveCwd)
      sockets.add(socket)
    },
    dispose: () => {
      offEvent()
      for (const socket of sockets) socket.close()
      sockets.clear()
    },
  }
}

/** One attached socket's watch set, phase one-shots and cwd coalescing timers. */
class SessionSocket {
  private readonly socket: WebSocket
  private readonly onClosed: () => void
  private readonly resolveCwd: ((sessionId: string) => Promise<SessionCwdAnswer>) | undefined
  private readonly watched = new Set<string>()
  /** Sessions this socket already heard the blank flip for (one frame, ever). */
  private readonly phased = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  /**
   * @param socket - the accepted WebSocket.
   * @param onClosed - hub-side cleanup (idempotent).
   * @param resolveCwd - cwd answer source; omitted, cwd frames stay bare.
   */
  constructor(
    socket: WebSocket,
    onClosed: () => void,
    resolveCwd?: (sessionId: string) => Promise<SessionCwdAnswer>,
  ) {
    this.socket = socket
    this.onClosed = onClosed
    this.resolveCwd = resolveCwd
    socket.on('message', (data: unknown) => { this.onMessage(data) })
    socket.on('close', () => { this.close() })
    socket.on('error', () => { this.close() })
  }

  /** Apply one client frame (an unparseable frame is ignored, never fatal). */
  private onMessage(data: unknown): void {
    let frame: WatchFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as WatchFrame
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object' || frame.op !== 'watch') return
    const ids = Array.isArray(frame.sessionIds)
      ? frame.sessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    const previous = new Set(this.watched)
    this.watched.clear()
    for (const id of ids.slice(0, MAX_WATCHED)) this.watched.add(id)
    // Unwatched sessions drop their pending notice, timer and phase one-shot
    // with them. A later re-watch may notify again — a client re-subscribing
    // is exactly the case that must hear the flip once more.
    for (const id of [...this.phased]) {
      if (!this.watched.has(id)) this.phased.delete(id)
    }
    for (const [id, timer] of this.timers) {
      if (this.watched.has(id)) continue
      clearTimeout(timer)
      this.timers.delete(id)
    }
    // A NEWLY watched session hears its CURRENT answer right away: a client
    // re-subscribing (every reconnect re-sends the whole watch set on a fresh
    // socket) is exactly the case that must not wait for the next tool call.
    // A repeated identical watch frame adds nothing, so it pushes nothing.
    for (const id of this.watched) {
      if (!previous.has(id)) this.pushCwdAnswer(id)
    }
  }

  /**
   * The session just left blank (first user/assistant message). ONE frame per
   * session per socket, ever: the flip is one-shot, and the client stops
   * watching the phase the moment it hears it.
   * @param sessionId - the session that flipped.
   */
  notifyPhase(sessionId: string): void {
    if (this.closed || !this.watched.has(sessionId) || this.phased.has(sessionId)) return
    this.phased.add(sessionId)
    this.send({ kind: 'phase', sessionId, blank: false })
  }

  /**
   * Coalesce one cwd notice for a session. The FIRST trigger's window wins, so
   * a burst of tool calls never postpones the notice it already scheduled.
   * @param sessionId - the session whose active root may have moved.
   */
  notifyCwd(sessionId: string): void {
    if (this.closed || !this.watched.has(sessionId) || this.timers.has(sessionId)) return
    this.timers.set(sessionId, setTimeout(() => {
      this.timers.delete(sessionId)
      // Without a resolver the frame stays the bare invalidation the client
      // answers with its own fresh re-ask (the pre-answer-wire format).
      if (this.resolveCwd === undefined) {
        this.send({ kind: 'cwd', sessionId })
        return
      }
      this.pushCwdAnswer(sessionId)
    }, CWD_DEBOUNCE_MS))
  }

  /**
   * Resolve the session's live answer and push it INSIDE the cwd frame. The
   * resolution is async, so the answer re-checks `closed`/`watched` before
   * sending: a socket that died, or a session the client watched away while
   * the answer was in flight, must not hear a late frame. A rejected
   * resolution (or a malformed one) degrades to the bare invalidation frame —
   * the client answers THAT with a fresh `session.cwd` re-ask, i.e. the very
   * route the resolver wraps, so the failure still self-heals end to end.
   * This is the designed fallback path, not a silently swallowed error.
   */
  private pushCwdAnswer(sessionId: string): void {
    const resolve = this.resolveCwd
    if (resolve === undefined || this.closed || !this.watched.has(sessionId)) return
    void resolve(sessionId)
      .then(answer => {
        if (this.closed || !this.watched.has(sessionId)) return
        const cwd = (answer as { cwd?: unknown } | null | undefined)?.cwd
        if (typeof answer !== 'object' || answer === null || typeof cwd !== 'string' || cwd === '') {
          this.send({ kind: 'cwd', sessionId })
          return
        }
        const record = answer as SessionCwdAnswer
        this.send({
          kind: 'cwd',
          sessionId,
          cwd: record.cwd,
          root: typeof record.root === 'string' ? record.root : '',
          parent: typeof record.parent === 'string' ? record.parent : null,
        })
      })
      .catch(() => {
        if (!this.closed && this.watched.has(sessionId)) this.send({ kind: 'cwd', sessionId })
      })
  }

  /** Push one notice (silently dropped once the socket is gone). */
  private send(frame: SessionPushFrame): void {
    if (this.closed) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      // A send on a dying socket is expected; the close handler cleans up.
    }
  }

  /** Release every timer and de-register (idempotent). */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.watched.clear()
    this.phased.clear()
    this.onClosed()
  }
}
