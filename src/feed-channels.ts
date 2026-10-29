/**
 * The feed endpoint's per-channel subscription table.
 *
 * Each channel opens its subscriptions through the very same hub/registry
 * seam the legacy `/sidebar/ws/*` endpoint shells use — one implementation
 * per channel, two transports. What a sub means per channel (the session
 * dimension is the control frame's `sessionId`, the rest rides `args`):
 *
 * - `agent-opens`: sessionId REQUIRED (the queue's scope). args: none.
 *   Frames: the open request verbatim, envelope sessionId always present.
 * - `git`: sessionId REQUIRED (the session fence; the legacy endpoint's
 *   missing-sessionId 1008 close becomes an error frame here). args:
 *   `{ worktrees?: string[] }` — the FULL replacement watch list, fixed
 *   for the sub's lifetime (a changed list is a new key: unsub the old,
 *   sub the new; shared worktrees keep their refcounted watchers).
 * - `fs-jobs`: sessionId optional (the archive fence; transfers are
 *   capability-scoped by their uuid either way). args:
 *   `{ jobs?: string[] }` — the full replacement watched-job set; every
 *   newly watched id is answered with its CURRENT snapshot (the
 *   subscribe-time snapshot the legacy socket also answers with).
 * - `session`: sessionId optional. Present = ONE watched session (its
 *   phase/cwd/history/turn/ops frames, watch-time answers included; the
 *   project-level seed broadcast stays off this sub). Absent = the
 *   project-level subscription: it hears the `history-seed` broadcasts
 *   (which are project-scoped, no session dimension) and nothing else.
 * - `sidechat`: sessionId optional (the thread id — a sidechat thread IS a
 *   session). Present = that thread's stale-transcript notices. Absent =
 *   only the GLOBAL thread-set group, and only with `args.threads === true`;
 *   a sub with neither a sessionId nor the threads flag watches nothing and
 *   is refused (an accepted dead sub would strand the client). A threads
 *   sub re-arms its census roots through the `watch` op (`input.roots`) —
 *   the data mode that replaces the legacy data-free invalidation frames.
 *
 * Envelope rule (ws-feed.ts): every frame rides
 * `{"channel","sessionId"?,"data"}` with `sessionId` echoing the sub's own
 * session dimension, so the client routes a frame by its subscription, not
 * by parsing channel-specific shapes.
 * @module dsh-better-sidebar/feed-channels
 */
import type { AgentOpenRegistry } from './agent-opens.ts'
import type { FsJobsPushHub } from './fs-jobs-push.ts'
import type { GitWatchHub } from './git-push.ts'
import type { SessionPushHub } from './session-push.ts'
import type { SidechatPushHub } from './sidechat-push.ts'
import type { FeedChannelHandler } from './ws-feed.ts'

/** Everything the channel table needs, all of it shared with the legacy shells. */
export interface FeedChannelDeps {
  /**
   * One session's workspace root — the same cwd chain every git route
   * resolves against, so the watched worktrees are the ones the git
   * inventory answers with.
   */
  sessionRootOf(sessionId: string): Promise<string>
  /** The sidebar_open registry (the legacy agent-opens endpoint's own). */
  agentOpenRegistry: Pick<AgentOpenRegistry, 'attach'>
  gitPush: Pick<GitWatchHub, 'subscribe'>
  fsJobsPush: Pick<FsJobsPushHub, 'subscribe'>
  /**
   * Built with the live `session.phase` / `session.cwd` answers (the same
   * sources the legacy `/sidebar/ws/session` hub resolves through), so the
   * feed's session channel serves the very same frames.
   */
  sessionPush: Pick<SessionPushHub, 'subscribe'>
  sidechatPush: Pick<SidechatPushHub, 'subscribe'>
}

/**
 * The string list one feed sub's args names under `field`
 * (`args.worktrees`, `args.jobs`); absent/malformed = empty.
 */
function stringListOf(args: unknown, field: string): string[] {
  if (args === null || typeof args !== 'object') return []
  const raw = (args as Record<string, unknown>)[field]
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string' && value !== '')
    : []
}

/** The sidechat sub's `args.threads` flag. */
function threadsFlagOf(args: unknown): boolean {
  return args !== null && typeof args === 'object' && (args as Record<string, unknown>).threads === true
}

/**
 * The sidechat `watch` frame's census roots (`input.roots`, the string list;
 * absent/malformed = none — the subscription then stays in legacy mode).
 * The roots deliberately do NOT ride `args`: they change with the client's
 * session list, and the subscription key must not tear every time they do.
 */
function threadsRootsOf(input: unknown): string[] {
  if (input === null || typeof input !== 'object') return []
  const raw = (input as Record<string, unknown>).roots
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string' && value !== '')
    : []
}

/**
 * Assemble the feed's channel table.
 * @param deps - the shared hubs/registry plus the session-cwd chain.
 * @returns one handler per channel name; unknown names are refused by the
 *   multiplexer before a handler is ever consulted.
 */
export function createFeedChannelHandlers(deps: FeedChannelDeps): Record<string, FeedChannelHandler> {
  return {
    'agent-opens': {
      open: ({ sessionId, send }) => {
        if (sessionId === undefined) return { error: 'sessionId is required' }
        // The registry's per-session seat: replays queued opens, and the
        // disposer detaches the view again (the last unsubscribe releases
        // the seat — the registry's own refcount semantics).
        return { dispose: deps.agentOpenRegistry.attach(sessionId, (request) => { send(request) }) }
      },
    },
    'git': {
      open: ({ sessionId, args, send }) => {
        // The session fence the legacy endpoint enforced with a 1008 close
        // on the upgrade: an error frame here, the connection stays up.
        if (sessionId === undefined) return { error: 'sessionId is required' }
        const subscription = deps.gitPush.subscribe({
          cwdOf: async () => deps.sessionRootOf(sessionId),
          onFrame: send,
        })
        void subscription.apply(stringListOf(args, 'worktrees'))
        return { dispose: () => { subscription.close() } }
      },
    },
    'fs-jobs': {
      open: ({ sessionId, args, send }) => {
        const subscription = deps.fsJobsPush.subscribe({ sessionId, onFrame: send })
        // The subscribe-time snapshot rides setJobs (newly watched ids are
        // answered with their current status), exactly like the legacy
        // socket's first watch frame.
        subscription.setJobs(stringListOf(args, 'jobs'))
        return { dispose: () => { subscription.close() } }
      },
    },
    'session': {
      open: ({ sessionId, send }) => {
        // sessionId present = one watched session (seed broadcast off);
        // absent = the project-level seed-state subscription (watches no
        // session, hears the `history-seed` broadcasts).
        const subscription = deps.sessionPush.subscribe({
          onFrame: send,
          seed: sessionId === undefined,
        })
        if (sessionId !== undefined) subscription.watch([sessionId])
        return { dispose: () => { subscription.close() } }
      },
    },
    'sidechat': {
      open: ({ sessionId, args, send }) => {
        const threads = threadsFlagOf(args)
        if (sessionId === undefined && !threads) {
          return { error: 'sidechat subscription watches nothing; pass sessionId or args.threads=true' }
        }
        const subscription = deps.sidechatPush.subscribe({ onFrame: send })
        const watchSet = sessionId === undefined ? [] : [sessionId]
        // The sub opens in LEGACY threads mode (no roots yet): the data-free
        // invalidation frames until the client's `watch` frame reports the
        // census roots — which flips the SAME subscription into data mode.
        subscription.setWatch(watchSet, threads)
        return {
          dispose: () => { subscription.close() },
          // The census roots ride the `watch` op on this exact key (never
          // `args` — the key must not tear when the session list changes).
          // Every watch re-runs the alignment snapshot server-side, so the
          // client never needs a join/reconnect pull.
          watch: ({ input }) => { subscription.setWatch(watchSet, threads, threadsRootsOf(input)) },
        }
      },
    },
  }
}
