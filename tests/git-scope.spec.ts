/**
 * 「git 起点」（git-from scope）规格（搜索页的可选候选集过滤）：
 *
 * - `resolveGitScope` 的解析顺序：有效提交/引用（`rev-parse … ^{commit}`）
 *   → 日期（`rev-list -1 --before=… HEAD`，git 自己的日期文法，早于分支
 *   首个提交的日期=空答案=失败）→ 两者皆非 = bad-request；
 * - 非 git 目录 = bad-request（「不是 git 仓库」），git stderr 不外泄；
 * - 差异文件集 = 基线 → 当前工作树的一条 `git diff --name-only -z`：已提
 *   交 + 暂存 + 未暂存都在集内，untracked 不在（不存在可比较的基线），
 *   删除的文件自然缺席；
 * - repoRoot ≠ cwd 的路径映射：git 的仓库根相对路径折算成 cwd 相对，
 *   落在 cwd 外的丢弃；
 * - 引擎一致性：同一 gitFiles 集在 rg（脚本化 --json 事件）与 walk 两引
 *   擎下结果逐字段一致——集外文件一个都不出，集内文件照常带命中。
 *
 * 全部跑在临时真实 git 仓库上（active-worktree.spec 的 fixture 形制：
 * spawnSync + 隔离身份 + core.hooksPath= 免全局钩子）。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { resolveGitScope } from '../src/git-scope.ts'
import { contentSearch, searchContentPlain } from '../src/fs-content-search.ts'
import { resetEngines, setEngineHooks, type EngineProbe } from '../src/search-engines.ts'
import { SidebarError } from '../src/wire.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function git(cwd: string, args: string[], date?: string): string {
  // `core.hooksPath=` keeps a developer's global commit-msg hook out of the scratch repos.
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...IDENTITY,
      ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

/** The scratch repo: a base commit (two files, both carrying the needle),
 *  then a second commit that adds src/changed.ts and rewrites README.md. */
function initRepo(path: string, dates?: [string, string]): string {
  mkdirSync(join(path, 'src'), { recursive: true })
  git(path, ['init', '-q'])
  git(path, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(path, 'src', 'keep.ts'), 'const answer = 42\n')
  writeFileSync(join(path, 'README.md'), '# the answer\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'base'], dates?.[0])
  writeFileSync(join(path, 'src', 'changed.ts'), 'export const answer = 42\n')
  writeFileSync(join(path, 'README.md'), '# the answer, changed\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'second'], dates?.[1])
  return git(path, ['rev-parse', 'HEAD']).trim()
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-git-scope-${prefix}-`))
}

/** The walk's scopes: no include entries → the WHOLE workspace is walked
 *  (fs-content-search's own rule), so the gitFiles gate is the only filter. */
const WHOLE_WORKSPACE = { dirs: [], files: [], includeGlobs: [], excludeDirs: [], excludeFiles: [], excludeGlobs: [] }

/** In a repo with the two-commit shape, the baseline = base commit answers
 *  exactly the two paths the second commit touched — never keep.ts. */
async function scopeOfBase(root: string): Promise<Set<string>> {
  const base = git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim()
  const scope = await resolveGitScope(root, base)
  expect(scope.commit).toBe(base)
  return scope.files
}

describe('resolveGitScope（真实 git 仓库）', () => {
  it('a commit 起点 scopes the diff of everything after it — committed, staged and unstaged, never untracked', async () => {
    const root = scratch('commit')
    try {
      const head = initRepo(root)
      // Post-commit worktree edits: one staged, one unstaged — one diff
      // against the baseline answers all three layers together.
      writeFileSync(join(root, 'staged.ts'), 'staged answer\n')
      git(root, ['add', 'staged.ts'])
      writeFileSync(join(root, 'README.md'), '# the answer, changed again\n')
      writeFileSync(join(root, 'untracked.ts'), 'untracked answer\n')
      const base = git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim()
      const scope = await resolveGitScope(root, base)
      expect(scope.commit).toBe(base)
      expect([...scope.files].sort()).toEqual(['README.md', 'src/changed.ts', 'staged.ts'])
      // HEAD as the 起点: only the worktree's own edits differ — the staged
      // new file AND the unstaged README rewrite (one diff carries both
      // layers); src/changed.ts is already IN head, so it drops out.
      const headScope = await resolveGitScope(root, head)
      expect([...headScope.files].sort()).toEqual(['README.md', 'staged.ts'])
      // Untracked files sit in no baseline: never candidates…
      expect(headScope.files.has('untracked.ts')).toBe(false)
      // …and a relative ref expression works (HEAD~1 = the base commit).
      const tilde = await resolveGitScope(root, 'HEAD~1')
      expect(tilde.commit).toBe(base)
      expect(tilde.files.has('src/keep.ts')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a 日期 起点 rides git\'s own --before parser and an empty answer is a failure', async () => {
    const root = scratch('date')
    try {
      initRepo(root, ['2026-01-01T00:00:00+00:00', '2026-06-01T00:00:00+00:00'])
      const head = git(root, ['rev-parse', 'HEAD']).trim()
      const base = git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim()
      // A date strictly between the two commits → baseline = base.
      const scope = await resolveGitScope(root, '2026-03-01')
      expect(scope.commit).toBe(base)
      expect([...scope.files].sort()).toEqual(['README.md', 'src/changed.ts'])
      // A datetime spelling parses the same way; here it sits AFTER the
      // second commit, so the baseline IS head and a clean tree diffs empty.
      const stamped = await resolveGitScope(root, '2026-06-01 12:00')
      expect(stamped.commit).toBe(head)
      expect(stamped.files.size).toBe(0)
      // A date predating the branch's first commit yields an EMPTY rev-list
      // answer — that is "no such baseline", a bad-request, not "everything".
      await expect(resolveGitScope(root, '1999-01-01')).rejects.toMatchObject({
        code: 'bad-request',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an input that is neither a commit nor a date is a clean bad-request', async () => {
    const root = scratch('bogus')
    try {
      initRepo(root)
      await expect(resolveGitScope(root, 'nope-not-a-ref')).rejects.toBeInstanceOf(SidebarError)
      await expect(resolveGitScope(root, 'nope-not-a-ref')).rejects.toMatchObject({
        code: 'bad-request',
      })
      // An option-looking input must not parse as a flag (it fails as a rev,
      // never escapes the git invocation).
      await expect(resolveGitScope(root, '--exec')).rejects.toMatchObject({ code: 'bad-request' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a non-git workspace is a bad-request before any rev parsing', async () => {
    const dir = scratch('nogit')
    try {
      mkdirSync(join(dir, 'inner'), { recursive: true })
      await expect(resolveGitScope(dir, 'HEAD')).rejects.toMatchObject({
        code: 'bad-request',
        message: '当前工作区不是 git 仓库（not a git repository）',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('repoRoot ≠ cwd: git paths map to cwd-relative and out-of-cwd paths drop', async () => {
    const root = scratch('subdir')
    try {
      initRepo(root)
      // A second commit touching one file INSIDE sub/ and one OUTSIDE it.
      mkdirSync(join(root, 'sub'), { recursive: true })
      writeFileSync(join(root, 'sub', 'inside.ts'), 'const answer = 42\n')
      writeFileSync(join(root, 'outside.txt'), 'the answer outside\n')
      git(root, ['add', '-A'])
      git(root, ['commit', '-q', '-m', 'subdir'])
      const base = git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim()
      const cwd = join(root, 'sub')
      const scope = await resolveGitScope(cwd, base)
      // git answers repo-root-relative: README.md and src/changed.ts sit
      // OUTSIDE the session cwd → dropped; sub/inside.ts (new in commit
      // three) reads as 'inside.ts'. keep.ts never differs.
      expect([...scope.files]).toEqual(['inside.ts'])
      // And the search itself answers in cwd-relative form.
      const found = await searchContentPlain(cwd, 'answer', WHOLE_WORKSPACE, { gitFiles: scope.files })
      expect(found.matches.map(file => file.path)).toEqual(['inside.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── 引擎一致性：同一 gitFiles 集在 rg 与 walk 下结果一致 ──────────────────

const rgProbe: EngineProbe = { engine: 'rg', binary: '/fake/rg' }

/** One rg --json event line (only the fields the parser reads). */
const beginEv = (path: string): string =>
  JSON.stringify({ type: 'begin', data: { path: { text: path } } })
const matchEv = (path: string, lineNumber: number, text: string): string =>
  JSON.stringify({ type: 'match', data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: lineNumber } })
const endEv = (path: string): string =>
  JSON.stringify({ type: 'end', data: { path: { text: path } } })

/** Script one rg child over `--json` event lines (fs-content-search.spec's
 *  shape): the spawner hook replays stdout, no real binary involved. */
function scriptEvents(lines: readonly string[]): ChildProcess {
  const stdout = new PassThrough()
  const listeners = new Map<string, Array<(arg?: unknown) => void>>()
  const child = {
    stdout,
    once(event: string, listener: (arg?: unknown) => void): ChildProcess {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return child as unknown as ChildProcess
    },
    kill(): boolean {
      return true
    },
  }
  const emit = (event: string, arg?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(arg)
  }
  queueMicrotask(async () => {
    stdout.write(`${lines.join('\n')}\n`)
    stdout.end()
    await new Promise<void>(resolve => { stdout.once('end', resolve) })
    emit('close', 0)
  })
  return child as unknown as ChildProcess
}

describe('gitFiles 过滤（两引擎一致）', () => {
  it('rg (scripted begin events) and the walk answer identically: out-of-set files never surface', async () => {
    const root = scratch('engines')
    try {
      initRepo(root)
      const files = await scopeOfBase(root)
      expect([...files].sort()).toEqual(['README.md', 'src/changed.ts'])
      // rg "runs" over the whole tree but reports BOTH in-set and out-of-set
      // files — the host's begin-event gate must drop the out-of-set ones.
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(join(root, 'src', 'keep.ts')),
          matchEv(join(root, 'src', 'keep.ts'), 1, 'const answer = 42'),
          endEv(join(root, 'src', 'keep.ts')),
          beginEv(join(root, 'src', 'changed.ts')),
          matchEv(join(root, 'src', 'changed.ts'), 1, 'export const answer = 42'),
          endEv(join(root, 'src', 'changed.ts')),
          beginEv(join(root, 'README.md')),
          matchEv(join(root, 'README.md'), 1, '# the answer, changed'),
          endEv(join(root, 'README.md')),
        ]),
      })
      const viaRg = await contentSearch(root, 'answer', { gitFiles: files })
      resetEngines() // the next search takes the plain walk
      const viaWalk = await searchContentPlain(root, 'answer', WHOLE_WORKSPACE, { gitFiles: files })
      const unscoped = await searchContentPlain(root, 'answer', WHOLE_WORKSPACE)
      expect(viaRg).toEqual(viaWalk)
      expect(viaRg.matches.map(file => file.path).sort()).toEqual(['README.md', 'src/changed.ts'])
      // The gate is REAL: without it keep.ts matches (same tree, same query).
      expect(unscoped.matches.map(file => file.path)).toContain('src/keep.ts')
      // Each surviving file carries its hit untouched.
      const changed = viaRg.matches.find(file => file.path === 'src/changed.ts')
      expect(changed).toMatchObject({ count: 1, hits: [{ line: 1, column: 13, length: 6 }] })
    } finally {
      resetEngines()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an empty diff set (baseline = HEAD, clean tree) answers nothing in both engines', async () => {
    const root = scratch('clean')
    try {
      const head = initRepo(root)
      const scope = await resolveGitScope(root, head)
      expect(scope.files.size).toBe(0)
      const viaWalk = await searchContentPlain(root, 'answer', WHOLE_WORKSPACE, { gitFiles: scope.files })
      expect(viaWalk).toEqual({ matches: [], truncated: false })
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(join(root, 'src', 'keep.ts')),
          matchEv(join(root, 'src', 'keep.ts'), 1, 'const answer = 42'),
          endEv(join(root, 'src', 'keep.ts')),
        ]),
      })
      const viaRg = await contentSearch(root, 'answer', { gitFiles: scope.files })
      expect(viaRg).toEqual({ matches: [], truncated: false })
    } finally {
      resetEngines()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
