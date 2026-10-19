/**
 * useSessionRoot (src/client/use-session-root.ts) with the session push
 * channel in place: a cwd frame for THIS session re-asks immediately WITH
 * `fresh` (the host must skip its 3s TTL cache), while every pre-existing
 * path — the initial read, window focus, the refresh-files event and the 5s
 * timer — stays non-fresh; a hidden document skips the ask entirely; and a
 * fresh answer that repeats the old cwd still folds (no re-render).
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

// The host's answer: always the CURRENT cwd (tests mutate `currentCwd`), so
// the same-value fold and a real change are both drivable.
let currentCwd = '/work-a'
vi.mock('../src/client/api.ts', () => ({
  api: {
    sessionCwd: vi.fn(async (scope: { sessionId: string }) => ({
      sessionId: scope.sessionId,
      cwd: currentCwd,
      root: currentCwd,
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
  /** The rendered root (the fetched one, or the list summary fallback). */
  root: () => string | undefined
  /** How many times the probe COMMITTED (a folded same-value ask commits none). */
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

/** Flush the in-flight fetch (and its setState) inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Override the document's visibility (the hook skips asks while hidden). */
async function withVisibility(hidden: boolean, body: () => Promise<void>): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true })
  try {
    await body()
  } finally {
    delete (document as { visibilityState?: string }).visibilityState
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
  currentCwd = '/work-a'
  sessionCwdMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('useSessionRoot', () => {
  it('re-asks with fresh on this session\'s cwd frame, not on other frames', async () => {
    const harness = mountRoot('s1')
    try {
      await settle()
      expect(harness.root()).toBe('/work-a')
      expect(sessionCwdMock).toHaveBeenCalledTimes(1)

      const socket = harness.socket()
      socket.open()
      act(() => {
        // Another session's move and a phase notice: neither is ours to ask.
        socket.frame({ kind: 'cwd', sessionId: 's2' })
        socket.frame({ kind: 'phase', sessionId: 's1', blank: false })
      })
      expect(sessionCwdMock).toHaveBeenCalledTimes(1)

      act(() => { socket.frame({ kind: 'cwd', sessionId: 's1' }) })
      expect(sessionCwdMock).toHaveBeenCalledTimes(2)
      // The push is the explicit "it moved" signal: the host must skip its
      // TTL cache, so the re-ask carries { fresh: true }.
      expect(sessionCwdMock).toHaveBeenLastCalledWith({ sessionId: 's1' }, { fresh: true })
    } finally {
      harness.unmount()
    }
  })

  it('keeps focus, refresh-files and the 5s timer non-fresh', async () => {
    const harness = mountRoot('s1')
    try {
      await settle()
      expect(sessionCwdMock).toHaveBeenCalledTimes(1)

      act(() => { window.dispatchEvent(new Event('focus')) })
      await settle()
      expect(sessionCwdMock).toHaveBeenCalledTimes(2)

      act(() => { window.dispatchEvent(new Event('dsh-sidebar:refresh-files')) })
      await settle()
      expect(sessionCwdMock).toHaveBeenCalledTimes(3)

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(sessionCwdMock).toHaveBeenCalledTimes(4)

      // Every poll-family call went out WITHOUT the fresh flag: those ask on
      // schedule, they do not claim the root moved.
      for (const call of sessionCwdMock.mock.calls) expect(call[1]).toBeUndefined()
    } finally {
      harness.unmount()
    }
  })

  it('asks nothing while the document is hidden, and resumes on focus', async () => {
    await withVisibility(true, async () => {
      const harness = mountRoot('s1')
      try {
        await settle()
        expect(harness.root()).toBe('/summary-a')
        expect(sessionCwdMock).not.toHaveBeenCalled()

        act(() => { window.dispatchEvent(new Event('focus')) })
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
        expect(sessionCwdMock).not.toHaveBeenCalled()
      } finally {
        harness.unmount()
      }
    })

    await withVisibility(false, async () => {
      const harness = mountRoot('s1')
      try {
        await settle()
        expect(sessionCwdMock).toHaveBeenCalledTimes(1)
        act(() => { window.dispatchEvent(new Event('focus')) })
        await settle()
        expect(sessionCwdMock).toHaveBeenCalledTimes(2)
      } finally {
        harness.unmount()
      }
    })
  })

  it('folds a fresh answer that repeats the cwd, and updates on a real change', async () => {
    const harness = mountRoot('s1')
    try {
      await settle()
      expect(harness.commits()).toBe(2)

      // The push says "it moved" but the fresh ask returns the SAME root:
      // the fold keeps the previous object, so nothing re-renders.
      harness.socket().open()
      act(() => { harness.socket().frame({ kind: 'cwd', sessionId: 's1' }) })
      await settle()
      expect(harness.commits()).toBe(2)
      expect(harness.root()).toBe('/work-a')

      // A real move (the next poll picks it up) lands with one commit.
      currentCwd = '/worktree-b'
      act(() => { window.dispatchEvent(new Event('focus')) })
      await settle()
      expect(harness.commits()).toBe(3)
      expect(harness.root()).toBe('/worktree-b')
    } finally {
      harness.unmount()
    }
  })
})
