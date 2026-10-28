/**
 * useSessionPhase (src/client/session-phase.ts) — 纯 ws 驱动：挂载打开
 * /sidebar/ws/session 并发出**零** HTTP 读取；相位答案完全由推送帧送达 ——
 * `blank: true` 继续等待，`blank: false`（或旧宿主缺省 blank 字段的帧）落定为
 * 非 blank 并收尾（关推送）。断线/连不上时绝不发 HTTP 轮询：只有重连退避
 * （1s→15s）在开新 socket，任意等待时长后 `session.phase` 调用数仍为 0，相位
 * 恒为 undefined（调用方按非 blank 对待）。undefined 会话 id 不读、不开 socket。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { useSessionPhase } from '../src/client/session-phase.ts'

import { sessionPhase } from '../src/client/api.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()

// The hook must never touch the HTTP route. The mock keeps the module
// importable and its call log readable, so "zero HTTP" is a positive
// assertion across ANY wait length.
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

/** How many HTTP phase reads have gone out (must stay 0 forever). */
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

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
  sessionPhaseMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useSessionPhase', () => {
  it('mounts with ZERO HTTP reads and opens the push socket', async () => {
    const harness = mountPhase('t1')
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(harness.state()).toBe('undefined')
      expect(reads()).toBe(0)
      expect(harness.socket().url).toContain('/sidebar/ws/feed')
    } finally {
      harness.unmount()
    }
  })

  it('keeps waiting on a blank:true frame — and no wait length produces an HTTP read', async () => {
    const harness = mountPhase('t1')
    try {
      const socket = harness.socket()
      socket.open()
      // Another session's flip, a cwd notice, a malformed frame: not ours.
      act(() => {
        socket.frame({ channel: 'session', sessionId: 't9', data: { kind: 'phase', sessionId: 't9', blank: true } })
        socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'cwd', sessionId: 't1', cwd: '/wt' } })
        socket.frame({ nope: 1 })
      })
      expect(harness.state()).toBe('undefined')

      act(() => { socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'phase', sessionId: 't1', blank: true } }) })
      expect(harness.state()).toBe('blank')

      // The old fallback poll ticked every 1s; now NOTHING fires over any
      // span — the answer can only arrive as a frame.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(reads()).toBe(0)
      expect(harness.state()).toBe('blank')
      expect(socket.closed).toBe(false)
    } finally {
      harness.unmount()
    }
  })

  it('settles non-blank on a blank:false frame and closes the push', async () => {
    const harness = mountPhase('t1')
    try {
      const socket = harness.socket()
      socket.open()
      act(() => { socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'phase', sessionId: 't1', blank: true } }) })
      expect(harness.state()).toBe('blank')

      act(() => { socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'phase', sessionId: 't1', blank: false } }) })
      expect(harness.state()).toBe('ready')
      // Done: no more reads (there never were any), the push socket is closed.
      expect(socket.closed).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(reads()).toBe(0)
    } finally {
      harness.unmount()
    }
  })

  it('treats a legacy frame with no blank field as the flip (old hosts push it only)', async () => {
    const harness = mountPhase('t1')
    try {
      const socket = harness.socket()
      socket.open()
      act(() => { socket.frame({ channel: 'session', sessionId: 't1', data: { kind: 'phase', sessionId: 't1' } }) })
      expect(harness.state()).toBe('ready')
      expect(socket.closed).toBe(true)
      expect(reads()).toBe(0)
    } finally {
      harness.unmount()
    }
  })

  it('answers a dead socket with reconnects only — the phase stays undefined, zero HTTP', async () => {
    const harness = mountPhase('t1')
    try {
      // Persistent connect failures: every retried socket dies too, and the
      // connector answers each drop with another backoff timer (1s → 2s →
      // 4s → 8s …) — never an HTTP read. The phase stays undefined; the
      // caller treats that as non-blank.
      harness.socket().drop()
      // Each step doubles (1s → 2s → 4s → 8s) with ±30% jitter on top: the
      // advances cross the WIDEST possible step, so the count is exact
      // without pinning the jittered delay.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_300) })
      FakeSocket.instances[1]?.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_600) })
      FakeSocket.instances[2]?.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(5_200) })
      FakeSocket.instances[3]?.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(10_400) })
      expect(FakeSocket.instances).toHaveLength(5)
      expect(reads()).toBe(0)
      expect(harness.state()).toBe('undefined')
    } finally {
      harness.unmount()
    }
  })

  it('reads nothing and opens no socket without a session id', async () => {
    const harness = mountPhase(undefined)
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(harness.state()).toBe('undefined')
      expect(FakeSocket.instances).toHaveLength(0)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(reads()).toBe(0)
    } finally {
      harness.unmount()
    }
  })

  it('stops the reconnect loop once unmounted', async () => {
    const harness = mountPhase('t1')
    harness.socket().drop()
    harness.unmount()
    const count = FakeSocket.instances.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(FakeSocket.instances).toHaveLength(count)
    expect(reads()).toBe(0)
  })
})
