/**
 * Side-chat push spec: the hub turns the two host feeds (the session append
 * feed and the process-local assistant stream) into per-thread INVALIDATION
 * notices, coalesced per thread. What matters here is exactly that shape —
 * a watched thread hears about both feeds, an unwatched one stays silent, a
 * burst folds into one notice, and a socket that goes away stops hearing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSidechatPushHub, THREADS_DEBOUNCE_MS as THREADS_WINDOW_MS } from '../src/sidechat-push.ts'
import type { Context } from '../src/context-types.ts'
import type { WebSocket } from 'ws'

/** One captured listener of a fake context event. */
type Listener = (...args: unknown[]) => void

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

  frames(): { threadId?: string; scope?: string; rows?: unknown[]; degraded?: boolean }[] {
    return this.sent.map(raw => JSON.parse(raw) as { threadId?: string; scope?: string; rows?: unknown[]; degraded?: boolean })
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('sidechat push hub', () => {
  it('notifies a watched thread on a durable append and on a stream frame', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threadIds: ['t1'] })

    emit('session/event', { id: 't1' }, { type: 'assistant/message' })
    vi.advanceTimersByTime(60)
    expect(socket.frames()).toEqual([{ threadId: 't1' }])

    emit('agent/assistant-stream', { agent: { session: { id: 't1' } }, frame: { type: 'chunk' } })
    vi.advanceTimersByTime(250)
    expect(socket.frames()).toEqual([{ threadId: 't1' }, { threadId: 't1' }])
    hub.dispose()
  })

  it('stays silent for threads the socket did not watch', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threadIds: ['t1'] })

    emit('session/event', { id: 'other' }, { type: 'turn/end' })
    emit('agent/assistant-stream', { agent: { session: { id: 'other' } }, frame: { type: 'chunk' } })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])
    hub.dispose()
  })

  it('folds a burst of stream frames into one notice', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threadIds: ['t1'] })

    for (let index = 0; index < 20; index++) {
      emit('agent/assistant-stream', { agent: { session: { id: 't1' } }, frame: { type: 'chunk' } })
      vi.advanceTimersByTime(10)
    }
    // The first frame armed the 250ms window; the burst never postpones it.
    expect(socket.frames()).toEqual([])
    vi.advanceTimersByTime(60)
    expect(socket.frames()).toEqual([{ threadId: 't1' }])
    hub.dispose()
  })

  it('replaces the watch set per frame (an unwatched thread drops its pending notice)', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threadIds: ['t1', 't2'] })
    emit('session/event', { id: 't1' }, { type: 'turn/end' })

    // Re-watch with t2 only BEFORE the first notice fires: t1 is forgotten
    // together with the notice it had scheduled.
    socket.receive({ op: 'watch', threadIds: ['t2'] })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])

    emit('session/event', { id: 't2' }, { type: 'turn/end' })
    vi.advanceTimersByTime(60)
    expect(socket.frames()).toEqual([{ threadId: 't2' }])
    hub.dispose()
  })

  it('ignores malformed frames and keeps only string ids', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive('not json')
    socket.receive({ op: 'nope' })
    // A non-array threadIds clears the set; the mixed array then watches t1.
    expect(() => { socket.receive({ op: 'watch', threadIds: 't1' }) }).not.toThrow()
    socket.receive({ op: 'watch', threadIds: [1, null, 't1'] })

    emit('session/event', { id: 't1' }, { type: 'turn/end' })
    vi.advanceTimersByTime(60)
    expect(socket.frames()).toEqual([{ threadId: 't1' }])
    hub.dispose()
  })

  it('caps the watch set and stops pushing once the socket closes', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const overflow = Array.from({ length: 80 }, (_, index) => `t${index}`)
    socket.receive({ op: 'watch', threadIds: overflow })

    emit('session/event', { id: 't79' }, { type: 'turn/end' })
    vi.advanceTimersByTime(60)
    // 80 ids capped to 64: the 65th+ ids are not watched.
    expect(socket.frames()).toEqual([])

    emit('session/event', { id: 't0' }, { type: 'turn/end' })
    vi.advanceTimersByTime(60)
    expect(socket.frames()).toEqual([{ threadId: 't0' }])

    socket.fire('close')
    emit('session/event', { id: 't0' }, { type: 'turn/end' })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([{ threadId: 't0' }])
    hub.dispose()
  })

  it('unbinds both feeds on dispose', () => {
    const { ctx, listeners } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    hub.dispose()
    for (const set of listeners.values()) expect(set.size).toBe(0)
  })
})

/**
 * The GLOBAL threads channel: a socket that watched `threads: true` also
 * hears ONE coalesced `{scope:'threads'}` frame per burst — triggered by
 * EITHER feed (any session's durable append, any stream delta) or by the
 * routes' direct `notifyThreads()` poke. Without rootIds the frame carries
 * no data (LEGACY mode: an old client answers it with one HTTP pull), and
 * a socket that never subscribed must not receive it (old clients stay
 * untouched).
 */
describe('sidechat push hub threads channel', () => {
  it('pushes a coalesced threads notice on both feeds and on notifyThreads', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threads: true })

    // Any session's durable append feeds the channel (the running flips ride
    // turn/start / turn/end appends)…
    emit('session/event', { id: 'anywhere' }, { type: 'turn/end' })
    // …and so does a stream delta for a thread this socket does not watch —
    // the GLOBAL groups care about every workspace, not a watch set.
    emit('agent/assistant-stream', { agent: { session: { id: 'unwatched' } }, frame: { type: 'chunk' } })
    vi.advanceTimersByTime(THREADS_WINDOW_MS)
    // Folded into ONE frame: both triggers landed inside the same window.
    expect(socket.frames()).toEqual([{ scope: 'threads' }])

    // The routes' direct poke (create / rename / dispose) arms the same
    // channel while it is already armed → still one frame per window.
    hub.notifyThreads()
    vi.advanceTimersByTime(THREADS_WINDOW_MS)
    expect(socket.frames()).toEqual([{ scope: 'threads' }, { scope: 'threads' }])
    hub.dispose()
  })

  it('never pushes a threads frame to a socket that did not subscribe', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    // The pre-threads watch shape: no `threads` key.
    socket.receive({ op: 'watch', threadIds: ['t1'] })

    emit('session/event', { id: 't1' }, { type: 'turn/start' })
    hub.notifyThreads()
    vi.advanceTimersByTime(1_000)
    // Only the per-thread notice the watch set asked for.
    expect(socket.frames()).toEqual([{ threadId: 't1' }])
    hub.dispose()
  })

  it('drops the threads subscription (and its pending notice) on a re-watch without the flag', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threads: true })
    emit('session/event', { id: 'x' }, { type: 'turn/end' })

    // Re-watch WITHOUT threads BEFORE the notice fires: the pending frame
    // dies with the subscription, like an unwatched thread's notice does.
    socket.receive({ op: 'watch', threadIds: ['t1'] })
    vi.advanceTimersByTime(1_000)
    expect(socket.frames()).toEqual([])
    hub.dispose()
  })

  it('keeps the threads channel independent of the per-thread channel', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    socket.receive({ op: 'watch', threadIds: ['t1'], threads: true })

    emit('session/event', { id: 't1' }, { type: 'turn/start' })
    emit('agent/assistant-stream', { agent: { session: { id: 't1' } }, frame: { type: 'chunk' } })
    vi.advanceTimersByTime(THREADS_WINDOW_MS)
    // The watched thread's notice rides the 60ms window, the global one the
    // threads window: two frames, each its own coalescing timer.
    expect(socket.frames()).toEqual([{ threadId: 't1' }, { scope: 'threads' }])
    hub.dispose()
  })
})

/**
 * The threads channel's DATA mode: a subscription whose census roots were
 * reported (`setWatch(..., roots)`, via the feed's `watch` control frame)
 * no longer receives pull-me empty frames — the hub COMPUTES the census
 * (the injected `threadsCensus`, the `sidechat.threads` route's core),
 * diffs it against what it last pushed, and ships only real changes as
 * `{scope:'threads', rows, degraded}`. Alignment is a push: the first
 * data-mode watch (join, re-open, a rootIds update) always produces the
 * current snapshot; before any roots the channel stays legacy.
 */
describe('sidechat push hub threads DATA mode', () => {
  /** A row factory (the wire shape of one census row). */
  function row(id: string, running = false, title = `Side: ${id}`): { id: string; title: string; running: boolean; parentId: string } {
    return { id, title, running, parentId: 'root' }
  }

  /** A census stub answering `answer` for every call (call-counted, roots
   *  recorded). */
  function censusOf(answer: { rows: unknown[]; degraded: boolean } | Error): { census: ReturnType<typeof vi.fn>; calls: () => number } {
    const census = vi.fn(async (_roots: readonly string[]) => {
      if (answer instanceof Error) throw answer
      return answer
    })
    return { census, calls: () => census.mock.calls.length }
  }

  it('pushes the current census as the alignment snapshot on the first data-mode watch — no feed trigger needed', async () => {
    const { ctx } = fakeCtx()
    const { census, calls } = censusOf({ rows: [row('s1', true)], degraded: false })
    const hub = createSidechatPushHub(ctx, { threadsCensus: census as never })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const subscription = hub.subscribe({ onFrame: (frame) => { socket.sent.push(JSON.stringify(frame)) } })

    subscription.setWatch([], true, ['root-1'])
    await vi.advanceTimersByTimeAsync(0)
    // The snapshot arrives WITHOUT any window: the client just said what it
    // wants to know.
    expect(socket.frames()).toEqual([{ scope: 'threads', rows: [row('s1', true)], degraded: false }])
    expect(calls()).toBe(1)
    subscription.close()
    hub.dispose()
  })

  it('recomputes on the coalescing window and SKIPS the frame when nothing changed (diff-skip)', async () => {
    const { ctx, emit } = fakeCtx()
    const { census, calls } = censusOf({ rows: [row('s1')], degraded: false })
    const hub = createSidechatPushHub(ctx, { threadsCensus: census as never })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const subscription = hub.subscribe({ onFrame: (frame) => { socket.sent.push(JSON.stringify(frame)) } })
    subscription.setWatch([], true, ['root-1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.frames()).toHaveLength(1)

    // A burst of triggers — feeds and a route poke — folds into ONE
    // recomputation at the window, and the identical answer ships NOTHING.
    emit('session/event', { id: 'x' }, { type: 'turn/end' })
    emit('agent/assistant-stream', { agent: { session: { id: 'y' } }, frame: { type: 'chunk' } })
    hub.notifyThreads()
    await vi.advanceTimersByTimeAsync(THREADS_WINDOW_MS + 10)
    expect(calls()).toBe(2)
    expect(socket.frames()).toHaveLength(1)
    subscription.close()
    hub.dispose()
  })

  it('ships the data frame exactly when a row changes, then goes quiet again', async () => {
    const { ctx, emit } = fakeCtx()
    const { census } = censusOf({ rows: [row('s1')], degraded: false })
    const hub = createSidechatPushHub(ctx, { threadsCensus: census as never })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const subscription = hub.subscribe({ onFrame: (frame) => { socket.sent.push(JSON.stringify(frame)) } })
    subscription.setWatch([], true, ['root-1'])
    await vi.advanceTimersByTimeAsync(0)

    census.mockImplementation(async () => ({ rows: [row('s1', true)], degraded: false }))
    emit('session/event', { id: 'x' }, { type: 'turn/end' })
    await vi.advanceTimersByTimeAsync(THREADS_WINDOW_MS + 10)
    expect(socket.frames()).toEqual([
      { scope: 'threads', rows: [row('s1')], degraded: false },
      { scope: 'threads', rows: [row('s1', true)], degraded: false },
    ])

    // The change is consumed: further identical computations ship nothing.
    emit('agent/assistant-stream', { agent: { session: { id: 'x' } }, frame: { type: 'chunk' } })
    await vi.advanceTimersByTimeAsync(THREADS_WINDOW_MS + 10)
    expect(socket.frames()).toHaveLength(2)
    subscription.close()
    hub.dispose()
  })

  it('treats a census throw as a degraded answer and still serializes (reentrancy: one follow-up per dirty burst)', async () => {
    const { ctx, emit } = fakeCtx()
    const error = new Error('catalog exploded')
    const { census, calls } = censusOf(error)
    const hub = createSidechatPushHub(ctx, { threadsCensus: census as never })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const subscription = hub.subscribe({ onFrame: (frame) => { socket.sent.push(JSON.stringify(frame)) } })

    // A slow census: the FIRST call hangs until we resolve it.
    let release!: (value: { rows: unknown[]; degraded: boolean }) => void
    const gate = new Promise<{ rows: unknown[]; degraded: boolean }>(resolve => { release = resolve })
    census.mockImplementationOnce(() => gate)
    subscription.setWatch([], true, ['root-1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(1)

    // Two triggers land MID-COMPUTATION: both only mark dirty — the pump
    // runs exactly ONE follow-up after the first settles.
    emit('session/event', { id: 'x' }, { type: 'turn/end' })
    hub.notifyThreads()
    release({ rows: [], degraded: true })
    await vi.advanceTimersByTimeAsync(THREADS_WINDOW_MS + 10)
    expect(calls()).toBe(2)
    // The error was degraded (logged), the follow-up's result shipped once.
    expect(socket.frames()).toEqual([{ scope: 'threads', rows: [], degraded: true }])
    vi.mocked(census).mockRestore()
    subscription.close()
    hub.dispose()
  })

  it('pushes a fresh snapshot when the rootIds update (same key, new computation input)', async () => {
    const { ctx } = fakeCtx()
    const { census, calls } = censusOf({ rows: [row('s1')], degraded: false })
    const hub = createSidechatPushHub(ctx, { threadsCensus: census as never })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const subscription = hub.subscribe({ onFrame: (frame) => { socket.sent.push(JSON.stringify(frame)) } })
    subscription.setWatch([], true, ['root-1'])
    await vi.advanceTimersByTimeAsync(0)

    // A second root appeared in the client's session list: the census
    // answers with BOTH rows and the update ships them without any window.
    census.mockImplementation(async () => ({ rows: [row('s1'), row('s2')], degraded: false }))
    subscription.setWatch([], true, ['root-1', 'root-2'])
    await vi.advanceTimersByTimeAsync(0)
    expect(calls()).toBe(2)
    expect(census.mock.calls[1]?.[0]).toEqual(['root-1', 'root-2'])
    expect(socket.frames()).toEqual([
      { scope: 'threads', rows: [row('s1')], degraded: false },
      { scope: 'threads', rows: [row('s1'), row('s2')], degraded: false },
    ])
    subscription.close()
    hub.dispose()
  })

  it('falls back to legacy empty frames before the roots are reported, and after a re-watch without them', async () => {
    const { ctx, emit } = fakeCtx()
    const { census, calls } = censusOf({ rows: [row('s1')], degraded: false })
    const hub = createSidechatPushHub(ctx, { threadsCensus: census as never })
    const socket = new FakeSocket()
    hub.attach(socket.asWebSocket())
    const subscription = hub.subscribe({ onFrame: (frame) => { socket.sent.push(JSON.stringify(frame)) } })

    // Threads channel WITHOUT roots: the legacy contract (empty invalidation),
    // and the census is never consulted.
    subscription.setWatch([], true)
    emit('session/event', { id: 'x' }, { type: 'turn/end' })
    await vi.advanceTimersByTimeAsync(THREADS_WINDOW_MS + 10)
    expect(socket.frames()).toEqual([{ scope: 'threads' }])
    expect(calls()).toBe(0)

    // Re-watch WITHOUT the flag: the pending mode dies with the subscription.
    subscription.setWatch([], false)
    emit('session/event', { id: 'x' }, { type: 'turn/end' })
    await vi.advanceTimersByTimeAsync(THREADS_WINDOW_MS + 10)
    expect(socket.frames()).toEqual([{ scope: 'threads' }])
    subscription.close()
    hub.dispose()
  })
})
