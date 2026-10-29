/**
 * The remote (ssh://) half of the git execution channel (`src/git.ts`,
 * commit 9f26f9e): a session whose cwd is the `ssh://<alias>/<path>` spelling
 * of a dsh-ssh-workspace mount cannot spawn a local `git -C <cwd>`, so
 * `runGit` routes the command through the host `subprocess` service (the
 * resolver injected from index.ts) and it runs ON the remote host.
 *
 * The contract pinned here (the dsh-ssh-workspace bridge shape, narrowed to
 * what git.ts sends and reads):
 *
 *  - SPEC ASSEMBLY: the remote argv carries NO `-C` (the bridge `cd`s into
 *    the remote cwd itself) and starts with the machine-readable pins
 *    (`git --no-pager -c color.ui=false -c core.quotePath=false`); env is the
 *    MINIMAL `{GIT_OPTIONAL_LOCKS:'0'}` (never the whole process.env);
 *    `graceMs` is a positive SIGTERM→SIGKILL grace; the spec carries a live
 *    `AbortSignal` and byte-bounded `{maxBytes}` stdout/stderr collectors;
 *    `stdin: {data}` exists ONLY when the caller passed `input`.
 *  - EXIT SEMANTICS: exitCode 0 resolves with the collected stdout text; a
 *    non-zero exit rejects with the collected stderr (trimmed), falling back
 *    to `git exited with N` when stderr is empty; a `done` REJECTION is an
 *    infrastructure failure and rejects as `cannot run git: …` (the local
 *    spawn-error vocabulary); a bridge that returns no usable handle too.
 *  - TWO RESOLVER STATES: with the service injected the spec above is sent;
 *    without one (or with a service-less / pre-takeover resolver answer) the
 *    promise REJECTS with the typed `git-remote-unavailable` error — never a
 *    synchronous throw, so `.then()`-chained callers see the rejection, not a
 *    TypeError.
 *  - TIMEOUT: the command timeout aborts the spec's signal (the bridge's
 *    hard-kill trigger) and rejects with the local contract's message.
 *  - LOCAL REGRESSION: a plain path keeps the exact local spawn — first argv
 *    `-C <cwd>`, same pins — and never consults the injected service.
 *
 * The subprocess service is faked at the resolver boundary (no real spawn,
 * no real network); the local tests mock `node:child_process` like
 * `git-spawn.spec.ts` does.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  GitCommandError,
  installSubprocessResolver,
  runGit,
} from '../src/git.ts'

/** One collected stream tail as the bridge reports it (sealed at exit). */
function tail(text: string): { finalize(): { text: string; truncated: boolean } } {
  return { finalize: () => ({ text, truncated: false }) }
}

/** The spec one spawn sent, and the specs of every spawn so far. */
interface SentSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  graceMs: number
  signal: AbortSignal
  stdio: {
    stdout: { maxBytes: number }
    stderr: { maxBytes: number }
    stdin?: { data: string }
  }
}

/** Install a fake remote bridge. `spawnImpl` answers with the handle shape
 *  the real bridge hands back; the specs it received are recorded. */
function installBridge(spawnImpl: (spec: SentSpec) => unknown): { specs: SentSpec[] } {
  const specs: SentSpec[] = []
  installSubprocessResolver(() => ({
    spawn: (spec: SentSpec): unknown => {
      specs.push(spec)
      return spawnImpl(spec)
    },
  }))
  return { specs }
}

/** The bridge handle for one settled answer: collected tails + a `done`. */
function handleOf(options: {
  stdout?: string
  stderr?: string
  exitCode?: number
  failure?: Error
  hang?: boolean
}): {
  collected: {
    stdout?: { finalize(): { text: string; truncated: boolean } }
    stderr?: { finalize(): { text: string; truncated: boolean } }
  }
  done: Promise<{ exitCode: number | null; signal: string | null }>
} {
  const done = options.hang === true
    ? new Promise<never>(() => {})
    : options.failure !== undefined
      ? Promise.reject(options.failure)
      : Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null })
  return {
    collected: {
      stdout: tail(options.stdout ?? ''),
      stderr: tail(options.stderr ?? ''),
    },
    done,
  }
}

afterEach(() => {
  installSubprocessResolver(undefined)
  spawnMock.mockReset()
  vi.useRealTimers()
})

describe('runGit over the ssh:// remote bridge', () => {
  it('assembles the bridge-contract spec: no -C, the pins, minimal env, bounded stdio', async () => {
    const { specs } = installBridge(() => handleOf({ stdout: 'branch state\n' }))

    await expect(runGit('ssh://myserver/home/u/repo', ['status', '--porcelain=v1'])).resolves.toBe('branch state\n')

    expect(specs).toHaveLength(1)
    const spec = specs[0]!
    // The bridge `cd`s into the remote cwd itself, so the argv must NOT
    // carry `-C` — the machine-readable pins stay the local contract's.
    expect(spec.argv[0]).toBe('git')
    expect(spec.argv).not.toContain('-C')
    expect(spec.argv.slice(1, 6)).toEqual(['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false'])
    expect(spec.argv.slice(6)).toEqual(['status', '--porcelain=v1'])
    expect(spec.cwd).toBe('ssh://myserver/home/u/repo')
    // The minimal env: one variable, never a re-exported process.env.
    expect(spec.env).toEqual({ GIT_OPTIONAL_LOCKS: '0' })
    expect(Object.keys(spec.env)).toEqual(['GIT_OPTIONAL_LOCKS'])
    // A bounded, positive SIGTERM→SIGKILL grace for the bridge's kill ladder.
    expect(spec.graceMs).toBeGreaterThan(0)
    // The timeout rides a live (not-yet-aborted) signal.
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    expect(spec.signal.aborted).toBe(false)
    // Byte-bounded collectors — the bridge contract takes ONLY {maxBytes}.
    expect(spec.stdio.stdout).toEqual({ maxBytes: expect.any(Number) })
    expect(spec.stdio.stdout.maxBytes).toBeGreaterThan(0)
    expect(spec.stdio.stderr).toEqual({ maxBytes: expect.any(Number) })
    expect(spec.stdio.stderr.maxBytes).toBeGreaterThan(0)
    // No input → no stdin payload.
    expect(spec.stdio.stdin).toBeUndefined()
  })

  it('carries stdin {data} exactly when the caller passes input', async () => {
    const { specs } = installBridge(() => handleOf({ stdout: '' }))

    await expect(runGit('ssh://myserver/home/u/repo', ['check-ignore', '--stdin', '-z'], 30_000, 'a.ts\0b.ts\0'))
      .resolves.toBe('')

    expect(specs).toHaveLength(1)
    expect(specs[0]!.stdio.stdin).toEqual({ data: 'a.ts\0b.ts\0' })
  })

  it('resolves with the collected stdout when git exits 0', async () => {
    installBridge(() => handleOf({ stdout: 'abc123\n' }))
    await expect(runGit('ssh://myserver/home/u/repo', ['rev-parse', 'HEAD'])).resolves.toBe('abc123\n')
  })

  it('rejects with the trimmed stderr text when git exits non-zero', async () => {
    installBridge(() => handleOf({ stderr: 'fatal: bad revision HEAD~999\n', exitCode: 128 }))
    const error = await runGit('ssh://myserver/home/u/repo', ['log', '-n', '1', 'HEAD~999']).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(GitCommandError)
    expect((error as GitCommandError).message).toBe('fatal: bad revision HEAD~999')
    expect((error as GitCommandError).code).toBe('git-error')
  })

  it('falls back to "git exited with N" when the failure has no stderr', async () => {
    installBridge(() => handleOf({ stderr: '', exitCode: 1 }))
    const error = await runGit('ssh://myserver/home/u/repo', ['status']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitCommandError)
    expect((error as GitCommandError).message).toBe('git exited with 1')
  })

  it('maps a done rejection (dead connection…) to "cannot run git: …"', async () => {
    installBridge(() => handleOf({ failure: new Error('connection dropped') }))
    const error = await runGit('ssh://myserver/home/u/repo', ['status']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitCommandError)
    expect((error as GitCommandError).message).toBe('cannot run git: connection dropped')
  })

  it('maps a bridge that yields no usable handle to "cannot run git: …"', async () => {
    for (const broken of [undefined, {}, { done: null }, { done: {} }]) {
      installBridge(() => broken)
      const error = await runGit('ssh://myserver/home/u/repo', ['status']).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(GitCommandError)
      expect((error as GitCommandError).message).toBe('cannot run git: the remote subprocess bridge returned no handle')
    }
  })

  it('rejects with the typed git-remote-unavailable error when no resolver is installed — as a rejected promise, never a sync throw', async () => {
    installSubprocessResolver(undefined)
    // The chained-caller regression: the git cache's HEAD probe and friends
    // call `.then()` directly — a synchronous throw here would surface as a
    // TypeError instead of the typed error.
    let chained: Promise<string> | undefined
    expect(() => { chained = runGit('ssh://myserver/home/u/repo', ['status']).then((out) => out) }).not.toThrow()
    await expect(chained).rejects.toMatchObject({ code: 'git-remote-unavailable' })
    await expect(runGit('ssh://myserver/home/u/repo', ['status']))
      .rejects.toThrow(/dsh-ssh-workspace/)
  })

  it('rejects with git-remote-unavailable when the resolver answers no service (absent or pre-takeover)', async () => {
    // The host context has no `subprocess` service at all.
    installSubprocessResolver(() => undefined)
    await expect(runGit('ssh://myserver/home/u/repo', ['status']))
      .rejects.toMatchObject({ code: 'git-remote-unavailable' })
    // A service exists but was not taken over by the ssh plugin — no `spawn`.
    installSubprocessResolver(() => ({ exec: () => {} }))
    await expect(runGit('ssh://myserver/home/u/repo', ['status']))
      .rejects.toMatchObject({ code: 'git-remote-unavailable' })
  })

  it('times out: aborts the spec signal and rejects with the local timeout message', async () => {
    vi.useFakeTimers()
    const { specs } = installBridge(() => handleOf({ hang: true }))

    const pending = runGit('ssh://myserver/home/u/repo', ['status'], 1234)
    const settled = expect(pending).rejects.toMatchObject({
      code: 'git-error',
      message: 'git status timed out after 1234ms',
    })
    expect(specs[0]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1234)
    await settled
    // The abort is the bridge's hard-kill trigger for the remote command.
    expect(specs[0]!.signal.aborted).toBe(true)
  })
})

describe('runGit keeps the local spawn for plain paths', () => {
  /** A local `git` child that answers stdout and exits `code`. */
  function localChild(stdoutText = '', stderrText = '', code = 0): EventEmitter {
    const child = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, { stdout, stderr, kill: vi.fn() })
    queueMicrotask(() => {
      stdout.end(stdoutText)
      stderr.end(stderrText)
      child.emit('close', code)
    })
    return child
  }

  it('spawns git -C <cwd> with the pins, byte-for-byte the pre-remote shape', async () => {
    spawnMock.mockImplementation(() => localChild('true\n'))

    await expect(runGit('/repo', ['rev-parse', '--is-inside-work-tree'])).resolves.toBe('true\n')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [file, args] = spawnMock.mock.calls[0]!
    expect(file).toBe('git')
    expect(args[0]).toBe('-C')
    expect(args[1]).toBe('/repo')
    expect(args.slice(2)).toEqual([
      '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false',
      'rev-parse', '--is-inside-work-tree',
    ])
  })

  it('never consults the injected remote bridge for a local cwd', async () => {
    const { specs } = installBridge(() => handleOf({ stdout: 'REMOTE\n' }))
    spawnMock.mockImplementation(() => localChild('LOCAL\n'))

    await expect(runGit('/repo', ['rev-parse', '--show-toplevel'])).resolves.toBe('LOCAL\n')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(specs).toHaveLength(0)
  })
})
