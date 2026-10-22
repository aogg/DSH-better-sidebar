/**
 * Session-level push behind `/sidebar/ws/session`.
 *
 * The sidebar client learns two session-level facts through THIS socket only:
 * whether the session is still blank and which workspace root the session is
 * working in. The client never polls them over HTTP — a dropped socket is
 * answered with reconnects (the client connector's 1s → 15s backoff), never
 * with asks. The host already knows the moment either fact changes: the
 * session append feed (`session/event`) carries every durable row, and a
 * `user/message` / `assistant/message` row is exactly the blank flip, while a
 * `tool/call` row is exactly the "the agent ran somewhere" signal the
 * active-worktree scan derives its answer from.
 *
 * This hub turns those events into per-session frames. Both frame kinds
 * carry the ANSWER, each resolved through its injected resolver — the very
 * implementation the HTTP route serves, so the pushed answer and the route's
 * can never disagree:
 *
 * - `phase`: a watch (re)subscription resolves the CURRENT phase and pushes
 *   `{kind:'phase', sessionId, blank}` — `blank:true` tells a freshly
 *   connected client "still waiting", `blank:false` IS the flip. The
 *   message-event flip stays one-shot per socket per session (a burst of
 *   message rows must not spam the client's entry flip). A late watch answer
 *   landing after the flip re-checks the one-shot set and is dropped, so a
 *   connected client never hears "non-blank, then blank again". A failed
 *   resolution pushes NOTHING — the phase has no bare invalidation form (the
 *   blank answer IS the "keep waiting" state).
 * - `cwd`: pushed on a watch (re)subscription and at the end of the 250ms
 *   tool/call coalescing window as `{kind:'cwd', sessionId, cwd, root,
 *   parent}`. A failed resolution, or a hub mounted without a resolver,
 *   degrades to the legacy bare `{kind:'cwd', sessionId}` invalidation —
 *   current clients IGNORE that bare frame and wait for the next push (the
 *   next tool/call burst re-resolves and re-pushes); the variant only exists
 *   so older answer-unaware clients keep their re-ask behavior working.
 *
 * - `history`: `{kind:'history', sessionId, records}` pushed by
 *   `notifyHistory` whenever the prompt-history recorder appends real-time
 *   records for a session (index.ts wires the recorder's sink to it). Event
 *   level, no one-shot/coalescing: each new record batch goes out to every
 *   socket watching that session as-is. Only FRESH appends ride this frame —
 *   the recorder's append path dedupes by record key first, so a record the
 *   seed scan already stored is never pushed twice.
 * - `history-seed`: `{kind:'history-seed', cwd, seeding}` broadcast by
 *   `notifyHistorySeed` when a project's seed scan STARTS (`seeding:true`) and
 *   FINISHES (`seeding:false`) — the prompt-history tab's seeding strip and
 *   its one-shot "refetch the first page when indexing completes" are driven
 *   by this frame instead of polling `history.list`. Project-scoped (not
 *   session-scoped), so it goes to every attached socket unfiltered; `cwd` is
 *   the same project root `history.list` answers with (`project.cwd`), which
 *   is how a client claims the frame. Clients that don't know the kind drop
 *   it in their existing unknown-kind filter — no shape change to the frames
 *   they do read.
 *
 * - `turn`: `{kind:'turn', sessionId}` pushed when a durable
 *   `assistant/message` row settles — one row per settled reply step, and the
 *   LAST one of a turn is exactly "the session's reply finished". The frame
 *   is what open editor tabs ride to re-read a file the reply may have
 *   rewritten (zero HTTP: the reload is scheduled by the push itself). Every
 *   row schedules its own 400ms coalescing window per socket per session
 *   (first-window-wins, the cwd schedule), so a multi-step turn pushes one
 *   beat per step — the intermediate beats are harmless freshness pushes, the
 *   final one is the completion signal. A watch (re)subscription pushes NO
 *   turn frame (a reconnect must not fake a "just finished" signal), and
 *   `user/message` / `tool/*` rows push none either — only a settled reply
 *   step does.
 *
 * - `ops`: `{kind:'ops', sessionId, seq}` — pure INVALIDATION, the side-chat
 *   push model. Every durable session-event row (any type: the consumers —
 *   the changes tab's session lens, the editor's file-op stream, the Tasks
 *   page's live/telemetry pulls — each fold their own subset, so the hub
 *   must not pre-filter) schedules one coalesced notice per socket per
 *   session (first-window-wins 250ms, the max seq of the window rides the
 *   frame as a diagnostic payload — subtree consumers renumber seqs when
 *   merging, so clients treat the frame as "re-pull your delta now" and
 *   never compare that seq with their own cursor). No event body crosses the
 *   socket: the one-shot `changes.ops` / `subagents.live` / `workflows.list`
 *   pull stays the single source of data, and a watch (re)subscription
 *   pushes NO ops frame — a reconnecting client catches up through its own
 *   re-pull (the client connector fires its reconnect hook), never through a
 *   fabricated notice.
 *
 * Two frame kinds, two schedules: the blank flip is one-shot, so each socket
 * pushes at most one `blank:false` phase frame per session, ever (a burst of
 * message events must not spam the client's entry flip). A `tool/call` only
 * means the worktree scan MIGHT reach a different root, so it rides a 250ms
 * coalescing window (first trigger's window wins) and the frame's answer is
 * resolved with `fresh: true`, skipping the 3s TTL cache.
 * @module dsh-better-sidebar/session-push
 */
import type { WebSocket } from 'ws'
import type { Context } from './context-types.ts'
import type { HistorySendRecord } from './prompt-history-extract.ts'

/** Coalescing window for `tool/call` (cwd) notices. */
const CWD_DEBOUNCE_MS = 250
/** Coalescing window for settled `assistant/message` (turn) notices. */
const TURN_COALESCE_MS = 400
/** Coalescing window for `ops` invalidation notices (any durable row). */
const OPS_DEBOUNCE_MS = 250
/** Session ids one socket may watch (a resource guard, not a policy). */
const MAX_WATCHED = 64

/** The frames the host pushes: which watched session, which fact — and the answer. */
export type SessionPushFrame =
  /** The phase answer: `blank:false` is the one-shot flip, `blank:true` the watch-time "still waiting". */
  | { kind: 'phase'; sessionId: string; blank: boolean }
  /** Bare invalidation: no resolver, or the resolution failed — current clients ignore it and wait for the next push. */
  | { kind: 'cwd'; sessionId: string }
  /** The answer itself, exactly what the `session.cwd` route would have returned. */
  | { kind: 'cwd'; sessionId: string; cwd: string; root: string; parent: string | null }
  /** Freshly recorded prompt-history send records (event level, no coalescing). */
  | { kind: 'history'; sessionId: string; records: HistorySendRecord[] }
  /**
   * A project's seed scan started (`seeding:true`) or finished (`seeding:false`);
   * `cwd` is the project root exactly as `history.list`'s `project.cwd` names it.
   * Broadcast to every attached socket (project-scoped, no watch filter).
   */
  | { kind: 'history-seed'; cwd: string; seeding: boolean }
  /**
   * One settled reply step of a watched session: a durable `assistant/message`
   * row landed (the turn's LAST row is the reply's completion). The bare
   * session id is the whole payload — the client knows what to do with the
   * fact (re-read open files), and the 400ms window keeps a burst of steps
   * from spamming it.
   */
  | { kind: 'turn'; sessionId: string }
  /**
   * INVALIDATION ONLY (the side-chat push model): at least one durable
   * session-event row of the watched session landed inside the 250ms window.
   * `seq` is the newest row's own per-log seq — a diagnostic payload, NOT a
   * client cursor (subtree `changes.ops` answers renumber seqs when merging,
   * so a client must never compare it with its cursor; the reaction is always
   * "re-pull the delta once"). No event body rides the frame.
   */
  | { kind: 'ops'; sessionId: string; seq: number }

/** One resolved cwd answer, shaped like the `session.cwd` route's return value. */
export interface SessionCwdAnswer {
  sessionId: string
  cwd: string
  root: string
  parent: string | null
}

/** One resolved phase answer, shaped like the `session.phase` route's return value. */
export interface SessionPhaseAnswer {
  blank: boolean
}

/** Hub options: where a frame's answer comes from. */
export interface SessionPushHubOptions {
  /**
   * Resolve one session's live answer. Implementations should be the SAME
   * source as the `session.cwd` route (in index.ts the resolver literally
   * calls that route with `fresh: true`); a rejection degrades the frame to
   * the bare invalidation variant.
   */
  resolveCwd(sessionId: string): Promise<SessionCwdAnswer>
  /**
   * Resolve one session's CURRENT blank phase — the same source as the
   * `session.phase` route. Omitted (or rejecting), a watch pushes no phase
   * frame at all: the phase has no bare invalidation form, and the message
   * flip keeps pushing `{blank:false}` regardless.
   */
  resolvePhase?(sessionId: string): Promise<SessionPhaseAnswer>
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
  /**
   * Push one batch of freshly recorded prompt-history records to every socket
   * watching `sessionId` (event level: no one-shot set, no coalescing window).
   */
  notifyHistory(sessionId: string, records: readonly HistorySendRecord[]): void
  /**
   * Broadcast a project seed-scan state change to every attached socket (the
   * prompt-history tab's seeding strip / one-shot completion refetch key off
   * this frame; project-scoped, so no watch filter applies).
   */
  notifyHistorySeed(projectRoot: string, seeding: boolean): void
  /** Release the event feed (socket teardown stays with the server). */
  dispose(): void
}

/**
 * Register the session push feed.
 * @param ctx - host plugin context (its `on` subscribes the append feed).
 * @param options - answer sources; an omitted `resolvePhase` (or a failing
 *   one) keeps watch-time phase silent, an omitted `resolveCwd` keeps cwd
 *   frames bare invalidations (the pre-answer-wire format).
 * @returns the hub plus a disposer unbinding the listener.
 */
export function createSessionPushHub(ctx: Context, options?: SessionPushHubOptions): SessionPushHub {
  const sockets = new Set<SessionSocket>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API still accept sockets, which then
    // simply never hear anything.
    return { attach: () => {}, notifyHistory: () => {}, notifyHistorySeed: () => {}, dispose: () => {} }
  }
  const offEvent = ctx.on('session/event', (session, event) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    // EVERY durable row invalidates the session's ops-delta consumers first
    // (changes tab, file-op stream, Tasks telemetry): each folds its own
    // subset of the log, so the one honest signal is "a row landed", with the
    // per-socket 250ms window bounding a burst. The specific kinds below stay
    // exactly as they were.
    for (const socket of sockets) socket.notifyOps(sessionId, event.seq)
    // Same verdict as the `session.phase` route: the first user/assistant
    // message is the flip out of blank.
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      for (const socket of sockets) socket.notifyPhase(sessionId)
      // A durable `assistant/message` row is one SETTLED reply step (stream
      // frames never reach the log) — each row schedules its own coalesced
      // turn beat, so the turn's last row pushes the completion frame. A
      // `user/message` is the ask, not an answer: no turn frame for it.
      if (event.type === 'assistant/message') {
        for (const socket of sockets) socket.notifyTurn(sessionId)
      }
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
      const socket = new SessionSocket(
        ws,
        () => { sockets.delete(socket) },
        options?.resolveCwd,
        options?.resolvePhase,
      )
      sockets.add(socket)
    },
    notifyHistory: (sessionId, records) => {
      // Event level, no one-shot/debounce: each record batch goes out as-is to
      // every socket watching the session (unwatched sockets stay silent).
      if (records.length === 0) return
      for (const socket of sockets) socket.notifyHistory(sessionId, records)
    },
    notifyHistorySeed: (projectRoot, seeding) => {
      // Project-scoped: broadcast, no watch filter (the seeding tab may not
      // watch every session the scan covers yet — that is exactly the gap the
      // completion frame's client-side refetch closes).
      for (const socket of sockets) socket.notifyHistorySeed(projectRoot, seeding)
    },
    dispose: () => {
      offEvent()
      for (const socket of sockets) socket.close()
      sockets.clear()
    },
  }
}

/** One attached socket's watch set, phase one-shots and cwd/turn coalescing timers. */
class SessionSocket {
  private readonly socket: WebSocket
  private readonly onClosed: () => void
  private readonly resolveCwd: ((sessionId: string) => Promise<SessionCwdAnswer>) | undefined
  private readonly resolvePhase: ((sessionId: string) => Promise<SessionPhaseAnswer>) | undefined
  private readonly watched = new Set<string>()
  /** Sessions this socket already heard the blank flip for (one frame, ever). */
  private readonly phased = new Set<string>()
  /** Pending cwd windows, keyed by session id. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Pending turn windows, keyed by session id (deliberately NOT the cwd map:
   *  both key on session id, and sharing one map would let a cwd window and a
   *  turn window evict each other mid-flight). */
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Pending ops windows, keyed by session id (own map, the same
   *  one-key-per-schedule reason as cwd/turn; the entry keeps the window's
   *  newest seq so a burst lands as ONE frame carrying the max). */
  private readonly opsTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; seq: number }>()
  private closed = false

  /**
   * @param socket - the accepted WebSocket.
   * @param onClosed - hub-side cleanup (idempotent).
   * @param resolveCwd - cwd answer source; omitted, cwd frames stay bare.
   * @param resolvePhase - phase answer source; omitted, watch stays phase-silent.
   */
  constructor(
    socket: WebSocket,
    onClosed: () => void,
    resolveCwd?: (sessionId: string) => Promise<SessionCwdAnswer>,
    resolvePhase?: (sessionId: string) => Promise<SessionPhaseAnswer>,
  ) {
    this.socket = socket
    this.onClosed = onClosed
    this.resolveCwd = resolveCwd
    this.resolvePhase = resolvePhase
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
    // The turn windows drop with their watch entries the same way (a separate
    // map, the same rule: an unwatched session may not fire a scheduled beat).
    for (const [id, timer] of this.turnTimers) {
      if (this.watched.has(id)) continue
      clearTimeout(timer)
      this.turnTimers.delete(id)
    }
    // The ops windows follow their watch entries out the same way: an
    // unwatched session must not hear a late invalidation.
    for (const [id, pending] of this.opsTimers) {
      if (this.watched.has(id)) continue
      clearTimeout(pending.timer)
      this.opsTimers.delete(id)
    }
    // A NEWLY watched session hears its CURRENT answers right away: a client
    // re-subscribing (every reconnect re-sends the whole watch set on a fresh
    // socket) is exactly the case that must not wait for the next event —
    // cwd's live root AND the phase's current blank state. A repeated
    // identical watch frame adds nothing, so it pushes nothing.
    for (const id of this.watched) {
      if (!previous.has(id)) {
        this.pushCwdAnswer(id)
        this.pushPhaseAnswer(id)
      }
    }
  }

  /**
   * The session just left blank (first user/assistant message). ONE `blank:
   * false` frame per session per socket, ever: the flip is one-shot, and the
   * client stops caring about the phase the moment it hears it.
   * @param sessionId - the session that flipped.
   */
  notifyPhase(sessionId: string): void {
    if (this.closed || !this.watched.has(sessionId) || this.phased.has(sessionId)) return
    this.phased.add(sessionId)
    this.send({ kind: 'phase', sessionId, blank: false })
  }

  /**
   * Push one batch of freshly recorded prompt-history records. Event level:
   * no one-shot set and no coalescing window — the prompt-history recorder's
   * sink calls this on every append, and each batch goes out as-is to the
   * sockets watching that session.
   * @param sessionId - the session the records belong to.
   * @param records - the newest-first send records just appended.
   */
  notifyHistory(sessionId: string, records: readonly HistorySendRecord[]): void {
    if (this.closed || !this.watched.has(sessionId)) return
    this.send({ kind: 'history', sessionId, records: [...records] })
  }

  /**
   * Broadcast a project seed-scan state change. Not watch-gated: the scan's
   * scope routinely covers sessions the client has never listed, and the
   * completion frame is what tells the tab to refetch and discover them.
   * @param projectRoot - the project root, identical to `history.list`'s
   *   `project.cwd` (same resolution, so the client can string-compare).
   * @param seeding - true = scan started, false = scan finished.
   */
  notifyHistorySeed(projectRoot: string, seeding: boolean): void {
    if (this.closed) return
    this.send({ kind: 'history-seed', cwd: projectRoot, seeding })
  }

  /**
   * Coalesce one turn notice for a session: a durable `assistant/message` row
   * just settled. The FIRST trigger's window wins (the cwd schedule), so each
   * settled step of a multi-step turn lands its own beat 400ms after IT
   * arrived — mid-turn beats are harmless freshness pushes, the turn's last
   * step pushes the frame the client means ("the reply finished, re-read what
   * it wrote"). (Re)subscriptions push nothing here: a reconnecting client
   * must not hear a fabricated "just finished" — the signal only exists when
   * a row actually settles while the socket watches.
   * @param sessionId - the session whose reply step just settled.
   */
  notifyTurn(sessionId: string): void {
    if (this.closed || !this.watched.has(sessionId) || this.turnTimers.has(sessionId)) return
    this.turnTimers.set(sessionId, setTimeout(() => {
      this.turnTimers.delete(sessionId)
      this.send({ kind: 'turn', sessionId })
    }, TURN_COALESCE_MS))
  }

  /**
   * Coalesce one ops invalidation for a session: a durable event row just
   * landed. The FIRST trigger's window wins (the cwd/turn schedule), and a
   * burst inside the window only raises the seq the frame will carry — one
   * frame per burst, never one per row. (Re)subscriptions push nothing here:
   * a reconnecting client catches up through its own re-pull, and a
   * fabricated "something landed" would only duplicate it.
   * @param sessionId - the session whose log grew.
   * @param seq - the landed row's own per-log seq (diagnostic on the wire).
   */
  notifyOps(sessionId: string, seq: number): void {
    if (this.closed || !this.watched.has(sessionId)) return
    const pending = this.opsTimers.get(sessionId)
    if (pending !== undefined) {
      if (seq > pending.seq) pending.seq = seq
      return
    }
    const entry = { timer: setTimeout(() => {
      this.opsTimers.delete(sessionId)
      this.send({ kind: 'ops', sessionId, seq: entry.seq })
    }, OPS_DEBOUNCE_MS), seq }
    this.opsTimers.set(sessionId, entry)
  }

  /**
   * Resolve the session's CURRENT phase and push it INSIDE the phase frame on
   * a watch (re)subscription: `blank:true` ("still waiting") and `blank:false`
   * (the flip itself, which joins the one-shot set exactly like a message
   * flip would). The resolution is async, so the answer re-checks `closed` /
   * `watched` / `phased` before sending — a socket that died, a session the
   * client watched away, or a flip frame that already went out (in-flight
   * watch answer vs. message event) must not produce a late frame, least of
   * all a `blank:true` that would regress a settled flip. A failed resolution
   * pushes NOTHING: the phase has no bare invalidation form (the blank answer
   * is itself the "keep waiting" state).
   */
  private pushPhaseAnswer(sessionId: string): void {
    const resolve = this.resolvePhase
    if (resolve === undefined || this.closed || !this.watched.has(sessionId)) return
    void resolve(sessionId)
      .then(answer => {
        if (this.closed || !this.watched.has(sessionId) || this.phased.has(sessionId)) return
        if ((answer as { blank?: unknown } | null | undefined)?.blank !== true) {
          // Non-blank — this IS the flip: join the one-shot set before the
          // frame leaves, so a racing message event can never push it twice.
          this.phased.add(sessionId)
          this.send({ kind: 'phase', sessionId, blank: false })
          return
        }
        this.send({ kind: 'phase', sessionId, blank: true })
      })
      .catch(() => {
        // Designed silence: watch-time phase has no degraded frame form.
      })
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
      // Without a resolver the frame stays the bare invalidation (the
      // pre-answer-wire format, kept for older clients).
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
   * current clients ignore THAT and simply wait for the next tool/call burst
   * to re-resolve and re-push; the variant exists so older answer-unaware
   * clients keep their re-ask behavior working. This is the designed
   * degradation path, not a silently swallowed error.
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
    for (const timer of this.turnTimers.values()) clearTimeout(timer)
    this.turnTimers.clear()
    for (const pending of this.opsTimers.values()) clearTimeout(pending.timer)
    this.opsTimers.clear()
    this.watched.clear()
    this.phased.clear()
    this.onClosed()
  }
}
