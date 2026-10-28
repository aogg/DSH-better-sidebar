/**
 * The client end of the session push channel (`connectSessionPush`,
 * src/client/session-push.ts), riding the ONE multiplexed feed socket
 * (`/sidebar/ws/feed`, channel `'session'` — feed-hub.ts): every watched
 * session is one reference-counted `sub` on the shared socket, announced on
 * EVERY open (the first and the one after a reconnect alike — the replay is
 * what re-seeds the host's watch answers); a wrapped `{channel, sessionId,
 * data}` frame reaches `onFrame` with its payload intact when the session
 * matches, while malformed / unknown-kind payloads never do; the
 * project-scoped `history-seed` frames (no sessionId on the wire) fan out to
 * the channel's subscribers; the open/close transitions reach the optional
 * `onState` signal (observability only — the session hooks stay connected
 * either way); reconnects back off 1s → 15s until disposed (then nothing
 * re-opens); and TWO callers watching the SAME session share ONE
 * subscription (the multiplexer's whole point).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSessionPush, openSessionPush } from '../src/client/session-push.ts'

/** The smallest WebSocket the connector talks to: `send` records the frames. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readonly url: string
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(frame: string): void { this.sent.push(frame) }
  close(): void { this.closed = true; this.readyState = 3 }
  /** The host's connection acknowledgement. */
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  /** The socket drops (a failed connect looks the same to the connector). */
  drop(): void { this.readyState = 3; this.onclose?.() }
  /** One host envelope (a data frame, or something malformed). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** One non-JSON or non-string message. */
  raw(data: unknown): void { this.onmessage?.({ data }) }
  /** The frames the connector sent, as parsed objects. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
  }
}

/** The latest socket the connector opened (or one of the earlier ones). */
function socketAt(index: number): FakeSocket {
  const socket = FakeSocket.instances[index]
  if (socket === undefined) throw new Error(`no socket at ${index}`)
  return socket
}

/** Every subscription a test opened, undone after the test whatever happens. */
const disposers: Array<() => void> = []

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('connectSessionPush (the multiplexed feed)', () => {
  it('opens the FEED socket and subscribes the watched session once it opens', () => {
    const onFrame = vi.fn()
    disposers.push(connectSessionPush(['t1'], onFrame))
    const socket = socketAt(0)
    expect(socket.url).toContain('/sidebar/ws/feed')
    expect(socket.url).not.toContain('sessionId=')
    // Nothing is sent before the connection opens.
    expect(socket.sent).toEqual([])
    socket.open()
    expect(socket.frames()).toEqual([{ op: 'sub', channel: 'session', sessionId: 't1' }])
  })

  it('re-announces the subscription on the socket a reconnect opened', async () => {
    const onFrame = vi.fn()
    disposers.push(connectSessionPush(['t1'], onFrame))
    socketAt(0).open()
    socketAt(0).drop()
    // The first retry waits 1s (±30% jitter: below 700ms nothing, past
    // 1300ms the reconnect must have fired).
    await vi.advanceTimersByTimeAsync(699)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(601)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(socketAt(1).sent).toEqual([])
    socketAt(1).open()
    // The whole watch set rides every open, including after a reconnect —
    // the replay is what re-seeds the host's phase/cwd answers.
    expect(socketAt(1).frames()).toEqual([{ op: 'sub', channel: 'session', sessionId: 't1' }])
  })

  it('lands a matching wrapped frame with its payload intact and drops the rest', () => {
    const onFrame = vi.fn()
    disposers.push(connectSessionPush(['t1'], onFrame))
    const socket = socketAt(0)
    socket.open()
    // The answer-carrying cwd frame, wrapped in the feed envelope.
    socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'cwd', sessionId: 't1', cwd: '/w' } })
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame).toHaveBeenCalledWith({ kind: 'cwd', sessionId: 't1', cwd: '/w' })
    // The phase flip passes through with its blank answer intact.
    socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'phase', sessionId: 't1', blank: false } })
    expect(onFrame).toHaveBeenLastCalledWith({ kind: 'phase', sessionId: 't1', blank: false })
    // The history frame passes through with its records payload intact.
    const records = [{ key: 'k' }]
    socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'history', sessionId: 't1', records } })
    expect(onFrame).toHaveBeenLastCalledWith({ kind: 'history', sessionId: 't1', records })
    // A foreign session's frame never reaches this subscriber (the hub
    // routes by sessionId).
    socket.frame({ channel: 'session', sessionId: 't2', data: { kind: 'turn', sessionId: 't2' } })
    // An unknown-kind payload is dropped (the union filter).
    socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'wat', sessionId: 't1' } })
    // A payload missing its session id is dropped.
    socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'turn' } })
    // A malformed envelope and a non-JSON message are ignored outright.
    socket.frame({ nope: 1 })
    expect(() => socket.raw('not json')).not.toThrow()
    expect(onFrame).toHaveBeenCalledTimes(3)
  })

  it('delivers the project-scoped history-seed frame (no sessionId on the wire)', () => {
    const onFrame = vi.fn()
    disposers.push(connectSessionPush(['t1'], onFrame))
    const socket = socketAt(0)
    socket.open()
    socket.frame({ channel: 'session', data: { kind: 'history-seed', cwd: '/work/alpha', seeding: true } })
    socket.frame({ channel: 'session', data: { kind: 'history-seed', cwd: '/work/alpha', seeding: false } })
    // A seed frame without a cwd is malformed: dropped.
    socket.frame({ channel: 'session', data: { kind: 'history-seed', seeding: true } })
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(onFrame).toHaveBeenNthCalledWith(1, { kind: 'history-seed', cwd: '/work/alpha', seeding: true })
    expect(onFrame).toHaveBeenNthCalledWith(2, { kind: 'history-seed', cwd: '/work/alpha', seeding: false })
  })

  it('signals open/close through onState', () => {
    const onFrame = vi.fn()
    const onState = vi.fn()
    disposers.push(connectSessionPush(['t1'], onFrame, onState))
    expect(onState).not.toHaveBeenCalled()
    socketAt(0).open()
    expect(onState).toHaveBeenNthCalledWith(1, true)
    socketAt(0).drop()
    expect(onState).toHaveBeenNthCalledWith(2, false)
  })

  it('shares ONE subscription when two callers watch the same session', () => {
    const first = vi.fn()
    const second = vi.fn()
    disposers.push(connectSessionPush(['t1'], first))
    socketAt(0).open()
    disposers.push(connectSessionPush(['t1'], second))
    // Same key: no extra wire frame, still one socket.
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socketAt(0).frames()).toEqual([{ op: 'sub', channel: 'session', sessionId: 't1' }])
    // One frame fans out to both.
    socketAt(0).frame({ channel: 'session', sessionId: 't1', data: { kind: 'ops', sessionId: 't1', seq: 3 } })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('distinct sessions share the same socket but not the frames', () => {
    const t1 = vi.fn()
    const t2 = vi.fn()
    disposers.push(connectSessionPush(['t1'], t1))
    socketAt(0).open()
    disposers.push(connectSessionPush(['t2'], t2))
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'sub', channel: 'session', sessionId: 't2' })
    socketAt(0).frame({ channel: 'session', sessionId: 't2', data: { kind: 'turn', sessionId: 't2' } })
    expect(t1).not.toHaveBeenCalled()
    expect(t2).toHaveBeenCalledWith({ kind: 'turn', sessionId: 't2' })
  })

  it('unsubscribes on dispose and closes the socket with the last caller', () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    disposers.push(dispose)
    socketAt(0).open()
    // A second caller keeps the socket alive through the first's dispose.
    const keep = connectSessionPush(['t2'], vi.fn())
    disposers.push(keep)
    dispose()
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'unsub', channel: 'session', sessionId: 't1' })
    expect(socketAt(0).closed).toBe(false)
    keep()
    expect(socketAt(0).closed).toBe(true)
    // Disposing twice is harmless.
    expect(() => dispose()).not.toThrow()
    disposers.length = 0
  })

  it('a getter-based watch set re-syncs on reconcile (the ops hub’s union)', () => {
    const onFrame = vi.fn()
    const ids = ['t1']
    const connection = openSessionPush(() => [...ids], onFrame)
    disposers.push(connection.close)
    socketAt(0).open()
    ids.push('t2')
    connection.reconcile()
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'sub', channel: 'session', sessionId: 't2' })
    ids.shift()
    connection.reconcile()
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'unsub', channel: 'session', sessionId: 't1' })
  })

  it('backs retries off and stops entirely once disposed', async () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    // Five consecutive failures without a successful open in between: the
    // delays double (1s, 2s, 4s, 8s) until the 15s cap swallows the 16s
    // (each jittered step is crossed by a generous 20s advance).
    for (const expected of [2, 3, 4, 5]) {
      socketAt(FakeSocket.instances.length - 1).drop()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(FakeSocket.instances).toHaveLength(expected)
    }
    // Dispose stops the retry loop: the pending reconnect timer is gone, and
    // a late close of the disposed socket re-opens nothing.
    dispose()
    socketAt(4).drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(5)
  })
})
