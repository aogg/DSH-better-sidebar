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

const { gitStatus } = vi.hoisted(() => ({ gitStatus: vi.fn() }))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, gitStatus } }
})

import { renderRoot, setupReactAct } from './test-utils.ts'
import { useGitStatus, type GitStatusView } from '../src/client/ui/git-status.ts'

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

/** Complete every pending upgrade (the connector answers with its watch set). */
function openGitSockets(): void {
  for (const socket of gitSockets) {
    if (socket.closed || socket.readyState === GitSocket.OPEN) continue
    socket.readyState = GitSocket.OPEN
    socket.onopen?.()
  }
}

/** Deliver one host `git` frame naming `worktree` to every live socket. */
async function gitFrame(worktree: string): Promise<void> {
  openGitSockets()
  await act(async () => {
    for (const socket of gitSockets) {
      if (socket.closed) continue
      socket.onmessage?.({ data: JSON.stringify({ kind: 'git', worktree }) })
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
  vi.unstubAllGlobals()
  gitSockets.length = 0
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
    // slot watches): ONE socket for the session, fenced by its sessionId.
    expect(gitSockets).toHaveLength(1)
    expect(gitSockets[0]!.url).toContain('/sidebar/ws/git')
    expect(gitSockets[0]!.url).toContain('sessionId=poll-on')
    openGitSockets()
    expect(gitSockets[0]!.sent).toEqual([JSON.stringify({ op: 'watch', worktrees: ['/tmp'] })])

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
    expect(gitSockets).toHaveLength(1)

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
    // notice for the slot's checkout reaches nobody.
    mounted.unmount()
    await flush()
    expect(gitSockets[0]!.closed).toBe(true)
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
    await tick(1_000)
    expect(gitSockets).toHaveLength(2)
    // The re-open re-announces the watch set…
    openGitSockets()
    expect(gitSockets[1]!.sent).toEqual([JSON.stringify({ op: 'watch', worktrees: ['/tmp'] })])
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
