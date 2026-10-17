// @vitest-environment jsdom
/**
 * The session lens's DIRECTORY tree layer (src/client/changes/SessionLens.tsx),
 * rendered directly with hand-built props. The tab-level smoke — the lens
 * switch and the mere existence of the dir/file rows — lives in
 * changes-tab.spec.tsx; this spec pins the fold mechanics the tree itself
 * adds: directory rows start expanded and fold on click, a single-child chain
 * reads as one `a/b/c` row, the file header names the file only (the full
 * path rides the title), the FOLDED header badges every distinct op kind the
 * group contains (edit→write→read, deduplicated), a preview selection
 * re-opens its own collapsed chain, and a kind filter removes emptied
 * branches whole.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { SessionLens } from '../src/client/changes/SessionLens.tsx'
import type { FileOp, FileOpKind } from '../src/client/changes/ops.ts'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()

let seq = 0

/** One settled op with a stable id, as the tab's fold would hand it over. */
function op(kind: FileOpKind, path: string, time = 1_700_000_000_000): FileOp {
  seq += 1
  return { callId: `call-${seq}`, kind, path, time, running: false, isError: false }
}

/** Render the lens over `ops` (newest first) and expose the preview spy. */
function renderLens(ops: readonly FileOp[], selectedCallId: string | null = null): RenderedRoot & {
  onPreview: ReturnType<typeof vi.fn>
} {
  const onPreview = vi.fn()
  const view = renderRoot(createElement(SessionLens, {
    ops,
    loadError: false,
    onPreview,
    selectedCallId,
  }))
  return { ...view, onPreview }
}

const dirRow = (container: HTMLElement, path: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[data-dir-group="${path}"]`)

const fileHead = (container: HTMLElement, path: string): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(`button[data-file-head="${path}"]`)

/** The one filter chip whose label is `label` (all/op-kind chips of the lens). */
function chip(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    .find(button => (button.textContent ?? '').includes(label)) ?? null
}

/** One user click, flushed through act() like the other component specs. */
const click = (button: HTMLButtonElement): void => {
  act(() => { button.click() })
}

/** The count pill of one directory row (the button carries no attributes). */
const countPill = (row: HTMLButtonElement): HTMLElement | null => row.querySelector<HTMLElement>('[data-count]')

describe('SessionLens directory tree', () => {
  it('renders every directory row expanded by default and folds/unfolds one on click', () => {
    const ops = [
      op('write', 'src/client/changes/a.ts'),
      op('edit', 'src/client/changes/b.ts'),
      op('read', 'docs/guide.md'),
    ]
    const view = renderLens(ops)
    try {
      const src = dirRow(view.container, 'src/client/changes')
      const docs = dirRow(view.container, 'docs')
      expect(src).not.toBeNull()
      expect(docs).not.toBeNull()
      // Born open (the collapsed set starts empty) and carrying its pill.
      expect(src!.getAttribute('aria-expanded')).toBe('true')
      expect(countPill(src!)!.getAttribute('data-count')).toBe('2')
      expect(countPill(docs!)!.getAttribute('data-count')).toBe('1')
      expect(fileHead(view.container, 'src/client/changes/a.ts')).not.toBeNull()

      // Folding the directory hides its whole subtree — the sibling branch
      // keeps its own state.
      click(src!)
      expect(src!.getAttribute('aria-expanded')).toBe('false')
      expect(fileHead(view.container, 'src/client/changes/a.ts')).toBeNull()
      expect(fileHead(view.container, 'src/client/changes/b.ts')).toBeNull()
      expect(docs!.getAttribute('aria-expanded')).toBe('true')
      expect(fileHead(view.container, 'docs/guide.md')).not.toBeNull()

      // Unfolding brings the rows back.
      click(src!)
      expect(src!.getAttribute('aria-expanded')).toBe('true')
      expect(fileHead(view.container, 'src/client/changes/b.ts')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('reads a single-child chain as one a/b/c row and titles the file row with the full path', () => {
    const ops = [op('write', 'a/b/c/deep.ts')]
    const view = renderLens(ops)
    try {
      // Exactly one directory row — the compressed chain — standing over the
      // one file.
      const rows = [...view.container.querySelectorAll<HTMLButtonElement>('button[data-dir-group]')]
      expect(rows.map(row => row.getAttribute('data-dir-group'))).toEqual(['a/b/c'])
      // The label IS the chain: one row, not three nested ones.
      expect(rows[0]!.textContent).toContain('a/b/c')
      expect(rows[0]!.querySelector('[data-count="1"]')).not.toBeNull()

      // The file row shows the NAME only; the full path rides the title.
      const head = fileHead(view.container, 'a/b/c/deep.ts')
      expect(head).not.toBeNull()
      expect(head!.getAttribute('title')).toBe('a/b/c/deep.ts')
      expect(head!.textContent).toContain('deep.ts')
      expect(head!.textContent).not.toContain('/')
    } finally {
      view.unmount()
    }
  })

  it('badges every distinct op kind on a folded file header, edit before read', () => {
    // The f1fa85ec regression shape: a subagent edits Backend.php, the main
    // session later READS the same path (newest first below). The folded
    // header used to badge only the newest op's kind — a lone 读取 pill that
    // hid the edits under the 全部 filter. One badge per occurred kind, fixed
    // edit→write→read order, keeps the summary truthful.
    const editOp = op('edit', 'src/app/Backend.php')
    const readOp = op('read', 'src/app/Backend.php')
    const view = renderLens([readOp, editOp])
    try {
      const head = fileHead(view.container, 'src/app/Backend.php')!
      const badges = [...head.querySelectorAll<HTMLElement>('[data-tone]')]
      expect(badges.map(badge => badge.getAttribute('data-tone'))).toEqual(['edit', 'read'])
      expect(badges.map(badge => badge.textContent)).toEqual([t('changesEdit'), t('changesRead')])
    } finally {
      view.unmount()
    }
  })

  it('deduplicates the folded badges when one kind repeats in the group', () => {
    // Two edits + one read: still exactly one 编辑 badge and one 读取 badge.
    const editOp = op('edit', 'src/app/Index.php')
    const secondEdit = op('edit', 'src/app/Index.php', 1_700_000_000_001)
    const readOp = op('read', 'src/app/Index.php', 1_700_000_000_002)
    const view = renderLens([readOp, secondEdit, editOp])
    try {
      const head = fileHead(view.container, 'src/app/Index.php')!
      const kinds = [...head.querySelectorAll<HTMLElement>('[data-tone]')]
        .map(badge => badge.getAttribute('data-tone'))
      expect(kinds).toEqual(['edit', 'read'])
      // The count pill still reports the whole group (3 ops).
      expect(head.querySelector('[data-op-count="3"]')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('previews the clicked op row with the file’s own path', () => {
    const first = op('edit', 'src/a.ts', 1_700_000_000_000)
    const second = op('write', 'src/a.ts', 1_700_000_000_001)
    const view = renderLens([second, first])
    try {
      const head = fileHead(view.container, 'src/a.ts')!
      click(head)
      const rows = [...view.container.querySelectorAll<HTMLButtonElement>('button[data-op-kind]')]
      expect(rows.map(row => row.getAttribute('data-op-kind'))).toEqual(['write', 'edit'])
      expect(rows[1]!.getAttribute('data-op-error')).toBeNull()

      click(rows[1]!)
      expect(view.onPreview).toHaveBeenCalledTimes(1)
      expect(view.onPreview).toHaveBeenCalledWith('src/a.ts', expect.objectContaining({ callId: first.callId }))
    } finally {
      view.unmount()
    }
  })

  it('re-opens the collapsed chain above a previewed op, and the op’s own folded file', () => {
    const deep = op('edit', 'a/b/c/deep.ts')
    const ops = [op('write', 'a/other.ts'), deep]
    const view = renderLens(ops)
    try {
      // Collapse BOTH ancestor rows of the folded file ('a' keeps its own row
      // because of other.ts; the chain below it is 'a/b/c') — the inner row
      // first, since folding 'a' unmounts it.
      const head = fileHead(view.container, 'a/b/c/deep.ts')!
      const chainRow = dirRow(view.container, 'a/b/c')!
      click(chainRow)
      click(dirRow(view.container, 'a')!)
      expect(head.getAttribute('aria-expanded')).toBe('false')
      expect(dirRow(view.container, 'a')!.getAttribute('aria-expanded')).toBe('false')
      // The chain row itself is unmounted with 'a'; its detached node keeps
      // the folded state this assertion reads back.
      expect(chainRow.getAttribute('aria-expanded')).toBe('false')

      // The selection lands inside the folded file: the group AND every
      // directory above it come back on their own — keyed by the tree's
      // compressed chain path, which ancestorDirs() names verbatim.
      view.rerender(createElement(SessionLens, { ops, loadError: false, onPreview: () => {}, selectedCallId: deep.callId }))
      expect(dirRow(view.container, 'a')!.getAttribute('aria-expanded')).toBe('true')
      expect(dirRow(view.container, 'a/b/c')!.getAttribute('aria-expanded')).toBe('true')
      expect(fileHead(view.container, 'a/b/c/deep.ts')!.getAttribute('aria-expanded')).toBe('true')
      expect(view.container.querySelector('button[data-op-kind="edit"]')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('removes a branch emptied by a kind filter whole, and restores it on the way back', () => {
    const ops = [op('write', 'src/a.ts'), op('read', 'docs/guide.md')]
    const view = renderLens(ops)
    try {
      expect(dirRow(view.container, 'src')).not.toBeNull()
      expect(dirRow(view.container, 'docs')).not.toBeNull()

      // Reads only: the write-only branch disappears ENTIRELY — no empty
      // directory shell stays behind.
      click(chip(view.container, t('changesRead'))!)
      expect(dirRow(view.container, 'src')).toBeNull()
      expect(fileHead(view.container, 'src/a.ts')).toBeNull()
      expect(dirRow(view.container, 'docs')).not.toBeNull()
      expect(fileHead(view.container, 'docs/guide.md')).not.toBeNull()

      // Writes only: the mirror image.
      click(chip(view.container, t('changesWrite'))!)
      expect(dirRow(view.container, 'docs')).toBeNull()
      expect(dirRow(view.container, 'src')).not.toBeNull()

      // Back to all: both branches return.
      click(chip(view.container, t('changesFilterAll'))!)
      expect(dirRow(view.container, 'src')).not.toBeNull()
      expect(dirRow(view.container, 'docs')).not.toBeNull()
    } finally {
      view.unmount()
    }
  })
})
