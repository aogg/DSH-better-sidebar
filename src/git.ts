/**
 * Git operations for the sidebar source-control panel. Everything goes
 * through the system `git` binary spawned per request (no library, no state),
 * with porcelain-parseable output formats (`-z` NUL framing, unit separators)
 * so parsing never depends on locale or color config. All commands run with
 * `-C <cwd>` on the session's working directory and `--no-pager` /
 * `-c color.ui=false` / `-c core.quotePath=false` so output stays
 * machine-readable and paths stay literal (git's default C-quotes a non-ASCII
 * path, which every diff surface would render as the file name).
 *
 * Commits use the user's git global identity untouched (never sets
 * user.name/user.email).
 *
 * Two status shapes exist, and the difference is deliberate: {@link status}
 * answers the WHOLE checkout (the first paint, and the calibration read after
 * an event that could move any path), while {@link statusPaths} answers only a
 * named set of paths — the incremental read the push hub's per-file notices
 * ride, so one saved file costs one small answer instead of a full snapshot.
 */
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface GitStatusEntry {
  path: string
  /** Two-letter index/worktree status (X Y), e.g. 'M ', ' M', 'A ', '??'. */
  xy: string
  /** How many lines this path gained and lost, index and worktree sides
   *  SUMMED (both are measured against HEAD). Absent when git has no numstat
   *  row for the path — an untracked file never gets one — so "no counts" is
   *  never rendered as a fabricated `0`. */
  counts?: GitLineCounts
}

/** One path's line-count summary from `git diff --numstat`. A binary change is
 *  its own variant because git reports `-`/`-` for it: there ARE no counts, and
 *  saying `+0 −0` would invent a number. */
export type GitLineCounts = { additions: number; deletions: number } | { binary: true }

/** The source-control panel snapshot. */
export interface GitStatusResult {
  isRepo: boolean
  branch?: string
  entries: GitStatusEntry[]
  /** True when the working tree had more rows than `GIT_STATUS_LIMIT`; the
   *  panel shows a truncation notice instead of freezing on a huge untracked
   *  set (issue #369). */
  truncated?: boolean
  /**
   * The paths git IGNORES (a `git ls-files --others --ignored
   * --exclude-standard --directory` read), repo-root-relative. An ignored
   * directory arrives COLLAPSED as `dir/` (git never descends into what it
   * ignores), so a `node_modules` costs one row, never every file under it.
   * Feeds the file tree's "ignored" overlay; the changes list must not see
   * these. Empty is a valid answer (nothing ignored, or the ignore read
   * failed — the status answer itself never fails because of it).
   */
  ignored?: string[]
  /** True when `ignored` hit `GIT_STATUS_LIMIT`: paths beyond the cap may
   *  still be ignored, so a "clean" badge must not be painted from a partial
   *  ignore list. */
  ignoredTruncated?: boolean
  /** Selected repository root, or the discovered roots when the cwd is a container. */
  root?: string
  repositories?: string[]
}

/**
 * The answer to {@link statusPaths}: the SAME row vocabulary as
 * {@link GitStatusResult}, but only for the paths the caller asked about —
 * never the whole repository. It exists so a single changed file can be
 * re-read on its own (one small answer instead of a full `status` snapshot),
 * which is what lets the client patch one row's ink and leave every other row
 * alone.
 */
export interface GitStatusPathsResult {
  /** Whether the session cwd resolves to a repository at all. */
  isRepo: boolean
  /** The repository root the paths were resolved against (absent when not a repo). */
  root?: string
  /** The current branch (absent when not a repo; `HEAD` when detached). */
  branch?: string
  /** The changed entries UNDER the requested paths' subtrees, repo-root-relative. */
  entries: GitStatusEntry[]
  /**
   * The IGNORED paths among the requested ones, repo-root-relative, exactly
   * the vocabulary {@link GitStatusResult.ignored} uses. Empty is a valid
   * answer (nothing requested is ignored, or the ignore read failed).
   */
  ignored: string[]
  /** True when this answer was capped at {@link GIT_STATUS_LIMIT} rows: the
   *  caller must calibrate with a full read rather than patch from a partial
   *  answer. */
  truncated?: boolean
}

/** One linked checkout returned by `git worktree list --porcelain`. */
export interface GitWorktree {
  /** Absolute checkout root. */
  path: string
  /** Branch name without `refs/heads/`, or `HEAD` when detached. */
  branch: string
  /** Whether this checkout contains the session cwd. */
  current: boolean
  /** Number of staged + unstaged status rows (a file changed on both sides counts once). */
  changes: number
}

/** One file a commit touched (a `--name-status` row). */
export interface GitLogNameStatus {
  path: string
  /** The name-status letter: `M`/`A`/`D` verbatim; a rename/copy score row
   *  (`R100`) folds to its letter (`R`). */
  status: string
}

/** One `git log` row. */
export interface GitLogEntry {
  /** Short hash (7+ chars, display). */
  hash: string
  /** Full 40-char hash (advanced operations: revert / cherry-pick). */
  hashFull: string
  subject: string
  author: string
  /** ISO 8601 author date (`%ai`), e.g. `2024-01-01 10:00:00 +0800`. */
  date: string
  /** Ref decorations (`%D` with --decorate=short), e.g. `HEAD -> main, origin/main`; '' when none. */
  refs: string
  /** Files the commit touched, ONLY when the caller asked for
   *  `--name-status` (absent otherwise — older clients see no change). */
  files?: GitLogNameStatus[]
}

/** One git failure (stderr text as the message). */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code = 'git-error',
    readonly command: string,
  ) {
    super(message)
  }
}

/** Parse porcelain v1 -z output into entries (rename/copy pairs collapse to one row). */
export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const tokens = output.split('\0')
  const entries: GitStatusEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    index += 1
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field; the
    // new path (the file as it exists now) is the display path.
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[index] !== undefined && tokens[index] !== '') {
      index += 1
    }
  }
  return entries
}

/**
 * The IGNORED paths of one `git ls-files --others --ignored
 * --exclude-standard --directory -z` answer: a NUL-framed path list, an
 * ignored DIRECTORY collapsed to one `dir/` row (git never descends into
 * what it ignores — measured 0.4 s on a pnpm-scale tree where the
 * equivalent `status --ignored` walk costs 45 s), ignored FILES as
 * themselves, negations (`.env.*` + `!.env.example`) resolved exactly as
 * status would. An empty/failed read answers "nothing known" — never an
 * error.
 */
export function ignoredPaths(output: string): string[] {
  return output.split('\0').filter(path => path !== '')
}

/**
 * Resolve one `--numstat` path field to the path the file has NOW: the plain
 * (`old => new`) and brace (`src/{a => b}/x.ts`) rename notations both fold
 * into the new name, and anything else passes through verbatim.
 *
 * Only the LINE-framed output needs this: in `-z` framing git writes the two
 * names as separate NUL fields, so a path is never folded into rename notation
 * there — a file literally named `a => b.txt` keeps its own name.
 */
function resolveNumstatPath(path: string): string {
  const arrow = path.indexOf(' => ')
  if (arrow === -1) return path
  const open = path.indexOf('{')
  if (open !== -1 && open < arrow) {
    const close = path.indexOf('}', arrow + 4)
    if (close !== -1) return `${path.slice(0, open)}${path.slice(arrow + 4, close)}${path.slice(close + 1)}`
  }
  return path.slice(arrow + 4)
}

/**
 * Parse one `git diff --numstat` answer into a path → line-counts map. Both
 * framings are accepted: the production `-z` one (records NUL-framed, so paths
 * with newlines or quotes stay lossless) and the plain line-framed one.
 *
 * Three record shapes exist:
 *  - `2\t0\tpath` — an ordinary change,
 *  - `-\t-\tpath` — a binary change: no counts exist, so it maps to the binary
 *    variant rather than to `0 0`,
 *  - renames — the path field is the pair `old => new` (or the brace form
 *    `src/{a => b}/x.ts`) in line framing, and two NUL-framed fields (origin
 *    first) in `-z` framing.
 *
 * A rename is attributed to the NEW path: that is the file as it exists now,
 * and the exact path `git status --porcelain` reports for the same change, so
 * the counts land on the row the panel renders.
 */
export function parseNumstat(output: string): Map<string, GitLineCounts> {
  const counts = new Map<string, GitLineCounts>()
  const framed = output.includes('\0')
  const records = output.split(framed ? '\0' : '\n')
  let index = 0
  while (index < records.length) {
    const record = records[index]!
    index += 1
    if (record === '') continue
    const addedEnd = record.indexOf('\t')
    const deletedEnd = addedEnd === -1 ? -1 : record.indexOf('\t', addedEnd + 1)
    // Not a numstat record (a stray line, or a truncated answer).
    if (deletedEnd === -1) continue
    const added = record.slice(0, addedEnd)
    const deleted = record.slice(addedEnd + 1, deletedEnd)
    let path = record.slice(deletedEnd + 1)
    if (framed && path === '') {
      // A rename: the origin and the new name are the next two NUL fields.
      const renamed = records[index + 1]
      index += 2
      if (renamed === undefined) continue
      path = renamed
    } else if (!framed) {
      path = resolveNumstatPath(path)
    }
    if (path === '') continue
    if (added === '-' || deleted === '-') {
      counts.set(path, { binary: true })
      continue
    }
    const additions = Number(added)
    const deletions = Number(deleted)
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue
    counts.set(path, { additions, deletions })
  }
  return counts
}

/** One raw porcelain worktree record. Prunable checkouts are retained by
 * Git's administrative metadata after their directory disappears and must not
 * become selectable command targets. Locked checkouts remain usable. */
export interface GitWorktreeRecord {
  path: string
  branch: string
  locked: boolean
  prunable: boolean
}

/** Parse `git worktree list --porcelain` records. Production requests use
 * `-z` so even newlines and non-ASCII bytes in checkout paths stay lossless;
 * newline framing remains accepted for small fixtures and older Git output. */
export function parseWorktreeList(output: string): GitWorktreeRecord[] {
  const rows: GitWorktreeRecord[] = []
  let path: string | undefined
  let branch = 'HEAD'
  let locked = false
  let prunable = false
  const flush = (): void => {
    if (path !== undefined) rows.push({ path, branch, locked, prunable })
    path = undefined
    branch = 'HEAD'
    locked = false
    prunable = false
  }
  const sep = output.includes('\0') ? '\0' : '\n'
  const framed = output.endsWith(sep) ? output : `${output}${sep}`
  for (const line of framed.split(sep)) {
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'locked' || line.startsWith('locked ')) {
      locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true
    }
  }
  return rows
}

/** Parse `git log --pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D` rows. */
export function parseLogLines(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({
      hash,
      subject,
      author: author ?? '',
      date: date ?? '',
      hashFull: hashFull ?? hash,
      refs: refs ?? '',
    })
  }
  return rows
}

/**
 * Parse `git log --name-status` output (the SAME pretty line as
 * {@link parseLogLines}, followed by one `\t`-framed row per touched file).
 * The two line kinds never collide: a pretty row always carries unit
 * separators, a name-status row never does. A rename/copy row carries a score
 * and BOTH paths (`R100\told\tnew`) and is attributed to the NEW path with the
 * bare letter — the file's name as the commit leaves it. Rows before the first
 * pretty line (a truncated answer) and junk lines are skipped, never fatal.
 */
export function parseLogNameStatus(output: string): GitLogEntry[] {
  const rows: GitLogEntry[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    if (line.includes('\x1f')) {
      const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
      if (hash === undefined || subject === undefined) continue
      rows.push({
        hash,
        subject,
        author: author ?? '',
        date: date ?? '',
        hashFull: hashFull ?? hash,
        refs: refs ?? '',
      })
      continue
    }
    const current = rows[rows.length - 1]
    if (current === undefined) continue
    const fields = line.split('\t')
    if (fields.length < 2 || fields[1] === '') continue
    const rawStatus = fields[0] ?? ''
    const status = rawStatus.length > 1 ? rawStatus[0]! : rawStatus
    // A rename/copy names both paths; the NEW one (the last field) is the
    // identity the client matches add operands against.
    const path = fields.length >= 3 ? fields[fields.length - 1]! : fields[1]!
    ;(current.files ??= []).push({ path, status })
  }
  return rows
}

/** Run one git command; resolves with stdout, rejects with GitCommandError.
 *  `input` (optional) is written to the child's stdin and the pipe closed —
 *  the `--stdin` readers (`check-ignore`) need it; every other command keeps
 *  the plain no-stdin spawn it always had. */
export function runGit(cwd: string, args: string[], timeoutMs = 30_000, input?: string): Promise<string> {
  // `core.quotePath=false`: emit paths verbatim instead of C-quoting them
  // (git's default turns a CJK/space path into an octal-escaped, quoted
  // string, and every diff surface renders that string as the file name).
  // The `-z`-framed porcelain callers are unaffected: git never quotes
  // NUL-framed output.
  const full = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false', ...args]
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', full, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    if (input !== undefined) {
      // A write to a git that died early surfaces as EPIPE on the stream; the
      // exit code / stderr below is the real error and must not be pre-empted
      // by an unhandled stream error.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new GitCommandError(`git ${args[0] ?? ''} timed out after ${timeoutMs}ms`, 'git-error', args.join(' ')))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new GitCommandError(`cannot run git: ${error.message}`, 'git-error', args.join(' ')))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise(stdout)
      } else {
        reject(new GitCommandError(stderr.trim() || `git exited with ${String(code)}`, 'git-error', args.join(' ')))
      }
    })
  })
}

/** One parsed `git blame --porcelain` row (the editor's hover blame). */
export interface GitBlameLine {
  /** 1-based line number in the file as it exists in the worktree. */
  line: number
  /** The blamed commit (40 hex chars; all zeros for a line that is not
   *  committed yet — a worktree edit git cannot attribute to a commit). */
  hash: string
  author: string
  /** Author time as ISO 8601 carrying the AUTHOR's UTC offset, so the value
   *  is stable regardless of the host machine's timezone. */
  date: string
  /** The commit's subject line (git's own placeholder for uncommitted rows). */
  summary: string
}

/** Format epoch seconds plus a `+HHMM`/`-HHMM` timezone as ISO 8601. */
function isoWithOffset(seconds: number, timezone: string): string {
  const zone = /^([+-])(\d{2})(\d{2})$/.exec(timezone)
  const offsetMinutes = zone === null
    ? 0
    : (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3]))
  const shifted = new Date((seconds + offsetMinutes * 60) * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  return zone === null ? `${stamp}Z` : `${stamp}${zone[1]}${zone[2]}:${zone[3]}`
}

/**
 * Parse `git blame --porcelain -L <a>,<b>` output into one row per blamed
 * line. Porcelain repeats only the `<hash> <orig> <final>` header for the
 * SECOND and later lines of the same commit (the author / committer / summary
 * block is emitted once per commit per run), so metadata is carried forward
 * per hash; every record ends with its `\t`-prefixed content line, which is
 * where the walk resumes. Unknown lines are skipped, never fatal.
 */
export function parseBlamePorcelain(output: string): GitBlameLine[] {
  const rows: GitBlameLine[] = []
  const seen = new Map<string, { author: string; date: string; summary: string }>()
  const lines = output.split('\n')
  let index = 0
  while (index < lines.length) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(lines[index]!)
    if (header === null) {
      index += 1
      continue
    }
    const hash = header[1]!
    const line = Number(header[2])
    index += 1
    let author: string | undefined
    let date: string | undefined
    let summary: string | undefined
    while (index < lines.length && !lines[index]!.startsWith('\t')) {
      const text = lines[index]!
      index += 1
      if (text.startsWith('author ')) author = text.slice('author '.length)
      else if (text.startsWith('author-time ')) {
        const seconds = Number(text.slice('author-time '.length))
        const zone = /^author-tz (.+)$/.exec(lines[index] ?? '')
        if (Number.isFinite(seconds)) date = isoWithOffset(seconds, zone?.[1] ?? '')
      } else if (text.startsWith('summary ')) summary = text.slice('summary '.length)
    }
    // The record's content line; the next header follows it.
    if (index < lines.length && lines[index]!.startsWith('\t')) index += 1
    const known = seen.get(hash)
    if (known === undefined) {
      const record = { author: author ?? '', date: date ?? '', summary: summary ?? '' }
      seen.set(hash, record)
      rows.push({ hash, line, ...record })
    } else {
      rows.push({ hash, line, ...known })
    }
  }
  return rows
}

/**
 * Blame one line range of a file (`git blame --porcelain -L <a>,<b>`).
 * Every failure mode — not a repository, an untracked file (`git blame`
 * exits non-zero: no such path in HEAD), a bad revision, a stalled mount
 * hitting the command timeout — resolves to an EMPTY result: the editor's
 * hover tooltip shows nothing and a missing answer can never break the
 * editing surface.
 */
export async function blame(
  cwd: string,
  path: string,
  startLine: number,
  endLine: number,
  selected?: string,
): Promise<GitBlameLine[]> {
  try {
    const root = await repoRoot(cwd, selected)
    const output = await runGit(root, [
      'blame', '--porcelain', '-L', `${String(startLine)},${String(endLine)}`, '--', path,
    ])
    return parseBlamePorcelain(output)
  } catch {
    return []
  }
}

/** Cap on child directories probed by the workspace-container fallback scan.
 *  A home-directory cwd can hold hundreds of visible folders (Library, iCloud
 *  mounts…); probing them all serially is what froze the panel in #369. */
const DISCOVERY_LIMIT = 200
/** Per-probe and direct-discovery budget. `rev-parse` is millisecond-scale on
 *  a healthy checkout; a probe that needs longer is a stalled mount and is
 *  better abandoned than waited on. */
const DISCOVERY_TIMEOUT_MS = 5_000
/** Discovery results are cheap to recompute but expensive to storm: the panel
 *  polls every 2s and each poll fans out into several git.* calls that all
 *  resolve the same roots. A short TTL keeps fan-out at one scan per cwd. */
const DISCOVERY_CACHE_TTL_MS = 60_000

const repoRootsCache = new Map<string, { roots: string[]; expires: number }>()
const repoRootsInFlight = new Map<string, Promise<string[]>>()

/** Whether the directory is inside a git work tree (exit-0 `git rev-parse`).
 *  Probe timeout is short: a cwd on a stalled mount must not hold the panel
 *  hostage for the full command budget (issue #369). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], DISCOVERY_TIMEOUT_MS)
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** The repository top level containing `cwd` (`git rev-parse --show-toplevel`). */
async function directRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--show-toplevel'], DISCOVERY_TIMEOUT_MS)
  return out.trim()
}

/** Discover the current repository or direct child repositories. Results are
 *  cached per cwd and concurrent callers share one in-flight scan, so opening
 *  the panel (three parallel git.* requests) costs a single discovery pass. */
export function repoRoots(cwd: string): Promise<string[]> {
  const cached = repoRootsCache.get(cwd)
  if (cached !== undefined && cached.expires > Date.now()) return Promise.resolve(cached.roots)
  const pending = repoRootsInFlight.get(cwd)
  if (pending !== undefined) return pending
  const promise = discoverRepoRoots(cwd).then(
    (roots) => {
      repoRootsCache.set(cwd, { roots, expires: Date.now() + DISCOVERY_CACHE_TTL_MS })
      repoRootsInFlight.delete(cwd)
      return roots
    },
    (error: unknown) => {
      repoRootsInFlight.delete(cwd)
      throw error
    },
  )
  repoRootsInFlight.set(cwd, promise)
  return promise
}

async function discoverRepoRoots(cwd: string): Promise<string[]> {
  try {
    return [await directRepoRoot(cwd)]
  } catch {
    const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
    const roots: string[] = []
    for (const entry of entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, DISCOVERY_LIMIT)) {
      try {
        const root = await directRepoRoot(join(cwd, entry.name))
        if (!roots.some(existing => pathIdentity(existing) === pathIdentity(root))) roots.push(root)
      } catch {
        // Ordinary child directory; keep discovering sibling repositories.
      }
    }
    return roots
  }
}

/** Resolve the selected repository, defaulting to the first discovered root. */
export async function repoRoot(cwd: string, selected?: string): Promise<string> {
  const roots = await repoRoots(cwd)
  if (roots.length === 0) throw new GitCommandError('not a git repository', 'not-repo', 'rev-parse')
  // Git for Windows may return forward-slash roots while callers pass
  // backslashes (or vice-versa); compare via the platform-aware identity.
  if (selected !== undefined) {
    const identity = pathIdentity(selected)
    const match = roots.find(root => pathIdentity(root) === identity)
    if (match !== undefined) return match
  }
  return roots[0]!
}

/** The current branch name (`git rev-parse --abbrev-ref HEAD`; 'HEAD' when detached). */
export async function currentBranch(cwd: string): Promise<string> {
  const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return out.trim()
}

/** Upper bound on status rows shipped to the client. Beyond this the result
 *  is truncated (with `truncated: true`) so a pathological untracked set —
 *  e.g. the working tree discovered under a home-directory cwd — cannot
 *  freeze the browser main thread on JSON parse or list render (#369). */
const GIT_STATUS_LIMIT = 2_000

/** How many paths one {@link statusPaths} call may carry. The client chunks
 *  its incremental refreshes well below this; the cap exists so a single
 *  request can never turn into a command line of unbounded length (Windows
 *  caps argv at ~32k characters, and a pathological caller would hit it). */
export const GIT_STATUS_PATHS_LIMIT = 200

/**
 * Fold one path's counts from both numstat sides into a running map. A file
 * changed in the index AND in the worktree is measured on each side against
 * HEAD, so the two readings ADD UP; a binary reading on either side wins,
 * because then there is no line count to add.
 */
function addLineCounts(into: Map<string, GitLineCounts>, from: Map<string, GitLineCounts>): void {
  for (const [path, counts] of from) {
    const previous = into.get(path)
    if (previous === undefined) {
      into.set(path, counts)
      continue
    }
    if (!('additions' in previous) || !('additions' in counts)) {
      into.set(path, { binary: true })
      continue
    }
    into.set(path, {
      additions: previous.additions + counts.additions,
      deletions: previous.deletions + counts.deletions,
    })
  }
}

/**
 * Working-tree status (untracked included). `--untracked-files=all` lists
 * the contents of new directories as individual entries, while preserving
 * repository discovery and explicit repository selection for workspace roots.
 *
 * The per-path line counts (#131) ride this SAME read: one batch of three git
 * processes answers status and both numstat sides together, never one process
 * per file, and callers keep their existing refresh cadence. A numstat failure
 * costs only the counts (the rows fall back to their count-less rendering) —
 * the status answer itself must never fail because of it.
 */
export async function status(cwd: string, selected?: string): Promise<GitStatusResult> {
  const repositories = await repoRoots(cwd)
  if (repositories.length === 0) return { isRepo: false, entries: [], repositories: [] }
  const root = await repoRoot(cwd, selected)
  const [branch, raw, unstagedNumstat, stagedNumstat, ignoredRaw] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(root, ['diff', '--numstat', '-z']).catch(() => ''),
    runGit(root, ['diff', '--cached', '--numstat', '-z']).catch(() => ''),
    // The IGNORED paths ride the same batch via `ls-files --ignored`, NOT a
    // `status --ignored` walk: ls-files answers in ~0.4 s on a pnpm-scale
    // tree where the status walk costs ~45 s (git descends into every
    // ignored directory before collapsing it), for the same collapsed
    // `dir/` list. The file tree's "ignored" overlay needs them; the
    // changes list must not see them. A failure costs the overlay, never
    // the status answer.
    runGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])
      .catch(() => ''),
  ])
  const parsed = parsePorcelainZ(raw)
  const lineCounts = new Map<string, GitLineCounts>()
  addLineCounts(lineCounts, parseNumstat(stagedNumstat))
  addLineCounts(lineCounts, parseNumstat(unstagedNumstat))
  const truncated = parsed.length > GIT_STATUS_LIMIT
  const bounded = truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed
  // The ignore list is capped separately from `entries` and gets its own
  // flag: an ignore overflow must not put the changes panel's truncation
  // notice up (no change row was dropped), it only downgrades the tree's
  // badges to "unknown" for the paths beyond the cap.
  const ignoredAll = ignoredPaths(ignoredRaw)
  const ignoredTruncated = ignoredAll.length > GIT_STATUS_LIMIT
  const ignored = ignoredTruncated ? ignoredAll.slice(0, GIT_STATUS_LIMIT) : ignoredAll
  return {
    isRepo: true,
    branch,
    // Paths git has no numstat row for (untracked files) keep their entry
    // untouched: the absence IS the information.
    entries: bounded.map((entry): GitStatusEntry => {
      const counts = lineCounts.get(entry.path)
      return counts === undefined ? entry : { ...entry, counts }
    }),
    truncated,
    ignored,
    ignoredTruncated,
    root,
    repositories,
  }
}

/**
 * Status of a NAMED SET OF PATHS only — the incremental counterpart of
 * {@link status} ("tell me about these rows", never "tell me the whole
 * repository").
 *
 * Why it exists: the client used to re-read the full snapshot whenever
 * anything in the checkout moved, so one saved file re-transferred every
 * changed row plus the whole ignored list and re-rendered the file tree. The
 * push hub now names the files that actually moved, and this route answers
 * exactly those, so a refresh costs an answer proportional to the change.
 *
 * Path handling: every requested path is resolved against the session cwd and
 * folded into a repo-root-relative pathspec. A path OUTSIDE the repository is
 * dropped (it can have no git status there); a DIRECTORY is passed as its own
 * pathspec, so git answers everything changed under it — an empty answer
 * means that subtree is clean. Requesting the repository root itself is
 * accepted and behaves like the full read (the caller normally never does:
 * fs events name files). Everything after `--` is a literal pathspec, so a
 * caller-supplied spelling can never be parsed as an option.
 *
 * The three reads ride ONE batch, exactly like {@link status}: porcelain
 * status (the rows), `check-ignore` (the ⊘ vocabulary — NUL-fed on stdin so
 * no argv-length or quoting concerns), and both `--numstat` sides (the line
 * counts). A failed ignore/numstat read costs only that facet; the status
 * answer itself must never fail because of it.
 *
 * @param cwd - the session working directory the paths resolve against.
 * @param paths - absolute paths (or cwd-relative spellings) to answer for.
 * @param selected - the Git panel's selected repository (a container cwd).
 * @returns the requested paths' entries + ignored paths, plus the root and
 *   branch they belong to; `isRepo: false` when cwd has no repository.
 */
export async function statusPaths(
  cwd: string,
  paths: readonly string[],
  selected?: string,
): Promise<GitStatusPathsResult> {
  if (paths.length > GIT_STATUS_PATHS_LIMIT) {
    throw new GitCommandError(
      `too many paths (max ${GIT_STATUS_PATHS_LIMIT})`,
      'bad-request',
      'status',
    )
  }
  const repositories = await repoRoots(cwd)
  if (repositories.length === 0) return { isRepo: false, entries: [], ignored: [] }
  const root = await repoRoot(cwd, selected)
  // Repo-root-relative pathspecs, deduped. A path outside the root has no
  // status here; the root itself is pathspec '.' (the full-read shape).
  const pathspecs: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    let rel: string
    try {
      rel = relative(root, resolve(cwd, raw)).split('\\').join('/')
    } catch {
      continue
    }
    // A path outside the root has no status here; on Windows a different
    // drive comes back ABSOLUTE from `relative` rather than `../`-prefixed.
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) continue
    const pathspec = rel === '' ? '.' : rel
    if (seen.has(pathspec)) continue
    seen.add(pathspec)
    pathspecs.push(pathspec)
  }
  const branchPromise = currentBranch(root).catch(() => 'HEAD')
  if (pathspecs.length === 0) {
    return { isRepo: true, root, branch: await branchPromise, entries: [], ignored: [] }
  }
  // ONE batch: the rows, their line counts, and the ignore subset. `--`
  // before the pathspecs keeps every caller spelling literal.
  const [branch, raw, unstagedNumstat, stagedNumstat, ignoredRaw] = await Promise.all([
    branchPromise,
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs]),
    runGit(root, ['diff', '--numstat', '-z', '--', ...pathspecs]).catch(() => ''),
    runGit(root, ['diff', '--cached', '--numstat', '-z', '--', ...pathspecs]).catch(() => ''),
    // NUL-framed on stdin AND stdout: a path that starts with `-` or holds a
    // newline stays literal. `check-ignore` exits 1 when nothing matches —
    // that is an empty answer, not a failure.
    runGit(root, ['check-ignore', '--stdin', '-z'], 30_000, `${pathspecs.join('\0')}\0`).catch(() => ''),
  ])
  const parsed = parsePorcelainZ(raw)
  const lineCounts = new Map<string, GitLineCounts>()
  addLineCounts(lineCounts, parseNumstat(stagedNumstat))
  addLineCounts(lineCounts, parseNumstat(unstagedNumstat))
  const truncated = parsed.length > GIT_STATUS_LIMIT
  const bounded = truncated ? parsed.slice(0, GIT_STATUS_LIMIT) : parsed
  return {
    isRepo: true,
    root,
    branch,
    entries: bounded.map((entry): GitStatusEntry => {
      const counts = lineCounts.get(entry.path)
      return counts === undefined ? entry : { ...entry, counts }
    }),
    ignored: ignoredPaths(ignoredRaw),
    truncated,
  }
}

/** Platform-aware identity used only for comparing absolute checkout roots. */
function pathIdentity(path: string): string {
  const absolute = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Whether the current Git binary supports NUL-framed `worktree list` output.
 * Git < 2.36 rejects `-z`; cache the capability after the first attempt so
 * the SCM panel's polling does not repeatedly spawn a command known to fail. */
let worktreeListSupportsZ: boolean | undefined

/** Raw usable checkout records, shared by inventory and target validation.
 * Prunable records point at missing paths and are deliberately excluded from
 * both the selector and the command-target allowlist. */
async function listedWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  let raw: string
  if (worktreeListSupportsZ === false) {
    raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
  } else {
    try {
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
      worktreeListSupportsZ = true
    } catch {
      worktreeListSupportsZ = false
      raw = await runGit(cwd, ['worktree', 'list', '--porcelain'])
    }
  }
  return parseWorktreeList(raw).filter(entry => !entry.prunable)
}

/**
 * How many entries `git status` reports for one checkout, as ONE cheap command.
 *
 * The inventory below used to call the full `status()`, which spawns four
 * processes — including the `--untracked-files=all` walk and two whole-repo
 * `--numstat` diffs — just to read `.entries.length`, per linked checkout, on a
 * 30 s poll. This asks the same question with a single process and without the
 * untracked walk. The number differs in exactly one way, deliberately: an
 * untracked DIRECTORY counts as one entry instead of as every file inside it,
 * which is what "this checkout has changes" should read as anyway (and the old
 * number was silently capped at `GIT_STATUS_LIMIT` regardless).
 */
async function countChanges(cwd: string): Promise<number> {
  const raw = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  return parsePorcelainZ(raw).length
}

/** All linked checkouts of the repository containing `cwd`, enriched with a
 * live change count. The current checkout is first so a single-worktree repo
 * preserves the old UI ordering. */
export async function worktrees(cwd: string): Promise<GitWorktree[]> {
  if (!await isGitRepo(cwd)) return []
  const currentRoot = await repoRoot(cwd)
  const listed = await listedWorktrees(cwd)
  const rows = await Promise.all(listed.map(async (entry): Promise<GitWorktree> => ({
    path: entry.path,
    branch: entry.branch,
    current: pathIdentity(entry.path) === pathIdentity(currentRoot),
    // One stale/permission-raced linked checkout must not hide the valid
    // current repository from the panel. Targeted operations still fail loud.
    changes: await countChanges(entry.path).catch(() => 0),
  })))
  return rows.sort((left, right) => Number(right.current) - Number(left.current))
}

/** Resolve an optional client-selected linked checkout. A caller may never use
 * this seam to point Git operations at an unrelated repository: the target
 * must occur in the authoritative session repository's worktree list. */
export async function resolveWorktree(cwd: string, requested?: string): Promise<string> {
  if (requested === undefined || requested === '') return cwd
  const identity = pathIdentity(requested)
  const match = (await listedWorktrees(cwd)).find(entry => pathIdentity(entry.path) === identity)
  if (match === undefined) {
    throw new GitCommandError(`unknown linked worktree: ${requested}`, 'git-worktree', 'worktree list')
  }
  return match.path
}

/** Diff text of the worktree (unstaged) or the index (staged). */
export async function diff(cwd: string, path: string | undefined, staged: boolean, selected?: string): Promise<string> {
  const root = await repoRoot(cwd, selected)
  const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
  if (staged) args.push('--cached')
  if (path !== undefined) args.push('--', path)
  return runGit(root, args)
}

/**
 * Diff text of the worktree against HEAD — staged and unstaged changes in
 * ONE patch, which is what "uncommitted changes" means for the editor's
 * change gutter (the two-sided `diff()` above would each miss half of a file
 * that is partly staged). A repository whose HEAD is not born yet cannot
 * answer `diff HEAD`, so that one failure falls back to `diff --cached`
 * (index against the empty tree — the unborn-HEAD shape of the same
 * question). Untracked files never appear in either: the caller marks them
 * from the status store instead.
 */
export async function diffHead(cwd: string, path: string | undefined, selected?: string): Promise<string> {
  const root = await repoRoot(cwd, selected)
  const tail = path !== undefined ? ['--', path] : []
  try {
    return await runGit(root, ['diff', '--no-ext-diff', '--no-color', '-U3', 'HEAD', ...tail])
  } catch {
    return runGit(root, ['diff', '--no-ext-diff', '--no-color', '-U3', '--cached', ...tail])
  }
}

/**
 * Diff text of the worktree against ANY baseline revision — staged and
 * unstaged in ONE patch (the worktree-vs-rev shape of {@link diffHead},
 * aimed at an arbitrary rev instead), which is what "this round changed"
 * means for the changes tab's round-diff lens: it aims the call at the newest
 * commit that predates the round, so every round change — round-committed or
 * still uncommitted, added / modified / deleted / renamed — falls out of the
 * one patch. Untracked files never appear (they are in no baseline to diff
 * from), the same as every other git diff face.
 *
 * `--end-of-options` precedes the rev: a caller-supplied value beginning with
 * `-` would otherwise parse as an OPTION (see show() / commitDiff() for the
 * same guard). The empty-tree hash is a valid rev everywhere, so the unborn
 * round shape (every commit inside the round) passes the all-virtual tree and
 * reads every tracked file as new.
 */
export async function diffRange(cwd: string, rev: string, selected?: string): Promise<string> {
  return runGit(await repoRoot(cwd, selected), ['diff', '--no-ext-diff', '--no-color', '-U3', '--end-of-options', rev])
}

/** Stage paths (all when path is undefined). */
export async function stage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['add', '-A', ...(path !== undefined ? ['--', path] : [])])
}

/** Unstage paths (all when path is undefined). */
export async function unstage(cwd: string, path: string | undefined, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['reset', '-q', ...(path !== undefined ? ['--', path] : [])])
}

/** Commit the staged changes with a message (global identity untouched). */
export async function commit(cwd: string, message: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['commit', '-m', message])
}

/** Branch names (current first). */
export async function branches(cwd: string, selected?: string): Promise<{ current: string; names: string[] }> {
  const root = await repoRoot(cwd, selected)
  const [current, raw] = await Promise.all([
    currentBranch(root).catch(() => 'HEAD'),
    runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
  ])
  const names = raw.split('\n').filter(line => line !== '')
  return { current, names: names.includes(current) ? names : [current, ...names] }
}

/** Switch to an existing branch.
 *  A caller-supplied branch beginning with `-` parses as an OPTION, so `-f`
 *  force-discarded the worktree changes and `--work-tree=…` redirected the
 *  checkout (4100e16 added `--end-of-options` guards to show / commitDiff /
 *  revert / cherryPick). Checkout is the exception: its operand parsing does
 *  not go through parse-options, so it never learned the sentinel — git treats
 *  `--end-of-options` itself as a pathspec (verified on 2.39.5: `pathspec
 *  '--end-of-options' did not match any file(s) known to git`) and the real
 *  branch switch breaks. The guard is the rejection below: a valid refname can
 *  never start with `-` (`git check-ref-format --branch` refuses it), so an
 *  option-like name dies before git sees it and what remains is a bare operand
 *  that cannot parse as an option — on every git version. */
export async function checkout(cwd: string, branch: string, selected?: string): Promise<void> {
  if (branch.startsWith('-')) throw new Error(`refusing option-like branch name: ${branch}`)
  await runGit(await repoRoot(cwd, selected), ['checkout', branch])
}

/** Recent commit history (newest first), lazily pageable via skip/count.
 *  `opts.files` adds `--name-status` and fills each entry's `files` (see
 *  {@link parseLogNameStatus}); without it the output — and the parse — are
 *  exactly what they always were, so older callers see no difference.
 *  `opts.path` narrows the log to ONE pathspec (a file's, or a directory's
 *  whole subtree — git treats a dir pathspec as "anything under it", which is
 *  how a folder row shows the history of everything it holds). The pathspec
 *  rides behind `--end-of-options` + `--`: a caller-supplied value beginning
 *  with `-` would otherwise parse as an OPTION (the same guard show() /
 *  commitDiff() / diffRange() carry, see their comments), and after the
 *  sentinel it can only ever be a path. `opts.follow` (a single FILE only)
 *  adds `--follow`, so a file renamed mid-history keeps its log continuous
 *  instead of stopping at the rename. Our own flag, it goes BEFORE the
 *  sentinel — past `--end-of-options` git would take it for a pathspec and
 *  the command would fail. Without `opts.path` the argv is byte-identical to
 *  the pre-history shape: no `--`, no sentinel, no `--follow`. */
export async function log(
  cwd: string,
  count = 30,
  skip = 0,
  selected?: string,
  opts?: { files?: boolean; path?: string; follow?: boolean },
): Promise<GitLogEntry[]> {
  const args = [
    'log', '-n', String(count), '--skip', String(skip), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D',
  ]
  const files = opts?.files === true
  if (files) args.push('--name-status')
  const path = opts?.path
  if (path !== undefined && path !== '') {
    if (opts?.follow === true) args.push('--follow')
    args.push('--end-of-options', '--', path)
  }
  const raw = await runGit(await repoRoot(cwd, selected), args)
  return files ? parseLogNameStatus(raw) : parseLogLines(raw)
}

/**
 * Content of a file at a revision (`git show <rev>:<path>`), or null when the
 * revision has no such path (a new/untracked file has no HEAD side).
 *
 * `--end-of-options` precedes the operand: without it a caller-supplied `rev`
 * beginning with `-` is parsed as an OPTION rather than a revision, so
 * `rev: "--output=NUL"` silently wrote to a file and returned empty instead of
 * failing (the Changes tab's diff/blame panes then rendered blank). The
 * sentinel ends option parsing, so the operand can never be a flag while every
 * legitimate revision form still works (`HEAD`, `:0`, `<hash>^`, `HEAD~2`,
 * `origin/main`, any branch name).
 */
export async function show(cwd: string, rev: string, path: string, selected?: string): Promise<string | null> {
  try {
    return await runGit(await repoRoot(cwd, selected), ['show', '--end-of-options', `${rev}:${path}`])
  } catch {
    return null
  }
}

/** Full patch text of one commit (`git show` with the commit header suppressed).
 *  Merge commits show their diff against the first parent (`-m --first-parent`
 *  is a no-op for regular commits), so a history click always has content.
 *  `--end-of-options` keeps a caller-supplied hash from parsing as an option.
 *  `opts.path` trims the patch to ONE pathspec (`<hash> -- <path>` — "what did
 *  THIS commit do to that file/directory"): the file-history modal expands a
 *  commit onto the row it listed, and a whole-commit patch would bury the one
 *  file's hunks under every sibling's. The path is an operand, not an option,
 *  so it rides after a bare `--` (the hash's `--end-of-options` guard does not
 *  cover it — the sentinel ends parsing at the hash, everything after `--` is
 *  a pathspec anyway, and a leading `-` path cannot parse as a flag there). */
export async function commitDiff(cwd: string, hash: string, selected?: string, opts?: { path?: string }): Promise<string> {
  const args = ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', '--end-of-options', hash]
  const path = opts?.path
  if (path !== undefined && path !== '') args.push('--', path)
  return runGit(await repoRoot(cwd, selected), args)
}

/** Discard the worktree changes of one path (`git checkout -- <path>`; the index is untouched). */
export async function discard(cwd: string, path: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['checkout', '--', path])
}

/** Revert one commit onto the current branch with an auto-generated message.
 *  `--end-of-options` keeps a caller-supplied hash from parsing as an option. */
export async function revert(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['revert', '--no-edit', '--end-of-options', hash])
}

/** Cherry-pick one commit onto the current branch.
 *  `--end-of-options` keeps a caller-supplied hash from parsing as an option. */
export async function cherryPick(cwd: string, hash: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['cherry-pick', '--end-of-options', hash])
}

/** Push the current branch to its upstream (`git push`). A branch without a
 *  tracking remote fails loudly with git's own message — the panel shows it and
 *  the user fixes the tracking in a terminal. No operands, so there is nothing
 *  for a caller-supplied value to smuggle in as an option. */
export async function push(cwd: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['push'])
}

/** Pull upstream changes into the current branch (`git pull --ff-only`).
 *  Fast-forward-only keeps a headless panel out of merge/conflict editors: a
 *  diverged branch fails with git's own message instead of opening an
 *  interactive merge, so the user resolves it in a terminal. */
export async function pull(cwd: string, selected?: string): Promise<void> {
  await runGit(await repoRoot(cwd, selected), ['pull', '--ff-only'])
}
