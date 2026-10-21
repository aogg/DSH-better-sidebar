/**
 * The round-diff lens's summary hierarchy.
 *
 * The round-diff lens used to render its parsed patch files (`parseDiffFiles`)
 * as one flat row per file, whole path on the line — a round touching
 * `src/client/changes/*` read as a wall of near-identical rows. This module
 * folds the list into the directory tree the lens renders — the SAME shape
 * the session lens shows (see `session-tree.ts`): directories before files, a
 * directory with no file of its own and exactly one subdirectory compressed
 * into one `a/b/c` row, and a pinned case-insensitive collation so the order
 * does not move between machines. The leaves keep their diff-summary status
 * letter, so the renderer only walks the result.
 *
 * Pure — no React, no DOM. `buildRoundDiffTree` runs once per parsed patch;
 * the renderer only walks the result. The collation helpers mirror
 * `change-tree.ts` on purpose: that module's API and behavior stay untouched
 * (its specs pin them), and it is not reused here because its input is a
 * porcelain `XY` answer whose leaf status is DERIVED (`statusOfXY`) — a diff
 * summary carries a plain letter, and synthesizing porcelain codes to fit
 * would be lossy (an unrecognized letter would silently drop the file) and
 * would drag staged/unstaged semantics into a view that has neither. This is
 * the same call `session-tree.ts` made for its own leaf payload.
 */
import type { CommitFile } from './round-commits.ts'

/** One changed file (a leaf), carrying its diff-summary status letter. */
export interface RoundDiffFile {
  kind: 'file'
  /** The file's own name (the last path segment). */
  name: string
  /** The repo-relative path exactly as the patch named it (the b-side, the
   *  row's identity and what a 「查看原文件」 open resolves). */
  path: string
  /** The summary letter the patch headers carry (M/A/D/R — see
   *  `parseDiffFiles`). */
  status: string
}

/** One directory row: its children plus the number of changed files beneath. */
export interface RoundDiffDir {
  kind: 'dir'
  /** The display label: one segment, or the compressed chain ('src/client'). */
  name: string
  /** The deepest directory this row stands for (normalized separators) — the
   *  fold-set key and what a 「查看原文件」 open resolves. */
  path: string
  children: RoundDiffNode[]
  /** Changed files anywhere under this row (the row's count pill). */
  files: number
}

export type RoundDiffNode = RoundDiffDir | RoundDiffFile

/** A directory being assembled (children keyed by their own segment). */
interface DirDraft {
  name: string
  path: string
  dirs: Map<string, DirDraft>
  files: RoundDiffFile[]
}

/**
 * Split one file path into its normalized segments: separators unified to
 * `/`, empty and `.` segments dropped — the exact normalization
 * `change-tree.ts` applies, so the three trees name the same directories
 * alike.
 */
function segmentsOf(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(segment => segment !== '' && segment !== '.')
}

/**
 * Directories before files, then by name — case-insensitively.
 *
 * The collation is PINNED (`'en'`, `sensitivity: 'base'`) rather than left to
 * the runtime's default locale: `localeCompare(other)` alone follows whatever
 * locale the browser/Node happens to run under, so the same tree could order
 * differently on two machines. Base sensitivity makes case and accent
 * variants compare equal, and the code-point tiebreak below then decides — a
 * total order that does not move when the input order changes.
 */
function compareNames(left: string, right: string): number {
  const collated = left.localeCompare(right, 'en', { sensitivity: 'base' })
  if (collated !== 0) return collated
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareNodes(left: RoundDiffNode, right: RoundDiffNode): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  return compareNames(left.name, right.name)
}

/** The number of changed files under a finished child list. */
function countFiles(nodes: readonly RoundDiffNode[]): number {
  let count = 0
  for (const node of nodes) count += node.kind === 'dir' ? node.files : 1
  return count
}

/** Materialize one draft directory, compressing its single-child chain. */
function finishDir(draft: DirDraft): RoundDiffDir {
  let name = draft.name
  let current = draft
  // A directory with no file of its own and exactly one subdirectory is not
  // worth a row: the whole chain reads as one label (`a/b/c`). Compression
  // stops the moment the path branches or a file sits at this level, so a row
  // always stands for a place where something actually changed.
  while (current.files.length === 0 && current.dirs.size === 1) {
    const only = [...current.dirs.values()][0]!
    name = `${name}/${only.name}`
    current = only
  }
  const children = finishChildren(current)
  return { kind: 'dir', name, path: current.path, children, files: countFiles(children) }
}

/** Finish a draft's children (directories first, then its own files). */
function finishChildren(draft: DirDraft): RoundDiffNode[] {
  const nodes: RoundDiffNode[] = []
  for (const child of draft.dirs.values()) nodes.push(finishDir(child))
  nodes.push(...draft.files)
  nodes.sort(compareNodes)
  return nodes
}

/**
 * Fold one round patch's file rows into a directory tree. A repeated path
 * counts once (a patch cannot name the same b-side twice; the guard keeps a
 * malformed one honest) and an empty input yields an empty list. Unlike the
 * flat list's patch order, rows within a level are name-sorted — the Git and
 * session lens's ordering, so all three trees read alike.
 * @param files - the parsed patch rows (`parseDiffFiles` output).
 * @returns the tree's roots, ready to render in order.
 */
export function buildRoundDiffTree(files: readonly CommitFile[]): RoundDiffNode[] {
  const root: DirDraft = { name: '', path: '', dirs: new Map(), files: [] }
  const seen = new Set<string>()
  for (const file of files) {
    const segments = segmentsOf(file.path)
    if (segments.length === 0) continue
    const normalized = segments.join('/')
    if (seen.has(normalized)) continue
    seen.add(normalized)
    // The FILE keeps the patch's own spelling (the open action and the row's
    // title both resolve this path); only the directory rows use the split
    // form.
    const leaf: RoundDiffFile = {
      kind: 'file',
      name: segments[segments.length - 1]!,
      path: file.path,
      status: file.status,
    }
    let at = root
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!
      let next = at.dirs.get(name)
      if (next === undefined) {
        next = { name, path: segments.slice(0, index + 1).join('/'), dirs: new Map(), files: [] }
        at.dirs.set(name, next)
      }
      at = next
    }
    at.files.push(leaf)
  }
  return finishChildren(root)
}

/**
 * Every directory row path of one finished tree, depth-first in display
 * order — exactly the `path`s the {@link RoundDiffDir} rows carry, so
 * 「全部收起」 can fill the collapsed-set with real row keys (a compressed
 * chain contributes its own row path, never the intermediate ones it
 * swallowed: those have no row to fold).
 * @param nodes - the tree's roots (any finished subtree works too).
 * @returns the directory paths, parents before children.
 */
export function dirPathsOf(nodes: readonly RoundDiffNode[]): string[] {
  const paths: string[] = []
  for (const node of nodes) {
    if (node.kind !== 'dir') continue
    paths.push(node.path)
    paths.push(...dirPathsOf(node.children))
  }
  return paths
}
