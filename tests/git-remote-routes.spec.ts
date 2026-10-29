/**
 * The git routes' ssh:// lexical path branches (`src/index.ts`, commit
 * 9f26f9e). A remote workspace session carries the `ssh://<alias>/<path>`
 * spelling as its cwd, and node's own notion of absolute cannot see it — so
 * the index layer resolves git-domain paths LEXICALLY there:
 *
 *  - `requireGitPath` accepts an `ssh://` spelling (trailing slash trimmed,
 *    never `resolve()`d onto the host fs) and keeps `requireAbsolute`'s exact
 *    shape for local paths — a relative cwd/repoRoot is still bad-request;
 *  - `resolveGitPath` joins a session-relative raw onto the cwd's own
 *    spelling (no stat probe) and passes an already-absolute one through;
 *  - `resolveStatusPath` joins onto the answering repository root's
 *    spelling;
 *  - `selectedRepoOf` accepts an `ssh://` repoRoot (compared lexically by
 *    git.ts's `pathIdentity`).
 *
 * The spellings are observable at the spawn boundary: the plugin's `apply`
 * injects git.ts's subprocess resolver from this same context, so a fake
 * `subprocess` service in the context receives every remote spec and the
 * tests can assert the lowered NATIVE operands and the exact `ssh://` cwds.
 * Without a service the typed `git-remote-unavailable` failure surfaces
 * through the API envelope as a 400 `git-error` (not a 500, not
 * bad-request) — the route-level shape of "plugin absent".
 *
 * Mounting follows `fs-read-page.spec.ts`'s FakeContext precedent; no real
 * spawn, no real network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { installSubprocessResolver } from '../src/git.ts'
import type { SidebarWebRoute } from '../src/context-types.ts'

interface SentSpec {
  argv: string[]
  cwd: string
  stdio: { stdin?: { data: string } }
}

/** The fake remote bridge service the context hands to git.ts's resolver. */
let bridgeSpecs: SentSpec[]
let bridgeService: unknown

/** The session header `sessions.get` answers (undefined → no session). */
let headerCwd: string | undefined

const FakeContext = {
  webRuntime: { trustedHosts: [] },
  webServer: {
    register: (route: SidebarWebRoute): (() => void) => { routes.push(route); return () => {} },
    registerUpgrade: (): (() => void) => () => {},
  },
  sessions: { get: (): { header: { cwd?: string } } | undefined => headerCwd === undefined ? undefined : { header: { cwd: headerCwd } } },
  tools: { register: (): (() => void) => () => {} },
  effect: (fn: () => void | (() => void)): void => { fn() },
  inject: (): (() => void) => () => {},
  on: (): (() => void) => () => {},
  get: (key: string): unknown => key === 'subprocess' ? bridgeService : undefined,
}

const routes: SidebarWebRoute[] = []

/** The git subcommand of one remote argv (skip `git` + pins). */
function subcommandOf(argv: string[]): string[] {
  let at = 1
  while (at < argv.length) {
    if (argv[at] === '-c') { at += 2; continue }
    if (argv[at] === '--no-pager') { at += 1; continue }
    break
  }
  return argv.slice(at)
}

/** A bridge answering like a repository rooted at the native root. */
function fakeGitBridge(nativeRoot: string): unknown {
  return {
    spawn: (spec: SentSpec): unknown => {
      bridgeSpecs.push(spec)
      const command = subcommandOf(spec.argv)
      const answer = (text: string, exitCode = 0): unknown => ({
        collected: {
          stdout: { finalize: (): { text: string; truncated: boolean } => ({ text, truncated: false }) },
          stderr: { finalize: (): { text: string; truncated: boolean } => ({ text: '', truncated: false }) },
        },
        done: Promise.resolve({ exitCode, signal: null }),
      })
      if (command[0] === 'rev-parse') {
        if (command[1] === '--show-toplevel') return answer(`${nativeRoot}\n`)
        if (command[1] === '--is-inside-work-tree') return answer('true\n')
        if (command[1] === '--abbrev-ref') return answer('main\n')
      }
      return answer('')
    },
  }
}

/** Mount the plugin fresh and hand back the JSON api route. */
function mountApi(): SidebarWebRoute {
  routes.length = 0
  bridgeSpecs = []
  bridgeService = undefined
  headerCwd = undefined
  apply(FakeContext as never, {})
  return routes.find(route => route.path === '/sidebar/api')!
}

interface RouteOutcome {
  ok: boolean
  value?: Record<string, unknown>
  error?: { code?: string; message?: string }
}

async function call(route: SidebarWebRoute, method: string, payload: Record<string, unknown>): Promise<RouteOutcome> {
  const body = Buffer.from(JSON.stringify({ sessionId: 's', ...payload }))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<Buffer> { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number): void => { out.status = status },
    end: (chunk: unknown): void => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return JSON.parse(out.body) as RouteOutcome
}

afterEach(() => {
  installSubprocessResolver(undefined)
})

describe('the git routes accept the ssh:// workspace spelling', () => {
  it('git.status answers on an ssh:// client cwd, trimmed, and routes the bridge there', async () => {
    const route = mountApi()
    bridgeService = fakeGitBridge('/home/u/p')

    const outcome = await call(route, 'git.status', { cwd: 'ssh://myserver/home/u/p/' })

    // requireGitPath: lexical pass + trailing-slash trim, never resolved().
    expect(outcome.ok).toBe(true)
    expect(outcome.value?.root).toBe('ssh://myserver/home/u/p')
    // Every git call ran ON the trimmed workspace spelling.
    expect(bridgeSpecs.length).toBeGreaterThan(0)
    expect(bridgeSpecs.map(spec => spec.cwd)).toEqual(
      bridgeSpecs.map(() => 'ssh://myserver/home/u/p'),
    )
  })

  it('keeps rejecting a relative cwd as bad-request before any git call', async () => {
    const route = mountApi()
    bridgeService = fakeGitBridge('/home/u/p')

    const outcome = await call(route, 'git.status', { cwd: 'repo' })

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('bad-request')
    expect(outcome.error?.message).toBe('invalid working directory "repo"')
    expect(bridgeSpecs).toHaveLength(0)
  })

  it('accepts an ssh:// repoRoot for the selected repository (lexical identity)', async () => {
    const route = mountApi()
    headerCwd = 'ssh://myserver/home/u/p'
    bridgeService = fakeGitBridge('/home/u/p')

    const outcome = await call(route, 'git.status', { repoRoot: 'ssh://myserver/home/u/p' })

    expect(outcome.ok).toBe(true)
    expect(outcome.value?.root).toBe('ssh://myserver/home/u/p')
    expect(outcome.value?.branch).toBe('main')
  })

  it("still rejects a relative repoRoot, keeping requireAbsolute's exact error shape", async () => {
    const route = mountApi()
    headerCwd = 'ssh://myserver/home/u/p'

    const outcome = await call(route, 'git.status', { repoRoot: 'repo' })

    // requireGitPath keeps the local shape byte-for-byte: requireAbsolute's
    // own fs-error (the 'invalid working directory' wrap exists only on the
    // session-cwd fallbacks). Rejected before any git call runs.
    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('fs-error')
    expect(bridgeSpecs).toHaveLength(0)
  })
})

describe('the git routes resolve paths lexically on a remote workspace', () => {
  it('git.diff-head joins a session-relative path onto the ssh:// cwd and lowers it to native', async () => {
    const route = mountApi()
    headerCwd = 'ssh://myserver/home/u/p'
    bridgeService = fakeGitBridge('/home/u/p')

    const relative = await call(route, 'git.diff-head', { path: 'src/a.ts' })
    expect(relative.ok).toBe(true)
    expect(relative.value?.diff).toBe('')

    const absolute = await call(route, 'git.diff-head', { path: 'ssh://myserver/home/u/p/src/b.ts' })
    expect(absolute.ok).toBe(true)

    const diffs = bridgeSpecs.filter(spec => subcommandOf(spec.argv)[0] === 'diff')
    expect(diffs.map(spec => spec.argv.at(-1))).toEqual([
      '/home/u/p/src/a.ts', // session-relative → joined onto the spelling → native
      '/home/u/p/src/b.ts', // already-absolute spelling → passed through → native
    ])
    expect(diffs.map(spec => spec.cwd)).toEqual([
      'ssh://myserver/home/u/p',
      'ssh://myserver/home/u/p',
    ])
  })

  it("git.diff joins a relative path onto the answering repository root's spelling", async () => {
    const route = mountApi()
    headerCwd = 'ssh://myserver/home/u/p'
    bridgeService = fakeGitBridge('/home/u/p')

    const outcome = await call(route, 'git.diff', { path: 'src/rel.ts' })

    expect(outcome.ok).toBe(true)
    const diffs = bridgeSpecs.filter(spec => subcommandOf(spec.argv)[0] === 'diff')
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.argv.slice(-2)).toEqual(['--', '/home/u/p/src/rel.ts'])
  })
})

describe('the git routes degrade cleanly without the subprocess service', () => {
  it('answers the typed remote-unavailable failure as a 400 git-error, not a crash', async () => {
    const route = mountApi()
    headerCwd = 'ssh://myserver/home/u/p'
    bridgeService = undefined // no dsh-ssh-workspace on the host

    const outcome = await call(route, 'git.status', {})

    expect(outcome.ok).toBe(false)
    expect(outcome.error?.code).toBe('git-error')
    expect(outcome.error?.message).toContain('dsh-ssh-workspace')
  })
})
