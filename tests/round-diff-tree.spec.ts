/**
 * The round-diff summary tree module ({@link buildRoundDiffTree}): the flat
 * parsed patch rows fold into the directory tree the lens renders —
 * directories before files, a single-child chain read as one `a/b/c` row,
 * the pinned case-insensitive collation, repeated paths counted once, empty
 * input in empty output — plus {@link dirPathsOf}, the row-path collector
 * 「全部收起」 fills the collapsed-set with (a compressed chain contributes
 * its own row path only).
 */
import { describe, expect, it } from 'vitest'
import { buildRoundDiffTree, dirPathsOf, type RoundDiffDir, type RoundDiffFile, type RoundDiffNode } from '../src/client/changes/round-diff-tree.ts'
import type { CommitFile } from '../src/client/changes/round-commits.ts'

/** One parsed patch row. */
function file(path: string, status = 'M'): CommitFile {
  return { path, status }
}

/** Narrow one node to a directory row (a leaf here is a bug worth naming). */
function asDir(node: RoundDiffNode): RoundDiffDir {
  if (node.kind !== 'dir') throw new Error(`expected a directory row, got a ${node.kind}`)
  return node
}

/** Narrow one node to a file leaf. */
function asFile(node: RoundDiffNode): RoundDiffFile {
  if (node.kind !== 'file') throw new Error(`expected a file leaf, got a ${node.kind}`)
  return node
}

describe('buildRoundDiffTree', () => {
  it('folds nested paths into directories first, files below, name-sorted case-insensitively', () => {
    const tree = buildRoundDiffTree([
      file('src/Beta.ts'),
      file('src/alpha.ts'),
      file('docs/guide.md', 'A'),
    ])
    // Two roots, directories first, then by name.
    expect(tree.map(node => node.kind)).toEqual(['dir', 'dir'])
    expect(tree.map(node => node.name)).toEqual(['docs', 'src'])
    const src = asDir(tree[1]!)
    expect(src.path).toBe('src')
    expect(src.files).toBe(2)
    // Within a level: base-sensitivity collation, code-point tiebreak.
    expect(src.children.map(child => child.name)).toEqual(['alpha.ts', 'Beta.ts'])
    // The leaves keep the patch's own spelling and status letter.
    expect(asFile(src.children[0]!)).toMatchObject({ kind: 'file', path: 'src/alpha.ts', status: 'M' })
    expect(asFile(asDir(tree[0]!).children[0]!)).toMatchObject({ kind: 'file', path: 'docs/guide.md', status: 'A' })
  })

  it('compresses a single-child chain into one a/b/c row that carries the leaf count', () => {
    const tree = buildRoundDiffTree([file('a/b/c/deep.ts')])
    expect(tree).toHaveLength(1)
    const chain = asDir(tree[0]!)
    expect(chain.name).toBe('a/b/c')
    expect(chain.path).toBe('a/b/c')
    expect(chain.files).toBe(1)
    expect(chain.children.map(child => child.kind)).toEqual(['file'])
  })

  it('keeps a directory row where a file sits beside the chain', () => {
    const tree = buildRoundDiffTree([file('a/keep.ts'), file('a/b/c/deep.ts')])
    const a = asDir(tree[0]!)
    expect(a.name).toBe('a')
    expect(a.path).toBe('a')
    // One compressed chain row below 'a' ('b/c'), plus the file.
    expect(a.children.map(child => child.name)).toEqual(['b/c', 'keep.ts'])
  })

  it('counts a repeated path once and normalizes separators and dot segments for its rows', () => {
    const tree = buildRoundDiffTree([
      file('src/a.ts'),
      file('src/./a.ts'),
      file('src\\nested\\b.ts'),
    ])
    const src = asDir(tree[0]!)
    expect(src.children).toHaveLength(2)
    expect(src.children.map(child => child.name)).toEqual(['a.ts', 'nested'])
    const nested = asDir(src.children[1]!)
    expect(nested.path).toBe('src/nested')
  })

  it('answers an empty list with an empty tree', () => {
    expect(buildRoundDiffTree([])).toEqual([])
  })
})

describe('dirPathsOf', () => {
  it('lists every directory row path, parents before children, row spellings only', () => {
    const tree = buildRoundDiffTree([
      file('a/keep.ts'),
      file('a/b/c/deep.ts'),
      file('docs/guide.md'),
    ])
    // 'a/b' has no row (swallowed by the 'a/b/c' chain): only real rows list.
    expect(dirPathsOf(tree)).toEqual(['a', 'a/b/c', 'docs'])
  })

  it('answers an empty tree with an empty list', () => {
    expect(dirPathsOf(buildRoundDiffTree([]))).toEqual([])
  })
})
