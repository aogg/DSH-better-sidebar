/**
 * Session push hub spec (`/sidebar/ws/session`, src/session-push.ts): the hub
 * turns session events into per-session INVALIDATION notices. What matters
 * here is exactly that shape — the watch frame REPLACES the watch set (and
 * drops a forgotten session's pending notice), malformed or foreign frames
 * are silently ignored, the watch set caps at 64, the blank flip pushes ONE
 * phase frame per socket per session (a burst of messages must not spam the
 * client), a tool/call folds into one cwd frame per 250ms window (the FIRST
 * trigger's window wins, and a window can fire again once it has), and a ctx
 * without the event API degrades to a no-op instead of throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionPushHub } from '../src/session-push.ts'
import type { Context } from '../src/context-types.ts'
import type { WebSocket } from 'ws'

/** One captured listener of a fake context event. */
type Listener = (...args: unknown[]) => void

/** The frames the hub pushes, as parsed objects. */
interface HubFrame {
  kind: string
  sessionId: string
  blank?: unknown
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
