/**
 * FeedHub — the ONE multiplexed WebSocket every push consumer shares.
 *
 * The client used to open one socket per component instance (side chat per
 * tab, fs-watch per tree, agent-opens per sidebar shell) plus one per native
 * tab body (session) — with the host keeping every visited tab body mounted
 * (`keepMounted`), connections and memory grew linearly with the tab count.
 * The host now serves `/sidebar/ws/feed`, a MULTIPLEXED endpoint: one socket
 * carries any number of typed subscriptions, announced as control frames and
 * answered with per-subscription data frames.
 *
 * Wire contract (client → host), one JSON object per frame:
 *   {"op":"sub","channel":…,"sessionId"?:…,"args"?:…}
 *   {"op":"unsub","channel":…,"sessionId"?:…,"args"?:…}
 * with `channel` one of 'git' | 'fs-jobs' | 'session' | 'sidechat' |
 * 'agent-opens'. Host → client, two shapes:
 *   {"channel":…,"sessionId"?:…,"data":…}   — dispatched by channel+sessionId
 *   {"error":…,"channel"?,…}                — routed to the failing subscription
 *
 * A subscription is keyed by `channel + '\u0000' + (sessionId ?? '') +
 * '\u0000' + JSON.stringify(args ?? null)` and REFERENCE-COUNTED: the first
 * subscriber of a key opens the shared socket (if it is not open yet) and
 * announces the key, additional subscribers of the same key join it, and the
 * last unsubscriber retires the key — closing the socket when no key remains.
 * Reconnects back off 1s → 15s with ±30% jitter and NEVER give up (the push
 * rule); a successful re-open replays every active `sub` so the host re-seeds
 * its snapshots (the session/git watch answers ride that replay), and the
 * recovery fires each subscriber's `onReconnect` so one-shot consumers re-pull
 * what the outage swallowed. There is no HTTP polling fallback anywhere.
 *
 * 会话维度簿记（工作区切走延时释放，feed-release.ts）: the hub records every
 * subscription's session dimension, so the OLD session's subscriptions can be
 * suspended in one call (wire `unsub`, registry kept) and restored on the
 * switch back (wire `sub` + `onReconnect` so consumers re-pull). Sidechat is
 * excluded by design: its thread subscriptions are cross-workspace.
 * @module dsh-better-sidebar/feed-hub
 */
import { hostWebSocketUrl } from './host-route-url.ts'

/** The channels the feed endpoint multiplexes. */
export type FeedChannel = 'git' | 'fs-jobs' | 'session' | 'sidechat' | 'agent-opens'

/** One host data frame: which channel/session it belongs to and its payload. */
export interface FeedDataFrame {
  channel: string
  sessionId?: string
  data?: unknown
}

/** What one subscriber hands {@linkcode feedSubscribe}. */
export interface FeedSubscribeOptions {
  /** The channel to subscribe (the endpoint's first dispatch key). */
  channel: FeedChannel
  /**
   * The session dimension of the subscription, when the channel is
   * session-scoped (git / fs-jobs / session / agent-opens). Absent for
   * cross-workspace channels (sidechat).
   */
  sessionId?: string
  /**
   * The channel's filter payload (git's worktree union, fs-jobs' job union,
   * sidechat's thread set / threads group). Part of the subscription key:
   * a changed payload is a delta `unsub`+`sub` via
   * {@linkcode FeedSubscription.setArgs}.
   */
  args?: object
  /** One host payload of this subscription (already unwrapped from the envelope). */
  onData: (data: unknown, frame: FeedDataFrame) => void
  /** The host refused something about this subscription (an `error` frame). */
  onError?: (message: string) => void
  /**
   * The shared socket opened or closed while this subscription is live. A
   * subscriber that joins an ALREADY-open socket is told `true` immediately —
   * the open event it would otherwise have missed (the sidechat alignment
   * depends on it).
   */
  onState?: (open: boolean) => void
  /**
   * The socket re-opened after a drop, OR this subscription came back from a
   * session-dimension release — every frame in between is gone for good, so
   * the consumer re-pulls once.
   */
  onReconnect?: () => void
}

/** One live subscription: re-point its args, or unsubscribe (both idempotent). */
export interface FeedSubscription {
  /**
   * Replace the subscription's args payload (a delta `unsub` of the old key +
   * `sub` of the new one on the wire; other subscribers of the exact old key
   * keep it alive).
   */
  setArgs(args: object | undefined): void
  /** Unsubscribe this handle (idempotent; the key dies with its last handle). */
  close(): void
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000
/** Reconnect jitter fraction (±30%): the delay lands in [70%, 130%] of the step. */
const JITTER = 0.3

/**
 * The channels the 会话维度 release covers. Sidechat's thread subscriptions
 * are cross-workspace by design (floating windows and other tabs' threads
 * stay live across session switches), so they never suspend.
 */
const SESSION_SCOPED_CHANNELS: ReadonlySet<FeedChannel> = new Set<FeedChannel>(['session', 'git', 'fs-jobs', 'agent-opens'])

/** One subscriber handle's registration inside its key entry. */
interface FeedSubscriber {
  options: FeedSubscribeOptions
}

/**
 * One subscription key's registry entry: the reference-counted wire
 * subscription plus whoever shares it. `suspended` marks a session-dimension
 * release: the entry (and its subscribers) stay registered, but the wire
 * subscription is withdrawn and frames stop — until
 * {@linkcode feedRestoreSession} re-announces it.
 */
interface FeedEntry {
  channel: FeedChannel
  sessionId: string | undefined
  args: object | undefined
  /** Live handles sharing this exact key (the reference count). */
  handles: Set<FeedSubscriber>
  /** True while the session dimension is released (wire-unsubscribed). */
  suspended: boolean
}

/** The subscription registry, keyed by {@link subscriptionKey}. */
const entries = new Map<string, FeedEntry>()

let socket: WebSocket | null = null
let retry: number | undefined
let failures = 0
/** The FIRST open is not a reconnect (nothing was missed); only an open that
 * follows a successful connection's close is, because that gap swallowed frames. */
let connectedOnce = false
let dropped = false

/** Build the registry key of one subscription (NUL-joined — no part can contain one). */
function subscriptionKey(channel: FeedChannel, sessionId: string | undefined, args: object | undefined): string {
  return `${channel}\u0000${sessionId ?? ''}\u0000${JSON.stringify(args ?? null)}`
}

/** Jitter one backoff step into [1−JITTER, 1+JITTER] of itself. */
function jittered(delay: number): number {
  return Math.round(delay * (1 - JITTER + Math.random() * JITTER * 2))
}

/** Whether the shared socket is currently open. */
function isOpen(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN
}

/** Send one control frame when the socket can carry it. */
function sendControl(frame: Record<string, unknown>): void {
  if (isOpen()) socket?.send(JSON.stringify(frame))
}

/** The wire `sub` frame of one entry. */
function subFrame(entry: FeedEntry): Record<string, unknown> {
  return {
    op: 'sub',
    channel: entry.channel,
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
  }
}

/** The wire `unsub` frame of one entry. */
function unsubFrame(entry: FeedEntry): Record<string, unknown> {
  return {
    op: 'unsub',
    channel: entry.channel,
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
  }
}

/** Announce one entry's `sub` (a released entry announces nothing). */
function announce(entry: FeedEntry): void {
  if (entry.suspended) return
  sendControl(subFrame(entry))
}

/** Open (or keep) the shared socket; replay every live `sub` on open. */
function ensureConnection(): void {
  if (socket !== null || retry !== undefined) return
  const connect = (): void => {
    if (entries.size === 0) return
    socket = new WebSocket(hostWebSocketUrl('sidebar/ws/feed').toString())
    socket.onopen = () => {
      failures = 0
      const recovered = dropped
      dropped = false
      connectedOnce = true
      // Re-announce every live subscription: the host's watch answers
      // (session phase/cwd seeds, git/fs-jobs snapshots) ride this replay.
      for (const entry of [...entries.values()]) announce(entry)
      for (const entry of [...entries.values()]) {
        for (const subscriber of [...entry.handles]) {
          try {
            subscriber.options.onState?.(true)
            if (recovered) subscriber.options.onReconnect?.()
          } catch (error) {
            console.error('[dsh-better-sidebar] feed subscriber error:', error)
          }
        }
      }
    }
    socket.onmessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') return
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object') return
      if (typeof frame.error === 'string') {
        routeError(frame.error, frame)
        return
      }
      if (typeof frame.channel !== 'string') return
      routeData(frame as unknown as FeedDataFrame)
    }
    socket.onclose = () => {
      socket = null
      if (entries.size === 0) return
      for (const entry of [...entries.values()]) {
        if (!entry.suspended) dropped = true
      }
      for (const entry of [...entries.values()]) {
        for (const subscriber of [...entry.handles]) {
          try {
            subscriber.options.onState?.(false)
          } catch (error) {
            console.error('[dsh-better-sidebar] feed subscriber error:', error)
          }
        }
      }
      failures += 1
      // Throttled like the old per-socket loggers: the first drop, then
      // every 10th consecutive failure — a long outage cannot spam.
      if (failures === 1 || failures % 10 === 0) {
        console.error('[dsh-better-sidebar] feed socket dropped; reconnecting', { subscriptions: entries.size, failures })
      }
      const step = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
      retry = window.setTimeout(() => {
        retry = undefined
        if (entries.size > 0) connect()
      }, jittered(step))
    }
  }
  connect()
}

/** Tear the shared socket down (last subscription left). */
function closeConnection(): void {
  if (retry !== undefined) {
    window.clearTimeout(retry)
    retry = undefined
  }
  dropped = false
  connectedOnce = false
  failures = 0
  socket?.close()
  socket = null
}

/** Deliver one host data frame to the matching entries' subscribers. A frame
 * carrying a sessionId reaches only that session's entries; one without
 * (the session channel's project-scoped `history-seed`) fans out to every
 * entry of the channel — each consumer keeps its own claim filter. */
function routeData(frame: FeedDataFrame): void {
  for (const entry of [...entries.values()]) {
    if (entry.channel !== frame.channel || entry.suspended) continue
    if (typeof frame.sessionId === 'string' && entry.sessionId !== frame.sessionId) continue
    for (const subscriber of [...entry.handles]) {
      try {
        subscriber.options.onData(frame.data, frame)
      } catch (error) {
        // A throwing subscriber is CONTAINED, not allowed to starve the rest —
        // the same isolation every push module fans out with.
        console.error('[dsh-better-sidebar] feed subscriber error:', error)
      }
    }
  }
}

/** Deliver one host `error` frame to the failing subscription's subscribers:
 * the narrowest route the frame names (exact args match, else channel+
 * session, else the whole channel), falling back to everything when the
 * frame names no channel at all. */
function routeError(message: string, frame: Record<string, unknown>): void {
  const channel = typeof frame.channel === 'string' ? frame.channel : undefined
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
  const args = frame.args
  const argsKey = args !== undefined && typeof args === 'object' && args !== null
    ? subscriptionKey((channel ?? 'session') as FeedChannel, sessionId, args)
    : undefined
  for (const entry of [...entries.values()]) {
    if (channel !== undefined && entry.channel !== channel) continue
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue
    if (argsKey !== undefined && subscriptionKey(entry.channel, entry.sessionId, entry.args) !== argsKey) continue
    for (const subscriber of [...entry.handles]) {
      try {
        subscriber.options.onError?.(message)
      } catch (error) {
        console.error('[dsh-better-sidebar] feed subscriber error:', error)
      }
    }
  }
}

/**
 * Subscribe to the feed: joins (or creates) the key's reference-counted
 * entry, opening the shared socket on the first subscription of the run and
 * announcing the key on the wire. A subscriber joining an ALREADY-open socket
 * is synchronously told `true` through `onState` — the open event it would
 * otherwise have missed.
 * @param options - channel, session dimension, args payload and the callbacks.
 * @returns the subscription handle ({@linkcode FeedSubscription.setArgs} and
 *   {@linkcode FeedSubscription.close}, both idempotent).
 */
export function feedSubscribe(options: FeedSubscribeOptions): FeedSubscription {
  const subscriber: FeedSubscriber = { options }
  let entry = entries.get(subscriptionKey(options.channel, options.sessionId, options.args))
  let announceIt = false
  if (entry === undefined) {
    entry = { channel: options.channel, sessionId: options.sessionId, args: options.args, handles: new Set(), suspended: false }
    entries.set(subscriptionKey(entry.channel, entry.sessionId, entry.args), entry)
    announceIt = true
  } else if (entry.suspended) {
    // A re-entrant join of a released key restores it on the wire at once —
    // the component remounted inside the release window and must not wait
    // for the session-level restore.
    entry.suspended = false
    announceIt = true
  }
  entry.handles.add(subscriber)
  // The socket serves the ENTRY, not the join: make sure a live entry always
  // has a live (or retrying) socket behind it — normally a no-op (an entry
  // only exists while the socket does), but a caller whose teardown was
  // skipped (a crashed test, a forgotten disposer) must not wedge the hub
  // into "entries without a connection".
  ensureConnection()
  if (announceIt) announce(entry)
  if (isOpen()) options.onState?.(true)
  const self = {
    setArgs(next: object | undefined): void {
      const current = entries.get(subscriptionKey(entry!.channel, entry!.sessionId, entry!.args))
      if (current === undefined || !current.handles.has(subscriber)) return
      if (next === undefined) return
      const nextKey = subscriptionKey(entry!.channel, entry!.sessionId, next)
      if (nextKey === subscriptionKey(entry!.channel, entry!.sessionId, entry!.args)) return
      current.handles.delete(subscriber)
      if (current.handles.size === 0) {
        if (entries.get(nextKey) === undefined) sendControl(unsubFrame(current))
        entries.delete(subscriptionKey(current.channel, current.sessionId, current.args))
      }
      const existing = entries.get(nextKey)
      if (existing !== undefined) {
        // Join the entry the new args already have (another handle lives
        // there); restore it if the release caught it.
        entry = existing
        entry.handles.add(subscriber)
        if (entry.suspended) {
          entry.suspended = false
          announce(entry)
        }
        return
      }
      entry = { channel: current.channel, sessionId: current.sessionId, args: next, handles: new Set([subscriber]), suspended: false }
      entries.set(nextKey, entry)
      announce(entry)
    },
    close(): void {
      const current = entries.get(subscriptionKey(entry!.channel, entry!.sessionId, entry!.args))
      if (current === undefined || !current.handles.delete(subscriber)) return
      if (current.handles.size > 0) return
      const last = entries.size === 1
      if (!last) sendControl(unsubFrame(current))
      entries.delete(subscriptionKey(current.channel, current.sessionId, current.args))
      // The LAST subscription of the run closes the shared socket (the
      // "或按保活策略保留" alternative is not used: zero consumers means
      // zero connections).
      if (last) closeConnection()
    },
  }
  return self
}

/**
 * Suspend every session-scoped subscription of one session (the wire `unsub`
 * half of the 会话切走延时释放): registry entries and their callbacks stay,
 * frames stop. Sidechat is never suspended (cross-workspace by design).
 * @param sessionId - the session that lost its active seat.
 */
export function feedReleaseSession(sessionId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.suspended || entry.sessionId !== sessionId) continue
    if (!SESSION_SCOPED_CHANNELS.has(entry.channel)) continue
    entry.suspended = true
    sendControl(unsubFrame(entry))
  }
}

/**
 * Re-announce every suspended subscription of one session (the switch-back
 * half of the release): the wire `sub` re-seeds the host snapshots, and each
 * subscriber's `onReconnect` fires so one-shot consumers re-pull the frames
 * the release window swallowed. A session with nothing suspended is a no-op.
 * @param sessionId - the session that became active again.
 */
export function feedRestoreSession(sessionId: string): void {
  for (const entry of [...entries.values()]) {
    if (!entry.suspended || entry.sessionId !== sessionId) continue
    entry.suspended = false
    announce(entry)
    for (const subscriber of [...entry.handles]) {
      try {
        subscriber.options.onReconnect?.()
      } catch (error) {
        console.error('[dsh-better-sidebar] feed subscriber error:', error)
      }
    }
  }
}

/** Test seam: how many registry entries are live right now. */
export function feedEntryCountForTests(): number {
  return entries.size
}

/** Test seam: tear the singleton down (socket + registry) so a spec whose
 *  subjects do not always retire every subscription starts each test clean. */
export function feedHubResetForTests(): void {
  closeConnection()
  entries.clear()
}
