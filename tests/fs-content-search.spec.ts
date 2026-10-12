/**
 * fs-content-search: the host's text-CONTENT search behind the file tree's
 * 「文本内容搜索」 section. Pinned here:
 *
 * - entry classification (src/fs-content-search.ts `classifyEntries`): an
 *   existing directory scopes the search, an existing file is searched
 *   alone, everything else degrades to a glob pattern — including entries
 *   resolveTarget cannot resolve and the exclude-side concrete shapes
 *   (an exclude DIR must narrow the search, never widen it);
 * - include union / empty semantics, and the glob subset grammar (bare name,
 *   the `**` + `/` head, `*` / `?`) reusing exclude-patterns.ts;
 * - exclude stacking: the user's exclude list applies AFTER include scoping,
 *   and the explorerExclude preference stacks on top of it;
 * - the rg pass: argv SHAPE (pinned byte-for-byte against
 *   `contentRgArgv` — no real process is ever spawned) and the fallback to
 *   the plain walk when rg is absent or fails at runtime;
 * - the walk's budgets (`maxMatches` / `maxVisited` + `truncated`) and the
 *   content rules: binary sniff (NUL in the first 8 KiB) and the 512 KiB
 *   per-file skip.
 *
 * Everything runs through injected engine hooks — CI has no rg and the
 * fixtures use only Windows-legal file names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { compileExcludePatterns } from '../src/exclude-patterns.ts'
import {
  buildContentFilter,
  classifyEntries,
  contentRgArgv,
  contentSearch,
  searchContentPlain,
  type ContentScopes,
} from '../src/fs-content-search.ts'
import { resetEngines, setEngineHooks, SKIP_DIR_NAMES } from '../src/search-engines.ts'
import type { EngineProbe } from '../src/search-engines.ts'

/**
 * Symlink creation needs extra privileges on Windows; the symlink case skips
 * there rather than fails (mirror of the fs-search spec).
 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A scratch tree: text hits at several depths, plus the noise classes. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# the answer\n')
  writeFileSync(join(dir, 'src', 'a.ts'), 'const answer = 42\n')
  writeFileSync(join(dir, 'src', 'b.ts'), '// TODO: fix the answer later\n')
  writeFileSync(join(dir, 'docs', 'guide.md'), 'The Answer is 42.\n')
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 42\n')
  writeFileSync(join(dir, '.git', 'config'), 'the answer hides here\n')
  // A BINARY file whose bytes still contain the needle: the NUL in the
  // first 8 KiB must sink it (without the sniff this row would match).
  writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('the answer is 42')]))
  return dir
}

const EMPTY_SCOPES: ContentScopes = {
  dirs: [], files: [], includeGlobs: [],
  excludeDirs: [], excludeFiles: [], excludeGlobs: [],
}

describe('classifyEntries', () => {
  it('classifies existing directories and files, and degrades the rest to globs', async () => {
    const dir = makeFixture()
    try {
      const scopes = await classifyEntries(dir, ['src', join(dir, 'docs', 'guide.md'), '*.md', 'no-such-entry-*', '   '], [])
      expect(scopes.dirs).toEqual([join(dir, 'src')])
      expect(scopes.files).toEqual([join(dir, 'docs', 'guide.md')])
      // Patterns (and whitespace-only junk) fall through to the glob list —
      // the compiler drops the malformed ones silently later.
      expect(scopes.includeGlobs).toEqual(['*.md', 'no-such-entry-*', ''])
      expect(scopes.excludeDirs).toEqual([])
      expect(scopes.excludeFiles).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies exclude-side entries separately: an exclude dir must never widen the search', async () => {
    const dir = makeFixture()
    try {
      const scopes = await classifyEntries(dir, [], ['src', join(dir, 'README.md'), 'nope'])
      // NOT scopes.dirs/files — the exclude verdicts live on their own side.
      expect(scopes.dirs).toEqual([])
      expect(scopes.files).toEqual([])
      expect(scopes.excludeDirs).toEqual([join(dir, 'src')])
      expect(scopes.excludeFiles).toEqual([join(dir, 'README.md')])
      expect(scopes.excludeGlobs).toEqual(['nope'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('searchContentPlain (the fallback walk)', () => {
  it('matches contents case-insensitively, files only, skipping noise and binaries', async () => {
    const dir = makeFixture()
    try {
      const result = await searchContentPlain(dir, 'ANSWER', EMPTY_SCOPES)
      // node_modules / .git are never entered; blob.bin carries a NUL in its
      // first bytes (binary sniff); every hit is a root-relative FILE.
      expect(result).toEqual({
        matches: ['README.md', 'docs/guide.md', 'src/a.ts', 'src/b.ts'],
        truncated: false,
      })
      for (const match of result.matches) {
        expect(match.startsWith(dir)).toBe(false)
        expect(match).not.toContain('\\')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty (or whitespace) query matches nothing', async () => {
    const dir = makeFixture()
    try {
      expect(await searchContentPlain(dir, '   ', EMPTY_SCOPES)).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an existing-directory include scope limits the search to that subtree', async () => {
    const dir = makeFixture()
    try {
      const scopes = await classifyEntries(dir, ['src'])
      expect(await searchContentPlain(dir, 'answer', scopes)).toEqual({
        matches: ['src/a.ts', 'src/b.ts'],
        truncated: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an existing-file include is searched alone; several entries are a UNION', async () => {
    const dir = makeFixture()
    try {
      const alone = await classifyEntries(dir, ['docs/guide.md'])
      expect(await searchContentPlain(dir, 'answer', alone)).toEqual({
        matches: ['docs/guide.md'],
        truncated: false,
      })
      // Union: the dir scope (src/*) plus the lone file.
      const union = await classifyEntries(dir, ['src', 'docs/guide.md'])
      expect((await searchContentPlain(dir, 'answer', union)).matches).toEqual([
        'docs/guide.md',
        'src/a.ts',
        'src/b.ts',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('glob includes use the exclude-patterns subset grammar (bare name, doublestar head, * and ?)', async () => {
    const dir = makeFixture()
    try {
      // Bare name: matches that base name at ANY depth.
      expect((await searchContentPlain(dir, 'answer', { ...EMPTY_SCOPES, includeGlobs: ['a.ts'] })).matches)
        .toEqual(['src/a.ts'])
      // The `**` + `/` head strips away — the same any-depth name match.
      expect((await searchContentPlain(dir, 'answer', { ...EMPTY_SCOPES, includeGlobs: ['**/a.ts'] })).matches)
        .toEqual(['src/a.ts'])
      // Path-anchored with a `*` wildcard inside one segment.
      expect((await searchContentPlain(dir, 'answer', { ...EMPTY_SCOPES, includeGlobs: ['docs/*', 'src/b.ts'] })).matches)
        .toEqual(['docs/guide.md', 'src/b.ts'])
      // `?` matches exactly one character within the segment.
      expect((await searchContentPlain(dir, 'answer', { ...EMPTY_SCOPES, includeGlobs: ['?.ts'] })).matches)
        .toEqual(['src/a.ts', 'src/b.ts'])
      // Glob include + concrete dir scope: the union, not an intersection
      // (the concrete scope bypasses the glob filter).
      const both = { ...EMPTY_SCOPES, dirs: [join(dir, 'src')], includeGlobs: ['*.md'] }
      expect((await searchContentPlain(dir, 'answer', both)).matches)
        .toEqual(['README.md', 'docs/guide.md', 'src/a.ts', 'src/b.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('excludes apply after include scoping, concretely and as globs', async () => {
    const dir = makeFixture()
    try {
      // Glob exclude narrows the workspace search.
      const globOut = { ...EMPTY_SCOPES, excludeGlobs: ['*.ts'] }
      expect((await searchContentPlain(dir, 'answer', globOut)).matches).toEqual(['README.md', 'docs/guide.md'])
      // An exclude DIRECTORY drops its whole subtree (the walk never descends).
      const dirOut = { ...EMPTY_SCOPES, excludeDirs: [join(dir, 'docs')] }
      expect((await searchContentPlain(dir, 'answer', dirOut)).matches).toEqual(['README.md', 'src/a.ts', 'src/b.ts'])
      // An exclude FILE drops exactly that file.
      const fileOut = { ...EMPTY_SCOPES, excludeFiles: [join(dir, 'src', 'a.ts')] }
      expect((await searchContentPlain(dir, 'answer', fileOut)).matches).toEqual([
        'README.md',
        'docs/guide.md',
        'src/b.ts',
      ])
      // Excludes apply to include-scoped results too (after scoping).
      const scoped = { dirs: [join(dir, 'src')], files: [], includeGlobs: [], excludeDirs: [], excludeFiles: [], excludeGlobs: ['b.ts'] }
      expect((await searchContentPlain(dir, 'answer', scoped)).matches).toEqual(['src/a.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the explorerExclude preference stacks ON TOP of the exclude list', async () => {
    const dir = makeFixture()
    try {
      const scopes: ContentScopes = { ...EMPTY_SCOPES, excludeGlobs: ['*.ts'] }
      const prefExclude = compileExcludePatterns(['*.md'], dir)
      // Each layer alone leaves one hit…
      expect((await searchContentPlain(dir, 'answer', scopes)).matches).toEqual(['README.md', 'docs/guide.md'])
      expect((await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { prefExclude })).matches)
        .toEqual(['src/a.ts', 'src/b.ts'])
      // …together they leave none: two layers, one surface.
      expect(await searchContentPlain(dir, 'answer', scopes, { prefExclude })).toEqual({
        matches: [],
        truncated: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips files over the 512 KiB single-file cap instead of partially matching', async () => {
    const dir = makeFixture()
    try {
      writeFileSync(join(dir, 'huge.log'), `${'x'.repeat(512 * 1024 + 1)}needle-42\n`)
      writeFileSync(join(dir, 'small.log'), 'needle-42\n')
      expect((await searchContentPlain(dir, 'needle-42', EMPTY_SCOPES)).matches).toEqual(['small.log'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the match budget is exceeded', async () => {
    const dir = makeFixture()
    try {
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { maxMatches: 2 })
      expect(result.truncated).toBe(true)
      expect(result.matches.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the visited budget is exceeded', async () => {
    const dir = makeFixture()
    try {
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { maxVisited: 2 })
      expect(result.truncated).toBe(true)
      expect(result.matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable root yields no matches instead of throwing', async () => {
    const dir = makeFixture()
    try {
      expect(await searchContentPlain(join(dir, 'does-not-exist'), 'x', EMPTY_SCOPES)).toEqual({
        matches: [],
        truncated: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('never descends into symlinked directories (cycle safety)', async () => {
    const dir = makeFixture()
    try {
      symlinkSync(dir, join(dir, 'loop'))
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES)
      expect(result.matches).toEqual(['README.md', 'docs/guide.md', 'src/a.ts', 'src/b.ts'])
      expect(result.truncated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildContentFilter', () => {
  it('exclude verdicts cover ancestors and stop at the root', () => {
    const root = '/work/project'
    const scopes: ContentScopes = { ...EMPTY_SCOPES, excludeGlobs: ['third_party', 'build/out'] }
    const filter = buildContentFilter(root, scopes)
    expect(filter.excluded(`${root}/third_party`)).toBe(true)
    // A file UNDER an excluded directory is excluded too (the walk could
    // never have descended there).
    expect(filter.excluded(`${root}/third_party/pkg/index.js`)).toBe(true)
    expect(filter.excluded(`${root}/src/index.ts`)).toBe(false)
    expect(filter.excluded(`${root}/build/out/a.js`)).toBe(true)
    expect(filter.excluded(`${root}/build/in/a.js`)).toBe(false)
    // The root itself is never excluded (the walk only tests below it).
    expect(filter.excluded(root)).toBe(false)
  })
})

/**
 * The rg pass. The argv shape is pinned WITHOUT a real process: the dispatch
 * runs through the injected `spawner` hook (the same seam the name-search
 * engines use), and the scripted child replays stdout lines.
 */
describe('contentSearch dispatch (rg first, walk fallback)', () => {
  const rgProbe: EngineProbe = { engine: 'rg', binary: '/fake/rg' }

  afterEach(() => {
    resetEngines()
  })

  it('rg argv: literal case-insensitive files-with-matches over multi-root paths, skip globs, no pattern entries', () => {
    const argv = contentRgArgv('answer', ['/root', '/other'])
    expect(argv.slice(0, 3)).toEqual(['--files-with-matches', '-i', '-F'])
    expect(argv).toContain('--hidden')
    expect(argv).toContain('--no-ignore')
    expect(argv).toContain('--path-separator')
    expect(argv[argv.indexOf('--path-separator') + 1]).toBe('/')
    // `--` guards a needle that looks like a flag; the pattern precedes the
    // multi-root include paths.
    expect(argv[argv.indexOf('--') + 1]).toBe('answer')
    expect(argv.slice(argv.length - 2)).toEqual(['/root', '/other'])
    // One skip glob pair per SKIP_DIR_NAMES entry (directory + bare entry).
    const iglobs: (string | undefined)[] = []
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--iglob') iglobs.push(argv[index + 1])
    }
    for (const name of SKIP_DIR_NAMES) {
      expect(iglobs).toContain(`!**/${name}/**`)
      expect(iglobs).toContain(`!**/${name}`)
    }
    // Pattern-shaped include/exclude entries NEVER ride the argv — they are
    // judged host-side through compileExcludePatterns (no --glob at all).
    expect(argv).not.toContain('--glob')
    expect(iglobs.every(glob => !glob!.includes('*.'))).toBe(true)
  })

  it('routes through the pinned argv, then filters engine output host-side', async () => {
    const dir = makeFixture()
    try {
      let seenArgv: readonly string[] | undefined
      let seenCwd: string | undefined
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: (binary, argv, options) => {
          expect(binary).toBe('/fake/rg')
          seenArgv = argv
          seenCwd = options.cwd
          return scriptedChild([
            `${dir}/src/a.ts`,
            `${dir}/README.md`,
            `${dir}/docs/guide.md`,
          ])
        },
      })
      // exclude entry '*.md' stats to nothing → glob, judged HOST-side.
      // (A real rg would also prune node_modules / .git via the argv's skip
      // globs — that division of labor is pinned by the argv test above, so
      // the scripted output here carries only rows the argv would emit.)
      const result = await contentSearch(dir, 'answer', { exclude: ['*.md'] })
      expect(seenCwd).toBe(dir)
      expect(seenArgv).toEqual(contentRgArgv('answer', [dir]))
      expect(result).toEqual({ matches: ['src/a.ts'], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('caps engine output at maxMatches and reports truncated', async () => {
    setEngineHooks({
      prober: async () => [rgProbe],
      spawner: () => scriptedChild(['/w/b', '/w/a', '/w/c']),
    })
    const result = await contentSearch('/w', 'answer', { maxMatches: 2 })
    expect(result.matches).toEqual(['a', 'b'])
    expect(result.truncated).toBe(true)
  })

  it('falls back to the plain walk when rg fails at runtime', async () => {
    const dir = makeFixture()
    try {
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptedChild(undefined, new Error('rg exploded')),
      })
      const result = await contentSearch(dir, 'answer', { exclude: ['*.ts'] })
      expect(result).toEqual({ matches: ['README.md', 'docs/guide.md'], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the plain walk when no engine is probed', async () => {
    const dir = makeFixture()
    try {
      let spawned = false
      setEngineHooks({
        prober: async () => [],
        spawner: () => {
          spawned = true
          throw new Error('nothing should spawn without a probed engine')
        },
      })
      expect(await contentSearch(dir, 'answer')).toEqual({
        matches: ['README.md', 'docs/guide.md', 'src/a.ts', 'src/b.ts'],
        truncated: false,
      })
      expect(spawned).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a blank query matches nothing and never probes or spawns', async () => {
    let probed = false
    setEngineHooks({
      prober: async () => {
        probed = true
        return [rgProbe]
      },
      spawner: () => {
        throw new Error('nothing should spawn for a blank query')
      },
    })
    expect(await contentSearch('/w', '   ')).toEqual({ matches: [], truncated: false })
    expect(probed).toBe(false)
  })
})

/**
 * A scripted rg child: stdout fed once, closed, then the `close` event —
 * the settlement streamLines depends on (#883). Passing `error` replays a
 * runtime failure instead.
 */
function scriptedChild(lines?: readonly string[], error?: Error): ChildProcess {
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
    kill(): boolean { return true },
  }
  const emit = (event: string, arg?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(arg)
  }
  queueMicrotask(async () => {
    if (error !== undefined) {
      emit('error', error)
      return
    }
    stdout.write(`${(lines ?? []).join('\n')}\n`)
    stdout.end()
    await new Promise<void>(resolve => { stdout.once('end', resolve) })
    emit('close', 0)
  })
  return child as unknown as ChildProcess
}

/** Test isolation: the engine hooks leak across files in the same worker. */
beforeEach(() => {
  resetEngines()
})
