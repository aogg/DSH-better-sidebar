/**
 * The session lens's directory tree (src/client/changes/session-tree.ts):
 * `buildSessionTree` folds the tab's `path → ops` groups into the SAME shape
 * the Git lens renders (`change-tree.ts`) — directories before files, one
 * `a/b/c` row for a chain of directories that never branch and never hold a
 * file of their own, a pinned 'en'/base collation so the order does not move
 * between machines — and `ancestorDirs` names the directory rows a file sits
 * under, shallowest first, in exactly the spelling the tree's rows carry (the
 * collapsed-set lookup in SessionLens keys on those strings verbatim).
 */
import { describe, expect, it } from 'vitest'
import { ancestorDirs, buildSessionTree, type SessionNode } from '../src/client/changes/session-tree.ts'
import type { FileOp, FileOpKind } from '../src/client/changes/ops.ts'

/** One op as the tab's fold produces it (the tree carries ops opaquely). */
function op(callId: string, kind: FileOpKind = 'write', time = 1_700_000_000_000): FileOp {
  return { callId, kind, path: '', time, running: false, isError: false }
}

/** A compact, assertion-friendly projection of one tree. */
const shape = (nodes: readonly SessionNode[]): unknown[] => nodes.map(node => node.kind === 'dir'
  ? { dir: node.name, path: node.path, files: node.files, children: shape(node.children) }
  : { file: node.name, path: node.path, ops: node.ops.map(item => item.callId) })

/** Every node with the path of the row directly holding it ('' = the root). */
function walk(nodes: readonly SessionNode[], container = ''): Array<{ node: SessionNode; container: string }> {
  return nodes.flatMap(node => [
    { node, container },
    ...(node.kind === 'dir' ? walk(node.children, node.path) : []),
  ])
}

describe('buildSessionTree', () => {
  it('returns no rows for an empty group map', () => {
    expect(buildSessionTree(new Map())).toEqual([])
  })

  it('keeps a bare root-level file as one leaf without a directory row', () => {
    expect(shape(buildSessionTree(new Map([['readme.md', [op('r1')]]])))).toEqual([
      { file: 'readme.md', path: 'readme.md', ops: ['r1'] },
    ])
  })

  it('compresses a never-branching directory chain into one a/b/c row', () => {
    const tree = buildSessionTree(new Map([['src/client/changes/a.ts', [op('a1')]]]))
    expect(shape(tree)).toEqual([
      {
        dir: 'src/client/changes',
        path: 'src/client/changes',
        files: 1,
        children: [{ file: 'a.ts', path: 'src/client/changes/a.ts', ops: ['a1'] }],
      },
    ])
  })

  it('stops compressing where the path branches or a directory holds its own file', () => {
    const groups = (entries: Array<[string, FileOp[]]>): Map<string, FileOp[]> => new Map(entries)
    // Two child directories: 'src' keeps its own row.
    expect(shape(buildSessionTree(groups([
      ['src/a/x.ts', [op('x1')]], ['src/b/y.ts', [op('y1')]],
    ])))).toEqual([
      {
        dir: 'src',
        path: 'src',
        files: 2,
        children: [
          { dir: 'a', path: 'src/a', files: 1, children: [{ file: 'x.ts', path: 'src/a/x.ts', ops: ['x1'] }] },
          { dir: 'b', path: 'src/b', files: 1, children: [{ file: 'y.ts', path: 'src/b/y.ts', ops: ['y1'] }] },
        ],
      },
    ])
    // A file AT this level: 'a' keeps its own row (and its file leads the children).
    expect(shape(buildSessionTree(groups([
      ['a/x.ts', [op('x1')]], ['a/b/y.ts', [op('y1')]],
    ])))).toEqual([
      {
        dir: 'a',
        path: 'a',
        files: 2,
        children: [
          { dir: 'b', path: 'a/b', files: 1, children: [{ file: 'y.ts', path: 'a/b/y.ts', ops: ['y1'] }] },
          { file: 'x.ts', path: 'a/x.ts', ops: ['x1'] },
        ],
      },
    ])
  })

  it('merges two spellings of one normalized path into a single row, ops concatenated', () => {
    // The same file spelled './x.ts' and 'x.ts' in one round: one row, both
    // rows' ops in the caller's order, the FIRST spelling kept as the path
    // (the preview and the header's title resolve that one).
    const tree = buildSessionTree(new Map([
      ['./x.ts', [op('o1', 'read')]],
      ['x.ts', [op('o2', 'edit')]],
    ]))
    expect(shape(tree)).toEqual([
      { file: 'x.ts', path: './x.ts', ops: ['o1', 'o2'] },
    ])
  })

  it('unifies separators and ./ segments so one directory reads as one row', () => {
    const tree = buildSessionTree(new Map([
      ['src\\client\\a.ts', [op('a1')]],
      ['./src/client/b.ts', [op('b1')]],
    ]))
    expect(shape(tree)).toEqual([
      {
        dir: 'src/client',
        path: 'src/client',
        files: 2,
        children: [
          { file: 'a.ts', path: 'src\\client\\a.ts', ops: ['a1'] },
          { file: 'b.ts', path: './src/client/b.ts', ops: ['b1'] },
        ],
      },
    ])
  })

  it('orders directories before files, each by the pinned collation', () => {
    const groups = (paths: readonly string[]): Map<string, FileOp[]> =>
      new Map(paths.map(path => [path, [op(`c-${path}`)]]))
    const names = (list: readonly string[]): string[] =>
      buildSessionTree(groups(list)).map(node => node.name)
    expect(names(['Zed.ts', 'B.ts', 'a.ts', 'zdir/f.ts', 'Adir/f.ts']))
      .toEqual(['Adir', 'zdir', 'a.ts', 'B.ts', 'Zed.ts'])
    // …and it is a TOTAL order: reversing the input cannot move a row.
    expect(names([...['Zed.ts', 'B.ts', 'a.ts', 'zdir/f.ts', 'Adir/f.ts']].reverse()))
      .toEqual(names(['Zed.ts', 'B.ts', 'a.ts', 'zdir/f.ts', 'Adir/f.ts']))
  })

  it('counts the touched files beneath every directory row', () => {
    const tree = buildSessionTree(new Map([
      ['src/a.ts', [op('a1')]],
      ['src/inner/deep/c.ts', [op('c1')]],
      ['src/inner/deep/other/d.ts', [op('d1')]],
      ['top.md', [op('t1')]],
    ]))
    // 'inner' holds no file of its own and one child: it compresses into the
    // one 'inner/deep' row, whose pill counts the two files under it — and
    // 'src' sums its own file plus the whole compressed side.
    const src = tree[0]!
    expect(src.kind).toBe('dir')
    expect(src.kind === 'dir' ? src.files : 0).toBe(3)
    const chain = src.kind === 'dir' ? src.children.find(child => child.kind === 'dir')! : null
    expect(chain?.kind).toBe('dir')
    expect(chain?.kind === 'dir' ? chain.name : '').toBe('inner/deep')
    expect(chain?.kind === 'dir' ? chain.files : 0).toBe(2)
  })

  it('never emits a directory without a file', () => {
    const tree = buildSessionTree(new Map([
      ['a/b/c/f.ts', [op('f1')]],
      ['a/other.ts', [op('o1')]],
      ['lonely.md', [op('l1')]],
    ]))
    for (const { node } of walk(tree)) {
      if (node.kind === 'dir') expect(node.files, `dir ${node.path} must hold files`).toBeGreaterThan(0)
    }
  })
})

describe('ancestorDirs', () => {
  it('returns the ancestors shallowest → deepest', () => {
    expect(ancestorDirs('a/b/c/f.ts')).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('normalizes separators and ./ exactly like the tree does', () => {
    expect(ancestorDirs('a\\b/f.ts')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('./a/f.ts')).toEqual(['a'])
  })

  it('answers nothing for a bare file name', () => {
    expect(ancestorDirs('f.ts')).toEqual([])
  })

  it('hits the tree’s compressed chain row and the row that directly holds each file', () => {
    const paths = [
      'a/b/c/deep.ts', // one compressed chain row 'a/b/c'
      'a/other.ts', // keeps 'a' from compressing, so 'a' is a row of its own
      'src/keep.ts',
      'src/branch/inner/x.ts', // 'src/branch' branches → own row
    ]
    const tree = buildSessionTree(new Map(paths.map(path => [path, [op(`c-${path}`)]])))
    for (const { node, container } of walk(tree)) {
      if (node.kind !== 'file') continue
      const ancestors = ancestorDirs(node.path)
      if (ancestors.length === 0) continue
      // Every directory row's path key is spelled EXACTLY as some ancestor
      // string of a file beneath it — the collapsed-set lookup in SessionLens
      // compares these strings verbatim.
      expect(ancestors, `ancestors of ${node.path}`).toContain(container)
      // …and the row DIRECTLY holding the file is the deepest ancestor: a
      // file's own parent never compresses upward (it has the file).
      expect(ancestors.at(-1), `deepest ancestor of ${node.path}`).toBe(container)
    }
    // The compressed-chain case itself: the only dir row is 'a/b/c' and the
    // ancestors of the file under it name that row verbatim.
    const chain = buildSessionTree(new Map([['a/b/c/deep.ts', [op('d1')]]]))
    expect(chain[0]!.kind === 'dir' ? chain[0]!.path : '').toBe('a/b/c')
    expect(ancestorDirs('a/b/c/deep.ts')).toContain('a/b/c')
  })
})
