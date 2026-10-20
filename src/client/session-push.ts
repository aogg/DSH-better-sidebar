/**
 * Client end of the session push channel `/sidebar/ws/session`.
 *
 * The host turns session events into frames: a first user/assistant message
 * flips the blank phase (`kind: 'phase'`, `blank: false` — the frame IS the
 * answer), a watch (re)subscription resolves the CURRENT phase and cwd and
 * pushes them (`blank: true` = still waiting; the cwd answer itself), and a
 * tool/call produces a cwd frame. A cwd frame carries the answer
 * (`cwd`/`root`/`parent`, resolved by the host through the very `session.cwd`
 * route) whenever it could resolve one; the bare `{kind:'cwd', sessionId}`
 * variant — an older host, or a failed host-side resolution — carries no
 * answer, and the session hooks simply ignore it: the next tool/call burst
 * re-resolves and re-pushes over the same socket.
 *
 * This socket is the session hooks' ONLY data channel — there is no HTTP
 * polling beside it. A dropped socket is answered with reconnects that back
 * off 1s → 15s (reset on the first success), never with HTTP asks.
 *
 * One small connector shared by the session hooks (`session-phase.ts`,
 * `use-session-root.ts`), shaped after use-sidechat-push minus the
 * reconcile-on-change logic: each hook watches a single session that is fixed
 * for the connection's lifetime, so the full `watch` frame is simply
 * (re-)sent on every open — including after a reconnect.
 */
import { hostWebSocketUrl } from './host-route-url.ts'

/** One host frame: which watched session changed, which fact — and maybe the answer. */
export interface SessionPushFrame {
  kind: 'phase' | 'cwd'
  sessionId: string
  /**
   * phase frames carry the answer: `blank: false` is the one-shot flip, and a
   * watch (re)subscription resolves the CURRENT phase first — `blank: true`
   * ("still waiting") or `blank: false` (settled, end of story). Absent on
   * legacy hosts, whose phase frames were always the flip.
   */
  blank?: unknown
  /**
   * cwd frames carry the answer when the host resolved one: the live root,
   * same value the `session.cwd` route returns. Absent (older host / failed
   * resolution) the frame is a bare invalidation — no answer to land.
   */
  cwd?: unknown
  root?: unknown
  parent?: unknown
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/**
 * Open the session push socket for one fixed watch set.
 * @param sessionIds - sessions to watch; announced on every (re)open.
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal (observability; the session
 *   hooks stay connected either way — a drop just means frames pause until
 *   the next successful reconnect).
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
