/**
 * Text-content search for the file manager panel (the tree's "文本内容
 * 搜索" section, and the PhpStorm-style search page growing out of it):
 * LINE-LEVEL hits over file CONTENTS, scoped by include/exclude entries the
 * user types as chips.
 *
 * Every include/exclude entry is classified host-side (the client sends raw
 * strings — the verdict is a filesystem+policy decision, not a UI one):
 *
 *  1. The entry resolves through the SAME primitive every fs route uses
 *     (`resolveTarget` — absolute, `~/`-relative, or cwd-relative) to an
 *     EXISTING directory → include: the search is scoped to that directory
 *     (relative-prefix judging); exclude: that directory (and everything
 *     under it) is dropped;
 *  2. …to an EXISTING file → include: only that file is searched; exclude:
 *     that one file is dropped;
 *  3. otherwise the entry is a GLOB pattern with exactly the
 *     exclude-patterns.ts subset grammar (bare name = any-depth name match;
 *     `dir/name` = anchored at the session cwd; the `**` + `/` head (a
 *     doublestar-slash prefix) matches at any depth;
 *     `*`/`?` = within one segment). Include globs are a UNION; an empty
 *     include list means the whole workspace. Excludes apply AFTER include
 *     scoping, and the explorerExclude preference (the same probe the name
 *     search carries) stacks on top of them.
 *
 * Three match-mode booleans ride the request (`caseSensitive` / `wholeWord`
 * / `regex`, all default false — i.e. the v1 literal case-insensitive
 * search). Both engines apply the SAME resolved combination through the
 * shared {@link createLineMatcher}, so a hit's coordinates never depend on
 * which engine answered.
 *
 * Two engines fill one contract — per-file hit groups (`matches` sorted by
 * root-relative, '/'-separated path), each hit carrying line/column/length/
 * text plus up to two `before`/`after` context lines, plus the truncation
 * flag:
 *
 *  - rg first (see search-engines.ts): `--json -C 2` streaming, so the run
 *    yields begin/match/context/end events instead of a bare file list. The
 *    mode flags compose exactly as the options pick: non-caseSensitive →
 *    `-i`, wholeWord → `-w`, regex → drop `-F` and carry the pattern with
 *    `-e` (after `--` everything is a PATH, so a regex starting with `-`
 *    must not ride positionally). Concrete include dirs/files are passed as
 *    MULTI-ROOT path arguments (rg prunes and scans exactly those trees);
 *    every pattern-shaped entry (include globs AND excludes) is judged
 *    HOST-SIDE through the real `compileExcludePatterns` compiler after the
 *    run — the compiled subset grammar is the single semantics, and
 *    duplicating it as `--glob` argv would let the two disagree. SKIP_DIR_NAMES
 *    ride as `--iglob` pairs like the name search's rg argv, so an explicitly
 *    included directory inside a skip forest is pruned there exactly as the
 *    walk would. A missing or failing rg falls back to the plain walk below
 *    (per search — rg is not disabled process-wide).
 *
 *    The hit's column/length are NEVER taken from rg's submatch offsets:
 *    those are BYTE offsets into a possibly multibyte line, while the wire
 *    contract is JS string indices over the decoded line. Each match event
 *    contributes the LINE and its text; the host re-derives every hit range
 *    on that text with the same matcher the walk uses, and the context
 *    events around it fill `before`/`after` (two adjacent hits share their
 *    context lines; the file's edges simply yield fewer than two). rg's
 *    regex dialect and JS's are NOT isomorphic: v2 only promises the COMMON
 *    syntax (literals, character classes, quantifiers, groups, anchors).
 *    Divergence is fenced per direction: a JS-valid pattern rg rejects fails
 *    the rg run into the walk fallback, whose matcher still answers
 *    identically; a JS-rejected pattern throws out of the matcher factory
 *    in BOTH paths, and the route's compile-once check is what turns that
 *    into a clean bad-request (the dispatch's rethrow is just the defense
 *    for callers that skipped the route).
 *  - The plain JS walk reuses the fs-search budget shape, the skip-dir set
 *    and symlink cycle safety, and adds content rules: a file is read only
 *    up to 512 KiB (larger files are SKIPPED, never partially matched), a
 *    file whose first 8 KiB contain a NUL byte is binary and skipped, and
 *    the file is matched LINE BY LINE with the shared matcher. Hit budgets
 *    bound the payload, not the scan: at most MAX_HITS_PER_FILE hits are
 *    kept per file (the file's `count` stays the true total and
 *    `truncated` marks the cut) and at most MAX_TOTAL_HITS hits are kept
 *    per search, on top of the fs-search shape (DEFAULT_MAX_MATCHES files,
 *    DEFAULT_MAX_VISITED visited entries). Reaching a budget flags
 *    `truncated` — the same honesty rule the file cap has always used.
 *
 * Cancellation is client-side only (an AbortController around the fetch,
 * exactly like the name search): the host route finishes its bounded run.
 */
import { open, opendir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ExcludeTest } from './exclude-patterns.ts'
import { compileExcludePatterns } from './exclude-patterns.ts'
import { resolveTarget } from './path-security.ts'
import { SKIP_DIR_NAMES, runEngineArgv, usableEngines, type EngineProbe } from './search-engines.ts'
import { debugLog } from './search-debug.ts'
import type {
  ContentFileHit,
  ContentLineHit,
  ContentSearchMatchOptions,
  ContentSearchResult,
} from './content-search-types.ts'

export type { ContentFileHit, ContentLineHit, ContentSearchMatchOptions, ContentSearchResult }

/** Search budgets (all injectable for tests), in the fs-search style. */
export interface ContentSearchOptions extends ContentSearchMatchOptions {
  /** Include entries: existing dirs/files or glob patterns; empty = the
   *  whole workspace. */
  include?: readonly string[]
  /** Exclude entries (same shapes), applied after include scoping. */
  exclude?: readonly string[]
  /** Compiled explorerExclude probe — the preference stack ON TOP of
   *  `exclude`, in lockstep with the tree listing and the name search. */
  prefExclude?: ExcludeTest
  /** File cap of the result list (default 200). */
  maxMatches?: number
  /** Total entries visited before the walk gives up (default 100_000). */
  maxVisited?: number
  /** Hits kept per file before that file's payload is cut (default 100;
   *  `count` stays honest, `truncated` marks the cut). */
  maxHitsPerFile?: number
  /** Hits kept across the whole search (default 2000). */
  maxTotalHits?: number
}

/** One search's include/exclude entries after host-side classification. */
export interface ContentScopes {
  /** INCLUDE entries that named existing directories (absolute). */
  dirs: string[]
  /** INCLUDE entries that named existing files, searched alone (absolute). */
  files: string[]
  /** INCLUDE entries that resolved to nothing — glob patterns. */
  includeGlobs: string[]
  /** EXCLUDE entries that named existing directories: the directory and its
   *  whole subtree are dropped (absolute). */
  excludeDirs: string[]
  /** EXCLUDE entries that named existing files (absolute). */
  excludeFiles: string[]
  /** EXCLUDE entries that resolved to nothing — glob patterns. */
  excludeGlobs: string[]
}

const DEFAULT_MAX_MATCHES = 200
const DEFAULT_MAX_VISITED = 100_000

/** Hits KEPT per file before the file's payload is cut: the PhpStorm-style
 *  page needs lines, not warehouses — 100 lines render, a minified bundle
 *  matching 50k times must not ship 50k hit objects. */
export const MAX_HITS_PER_FILE = 100

/** Hits KEPT across the whole search: the response-size twin of
 *  MAX_HITS_PER_FILE, bounding the wire payload no matter how many files
 *  matched. */
export const MAX_TOTAL_HITS = 2000

/** Context lines kept on each side of a hit (the wire contract's "up to
 *  two"; rg rides `-C 2` so both engines gather the same window). */
const CONTEXT_LINES = 2

/** A file larger than this is never read (skipped, not partially matched):
 *  content search is for source text, and the walk must not stall on
 *  multi-hundred-MB artifacts. */
const MAX_FILE_BYTES = 512 * 1024

/** Binary sniff window: one NUL byte in the first 8 KiB marks a binary file
 *  (the same signal class `fs.read`'s decoder uses). */
const BINARY_SNIFF_BYTES = 8 * 1024

/** The case-insensitive skip set (built from search-engines' list, exactly
 *  like the fs-search walk): neither matched nor descended, so the two
 *  engines and the name search stay one surface. */
const SEARCH_SKIP_DIRS = new Set(SKIP_DIR_NAMES.map(name => name.toLowerCase()))

/** The three wire booleans resolved to hard booleans (`=== true` — a loose
 *  payload from a stale client means the v1 default, never a half-mode). */
export interface ResolvedMatchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** Resolve the wire match options (the route's loose-booleans rule, applied
 *  once here so both engines read the same verdict). */
export function resolveMatchOptions(options: ContentSearchMatchOptions): ResolvedMatchOptions {
  return {
    caseSensitive: options.caseSensitive === true,
    wholeWord: options.wholeWord === true,
    regex: options.regex === true,
  }
}

/** One hit range re-derived on a decoded line (JS string indices). */
export interface LineMatchRange {
  start: number
  length: number
}

/** JS `\w` is exactly the ASCII class [A-Za-z0-9_] — a hand-rolled char-code
 *  test keeps the whole-word edges identical to a RegExp `\w` negation
 *  without allocating a regex per position. */
function isWordChar(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
}

/** Whole-word rule: both edges of the range must abut a non-word character,
 *  with the line's start/end counting as boundaries. */
function wordEdgesOk(text: string, start: number, length: number): boolean {
  return (start === 0 || !isWordChar(text, start - 1))
    && (start + length >= text.length || !isWordChar(text, start + length))
}

/**
 * The ONE matcher both engines share: given a decoded line, return every
 * hit range as JS string indices. The match options compile once per search
 * (the regex form builds its RegExp here, not per line); the returned
 * closure is pure over the line text.
 *
 * Case-insensitive LITERAL matching lowercases haystack and needle and
 * scans the lowered copy (`indexOf` chain) — the same fold the v1 walk
 * used. The hit indices then index the LOWERED string; that is safe for the
 * whole-word edge test because lowercasing never turns a non-word character
 * into `\w` (`\w` is ASCII and ASCII non-word characters are caseless), and
 * the wire hit carries the ORIGINAL line text.
 *
 * REGEX matching runs one `g`-flagged RegExp per line; a zero-length match
 * advances the scan by one character (a bare `exec` loop would otherwise
 * spin forever on `a*`-style patterns). Whole-word mode filters the ranges
 * with the same edge test as the literal form.
 */
export function createLineMatcher(
  query: string,
  options: ResolvedMatchOptions,
): (text: string) => LineMatchRange[] {
  if (options.regex) {
    // v2 promises the COMMON regex syntax only (see the module header). A
    // pattern rg accepts but JS rejects throws HERE; the dispatch's catch
    // then hands the search to the walk, which throws the same way — the
    // route's compile-once check is the real gate, and this throw is the
    // defense for callers that skipped it. The realistic divergence runs the
    // other way: a JS-valid pattern rg rejects fails the rg run into the
    // walk fallback, whose matcher still answers identically.
    const scanner = new RegExp(query, (options.caseSensitive ? '' : 'i') + 'g')
    return (text) => {
      const ranges: LineMatchRange[] = []
      scanner.lastIndex = 0
      let found: RegExpExecArray | null
      while ((found = scanner.exec(text)) !== null) {
        const length = found[0].length
        if (!options.wholeWord || wordEdgesOk(text, found.index, length)) {
          ranges.push({ start: found.index, length })
        }
        if (length === 0) scanner.lastIndex = found.index + 1
      }
      return ranges
    }
  }
  const needle = options.caseSensitive ? query : query.toLowerCase()
  if (needle === '') return (): LineMatchRange[] => []
  return (text) => {
    const hay = options.caseSensitive ? text : text.toLowerCase()
    const ranges: LineMatchRange[] = []
    let from = 0
    for (;;) {
      const start = hay.indexOf(needle, from)
      if (start < 0) break
      // Edges are tested on the scanned copy (see the doc comment): the
      // indices came from it, and the word-char verdict is fold-stable.
      if (!options.wholeWord || wordEdgesOk(hay, start, needle.length)) {
        ranges.push({ start, length: needle.length })
      }
      from = start + 1
    }
    return ranges
  }
}

/**
 * Classify the wire include/exclude entries. `resolveTarget` + `stat` decide
 * the dir/file shapes; a resolution or stat failure (including any odd wire
 * value resolveTarget throws on) degrades to a glob pattern — the compiler
 * drops malformed ones silently, so a bad entry can never fail the search.
 * `stat` follows symlinks, so a link to a file is a file entry and a link to
 * a directory a directory entry (the same classification fs.read applies).
 */
export async function classifyEntries(
  root: string,
  include: readonly string[] = [],
  exclude: readonly string[] = [],
): Promise<ContentScopes> {
  const scopes: ContentScopes = {
    dirs: [], files: [], includeGlobs: [],
    excludeDirs: [], excludeFiles: [], excludeGlobs: [],
  }
  const classify = async (raw: string): Promise<{ kind: 'dir' | 'file'; absolute: string } | { kind: 'glob' }> => {
    const entry = raw.trim()
    if (entry === '') return { kind: 'glob' }
    let target: string
    try {
      target = resolveTarget(root, entry)
    } catch {
      return { kind: 'glob' }
    }
    const info = await stat(target).catch(() => undefined)
    if (info === undefined) return { kind: 'glob' }
    if (info.isDirectory()) return { kind: 'dir', absolute: target }
    return { kind: 'file', absolute: target }
  }
  for (const raw of include) {
    const verdict = await classify(raw)
    if (verdict.kind === 'dir') scopes.dirs.push(verdict.absolute)
    else if (verdict.kind === 'file') scopes.files.push(verdict.absolute)
    else scopes.includeGlobs.push(raw.trim())
  }
  for (const raw of exclude) {
    const verdict = await classify(raw)
    if (verdict.kind === 'dir') scopes.excludeDirs.push(verdict.absolute)
    else if (verdict.kind === 'file') scopes.excludeFiles.push(verdict.absolute)
    else scopes.excludeGlobs.push(raw.trim())
  }
  return scopes
}

/** Whether `absolute` lies inside `root` (not a `..`-relative escape). */
function underRoot(root: string, absolute: string): boolean {
  return isAbsolute(absolute) && !relative(root, absolute).startsWith('..')
}

/**
 * The include/exclude verdicts both engines share. Include = union of the
 * concrete scopes and the glob matches (an empty include list = everything);
 * exclude = "self or an ancestor is excluded" (the walk never descends into
 * an excluded directory, so the engine pass must not report one's children
 * either), stacking the concrete excludes, the exclude globs AND the pref
 * probe. Ancestor verdicts stop AT the search root — the root itself is
 * never excluded, exactly like the fs-search walk (which only ever tests
 * entries under the root). Verdicts are memoized per absolute path: every
 * file under one directory re-asks the same ancestor chain.
 */
export function buildContentFilter(
  root: string,
  scopes: ContentScopes,
  prefExclude?: ExcludeTest,
): { included: (absolute: string, name: string) => boolean; excluded: (absolute: string) => boolean } {
  const includeMatcher = scopes.includeGlobs.length > 0
    ? compileExcludePatterns(scopes.includeGlobs, root)
    : undefined
  const excludeProbes: ExcludeTest[] = []
  const excludeMatcher = scopes.excludeGlobs.length > 0
    ? compileExcludePatterns(scopes.excludeGlobs, root)
    : undefined
  if (excludeMatcher !== undefined) excludeProbes.push(excludeMatcher)
  if (prefExclude !== undefined) excludeProbes.push(prefExclude)
  const scopeDirs = scopes.dirs
  const scopeFiles = new Set(scopes.files)
  const excludeDirs = new Set(scopes.excludeDirs)
  const excludeFiles = new Set(scopes.excludeFiles)
  const inScopeDir = (absolute: string): boolean =>
    scopeDirs.some((dir) => {
      const rel = relative(dir, absolute)
      return rel === '' || !rel.startsWith('..')
    })
  const verdictCache = new Map<string, boolean>()
  const excluded = (absolute: string): boolean => {
    if (absolute === root) return false
    const cached = verdictCache.get(absolute)
    if (cached !== undefined) return cached
    const parent = dirname(absolute)
    const verdict = (parent !== absolute && parent !== '' && excluded(parent))
      || excludeFiles.has(absolute)
      || excludeDirs.has(absolute)
      || excludeProbes.some(probe => probe(absolute, basename(absolute)))
    verdictCache.set(absolute, verdict)
    return verdict
  }
  const included = (absolute: string, name: string): boolean =>
    scopeFiles.has(absolute)
    || inScopeDir(absolute)
    || (includeMatcher === undefined ? true : includeMatcher(absolute, name))
  return { included, excluded }
}

/**
 * The rg argv for one content search: `--json -C 2` event streaming with the
 * match-mode flags the options pick (non-caseSensitive → `-i`, wholeWord →
 * `-w`, regex → drop `-F` and carry the pattern with `-e`), hidden files in,
 * ignore files OUT (parity with the walk), one skip-dir glob pair per
 * SKIP_DIR_NAMES entry (directory + bare-entry shapes — a worktree `.git`
 * FILE is covered by the second), '/' path separators pinned, then the
 * pattern and the (absolute) multi-root include paths. Regex patterns ride
 * `-e` (before `--`, because after it every argument is a PATH — a pattern
 * like `^-x` would be unreadable positionally); literal queries keep the v1
 * `-- query` shape. Pattern-shaped include entries and excludes NEVER ride
 * the argv — they are judged host-side through compileExcludePatterns so the
 * subset grammar stays the single semantics (see the module header).
 */
export function contentRgArgv(
  query: string,
  roots: readonly string[],
  match: ContentSearchMatchOptions = {},
): string[] {
  const resolved = resolveMatchOptions(match)
  const skipGlobs = SKIP_DIR_NAMES.flatMap(name => [
    '--iglob', `!**/${name}/**`,
    '--iglob', `!**/${name}`,
  ])
  const argv = [
    '--json', '-C', String(CONTEXT_LINES),
    ...(resolved.caseSensitive ? [] : ['-i']),
    ...(resolved.regex ? [] : ['-F']),
    ...(resolved.wholeWord ? ['-w'] : []),
    '--hidden', '--no-ignore',
    ...skipGlobs,
    '--path-separator', '/',
  ]
  if (resolved.regex) {
    argv.push('-e', query, '--', ...roots)
  } else {
    argv.push('--', query, ...roots)
  }
  return argv
}

/** Root-relative '/'-separated form of one rg output path (absolute, since
 *  the include roots are passed absolute). A path resolving to '' (the root
 *  itself) is dropped; a path OUTSIDE the root keeps its `..`-relative form
 *  (an include scope may sit outside the workspace). */
function relOf(root: string, line: string): string | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (trimmed === '') return undefined
  const rel = relative(root, trimmed)
  if (rel === '') return undefined
  return rel.split(sep).join('/')
}

/** One decoded rg event line: the trailing `\n` (and a CRLF `\r`) goes —
 *  the wire `text` is the line without its terminator, leading whitespace
 *  kept. */
function stripLineEnd(text: string): string {
  if (text.endsWith('\n')) text = text.slice(0, -1)
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

/** Minimal shape of one `rg --json` event line (only the fields we read;
 *  `text`-less `path`/`lines` objects are the `bytes` form for non-UTF-8
 *  names/contents, which this search skips exactly like the walk skips
 *  binaries). */
interface RgEvent {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
  }
}

/** Per-file streaming state of the rg event walk. */
interface RgFileState {
  rel: string
  /** Total matching ranges seen (host-derived), kept honest past the cap. */
  count: number
  /** Hits kept for the wire (≤ per-file cap ∩ remaining global budget). */
  kept: ContentLineHit[]
  /** The kept ceiling for THIS file (global budget may already be tight). */
  keptLimit: number
  /** The ≤2 context lines since the last match — the next hit's `before`. */
  pendingBefore: string[]
  /** Last KEPT hit: later context events fill its `after`. */
  lastKept: ContentLineHit | undefined
  /** Fallback line counter when an event lacks `line_number`. */
  lastLine: number
}

/**
 * The rg pass of one content search: stream `--json` events and assemble
 * per-file hit groups. A `match` event gives the line and its text; the
 * host re-derives the hit ranges on that text with the shared matcher (rg's
 * submatch offsets are BYTE offsets — wrong currency for a JS-string wire
 * contract, see the module header). `context` events fill the previous
 * kept hit's `after` and roll the next hit's `before`, so two adjacent
 * hits share their context window exactly as rg emitted it (deduped by rg
 * itself). Throws on engine failure (the caller falls back to the walk); a
 * TIMEOUT throws like any other failure — this tree was too large for the
 * stream budget, and the walk's own budgets take over.
 */
async function rgContentSearch(
  root: string,
  query: string,
  scopes: ContentScopes,
  filter: ReturnType<typeof buildContentFilter>,
  opts: ContentSearchOptions,
  probe: EngineProbe,
): Promise<ContentSearchResult> {
  const match = resolveMatchOptions(opts)
  const matchLine = createLineMatcher(query, match)
  const maxFiles = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxHits = opts.maxHitsPerFile ?? MAX_HITS_PER_FILE
  const maxTotal = opts.maxTotalHits ?? MAX_TOTAL_HITS
  const roots = scopes.dirs.length > 0 || scopes.files.length > 0
    ? [...scopes.dirs, ...scopes.files]
    : [root]
  const started = performance.now()
  // The stream cap is LINES of JSON events, so the hit budget is inflated
  // into an event budget: one match event per hit, ≤4 context events per
  // hit (rg dedupes overlapping context, so this over-counts = margin),
  // begin/end amortized per hit, plus an explicit begin/end pair per file
  // beyond the hit accounting. The +1 sentinels keep the "there was more"
  // proof intact (streamLines truncates one line PAST the cap).
  const perHit = 1 + 2 * CONTEXT_LINES + 1
  const cap = (maxTotal + 1) * perHit + 2 * (maxFiles + 1) + 1
  const { lines, truncated: streamTruncated } = await runEngineArgv(
    probe, contentRgArgv(query, roots, match), root, cap,
  )

  const matches: ContentFileHit[] = []
  let keptTotal = 0
  // A finished file pushes its kept hits onto the total; REACHING the
  // global cap flags truncation (more hits may exist) — the same honesty
  // rule the file cap and the walk's flags use.
  let budgetReached = false
  let active: RgFileState | null = null

  // One file is done: host-side filter (the SAME verdicts the walk applies
  // — pattern entries never ride the argv), then the result row.
  const flush = (): void => {
    const file = active
    active = null
    if (file === null) return
    if (file.count === 0) return
    const absolute = join(root, file.rel)
    if (filter.excluded(absolute)) return
    if (!filter.included(absolute, basename(file.rel))) return
    keptTotal += file.kept.length
    if (keptTotal >= maxTotal) budgetReached = true
    matches.push({
      path: file.rel,
      count: file.count,
      truncated: file.count > file.kept.length,
      hits: file.kept,
    })
  }

  for (const line of lines) {
    let event: RgEvent
    try {
      event = JSON.parse(line) as RgEvent
    } catch {
      continue // one foreign/torn line never fails the whole run
    }
    const data = event.data
    switch (event.type) {
      case 'begin': {
        flush()
        const text = data?.path?.text
        const fileRel = text === undefined ? undefined : relOf(root, text)
        if (fileRel === undefined) break // bytes path or the root itself: skip
        active = {
          rel: fileRel,
          count: 0,
          kept: [],
          keptLimit: Math.min(maxHits, Math.max(0, maxTotal - keptTotal)),
          pendingBefore: [],
          lastKept: undefined,
          lastLine: 0,
        }
        break
      }
      case 'context': {
        if (active === null) break
        const text = data?.lines?.text
        if (text === undefined) break
        const lineText = stripLineEnd(text)
        if (active.lastKept !== undefined && active.lastKept.after.length < CONTEXT_LINES) {
          active.lastKept.after.push(lineText)
        }
        active.pendingBefore.push(lineText)
        if (active.pendingBefore.length > CONTEXT_LINES) active.pendingBefore.shift()
        active.lastLine += 1
        break
      }
      case 'match': {
        if (active === null) break
        const text = data?.lines?.text
        if (text === undefined) break
        const lineText = stripLineEnd(text)
        const numbered = data?.line_number
        const lineNumber = typeof numbered === 'number' && Number.isInteger(numbered) && numbered >= 1
          ? numbered
          : active.lastLine + 1
        active.lastLine = lineNumber
        // Ranges come from the HOST matcher on the DECODED line, so the
        // count is the host's truth too: a dialect edge where rg matched
        // but the shared matcher does not simply records no hit (kept
        // consistent — every wire hit carries host-derived coordinates).
        const ranges = matchLine(lineText)
        active.count += ranges.length
        for (const range of ranges) {
          if (active.kept.length >= active.keptLimit) break
          const hit: ContentLineHit = {
            line: lineNumber,
            column: range.start,
            length: range.length,
            text: lineText,
            before: active.pendingBefore.slice(),
            after: [],
          }
          active.kept.push(hit)
          active.lastKept = hit
        }
        // The match line itself ends the "before" window; what follows is
        // `after` territory (and the next hit's `before` only once context
        // events actually arrive).
        active.pendingBefore.length = 0
        break
      }
      case 'end':
        flush()
        break
      default:
        break // 'summary' and friends carry nothing this contract needs
    }
  }
  flush() // a truncated stream kills rg before its final `end`

  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // The stream cap (event budget) proves there was more; the global hit
  // budget and a post-filter file overflow raise the same flag. Either way
  // the flag stays honest, exactly like the name search's engine dispatch.
  const truncated = streamTruncated || budgetReached || matches.length > maxFiles
  const sliced = matches.length > maxFiles ? matches.slice(0, maxFiles) : matches
  debugLog(`[dsh-search] content engine=rg bin=${probe.binary} query="${query}" roots=${roots.length} files=${sliced.length} hits=${keptTotal} truncated=${truncated} ${(performance.now() - started).toFixed(0)}ms`)
  return { matches: sliced, truncated }
}

/**
 * Read one candidate file as searchable LINES, under the walk's content
 * rules: over-limit files and binaries are skipped (not partially matched),
 * unreadable files are skipped (a permission error never fails the search).
 * Lines are split on every terminator flavor and carry no trailing `\r\n`;
 * the single empty artifact a final terminator leaves is dropped (rg counts
 * "a\n" as ONE line, and the walk must not report a phantom line 2).
 */
async function readSearchableLines(absolute: string): Promise<string[] | undefined> {
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.size > MAX_FILE_BYTES) return undefined
  const handle = await open(absolute, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(info.size, MAX_FILE_BYTES)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, bytesRead)
    if (slice.subarray(0, Math.min(slice.length, BINARY_SNIFF_BYTES)).includes(0)) return undefined
    const lines = slice.toString('utf8').split(/\r\n|\n|\r/)
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    return lines
  } finally {
    await handle.close()
  }
}

/** Turn kept ranges (line/column/length) into wire hits, pulling the
 *  context window straight out of the file's line array — file edges simply
 *  yield fewer than two lines, and two hits on adjacent lines share theirs. */
function buildLineHits(lines: readonly string[], ranges: readonly LineRange[]): ContentLineHit[] {
  return ranges.map((range) => {
    const index = range.line - 1
    return {
      line: range.line,
      column: range.column,
      length: range.length,
      text: lines[index] ?? '',
      before: lines.slice(Math.max(0, index - CONTEXT_LINES), index),
      after: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
    }
  })
}

/**
 * The plain-JS fallback walk: visit every include scope (the concrete dirs,
 * the lone files, and the whole workspace when glob includes or an empty
 * include list demand it), read text files under the byte cap and match
 * them LINE BY LINE with the shared matcher. Budgets, the skip-dir set,
 * symlink cycle safety and the exclude semantics mirror fs-search's walk;
 * content rules (skip limit, binary sniff, per-file and total hit budgets)
 * are this module's own. Exceeding any budget stops early with
 * `truncated: true`.
 */
export async function searchContentPlain(
  root: string,
  query: string,
  scopes: ContentScopes,
  opts: ContentSearchOptions = {},
): Promise<ContentSearchResult> {
  const needle = query.trim()
  if (needle === '') return { matches: [], truncated: false }
  const matchLine = createLineMatcher(needle, resolveMatchOptions(opts))
  const maxFiles = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED
  const maxHits = opts.maxHitsPerFile ?? MAX_HITS_PER_FILE
  const maxTotal = opts.maxTotalHits ?? MAX_TOTAL_HITS
  const filter = buildContentFilter(root, scopes, opts.prefExclude)

  const matches = new Map<string, ContentFileHit>()
  let visited = 0
  let keptTotal = 0
  let truncated = false

  /** Full verdict + read + line scan of one candidate file. */
  const scanFile = async (absolute: string, name: string): Promise<void> => {
    visited += 1
    if (visited > maxVisited) {
      truncated = true
      return
    }
    // Any budget already tripped: stop reading (the flag was raised when
    // the cap-filling file/hit landed).
    if (truncated) return
    if (filter.excluded(absolute) || !filter.included(absolute, name)) return
    const lines = await readSearchableLines(absolute)
    if (lines === undefined) return
    let count = 0
    const ranges: LineRange[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index]
      if (lineText === undefined) continue
      const found = matchLine(lineText)
      if (found.length === 0) continue
      count += found.length
      for (const range of found) {
        if (ranges.length >= maxHits) break
        ranges.push({ line: index + 1, column: range.start, length: range.length })
      }
    }
    if (count === 0) return
    // The global budget may only have room for part of this file's kept
    // hits — slice honestly and let `truncated` say so (`count` stays the
    // file's true total either way).
    const remaining = Math.max(0, maxTotal - keptTotal)
    const keptRanges = ranges.length > remaining ? ranges.slice(0, remaining) : ranges
    keptTotal += keptRanges.length
    const rel = relative(root, absolute).split(sep).join('/')
    matches.set(rel, {
      path: rel,
      count,
      truncated: count > keptRanges.length,
      hits: buildLineHits(lines, keptRanges),
    })
    // REACHING a budget flags truncation — more hits/files may exist, and
    // the flag must not promise they don't.
    if (keptTotal >= maxTotal) truncated = true
    if (matches.size >= maxFiles) truncated = true
  }

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    const level = await opendir(dir).catch(() => undefined)
    if (level === undefined) return
    for await (const dirent of level) {
      visited += 1
      if (visited > maxVisited) {
        truncated = true
        return
      }
      // Dependency / VCS / build-output forests: never matched, never
      // descended (worktree-style `.git` FILES included) — parity with the
      // engine argvs' skip globs.
      if (SEARCH_SKIP_DIRS.has(dirent.name.toLowerCase())) continue
      const absolute = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        // A symlinked directory may point back up the tree (cycle).
        if (dirent.isSymbolicLink()) continue
        if (filter.excluded(absolute)) continue
        await walk(absolute)
        if (truncated) return
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        await scanFile(absolute, dirent.name)
        if (truncated) return
      }
    }
  }

  // Scope walk set: the whole workspace when glob includes exist (their
  // union needs the full listing) or when the include list is empty —
  // otherwise exactly the concrete include dirs, each walked DIRECTLY (the
  // root itself is not a scope). With globs present, an in-root concrete dir
  // is already covered by the root walk (`included` lets its files through);
  // an out-of-root one still needs its own walk.
  const finish = (): ContentSearchResult => {
    const sorted = [...matches.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { matches: sorted, truncated }
  }
  const walkRoots = new Set<string>()
  const globsPresent = scopes.includeGlobs.length > 0
  if (globsPresent || (scopes.dirs.length === 0 && scopes.files.length === 0)) walkRoots.add(root)
  for (const dir of scopes.dirs) {
    if (!globsPresent || !underRoot(root, dir)) walkRoots.add(dir)
  }
  for (const file of scopes.files) {
    await scanFile(file, basename(file))
    if (truncated) return finish()
  }
  for (const dir of walkRoots) {
    await walk(dir)
    if (truncated) break
  }
  return finish()
}

/**
 * The fs.contentSearch dispatch: classify the entries host-side, try rg
 * (when probed and healthy), fall back to the plain walk on absence or
 * failure. A blank query matches nothing and touches neither the engine nor
 * the filesystem; the route layer compiles regex queries once BEFORE this
 * dispatch, so an illegal pattern surfaces as a clean bad-request — but a
 * pattern JS cannot compile that arrives another way throws here and reads
 * as an rg failure, taking the walk fallback (which would throw the same
 * way; the route's compile check is the contract).
 */
export async function contentSearch(root: string, query: string, opts: ContentSearchOptions = {}): Promise<ContentSearchResult> {
  const needle = query.trim()
  if (needle === '') return { matches: [], truncated: false }
  const scopes = await classifyEntries(root, opts.include, opts.exclude)
  const filter = buildContentFilter(root, scopes, opts.prefExclude)
  for (const probe of await usableEngines()) {
    if (probe.engine !== 'rg') continue
    try {
      return await rgContentSearch(root, needle, scopes, filter, opts, probe)
    } catch {
      // rg is unavailable or failed for this run — the walk below owns the
      // search (content parity is guaranteed by the shared filter, skip set
      // AND matcher; this pass does not disable rg process-wide, the next
      // search may try again).
    }
  }
  return searchContentPlain(root, needle, scopes, opts)
}
