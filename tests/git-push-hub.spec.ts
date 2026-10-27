/**
 * The git push hub's PER-FILE notice contract (`src/git-push.ts`): the
 * frames the host pushes over `/sidebar/ws/git` used to be bare
 * invalidations ("something moved"), so the client could only answer with
 * a whole-repository re-pull. The hub now collects the watched checkout's
 * file-watcher filenames across its 250 ms burst window and fires them as
 * the frame's `paths`. The rules under test:
 *
 *  - COLLECTION: only the checkout's FILES watcher group collects; the
 *    `.git` metadata group's events (stage / commit / checkout) fire a
 *    paths-less frame — their blast radius is by definition the whole
 *    repository.
 *  - NORMALIZATION + FILTERING: filenames normalize to worktree-relative
 *    POSIX paths, and `.git`-internal names the main checkout's recursive
 *    file watch inevitably sees are dropped (a stage must not masquerade
 *    as a one-file edit).
 *  - DEDUP + CAP: one burst answers once, deduplicated; past 64 distinct
 *    paths the whole field degrades (a partial list would leave the rest
 *    of the burst stale until the next notice).
 *  - DEGRADE: a null filename ("moved, name unknown") degrades the frame;
 *    metadata events never erase a file group's list.
 *  - SHAPE: the worktree spelling stays the client's own; old fields are
 *    untouched, so a paths-less frame is byte-identical to the pre-paths
 *    contract.
 *
 * `node:fs`'s `watch` and `node:fs/promises`' `stat` are mocked at the
 * module boundary (the hub's only entries into the filesystem): the fake
 * watcher is an event emitter the tests drive, and `stat` answers a
 * directory `.git` so `resolveGitDirs` takes the main-checkout branch.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every fake watcher the mock created, in creation order. */
const watchers: Array<{ path: string; recursive: boolean; events: EventEmitter }> = []

vi.mock('node:fs', () => ({
  watch: (path: string, options: { recursive?: boolean }): EventEmitter => {
    const events = new EventEmitter()
    watchers.push({ path, recursive: options.recursive === true, events })
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

/** The frames one fake socket was sent, parsed. */
type SentFrame = { kind: string; worktree: string; paths?: string[] }

/** A fake accepted socket: records frames, hands the hub its handlers. */
class FakeSocket {
  readonly sent: SentFrame[] = []
  closed = false
  private readonly events = new EventEmitter()
  on(event: string, handler: (data?: unknown) => void): void { this.events.on(event, handler) }
  /** The hub's view of an incoming message. */
  receive(text: string): void { this.events.emit('message', text) }
  send(data: string): void { this.sent.push(JSON.parse(data) as SentFrame) }
  close(): void { this.closed = true }
}

beforeEach(() => {
  watchers.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Attach one socket watching `/repo` and let the async apply chain settle. */
async function attached(): Promise<{ socket: FakeSocket; hub: ReturnType<typeof createGitWatchHub> }> {
  const hub = createGitWatchHub(() => {})
  const socket = new FakeSocket()
  hub.attach(socket as never, async () => '/session')
  socket.receive(JSON.stringify({ op: 'watch', worktrees: ['/repo'] }))
  await vi.advanceTimersByTimeAsync(0)
  return { socket, hub }
}

/** The two watcher groups of the attached entry, by watched path. */
function groupOf(path: string): EventEmitter | undefined {
  return watchers.find(watcher => watcher.path === path)?.events
}

async function fire(group: string, filename: string | null): Promise<void> {
  groupOf(group)?.emit('change', 'change', filename)
  await vi.advanceTimersByTimeAsync(2_100)
}

describe('the git push hub frame paths', () => {
  it('watches both groups and carries collected file paths on the frame', async () => {
    const { socket, hub } = await attached()
    // The FILES group on the checkout root (recursive), the metadata group
    // on its `.git`.
    expect(watchers.map(watcher => watcher.path).sort()).toEqual(['/repo', '/repo/.git'])
    expect(watchers.every(watcher => watcher.recursive)).toBe(true)

    await fire('/repo', 'src/a.ts')
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo', paths: ['src/a.ts'] }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('deduplicates one burst and keeps the client spelling of the worktree', async () => {
    const { socket, hub } = await attached()
    groupOf('/repo')?.emit('change', 'change', 'a.ts')
    groupOf('/repo')?.emit('change', 'change', 'b.ts')
    groupOf('/repo')?.emit('change', 'change', 'a.ts') // duplicate inside the window
    groupOf('/repo')?.emit('change', 'change', 'sub\\win.ts') // Windows spelling
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo', paths: ['a.ts', 'b.ts', 'sub/win.ts'] }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('drops .git-internal names the file watcher inevitably sees', async () => {
    const { socket, hub } = await attached()
    groupOf('/repo')?.emit('change', 'change', '.git/index')
    groupOf('/repo')?.emit('change', 'change', '.git/refs/heads/main')
    groupOf('/repo')?.emit('change', 'change', '.git')
    await vi.advanceTimersByTimeAsync(2_100)
    // Everything collected was metadata: the frame fires paths-less — the
    // "something moved" shape, exactly the pre-paths contract.
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo' }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('fires paths-less for pure .git metadata events (stage/commit/checkout)', async () => {
    const { socket, hub } = await attached()
    await fire('/repo/.git', 'index')
    await fire('/repo/.git', 'refs/heads/main')
    expect(socket.sent).toEqual([
      { kind: 'git', worktree: '/repo' },
      { kind: 'git', worktree: '/repo' },
    ])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('never lets metadata events erase the file group\'s collected list', async () => {
    const { socket, hub } = await attached()
    groupOf('/repo')?.emit('change', 'change', 'edited.ts')
    groupOf('/repo/.git')?.emit('change', 'change', 'index') // a stage raced the save
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo', paths: ['edited.ts'] }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('degrades to paths-less past 64 distinct paths', async () => {
    const { socket, hub } = await attached()
    for (let index = 0; index < 65; index += 1) {
      groupOf('/repo')?.emit('change', 'change', `burst/f${String(index)}.ts`)
    }
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo' }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('carries exactly the 64-path cap when the burst stops at it', async () => {
    const { socket, hub } = await attached()
    for (let index = 0; index < 64; index += 1) {
      groupOf('/repo')?.emit('change', 'change', `burst/f${String(index)}.ts`)
    }
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toHaveLength(1)
    expect(socket.sent[0]!.paths).toHaveLength(64)
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('a null filename ("moved, name unknown") degrades the whole frame', async () => {
    const { socket, hub } = await attached()
    groupOf('/repo')?.emit('change', 'change', 'known.ts')
    groupOf('/repo')?.emit('change', 'change', null) // some platforms under load
    await vi.advanceTimersByTimeAsync(2_100)
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo' }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })

  it('fans one burst out to every socket watching the checkout', async () => {
    const { socket, hub } = await attached()
    const second = new FakeSocket()
    hub.attach(second as never, async () => '/session')
    second.receive(JSON.stringify({ op: 'watch', worktrees: ['/repo'] }))
    await vi.advanceTimersByTimeAsync(0)
    await fire('/repo', 'shared.ts')
    expect(socket.sent).toEqual([{ kind: 'git', worktree: '/repo', paths: ['shared.ts'] }])
    expect(second.sent).toEqual([{ kind: 'git', worktree: '/repo', paths: ['shared.ts'] }])
    await vi.advanceTimersByTimeAsync(10)
    hub.dispose()
  })
})
