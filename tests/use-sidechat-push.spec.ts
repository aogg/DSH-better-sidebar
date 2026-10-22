/**
 * The client half of the Side Chat staleness push: one socket per mounted
 * tab, opened under `/sidebar/ws/sidechat`, whose `watch` frames carry the
 * WHOLE subscription set (a replacement, never an incremental add), whose
 * notices are routed to `onInvalidate` for WATCHED ids only, and which does
 * not exist at all while the id list is empty — unless the GLOBAL threads
 * channel is subscribed (`threads: true`), which keeps the socket alive for
 * tabs with no bound thread and routes `{scope:'threads'}` frames (plus the
 * open-time alignment) to `onThreadsStale`.
 *
 * The identity guard mirrors the fs-watch hook's: the wanted set derives from
 * the CONTENT of the id list (a NUL-joined key), so a caller re-rendering
 * with a fresh array of the same ids neither reopens the socket nor re-sends
 * the watch frame.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useSidechatPush } from '../src/client/use-sidechat-push.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** The smallest WebSocket the hook talks to: `send` records the frames. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly OPEN = 1
  static readonly CONNECTING = 0
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
  /** The host's connection acknowledgement. */
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  /** One host frame (an invalidation notice, or something malformed). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** A drop WITHOUT a clean close (drives the retry/backoff path). */
  drop(): void { this.onclose?.() }
  /** The frames the hook sent, as parsed objects. */
  frames(): { op: string; threadIds: string[]; threads?: boolean }[] {
    return this.sent.map(frame => JSON.parse(frame) as { op: string; threadIds: string[]; threads?: boolean })
  }
}

/** The full option bag the hook accepts (what a test does not pass, the
 *  hook does not receive — the undefined-vs-absent distinction matters for
 *  the threads flag). */
interface ProbeOptions {
  threadIds?: string[]
  threads?: boolean
  onInvalidate?: (id: string) => void
  onThreadsStale?: () => void
  onReconnect?: () => void
}

function Probe(props: ProbeOptions): ReactNode {
  useSidechatPush({
    threadIds: props.threadIds ?? [],
    onInvalidate: props.onInvalidate ?? (() => {}),
    ...(props.threads !== undefined ? { threads: props.threads } : {}),
    ...(props.onThreadsStale !== undefined ? { onThreadsStale: props.onThreadsStale } : {}),
    ...(props.onReconnect !== undefined ? { onReconnect: props.onReconnect } : {}),
  })
  return null
}

interface Harness {
  rerender: (threadIds: string[]) => void
  /** The single open socket; throws when the list was empty. */
  socket: () => FakeSocket
  unmount: () => void
}

function mountProbe(onInvalidate: (id: string) => void, initial: string[] = ['t1'], options: Omit<ProbeOptions, 'threadIds' | 'onInvalidate'> = {}): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (threadIds: string[]): void => {
    root.render(createElement(Probe, { threadIds, onInvalidate, ...options }))
  }
  act(() => { render(initial) })
  return {
    rerender: (threadIds: string[]) => { act(() => { render(threadIds) }) },
    socket: () => {
      const socket = FakeSocket.instances[0]
      if (socket === undefined) throw new Error('no socket opened')
      return socket
    },
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('useSidechatPush', () => {
  it('opens the sidechat socket and announces the watched ids once it opens', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    expect(socket.url).toContain('/sidebar/ws/sidechat')
    // Nothing is sent before the connection opens.
    expect(socket.sent).toEqual([])
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: ['t1'] }])
    harness.unmount()
  })

  it('re-announces the full set on the SAME socket when the ids change', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.rerender(['t1', 't2'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.frames().at(-1)).toEqual({ op: 'watch', threadIds: ['t1', 't2'] })
    harness.unmount()
  })

  it('sends nothing when a re-render repeats the same ids in a fresh array', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    const before = socket.sent.length
    harness.rerender(['t1'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.sent.length).toBe(before)
    harness.unmount()
  })

  it('invalidates a watched id and ignores everything else', () => {
    const onInvalidate = vi.fn()
    const harness = mountProbe(onInvalidate)
    const socket = harness.socket()
    act(() => { socket.open() })
    // A thread this socket does not watch (a late notice after a switch).
    act(() => { socket.frame({ threadId: 't9' }) })
    expect(onInvalidate).not.toHaveBeenCalled()
    // A malformed frame is ignored outright.
    act(() => { socket.frame({ nope: 1 }) })
    expect(onInvalidate).not.toHaveBeenCalled()
    // The notice is an invalidation: `running` rides along but changes nothing.
    act(() => { socket.frame({ threadId: 't1', running: true }) })
    expect(onInvalidate).toHaveBeenCalledWith('t1')
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('opens no socket while the list is empty, and closes it when the list empties', () => {
    const harness = mountProbe(() => {}, [])
    expect(FakeSocket.instances).toHaveLength(0)

    harness.rerender(['t1'])
    const socket = harness.socket()
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: ['t1'] }])

    harness.rerender([])
    expect(socket.closed).toBe(true)
    expect(FakeSocket.instances).toHaveLength(1)
    harness.unmount()
  })

  it('closes the socket on unmount', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.unmount()
    expect(socket.closed).toBe(true)
  })

  // ---- The GLOBAL threads channel --------------------------------------

  it('keeps the socket alive with threads:true even when the id list is empty', () => {
    // The pre-threads contract (no socket for an empty list) has its own case
    // above; with the threads channel a tab with NO bound thread still needs
    // the global feed, so the socket stays.
    const harness = mountProbe(() => {}, [], { threads: true })
    expect(FakeSocket.instances).toHaveLength(1)
    const socket = harness.socket()
    act(() => { socket.open() })
    // An empty watch set + the threads flag: the host filters {threadId}
    // frames against the empty set and pushes only {scope:'threads'} frames.
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: [], threads: true }])
    harness.unmount()
  })

  it('fires onThreadsStale on the first open (alignment) and on every threads frame', () => {
    const onThreadsStale = vi.fn()
    const onInvalidate = vi.fn()
    const harness = mountProbe(onInvalidate, ['t1'], { threads: true, onThreadsStale })
    const socket = harness.socket()
    // Subscribe-and-pull alignment: the watch frame only announces what to
    // watch from NOW on, so the CURRENT thread set must be pulled at once.
    act(() => { socket.open() })
    expect(onThreadsStale).toHaveBeenCalledTimes(1)
    // A threads frame is a pure invalidation: no thread id, no data.
    act(() => { socket.frame({ scope: 'threads' }) })
    expect(onThreadsStale).toHaveBeenCalledTimes(2)
    // A per-thread notice goes to onInvalidate and leaves the threads
    // callback alone — the two channels stay independent.
    act(() => { socket.frame({ threadId: 't1' }) })
    expect(onInvalidate).toHaveBeenCalledWith('t1')
    expect(onThreadsStale).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('stays silent about threads without the threads subscription (old contract)', () => {
    const onThreadsStale = vi.fn()
    const harness = mountProbe(() => {}, ['t1'], { onThreadsStale })
    const socket = harness.socket()
    act(() => { socket.open() })
    // No threads option → no alignment fire and no flag on the wire; the
    // host will never push threads frames to this socket, and one that
    // arrives anyway (an old host's bug) is ignored here.
    expect(onThreadsStale).not.toHaveBeenCalled()
    expect(socket.frames()).toEqual([{ op: 'watch', threadIds: ['t1'] }])
    act(() => { socket.frame({ scope: 'threads' }) })
    expect(onThreadsStale).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('re-aligns the threads channel on a re-open after a drop', async () => {
    vi.useFakeTimers()
    try {
      const onThreadsStale = vi.fn()
      const onReconnect = vi.fn()
      const harness = mountProbe(() => {}, ['t1'], { threads: true, onThreadsStale, onReconnect })
      const socket = harness.socket()
      act(() => { socket.open() })
      expect(onThreadsStale).toHaveBeenCalledTimes(1)

      // The wire drops: the hook retries forever, 1s first.
      act(() => { socket.drop() })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      const second = FakeSocket.instances[1]!
      expect(second).toBeDefined()
      // Frames the outage swallowed are gone for good: the re-open fires
      // BOTH the reconnect report and the threads alignment.
      expect(onReconnect).not.toHaveBeenCalled()
      act(() => { second.open() })
      expect(onReconnect).toHaveBeenCalledTimes(1)
      expect(onThreadsStale).toHaveBeenCalledTimes(2)
      // The re-announced watch set carries the threads flag again.
      expect(second.frames()).toEqual([{ op: 'watch', threadIds: ['t1'], threads: true }])
      harness.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
