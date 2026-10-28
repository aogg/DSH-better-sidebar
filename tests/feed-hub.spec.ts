/**
 * The FeedHub singleton (src/client/feed-hub.ts): ONE multiplexed
 * `/sidebar/ws/feed` WebSocket for every push consumer. The rules under
 * test:
 *  - ONE socket total: the first subscription opens it, further channels
 *    join it, and the LAST unsubscription closes it.
 *  - REFERENCE COUNTING per key (`channel + sessionId + args`): two
 *    subscribers of the same key share one entry; the key's wire `unsub`
 *    waits for its last handle; `setArgs` is a delta `unsub`+`sub`.
 *  - DISPATCH: a `{channel, sessionId, data}` frame reaches only that
 *    session's subscribers of that channel; a sessionId-less frame (the
 *    session channel's project-scoped seeds) fans out to the whole channel.
 *  - ERRORS: an `{error}` frame is routed to the named subscription's
 *    `onError` (narrowest match the frame names).
 *  - RECONNECT: a drop backs off 1s (±30% jitter) and never gives up; the
 *    re-open REPLAYS every active `sub` (the host re-seeds), fires
 *    `onState(false→true)` and — only after a real drop — `onReconnect`.
 *  - SESSION-DIMENSION RELEASE: `feedReleaseSession` wire-unsubscribes the
 *    session-scoped channels of one session (sidechat excluded) and stops
 *    their frames; `feedRestoreSession` re-announces them and fires
 *    `onReconnect`.
 *
 * The hub state lives at MODULE level, so every test closes every
 * subscription it opened (`track` + afterEach) — a leftover subscriber
 * would keep the socket alive into the next test.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  feedEntryCountForTests,
  feedReleaseSession,
  feedRestoreSession,
  feedSubscribe,
  type FeedSubscription,
} from '../src/client/feed-hub.ts'

/** The smallest WebSocket the hub talks to: `send` records the frames. */
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
  /** One host frame (a data envelope, an error, or something malformed). */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** A drop (drives the reconnect/backoff path). */
  drop(): void { this.readyState = 3; this.onclose?.() }
  /** The frames the hub sent, as parsed objects. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
  }
}

/** Every subscription a test opened, undone after the test whatever happens. */
const disposers: FeedSubscription[] = []
function track(subscription: FeedSubscription): FeedSubscription {
  disposers.push(subscription)
  return subscription
}

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
  for (const disposer of disposers.splice(0)) disposer.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('feedSubscribe (one socket, reference counting)', () => {
  it('opens ONE feed socket and announces each subscription on it', () => {
    const a = track(feedSubscribe({ channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] }, onData: () => {} }))
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socketAt(0).url).toContain('/sidebar/ws/feed')
    // Nothing is sent before the connection opens.
    expect(socketAt(0).sent).toEqual([])
    socketAt(0).open()
    expect(socketAt(0).frames()).toEqual([
      { op: 'sub', channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] } },
    ])
    // A second subscription (another channel, same socket) announces at once.
    track(feedSubscribe({ channel: 'session', sessionId: 's2', onData: () => {} }))
    expect(FakeSocket.instances).toHaveLength(1)
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'sub', channel: 'session', sessionId: 's2' })
    void a
  })

  it('shares one entry for identical keys and retires the key with the last handle', () => {
    const first = track(feedSubscribe({ channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] }, onData: () => {} }))
    socketAt(0).open()
    const sentAfterFirst = socketAt(0).sent.length
    const second = track(feedSubscribe({ channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] }, onData: () => {} }))
    // Same key: no extra wire frame, no extra entry.
    expect(socketAt(0).sent.length).toBe(sentAfterFirst)
    expect(feedEntryCountForTests()).toBe(1)
    // The first handle leaving keeps the key alive.
    first.close()
    expect(feedEntryCountForTests()).toBe(1)
    expect(socketAt(0).frames().some(frame => frame.op === 'unsub')).toBe(false)
    // The last handle retires it: no `unsub` is needed (the socket dies with
    // its only key) and the shared socket closes.
    second.close()
    disposers.length = 0
    expect(socketAt(0).frames().some(frame => frame.op === 'unsub')).toBe(false)
    expect(socketAt(0).closed).toBe(true)
  })

  it('re-points args with a delta unsub+sub, keeping other handles honest', () => {
    const sub = track(feedSubscribe({ channel: 'fs-jobs', sessionId: 's1', args: { jobs: ['a'] }, onData: () => {} }))
    socketAt(0).open()
    sub.setArgs({ jobs: ['a', 'b'] })
    const frames = socketAt(0).frames()
    expect(frames.at(-2)).toEqual({ op: 'unsub', channel: 'fs-jobs', sessionId: 's1', args: { jobs: ['a'] } })
    expect(frames.at(-1)).toEqual({ op: 'sub', channel: 'fs-jobs', sessionId: 's1', args: { jobs: ['a', 'b'] } })
    // Setting the SAME args again is a no-op.
    const before = socketAt(0).sent.length
    sub.setArgs({ jobs: ['a', 'b'] })
    expect(socketAt(0).sent.length).toBe(before)
  })

  it('tells a subscriber joining an ALREADY-open socket that it is open', () => {
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    socketAt(0).open()
    const onState = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's2', onData: () => {}, onState }))
    expect(onState).toHaveBeenCalledWith(true)
  })
})

describe('feedSubscribe (dispatch and errors)', () => {
  it('routes data frames by channel and sessionId', () => {
    const gitS1 = vi.fn()
    const gitS2 = vi.fn()
    const session = vi.fn()
    track(feedSubscribe({ channel: 'git', sessionId: 's1', onData: gitS1 }))
    track(feedSubscribe({ channel: 'git', sessionId: 's2', onData: gitS2 }))
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: session }))
    socketAt(0).open()
    socketAt(0).frame({ channel: 'git', sessionId: 's1', data: { kind: 'git', worktree: '/r' } })
    expect(gitS1).toHaveBeenCalledTimes(1)
    expect(gitS2).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
    socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'cwd', sessionId: 's1' } })
    expect(session).toHaveBeenCalledTimes(1)
  })

  it('fans a sessionId-less frame out to the whole channel (project-scoped seeds)', () => {
    const a = vi.fn()
    const b = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: a }))
    track(feedSubscribe({ channel: 'session', sessionId: 's2', onData: b }))
    socketAt(0).open()
    socketAt(0).frame({ channel: 'session', data: { kind: 'history-seed', cwd: '/p', seeding: true } })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('routes an error frame to the named subscription only', () => {
    const onError1 = vi.fn()
    const onError2 = vi.fn()
    track(feedSubscribe({ channel: 'git', sessionId: 's1', onData: () => {}, onError: onError1 }))
    track(feedSubscribe({ channel: 'git', sessionId: 's2', onData: () => {}, onError: onError2 }))
    socketAt(0).open()
    socketAt(0).frame({ error: 'watch refused', channel: 'git', sessionId: 's1' })
    expect(onError1).toHaveBeenCalledWith('watch refused')
    expect(onError2).not.toHaveBeenCalled()
    // Malformed host frames (no channel, no error) are ignored outright.
    expect(() => socketAt(0).frame({ nope: true })).not.toThrow()
  })

  it('contains a throwing subscriber so the rest still hear their frames', () => {
    const good = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => { throw new Error('boom') } }))
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: good }))
    socketAt(0).open()
    expect(() => socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'turn', sessionId: 's1' } })).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
  })
})

describe('feedSubscribe (reconnect)', () => {
  it('replays every active sub on the re-opened socket and fires onReconnect once', async () => {
    const onState = vi.fn()
    const onReconnect = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {}, onState, onReconnect }))
    track(feedSubscribe({ channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] }, onData: () => {} }))
    socketAt(0).open()
    // The FIRST open is not a recovery.
    expect(onState).toHaveBeenCalledWith(true)
    expect(onReconnect).not.toHaveBeenCalled()
    socketAt(0).drop()
    expect(onState).toHaveBeenCalledWith(false)
    // The first retry waits 1s ±30%: below 700ms nothing happens, past
    // 1300ms the reconnect must have fired.
    await vi.advanceTimersByTimeAsync(699)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(601)
    expect(FakeSocket.instances).toHaveLength(2)
    socketAt(1).open()
    // Every active subscription is replayed for the host to re-seed.
    expect(socketAt(1).frames()).toEqual([
      { op: 'sub', channel: 'session', sessionId: 's1' },
      { op: 'sub', channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] } },
    ])
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('never gives up: each failure doubles the step up to the 15s cap', async () => {
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    // Four consecutive failures: 1s, 2s, 4s, 8s (jitter widens each by ≤30%,
    // so generous advances cross exactly one step at a time).
    for (let expected = 2; expected <= 5; expected += 1) {
      socketAt(FakeSocket.instances.length - 1).drop()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(FakeSocket.instances).toHaveLength(expected)
    }
    // A clean close without subscriptions left opens nothing further.
    disposers.splice(0).forEach(disposer => disposer.close())
    socketAt(4).drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeSocket.instances).toHaveLength(5)
  })
})

describe('feedReleaseSession / feedRestoreSession', () => {
  it('suspends the session-scoped subscriptions of one session, sidechat excluded', () => {
    const sessionData = vi.fn()
    const sidechatData = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: sessionData }))
    track(feedSubscribe({ channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] }, onData: () => {} }))
    track(feedSubscribe({ channel: 'sidechat', args: { threadId: 't1' }, onData: sidechatData }))
    socketAt(0).open()
    feedReleaseSession('s1')
    const frames = socketAt(0).frames()
    expect(frames.filter(frame => frame.op === 'unsub')).toEqual([
      { op: 'unsub', channel: 'session', sessionId: 's1' },
      { op: 'unsub', channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] } },
    ])
    // Released entries hear no frames; sidechat does.
    socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'turn', sessionId: 's1' } })
    expect(sessionData).not.toHaveBeenCalled()
    socketAt(0).frame({ channel: 'sidechat', data: { threadId: 't1' } })
    expect(sidechatData).toHaveBeenCalledTimes(1)
    // The registry keeps the entries (restore has something to restore).
    expect(feedEntryCountForTests()).toBe(3)
  })

  it('restores the released subscriptions and fires onReconnect for the catch-up', () => {
    const onReconnect = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {}, onReconnect }))
    socketAt(0).open()
    feedReleaseSession('s1')
    feedRestoreSession('s1')
    const frames = socketAt(0).frames()
    expect(frames.filter(frame => frame.op === 'sub')).toEqual([
      { op: 'sub', channel: 'session', sessionId: 's1' },
      { op: 'sub', channel: 'session', sessionId: 's1' },
    ])
    expect(onReconnect).toHaveBeenCalledTimes(1)
    // Frames flow again.
    socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'phase', sessionId: 's1' } })
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('a session with nothing registered is a no-op', () => {
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    socketAt(0).open()
    const before = socketAt(0).sent.length
    expect(() => feedReleaseSession('ghost')).not.toThrow()
    expect(() => feedRestoreSession('ghost')).not.toThrow()
    expect(socketAt(0).sent.length).toBe(before)
  })

  it('a re-entrant join of a released key restores it at once', () => {
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    socketAt(0).open()
    feedReleaseSession('s1')
    const onState = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {}, onState }))
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'sub', channel: 'session', sessionId: 's1' })
    expect(onState).toHaveBeenCalledWith(true)
  })
})
