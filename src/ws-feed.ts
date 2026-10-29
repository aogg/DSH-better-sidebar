/**
 * The multiplexed feed WebSocket behind `/sidebar/ws/feed`.
 *
 * The plugin used to cost one connection PER CONCERN: each sidebar component
 * instance opened its own socket to `/sidebar/ws/git`, `/sidebar/ws/fs-jobs`,
 * `/sidebar/ws/session`, `/sidebar/ws/sidechat` or `/sidebar/ws/agent-opens`,
 * so one view with a git lens, a running transfer, the session phase and a
 * side-chat thread held four sockets where one would do — each with its own
 * upgrade, its own watcher set on the host and its own reconnect loop on the
 * client. This endpoint multiplexes all five push channels over ONE socket.
 *
 * The wire protocol (frozen; the client half speaks the same one):
 *
 * - Control frames (client→server):
 *   `{"op":"sub"|"unsub","channel":…,"sessionId"?:string,"args"?:object}`
 *   with `channel` one of `agent-opens` `git` `fs-jobs` `session` `sidechat`,
 *   plus the `watch` update frame
 *   `{"op":"watch","channel":…,"sessionId"?:string,"args"?:object,"input"?:…}`
 *   that re-arms an ALREADY-live subscription's computation input (its exact
 *   `channel + sessionId + args` key must exist; `input` is the channel's
 *   own watch payload). The point: a channel whose watch input changes per
 *   keystroke — sidechat's census roots — must update WITHOUT tearing the
 *   refcounted subscription, so the volatile part rides `watch`/`input` and
 *   the KEY stays stable.
 * - The subscription key is
 *   `channel + '\u0000' + (sessionId ?? '') + '\u0000' + JSON.stringify(args ?? null)`;
 *   an `unsub` removes exactly the key an equal `sub` opened — different args
 *   (or a different sessionId) never remove anything. A repeated identical
 *   `sub` is idempotent: the live subscription is kept, not doubled.
 * - Data frames (server→client):
 *   `{"channel":…,"sessionId"?:…,"data":<the channel's native frame verbatim>}`.
 *   `sessionId` echoes the subscription's own session dimension; it is
 *   omitted when the subscription has none (e.g. the session channel's
 *   project-level seed subscription, the sidechat threads group).
 * - Error frames: `{"error":…,"channel"?:…,"sessionId"?:…}` — a refused
 *   frame (unknown channel/op, malformed frame, a `watch` naming no live
 *   subscription, a channel that takes no watch input, a channel's session
 *   fence) is answered and the CONNECTION STAYS UP. Only the HTTP upgrade's
 *   trust fence (the same one every endpoint applies) still destroys the
 *   socket.
 *
 * Resources are per (channel, key): each subscription holds its channel's
 * server-side resource (a watcher set, a registry seat, a watch list) and
 * the last unsubscribe/disconnect releases it — the same refcount semantics
 * the per-endpoint hubs already implement for their sockets, now applied per
 * subscription instead of per connection. A disconnect releases every
 * subscription the connection held.
 * @module dsh-better-sidebar/ws-feed
 */
import type { WebSocket } from 'ws'

/** The channels the feed multiplexes (fs-watch is retired, not multiplexed). */
export type FeedChannel = 'agent-opens' | 'git' | 'fs-jobs' | 'session' | 'sidechat'

/** Every channel name the feed accepts. */
export const FEED_CHANNELS: readonly FeedChannel[] = ['agent-opens', 'git', 'fs-jobs', 'session', 'sidechat']

/** Server→client data frame: the channel's native frame in its envelope. */
export interface FeedDataFrame {
  channel: FeedChannel
  /** The subscription's session dimension; omitted when it has none. */
  sessionId?: string
  /** The channel's native frame, verbatim. */
  data: unknown
}

/** Server→client error frame: one refused frame; the connection stays up. */
export interface FeedErrorFrame {
  error: string
  /** The refused frame's channel, when it named one. */
  channel?: string
  /** The refused frame's sessionId, when it carried one. */
  sessionId?: string
}

/** Anything the feed writes to the wire. */
export type FeedOutboundFrame = FeedDataFrame | FeedErrorFrame

/** Client→server control frame. */
export interface FeedControlFrame {
  op?: unknown
  channel?: unknown
  sessionId?: unknown
  args?: unknown
  /** The `watch` op's channel-specific payload (opaque to the multiplexer). */
  input?: unknown
}

/**
 * One `watch` request, as its channel handler sees it: the SAME coordinates
 * the subscription was opened under (so the handler can tell which one is
 * being re-armed) plus the channel-specific input.
 */
export interface FeedWatchRequest {
  /** The session dimension (`undefined` = project/global scope). */
  readonly sessionId: string | undefined
  /** The sub frame's args (an object, or `null` when absent). */
  readonly args: unknown
  /** The watch payload the channel interprets. */
  readonly input: unknown
}

/**
 * The subscription key of one (channel, sessionId, args) triple.
 *
 * Exported because the client half must compute the SAME key for its `unsub`
 * frames, and because the specs assert the exact match rule through it.
 */
export function feedSubscriptionKey(channel: string, sessionId: string | undefined, args: unknown): string {
  return `${channel}\u0000${sessionId ?? ''}\u0000${JSON.stringify(args ?? null)}`
}

/** One accepted subscription, as its channel handler sees it. */
export interface FeedChannelRequest {
  /** The session dimension (`undefined` = project/global scope). */
  readonly sessionId: string | undefined
  /** The sub frame's args (an object, or `null` when absent). */
  readonly args: unknown
  /** Deliver one native channel frame to THIS subscription alone. */
  readonly send: (data: unknown) => void
}

/** One live subscription's teardown (idempotent), plus its optional watch
 *  seam (the `watch` control op's target — a channel without volatile input
 *  omits it and such frames are refused). */
export interface FeedSubscription {
  dispose(): void
  /** Re-arm the subscription's computation input (the `watch` control op). */
  watch?(request: FeedWatchRequest): void
}

/** A channel's refusal of one sub: the feed answers an error frame, nothing opens. */
export interface FeedOpenError {
  error: string
}

/** The per-channel seam the host assembles once at mount (see feed-channels.ts). */
export interface FeedChannelHandler {
  /** Open one subscription; return its disposer, or the refusal reason. */
  open(request: FeedChannelRequest): FeedSubscription | FeedOpenError
}

/** Options of one feed connection. */
export interface FeedConnectionOptions {
  /** The channel table; an unknown channel is refused with an error frame. */
  readonly handlers: Readonly<Record<string, FeedChannelHandler>>
  /** Deliver one outbound frame (the connection's socket). */
  readonly send: (frame: FeedOutboundFrame) => void
  /** Live subscriptions per connection (a resource guard, not a policy). */
  readonly maxSubscriptions?: number
}

/** Subscriptions one connection may hold. */
const DEFAULT_MAX_SUBSCRIPTIONS = 256

/**
 * One connection's subscription table.
 *
 * The multiplexer itself knows nothing about the channels: it validates
 * frames, keeps (connection, key) → disposer, folds native frames into the
 * envelope, and releases everything on close. Every channel semantic lives
 * in its handler.
 */
export class FeedConnection {
  private readonly handlers: Readonly<Record<string, FeedChannelHandler>>
  private readonly send: (frame: FeedOutboundFrame) => void
  private readonly maxSubscriptions: number
  private readonly entries = new Map<string, {
    dispose: () => void
    watch?: (request: FeedWatchRequest) => void
  }>()
  private closed = false

  constructor(options: FeedConnectionOptions) {
    this.handlers = options.handlers
    this.send = options.send
    this.maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS
  }

  /** Apply one raw inbound frame (unparseable input answers an error frame). */
  handleRaw(data: unknown): void {
    if (this.closed) return
    let frame: FeedControlFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as FeedControlFrame
    } catch {
      this.refuse('invalid frame')
      return
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      this.refuse('invalid frame')
      return
    }
    const channel = typeof frame.channel === 'string' ? frame.channel : undefined
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    if (frame.op !== 'sub' && frame.op !== 'unsub' && frame.op !== 'watch') {
      this.refuse(frame.op === undefined ? 'missing op' : `unknown op ${String(frame.op)}`, channel, sessionId)
      return
    }
    if (channel === undefined) {
      this.refuse(frame.channel === undefined ? 'missing channel' : `unknown channel ${String(frame.channel)}`)
      return
    }
    if (!FEED_CHANNELS.includes(channel as FeedChannel)) {
      this.refuse(`unknown channel ${channel}`, channel, sessionId)
      return
    }
    if (frame.sessionId !== undefined && typeof frame.sessionId !== 'string') {
      this.refuse('sessionId must be a string', channel, sessionId)
      return
    }
    if (frame.args !== undefined && frame.args !== null && (typeof frame.args !== 'object' || Array.isArray(frame.args))) {
      this.refuse('args must be an object', channel, sessionId)
      return
    }
    const key = feedSubscriptionKey(channel, sessionId, frame.args ?? null)
    if (frame.op === 'unsub') {
      // Only the key an equal sub opened is removed; anything else is a
      // silent no-op (a client unsubscribing what it never subscribed).
      const entry = this.entries.get(key)
      if (entry !== undefined) {
        this.entries.delete(key)
        entry.dispose()
      }
      return
    }
    if (frame.op === 'watch') {
      // Re-arm a LIVE subscription's computation input. No key, no watch —
      // a frame racing the subscription's teardown is refused (the client's
      // next sub + watch replay re-arms it on the fresh subscription).
      const entry = this.entries.get(key)
      if (entry === undefined) {
        this.refuse('watch names no live subscription', channel, sessionId)
        return
      }
      if (entry.watch === undefined) {
        this.refuse(`channel ${channel} takes no watch input`, channel, sessionId)
        return
      }
      entry.watch({ sessionId, args: frame.args ?? null, input: frame.input })
      return
    }
    // A repeated identical sub keeps the live subscription: opening a second
    // one over the map entry would orphan the first's server-side resource.
    if (this.entries.has(key)) return
    if (this.entries.size >= this.maxSubscriptions) {
      this.refuse('too many subscriptions', channel, sessionId)
      return
    }
    const args = frame.args ?? null
    const handler = this.handlers[channel]
    if (handler === undefined) {
      // The table is assembled once at mount; a channel it does not carry is
      // refused exactly like an unknown name (never a throw mid-frame).
      this.refuse(`unknown channel ${channel}`, channel, sessionId)
      return
    }
    // `live` guards the envelope against a frame a disposed subscription's
    // channel still had in flight (the async resolvers): once disposed, the
    // channel's own closed flag drops the frame — and this drops the envelope.
    let live = true
    const outcome = handler.open({
      sessionId,
      args,
      send: (data) => {
        // The FEED_CHANNELS.includes guard above proved the name; the cast
        // carries that proof into deliver's typed envelope routing.
        if (live) this.deliver(channel as FeedChannel, sessionId, data)
      },
    })
    if ('error' in outcome) {
      this.refuse(outcome.error, channel, sessionId)
      return
    }
    if (this.closed) {
      // The connection died while the channel was opening its resource.
      outcome.dispose()
      return
    }
    this.entries.set(key, {
      dispose: () => {
        live = false
        outcome.dispose()
      },
      // The channel's own watch seam (absent = watch frames refused).
      ...(outcome.watch !== undefined ? { watch: (request: FeedWatchRequest) => { outcome.watch?.(request) } } : {}),
    })
  }

  /** Release every subscription (connection close/error); idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const entry of [...this.entries.values()]) entry.dispose()
    this.entries.clear()
  }

  /** Whether this connection holds that exact subscription (a test seam). */
  holds(channel: string, sessionId: string | undefined, args: unknown): boolean {
    return this.entries.has(feedSubscriptionKey(channel, sessionId, args))
  }

  /** Fold one native channel frame into its envelope and write it. */
  private deliver(channel: FeedChannel, sessionId: string | undefined, data: unknown): void {
    if (this.closed) return
    this.send({ channel, ...(sessionId !== undefined ? { sessionId } : {}), data })
  }

  /** Answer one refused frame (the connection stays up). */
  private refuse(error: string, channel?: string, sessionId?: string): void {
    if (this.closed) return
    this.send({
      error,
      ...(channel !== undefined ? { channel } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    })
  }
}

/**
 * Wire one accepted WebSocket to a feed connection — the endpoint shell's
 * whole job: control frames in, envelopes out, close/error releases every
 * subscription.
 * @param handlers - the channel table (see feed-channels.ts).
 * @param ws - the accepted socket.
 * @param options - forwarded to the connection (the per-connection cap).
 * @returns the connection (the specs drive it directly).
 */
export function attachFeedSocket(
  handlers: Readonly<Record<string, FeedChannelHandler>>,
  ws: WebSocket,
  options?: { maxSubscriptions?: number },
): FeedConnection {
  const connection = new FeedConnection({
    handlers,
    send: (frame) => {
      try {
        ws.send(JSON.stringify(frame))
      } catch {
        // A send on a dying socket is expected; the close handler cleans up.
      }
    },
    ...options,
  })
  ws.on('message', (data: unknown) => { connection.handleRaw(data) })
  ws.on('close', () => { connection.close() })
  ws.on('error', () => { connection.close() })
  return connection
}
