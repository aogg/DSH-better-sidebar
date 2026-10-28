/**
 * The shared git-status store's PUSH contract (the phase-2 polling rule: no
 * timer may drive a fetch — every invalidation arrives on the session's
 * `/sidebar/ws/git` socket).
 *
 * One fetch here is `git status --untracked-files=all` plus two `--numstat`
 * diffs, so a refresh is real work. What the store now guarantees:
 *
 *  - SUBSCRIPTION: the first answer names the checkout (`snapshot.root`),
 *    and the slot subscribes to its session's git socket with exactly that
 *    worktree as the watch set. No consumer can keep a timer running,
 *    because there is no timer — a held slot only fetches when the host
 *    says something moved (the deprecated `poll`/`pollMs` options are
 *    accepted no-ops).
 *  - SHARING: every visible consumer of a key holds the SAME subscription;
 *    one notice re-pulls the snapshot once, not once per consumer, and the
 *    last consumer's release closes the socket.
 *  - SILENCE: a notice that returns an equal status notifies nobody — the
 *    version counter is the `useSyncExternalStore` snapshot, and bumping it
 *    re-rendered every consumer (the file tree's rows included) for nothing.
 *  - RECONNECT: the socket's re-open after a drop fires one catch-up pull
 *    (the outage swallowed notices), and the watch set is re-announced.
 *  - COALESING: a notice landing while a fetch is in flight queues exactly
 *    one trailing pull; an error state recovers on the next notice.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import type { GitStatusResult, SessionScope } from '../src/client/api.ts'

const { gitStatus, gitStatusPaths } = vi.hoisted(() => ({ gitStatus: vi.fn(), gitStatusPaths: vi.fn() }))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, gitStatus, gitStatusPaths } }
})

import { renderRoot, setupReactAct } from './test-utils.ts'
import { useGitStatus, type GitStatusView } from '../src/client/ui/git-status.ts'
import { feedHubResetForTests } from '../src/client/feed-hub.ts'

setupReactAct()

const REPO: GitStatusResult = {
  isRepo: true,
  root: '/tmp',
  entries: [{ path: 'a.ts', xy: ' M' }],
}

/** The scope of one test; a fresh sessionId mints a fresh slot. */
const scopeFor = (id: string): SessionScope => ({ sessionId: id, cwd: '/tmp' })

/** Commits observed for the probe component (not renders — see Probe). */
interface Counter { value: number }

/** The view the probe most recently received, for the event-driven cases. */
let latest: GitStatusView | null = null

function Probe(props: { scope: SessionScope; poll?: boolean; visible?: boolean; commits: Counter }): ReactNode {
  const view = useGitStatus(props.scope, { poll: props.poll, visible: props.visible })
  // One per COMMIT: the store's only observable is the version counter behind
  // `useSyncExternalStore`, so a commit is exactly "the store notified".
  useEffect(() => { props.commits.value += 1 })
  latest = view
  return createElement('span')
}

/** Let the store's in-flight fetch settle (inside act — it notifies React). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Advance the fake clock, letting the store's promises settle inside act. */
async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/**
 * A controllable WebSocket double: the store's slot subscribes through
 * `subscribeGitWatch`, which opens the session's `/sidebar/ws/git` socket —
 * the double records every instance so a test can open, drop and feed it.
 */
class GitSocket {
  static readonly OPEN = 1
  readonly sent: string[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { gitSockets.push(this) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
}

/** Every socket double of the current test. */
const gitSockets: GitSocket[] = []

/** The feed sockets (the `/sidebar/ws/feed` multiplexer) — the git watch
 *  AND the session turn subscription now ride the SAME socket, so both
 *  helpers answer the same list; the frames distinguish the channels. */
function gitSocketsOf(): GitSocket[] {
  return gitSockets.filter(socket => socket.url.includes('ws/feed'))
}

/** The feed sockets (the turn subscription shares the git watch's socket). */
function turnSocketsOf(): GitSocket[] {
  return gitSockets.filter(socket => socket.url.includes('ws/feed'))
}

/** The sessionIds a socket subscribed on one channel, from its sent subs. */
function subscribedSessions(socket: GitSocket, channel: string): string[] {
  const ids: string[] = []
  for (const frame of socket.sent) {
    try {
      const parsed = JSON.parse(frame) as { op?: string; channel?: string; sessionId?: string }
      if (parsed.op === 'sub' && parsed.channel === channel && typeof parsed.sessionId === 'string') ids.push(parsed.sessionId)
    } catch {
      // Not a control frame.
    }
  }
  return ids
}

/** Complete every pending upgrade (the connector answers with its watch set). */
function openGitSockets(): void {
  for (const socket of gitSockets) {
    if (socket.closed || socket.readyState === GitSocket.OPEN) continue
    socket.readyState = GitSocket.OPEN
    socket.onopen?.()
  }
}

/** Deliver one host `git` frame naming `worktree` to every feed socket,
 *  once per session the socket subscribed on the git channel (the envelope's
 *  sessionId is the hub's routing key). */
async function gitFrame(worktree: string, paths?: string[]): Promise<void> {
  openGitSockets()
  await act(async () => {
    for (const socket of gitSocketsOf()) {
      if (socket.closed) continue
      for (const sessionId of subscribedSessions(socket, 'git')) {
        socket.onmessage?.({ data: JSON.stringify({ channel: 'git', sessionId, data: { kind: 'git', worktree, ...(paths !== undefined ? { paths } : {}) } }) })
      }
    }
  })
}

/** Deliver one `turn` frame of `sessionId` to every live session socket. */
async function turnFrame(sessionId: string): Promise<void> {
  openGitSockets()
  await act(async () => {
    for (const socket of turnSocketsOf()) {
      if (socket.closed) continue
      socket.onmessage?.({ data: JSON.stringify({ channel: 'session', sessionId, data: { kind: 'turn', sessionId } }) })
    }
  })
}

/** Tear every open socket down the way a dropped connection does: a dead
 *  transport can never deliver a frame again. */
function dropGitSockets(): void {
  for (const socket of gitSockets) {
    if (socket.closed || socket.readyState !== GitSocket.OPEN) continue
    socket.readyState = 3
    socket.onmessage = null
    socket.onclose?.()
  }
}

let mounted: ReturnType<typeof renderRoot> | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  latest = null
  gitStatus.mockReset()
  gitStatusPaths.mockReset()
  vi.unstubAllGlobals()
  gitSockets.length = 0
  // The feed hub is a module singleton: a test whose subjects do not retire
  // every subscription must not leak its entries (and their dead socket)
  // into the next one.
  feedHubResetForTests()
  localStorage.clear()
  vi.useRealTimers()
})

describe('the shared git status store cadence', () => {
  it('never fetches again for a poll:false consumer without a notice', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('poll-off'), poll: false, commits }))
    await tick(0)
    await flush()
    // The one reading a non-polling consumer is entitled to.
    expect(gitStatus).toHaveBeenCalledTimes(1)
    await tick(120_000)
    expect(gitStatus).toHaveBeenCalledTimes(1)
  })

  it('subscribes the slot to its session git socket once the first answer names the checkout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('poll-on'), commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    // The subscription follows the first answer (it names the checkout the
    // slot watches): ONE git socket for the session, fenced by its sessionId
    // (the store's turn socket for the same session is a separate URL).
    expect(gitSocketsOf()).toHaveLength(1)
    expect(gitSocketsOf()[0]!.url).toContain('/sidebar/ws/feed')
    openGitSockets()
    // The watch rides the channel's sub frame now (session + args on it);
    // the visible slot's turn subscription shares the socket (session
    // channel, no args).
    expect(gitSocketsOf()[0]!.sent).toEqual([
      JSON.stringify({ op: 'sub', channel: 'session', sessionId: 'poll-on' }),
      JSON.stringify({ op: 'sub', channel: 'git', sessionId: 'poll-on', args: { worktrees: ['/tmp'] } }),
    ])

    // The cadence is gone with the poller: no timer re-fetches anything…
    await tick(120_000)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    // …while a host notice of the checkout re-pulls ONCE.
    await gitFrame('/tmp')
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // A notice for a checkout the slot does not watch is filtered by the hub.
    await gitFrame('/other/worktree')
    expect(gitStatus).toHaveBeenCalledTimes(2)
  })

  it('shares one subscription across every visible consumer, whatever order they arrived in', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    const scope = scopeFor('shared-sub')
    // Both mount in one commit; effects run in tree order, so the first
    // consumer retains the slot before the second joins it.
    const tree = (withSecond: boolean): ReactNode => createElement('div', null,
      createElement(Probe, { scope, poll: false, commits }),
      withSecond ? createElement(Probe, { scope, poll: true, commits }) : null,
    )
    mounted = renderRoot(tree(true))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(gitSocketsOf()).toHaveLength(1)

    // ONE notice re-pulls the shared snapshot once — not once per consumer.
    await gitFrame('/tmp')
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // One consumer leaves: the other still holds the answer AND the socket…
    mounted.rerender(tree(false))
    await flush()
    expect(latest?.snapshot).not.toBeNull()
    await gitFrame('/tmp')
    expect(gitStatus).toHaveBeenCalledTimes(3)

    // …and the LAST consumer's release closes the socket with it: a late
    // notice for the slot's checkout reaches nobody (both the git watch
    // and the turn subscription die with the release).
    mounted.unmount()
    await flush()
    expect(gitSocketsOf()[0]!.closed).toBe(true)
    expect(turnSocketsOf()[0]!.closed).toBe(true)
    await gitFrame('/tmp')
    expect(gitStatus).toHaveBeenCalledTimes(3)
  })

  it('stays silent when an idle notice returns the same status', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('idle-silent'), commits }))
    await tick(0)
    await flush()
    const settled = commits.value
    expect(settled).toBeGreaterThan(0)

    // One notice runs (a NEW object every time), the status is equal, so no
    // consumer may be told anything. Without the guard this bumps the
    // version and the probe commits again.
    await gitFrame('/tmp')
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(commits.value).toBe(settled)

    // A real change still lands.
    gitStatus.mockResolvedValue({ ...REPO, entries: [{ path: 'a.ts', xy: ' M' }, { path: 'b.ts', xy: '??' }] })
    await gitFrame('/tmp')
    await flush()
    expect(commits.value).toBeGreaterThan(settled)
  })

  it('re-pulls once when the socket re-opens after a drop (the reconnect catch-up)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('reconnect'), commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    openGitSockets()

    // The connection drops; the connector backs off and retries forever.
    dropGitSockets()
    // The first retry waits 1s ±30% jitter: cross the widest step.
    await tick(1_300)
    expect(gitSocketsOf()).toHaveLength(2)
    // The re-open replays every subscription (the hub's re-seed)…
    openGitSockets()
    expect(gitSocketsOf()[1]!.sent).toEqual([
      JSON.stringify({ op: 'sub', channel: 'session', sessionId: 'reconnect' }),
      JSON.stringify({ op: 'sub', channel: 'git', sessionId: 'reconnect', args: { worktrees: ['/tmp'] } }),
    ])
    // …and fires the catch-up pull: the outage swallowed notices.
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // Fresh notices keep arriving through the new socket.
    await gitFrame('/tmp')
    expect(gitStatus).toHaveBeenCalledTimes(3)
  })

  it('queues exactly one trailing pull for a notice landing mid-flight', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    // The mount answer lands (it opens the subscription); the manual refresh
    // that follows is held in flight, and the notice lands while it runs.
    let release: ((value: GitStatusResult) => void) | undefined
    gitStatus
      .mockResolvedValueOnce(REPO)
      .mockImplementation(() => new Promise<GitStatusResult>(resolve => { release = resolve }))
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('mid-flight'), commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    await act(async () => { latest?.refresh() })
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // The notice lands while the (slow) refresh is still in flight: it must
    // neither start a second concurrent fetch nor get lost.
    await gitFrame('/tmp')
    expect(gitStatus).toHaveBeenCalledTimes(2)

    await act(async () => { release?.(REPO) })
    await flush()
    // The trailing pull ran — exactly one.
    expect(gitStatus).toHaveBeenCalledTimes(3)
  })

  it('recovers an error state on the next notice', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus
      .mockResolvedValueOnce(REPO)
      .mockRejectedValueOnce(new Error('status route down'))
      .mockResolvedValue({ ...REPO, entries: [{ path: 'a.ts', xy: ' M' }, { path: 'b.ts', xy: '??' }] })
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('error-recovery'), commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    await gitFrame('/tmp')
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(latest?.error).toBe(true)

    // The next notice answers again: the error flag clears and the changed
    // snapshot lands.
    await gitFrame('/tmp')
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(3)
    expect(latest?.error).toBe(false)
    expect(latest?.snapshot?.entries).toHaveLength(2)
  })

  it('does not fetch at all for a hidden consumer, and starts when it shows', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    const scope = scopeFor('visibility')
    mounted = renderRoot(createElement(Probe, { scope, visible: false, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(0)
    await tick(120_000)
    expect(gitStatus).toHaveBeenCalledTimes(0)

    mounted.rerender(createElement(Probe, { scope, visible: true, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
  })
})

describe('the shared git status store ignore index (the ⊘ vocabulary)', () => {
  /** Mount one probe on a snapshot and return its settled view. */
  async function viewOf(id: string, snapshot: GitStatusResult): Promise<GitStatusView> {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(snapshot)
    mounted = renderRoot(createElement(Probe, { scope: scopeFor(id), commits: { value: 0 } }))
    await tick(0)
    await flush()
    if (latest === null) throw new Error('no view settled')
    return latest
  }

  it('answers the ignored question for the entry itself and its subtree', async () => {
    const view = await viewOf('ignored-tree', {
      ...REPO,
      ignored: ['node_modules/', 'logo.gen.png'],
    })
    // The collapsed directory row itself…
    expect(view.isIgnored('/tmp/node_modules')).toBe(true)
    // …everything under it…
    expect(view.isIgnored('/tmp/node_modules/.pnpm/x/index.js')).toBe(true)
    // …an ignored FILE exactly (never its "subtree" — files have none)…
    expect(view.isIgnored('/tmp/logo.gen.png')).toBe(true)
    // …and nothing else: siblings, the root, and paths that merely share a
    // name segment answer false.
    expect(view.isIgnored('/tmp/a.ts')).toBe(false)
    expect(view.isIgnored('/tmp')).toBe(false)
    expect(view.isIgnored('/tmp/other/node_modules/x.js')).toBe(false)
    // Windows separators normalize to the same answer.
    expect(view.isIgnored('\\tmp\\node_modules\\x.js')).toBe(true)
  })

  it('answers plain false with no ignore data at all (older host, failed read)', async () => {
    const view = await viewOf('ignored-empty', REPO)
    expect(view.isIgnored('/tmp/node_modules/x.js')).toBe(false)
    const nothing = await viewOf('ignored-undefined', { ...REPO, ignored: undefined })
    expect(nothing.isIgnored('/tmp/node_modules')).toBe(false)
  })

  it('keeps idle notices silent while the ignore set is equal, and notifies when it moves', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    const WITH_IGNORE: GitStatusResult = { ...REPO, ignored: ['node_modules/'] }
    gitStatus.mockResolvedValue(WITH_IGNORE)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('ignored-cadence'), commits }))
    await tick(0)
    await flush()
    const settled = commits.value

    // A NEW object with the SAME ignore set (plus truncation flag): equal,
    // so the idle notice must not re-render the tree's rows.
    gitStatus.mockResolvedValue({ ...WITH_IGNORE })
    await gitFrame('/tmp')
    await flush()
    expect(commits.value).toBe(settled)

    // A different ignore set is a real answer change — the ⊘ badges move.
    gitStatus.mockResolvedValue({ ...REPO, ignored: [] })
    await gitFrame('/tmp')
    await flush()
    expect(commits.value).toBeGreaterThan(settled)
  })
})

describe('the store\'s cache, per-path patching and turn calibration', () => {
  it('hydrates the first paint from storage and subscribes before the first pull returns', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    // First visit: the answer lands (and writes through to storage)…
    gitStatus.mockResolvedValue(REPO)
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('hydrate'), commits: { value: 0 } }))
    await tick(0)
    await flush()
    mounted.unmount()
    mounted = null
    gitStatus.mockReset()

    // …second visit, same slot identity: the pull is held in flight, so
    // whatever is on screen came from storage.
    let release: ((value: GitStatusResult) => void) | undefined
    gitStatus.mockImplementation(() => new Promise<GitStatusResult>(resolve => { release = resolve }))
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('hydrate'), commits: { value: 0 } }))
    // The cache already colors: a snapshot before ANY answer, loading quiet.
    expect(latest?.snapshot).not.toBeNull()
    expect(latest?.snapshot?.entries).toEqual([{ path: 'a.ts', xy: ' M' }])
    expect(latest?.loading).toBe(false)
    // And the hydrated root lets the watch attach BEFORE the pull returns.
    // The array also still holds the PREVIOUS visit's feed socket — the
    // release at unmount retired its last subscription, so the hub closed it
    // (zero consumers, zero connections); count the LIVE sockets of this
    // mount, which carry exactly the session + git watch subs.
    openGitSockets()
    const liveFeedSockets = gitSocketsOf().filter(socket => !socket.closed)
    expect(liveFeedSockets).toHaveLength(1)
    expect(liveFeedSockets[0]!.sent).toEqual([
      JSON.stringify({ op: 'sub', channel: 'session', sessionId: 'hydrate' }),
      JSON.stringify({ op: 'sub', channel: 'git', sessionId: 'hydrate', args: { worktrees: ['/tmp'] } }),
    ])
    await act(async () => { release?.(REPO) })
    await flush()
    // The calibration pull still ran — the cache only decides the first
    // instants, the live answer the final state.
    expect(gitStatus).toHaveBeenCalledTimes(1)
  })

  it('patches a paths-bearing frame per path without a full re-pull', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('patch'), commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    // The frame names the file (worktree-relative, as the host watcher
    // reports it); the answer is per-path and ABSOLUTE on the wire.
    gitStatusPaths.mockResolvedValue({
      isRepo: true, root: '/tmp', branch: 'main',
      entries: [{ path: 'a.ts', xy: 'M ', counts: { additions: 2, deletions: 1 } }],
      ignored: [],
    })
    await gitFrame('/tmp', ['a.ts'])
    expect(gitStatusPaths).toHaveBeenCalledTimes(1)
    expect(gitStatusPaths.mock.calls[0]![1]).toEqual(['/tmp/a.ts'])
    expect(gitStatus).toHaveBeenCalledTimes(1) // NO full re-pull
    expect(latest?.snapshot?.entries).toEqual([{ path: 'a.ts', xy: 'M ', counts: { additions: 2, deletions: 1 } }])
    expect(commits.value).toBeGreaterThan(0)
  })

  it('a patch answering nothing drops the row (went clean) and an equal patch stays silent', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('patch-clean'), commits }))
    await tick(0)
    await flush()
    const settled = commits.value

    gitStatusPaths.mockResolvedValue({ isRepo: true, root: '/tmp', entries: [], ignored: [] })
    await gitFrame('/tmp', ['a.ts'])
    await flush()
    // Absence IS the answer: the row is gone, the store told everyone.
    expect(latest?.snapshot?.entries).toEqual([])
    expect(commits.value).toBeGreaterThan(settled)
    const afterDrop = commits.value

    // The same answer again changes nothing visible: no notify (the
    // idle-silence contract holds for patches too).
    await gitFrame('/tmp', ['a.ts'])
    await flush()
    expect(gitStatusPaths).toHaveBeenCalledTimes(2)
    expect(commits.value).toBe(afterDrop)
  })

  it('a truncated per-path answer falls back to the full calibration pull', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('patch-truncated'), commits: { value: 0 } }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)

    gitStatusPaths.mockResolvedValue({ isRepo: true, root: '/tmp', entries: [], ignored: [], truncated: true })
    await gitFrame('/tmp', ['a.ts'])
    await flush()
    // A capped answer must not be patched in (it would drop rows it never
    // saw): the full read recalibrates.
    expect(gitStatusPaths).toHaveBeenCalledTimes(1)
    expect(gitStatus).toHaveBeenCalledTimes(2)
  })

  it('a paths frame naming paths outside the repository root does nothing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('patch-outside'), commits }))
    await tick(0)
    await flush()
    const settled = commits.value

    await gitFrame('/tmp', ['../outside/x.ts', '/elsewhere/y.ts'])
    await flush()
    // Nothing inside the checkout's root: no per-path call, no full pull,
    // no notify.
    expect(gitStatusPaths).not.toHaveBeenCalled()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(commits.value).toBe(settled)
  })

  it('holds the session turn subscription while visible and calibrates on each settled reply', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    const commits: Counter = { value: 0 }
    const scope = scopeFor('turn-cal')
    mounted = renderRoot(createElement(Probe, { scope, commits }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(1)
    // The turn subscription rides the session channel of the SAME feed
    // socket, and it exists the moment the slot is visibly held (its sub
    // frame rides the open).
    expect(turnSocketsOf()).toHaveLength(1)
    expect(turnSocketsOf()[0]!.url).toContain('/sidebar/ws/feed')
    openGitSockets()
    expect(subscribedSessions(turnSocketsOf()[0]!, 'session')).toEqual(['turn-cal'])

    // One settled reply of THIS session = one full calibration re-pull.
    await turnFrame('turn-cal')
    expect(gitStatus).toHaveBeenCalledTimes(2)
    // Another session's turn frame is filtered (the hub only hears its own).
    await turnFrame('other-session')
    expect(gitStatus).toHaveBeenCalledTimes(2)

    // The last release drops the turn subscription with the watch.
    mounted.unmount()
    await flush()
    expect(turnSocketsOf()[0]!.closed).toBe(true)
  })

  it('a hidden consumer holds no turn socket at all', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', GitSocket)
    gitStatus.mockResolvedValue(REPO)
    mounted = renderRoot(createElement(Probe, { scope: scopeFor('turn-hidden'), visible: false, commits: { value: 0 } }))
    await tick(0)
    await flush()
    expect(gitStatus).toHaveBeenCalledTimes(0)
    expect(turnSocketsOf()).toHaveLength(0)
    await turnFrame('turn-hidden')
    expect(gitStatus).toHaveBeenCalledTimes(0)
  })
})
