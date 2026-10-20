/**
 * Session push hub spec (`/sidebar/ws/session`, src/session-push.ts): the hub
 * turns session events into per-session frames. What matters here is exactly
 * that shape — the watch frame REPLACES the watch set (and drops a forgotten
 * session's pending notice), malformed or foreign frames are silently
 * ignored, the watch set caps at 64, the blank flip pushes ONE phase frame
 * per socket per session (a burst of messages must not spam the client), a
 * tool/call folds into one cwd frame per 250ms window (the FIRST trigger's
 * window wins, and a window can fire again once it has), and a ctx without
 * the event API degrades to a no-op instead of throwing. With a resolver
 * injected, cwd frames carry the ANSWER — pushed right on a new watch entry
 * and at each window's end, degraded to the bare frame when the resolution
 * fails or lands after the session left the watch set.
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
    // must not spam the client's entry flip.
    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    emit('session/event', { id: 't1' }, { type: 'user/message' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([{ kind: 'phase', sessionId: 't1', blank: false }])
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
