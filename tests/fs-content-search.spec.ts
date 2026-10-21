/**
 * fs-content-search v2: the host's LINE-LEVEL content search behind the
 *「搜索」page (PhpStorm-style Find in Files). Pinned here (design doc
 * §5 / §8):
 *
 * - entry classification (`classifyEntries`): an existing directory scopes
 *   the search, an existing file is searched alone, everything else
 *   degrades to a glob pattern — including the exclude-side concrete
 *   shapes (an exclude DIR must narrow the search, never widen it);
 * - the ONE matcher (`createLineMatcher`, options resolved through
 *   `resolveMatchOptions`): literal case-insensitive by default,
 *   caseSensitive / wholeWord / regex semantics, ALL ranges as JS string
 *   indices over the decoded line — both engines share this instance, so
 *   a hit's column/length never depends on which engine answered;
 * - the plain walk: v2 line hits (1-based line, 0-based column, verbatim
 *   line text, ≤2 before/after context lines), the include/exclude/
 *   prefExclude verdicts, the content rules (binary sniff, 512 KiB skip)
 *   and every budget (`maxMatches` files, `maxVisited`, `maxHitsPerFile`,
 *   `maxTotalHits`) with honest `truncated` flags — a file's `count` stays
 *   the TRUE total, the per-file `truncated` marks the payload cut;
 * - the rg pass: argv SHAPE (`--json -C 2`, mode flags, `-e` for regex
 *   patterns before `--`, literal `-- query` otherwise, multi-root
 *   include paths, skip globs, NO --glob for pattern entries) and `--json`
 *   EVENT ASSEMBLY through the scripted spawner (search-engines' test
 *   hook): per-file grouping, context-window filling, host-side filter
 *   verdicts, host re-derived hit ranges (rg's byte offsets ignored) and
 *   the match-event-counted stream sentinel.
 *
 * Everything runs through injected engine hooks — no real rg is needed.
 * The route-level contract (regex compile-once → clean `bad-request`,
 * wire shape end to end) is pinned in smoke.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { compileExcludePatterns } from '../src/exclude-patterns.ts'
import {
  MAX_HITS_PER_FILE,
  MAX_TOTAL_HITS,
  buildContentFilter,
  classifyEntries,
  contentRgArgv,
  contentSearch,
  createLineMatcher,
  resolveMatchOptions,
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

/** A scratch tree: hits at several depths, a two-hits-on-one-line file, plus
 *  the noise classes (dependency/VCS forests, a NUL-carrying binary). */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# the answer\n')
  writeFileSync(join(dir, 'src', 'a.ts'), 'const answer = 42\n')
  writeFileSync(join(dir, 'src', 'b.ts'), '// TODO: fix the answer later\n')
  writeFileSync(join(dir, 'src', 'multi.ts'), 'an answer and another answer here\n')
  writeFileSync(join(dir, 'docs', 'guide.md'), 'The Answer is 42.\n')
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 42\n')
  writeFileSync(join(dir, '.git', 'config'), 'the answer hides here\n')
  // A BINARY file whose bytes still contain the needle: the NUL in the
  // first 8 KiB must sink it (without the sniff this row would match).
  writeFileSync(join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('the answer is 42')]))
  return dir
}

/** Every file the fixture's case-insensitive「answer」walk must report. */
const ALL_ANSWER_FILES = ['README.md', 'docs/guide.md', 'src/a.ts', 'src/b.ts', 'src/multi.ts']

const EMPTY_SCOPES: ContentScopes = {
  dirs: [], files: [], includeGlobs: [],
  excludeDirs: [], excludeFiles: [], excludeGlobs: [],
}

describe('resolveMatchOptions + createLineMatcher (the ONE matcher)', () => {
  it('resolves the loose wire booleans (a stale payload means the v1 default)', () => {
    expect(resolveMatchOptions({})).toEqual({ caseSensitive: false, wholeWord: false, regex: false })
    expect(resolveMatchOptions({ caseSensitive: true, wholeWord: true, regex: true }))
      .toEqual({ caseSensitive: true, wholeWord: true, regex: true })
    expect(resolveMatchOptions({ caseSensitive: 'yes' as unknown as boolean }))
      .toEqual({ caseSensitive: false, wholeWord: false, regex: false })
  })

  it('literal default: case-insensitive, every range, original-text indices', () => {
    const match = createLineMatcher('Answer', resolveMatchOptions({}))
    expect(match('an answer and an ANSWER end')).toEqual([
      { start: 3, length: 6 },
      { start: 17, length: 6 },
    ])
    // Slicing the ORIGINAL text with the reported range yields the hit.
    const [only] = match('an ANSWER here')
    expect(only).toBeDefined()
    expect('an ANSWER here'.slice(only!.start, only!.start + only!.length)).toBe('ANSWER')
  })

  it('caseSensitive keeps the case-exact ranges only', () => {
    const match = createLineMatcher('Answer', resolveMatchOptions({ caseSensitive: true }))
    expect(match('The Answer is 42')).toEqual([{ start: 4, length: 6 }])
    expect(match('the answer is 42')).toEqual([])
  })

  it('wholeWord demands non-word edges; line start/end count as boundaries', () => {
    const match = createLineMatcher('answer', resolveMatchOptions({ wholeWord: true }))
    expect(match('answer')).toEqual([{ start: 0, length: 6 }])
    expect(match('the answer is')).toEqual([{ start: 4, length: 6 }])
    expect(match('answers and answering')).toEqual([])
    // A word char on EITHER edge disqualifies; '_' is a word char too.
    expect(match('my_answer')).toEqual([])
  })

  it('regex compiles once, finds every range, and never spins on a zero-length match', () => {
    const match = createLineMatcher('\\d+', resolveMatchOptions({ regex: true }))
    expect(match('run 42 times, then 7 more')).toEqual([
      { start: 4, length: 2 },
      { start: 19, length: 1 },
    ])
    // `a*` past the full match answers one EMPTY range at the tail: the scan
    // advances (a bare exec loop would spin) — no infinite loop, no extra hits.
    expect(createLineMatcher('a*', resolveMatchOptions({ regex: true }))('aaa')).toEqual([
      { start: 0, length: 3 },
      { start: 3, length: 0 },
    ])
    // An uncompilable pattern throws HERE — the route's compile-once check
    // is what turns it into a clean bad-request (pinned in smoke.spec.ts).
    expect(() => createLineMatcher('(', resolveMatchOptions({ regex: true }))).toThrow()
  })

  it('an empty needle matches nothing (the v1「空查询不触引擎」door)', () => {
    expect(createLineMatcher('', resolveMatchOptions({}))('anything')).toEqual([])
  })
})

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
  it('answers LINE-LEVEL hits: 1-based line, 0-based column, verbatim text, ≤2 context each side', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-lines-'))
    try {
      writeFileSync(join(dir, 'only.txt'), 'head one\nhead two\nthe answer here\ntail one\ntail two\ntail three\n')
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES)
      expect(result.truncated).toBe(false)
      expect(result.matches).toEqual([{
        path: 'only.txt',
        count: 1,
        truncated: false,
        hits: [{
          line: 3,
          column: 4,
          length: 6,
          text: 'the answer here',
          before: ['head one', 'head two'],
          after: ['tail one', 'tail two'],
        }],
      }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('file-edge context simply yields fewer than two lines; adjacent hits share theirs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-edges-'))
    try {
      // Lines: 1 hit, 2..5 plain, 6 hit — the two hits share lines 2..5.
      writeFileSync(join(dir, 'edges.txt'), 'answer one\np2\np3\np4\np5\nanswer two\n')
      const [file] = (await searchContentPlain(dir, 'answer', EMPTY_SCOPES)).matches
      expect(file!.hits).toHaveLength(2)
      expect(file!.hits[0]).toMatchObject({ line: 1, before: [], after: ['p2', 'p3'] })
      expect(file!.hits[1]).toMatchObject({ line: 6, before: ['p4', 'p5'], after: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts EVERY occurrence: several per line, several per file (count is the true total)', async () => {
    const dir = makeFixture()
    try {
      const [multi] = (await searchContentPlain(dir, 'answer', EMPTY_SCOPES)).matches
        .filter(file => file.path === 'src/multi.ts')
      expect(multi!.count).toBe(2)
      expect(multi!.hits.map(hit => hit.column)).toEqual([3, 22])
      expect(multi!.hits.every(hit => hit.text === 'an answer and another answer here')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches case-insensitively by default (the v1 fold) and honors caseSensitive', async () => {
    const dir = makeFixture()
    try {
      expect((await searchContentPlain(dir, 'ANSWER', EMPTY_SCOPES)).matches.map(m => m.path))
        .toEqual(ALL_ANSWER_FILES)
      // caseSensitive: only the capitalized line survives.
      expect((await searchContentPlain(dir, 'Answer', EMPTY_SCOPES, { caseSensitive: true })).matches.map(m => m.path))
        .toEqual(['docs/guide.md'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wholeWord drops word-internal occurrences (ASCII \\b edges)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-word-'))
    try {
      writeFileSync(join(dir, 'words.txt'), 'answers here\nanswer there\n_answer\n')
      const plain = await searchContentPlain(dir, 'answer', EMPTY_SCOPES)
      expect(plain.matches[0]!.count).toBe(3)
      const word = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { wholeWord: true })
      expect(word.matches[0]!.count).toBe(1)
      expect(word.matches[0]!.hits[0]!.line).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('regex mode runs the JS matcher over each line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-re-'))
    try {
      writeFileSync(join(dir, 're.txt'), 'run 42 times\nno digits\n')
      const result = await searchContentPlain(dir, '\\d+', EMPTY_SCOPES, { regex: true })
      expect(result.matches[0]!.hits[0]).toMatchObject({ line: 1, column: 4, length: 2 })
      // The regex + wholeWord composition rides the same range filter.
      const wordy = await searchContentPlain(dir, '42|digit', EMPTY_SCOPES, { regex: true, wholeWord: true })
      expect(wordy.matches[0]!.count).toBe(1)
      expect(wordy.matches[0]!.hits[0]!.line).toBe(1)
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
      expect((await searchContentPlain(dir, 'answer', scopes)).matches.map(m => m.path))
        .toEqual(['src/a.ts', 'src/b.ts', 'src/multi.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an existing-file include is searched alone; several entries are a UNION', async () => {
    const dir = makeFixture()
    try {
      const alone = await classifyEntries(dir, ['docs/guide.md'])
      expect((await searchContentPlain(dir, 'answer', alone)).matches.map(m => m.path))
        .toEqual(['docs/guide.md'])
      // Union: the dir scope (src/*) plus the lone file.
      const union = await classifyEntries(dir, ['src', 'docs/guide.md'])
      expect((await searchContentPlain(dir, 'answer', union)).matches.map(m => m.path)).toEqual([
        'docs/guide.md',
        'src/a.ts',
        'src/b.ts',
        'src/multi.ts',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('glob includes use the exclude-patterns subset grammar (bare name, doublestar head, * and ?)', async () => {
    const dir = makeFixture()
    try {
      const pathsOf = async (includeGlobs: string[]): Promise<string[]> =>
        (await searchContentPlain(dir, 'answer', { ...EMPTY_SCOPES, includeGlobs })).matches.map(m => m.path)
      // Bare name: matches that base name at ANY depth.
      expect(await pathsOf(['a.ts'])).toEqual(['src/a.ts'])
      // The `**` + `/` head strips away — the same any-depth name match.
      expect(await pathsOf(['**/a.ts'])).toEqual(['src/a.ts'])
      // Path-anchored with a `*` wildcard inside one segment.
      expect(await pathsOf(['docs/*', 'src/b.ts'])).toEqual(['docs/guide.md', 'src/b.ts'])
      // `?` matches exactly one character within the segment.
      expect(await pathsOf(['?.ts'])).toEqual(['src/a.ts', 'src/b.ts'])
      // Glob include + concrete dir scope: the union, not an intersection
      // (the concrete scope bypasses the glob filter).
      const both = { ...EMPTY_SCOPES, dirs: [join(dir, 'src')], includeGlobs: ['*.md'] }
      expect((await searchContentPlain(dir, 'answer', both)).matches.map(m => m.path)).toEqual(ALL_ANSWER_FILES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('excludes apply after include scoping, concretely and as globs', async () => {
    const dir = makeFixture()
    try {
      const pathsOf = async (scopes: ContentScopes): Promise<string[]> =>
        (await searchContentPlain(dir, 'answer', scopes)).matches.map(m => m.path)
      // Glob exclude narrows the workspace search.
      expect(await pathsOf({ ...EMPTY_SCOPES, excludeGlobs: ['*.ts'] })).toEqual(['README.md', 'docs/guide.md'])
      // An exclude DIRECTORY drops its whole subtree (the walk never descends).
      expect(await pathsOf({ ...EMPTY_SCOPES, excludeDirs: [join(dir, 'docs')] }))
        .toEqual(['README.md', 'src/a.ts', 'src/b.ts', 'src/multi.ts'])
      // An exclude FILE drops exactly that file.
      expect(await pathsOf({ ...EMPTY_SCOPES, excludeFiles: [join(dir, 'src', 'a.ts')] }))
        .toEqual(['README.md', 'docs/guide.md', 'src/b.ts', 'src/multi.ts'])
      // Excludes apply to include-scoped results too (after scoping).
      expect(await pathsOf({ dirs: [join(dir, 'src')], files: [], includeGlobs: [], excludeDirs: [], excludeFiles: [], excludeGlobs: ['b.ts'] }))
        .toEqual(['src/a.ts', 'src/multi.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the explorerExclude preference stacks ON TOP of the exclude list', async () => {
    const dir = makeFixture()
    try {
      const scopes: ContentScopes = { ...EMPTY_SCOPES, excludeGlobs: ['*.ts'] }
      const prefExclude = compileExcludePatterns(['*.md'], dir)
      // Each layer alone leaves the src tree…
      expect((await searchContentPlain(dir, 'answer', scopes)).matches.map(m => m.path)).toEqual(['README.md', 'docs/guide.md'])
      expect((await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { prefExclude })).matches.map(m => m.path))
        .toEqual(['src/a.ts', 'src/b.ts', 'src/multi.ts'])
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
      expect((await searchContentPlain(dir, 'needle-42', EMPTY_SCOPES)).matches.map(m => m.path)).toEqual(['small.log'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips binaries (a NUL in the first 8 KiB) even when the bytes contain the needle', async () => {
    const dir = makeFixture()
    try {
      const paths = (await searchContentPlain(dir, 'answer', EMPTY_SCOPES)).matches.map(m => m.path)
      expect(paths).not.toContain('blob.bin')
      expect(paths).toEqual(ALL_ANSWER_FILES)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-file hit budget: count stays the TRUE total, the file flag marks the cut', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-perfile-'))
    try {
      writeFileSync(join(dir, 'rich.txt'), 'a answer\nb answer\nc answer\n')
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { maxHitsPerFile: 2 })
      expect(result.truncated).toBe(false) // the GLOBAL answer was not cut…
      const [file] = result.matches
      expect(file!.count).toBe(3) // …but the total is honest…
      expect(file!.hits).toHaveLength(2) // …and the payload is capped…
      expect(file!.truncated).toBe(true) // …with the flag saying so.
      expect(file!.hits.map(hit => hit.line)).toEqual([1, 2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('total hit budget: later files keep only the REMAINING room, still counting truly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-total-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'answer\nanswer\nanswer\n')
      writeFileSync(join(dir, 'b.txt'), 'answer\nanswer\nanswer\n')
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { maxTotalHits: 4 })
      expect(result.truncated).toBe(true)
      const [first, second] = result.matches
      expect(first).toMatchObject({ path: 'a.txt', count: 3, truncated: false })
      expect(first!.hits).toHaveLength(3)
      expect(second).toMatchObject({ path: 'b.txt', count: 3, truncated: true })
      expect(second!.hits).toHaveLength(1) // only the remaining room of 4 − 3
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('file-count and visited budgets keep raising truncated (v1 honesty)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-files-'))
    try {
      for (let index = 0; index < 3; index += 1) writeFileSync(join(dir, `f${index}.txt`), 'answer\n')
      const fileCapped = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { maxMatches: 2 })
      expect(fileCapped.truncated).toBe(true)
      expect(fileCapped.matches).toHaveLength(2)
      const visited = await searchContentPlain(dir, 'answer', EMPTY_SCOPES, { maxVisited: 1 })
      // The FIRST candidate already spends the budget inside scanFile, so
      // nothing is read and nothing matches.
      expect(visited.truncated).toBe(true)
      expect(visited.matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the default budgets are the design-pinned values (100 per file / 2000 total / 200 files)', async () => {
    expect(MAX_HITS_PER_FILE).toBe(100)
    expect(MAX_TOTAL_HITS).toBe(2000)
    // The unexported default file cap (200) shows through the walk's answer.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-cap200-'))
    try {
      for (let index = 0; index < 201; index += 1) writeFileSync(join(dir, `f${String(index).padStart(3, '0')}.txt`), 'answer\n')
      const result = await searchContentPlain(dir, 'answer', EMPTY_SCOPES)
      expect(result.matches).toHaveLength(200)
      expect(result.truncated).toBe(true)
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
      expect(result.matches.map(m => m.path)).toEqual(ALL_ANSWER_FILES)
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

// ── The rg pass ───────────────────────────────────────────────────────────
//
// The argv shape and the --json event assembly are pinned WITHOUT a real
// process: the dispatch runs through the injected `spawner` hook (the same
// seam the name-search engines use), and the scripted child replays stdout
// lines of rg --json events.

const rgProbe: EngineProbe = { engine: 'rg', binary: '/fake/rg' }

/** One rg --json event line (only the fields the parser reads). */
const beginEv = (path: string): string =>
  JSON.stringify({ type: 'begin', data: { path: { text: path } } })
const matchEv = (path: string, lineNumber: number | undefined, text: string): string =>
  JSON.stringify({
    type: 'match',
    data: { path: { text: path }, lines: { text: `${text}\n` }, ...(lineNumber === undefined ? {} : { line_number: lineNumber }) },
  })
const contextEv = (path: string, lineNumber: number, text: string): string =>
  JSON.stringify({ type: 'context', data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: lineNumber } })
const endEv = (path: string): string =>
  JSON.stringify({ type: 'end', data: { path: { text: path } } })

describe('contentRgArgv (the argv shape)', () => {
  it('streams --json -C 2 with -i -F by default, skip globs, `--` before the query and the multi-root includes', () => {
    const argv = contentRgArgv('answer', ['/root', '/other'])
    expect(argv.slice(0, 5)).toEqual(['--json', '-C', '2', '-i', '-F'])
    expect(argv).not.toContain('-w')
    expect(argv).not.toContain('-e')
    expect(argv).toContain('--hidden')
    expect(argv).toContain('--no-ignore')
    expect(argv[argv.indexOf('--path-separator') + 1]).toBe('/')
    // `--` guards a needle that looks like a flag; the pattern precedes the
    // multi-root include paths.
    const dd = argv.indexOf('--')
    expect(argv[dd + 1]).toBe('answer')
    expect(argv.slice(dd + 2)).toEqual(['/root', '/other'])
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

  it('composes the mode flags: caseSensitive drops -i, wholeWord adds -w, regex swaps -F for -e (pattern BEFORE --)', () => {
    const argv = contentRgArgv('a+', ['/root'], { caseSensitive: true, wholeWord: true, regex: true })
    expect(argv).not.toContain('-i')
    expect(argv).not.toContain('-F')
    expect(argv).toContain('-w')
    // After `--` every argument is a PATH, so a regex — one that may start
    // with `-` — must ride `-e` ahead of it.
    const e = argv.indexOf('-e')
    expect(argv[e + 1]).toBe('a+')
    const dd = argv.indexOf('--')
    expect(dd).toBeGreaterThan(e)
    expect(argv.slice(dd + 1)).toEqual(['/root'])
    // A literal query that looks like a flag keeps the `-- query` shape.
    const literal = contentRgArgv('-x', ['/root'])
    expect(literal[literal.indexOf('--') + 1]).toBe('-x')
    // The match options resolve to hard booleans inside the builder.
    expect(contentRgArgv('q', ['/root'], {})).toEqual(contentRgArgv('q', ['/root']))
  })
})

describe('contentSearch dispatch (rg --json first, walk fallback)', () => {
  beforeEach(() => {
    resetEngines()
  })
  afterEach(() => {
    resetEngines()
  })

  /** Script one rg child over `--json` event lines; `onKill` observes the
   *  stream sentinel's kill. Passing `error` replays a runtime failure. */
  function scriptEvents(lines: readonly string[], error?: Error, onKill?: () => void): ChildProcess {
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
        onKill?.()
        return true
      },
    }
    const emit = (event: string, arg?: unknown): void => {
      for (const listener of listeners.get(event) ?? []) listener(arg)
    }
    queueMicrotask(async () => {
      if (error !== undefined) {
        emit('error', error)
        return
      }
      stdout.write(`${lines.join('\n')}\n`)
      stdout.end()
      await new Promise<void>(resolve => { stdout.once('end', resolve) })
      emit('close', 0)
    })
    return child as unknown as ChildProcess
  }

  it('routes through the pinned argv and assembles --json events into per-file line groups', async () => {
    const dir = makeFixture()
    try {
      let seenArgv: readonly string[] | undefined
      let seenCwd: string | undefined
      const aPath = join(dir, 'src', 'a.ts')
      const bPath = join(dir, 'src', 'b.ts')
      const mdPath = join(dir, 'docs', 'guide.md')
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: (binary, argv, options) => {
          expect(binary).toBe('/fake/rg')
          seenArgv = argv
          seenCwd = options.cwd
          return scriptEvents([
            beginEv(aPath),
            contextEv(aPath, 1, 'pragma'),
            matchEv(aPath, 2, 'const answer = 42'),
            contextEv(aPath, 3, 'epilogue one'),
            contextEv(aPath, 4, 'epilogue two'),
            endEv(aPath),
            beginEv(bPath),
            matchEv(bPath, 10, '// TODO: fix the answer later'),
            contextEv(bPath, 11, 'shared window line'),
            matchEv(bPath, 12, 'the answer again'),
            endEv(bPath),
            // rg answered this too — but the host's OWN verdicts drop it
            // (the exclude glob below never rode the argv).
            beginEv(mdPath),
            matchEv(mdPath, 1, 'The Answer is 42.'),
            endEv(mdPath),
          ])
        },
      })
      const result = await contentSearch(dir, 'answer', { exclude: ['*.md'] })
      expect(seenCwd).toBe(dir)
      expect(seenArgv).toEqual(contentRgArgv('answer', [dir]))
      expect(result.truncated).toBe(false)
      expect(result.matches.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
      const [a, b] = result.matches
      expect(a).toEqual({
        path: 'src/a.ts',
        count: 1,
        truncated: false,
        hits: [{
          line: 2,
          column: 6,
          length: 6,
          text: 'const answer = 42',
          before: ['pragma'],
          after: ['epilogue one', 'epilogue two'],
        }],
      })
      // Two adjacent hits SHARE the context line between them: it fills the
      // first hit's `after` and rolls into the second hit's `before`.
      expect(b!.count).toBe(2)
      expect(b!.hits[0]).toMatchObject({ line: 10, before: [], after: ['shared window line'] })
      expect(b!.hits[1]).toMatchObject({ line: 12, before: ['shared window line'], after: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('re-derives every hit range on the DECODED line (rg byte offsets ignored; multibyte safe)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-rgjson-'))
    try {
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(join(dir, '答案.txt')),
          // One rg event, but the line carries TWO matches — the host matcher
          // finds both, with JS string indices (3, not the byte offset 7).
          matchEv(join(dir, '答案.txt'), 1, '答案 answer and answer'),
          endEv(join(dir, '答案.txt')),
        ]),
      })
      const result = await contentSearch(dir, 'answer')
      const [file] = result.matches
      expect(file!.count).toBe(2)
      expect(file!.hits.map(hit => [hit.column, hit.length])).toEqual([[3, 6], [14, 6]])
      expect(file!.hits.every(hit => hit.text === '答案 answer and answer')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the JS matcher is the semantics: an rg match the matcher rejects records NO hit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-dialect-'))
    try {
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(join(dir, 'ghost.ts')),
          // A dialect edge: rg recalled the line, the shared matcher does not
          // recognize it — the file lands with count 0 and is dropped.
          matchEv(join(dir, 'ghost.ts'), 1, 'no needle in here'),
          endEv(join(dir, 'ghost.ts')),
        ]),
      })
      expect(await contentSearch(dir, 'answer')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a match event without line_number falls back to the running line count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-lineno-'))
    try {
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(join(dir, 'f.txt')),
          contextEv(join(dir, 'f.txt'), 1, 'one'),
          contextEv(join(dir, 'f.txt'), 2, 'two'),
          matchEv(join(dir, 'f.txt'), undefined, 'answer here'),
          endEv(join(dir, 'f.txt')),
        ]),
      })
      const [file] = (await contentSearch(dir, 'answer')).matches
      expect(file!.hits[0]!.line).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-file hit budget: keptLimit bounds the payload, count stays true, the FILE flag marks it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-rgcap-'))
    try {
      const path = join(dir, 'rich.txt')
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(path),
          matchEv(path, 1, 'answer one'),
          matchEv(path, 2, 'answer two'),
          matchEv(path, 3, 'answer three'),
          endEv(path),
        ]),
      })
      const result = await contentSearch(dir, 'answer', { maxHitsPerFile: 2 })
      expect(result.truncated).toBe(false) // the GLOBAL answer was not cut
      const [file] = result.matches
      expect(file).toMatchObject({ path: 'rich.txt', count: 3, truncated: true })
      expect(file!.hits).toHaveLength(2)
      expect(file!.hits.map(hit => hit.line)).toEqual([1, 2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('total hit budget: reaching it flags truncated; the next file keeps only remaining room', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-rgtotal-'))
    try {
      const aPath = join(dir, 'a.txt')
      const bPath = join(dir, 'b.txt')
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          beginEv(aPath),
          matchEv(aPath, 1, 'answer a1'),
          matchEv(aPath, 2, 'answer a2'),
          endEv(aPath),
          beginEv(bPath),
          matchEv(bPath, 1, 'answer b1'),
          matchEv(bPath, 2, 'answer b2'),
          endEv(bPath),
        ]),
      })
      const result = await contentSearch(dir, 'answer', { maxTotalHits: 2 })
      expect(result.truncated).toBe(true)
      const [a, b] = result.matches
      expect(a).toMatchObject({ path: 'a.txt', count: 2, truncated: false })
      expect(a!.hits).toHaveLength(2)
      expect(b).toMatchObject({ path: 'b.txt', count: 2, truncated: true })
      expect(b!.hits).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the stream sentinel counts EVENTS: past the hit-budget-derived cap it kills rg and flags truncated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-rgsentinel-'))
    try {
      const path = join(dir, 'flood.txt')
      // cap = (maxTotal + 1)·perHit + 2·(maxFiles + 1) + 1 with maxTotal=1,
      // maxMatches=1, perHit=6 → 17. One begin + 17 match events = 18 lines
      // overruns it: the child is killed before its final `end`, and the
      // active file is still flushed with the hits received so far.
      const events = [beginEv(path)]
      for (let line = 1; line <= 17; line += 1) events.push(matchEv(path, line, `answer ${line}`))
      let kills = 0
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents(events, undefined, () => { kills += 1 }),
      })
      const result = await contentSearch(dir, 'answer', { maxMatches: 1, maxTotalHits: 1 })
      expect(kills).toBe(1)
      expect(result.truncated).toBe(true)
      const [file] = result.matches
      expect(file).toMatchObject({ path: 'flood.txt', count: 17, truncated: true })
      expect(file!.hits).toHaveLength(1) // maxTotalHits=1 leaves room for one
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a torn/foreign event line never fails the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-content-torn-'))
    try {
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([
          '{"type":"begin","data":{"path":{"text":"',
          beginEv(join(dir, 'ok.txt')),
          matchEv(join(dir, 'ok.txt'), 1, 'answer here'),
          endEv(join(dir, 'ok.txt')),
        ]),
      })
      expect((await contentSearch(dir, 'answer')).matches.map(file => file.path)).toEqual(['ok.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the plain walk when rg fails at runtime', async () => {
    const dir = makeFixture()
    try {
      setEngineHooks({
        prober: async () => [rgProbe],
        spawner: () => scriptEvents([], new Error('rg exploded')),
      })
      const result = await contentSearch(dir, 'answer', { exclude: ['*.ts'] })
      expect(result.matches.map(m => m.path)).toEqual(['README.md', 'docs/guide.md'])
      expect(result.truncated).toBe(false)
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
      const result = await contentSearch(dir, 'answer')
      expect(result.matches.map(m => m.path)).toEqual(ALL_ANSWER_FILES)
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

  it('an illegal regex pattern rejects at the dispatch too (the route turns it into bad-request)', async () => {
    const dir = makeFixture()
    try {
      // The route compiles the pattern ONCE up front (the clean bad-request
      // contract, pinned in smoke.spec.ts); the dispatch-level throw here is
      // the defense for callers that skipped the route — the walk would
      // throw the same way, so no partial answer can leak.
      await expect(contentSearch(dir, '(', { regex: true })).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
