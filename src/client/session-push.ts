/**
 * Client end of the session push channel `/sidebar/ws/session`.
 *
 * The host turns session events into invalidation notices: a first
 * user/assistant message flips the blank phase (`kind: 'phase'`) and a
 * tool/call may move the active workspace root (`kind: 'cwd'`). Frames carry
 * only the session id — the answer still comes from the same HTTP routes as
 * before, so a dropped socket self-heals through them.
 *
 * One small connector shared by the session hooks (`session-phase.ts`,
 * `use-session-root.ts`), shaped after use-sidechat-push minus the
 * reconcile-on-change logic: each hook watches a single session that is fixed
 * for the connection's lifetime, so the full `watch` frame is simply
 * (re-)sent on every open — including after a reconnect — and failures back
 * off 1s → 15s.
 */
import { hostWebSocketUrl } from './host-route-url.ts'

/** One host frame: which watched session changed, and which fact went stale. */
export interface SessionPushFrame {
  kind: 'phase' | 'cwd'
  sessionId: string
  /** phase frames always carry `blank: false` — the only push-worthy flip. */
  blank?: unknown
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/**
 * Open the session push socket for one fixed watch set.
 * @param sessionIds - sessions to watch; announced on every (re)open.
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal (the phase hook pauses its poll
 *   while the socket is open and falls back to it when the socket drops).
 * @returns the disposer (idempotent per connection).
 */
export function connectSessionPush(
  sessionIds: readonly string[],
  onFrame: (frame: SessionPushFrame) => void,
  onState?: (open: boolean) => void,
): () => void {
  let socket: WebSocket | null = null
  let retry: number | undefined
  let closed = false
  let failures = 0

  /** Push the whole watch set (a full replacement, also after a reconnect). */
  const sendWatch = (): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'watch', sessionIds: [...sessionIds] }))
    }
  }

  const connect = (): void => {
    if (closed) return
    socket = new WebSocket(hostWebSocketUrl('sidebar/ws/session').toString())
    socket.onopen = () => {
      failures = 0
      onState?.(true)
      sendWatch()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let frame: SessionPushFrame
      try {
        frame = JSON.parse(event.data) as SessionPushFrame
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object') return
      // A malformed or foreign frame is a late/dirty notice, not an invalidation.
      if ((frame.kind !== 'phase' && frame.kind !== 'cwd') || typeof frame.sessionId !== 'string') return
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

  return () => {
    closed = true
    if (retry !== undefined) window.clearTimeout(retry)
    socket?.close()
  }
}
