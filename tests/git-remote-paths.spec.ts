/**
 * The remote path plumbing behind the ssh:// git views (`src/git.ts`,
 * commit 9f26f9e): git ON the remote host answers NATIVE paths, while the
 * panel only ever speaks the `ssh://<alias>/<path>` spelling — the module
 * lifts at egress and lowers at the spawn boundary.
 *
 * Pinned here:
 *
 *  - SPELLING LIFTS: `remoteRootSpelling(sshCwd, nativeRoot)` rebuilds the
 *    `ssh://` spelling for POSIX roots and the Windows-drive form
 *    (`ssh://win/D:/…`, git for Windows spells drive roots without the URI's
 *    leading slash); malformed input answers `undefined` and callers degrade.
 *  - NATIVE LOWERS: `remoteNativePathOf` is the exact inverse (including the
 *    `/D:/` prefix strip); local paths and relative rows lower to `undefined`
 *    (pass-through untouched).
 *  - OPERAND LOWERING through the EXPORTED surface: every pathspec operand
 *    (`blame`/`diff`/`diffHead`/`log`/`stage`/`unstage`/`commitDiff`/
 *    `discard`) that carries an `ssh://` spelling reaches the remote argv as
 *    the native path; relative rows and native absolutes pass through; on a
 *    LOCAL cwd nothing is rewritten.
 *  - PATHSPEC DERIVATION: `statusPaths` on a remote root derives its
 *    pathspecs LEXICALLY — an `ssh://` spelling under the answering root
 *    strips to repo-root-relative, the root itself is `.`, native absolutes
 *    fold the same way, relative rows stay verbatim, and anything else
 *    (another authority, a sibling-prefix path, a `..` escape) is dropped —
 *    deduped, and fed to `status`/`check-ignore` verbatim.
 *  - EGRESS LIFTS: `repoRoots` and `worktrees` answer roots re-spelled to the
 *    `ssh://` form so the client can echo them back as a cwd.
 *
 * The subprocess service is faked at the resolver boundary and dispatches by
 * subcommand; no real spawn, no real network. Distinct `ssh://` spellings per
 * test keep the module's repoRoots cache out of the way.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  blame,
  commitDiff,
  diff,
  diffHead,
  discard,
  installSubprocessResolver,
  log,
  remoteNativePathOf,
  remoteRootSpelling,
  repoRoot,
  repoRoots,
  stage,
  statusPaths,
  unstage,
  worktrees,
} from '../src/git.ts'

/** The git subcommand of one remote argv (skip `git`, its `--no-pager` and
 *  any number of `-c key=value` pins — never count positions). */
function subcommandOf(argv: string[]): string[] {
  let at = 1
  while (at < argv.length) {
    if (argv[at] === '-c') { at += 2; continue }
    if (argv[at] === '--no-pager') { at += 1; continue }
    break
  }
  return argv.slice(at)
}

/** One settled bridge answer (collected tails + exit facts). */
function handleOf(stdout: string, options?: { stderr?: string; exitCode?: number }): unknown {
  return {
    collected: {
      stdout: { finalize: () => ({ text: stdout, truncated: false }) },
      stderr: { finalize: () => ({ text: options?.stderr ?? '', truncated: false }) },
    },
    done: Promise.resolve({ exitCode: options?.exitCode ?? 0, signal: null }),
  }
}

interface SentSpec {
  argv: string[]
  cwd: string
  stdio: { stdin?: { data: string } }
}

/** Install a fake remote git: answers rev-parse/status/diff/check-ignore/
 *  worktree like a real repository rooted at `nativeRoot`. */
function installRemoteGit(nativeRoot: string, overrides?: {
  worktreePorcelain?: string
}): { specs: SentSpec[] } {
  const specs: SentSpec[] = []
  installSubprocessResolver(() => ({
    spawn: (spec: SentSpec): unknown => {
      specs.push(spec)
      const command = subcommandOf(spec.argv)
      if (command[0] === 'rev-parse') {
        if (command[1] === '--show-toplevel') return handleOf(`${nativeRoot}\n`)
        if (command[1] === '--is-inside-work-tree') return handleOf('true\n')
        if (command[1] === '--abbrev-ref') return handleOf('main\n')
      }
      if (command[0] === 'status') return handleOf('')
      if (command[0] === 'diff') return handleOf('')
      if (command[0] === 'check-ignore') return handleOf('', { exitCode: 1 }) // nothing ignored
      if (command[0] === 'log') return handleOf('')
      // The mutating / read-through commands succeed silently (their argv is
      // what the assertions come for; `show` carries commitDiff's operand).
      if (['add', 'reset', 'checkout', 'show'].includes(command[0])) return handleOf('')
      if (command[0] === 'worktree') {
        // Pin the plain-porcelain path: a `-z`-incapable git rejects the
        // first attempt, exactly like `git-spawn.spec.ts` fakes it.
        if (command.includes('-z')) {
          return handleOf('', { stderr: "error: unknown switch `z'\n", exitCode: 129 })
        }
        return handleOf(overrides?.worktreePorcelain ?? [
          `worktree ${nativeRoot}`,
          'HEAD abc',
          'branch refs/heads/main',
          '',
        ].join('\n'))
      }
      throw new Error(`unexpected remote git command: ${command.join(' ')}`)
    },
  }))
  return { specs }
}

/** The recorded specs running one git subcommand. */
function specsOf(specs: SentSpec[], subcommand: string): SentSpec[] {
  return specs.filter(spec => subcommandOf(spec.argv)[0] === subcommand)
}

afterEach(() => {
  installSubprocessResolver(undefined)
  spawnMock.mockReset()
})

describe('remoteRootSpelling', () => {
  it('lifts a POSIX native root onto the workspace authority', () => {
    expect(remoteRootSpelling('ssh://myserver/home/u', '/home/u/proj')).toBe('ssh://myserver/home/u/proj')
    // The answering root itself round-trips to the same spelling.
    expect(remoteRootSpelling('ssh://myserver/home/u/proj', '/home/u/proj')).toBe('ssh://myserver/home/u/proj')
    // A trailing slash on the native answer never reaches the spelling.
    expect(remoteRootSpelling('ssh://myserver/home/u', '/home/u/proj/')).toBe('ssh://myserver/home/u/proj')
  })

  it('lifts the Windows-drive form without re-adding the URI slash', () => {
    // Git for Windows answers `D:\code\x\repo`; the URI keeps `D:/` slashless
    // at the front.
    expect(remoteRootSpelling('ssh://win/D:/code/x', 'D:\\code\\x\\repo')).toBe('ssh://win/D:/code/x/repo')
    // The `/D:/…` spelling some answers carry loses its leading slash too.
    expect(remoteRootSpelling('ssh://win/D:/code/x', '/D:/code/x/repo')).toBe('ssh://win/D:/code/x/repo')
  })

  it('answers undefined for malformed input (callers degrade)', () => {
    expect(remoteRootSpelling('/local/path', '/home/u/proj')).toBeUndefined()
    expect(remoteRootSpelling('ssh://host', '/home/u/proj')).toBeUndefined() // no authority path
    expect(remoteRootSpelling('ssh://host/home/u', '')).toBeUndefined()
    expect(remoteRootSpelling('ssh://host/home/u', '   ')).toBeUndefined()
  })
})

describe('remoteNativePathOf', () => {
  it('lowers the ssh:// spelling to the remote-native path', () => {
    expect(remoteNativePathOf('ssh://myserver/home/u/proj')).toBe('/home/u/proj')
    expect(remoteNativePathOf('ssh://myserver/home/u/proj/src/a.ts')).toBe('/home/u/proj/src/a.ts')
  })

  it('strips the /D:/ URI prefix from the Windows-drive form', () => {
    expect(remoteNativePathOf('ssh://win/D:/code/x/repo')).toBe('D:/code/x/repo')
  })

  it('answers undefined for anything that is not an ssh:// spelling', () => {
    expect(remoteNativePathOf('/home/u/proj')).toBeUndefined() // local absolute
    expect(remoteNativePathOf('src/a.ts')).toBeUndefined() // relative row
    expect(remoteNativePathOf('')).toBeUndefined()
  })

  it('round-trips with remoteRootSpelling in both shapes', () => {
    const posix = remoteRootSpelling('ssh://myserver/home/u', '/home/u/proj')!
    expect(remoteNativePathOf(posix)).toBe('/home/u/proj')
    expect(remoteRootSpelling('ssh://myserver/home/u', remoteNativePathOf(posix)!)).toBe(posix)

    const win = remoteRootSpelling('ssh://win/D:/code/x', 'D:\\code\\x\\repo')!
    expect(remoteNativePathOf(win)).toBe('D:/code/x/repo')
    expect(remoteRootSpelling('ssh://win/D:/code/x', remoteNativePathOf(win)!)).toBe(win)
  })
})

describe('pathspec operands lower to native on the exported surface', () => {
  it('blame lowers an ssh:// path and keeps the lifted root as cwd', async () => {
    const cwd = 'ssh://t-blame/home/u/proj'
    const { specs } = installRemoteGit('/home/u/proj')

    await blame(cwd, 'ssh://t-blame/home/u/proj/src/a.ts', 10, 20)

    const blameSpecs = specsOf(specs, 'blame')
    expect(blameSpecs).toHaveLength(1)
    expect(blameSpecs[0]!.cwd).toBe(cwd) // the LIFTED root routes back to the host
    expect(blameSpecs[0]!.argv.at(-1)).toBe('/home/u/proj/src/a.ts')
  })

  it('blame passes relative rows and native absolutes through untouched', async () => {
    const cwd = 'ssh://t-blame-rel/home/u/proj'
    const { specs } = installRemoteGit('/home/u/proj')

    await blame(cwd, 'src/rel.ts', 1, 2)
    await blame(cwd, '/home/u/proj/src/nat.ts', 1, 2)

    const operands = specsOf(specs, 'blame').map(spec => spec.argv.at(-1))
    expect(operands).toEqual(['src/rel.ts', '/home/u/proj/src/nat.ts'])
  })

  it('diff / diffHead lower the ssh:// path after the -- separator', async () => {
    const cwd = 'ssh://t-diff/home/u/proj'
    const { specs } = installRemoteGit('/home/u/proj')
    const sshPath = 'ssh://t-diff/home/u/proj/src/a.ts'

    await diff(cwd, sshPath, false)
    await diff(cwd, sshPath, true)
    await diffHead(cwd, sshPath)

    const diffs = specsOf(specs, 'diff')
    expect(diffs).toHaveLength(3)
    // --cached flags the staged read; HEAD the diffHead read; the plain one
    // is the worktree side. Every pathspec operand lowered to native.
    expect(diffs.find(spec => spec.argv.includes('--cached'))!.argv.slice(-2))
      .toEqual(['--', '/home/u/proj/src/a.ts'])
    expect(diffs.find(spec => !spec.argv.includes('--cached') && !spec.argv.includes('HEAD'))!.argv.slice(-2))
      .toEqual(['--', '/home/u/proj/src/a.ts'])
    expect(diffs.find(spec => spec.argv.includes('HEAD'))!.argv.slice(-2))
      .toEqual(['--', '/home/u/proj/src/a.ts'])
  })

  it('log lowers the ssh:// path past --end-of-options --', async () => {
    const cwd = 'ssh://t-log/home/u/proj'
    const { specs } = installRemoteGit('/home/u/proj')

    await log(cwd, 30, 0, undefined, { path: 'ssh://t-log/home/u/proj/src/a.ts', follow: true })

    const logSpecs = specsOf(specs, 'log')
    expect(logSpecs).toHaveLength(1)
    expect(logSpecs[0]!.argv.slice(-3)).toEqual(['--end-of-options', '--', '/home/u/proj/src/a.ts'])
    expect(logSpecs[0]!.argv).toContain('--follow')
  })

  it('stage / unstage / discard / commitDiff lower the ssh:// path', async () => {
    const cwd = 'ssh://t-mutate/home/u/proj'
    const { specs } = installRemoteGit('/home/u/proj')
    const sshPath = 'ssh://t-mutate/home/u/proj/src/a.ts'

    await stage(cwd, sshPath)
    await unstage(cwd, sshPath)
    await discard(cwd, sshPath)
    await commitDiff(cwd, 'abc123', undefined, { path: sshPath })

    expect(specsOf(specs, 'add')[0]!.argv.slice(-2)).toEqual(['--', '/home/u/proj/src/a.ts'])
    expect(specsOf(specs, 'reset')[0]!.argv.slice(-2)).toEqual(['--', '/home/u/proj/src/a.ts'])
    expect(specsOf(specs, 'checkout')[0]!.argv.slice(-2)).toEqual(['--', '/home/u/proj/src/a.ts'])
    expect(specsOf(specs, 'show')[0]!.argv.at(-1)).toBe('/home/u/proj/src/a.ts')
  })

  it('keeps a LOCAL pathspec verbatim (no lowering outside ssh:// spellings)', async () => {
    let childRuns = 0
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      Object.assign(child, { stdout, stderr, kill: vi.fn() })
      queueMicrotask(() => {
        stdout.end(childRuns++ === 0 ? '/repo\n' : '')
        stderr.end()
        child.emit('close', 0)
      })
      return child
    })

    await diff('/repo', '/repo/src/a.ts', false)

    const diffArgs = spawnMock.mock.calls.at(-1)![1] as string[]
    expect(diffArgs[0]).toBe('-C') // the local spawn shape, untouched
    expect(diffArgs.slice(-2)).toEqual(['--', '/repo/src/a.ts']) // verbatim operand
  })
})

describe('statusPaths derives pathspecs lexically on a remote worktree', () => {
  const cwd = 'ssh://t-status/home/u/proj'

  it('strips in-root ssh spellings, folds native absolutes, keeps relative rows, drops the rest', async () => {
    const { specs } = installRemoteGit('/home/u/proj')

    const result = await statusPaths(cwd, [
      'ssh://t-status/home/u/proj/src/a.ts', // in-root ssh spelling → relative
      'ssh://t-status/home/u/proj', // the root itself → the full-read '.'
      'ssh://other-host/home/u/proj/src/out.ts', // another authority → dropped
      'ssh://t-status/home/u/proj2/sibling.ts', // sibling prefix, not under root → dropped
      'ssh://t-status/home/u/proj/../escape.ts', // .. escape → dropped
      '/home/u/proj/src/native-abs.ts', // native absolute twin → folded
      '/home/u/proj/../escape-native.ts', // native .. escape → dropped
      '/elsewhere/out.ts', // native absolute outside → dropped
      'src/rel-row.ts', // relative row → verbatim
      'ssh://t-status/home/u/proj/src/./b.ts', // '.' folds
      'ssh://t-status/home/u/proj/src/a.ts', // exact duplicate → deduped
    ])

    expect(result.isRepo).toBe(true)
    expect(result.root).toBe(cwd)
    expect(result.branch).toBe('main')
    const status = specsOf(specs, 'status').find(spec => spec.argv.includes('--porcelain=v1'))!
    expect(status.argv.slice(status.argv.indexOf('--') + 1)).toEqual([
      'src/a.ts',
      '.',
      'src/native-abs.ts',
      'src/rel-row.ts',
      'src/b.ts',
    ])
    // check-ignore is NUL-fed exactly the derived pathspec set.
    const ignore = specsOf(specs, 'check-ignore')[0]!
    expect(ignore.stdio.stdin).toEqual({
      data: 'src/a.ts\0.\0src/native-abs.ts\0src/rel-row.ts\0src/b.ts\0',
    })
  })

  it('answers the empty set without spawning status when every path is dropped', async () => {
    const { specs } = installRemoteGit('/home/u/proj')

    const result = await statusPaths(cwd, [
      'ssh://other-host/elsewhere/x.ts',
      '../escape-rel.ts',
    ])

    expect(result).toMatchObject({ isRepo: true, entries: [] })
    expect(specsOf(specs, 'status')).toHaveLength(0)
  })
})

describe('remote git answers lift back to the ssh:// spelling at egress', () => {
  it('repoRoots / repoRoot answer the lifted spelling', async () => {
    const cwd = 'ssh://t-lift/home/u/proj'
    installRemoteGit('/home/u/proj')

    await expect(repoRoots(cwd)).resolves.toEqual(['ssh://t-lift/home/u/proj'])
    await expect(repoRoot(cwd)).resolves.toBe('ssh://t-lift/home/u/proj')
  })

  it('worktrees lift every listed root (client echoes them back as the worktree argument)', async () => {
    const cwd = 'ssh://t-wt/home/u/proj'
    const { specs } = installRemoteGit('/home/u/proj', {
      worktreePorcelain: [
        'worktree /home/u/proj',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /home/u/proj-wt',
        'HEAD abc',
        'branch refs/heads/wt',
        '',
      ].join('\n'),
    })

    const rows = await worktrees(cwd)

    expect(rows.map(row => row.path)).toEqual([
      'ssh://t-wt/home/u/proj',
      'ssh://t-wt/home/u/proj-wt',
    ])
    expect(rows.map(row => row.branch)).toEqual(['main', 'wt'])
    expect(rows.map(row => row.current)).toEqual([true, false])
    // The per-worktree change counts run against the LIFTED spellings.
    const counters = specsOf(specs, 'status').map(spec => spec.cwd)
    expect(counters).toEqual(['ssh://t-wt/home/u/proj', 'ssh://t-wt/home/u/proj-wt'])
  })
})
