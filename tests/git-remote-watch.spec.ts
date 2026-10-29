/**
 * The git push hub's remote (ssh://) behavior (`src/git-push.ts`, commit
 * 9f26f9e): a session whose cwd is the `ssh://<alias>/<path>` spelling of a
 * dsh-ssh-workspace mount skips watching ENTIRELY. The hub's handles are
 * node `fs.watch` calls on local paths — they can never see a remote
 * checkout — and the session's spellings are not local paths
 * `resolveTarget` can normalize (each frame would die as a warning). The
 * skip is a deliberate silent degradation:
 *
 *  - an ssh session's watch frame builds NO watcher and raises NO warning;
 *  - a session that moved from a local to a remote cwd releases its
 *    existing watches cleanly through the same empty-`next` release loop;
 *  - a local session's contract is untouched: both watcher groups are
 *    created and a file edit still fires the per-path frame.
 *
 * `node:fs`'s `watch` and `node:fs/promises`' `stat` are mocked at the
 * module boundary, exactly like `git-push-hub.spec.ts` (the fake watcher is
 * an event emitter the tests drive; `stat` answers a directory `.git` so
 * `resolveGitDirs` takes the main-checkout branch).
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every fake watcher the mock created, in creation order. */
const watchers: Array<{ path: string; recursive: boolean; events: EventEmitter; close: ReturnType<typeof vi.fn> }> = []

vi.mock('node:fs', () => ({
  watch: (path: string, options: { recursive?: boolean }): EventEmitter => {
    const events = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    // The hub closes the RETURNED watcher object — the close mock must live
    // on it, not on the test-side record.
    events.close = vi.fn()
    watchers.push({ path, recursive: options.recursive === true, events, close: events.close })
    return events
  },
}))

vi.mock('node:fs/promises', () => ({
  stat: async (path: string): Promise<Record<string, unknown>> => {
    // `resolveGitDirs` probes `<worktree>/.git`: a directory means a MAIN
    // checkout (own git dir + repoRoot = the worktree).
    if (path === '/repo/.git') return { isDirectory: () => true, isFile: () => false }
    throw new Error('no such file')
  },
  readFile: async (): Promise<string> => {
    throw new Error('not a gitdir file')
  },
}))

import { createGitWatchHub } from '../src/git-push.ts'

/** A fake accepted socket: records frames, hands the hub its handlers. */
class FakeSocket {
  readonly sent: Array<{ kind: string; worktree: string; paths?: string[] }> = []
  closed = false
  private readonly events = new EventEmitter()
  on(event: string, handler: (data?: unknown) => void): void { this.events.on(event, handler) }
  receive(text: string): void { this.events.emit('message', text) }
  send(data: string): void { this.sent.push(JSON.parse(data) as { kind: string; worktree: string }) }
  close(): void { this.closed = true }
}

let cwd = '/repo'
let warn: ReturnType<typeof vi.fn>

beforeEach(() => {
  watchers.length = 0
  cwd = '/repo'
  warn = vi.fn()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Attach one socket whose session cwd is the (mutable) module `cwd`. */
async function attached(): Promise<{ socket: FakeSocket; hub: ReturnType<typeof createGitWatchHub> }> {
  const hub = createGitWatchHub(warn)
  const socket = new FakeSocket()
  hub.attach(socket as never, async () => cwd)
  return { socket, hub }
}

/** Send one watch frame and let the serialized apply chain settle. */
async function watch(socket: FakeSocket, worktrees: string[]): Promise<void> {
  socket.receive(JSON.stringify({ op: 'watch', worktrees }))
  await vi.advanceTimersByTimeAsync(0)
}

function groupOf(path: string): EventEmitter | undefined {
  return watchers.find(watcher => watcher.path === path)?.events
}

describe('the git push hub on an ssh:// workspace session', () => {
  it('creates no watcher and raises no warning for a remote session', async () => {
    cwd = 'ssh://myserver/home/u/repo'
    const { socket, hub } = await attached()

    await watch(socket, ['ssh://myserver/home/u/repo', 'ssh://myserver/home/u/repo/src', 'relative-row.ts'])

    expect(watchers).toHaveLength(0) // no fs.watch handle was ever created
    expect(warn).not.toHaveBeenCalled() // a deliberate skip, not a failure
    expect(socket.sent).toEqual([])

    // Firing anything cannot exist — there is nothing to fire — and a
    // follow-up frame stays equally silent.
    await watch(socket, ['ssh://myserver/home/u/repo'])
    expect(watchers).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it("releases a local session's watches cleanly when its cwd moves to a remote spelling", async () => {
    const { socket, hub } = await attached()
    await watch(socket, ['/repo'])
    expect(watchers.map(watcher => watcher.path).sort()).toEqual(['/repo', '/repo/.git'])

    // The session re-spells its cwd as a remote workspace (a dsh-ssh
    // mount took over): the next frame must drop every local watch,
    // silently.
    cwd = 'ssh://myserver/home/u/repo'
    await watch(socket, ['/repo'])

    expect(warn).not.toHaveBeenCalled()
    expect(watchers.every(watcher => watcher.close.mock.calls.length > 0)).toBe(true)
    // The released entry no longer answers: firing the stale handle
    // schedules nothing (the hub's entry is gone) — no frame ever leaves.
    groupOf('/repo')?.emit('change', 'change', 'stale-edit.ts')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toEqual([])

    // And the remote cwd keeps refusing new watches, still silently.
    await watch(socket, ['/repo'])
    expect(watchers.every(watcher => watcher.close.mock.calls.length > 0)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })
})

describe('the git push hub keeps the local contract', () => {
  it('watches both groups of a local session and fires the per-path frame', async () => {
    const { socket, hub } = await attached()
    await watch(socket, ['/repo'])

    expect(watchers.map(watcher => watcher.path).sort()).toEqual(['/repo', '/repo/.git'])
    expect(watchers.every(watcher => watcher.recursive)).toBe(true)
    expect(warn).not.toHaveBeenCalled()

    groupOf('/repo')?.emit('change', 'change', 'src/a.ts')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo', paths: ['src/a.ts'] }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })
})
