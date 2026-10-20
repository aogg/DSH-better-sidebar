/**
 * useSessionRoot (src/client/use-session-root.ts) on a pure-WebSocket diet:
 * the session push channel is the ONLY data channel. A cwd frame that CARRIES
 * the answer lands directly (identical answers fold — no re-render); a BARE
 * cwd frame (older host / failed host-side resolution) is IGNORED — the next
 * tool/call burst re-pushes over the same socket; foreign-session and phase
 * frames are never ours. The hook therefore fires ZERO HTTP requests for its
 * whole life: no mount-time fetch, no focus/refresh-files listeners, no
 * timer — any amount of elapsed time produces no `api.sessionCwd` call.
 * Before the first answer frame arrives, the list's summary cwd renders; a
 * dropped socket only re-connects (the connector's 1s → 15s backoff) and
 * never degrades to HTTP.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { useSessionRoot } from '../src/client/use-session-root.ts'

import { api } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()

// The hook must never touch the HTTP route. The mock keeps the module
// importable and its call log readable, so "zero HTTP" is a positive
// assertion, not just the absence of a transport.
vi.mock('../src/client/api.ts', () => ({
  api: {
    sessionCwd: vi.fn(async (scope: { sessionId: string }) => ({
      sessionId: scope.sessionId,
      cwd: '/work-a',
      root: '/work-a',
      parent: null,
    })),
  },
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
  /** The frames the connector sent, as parsed objects. */
  frames(): { op: string; sessionIds: string[] }[] {
    return this.sent.map(frame => JSON.parse(frame) as { op: string; sessionIds: string[] })
  }
}

const sessionCwdMock = vi.mocked(api.sessionCwd)

/** The minimal client ctx: the sessions list feed `useSessionRoot` consults.
 *  ONE stable snapshot — a fresh object per getSnapshot() is an infinite-loop
 *  warn under useSyncExternalStore. */
function createCtx(): Context {
  const snapshot = {
    byId: {
      s1: { id: 's1', cwd: '/summary-a' },
      s2: { id: 's2', cwd: '/summary-b' },
    },
  }
  return { sessions: { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } } } as unknown as Context
}

interface Harness {
  /** The rendered root (the pushed answer, or the list summary fallback). */
  root: () => string | undefined
  /** How many times the probe COMMITTED (a folded same-value frame commits none). */
  commits: () => number
  /** The first socket the hook's connector opened. */
  socket: () => FakeSocket
  unmount: () => void
}

function mountRoot(sessionId: string, ctx: Context = createCtx()): Harness {
  const commits = { count: 0 }
  function Probe(): ReactNode {
    const root = useSessionRoot(ctx, sessionId)
    // Runs after every commit — the render count that matters.
    useEffect(() => { commits.count += 1 })
    return createElement('div', { 'data-root': root ?? 'none' })
  }
  const view = renderRoot(createElement(Probe, null))
  return {
    root: () => view.container.querySelector('[data-root]')?.getAttribute('data-root') ?? undefined,
    commits: () => commits.count,
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
  sessionCwdMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useSessionRoot', () => {
  it('renders the list summary cwd until a frame arrives, with ZERO HTTP', async () => {
    const harness = mountRoot('s1')
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      // First paint uses the session list header cwd — no mount-time fetch.
      expect(harness.root()).toBe('/summary-a')
      expect(sessionCwdMock).not.toHaveBeenCalled()
      // And the watch set is announced on the session socket.
      expect(harness.socket().url).toContain('/sidebar/ws/session')
      harness.socket().open()
      expect(harness.socket().frames()).toEqual([{ op: 'watch', sessionIds: ['s1'] }])
    } finally {
      harness.unmount()
    }
  })

  it('lands a cwd frame that CARRIES the answer, folding identical answers', async () => {
    const harness = mountRoot('s1')
    try {
      harness.socket().open()
      act(() => {
        harness.socket().frame({ kind: 'cwd', sessionId: 's1', cwd: '/wt-pushed', root: 'pushed', parent: null })
      })
      // The answer is in the frame: it lands directly, no HTTP round trip.
      expect(harness.root()).toBe('/wt-pushed')
      expect(sessionCwdMock).not.toHaveBeenCalled()

      // A repeated identical answer folds: no re-render.
      const commitsBefore = harness.commits()
      act(() => {
        harness.socket().frame({ kind: 'cwd', sessionId: 's1', cwd: '/wt-pushed', root: 'pushed', parent: null })
      })
      expect(harness.commits()).toBe(commitsBefore)

      // A real move lands with one commit.
      act(() => {
        harness.socket().frame({ kind: 'cwd', sessionId: 's1', cwd: '/wt-moved', root: 'moved', parent: 'pushed' })
      })
      expect(harness.root()).toBe('/wt-moved')
      expect(harness.commits()).toBe(commitsBefore + 1)
    } finally {
      harness.unmount()
    }
  })

  it('ignores a BARE cwd frame and every frame that is not ours', async () => {
    const harness = mountRoot('s1')
    try {
      harness.socket().open()
      act(() => {
        // The bare invalidation (older host / failed host resolution), the
        // empty-string answer, another session's answer and move, a phase
        // notice, and a malformed frame: none may touch the rendered root.
        harness.socket().frame({ kind: 'cwd', sessionId: 's1' })
        harness.socket().frame({ kind: 'cwd', sessionId: 's1', cwd: '' })
        harness.socket().frame({ kind: 'cwd', sessionId: 's2', cwd: '/elsewhere' })
        harness.socket().frame({ kind: 'cwd', sessionId: 's2' })
        harness.socket().frame({ kind: 'phase', sessionId: 's1', blank: false })
        harness.socket().frame({ nope: 1 })
      })
      expect(harness.root()).toBe('/summary-a')
      // Zero HTTP either way: the host re-pushes on the next tool/call burst.
      expect(sessionCwdMock).not.toHaveBeenCalled()

      // And a later answer frame for our session still lands after the noise.
      act(() => {
        harness.socket().frame({ kind: 'cwd', sessionId: 's1', cwd: '/wt-late' })
      })
      expect(harness.root()).toBe('/wt-late')
    } finally {
      harness.unmount()
    }
  })

  it('answers a dropped socket with reconnects only — no HTTP ask ever fires', async () => {
    const harness = mountRoot('s1')
    try {
      harness.socket().open()
      harness.socket().drop()
      // Persistent connect failures: every retried socket dies too, and the
      // connector answers each drop with another backoff timer (1s → 2s →
      // 4s → 8s …) — not one HTTP ask goes out.
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      FakeSocket.instances[1]?.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      FakeSocket.instances[2]?.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
      FakeSocket.instances[3]?.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
      expect(FakeSocket.instances).toHaveLength(5)
      expect(sessionCwdMock).not.toHaveBeenCalled()
      // A socket that finally opens re-announces the watch set.
      const latest = FakeSocket.instances[4]
      if (latest === undefined) throw new Error('no fifth socket')
      latest.open()
      expect(latest.frames()).toEqual([{ op: 'watch', sessionIds: ['s1'] }])
    } finally {
      harness.unmount()
    }
  })

  it('stops reconnecting once unmounted', async () => {
    const harness = mountRoot('s1')
    harness.socket().drop()
    harness.unmount()
    const count = FakeSocket.instances.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(FakeSocket.instances).toHaveLength(count)
  })
})
