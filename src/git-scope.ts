/**
 * The search page's optional「git 起点」(git-from scope): the user names a
 * git baseline — a commit-ish (`abc1234`, `HEAD~5`, `v1.2.0`) or a date
 * (`2026-10-01`, `2026-10-01 12:00`) — and the search's candidate file set
 * narrows to the files whose CONTENTS differ between that baseline and the
 * CURRENT worktree. The contents searched are the worktree's (unchanged v2
 * behavior); only the candidate set is filtered.
 *
 * Resolution order (each step falls through to the next on failure):
 *  1. the session cwd must sit inside a git work tree (`isGitRepo`) —
 *     otherwise a clean bad-request, never a git stderr leak;
 *  2. `git rev-parse --verify --quiet <input>^{commit}` — a valid commit-ish
 *     wins immediately (`^{commit}` peels tags/annotated refs to a commit);
 *  3. `git rev-list -1 --before=<input> HEAD` — but ONLY for strictly
 *     date-shaped input (see {@link DATE_SHAPE}): git's approxidate is
 *     deliberately lenient (an unparseable string silently reads as "now",
 *     which would turn a typo into "baseline = HEAD"), so the date path is
 *     gated on the documented `2026-10-01 [HH:MM[:SS]]` forms and git's own
 *     parser picks the newest commit on the current branch dated before it;
 *     an EMPTY answer (the date predates the branch's first commit) fails;
 *  4. all of the above failed → bad-request「无法识别为提交或日期」;
 *  5. the candidate set is ONE `git diff --name-only -z <baseline>` against
 *     the worktree: committed + staged + unstaged changes in a single
 *     answer (`-z` NUL framing, so no path ever arrives C-quoted). Untracked
 *     files are deliberately outside — they exist in no baseline to differ
 *     from — and deleted files drop out naturally (nothing to read in the
 *     worktree the search walks).
 *
 * git answers with REPO-ROOT-relative paths; the session cwd may sit deeper
 * (a subdirectory checkout) or the root may be a realpath spelling of what
 * the caller passed (macOS `/var` → `/private/var`). Every path is mapped
 * with `relative(realpath(cwd), join(realpath(root), gitPath))` — paths
 * landing outside the session cwd are dropped, survivors are normalized to
 * cwd-relative '/'-separated form, exactly the shape
 * {@link ContentSearchOptions.gitFiles} judges.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isGitRepo, repoRoot, runGit } from './git.ts'
import { SidebarError } from './wire.ts'

/** One resolved git-from scope. */
export interface GitScope {
  /** The baseline commit (as git printed it — a full object name). */
  commit: string
  /** The changed paths, cwd-relative and '/'-separated (the exact shape
   *  the content-search engines judge). */
  files: Set<string>
}

/** The date shapes that may take the `--before` path: `2026-10-01`, with an
 *  optional ` HH:MM[:SS]` (or `T`-separated) time. Deliberately a GATE, not
 *  a parser — git still does the parsing; this only keeps its lenient
 *  approxidate from reading arbitrary garbage as "now". */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/

/** realpath spelling of one path (deleted/racy paths keep their raw form —
 *  the mapping below then simply mismatches and the file is dropped). */
function realOf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** The commit `<input>^{commit}` resolves to, or null (any failure — an
 *  unknown rev, an object that is not a commit — reads as "not this shape").
 *  `--quiet` makes git exit non-zero WITHOUT stderr noise on a miss;
 *  `--end-of-options` keeps an input that begins with `-` from parsing as an
 *  option (the same guard show()/commitDiff()/diffRange() carry). */
async function commitOf(root: string, input: string): Promise<string | null> {
  try {
    const out = await runGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${input}^{commit}`])
    const hash = out.trim()
    return hash === '' ? null : hash
  } catch {
    return null
  }
}

/** The newest commit on HEAD dated before `<input>` (git's own date
 *  grammar), or null — including the EMPTY answer a too-early date yields
 *  (an empty `rev-list -1` means "no such commit", not "the first commit"). */
async function commitBeforeOf(root: string, input: string): Promise<string | null> {
  try {
    const out = await runGit(root, ['rev-list', '-1', `--before=${input}`, 'HEAD'])
    const hash = out.trim()
    return hash === '' ? null : hash
  } catch {
    return null
  }
}

/**
 * Resolve one user-typed git 起点 against the session cwd (see the module
 * header for the order). Every failure is a clean `bad-request`; git's
 * stderr never reaches the wire.
 */
export async function resolveGitScope(cwd: string, input: string): Promise<GitScope> {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new SidebarError('bad-request', 'git 起点为空（git-from scope is empty）')
  }
  if (!await isGitRepo(cwd)) {
    throw new SidebarError('bad-request', '当前工作区不是 git 仓库（not a git repository）')
  }
  const root = await repoRoot(cwd)
  // Commit-ish first; the date path opens only for date-shaped input (see
  // DATE_SHAPE — approxidate's leniency must not turn a typo into HEAD).
  const commit = await commitOf(root, trimmed)
    ?? (DATE_SHAPE.test(trimmed) ? await commitBeforeOf(root, trimmed) : null)
  if (commit === null) {
    throw new SidebarError('bad-request', `无法识别为提交或日期：${trimmed}（not a valid commit or date）`)
  }
  // One diff answers the whole candidate set: baseline → worktree (staged
  // and unstaged included, untracked excluded). The commit rides behind
  // `--end-of-options` like every other caller-supplied rev.
  const raw = await runGit(root, ['diff', '--name-only', '-z', '--end-of-options', commit])
  const base = realOf(cwd)
  const rootReal = realOf(root)
  const files = new Set<string>()
  for (const entry of raw.split('\0')) {
    if (entry === '') continue
    // git speaks repo-root-relative; the search judges cwd-relative. A path
    // mapping outside the session cwd (`..` or absolute) is not this
    // workspace's file — drop it rather than mis-scope the search.
    const rel = relative(base, join(rootReal, entry))
    if (rel === '' || isAbsolute(rel) || rel.startsWith('..')) continue
    files.add(rel.split(sep).join('/'))
  }
  return { commit, files }
}
