/**
 * Text-content search for the file manager panel (the tree's "文本内容
 * 搜索" section): a case-insensitive LITERAL substring query over file
 * CONTENTS, scoped by include/exclude entries the user types as chips.
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
 * Two engines fill one contract — files only (a content hit is always a
 * file; `matches` are root-relative, '/'-separated), plus the truncation
 * flag:
 *
 *  - rg first (see search-engines.ts): `-i -F --files-with-matches` literal
 *    case-insensitive matching. Concrete include dirs/files are passed as
 *    MULTI-ROOT path arguments (rg prunes and scans exactly those trees);
 *    every pattern-shaped entry (include globs AND excludes) is judged
 *    HOST-SIDE through the real `compileExcludePatterns` compiler after the
 *    run — the compiled subset grammar is the single semantics, and
 *    duplicating it as `--glob` argv would let the two disagree (tests pin
 *    the argv shape: the pattern entries never reach the argv).
 *    SKIP_DIR_NAMES ride as `--iglob` pairs like the name search's rg argv,
 *    so an explicitly included directory inside a skip forest is pruned
 *    there exactly as the walk would. A missing or failing rg falls back to
 *    the plain walk below (per search — rg is not disabled process-wide).
 *  - The plain JS walk reuses the fs-search budget shape (`maxMatches` /
 *    `maxVisited` + `truncated`), the skip-dir set and symlink cycle safety,
 *    and adds content rules: a single file is read only up to 512 KiB
 *    (larger files are SKIPPED, never partially matched), a file whose first
 *    8 KiB contain a NUL byte is binary and skipped, and the needle matches
 *    as a case-insensitive literal substring.
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

/** One content search: the matching FILES (root-relative, '/'-separated,
 *  sorted) plus the truncation flag. Directories never match — there is no
 *  content to search inside one. */
export interface ContentSearchResult {
  matches: string[]
  truncated: boolean
}

/** Search budgets (both injectable for tests), in the fs-search style. */
export interface ContentSearchOptions {
  /** Include entries: existing dirs/files or glob patterns; empty = the
   *  whole workspace. */
  include?: readonly string[]
  /** Exclude entries (same shapes), applied after include scoping. */
  exclude?: readonly string[]
  /** Compiled explorerExclude probe — the preference stack ON TOP of
   *  `exclude`, in lockstep with the tree listing and the name search. */
  prefExclude?: ExcludeTest
  /** Row cap of the result list (default 200). */
  maxMatches?: number
  /** Total entries visited before the walk gives up (default 100_000). */
  maxVisited?: number
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
 * The rg argv for one content search: literal (`-F`), case-insensitive
 * (`-i`), files-with-matches listing, hidden files in, ignore files OUT
 * (parity with the walk), one skip-dir glob pair per SKIP_DIR_NAMES entry
 * (directory + bare-entry shapes — a worktree `.git` FILE is covered by the
 * second), '/' path separators pinned, then `--`, the needle, and the
 * (absolute) multi-root include paths. Pattern-shaped include entries and
 * excludes NEVER ride the argv — they are judged host-side through
 * compileExcludePatterns so the subset grammar stays the single semantics
 * (see the module header).
 */
export function contentRgArgv(query: string, roots: readonly string[]): string[] {
  const skipGlobs = SKIP_DIR_NAMES.flatMap(name => [
    '--iglob', `!**/${name}/**`,
    '--iglob', `!**/${name}`,
  ])
  return [
    '--files-with-matches', '-i', '-F',
    '--hidden', '--no-ignore',
    ...skipGlobs,
    '--path-separator', '/',
    '--', query, ...roots,
  ]
}

/** Root-relative '/'-separated form of one rg output line (absolute, since
 *  the include roots are passed absolute). A line resolving to '' (the root
 *  itself) is dropped; a line OUTSIDE the root keeps its `..`-relative form
 *  (an include scope may sit outside the workspace). */
function relOf(root: string, line: string): string | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (trimmed === '') return undefined
  const rel = relative(root, trimmed)
  if (rel === '') return undefined
  return rel.split(sep).join('/')
}

/**
 * The rg pass of one content search. Throws on engine failure (the caller
 * falls back to the walk); a TIMEOUT throws like any other failure — this
 * tree was too large for the stream budget, and the walk's own budgets take
 * over.
 */
async function rgContentSearch(
  root: string,
  query: string,
  scopes: ContentScopes,
  filter: ReturnType<typeof buildContentFilter>,
  opts: ContentSearchOptions,
  probe: EngineProbe,
): Promise<ContentSearchResult> {
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const roots = scopes.dirs.length > 0 || scopes.files.length > 0
    ? [...scopes.dirs, ...scopes.files]
    : [root]
  const started = performance.now()
  const { lines, truncated: streamTruncated } = await runEngineArgv(
    probe, contentRgArgv(query, roots), root, maxMatches + 1,
  )
  const matches: string[] = []
  for (const line of lines) {
    const rel = relOf(root, line)
    if (rel === undefined) continue
    const absolute = join(root, rel)
    if (filter.excluded(absolute)) continue
    if (!filter.included(absolute, basename(rel))) continue
    matches.push(rel)
  }
  const sorted = matches.sort()
  // The stream cap (maxMatches + 1) proves there was more; the post-filter
  // slice can also cut a longer list short. Either way the flag stays
  // honest, exactly like the name search's engine dispatch.
  const truncated = streamTruncated || sorted.length > maxMatches
  debugLog(`[dsh-search] content engine=rg bin=${probe.binary} query="${query}" roots=${roots.length} hits=${Math.min(sorted.length, maxMatches)} truncated=${truncated} ${(performance.now() - started).toFixed(0)}ms`)
  return { matches: sorted.slice(0, maxMatches), truncated }
}

/**
 * Whether one file's CONTENT contains the needle (case-insensitive literal).
 * Over-limit files and binaries are skipped (not partially matched);
 * unreadable files are skipped (a permission error never fails the search).
 */
export async function contentMatchFile(absolute: string, needle: string): Promise<boolean> {
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.size > MAX_FILE_BYTES) return false
  const handle = await open(absolute, 'r').catch(() => undefined)
  if (handle === undefined) return false
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(info.size, MAX_FILE_BYTES)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, bytesRead)
    if (slice.subarray(0, Math.min(slice.length, BINARY_SNIFF_BYTES)).includes(0)) return false
    return slice.toString('utf8').toLowerCase().includes(needle)
  } finally {
    await handle.close()
  }
}

/** Sorted '/'-separated output of the walk's match set. */
function sortedMatches(matches: ReadonlySet<string>): string[] {
  return [...matches].sort()
}

/**
 * The plain-JS fallback walk: visit every include scope (the concrete dirs,
 * the lone files, and the whole workspace when glob includes or an empty
 * include list demand it), read text files under the byte cap and match the
 * needle literally. Budgets, the skip-dir set, symlink cycle safety and the
 * exclude semantics mirror fs-search's walk; content rules (skip limit,
 * binary sniff, case-insensitive substring) are this module's own. Exceeding
 * either budget stops early with `truncated: true`.
 */
export async function searchContentPlain(
  root: string,
  query: string,
  scopes: ContentScopes,
  opts: ContentSearchOptions = {},
): Promise<ContentSearchResult> {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { matches: [], truncated: false }
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES
  const maxVisited = opts.maxVisited ?? DEFAULT_MAX_VISITED
  const filter = buildContentFilter(root, scopes, opts.prefExclude)

  const matches = new Set<string>()
  let visited = 0
  let truncated = false

  /** Full verdict + read of one candidate file. */
  const checkFile = async (absolute: string, name: string): Promise<boolean> => {
    visited += 1
    if (visited > maxVisited) {
      truncated = true
      return false
    }
    // Already at the row cap: stop reading (the flag was raised when the
    // cap-filling match landed).
    if (matches.size >= maxMatches) return false
    if (filter.excluded(absolute) || !filter.included(absolute, name)) return false
    if (await contentMatchFile(absolute, needle)) {
      matches.add(relative(root, absolute).split(sep).join('/'))
      if (matches.size >= maxMatches) truncated = true
      return true
    }
    return false
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
        await checkFile(absolute, dirent.name)
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
  const walkRoots = new Set<string>()
  const globsPresent = scopes.includeGlobs.length > 0
  if (globsPresent || (scopes.dirs.length === 0 && scopes.files.length === 0)) walkRoots.add(root)
  for (const dir of scopes.dirs) {
    if (!globsPresent || !underRoot(root, dir)) walkRoots.add(dir)
  }
  for (const file of scopes.files) {
    await checkFile(file, basename(file))
    if (truncated) return { matches: sortedMatches(matches), truncated }
  }
  for (const dir of walkRoots) {
    await walk(dir)
    if (truncated) break
  }
  return { matches: sortedMatches(matches), truncated }
}

/**
 * The fs.contentSearch dispatch: classify the entries host-side, try rg
 * (when probed and healthy), fall back to the plain walk on absence or
 * failure. A blank query matches nothing and touches neither the engine nor
 * the filesystem.
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
      // search (content parity is guaranteed by the shared filter and skip
      // set; this pass does not disable rg process-wide, the next search
      // may try again).
    }
  }
  return searchContentPlain(root, needle, scopes, opts)
}
