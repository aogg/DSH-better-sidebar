/**
 * The shared session-turn subscription (src/client/turn-push.ts): the whole
 * point is ONE `connectSessionPush` connection per SESSION no matter how many
 * editor tabs subscribe — the native right sidebar keeps every visited tab
 * body mounted, so per-tab sockets would multiply with the open tabs. The
 * hub-under-test is the real module with `connectSessionPush` mocked out: the
 * tests drive the captured `onFrame` and count connections, proving the
 * reference counting (N subscribers → 1 connection → close on the last
 * unsubscribe), the frame filter (only `turn` frames of THAT session reach a
 * callback — phase/cwd/history on the same wire stay invisible) and that a
 * fresh subscription after the last one left opens a NEW connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The connections `connectSessionPush` was asked to open, in order. */
interface CapturedConnection {
  sessionIds: readonly string[]
  onFrame: (frame: unknown) => void
  /** The disposer the fake returned (a spy: "did the hub close it?"). */
  dispose: ReturnType<typeof vi.fn>
}

const connections: CapturedConnection[] = []

vi.mock('../src/client/session-push.ts', () => ({
  connectSessionPush: (sessionIds: readonly string[], onFrame: (frame: unknown) => void): (() => void) => {
    const dispose = vi.fn()
    connections.push({ sessionIds, onFrame, dispose })
    return dispose
  },
}))

import { subscribeSessionTurns } from '../src/client/turn-push.ts'

/** The (only) connection open for a session, or undefined. */
function connectionOf(sessionId: string): CapturedConnection | undefined {
  return connections.find(connection => connection.sessionIds.includes(sessionId))
}

beforeEach(() => {
  connections.length = 0
})

describe('subscribeSessionTurns', () => {
  it('N subscribers of one session share exactly ONE connection', () => {
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    const disposeA = subscribeSessionTurns('s1', first)
    const disposeB = subscribeSessionTurns('s1', second)
    const disposeC = subscribeSessionTurns('s1', third)

    expect(connections).toHaveLength(1)
    expect(connections[0]!.sessionIds).toEqual(['s1'])

    // Every subscriber hears the same frame exactly once.
    connectionOf('s1')!.onFrame({ kind: 'turn', sessionId: 's1' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(third).toHaveBeenCalledTimes(1)

    // Leaving one by one keeps the connection up for the rest…
    disposeA()
    disposeB()
    expect(connections).toHaveLength(1)
    expect(connectionOf('s1')!.dispose).not.toHaveBeenCalled()
    connectionOf('s1')!.onFrame({ kind: 'turn', sessionId: 's1' })
    expect(third).toHaveBeenCalledTimes(2)
    expect(first).toHaveBeenCalledTimes(1)

    // …and the LAST unsubscribe closes it.
    disposeC()
    expect(connectionOf('s1')!.dispose).toHaveBeenCalledTimes(1)
  })

  it('the disposer is idempotent and a late second call closes nothing again', () => {
    const disposeA = subscribeSessionTurns('s1', () => {})
    const disposeB = subscribeSessionTurns('s1', () => {})
    disposeA()
    disposeB()
    // Both already ran; a repeat must not throw nor touch a closed hub.
    expect(() => { disposeA() }).not.toThrow()
    expect(() => { disposeB() }).not.toThrow()
    expect(connectionOf('s1')!.dispose).toHaveBeenCalledTimes(1)
  })

  it('a fresh subscription after the last one left opens a NEW connection', () => {
    const disposeA = subscribeSessionTurns('s1', () => {})
    disposeA()
    expect(connectionOf('s1')!.dispose).toHaveBeenCalledTimes(1)

    const listener = vi.fn()
    subscribeSessionTurns('s1', listener)
    expect(connections).toHaveLength(2)
    connectionOf('s1')!.onFrame({ kind: 'turn', sessionId: 's1' })
    expect(listener).toHaveBeenCalledTimes(1)
    // The closed first connection stays closed: its subscribers are gone.
    connections[0]!.onFrame({ kind: 'turn', sessionId: 's1' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('another session gets its own connection and hears only its own frames', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeSessionTurns('s1', a)
    subscribeSessionTurns('s2', b)

    expect(connections).toHaveLength(2)
    connectionOf('s1')!.onFrame({ kind: 'turn', sessionId: 's2' })
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    connectionOf('s2')!.onFrame({ kind: 'turn', sessionId: 's2' })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('only `turn` frames of the watched session are distributed', () => {
    const listener = vi.fn()
    subscribeSessionTurns('s1', listener)
    const { onFrame } = connectionOf('s1')!

    // The wire also carries the hooks' kinds — none of them is a turn.
    onFrame({ kind: 'phase', sessionId: 's1', blank: false })
    onFrame({ kind: 'cwd', sessionId: 's1', cwd: '/w', root: '/w', parent: null })
    onFrame({ kind: 'history', sessionId: 's1', records: [] })
    onFrame({ kind: 'history-seed', cwd: '/w', seeding: false })
    // …and a turn frame of ANOTHER session riding a shared wire shape.
    onFrame({ kind: 'turn', sessionId: 'other' })
    expect(listener).not.toHaveBeenCalled()

    onFrame({ kind: 'turn', sessionId: 's1' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a throwing subscriber is contained and does not starve the others', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const bad = vi.fn(() => { throw new Error('boom') })
      const good = vi.fn()
      subscribeSessionTurns('s1', bad)
      subscribeSessionTurns('s1', good)

      // Contained (the store's notify() convention): the frame fan-out
      // survives the bad subscriber and the rest still hear the turn.
      expect(() => connectionOf('s1')!.onFrame({ kind: 'turn', sessionId: 's1' })).not.toThrow()
      expect(bad).toHaveBeenCalledTimes(1)
      expect(good).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
