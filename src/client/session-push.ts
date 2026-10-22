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
 * re-resolves and re-pushes over the same socket. A third frame,
 * `{kind:'history', sessionId, records}` (v0.28.0+), rides the same channel:
 * it tells the prompt-history tab that fresh user-prompt records of a watched
 * session were just indexed. A fourth, `{kind:'history-seed', cwd, seeding}`
 * (v0.28.15+), tells it that a project's seed scan started/finished — the
 * tab's seeding strip and its one-shot "refetch the first page when indexing
 * completes" are driven by this frame instead of polling `history.list`.
 * A fifth, `{kind:'turn', sessionId}`, says one durable `assistant/message`
 * row settled for the session (400ms coalesced) — the turn's last row IS the
 * reply's completion, and open editor tabs ride it to re-read a file the
 * reply may have rewritten (see turn-push.ts). No answer rides it: the
 * refresh IS the reaction, fetched through the editor's own load path.
 * A sixth, `{kind:'ops', sessionId, seq}` (v0.28.19+), is pure invalidation
 * for the session's ops-delta consumers — the changes tab's session lens,
 * the editor's file-op stream, the Tasks page's live/telemetry pulls. It
 * says "re-pull your delta once" (a one-shot fetch, not a poll); `seq` is a
 * diagnostic payload, never a client cursor. Older clients drop the kind in
 * their existing unknown-kind filter (no crash, no shape change); an older
 * host simply never sends it and the newer client keeps working (it just
 * never hears the invalidation).
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
  /**
   * `turn` frames (newer hosts only) name a settled reply step; `ops` frames
   * (newer hosts only) name a stale ops delta. An older host never sends
   * either and an older client drops them in its unknown-kind filter — the
   * union grows, neither side breaks.
   */
  kind: 'phase' | 'cwd' | 'history' | 'history-seed' | 'turn' | 'ops'
  /**
   * The session the frame is about. Every kind carries one EXCEPT
   * `history-seed` (project-scoped, no session on the wire).
   */
  sessionId?: string
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
   * `history-seed` frames carry the PROJECT root instead (identical to
   * `history.list`'s `project.cwd` — the client string-compares it to claim
   * the frame).
   */
  cwd?: unknown
  root?: unknown
  parent?: unknown
  /**
   * history frames carry freshly indexed user-prompt records of THAT session
   * (the same {@linkcode HistorySendRecord} shape the `history.list` route
   * answers with): the prompt-history tab merges them into its list. The
   * connector validates SHAPE only — whether the session is one the tab
   * watches stays the caller's filter.
   */
  records?: unknown
  /**
   * `history-seed` frames carry the scan state: `true` = the project's seed
   * scan started, `false` = it finished. Absent on every other frame kind.
   */
  seeding?: unknown
  /**
   * `ops` frames carry the watched session's newest per-log seq inside the
   * coalescing window — a DIAGNOSTIC payload, never a client cursor (subtree
   * `changes.ops` answers renumber seqs when merging). Absent on every other
   * frame kind.
   */
  seq?: unknown
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/** A live session push connection: close it, or re-announce its watch set. */
export interface SessionPushConnection {
  /**
   * Re-send the whole watch frame (a full replacement). For a getter-based
   * connection whose ids change mid-flight — the shared ops hub's union of
   * subscriber trees — this is how a membership change reaches the host
   * without a reconnect.
   */
  reconcile(): void
  /** Close the connection and stop its retries (idempotent). */
  close(): void
}

/**
 * Open the session push socket for a fixed OR mutable watch set.
 * @param sessionIds - sessions to watch; an array is frozen for the
 *   connection's lifetime (the hooks' contract), a getter is re-read on every
 *   open AND every {@linkcode SessionPushConnection.reconcile} — the shared
 *   ops hub (ops-push.ts) feeds it the union of its subscribers' sessions.
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal (observability; the session
 *   hooks stay connected either way — a drop just means frames pause until
 *   the next successful reconnect).
 * @returns the live connection (close it to tear down; both calls idempotent).
 */
export function openSessionPush(
  sessionIds: readonly string[] | (() => readonly string[]),
  onFrame: (frame: SessionPushFrame) => void,
  onState?: (open: boolean) => void,
): SessionPushConnection {
  const currentIds = (): readonly string[] => (typeof sessionIds === 'function' ? sessionIds() : sessionIds)
  let socket: WebSocket | null = null
  let retry: number | undefined
  let closed = false
  let failures = 0

  /** Push the whole watch set (a full replacement, also after a reconnect). */
  const sendWatch = (): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op: 'watch', sessionIds: [...currentIds()] }))
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
      if (frame.kind !== 'phase' && frame.kind !== 'cwd' && frame.kind !== 'history' && frame.kind !== 'history-seed' && frame.kind !== 'turn' && frame.kind !== 'ops') return
      // history-seed is project-scoped: no sessionId on the wire — its claim
      // token is the project root, so a cwd-less seed frame is malformed.
      if (frame.kind === 'history-seed') {
        if (typeof frame.cwd !== 'string' || frame.cwd === '') return
      } else if (typeof frame.sessionId !== 'string') return
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
  return openSessionPush(sessionIds, onFrame, onState).close
}
