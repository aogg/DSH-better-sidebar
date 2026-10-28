/**
 * Client end of the session push channel, riding the multiplexed feed socket
 * (`/sidebar/ws/feed`, channel `'session'` — see feed-hub.ts).
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
 * The feed socket is the session hooks' ONLY data channel — there is no HTTP
 * polling beside it. A dropped socket is answered with reconnects (the hub's
 * 1s → 15s jittered backoff, reset on the first success) that REPLAY every
 * watch — never with HTTP asks.
 *
 * ONE SHARED SOCKET, not one per caller: every `openSessionPush` call
 * subscribes its session ids on the multiplexed feed (one reference-counted
 * `'session'` subscription per id), so the native sidebar's keep-mounted tab
 * bodies and every hook share ONE connection no matter how many tabs are
 * open. Each call still hears only what its watch set names — the hub routes
 * by sessionId and the frame filter below keeps the protocol's own guards.
 */
import { feedSubscribe, type FeedSubscription } from './feed-hub.ts'

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

/**
 * Validate one unwrapped feed payload into a {@linkcode SessionPushFrame}.
 * A malformed or foreign frame is a late/dirty notice, not an invalidation.
 */
function parseFrame(data: unknown): SessionPushFrame | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const frame = data as SessionPushFrame
  if (frame.kind !== 'phase' && frame.kind !== 'cwd' && frame.kind !== 'history' && frame.kind !== 'history-seed' && frame.kind !== 'turn' && frame.kind !== 'ops') return undefined
  // history-seed is project-scoped: no sessionId on the wire — its claim
  // token is the project root, so a cwd-less seed frame is malformed.
  if (frame.kind === 'history-seed') {
    if (typeof frame.cwd !== 'string' || frame.cwd === '') return undefined
  } else if (typeof frame.sessionId !== 'string') return undefined
  return frame
}

/** A live session push subscription: re-sync its watch set, or dispose it. */
export interface SessionPushConnection {
  /**
   * Re-read the watch set and apply the delta to the shared feed (a session
   * a getter-based connection gained joins, one it lost leaves). For the
   * fixed-array callers this is a no-op — the set never changes mid-flight.
   */
  reconcile(): void
  /** Close the connection (unsubscribe every id it still holds; idempotent). */
  close(): void
}

/**
 * Subscribe to the session channel of the shared feed for a fixed OR mutable
 * watch set.
 * @param sessionIds - sessions to watch; an array is frozen for the
 *   subscription's lifetime (the hooks' contract), a getter is re-read on
 *   every {@linkcode SessionPushConnection.reconcile} — the shared ops hub
 *   (ops-push.ts) feeds it the union of its subscribers' sessions.
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal of the shared feed socket
 *   (observability; the session hooks stay connected either way — a drop
 *   just means frames pause until the next successful reconnect, whose
 *   replay re-seeds the watch answers).
 * @returns the live connection (close it to tear down; both calls idempotent).
 */
export function openSessionPush(
  sessionIds: readonly string[] | (() => readonly string[]),
  onFrame: (frame: SessionPushFrame) => void,
  onState?: (open: boolean) => void,
): SessionPushConnection {
  const currentIds = (): readonly string[] => (typeof sessionIds === 'function' ? sessionIds() : sessionIds)
  /** One reference-counted feed subscription per watched id. */
  const subs = new Map<string, FeedSubscription>()
  /** Land one validated feed payload on the caller. */
  const onData = (data: unknown): void => {
    const frame = parseFrame(data)
    if (frame === undefined) return
    onFrame(frame)
  }
  /** Bring the live subscriptions in line with the current watch set: ids
   * the set lost are unsubscribed, ids it gained subscribe (delta, so a
   * membership change never re-seeds the ids it kept). */
  const sync = (): void => {
    const wanted = new Set(currentIds())
    for (const [id, sub] of [...subs]) {
      if (wanted.has(id)) continue
      sub.close()
      subs.delete(id)
    }
    for (const id of wanted) {
      if (subs.has(id)) continue
      subs.set(id, feedSubscribe({ channel: 'session', sessionId: id, onData, onState }))
    }
  }
  sync()

  return {
    reconcile: sync,
    close: () => {
      for (const sub of subs.values()) sub.close()
      subs.clear()
    },
  }
}

/**
 * Subscribe to the session channel of the shared feed for one fixed watch
 * set.
 * @param sessionIds - sessions to watch; announced as feed subscriptions on
 *   join and re-announced by the hub's reconnect replay.
 * @param onFrame - one validated host frame.
 * @param onState - optional open/close signal of the shared feed socket.
 * @returns the disposer (idempotent per connection).
 */
export function connectSessionPush(
  sessionIds: readonly string[],
  onFrame: (frame: SessionPushFrame) => void,
  onState?: (open: boolean) => void,
): () => void {
  return openSessionPush(sessionIds, onFrame, onState).close
}
