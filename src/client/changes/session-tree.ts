/**
 * The session lens's hierarchy.
 *
 * The session lens used to render its `path → ops` groups as one row per
 * file, with the whole path squeezed onto the line — a round touching
 * `src/client/changes/*` read as a wall of near-identical rows. This module
 * folds the groups into the directory tree the lens renders — the SAME shape
 * the Git lens shows (see `change-tree.ts`): directories before files, a
 * directory with no file of its own and exactly one subdirectory compressed
 * into one `a/b/c` row, and a pinned case-insensitive collation so the order
 * does not move between machines. The leaves carry their file's operations,
 * so the renderer only walks the result.
 *
 * Pure — no React, no DOM. `buildSessionTree` runs once per filter fold; the
 * renderer only walks the result. The collation helpers mirror
 * `change-tree.ts` on purpose: that module's API and behavior stay untouched
 * (its specs pin them), and this one differs in its leaf payload anyway.
 */
import type { FileOp, FileOpKind } from './ops.ts'

/** One touched file (a leaf), carrying the round's operations on it. */
export interface SessionFile {
  kind: 'file'
  /** The file's own name (the last path segment). */
  name: string
  /** The path exactly as the model spelled it — the row's identity, what the
   *  header's title shows, and what a preview targets. */
  path: string
  /** The file's operations, newest first (the group's own order). */
  ops: readonly FileOp[]
}

/** One directory row: its children plus the number of touched files beneath. */
export interface SessionDir {
  kind: 'dir'
  /** The display label: one segment, or the compressed chain ('src/client'). */
  name: string
  /** The deepest directory this row stands for (normalized separators). */
  path: string
  children: SessionNode[]
  /** Touched files anywhere under this row (the row's count pill). */
  files: number
}

export type SessionNode = SessionDir | SessionFile

/** A directory being assembled (children keyed by their own segment). */
interface DirDraft {
  name: string
  path: string
  dirs: Map<string, DirDraft>
  files: SessionFile[]
}

/**
 * Split one file path into its normalized segments: separators unified to
 * `/`, empty and `.` segments dropped — the exact normalization
 * `change-tree.ts` applies, so the two trees name the same directories alike.
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

function compareNodes(left: SessionNode, right: SessionNode): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  return compareNames(left.name, right.name)
}

/** The number of touched files under a finished child list. */
function countFiles(nodes: readonly SessionNode[]): number {
  let count = 0
  for (const node of nodes) count += node.kind === 'dir' ? node.files : 1
  return count
}

/** Materialize one draft directory, compressing its single-child chain. */
function finishDir(draft: DirDraft): SessionDir {
  let name = draft.name
  let current = draft
  // A directory with no file of its own and exactly one subdirectory is not
  // worth a row: the whole chain reads as one label (`a/b/c`). Compression
  // stops the moment the path branches or a file sits at this level, so a row
  // always stands for a place where something actually happened.
  while (current.files.length === 0 && current.dirs.size === 1) {
    const only = [...current.dirs.values()][0]!
    name = `${name}/${only.name}`
    current = only
  }
  const children = finishChildren(current)
  return { kind: 'dir', name, path: current.path, children, files: countFiles(children) }
}

/** Finish a draft's children (directories first, then its own files). */
function finishChildren(draft: DirDraft): SessionNode[] {
  const nodes: SessionNode[] = []
  for (const child of draft.dirs.values()) nodes.push(finishDir(child))
  nodes.push(...draft.files)
  nodes.sort(compareNodes)
  return nodes
}

/**
 * Fold one round's `path → ops` groups into a directory tree. Every directory
 * in the result holds at least one file (a filter that removes a group's last
 * file removes its whole branch with it — no empty shells), groups spelled
 * two ways over the same normalized path merge into one row, and an empty
 * input yields an empty list. Unlike the ops' own recency order, rows within
 * a level are name-sorted — the Git lens's ordering, so the two trees read
 * alike.
 * @param groups - the filtered `groupByFile` result (path → its ops).
 * @returns the tree's roots, ready to render in order.
 */
export function buildSessionTree(groups: ReadonlyMap<string, readonly FileOp[]>): SessionNode[] {
  const root: DirDraft = { name: '', path: '', dirs: new Map(), files: [] }
  const seen = new Map<string, SessionFile>()
  for (const [path, ops] of groups) {
    const segments = segmentsOf(path)
    if (segments.length === 0) continue
    const normalized = segments.join('/')
    const existing = seen.get(normalized)
    if (existing !== undefined) {
      // The same file spelled two ways in one round (`./a.ts` and `a.ts`):
      // one row, both rows' ops, the caller's order preserved.
      existing.ops = [...existing.ops, ...ops]
      continue
    }
    // The FILE keeps the model's own spelling (the preview and the header's
    // title both resolve this path); only the directory rows use the split
    // form.
    const file: SessionFile = { kind: 'file', name: segments[segments.length - 1]!, path, ops }
    seen.set(normalized, file)
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
    at.files.push(file)
  }
  return finishChildren(root)
}

/**
 * The ancestor directory paths of one file path, shallowest first, normalized
 * the same way the tree's directory rows are — so the returned strings are
 * exactly the `path`s the tree's {@link SessionDir} rows carry, and a
 * collapsed-set lookup hits. A bare file name has no ancestors.
 * @param path - the file's path (any separator).
 * @returns the ancestor directory paths, nearest last.
 */
export function ancestorDirs(path: string): string[] {
  const segments = segmentsOf(path)
  const dirs: string[] = []
  for (let index = 1; index < segments.length; index += 1) {
    dirs.push(segments.slice(0, index).join('/'))
  }
  return dirs
}

/** The fixed badge order of a folded file header: edits first (the round's
 *  substance), then whole-file writes, then reads. */
const FOLD_KIND_ORDER = ['edit', 'write', 'read'] as const

/**
 * The op kinds one file's FOLDED header badges: every kind that occurs in the
 * group, deduplicated, in the fixed {@link FOLD_KIND_ORDER}. The header used
 * to badge only the NEWEST op's kind — a subagent's edits followed by a later
 * plain read of the same path folded down to a lone 读取 pill and, under the
 * 「全部」 filter, the round read as untouched (session f1fa85ec, Backend.php /
 * Index.php). One badge per occurred kind keeps the summary truthful without
 * unfolding anything.
 * @param ops - the file's operations, newest first (the group's own order).
 * @returns the distinct kinds in fixed order; empty only for an empty group.
 */
export function foldedKindsOf(ops: readonly FileOp[]): FileOpKind[] {
  const seen = new Set<FileOpKind>()
  for (const op of ops) seen.add(op.kind)
  return FOLD_KIND_ORDER.filter(kind => seen.has(kind))
}
