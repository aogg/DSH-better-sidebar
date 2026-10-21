/**
 * Session push hub spec (`/sidebar/ws/session`, src/session-push.ts): the hub
 * turns session events into per-session frames. What matters here is exactly
 * that shape — the watch frame REPLACES the watch set (and drops a forgotten
 * session's pending notice), malformed or foreign frames are silently
 * ignored, the watch set caps at 64, the blank flip pushes ONE phase frame
 * per socket per session (a burst of messages must not spam the client), a
 * tool/call folds into one cwd frame per 250ms window (the FIRST trigger's
 * window wins, and a window can fire again once it has), and a ctx without
 * the event API degrades to a no-op instead of throwing. With resolvers
 * injected, cwd AND phase frames carry the ANSWER — pushed right on a new
 * watch entry (cwd at each window's end too, the phase's flip one-shot),
 * degraded to the bare cwd frame when that resolution fails or lands after
 * the session left the watch set, while a failing phase resolution stays
 * silent (no bare form) and a late phase answer never regresses a settled
 * flip. `history` frames push fresh record batches to watched sockets only
 * (event level); `history-seed` frames broadcast a project seed scan's
 * start/finish to EVERY attached socket (project-scoped, no watch filter) —
 * both stay no-ops after dispose and without the event API. A durable
 * `assistant/message` row schedules ONE coalesced `turn` frame 400ms out
 * (first-window-wins, its own timer map beside cwd's): the reply-settled
 * signal open editor tabs refresh on — filtered by the watch set, never
 * pushed on a (re)subscription, dropped with an un-watch mid-window, and
 * gone once the socket closes or the hub disposes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionPushHub, type SessionCwdAnswer } from '../src/session-push.ts'
import type { Context } from '../src/context-types.ts'
import type { WebSocket } from 'ws'

/** One captured listener of a fake context event. */
type Listener = (...args: unknown[]) => void

/** The frames the hub pushes, as parsed objects. */
interface HubFrame {
  kind: string
  sessionId: string
  blank?: unknown
  cwd?: unknown
  root?: unknown
  parent?: unknown
}

/** A context exposing just the `on` table the hub subscribes through. */
function fakeCtx(): { ctx: Context; emit: (event: string, ...args: unknown[]) => void; listeners: Map<string, Set<Listener>> } {
  const listeners = new Map<string, Set<Listener>>()
  const ctx = {
    on: (event: string, listener: Listener): (() => void) => {
      let set = listeners.get(event)
      if (set === undefined) listeners.set(event, set = new Set())
      set.add(listener)
      return () => { set.delete(listener) }
    },
  } as unknown as Context
  return {
    ctx,
    listeners,
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
}

/** A minimal WebSocket double: records sends, can be driven and closed. */
class FakeSocket {
  readonly sent: string[] = []
  private readonly handlers = new Map<string, Set<Listener>>()

  on(event: string, handler: Listener): void {
    let set = this.handlers.get(event)
    if (set === undefined) this.handlers.set(event, set = new Set())
    set.add(handler)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** Deliver one inbound frame to the hub. */
  receive(frame: unknown): void {
    for (const handler of [...(this.handlers.get('message') ?? [])]) {
      handler(typeof frame === 'string' ? frame : JSON.stringify(frame))
    }
  }

  /** Fire an event (`close`/`error`) at the socket. */
  fire(event: string): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler()
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket
  }

  frames(): HubFrame[] {
    return this.sent.map(raw => JSON.parse(raw) as HubFrame)
  }
}

/** Attach one socket to a hub, watching exactly `sessionIds`. */
function watch(hub: ReturnType<typeof createSessionPushHub>, socket: FakeSocket, sessionIds: string[]): void {
  hub.attach(socket.asWebSocket())
  socket.receive({ op: 'watch', sessionIds })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('session push hub', () => {
  it('pushes one phase frame for a watched session on its first message, once ever', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    // The blank flip is one-shot: further message rows (the rest of the turn)
    // must not spam the client's entry flip. Each durable assistant/message
    // row rides its own coalesced turn beat (the reply-settled signal); a
    // user/message carries none.
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
    ])
    hub.dispose()
  })

  it('stays silent for sessions the socket did not watch', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    emit('session/event', { id: 'other' }, { type: 'user/message' })
    emit('session/event', { id: 'other' }, { type: 'tool/call' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])
    hub.dispose()
  })

  it('pushes phase once PER SOCKET: two watched sockets each hear the flip once', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const a = new FakeSocket()
    const b = new FakeSocket()
    watch(hub, a, ['t1'])
    watch(hub, b, ['t1'])

    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    expect(a.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    expect(b.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    hub.dispose()
  })

  it('replaces the watch set per frame (a re-watched session may hear the flip again)', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1', 't2'])
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    // The next frame REPLACES the set: t1 is no longer watched.
    socket.receive({ op: 'watch', sessionIds: ['t2'] })
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    emit('session/event', { id: 't2' }, { type: 'user/message' })
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't2', blank: false })

    // Un-watching dropped t1's one-shot with it, so a client re-subscribing
    // hears the flip once more (its connector re-sends the watch on reconnect).
    socket.receive({ op: 'watch', sessionIds: ['t1'] })
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't1', blank: false })
    hub.dispose()
  })

  it('ignores malformed frames and keeps only non-empty string ids', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t2'])
    // None of these throw, and none of them is a watch: the set survives.
    expect(() => { socket.receive('not json') }).not.toThrow()
    expect(() => { socket.receive({ op: 'nope' }) }).not.toThrow()
    emit('session/event', { id: 't2' }, { type: 'user/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't2', blank: false }])

    // A non-array sessionIds REPLACES the set with an empty one: t2 is gone.
    expect(() => { socket.receive({ op: 'watch', sessionIds: 't1' }) }).not.toThrow()
    emit('session/event', { id: 't2' }, { type: 'user/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't2', blank: false }])
    // The mixed array filters down to the non-empty strings: t1 is watched.
    socket.receive({ op: 'watch', sessionIds: [1, null, '', 't1'] })

    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't1', blank: false })
    hub.dispose()
  })

  it('caps the watch set at 64 ids', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const overflow = Array.from({ length: 80 }, (_, index) => `t${index}`)
    socket.receive({ op: 'watch', sessionIds: overflow })

    // 80 ids capped to 64: index 64+ (t64 … t79) are not watched.
    emit('session/event', { id: 't64' }, { type: 'user/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])

    emit('session/event', { id: 't63' }, { type: 'user/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't63', blank: false }])
    hub.dispose()
  })

  it('folds tool calls into one cwd frame per 250ms window, then folds again', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    vi.advanceTimersByTime(249)
    expect(socket.frames()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1' }])

    // A burst within the FIRST trigger's window never postpones it: 20 calls
    // over 190ms, still inside the window armed at t=0.
    for (let index = 0; index < 20; index++) {
      emit('session/event', { id: 't1' }, { type: 'tool/call' })
      vi.advanceTimersByTime(10)
    }
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1' }])
    vi.advanceTimersByTime(60)
    // The window armed by the FIRST call fires exactly once for the burst.
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1' }, { kind: 'cwd', sessionId: 't1' }])

    // A window that has fired may fire again for the next trigger.
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    vi.advanceTimersByTime(250)
    expect(socket.frames()).toEqual([
      { kind: 'cwd', sessionId: 't1' },
      { kind: 'cwd', sessionId: 't1' },
      { kind: 'cwd', sessionId: 't1' },
    ])
    hub.dispose()
  })

  it('drops a pending cwd notice when the session is un-watched mid-window', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1', 't2'])
    emit('session/event', { id: 't1' }, { type: 'tool/call' })

    // Re-watch with t2 only BEFORE t1's window fires: the notice goes away
    // together with the watch entry it was scheduled for.
    socket.receive({ op: 'watch', sessionIds: ['t2'] })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])

    emit('session/event', { id: 't2' }, { type: 'tool/call' })
    vi.advanceTimersByTime(250)
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't2' }])
    hub.dispose()
  })

  it('stops pushing once the socket closes, and unbinds the feed on dispose', () => {
    const { ctx, emit, listeners } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    // The same "close" verdict arrives via an error event.
    socket.fire('error')
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    hub.dispose()
    for (const set of listeners.values()) expect(set.size).toBe(0)
    expect(() => { emit('session/event', { id: 't1' }, { type: 'user/message' }) }).not.toThrow()
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
  })

  it('degrades to a no-op when the ctx has no event API', () => {
    const hub = createSessionPushHub({} as unknown as Context)
    const socket = new FakeSocket()
    expect(() => { hub.attach(socket.asWebSocket()) }).not.toThrow()
    expect(() => { socket.receive({ op: 'watch', sessionIds: ['t1'] }) }).not.toThrow()
    expect(() => { hub.dispose() }).not.toThrow()
    expect(socket.sent).toEqual([])
  })
})

describe('session push hub with a cwd resolver', () => {
  /** One resolver double: always the same answer for any session. */
  const answerOf = (cwd: string): ((sessionId: string) => Promise<SessionCwdAnswer>) =>
    async (sessionId) => ({ sessionId, cwd, root: cwd, parent: null })

  it('answers a newly watched session with its current answer right away', async () => {
    const { ctx } = fakeCtx()
    const resolveCwd = vi.fn(answerOf('/wt-a'))
    const hub = createSessionPushHub(ctx, { resolveCwd })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', sessionIds: ['t1', 't2'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([
      { kind: 'cwd', sessionId: 't1', cwd: '/wt-a', root: '/wt-a', parent: null },
      { kind: 'cwd', sessionId: 't2', cwd: '/wt-a', root: '/wt-a', parent: null },
    ])

    // A repeated identical watch frame adds nothing, so it pushes nothing.
    socket.receive({ op: 'watch', sessionIds: ['t1', 't2'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toHaveLength(2)

    // A re-watched session (dropped, then back) is new again: it hears its
    // answer once more — a reconnecting client re-subscribes exactly so.
    socket.receive({ op: 'watch', sessionIds: ['t2'] })
    socket.receive({ op: 'watch', sessionIds: ['t2', 't1'] })
    await vi.advanceTimersByTimeAsync(0)
    const frames = socket.frames()
    expect(frames).toHaveLength(3)
    expect(frames.at(-1)).toEqual({ kind: 'cwd', sessionId: 't1', cwd: '/wt-a', root: '/wt-a', parent: null })
    hub.dispose()
  })

  it('carries the answer on the coalesced tool/call frame, resolved at window-end', async () => {
    const { ctx, emit } = fakeCtx()
    // The answer MOVES mid-test: the watch must carry the pre-move answer and
    // the window's frame the post-move one — proof the window resolves at its
    // END, not from the state when the first tool call arrived.
    let current = '/wt-before'
    const resolveCwd = vi.fn(async (sessionId: string) => ({ sessionId, cwd: current, root: current, parent: null }))
    const hub = createSessionPushHub(ctx, { resolveCwd })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1', cwd: '/wt-before', root: '/wt-before', parent: null }])

    current = '/wt-after'
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.frames()).toEqual([
      { kind: 'cwd', sessionId: 't1', cwd: '/wt-before', root: '/wt-before', parent: null },
      { kind: 'cwd', sessionId: 't1', cwd: '/wt-after', root: '/wt-after', parent: null },
    ])
    // One resolution per pushed frame (watch + window): no client re-asks.
    expect(resolveCwd).toHaveBeenCalledTimes(2)
    hub.dispose()
  })

  it('degrades to the bare cwd frame when the resolution fails', async () => {
    const { ctx, emit } = fakeCtx()
    const resolveCwd = vi.fn(async (sessionId: string) => {
      throw new Error(`no answer for ${sessionId}`)
    })
    const hub = createSessionPushHub(ctx, { resolveCwd })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    // The watch-time answer fails: the bare invalidation still goes out.
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1' }])

    // Same for a window whose answer fails.
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1' }, { kind: 'cwd', sessionId: 't1' }])
    hub.dispose()
  })

  it('drops an answer that resolves after the session left the watch set', async () => {
    let release: ((answer: SessionCwdAnswer) => void) | undefined
    const resolveCwd = vi.fn((): Promise<SessionCwdAnswer> => new Promise(resolve => { release = resolve }))
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    // Un-watch while the answer is in flight, then let it land: a late answer
    // for a session the client watched away must not arrive.
    socket.receive({ op: 'watch', sessionIds: [] })
    release?.({ sessionId: 't1', cwd: '/late', root: '/late', parent: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([])
    hub.dispose()
  })
})

describe('session push hub with a phase resolver', () => {
  /** One phase resolver double: always `blank`. */
  const phaseOf = (blank: boolean): ((sessionId: string) => Promise<{ blank: boolean }>) =>
    async () => ({ blank })
  /** A cwd resolver double so the options object type-checks; its frame is part of every watch. */
  const cwdAnswer = async (sessionId: string) => ({ sessionId, cwd: '/wt', root: 'wt', parent: null })

  it('answers a newly watched BLANK session with blank:true', async () => {
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase: phaseOf(true) })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([
      { kind: 'cwd', sessionId: 't1', cwd: '/wt', root: 'wt', parent: null },
      { kind: 'phase', sessionId: 't1', blank: true },
    ])
    hub.dispose()
  })

  it('answers a newly watched non-blank session with the flip, one-shot ever after', async () => {
    const { ctx, emit } = fakeCtx()
    const resolvePhase = vi.fn(phaseOf(false))
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([
      { kind: 'cwd', sessionId: 't1', cwd: '/wt', root: 'wt', parent: null },
      { kind: 'phase', sessionId: 't1', blank: false },
    ])

    // The watch answer joined the one-shot set: the message rows that follow
    // must not push the flip a second time. The assistant/message row still
    // schedules its turn beat (a reply step settled), 400ms on.
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([
      { kind: 'cwd', sessionId: 't1', cwd: '/wt', root: 'wt', parent: null },
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
    ])
    expect(resolvePhase).toHaveBeenCalledTimes(1)
    hub.dispose()
  })

  it('repeated identical watch frames re-push nothing', async () => {
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase: phaseOf(true) })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toHaveLength(2)

    socket.receive({ op: 'watch', sessionIds: ['t1'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toHaveLength(2)
    hub.dispose()
  })

  it('stays phase-silent on watch without a resolver, message flips still push', async () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([])

    // The one-shot flip path is independent of the resolver.
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    hub.dispose()
  })

  it('pushes no phase when the watch-time resolution fails, flips still work', async () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx, {
      resolveCwd: cwdAnswer,
      resolvePhase: async () => { throw new Error('phase route down') },
    })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    // No bare invalidation form exists for phase — silence there (only the
    // cwd answer went out), and the message flip keeps working for when the
    // route recovers.
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1', cwd: '/wt', root: 'wt', parent: null }])
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't1', blank: false })
    hub.dispose()
  })

  it('drops an in-flight blank:true watch answer that lands after the flip', async () => {
    let release: ((answer: { blank: boolean }) => void) | undefined
    const resolvePhase = vi.fn((): Promise<{ blank: boolean }> => new Promise(resolve => { release = resolve }))
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toEqual([{ kind: 'cwd', sessionId: 't1', cwd: '/wt', root: 'wt', parent: null }])

    // The message flip wins the race while the watch answer is still in
    // flight; the late blank:true must NOT follow it (never "flip, then
    // blank again").
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't1', blank: false })
    release?.({ blank: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't1', blank: false })
    hub.dispose()
  })

  it('drops an in-flight blank:false watch answer that lands after the flip', async () => {
    let release: ((answer: { blank: boolean }) => void) | undefined
    const resolvePhase = vi.fn((): Promise<{ blank: boolean }> => new Promise(resolve => { release = resolve }))
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)

    emit('session/event', { id: 't1' }, { type: 'user/message' })
    release?.({ blank: false })
    await vi.advanceTimersByTimeAsync(0)
    // The flip frame went out once; the watch answer joins the one-shot set's
    // verdict and must not duplicate it.
    expect(socket.frames().at(-1)).toEqual({ kind: 'phase', sessionId: 't1', blank: false })
    expect(socket.frames().filter(frame => frame.kind === 'phase')).toHaveLength(1)
    hub.dispose()
  })

  it('drops an in-flight phase answer that lands after the session left the watch set', async () => {
    let release: ((answer: { blank: boolean }) => void) | undefined
    const resolvePhase = vi.fn((): Promise<{ blank: boolean }> => new Promise(resolve => { release = resolve }))
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    socket.receive({ op: 'watch', sessionIds: [] })
    release?.({ blank: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames().filter(frame => frame.kind === 'phase')).toEqual([])
    hub.dispose()
  })

  it('re-pushes the current phase on un-watch then re-watch (the reconnect case)', async () => {
    let current = true
    const resolvePhase = vi.fn(async () => ({ blank: current }))
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx, { resolveCwd: cwdAnswer, resolvePhase })
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames().filter(frame => frame.kind === 'phase')).toEqual([
      { kind: 'phase', sessionId: 't1', blank: true },
    ])

    // Un-watch, the session flips elsewhere, then re-watch: the fresh
    // subscription hears the CURRENT answer, not the stale one.
    socket.receive({ op: 'watch', sessionIds: [] })
    current = false
    socket.receive({ op: 'watch', sessionIds: ['t1'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames().filter(frame => frame.kind === 'phase')).toEqual([
      { kind: 'phase', sessionId: 't1', blank: true },
      { kind: 'phase', sessionId: 't1', blank: false },
    ])
    hub.dispose()
  })
})

describe('session push hub: history frames', () => {
  /** One prompt-history send record double. */
  const historyRecord = {
    key: 't1:7',
    sessionId: 't1',
    seq: 7,
    time: 1_700_000_000_007,
    text: '实时一问',
    textTruncated: false,
  }

  it('pushes record batches to watched sockets only, event level (no coalescing)', () => {
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const watched = new FakeSocket()
    const other = new FakeSocket()
    watch(hub, watched, ['t1'])
    watch(hub, other, ['t2'])

    hub.notifyHistory('t1', [historyRecord])
    expect(watched.frames()).toEqual([{ kind: 'history', sessionId: 't1', records: [historyRecord] }])
    expect(other.frames()).toEqual([])

    // Event level: every batch goes out as-is (empty batches are dropped at
    // the hub, real batches are never merged or deduped).
    hub.notifyHistory('t1', [])
    hub.notifyHistory('t1', [historyRecord])
    expect(watched.frames()).toHaveLength(2)
    hub.dispose()
  })

  it('stops pushing after dispose and stays a no-op without the event API', () => {
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    hub.dispose()
    expect(() => { hub.notifyHistory('t1', [historyRecord]) }).not.toThrow()
    expect(socket.frames()).toEqual([])

    const bare = createSessionPushHub({} as unknown as Context)
    expect(() => { bare.notifyHistory('t1', [historyRecord]) }).not.toThrow()
    bare.dispose()
  })

  it('broadcasts history-seed frames to every attached socket, unwatched ones included', () => {
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const watched = new FakeSocket()
    const other = new FakeSocket()
    const idle = new FakeSocket()
    watch(hub, watched, ['t1'])
    watch(hub, other, ['t2'])
    hub.attach(idle.asWebSocket()) // 一个没 watch 任何会话的 socket

    hub.notifyHistorySeed('/work/alpha', true)
    const start = { kind: 'history-seed', cwd: '/work/alpha', seeding: true }
    expect(watched.frames()).toEqual([start])
    expect(other.frames()).toEqual([start])
    expect(idle.frames()).toEqual([start])

    hub.notifyHistorySeed('/work/alpha', false)
    const end = { kind: 'history-seed', cwd: '/work/alpha', seeding: false }
    expect(watched.frames()).toEqual([start, end])

    // 别的项目的扫描同样原样广播（客户端按 cwd 认领）。
    hub.notifyHistorySeed('/work/beta', true)
    expect(watched.frames().at(-1)).toEqual({ kind: 'history-seed', cwd: '/work/beta', seeding: true })
    hub.dispose()
  })

  it('stays a no-op for history-seed after dispose and without the event API', () => {
    const { ctx } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    hub.dispose()
    expect(() => { hub.notifyHistorySeed('/work/alpha', false) }).not.toThrow()
    expect(socket.frames()).toEqual([])

    const bare = createSessionPushHub({} as unknown as Context)
    expect(() => { bare.notifyHistorySeed('/work/alpha', true) }).not.toThrow()
    bare.dispose()
  })
})

describe('session push hub: turn frames', () => {
  it('pushes one turn frame 400ms after a durable assistant/message settles', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    // A watch (re)subscription pushes NO turn frame — the frames a plain
    // watch pushes (cwd/phase with resolvers) may come, but never a turn.
    vi.advanceTimersByTime(1_000)
    expect(socket.frames().filter(frame => frame.kind === 'turn')).toEqual([])

    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    // The same row is the session's first message, so the one-shot phase
    // flip leaves immediately; the turn beat rides its own 400ms window.
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    vi.advanceTimersByTime(399)
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    vi.advanceTimersByTime(1)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
    ])
    hub.dispose()
  })

  it('a user/message or a tool row schedules no turn frame', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    emit('session/event', { id: 't1' }, { type: 'user/message' })
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    vi.advanceTimersByTime(1_000)
    // The phase flip (user/message) and the cwd frame (tool/call) ride their
    // own kinds; the turn kind stays silent — only a settled reply step
    // means "the reply finished".
    expect(socket.frames().filter(frame => frame.kind === 'turn')).toEqual([])
    hub.dispose()
  })

  it('coalesces a burst of settled rows into the first trigger\'s window', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    // A multi-step turn settles row after row; every row inside the window
    // armed by the FIRST one joins it — one beat, not one per row. The
    // first row also spends the phase flip (one frame, ever).
    for (let index = 0; index < 5; index++) {
      emit('session/event', { id: 't1' }, { type: 'assistant/message' })
      vi.advanceTimersByTime(70)
    }
    // 5 rows × 70ms = 350ms: still inside the window armed at t=0.
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    vi.advanceTimersByTime(50)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
    ])

    // A window that has fired may fire again for the NEXT settled row — each
    // beat lands 400ms after ITS row, so a multi-step turn stays fresh and
    // the last row's beat is the completion signal.
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(400)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
      { kind: 'turn', sessionId: 't1' },
    ])
    hub.dispose()
  })

  it('per-socket windows: two watched sockets each get their own beat', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const a = new FakeSocket()
    const b = new FakeSocket()
    watch(hub, a, ['t1'])
    watch(hub, b, ['t1'])

    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(400)
    const beat = [{ kind: 'phase', sessionId: 't1', blank: false }, { kind: 'turn', sessionId: 't1' }]
    expect(a.frames()).toEqual(beat)
    expect(b.frames()).toEqual(beat)
    hub.dispose()
  })

  it('filters by the watch set: unwatched sessions push nothing', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    emit('session/event', { id: 'other' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])
    hub.dispose()
  })

  it('re-subscribing (the reconnect case) pushes no fabricated turn frame', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    // A settled row, its beat delivered (and the phase flip with it)…
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(400)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
    ])

    // …then the client re-subscribes (a reconnect re-sends the whole watch
    // set on a fresh socket). Un-watch + re-watch must not conjure a "just
    // finished" — the signal only exists when a row settles while watched.
    socket.receive({ op: 'watch', sessionIds: [] })
    socket.receive({ op: 'watch', sessionIds: ['t1'] })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'turn', sessionId: 't1' },
    ])
    hub.dispose()
  })

  it('drops a pending turn window when the session is un-watched mid-window', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1', 't2'])
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    // t1's first row also flips the phase; the TURN beat it scheduled…
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    socket.receive({ op: 'watch', sessionIds: ['t2'] })
    vi.advanceTimersByTime(1_000)
    // …is gone with the watch entry (the phase frame above is all t1 left).
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    // The dropped window does not poison the next one: t2's own row beats
    // (and flips t2's phase — its first message).
    emit('session/event', { id: 't2' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(400)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'phase', sessionId: 't2', blank: false },
      { kind: 'turn', sessionId: 't2' },
    ])
    hub.dispose()
  })

  it('stops pushing after the socket closes or the hub disposes, timers cleared', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    // The flip left synchronously; the turn beat is still pending…
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    // …and a closed socket drops it.
    socket.fire('error')
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])

    // Dispose tears down the feed: no listener left, no frame, no throw.
    const second = new FakeSocket()
    watch(hub, second, ['t1'])
    hub.dispose()
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(1_000)
    expect(second.frames()).toEqual([])
  })

  it('a cwd window and a turn window for the same session do not evict each other', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    watch(hub, socket, ['t1'])

    // Both schedules arm for the same session — separate timer maps, so the
    // cwd beat at 250ms and the turn beat at 400ms BOTH land. The
    // assistant/message row also flips the phase on arrival.
    emit('session/event', { id: 't1' }, { type: 'tool/call' })
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
    vi.advanceTimersByTime(250)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'cwd', sessionId: 't1' },
    ])
    vi.advanceTimersByTime(150)
    expect(socket.frames()).toEqual([
      { kind: 'phase', sessionId: 't1', blank: false },
      { kind: 'cwd', sessionId: 't1' },
      { kind: 'turn', sessionId: 't1' },
    ])
    hub.dispose()
  })
})
