/**
 * useSessionPhase (src/client/session-phase.ts) once the session push channel
 * exists: the hook watches the current session and — while that socket is
 * open — suspends the 1s HTTP poll; a phase frame for THIS session settles
 * the state non-blank and ends both the poll and the push; a socket drop
 * falls back to the poll (the route stays the source of truth); an undefined
 * session id reads nothing; an HTTP failure still degrades to non-blank.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { useSessionPhase } from '../src/client/session-phase.ts'

import { sessionPhase } from '../src/client/api.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()

// The hook asks the host route for the phase; without this mock the call
// would leave for a transport no jsdom spec has. Reset per test below.
vi.mock('../src/client/api.ts', () => ({
  sessionPhase: vi.fn(async () => ({ blank: true })),
}))

/** The smallest WebSocket the connector opens: driven, never networking. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readonly url: string
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(frame: string): void { this.sent.push(frame) }
  close(): void { this.closed = true; this.readyState = 3 }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  drop(): void { this.readyState = 3; this.onclose?.() }
  /** One host frame (a phase/cwd notice, or something malformed). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

const sessionPhaseMock = vi.mocked(sessionPhase)

/** How many HTTP phase reads have gone out. */
function reads(): number {
  return sessionPhaseMock.mock.calls.length
}

function Probe(props: { sessionId: string | undefined }): ReactNode {
  const phase = useSessionPhase(props.sessionId)
  return createElement('div', {
    'data-phase': phase === undefined ? 'undefined' : phase.blank ? 'blank' : 'ready',
  })
}

interface Harness {
  /** The rendered phase: `undefined` / `blank` / `ready`. */
  state: () => string | undefined
  /** The first socket the hook's connector opened. */
  socket: () => FakeSocket
  unmount: () => void
}

function mountPhase(sessionId: string | undefined): Harness {
  const view = renderRoot(createElement(Probe, { sessionId }))
  return {
    state: () => view.container.querySelector('[data-phase]')?.getAttribute('data-phase') ?? undefined,
    socket: () => {
      const socket = FakeSocket.instances[0]
      if (socket === undefined) throw new Error('no socket opened')
      return socket
    },
    unmount: view.unmount,
  }
}

/** Flush the in-flight fetch (and its setState) inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
  sessionPhaseMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useSessionPhase', () => {
  it('suspends the 1s poll while the push socket is open, resumes it on a drop', async () => {
    sessionPhaseMock.mockResolvedValue({ blank: true })
    const harness = mountPhase('t1')
    try {
      await settle()
      expect(harness.state()).toBe('blank')
      expect(reads()).toBe(1)
      expect(harness.socket().url).toContain('/sidebar/ws/session')

      // Socket open: the interval runs but every tick defers to the push.
      harness.socket().open()
      await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
      expect(reads()).toBe(1)

      // Socket lost: the poll is the fallback and picks up where it was.
      harness.socket().drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(reads()).toBe(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(reads()).toBe(3)
    } finally {
      harness.unmount()
    }
  })

  it('settles non-blank on this session\'s phase frame and stops polling and pushing', async () => {
    sessionPhaseMock.mockResolvedValue({ blank: true })
    const harness = mountPhase('t1')
    try {
      await settle()
      expect(harness.state()).toBe('blank')

      const socket = harness.socket()
      socket.open()
      // Another session's flip, a cwd notice, a malformed frame: not ours.
      act(() => {
        socket.frame({ kind: 'phase', sessionId: 't9', blank: false })
        socket.frame({ kind: 'cwd', sessionId: 't1' })
        socket.frame({ nope: 1 })
      })
      expect(harness.state()).toBe('blank')
      expect(socket.closed).toBe(false)

      act(() => { socket.frame({ kind: 'phase', sessionId: 't1', blank: false }) })
      expect(harness.state()).toBe('ready')
      // Done: no more reads, the push socket is closed.
      expect(socket.closed).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(reads()).toBe(1)
    } finally {
      harness.unmount()
    }
  })

  it('reads nothing and opens no socket without a session id', async () => {
    const harness = mountPhase(undefined)
    try {
      await settle()
      expect(harness.state()).toBe('undefined')
      expect(FakeSocket.instances).toHaveLength(0)
      expect(reads()).toBe(0)
    } finally {
      harness.unmount()
    }
  })

  it('degrades to non-blank when the HTTP route fails', async () => {
    sessionPhaseMock.mockRejectedValue(new Error('route gone'))
    const harness = mountPhase('t1')
    try {
      await settle()
      expect(harness.state()).toBe('ready')
      // Degraded is terminal too: no more reads, the push socket is closed.
      expect(harness.socket().closed).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(reads()).toBe(1)
    } finally {
      harness.unmount()
    }
  })
})
