/**
 * The multiplexed feed endpoint (`/sidebar/ws/feed`, src/ws-feed.ts +
 * src/feed-channels.ts). What matters here is the multiplexer contract and
 * its integration with the real push hubs:
 *
 *  - KEYS: the subscription key is channel + NUL + sessionId + NUL +
 *    JSON(args ?? null), an `unsub` removes exactly an equal `sub`'s key,
 *    and a repeated identical `sub` is idempotent (one resource, one
 *    dispose — never two stacked subscriptions behind one key).
 *  - ERRORS: an unknown channel/op, a malformed frame, a non-object args,
 *    a non-string sessionId and a channel's session fence (git/agent-opens
 *    without a sessionId — the legacy endpoints' 1008 close) answer an
 *    error frame and the CONNECTION STAYS UP.
 *  - ENVELOPES: native channel frames ride `{"channel","sessionId"?,"data"}`
 *    with sessionId echoing the subscription's own session dimension
 *    (omitted when it has none), verbatim data inside.
 *  - RESOURCES: two connections subscribing the same (channel, key) share
 *    the hub's one resource (one hub seat, both envelopes), the last
 *    unsubscribe releases it, and a disconnect releases EVERY subscription
 *    the connection held.
 *  - CHANNELS: the real feed-channels table maps each channel onto the
 *    same hub seams the legacy endpoint shells use — git/fs-jobs full-
 *    replacement args, the session channel's project-level seed sub, the
 *    sidechat threads flag, and refusals of subscriptions that could never
 *    hear anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEED_CHANNELS,
  FeedConnection,
  attachFeedSocket,
  feedSubscriptionKey,
  type FeedChannelHandler,
  type FeedOutboundFrame,
} from '../src/ws-feed.ts'
import { createFeedChannelHandlers } from '../src/feed-channels.ts'
import { createFsJobsPushHub } from '../src/fs-jobs-push.ts'
import type { TransferStatusView } from '../src/fs-transfer.ts'
import { createSessionPushHub } from '../src/session-push.ts'
import { createSidechatPushHub } from '../src/sidechat-push.ts'
import type { Context } from '../src/context-types.ts'
import type { WebSocket } from 'ws'

/** One captured listener of a fake context event feed. */
type Listener = (...args: unknown[]) => void

/** A context exposing just the `on` table the hubs subscribe through. */
function fakeCtx(): { ctx: Context; emit: (event: string, ...args: unknown[]) => void } {
  const listeners = new Map<string, Set<Listener>>()
  const ctx = {
    on: (event: string, listener: Listener): (() => void) => {
      let set = listeners.get(event)
      if (set === undefined) listeners.set(event, set = new Set())
      set.add(listener)
      return () => { set.delete(listener) }
    },
  } as unknown as Context
  return {
    ctx,
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
}

/** A minimal WebSocket double: records sends, can be driven and closed. */
class FakeSocket {
  readonly sent: FeedOutboundFrame[] = []
  private readonly handlers = new Map<string, Set<Listener>>()

  on(event: string, handler: Listener): void {
    let set = this.handlers.get(event)
    if (set === undefined) this.handlers.set(event, set = new Set())
    set.add(handler)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as FeedOutboundFrame)
  }

  /** Deliver one inbound frame to whatever is attached. */
  receive(frame: unknown): void {
    for (const handler of [...(this.handlers.get('message') ?? [])]) {
      handler(typeof frame === 'string' ? frame : JSON.stringify(frame))
    }
  }

  /** Fire an event (`close`/`error`) at the socket. */
  fire(event: string): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler()
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket
  }

  /** Attach the feed endpoint to this socket (the endpoint shell's wiring). */
  feed(handlers: Record<string, FeedChannelHandler>): FeedConnection {
    return attachFeedSocket(handlers, this.asWebSocket())
  }

  errors(): Array<Extract<FeedOutboundFrame, { error: string }>> {
    return this.sent.filter((frame): frame is Extract<FeedOutboundFrame, { error: string }> => 'error' in frame)
  }

  data(): Array<Extract<FeedOutboundFrame, { data?: unknown }>> {
    return this.sent.filter((frame): frame is Extract<FeedOutboundFrame, { data?: unknown }> => 'data' in frame)
  }
}

/** A counting channel double: one resource per open, all teardowns tallied. */
function countingChannel(): {
  handler: FeedChannelHandler
  opens: () => number
  disposals: () => number
  deliver: (data: unknown) => void
} {
  let opens = 0
  let disposals = 0
  let lastSend: ((data: unknown) => void) | undefined
  return {
    handler: {
      open: ({ send }) => {
        opens += 1
        lastSend = send
        return { dispose: () => { disposals += 1 } }
      },
    },
    opens: () => opens,
    disposals: () => disposals,
    deliver: (data) => { lastSend?.(data) },
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('feed subscription keys', () => {
  it('is channel + NUL + sessionId + NUL + JSON(args ?? null)', () => {
    expect(feedSubscriptionKey('git', 's1', { worktrees: ['/repo'] }))
      .toBe('git\0s1\0{"worktrees":["/repo"]}')
    // The no-session / no-args spellings: undefined and null are the same key
    // (JSON.stringify(undefined) is not a string), an object differs.
    expect(feedSubscriptionKey('session', undefined, undefined)).toBe('session\0\0null')
    expect(feedSubscriptionKey('session', undefined, null)).toBe('session\0\0null')
    expect(feedSubscriptionKey('session', undefined, {})).toBe('session\0\0{}')
    // An empty-string sessionId collapses onto the project-level key (the
    // spec's `(sessionId ?? '')` — the same reading the legacy endpoints'
    // `?sessionId=` query had); only `undefined` means "no session
    // dimension" to the per-channel fences.
    expect(feedSubscriptionKey('session', '', undefined)).toBe('session\0\0null')
    expect(feedSubscriptionKey('git', 's1', undefined)).not.toBe(feedSubscriptionKey('fs-jobs', 's1', undefined))
  })
})

describe('feed connection: control frames', () => {
  it('sub opens one subscription; unsub disposes it exactly once', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    const connection = socket.feed({ git: channel.handler })

    socket.receive({ op: 'sub', channel: 'git', sessionId: 's1' })
    expect(channel.opens()).toBe(1)
    expect(connection.holds('git', 's1', null)).toBe(true)

    socket.receive({ op: 'unsub', channel: 'git', sessionId: 's1' })
    expect(channel.disposals()).toBe(1)
    expect(connection.holds('git', 's1', null)).toBe(false)

    // A repeated unsub has nothing to remove: no double dispose.
    socket.receive({ op: 'unsub', channel: 'git', sessionId: 's1' })
    expect(channel.disposals()).toBe(1)

    // And a re-subscribe opens a fresh resource (the reconnect case).
    socket.receive({ op: 'sub', channel: 'git', sessionId: 's1' })
    expect(channel.opens()).toBe(2)
  })

  it('a repeated identical sub is idempotent: one resource behind the key', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    const connection = socket.feed({ session: channel.handler })

    socket.receive({ op: 'sub', channel: 'session', sessionId: 't1' })
    socket.receive({ op: 'sub', channel: 'session', sessionId: 't1' })
    expect(channel.opens()).toBe(1)

    // The single unsubscribe tears the single subscription down.
    socket.receive({ op: 'unsub', channel: 'session', sessionId: 't1' })
    expect(channel.disposals()).toBe(1)
    expect(connection.holds('session', 't1', null)).toBe(false)
  })

  it('unsub removes only the exact key: different args never remove', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    const connection = socket.feed({ 'fs-jobs': channel.handler })

    socket.receive({ op: 'sub', channel: 'fs-jobs', args: { jobs: ['t-1'] } })
    expect(connection.holds('fs-jobs', undefined, { jobs: ['t-1'] })).toBe(true)

    socket.receive({ op: 'unsub', channel: 'fs-jobs', args: { jobs: ['t-2'] } })
    expect(connection.holds('fs-jobs', undefined, { jobs: ['t-1'] })).toBe(true)
    expect(channel.disposals()).toBe(0)

    // A different sessionId is a different key too.
    socket.receive({ op: 'unsub', channel: 'fs-jobs', sessionId: 'other', args: { jobs: ['t-1'] } })
    expect(channel.disposals()).toBe(0)

    socket.receive({ op: 'unsub', channel: 'fs-jobs', args: { jobs: ['t-1'] } })
    expect(channel.disposals()).toBe(1)
    expect(connection.holds('fs-jobs', undefined, { jobs: ['t-1'] })).toBe(false)
  })

  it('refuses unknown channels, unknown ops and malformed frames, connection stays up', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    socket.feed({ git: channel.handler })

    socket.receive('not json at all')
    socket.receive({ op: 'watch', channel: 'git', sessionId: 's1' })
    socket.receive({ op: 'sub', channel: 'nope' })
    socket.receive({ op: 'sub' })
    socket.receive([1, 2, 3])
    socket.receive({ op: 'sub', channel: 'git', sessionId: 42 })
    socket.receive({ op: 'sub', channel: 'git', sessionId: 's1', args: 'jobs' })
    expect(socket.errors().map(frame => frame.error)).toEqual([
      'invalid frame',
      'unknown op watch',
      'unknown channel nope',
      'missing channel',
      'invalid frame',
      'sessionId must be a string',
      'args must be an object',
    ])
    // The error frames echo the refused frame's coordinates when it had any
    // (a non-string sessionId is refused, not echoed).
    expect(socket.errors().at(-2)).toMatchObject({ channel: 'git' })

    // The connection answers, so a valid sub still opens after all that.
    socket.receive({ op: 'sub', channel: 'git', sessionId: 's1' })
    expect(channel.opens()).toBe(1)
  })

  it('answers a channel refusal with an error frame and opens nothing', () => {
    const socket = new FakeSocket()
    const connection = socket.feed({
      git: { open: () => ({ error: 'sessionId is required' }) },
    })
    socket.receive({ op: 'sub', channel: 'git' })
    expect(socket.errors()).toEqual([{ error: 'sessionId is required', channel: 'git' }])
    expect(connection.holds('git', undefined, null)).toBe(false)
  })

  it('caps live subscriptions per connection', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    const connection = new FeedConnection({ handlers: { git: channel.handler }, send: frame => socket.send(JSON.stringify(frame)), maxSubscriptions: 1 })
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'git', sessionId: 'a' }))
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'git', sessionId: 'b' }))
    expect(socket.errors().at(-1)).toMatchObject({ error: 'too many subscriptions', channel: 'git', sessionId: 'b' })
    expect(connection.holds('git', 'a', null)).toBe(true)
    expect(connection.holds('git', 'b', null)).toBe(false)
  })

  it('envelopes native frames with the subscription\'s channel and sessionId', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    socket.feed({ sidechat: channel.handler })

    socket.receive({ op: 'sub', channel: 'sidechat', sessionId: 't1' })
    channel.deliver({ threadId: 't1' })
    expect(socket.sent.filter(frame => !('error' in frame))).toEqual([
      { channel: 'sidechat', sessionId: 't1', data: { threadId: 't1' } },
    ])

    // A session-less subscription omits the envelope's sessionId entirely.
    socket.receive({ op: 'sub', channel: 'sidechat', args: { threads: true } })
    channel.deliver({ scope: 'threads' })
    expect(socket.sent.filter(frame => !('error' in frame)).at(-1)).toEqual({
      channel: 'sidechat',
      data: { scope: 'threads' },
    })
  })

  it('a disposed subscription delivers no late frame even if the channel had one in flight', () => {
    const channel = countingChannel()
    const socket = new FakeSocket()
    socket.feed({ session: channel.handler })

    socket.receive({ op: 'sub', channel: 'session', sessionId: 't1' })
    socket.receive({ op: 'unsub', channel: 'session', sessionId: 't1' })
    channel.deliver({ kind: 'ops', sessionId: 't1', seq: 9 })
    expect(socket.sent.filter(frame => !('error' in frame))).toEqual([])
  })

  it('close releases EVERY subscription and ignores later frames', () => {
    const a = countingChannel()
    const b = countingChannel()
    const socket = new FakeSocket()
    const connection = socket.feed({ git: a.handler, session: b.handler })

    socket.receive({ op: 'sub', channel: 'git', sessionId: 's1' })
    socket.receive({ op: 'sub', channel: 'git', sessionId: 's2' })
    socket.receive({ op: 'sub', channel: 'session', sessionId: 't1' })
    expect(a.opens()).toBe(2)
    expect(b.opens()).toBe(1)

    // close and error land on the same path (either may arrive first).
    socket.fire('error')
    expect(a.disposals()).toBe(2)
    expect(b.disposals()).toBe(1)

    // Frames after the close are ignored, no handler is consulted again.
    socket.receive({ op: 'sub', channel: 'git', sessionId: 's3' })
    expect(a.opens()).toBe(2)
    expect(connection.holds('git', 's3', null)).toBe(false)
  })

  it('knows the five channels it multiplexes', () => {
    expect(FEED_CHANNELS).toEqual(['agent-opens', 'git', 'fs-jobs', 'session', 'sidechat'])
  })
})

describe('feed over the real fs-jobs hub', () => {
  const status: TransferStatusView = {
    transferId: 't-1',
    mode: 'copy',
    state: 'running',
    totalFiles: 2,
    totalBytes: 100,
    filesDone: 0,
    bytesDone: 10,
    itemErrors: [],
  }

  /** The REAL channel table against one real fs-jobs hub (the other channels dummy). */
  function feedOf(hub: ReturnType<typeof createFsJobsPushHub>): Record<string, FeedChannelHandler> {
    return createFeedChannelHandlers({
      sessionRootOf: async () => '/session',
      agentOpenRegistry: { attach: () => () => {} },
      gitPush: { subscribe: () => ({ apply: async () => {}, close: () => {} }) } as never,
      fsJobsPush: hub,
      sessionPush: { subscribe: () => ({ watch: () => {}, close: () => {} }) } as never,
      sidechatPush: { subscribe: () => ({ setWatch: () => {}, close: () => {} }) } as never,
    })
  }

  function jobsHub(): ReturnType<typeof createFsJobsPushHub> {
    return createFsJobsPushHub({
      warn: () => {},
      readTransfer: (id) => (id === 't-1' ? status : undefined),
      readArchive: () => undefined,
    })
  }

  it('shares one resource across connections on the same key; the last unsub releases it', () => {
    const hub = jobsHub()
    const handlers = feedOf(hub)
    const a = new FakeSocket()
    const b = new FakeSocket()
    a.feed(handlers)
    b.feed(handlers)
    for (const socket of [a, b]) {
      socket.receive({ op: 'sub', channel: 'fs-jobs', args: { jobs: ['t-1'] } })
    }

    // The subscribe-time snapshot reaches BOTH subscriptions (one hub seat
    // each, same underlying registry), in the envelope.
    const snapshot = { channel: 'fs-jobs', data: { kind: 'transfer', ...status } }
    expect(a.sent).toEqual([snapshot])
    expect(b.sent).toEqual([snapshot])

    // Live pushes fan out to both.
    hub.pushTransfer(status)
    expect(a.data()).toHaveLength(2)
    expect(b.data()).toHaveLength(2)

    // One unsub releases one seat: the OTHER keeps receiving.
    a.receive({ op: 'unsub', channel: 'fs-jobs', args: { jobs: ['t-1'] } })
    hub.pushTransfer(status)
    expect(a.data()).toHaveLength(2)
    expect(b.data()).toHaveLength(3)

    // The last unsub releases the last seat: nobody hears anything.
    b.receive({ op: 'unsub', channel: 'fs-jobs', args: { jobs: ['t-1'] } })
    hub.pushTransfer(status)
    expect(b.data()).toHaveLength(3)
    hub.dispose()
  })

  it('a disconnect releases the connection\'s subscriptions', () => {
    const hub = jobsHub()
    const socket = new FakeSocket()
    socket.feed(feedOf(hub))
    socket.receive({ op: 'sub', channel: 'fs-jobs', args: { jobs: ['t-1'] } })
    expect(socket.data()).toHaveLength(1)

    socket.fire('close')
    hub.pushTransfer(status)
    expect(socket.data()).toHaveLength(1)
    hub.dispose()
  })
})

describe('feed over the real session hub', () => {
  /** The REAL channel table against one real session hub (the others dummy). */
  function feedOf(hub: ReturnType<typeof createSessionPushHub>): Record<string, FeedChannelHandler> {
    return createFeedChannelHandlers({
      sessionRootOf: async () => '/session',
      agentOpenRegistry: { attach: () => () => {} },
      gitPush: { subscribe: () => ({ apply: async () => {}, close: () => {} }) } as never,
      fsJobsPush: { subscribe: () => ({ setJobs: () => {}, close: () => {} }) } as never,
      sessionPush: hub,
      sidechatPush: { subscribe: () => ({ setWatch: () => {}, close: () => {} }) } as never,
    })
  }

  it('session-scoped subs get their session\'s frames in the envelope, seed subs get the broadcasts', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSessionPushHub(ctx)
    const socket = new FakeSocket()
    socket.feed(feedOf(hub))
    socket.receive({ op: 'sub', channel: 'session', sessionId: 't1' })
    socket.receive({ op: 'sub', channel: 'session' })

    // The watched session's flip rides the envelope with its sessionId…
    emit('session/event', { id: 't1' }, { type: 'user/message', seq: 1 })
    expect(socket.sent[0]).toEqual({
      channel: 'session',
      sessionId: 't1',
      data: { kind: 'phase', sessionId: 't1', blank: false },
    })

    // …while the project-level seed broadcast rides the session-LESS
    // subscription alone (it has no session dimension to echo).
    hub.notifyHistorySeed('/work/alpha', true)
    expect(socket.sent.at(-1)).toEqual({
      channel: 'session',
      data: { kind: 'history-seed', cwd: '/work/alpha', seeding: true },
    })
    expect(socket.sent.filter(frame => 'data' in frame && (frame.data as { kind?: string }).kind === 'history-seed')).toHaveLength(1)

    // A sub the connection no longer holds hears nothing more.
    socket.receive({ op: 'unsub', channel: 'session', sessionId: 't1' })
    emit('session/event', { id: 't1' }, { type: 'tool/call', seq: 2 })
    vi.advanceTimersByTime(1_000)
    expect(socket.sent.filter(frame => 'data' in frame && (frame.data as { kind?: string }).kind === 'cwd')).toEqual([])
    hub.dispose()
  })
})

describe('feed over the real sidechat hub', () => {
  /** The REAL channel table against one real sidechat hub (the others dummy). */
  function feedOf(hub: ReturnType<typeof createSidechatPushHub>): Record<string, FeedChannelHandler> {
    return createFeedChannelHandlers({
      sessionRootOf: async () => '/session',
      agentOpenRegistry: { attach: () => () => {} },
      gitPush: { subscribe: () => ({ apply: async () => {}, close: () => {} }) } as never,
      fsJobsPush: { subscribe: () => ({ setJobs: () => {}, close: () => {} }) } as never,
      sessionPush: { subscribe: () => ({ watch: () => {}, close: () => {} }) } as never,
      sidechatPush: hub,
    })
  }

  it('per-thread subs and the global threads group ride one connection', () => {
    const { ctx, emit } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    socket.feed(feedOf(hub))
    socket.receive({ op: 'sub', channel: 'sidechat', sessionId: 't1' })
    socket.receive({ op: 'sub', channel: 'sidechat', args: { threads: true } })

    emit('session/event', { id: 't1' }, { type: 'assistant/message', seq: 1 })
    // Both coalescing windows fire inside 250ms — the durable per-thread one
    // at 60ms, the global threads group at its own 200ms.
    vi.advanceTimersByTime(250)
    expect(socket.data()).toEqual([
      { channel: 'sidechat', sessionId: 't1', data: { threadId: 't1' } },
      { channel: 'sidechat', data: { scope: 'threads' } },
    ])
    hub.dispose()
  })

  it('a sub with neither a thread nor the threads flag is refused', () => {
    const { ctx } = fakeCtx()
    const hub = createSidechatPushHub(ctx)
    const socket = new FakeSocket()
    socket.feed(feedOf(hub))
    socket.receive({ op: 'sub', channel: 'sidechat' })
    expect(socket.errors()).toEqual([
      { error: 'sidechat subscription watches nothing; pass sessionId or args.threads=true', channel: 'sidechat' },
    ])
    hub.dispose()
  })
})

describe('feed channel table (feed-channels.ts)', () => {
  /** A fake git hub recording what subscriptions it opened. */
  function fakeGitHub() {
    const opened: Array<{ cwdOf: () => Promise<string>; onFrame: (frame: unknown) => void; applied: string[][]; closed: number }> = []
    return {
      opened,
      hub: {
        subscribe: (options: { cwdOf: () => Promise<string>; onFrame: (frame: never) => void }) => {
          const entry = { cwdOf: options.cwdOf, onFrame: options.onFrame as (frame: unknown) => void, applied: [] as string[][], closed: 0 }
          opened.push(entry)
          return {
            apply: async (list: readonly string[]) => { entry.applied.push([...list]) },
            close: () => { entry.closed += 1 },
          }
        },
      },
    }
  }

  it('git requires a sessionId and applies the args.worktrees list', async () => {
    const git = fakeGitHub()
    const handlers = createFeedChannelHandlers({
      sessionRootOf: async () => '/session',
      agentOpenRegistry: { attach: () => () => {} },
      gitPush: git.hub as never,
      fsJobsPush: { subscribe: () => ({ setJobs: () => {}, close: () => {} }) } as never,
      sessionPush: { subscribe: () => ({ watch: () => {}, close: () => {} }) } as never,
      sidechatPush: { subscribe: () => ({ setWatch: () => {}, close: () => {} }) } as never,
    })
    const connection = new FeedConnection({ handlers, send: () => {} })

    // The session fence: the legacy endpoint closed the upgrade 1008, the
    // feed answers an error frame instead.
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'git' }))
    expect(git.opened).toHaveLength(0)

    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'git', sessionId: 's1', args: { worktrees: ['/repo/a', '/repo/b'] } }))
    expect(git.opened).toHaveLength(1)
    expect(git.opened[0]!.applied).toEqual([['/repo/a', '/repo/b']])
    expect(await git.opened[0]!.cwdOf()).toBe('/session')

    connection.handleRaw(JSON.stringify({ op: 'unsub', channel: 'git', sessionId: 's1', args: { worktrees: ['/repo/a', '/repo/b'] } }))
    expect(git.opened[0]!.closed).toBe(1)
  })

  it('agent-opens requires a sessionId and its seat lives until the unsub', () => {
    let seats = 0
    const handlers = createFeedChannelHandlers({
      sessionRootOf: async () => '/session',
      agentOpenRegistry: { attach: () => { seats += 1; return () => { seats -= 1 } } },
      gitPush: fakeGitHub().hub as never,
      fsJobsPush: { subscribe: () => ({ setJobs: () => {}, close: () => {} }) } as never,
      sessionPush: { subscribe: () => ({ watch: () => {}, close: () => {} }) } as never,
      sidechatPush: { subscribe: () => ({ setWatch: () => {}, close: () => {} }) } as never,
    })
    const connection = new FeedConnection({ handlers, send: () => {} })
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'agent-opens' }))
    expect(seats).toBe(0)
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'agent-opens', sessionId: 's1' }))
    expect(seats).toBe(1)
    connection.handleRaw(JSON.stringify({ op: 'unsub', channel: 'agent-opens', sessionId: 's1' }))
    expect(seats).toBe(0)
  })

  it('session subs watch their sessionId; the session-less sub is the seed sub', () => {
    const watched: Array<{ seed?: boolean; sessions: string[][] }> = []
    const handlers = createFeedChannelHandlers({
      sessionRootOf: async () => '/session',
      agentOpenRegistry: { attach: () => () => {} },
      gitPush: fakeGitHub().hub as never,
      fsJobsPush: { subscribe: () => ({ setJobs: () => {}, close: () => {} }) } as never,
      sessionPush: {
        subscribe: (options: { seed?: boolean; onFrame: (frame: never) => void }) => {
          const entry = { seed: options.seed, sessions: [] as string[][] }
          watched.push(entry)
          return {
            watch: (ids: readonly string[]) => { entry.sessions.push([...ids]) },
            close: () => {},
          }
        },
      } as never,
      sidechatPush: { subscribe: () => ({ setWatch: () => {}, close: () => {} }) } as never,
    })
    const connection = new FeedConnection({ handlers, send: () => {} })
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'session', sessionId: 't1' }))
    connection.handleRaw(JSON.stringify({ op: 'sub', channel: 'session' }))
    expect(watched).toEqual([
      { seed: false, sessions: [['t1']] },
      { seed: true, sessions: [] },
    ])
  })
})
