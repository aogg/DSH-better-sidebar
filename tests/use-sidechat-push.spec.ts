/**
 * The client half of the Side Chat staleness push, riding the ONE multiplexed
 * feed socket (channel `'sidechat'`, feed-hub.ts): one `sub` per watched
 * thread (a delta sub/unsub per id-list change on the SAME socket — never a
 * reconnect), the GLOBAL threads channel AGGREGATED at module level (every
 * subscribing tab shares one `{threads:true}` wire subscription), notices
 * routed to `onInvalidate` for WATCHED ids only, no subscription at all while
 * the id list is empty — unless the threads channel is joined, which keeps a
 * tab with no bound thread on the global feed. Subscribe-and-pull alignment:
 * a view's `onThreadsStale` fires when it JOINS (the shared subscription may
 * have been open long before) and on every threads frame / recovered open.
 *
 * The identity guard: the wanted set derives from the CONTENT of the id list
 * (a NUL-joined key), so a caller re-rendering with a fresh array of the same
 * ids sends nothing.
 *
 * The threads channel handle lives at MODULE level, so every test unmounts
 * its probe — a leftover subscriber would keep the shared subscription (and
 * the socket) alive into the next test.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useSidechatPush } from '../src/client/use-sidechat-push.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** The smallest WebSocket the hub talks to: `send` records the frames. */
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
  /** The frames the hub sent, as parsed objects. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
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
  /** The single open socket; throws when none was opened. */
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

describe('useSidechatPush (per-thread subscriptions)', () => {
  it('opens the shared feed socket and subscribes each watched thread on it', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    expect(socket.url).toContain('/sidebar/ws/feed')
    // The sub control frame rides the OPEN (nothing before it).
    expect(socket.sent).toEqual([])
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'sub', channel: 'sidechat', args: { threadId: 't1' } }])
    harness.unmount()
    expect(socket.closed).toBe(true)
  })

  it('applies an id change as a DELTA on the same socket', () => {
    const harness = mountProbe(() => {})
    const socket = harness.socket()
    act(() => { socket.open() })
    harness.rerender(['t1', 't2'])
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.frames().at(-1)).toEqual({ op: 'sub', channel: 'sidechat', args: { threadId: 't2' } })
    harness.rerender(['t2'])
    expect(socket.frames().at(-1)).toEqual({ op: 'unsub', channel: 'sidechat', args: { threadId: 't1' } })
    harness.unmount()
    expect(socket.closed).toBe(true)
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
    // A thread this view does not watch (a late notice after a switch): the
    // hub routes by subscription, and the view filters again.
    act(() => { socket.frame({ channel: 'sidechat', data: { threadId: 't9' } }) })
    expect(onInvalidate).not.toHaveBeenCalled()
    // A malformed frame is ignored outright.
    act(() => { socket.frame({ channel: 'sidechat', data: { nope: 1 } }) })
    act(() => { socket.frame({ nope: true }) })
    // The notice is an invalidation: `running` rides along but changes nothing.
    act(() => { socket.frame({ channel: 'sidechat', data: { threadId: 't1', running: true } }) })
    expect(onInvalidate).toHaveBeenCalledWith('t1')
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    harness.unmount()
  })

  it('opens no socket while the list is empty, and re-subscribes when it fills', () => {
    const harness = mountProbe(() => {}, [])
    expect(FakeSocket.instances).toHaveLength(0)

    harness.rerender(['t1'])
    const socket = harness.socket()
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'sub', channel: 'sidechat', args: { threadId: 't1' } }])

    harness.rerender([])
    // The LAST subscription of the run retires its key by CLOSING the shared
    // socket (no `unsub` is needed when nothing stays on the wire).
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socket.closed).toBe(true)
    harness.unmount()
  })

  it('fires onReconnect on a recovered open so the outage catch-up runs', async () => {
    vi.useFakeTimers()
    try {
      const onReconnect = vi.fn()
      const harness = mountProbe(() => {}, ['t1'], { onReconnect })
      const socket = harness.socket()
      act(() => { socket.open() })
      expect(onReconnect).not.toHaveBeenCalled()
      socket.drop()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      const second = FakeSocket.instances[1]!
      expect(second).toBeDefined()
      act(() => { second.open() })
      // The replay re-announces the thread on the new socket…
      expect(second.frames()).toEqual([{ op: 'sub', channel: 'sidechat', args: { threadId: 't1' } }])
      // …and the recovery fires once.
      expect(onReconnect).toHaveBeenCalledTimes(1)
      harness.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useSidechatPush (the shared global threads channel)', () => {
  it('keeps the socket alive with threads:true even when the id list is empty', () => {
    const harness = mountProbe(() => {}, [], { threads: true, onThreadsStale: () => {} })
    expect(FakeSocket.instances).toHaveLength(1)
    const socket = harness.socket()
    act(() => { socket.open() })
    // No per-thread subs; the ONE aggregated threads subscription.
    expect(socket.frames()).toEqual([{ op: 'sub', channel: 'sidechat', args: { threads: true } }])
    harness.unmount()
    expect(socket.closed).toBe(true)
  })

  it('fires onThreadsStale at join (alignment) and on every threads frame', () => {
    const onThreadsStale = vi.fn()
    const onInvalidate = vi.fn()
    const harness = mountProbe(onInvalidate, ['t1'], { threads: true, onThreadsStale })
    const socket = harness.socket()
    // Subscribe-and-pull alignment: the watch frames only announce what to
    // watch from NOW on, so the CURRENT thread set must be pulled at once —
    // the shared subscription may have been open long before this view
    // mounted, so the join itself is the alignment event.
    expect(onThreadsStale).toHaveBeenCalledTimes(1)
    act(() => { socket.open() })
    // The open itself does not fire again (the join already aligned).
    expect(onThreadsStale).toHaveBeenCalledTimes(1)
    // A threads frame is a pure invalidation: no thread id, no data.
    act(() => { socket.frame({ channel: 'sidechat', data: { scope: 'threads' } }) })
    expect(onThreadsStale).toHaveBeenCalledTimes(2)
    // A per-thread notice goes to onInvalidate and leaves the threads
    // callback alone — the two channels stay independent.
    act(() => { socket.frame({ channel: 'sidechat', data: { threadId: 't1' } }) })
    expect(onInvalidate).toHaveBeenCalledWith('t1')
    expect(onThreadsStale).toHaveBeenCalledTimes(2)
    harness.unmount()
  })

  it('stays silent about threads without the threads subscription', () => {
    const onThreadsStale = vi.fn()
    const harness = mountProbe(() => {}, ['t1'], { onThreadsStale })
    const socket = harness.socket()
    act(() => { socket.open() })
    // No threads option → no alignment fire and no threads subscription on
    // the wire; the host will never push threads frames to this key, and one
    // that arrives anyway is ignored here.
    expect(onThreadsStale).not.toHaveBeenCalled()
    expect(socket.frames()).toEqual([{ op: 'sub', channel: 'sidechat', args: { threadId: 't1' } }])
    act(() => { socket.frame({ channel: 'sidechat', data: { scope: 'threads' } }) })
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
      expect(onThreadsStale).toHaveBeenCalledTimes(1)

      // The wire drops: the hub retries forever, 1s first.
      act(() => { socket.drop() })
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      const second = FakeSocket.instances[1]!
      expect(second).toBeDefined()
      act(() => { second.open() })
      // Frames the outage swallowed are gone for good: the re-open replays
      // the subs and fires BOTH the reconnect report and the threads
      // alignment (through the shared channel's recovered open).
      expect(onReconnect).toHaveBeenCalledTimes(1)
      expect(onThreadsStale).toHaveBeenCalledTimes(2)
      expect(second.frames()).toEqual([
        { op: 'sub', channel: 'sidechat', args: { threadId: 't1' } },
        { op: 'sub', channel: 'sidechat', args: { threads: true } },
      ])
      harness.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aggregates the threads channel across TWO mounted views into one wire subscription', () => {
    const firstStale = vi.fn()
    const secondStale = vi.fn()
    const first = mountProbe(() => {}, [], { threads: true, onThreadsStale: firstStale })
    expect(firstStale).toHaveBeenCalledTimes(1)
    const second = mountProbe(() => {}, [], { threads: true, onThreadsStale: secondStale })
    expect(secondStale).toHaveBeenCalledTimes(1)
    // One socket, one {threads:true} sub total (the second view joined the
    // shared handle instead of re-announcing).
    expect(FakeSocket.instances).toHaveLength(1)
    const socket = first.socket()
    act(() => { socket.open() })
    expect(socket.frames()).toEqual([{ op: 'sub', channel: 'sidechat', args: { threads: true } }])
    // One frame fans out to BOTH views' listeners.
    act(() => { socket.frame({ channel: 'sidechat', data: { scope: 'threads' } }) })
    expect(firstStale).toHaveBeenCalledTimes(2)
    expect(secondStale).toHaveBeenCalledTimes(2)
    // The shared subscription survives the FIRST view leaving.
    first.unmount()
    expect(socket.closed).toBe(false)
    second.unmount()
    expect(socket.closed).toBe(true)
  })
})
