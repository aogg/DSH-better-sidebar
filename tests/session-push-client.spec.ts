/**
 * The client end of the session push channel (`connectSessionPush`,
 * src/client/session-push.ts): one socket under `/sidebar/ws/session` whose
 * full `watch` frame is (re-)sent on EVERY open — the first one and the one
 * after a reconnect alike — whose malformed / unknown-kind / foreign-session
 * frames never reach `onFrame`, whose answer-carrying cwd frames reach
 * `onFrame` with their answer fields intact, whose phase frames pass through
 * with their blank answer intact (`blank:true` = watch-time "still waiting",
 * `blank:false` = the flip), whose open/close transitions reach the optional
 * `onState` signal (each hook suspends its poll on it), and whose reconnects
 * back off 1s → 15s until disposed (then nothing re-opens).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSessionPush, type SessionPushFrame } from '../src/client/session-push.ts'

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
  /** One host frame (a validated notice, or something malformed). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** One non-JSON or non-string message. */
  raw(data: unknown): void { this.onmessage?.({ data }) }
  /** The frames the connector sent, as parsed objects. */
  frames(): { op: string; sessionIds: string[] }[] {
    return this.sent.map(frame => JSON.parse(frame) as { op: string; sessionIds: string[] })
  }
}

/** The latest socket the connector opened (or one of the earlier ones). */
function socketAt(index: number): FakeSocket {
  const socket = FakeSocket.instances[index]
  if (socket === undefined) throw new Error(`no socket at ${index}`)
  return socket
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('connectSessionPush', () => {
  it('opens the session socket and announces the watch set once it opens', () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    try {
      const socket = socketAt(0)
      expect(socket.url).toContain('/sidebar/ws/session')
      // Nothing is sent before the connection opens.
      expect(socket.sent).toEqual([])
      socket.open()
      expect(socket.frames()).toEqual([{ op: 'watch', sessionIds: ['t1'] }])
    } finally {
      dispose()
    }
  })

  it('re-announces the watch on the socket a reconnect opened', async () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    try {
      socketAt(0).open()
      socketAt(0).drop()
      // The first retry waits 1s.
      await vi.advanceTimersByTimeAsync(999)
      expect(FakeSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(2)
      expect(socketAt(1).sent).toEqual([])
      socketAt(1).open()
      // The whole watch set rides every open, including after a reconnect.
      expect(socketAt(1).frames()).toEqual([{ op: 'watch', sessionIds: ['t1'] }])
    } finally {
      dispose()
    }
  })

  it('backs retries off 1s → 2s → 4s → 8s and caps at 15s', async () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    try {
      // Five consecutive failures without a successful open in between: the
      // delays double (1s, 2s, 4s, 8s) until the 15s cap swallows the 16s.
      socketAt(0).drop()
      await vi.advanceTimersByTimeAsync(999)
      expect(FakeSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(2)

      socketAt(1).drop()
      await vi.advanceTimersByTimeAsync(1999)
      expect(FakeSocket.instances).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(3)

      socketAt(2).drop()
      await vi.advanceTimersByTimeAsync(3999)
      expect(FakeSocket.instances).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(4)

      socketAt(3).drop()
      await vi.advanceTimersByTimeAsync(7999)
      expect(FakeSocket.instances).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(5)

      socketAt(4).drop()
      await vi.advanceTimersByTimeAsync(14_999)
      expect(FakeSocket.instances).toHaveLength(5)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(6)
    } finally {
      dispose()
    }
  })

  it('routes only valid frames to onFrame; session ownership is the hook\'s filter', () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    try {
      const socket = socketAt(0)
      socket.open()
      // An unknown kind, a frame with no kind, a foreign session id type,
      // malformed JSON, a non-string message: late/dirty notices, not
      // invalidations.
      socket.frame({ kind: 'nope', sessionId: 't1' })
      socket.frame({ nope: 1 })
      socket.frame({ kind: 'phase', sessionId: 42 })
      socket.raw('not json')
      socket.raw(42)
      expect(onFrame).not.toHaveBeenCalled()

      // The connector validates SHAPE only (known kind + string sessionId):
      // which session is "mine" is decided by the hook that mounted it
      // (session-phase.ts / use-session-root.ts compare frame.sessionId).
      const phase: SessionPushFrame = { kind: 'phase', sessionId: 't1', blank: false }
      socket.frame(phase)
      socket.frame({ kind: 'cwd', sessionId: 't1' })
      socket.frame({ kind: 'cwd', sessionId: 't9' })
      expect(onFrame).toHaveBeenCalledTimes(3)
      expect(onFrame).toHaveBeenNthCalledWith(1, phase)
      expect(onFrame).toHaveBeenNthCalledWith(2, { kind: 'cwd', sessionId: 't1' })
      expect(onFrame).toHaveBeenNthCalledWith(3, { kind: 'cwd', sessionId: 't9' })
    } finally {
      dispose()
    }
  })

  it('passes an answer-carrying cwd frame through with its answer fields intact', () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    try {
      const socket = socketAt(0)
      socket.open()
      // The answer rides the frame verbatim: which session is "mine" and how
      // to land the answer stay the hook's business.
      const answered: SessionPushFrame = { kind: 'cwd', sessionId: 't1', cwd: '/wt', root: 'wt', parent: null }
      socket.frame(answered)
      expect(onFrame).toHaveBeenCalledTimes(1)
      expect(onFrame).toHaveBeenCalledWith(answered)
    } finally {
      dispose()
    }
  })

  it('passes phase frames through with their blank answer intact (true and false)', () => {
    const onFrame = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame)
    try {
      const socket = socketAt(0)
      socket.open()
      // A watch-time "still waiting" answer and the one-shot flip both ride
      // the same validation: shape only, semantics stay the hook's business.
      socket.frame({ kind: 'phase', sessionId: 't1', blank: true })
      socket.frame({ kind: 'phase', sessionId: 't1', blank: false })
      expect(onFrame).toHaveBeenCalledTimes(2)
      expect(onFrame).toHaveBeenNthCalledWith(1, { kind: 'phase', sessionId: 't1', blank: true })
      expect(onFrame).toHaveBeenNthCalledWith(2, { kind: 'phase', sessionId: 't1', blank: false })
    } finally {
      dispose()
    }
  })

  it('flips the state signal on open/close and goes quiet after dispose', async () => {
    const onFrame = vi.fn()
    const onState = vi.fn()
    const dispose = connectSessionPush(['t1'], onFrame, onState)
    expect(onState).not.toHaveBeenCalled()
    socketAt(0).open()
    expect(onState).toHaveBeenCalledTimes(1)
    expect(onState).toHaveBeenLastCalledWith(true)

    socketAt(0).drop()
    expect(onState).toHaveBeenCalledTimes(2)
    expect(onState).toHaveBeenLastCalledWith(false)

    // Dispose stops the retry loop: the pending reconnect timer is gone, and
    // a late close of the disposed socket re-opens nothing.
    dispose()
    expect(socketAt(0).closed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(onState).toHaveBeenCalledTimes(2)
  })
})
