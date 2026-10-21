/**
 * The round-diff lens component: ONE `git diff <rev>` against the baseline
 * {@link pickRoundDiffBase} picked from the log, the M/A/D/R summary TREE
 * folded from that SAME patch (no second git read; {@link buildRoundDiffTree},
 * the session lens's shape) with a 「查看原文件」 action on every row — a file
 * row opens the file through the tab's `onOpenFile` (resolved against the
 * round's worktree root), a directory row lands on the 「文件」 page with the
 * folder revealed ({@link activateFilesPage}) — the inline DiffFiles
 * rendering (no bottom pane), the empty / not-a-repository / failed states,
 * and the fold handle the tab header drives (summary directories AND the
 * per-file patch folds together). Also pins the DOM contract the lens
 * sheet's group-scroll CSS hooks onto (a DiffFiles file header is an
 * expandable button whose rendered body is its NEXT-SIBLING div — the open
 * action and the summary rows live outside that adjacency), so a DiffFiles
 * DOM drift fails here instead of silently unmounting the rules. The api
 * surface is mocked; no git binary, no host.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RoundDiffLens } from '../src/client/changes/RoundDiffLens.tsx'
import { EMPTY_TREE_HASH } from '../src/client/changes/round-diff.ts'
import type { LensControl } from '../src/client/changes/lens-control.ts'
import { api, type GitLogEntry, type GitWorktree } from '../src/client/api.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import type { Context } from '../src/context-types.ts'
import { t } from '../src/client/locales.ts'
import diffCss from '../src/client/diff/diff.module.css'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'
const NOW = Date.now()

/** One pre-round commit (the baseline the lens must aim the diff at). */
function logEntry(overrides: Partial<GitLogEntry>): GitLogEntry {
  return {
    hash: 'abc1234',
    hashFull: 'abc1234abc1234abc1234abc1234abc1234abc1234',
    subject: 'a commit',
    author: 'Agent',
    date: new Date(NOW - 600_000).toISOString(),
    refs: '',
    ...overrides,
  }
}

/** A two-file patch: one modified source file (open by default) and one new
 *  doc (stays folded — DOC_PATH), so both DiffFiles default states appear. */
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/docs/guide.md b/docs/guide.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/guide.md',
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n')

/** A context fake that answers `betterSidebar` (with an observed openTab) and
 *  the session cwd, so the directory rows' 「查看原文件」 landing (openTab +
 *  reveal) can be asserted. */
function fakeContext(cwd: string | undefined): { ctx: Context; openTab: ReturnType<typeof vi.fn> } {
  const openTab = vi.fn()
  const ctx = {
    get: (name: string) => (name === 'betterSidebar' ? { openTab } : undefined),
    sessions: { list: { getSnapshot: () => ({ byId: { session: { cwd } } }) } },
  } as unknown as Context
  return { ctx, openTab }
}

interface RenderProps {
  roundStart?: number
  ctx?: Context
  store?: SidebarStore
  onOpenFile?: (path: string) => void
  ref?: Ref<LensControl>
}

async function renderLens(props: RenderProps = {}): Promise<{
  container: HTMLElement
  root: Root
  openFile: (path: string) => void
  store: SidebarStore
}> {
  const openFile = props.onOpenFile ?? ((): void => {})
  const store = props.store ?? createSidebarStore()
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(RoundDiffLens, {
      ref: props.ref,
      ctx: props.ctx ?? fakeContext(MAIN).ctx,
      store,
      scope: { sessionId: 'session', cwd: MAIN },
      visible: true,
      roundStart: props.roundStart ?? NOW - 120_000,
      onOpenFile: openFile,
    }))
  })
  // The load chain is log → diff (two awaits): flush a few microtask turns.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
  return { container, root, openFile, store }
}

/** The one summary-row 「查看原文件」 button inside `row`. */
function openButtonOf(row: Element): HTMLButtonElement | null {
  return row.querySelector<HTMLButtonElement>(`button[aria-label="${t('changesViewOriginalFile')}"]`)
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: 0 },
  ] as GitWorktree[])
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('RoundDiffLens', () => {
  it('fetches ONE range diff against the pre-round baseline and lays out the M/A/R summary tree plus the patches', async () => {
    const baseline = logEntry({})
    const inRound = logEntry({ hashFull: 'round0round0round0round0round0round0round0round0', date: new Date(NOW - 10_000).toISOString() })
    const log = vi.spyOn(api, 'gitLog').mockResolvedValue([inRound, baseline])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens({ roundStart: NOW - 120_000 })
    try {
      // The baseline pick asked the log for the touched-files window (50).
      const filesCall = log.mock.calls.find(call => call[5]?.files === true)
      expect(filesCall).toBeDefined()
      expect(filesCall![1]).toBe(50)
      // Exactly ONE diff call, aimed at the NEWEST pre-round commit — not
      // the in-round HEAD.
      expect(diffRange).toHaveBeenCalledTimes(1)
      expect(diffRange.mock.calls[0]![1]).toBe(baseline.hashFull)

      // The summary band is a DIRECTORY tree over the patch's files: one row
      // per directory (born expanded, count pill included), the leaves keep
      // their status badge and show the NAME only (the full path rides the
      // row's identity attribute and title).
      expect(container.querySelector('[data-section="files"]')!.textContent).toContain(t('changesRoundDiffSection'))
      const src = container.querySelector<HTMLButtonElement>('button[data-round-dir="src"]')
      const docs = container.querySelector<HTMLButtonElement>('button[data-round-dir="docs"]')
      expect(src).not.toBeNull()
      expect(docs).not.toBeNull()
      expect(src!.getAttribute('aria-expanded')).toBe('true')
      expect(src!.querySelector('[data-count="1"]')).not.toBeNull()
      const modified = container.querySelector('[data-round-file="src/a.ts"]')
      expect(modified).not.toBeNull()
      expect(modified!.querySelector('[data-tone="modified"]')!.textContent).toBe('M')
      expect(modified!.textContent).toContain('a.ts')
      expect(modified!.textContent).not.toContain('/')
      const added = container.querySelector('[data-round-file="docs/guide.md"]')
      expect(added!.querySelector('[data-tone="added"]')!.textContent).toBe('A')

      // The patches render INLINE through DiffFiles (no bottom pane here):
      // the expanded source file's rows are in this lens's own DOM.
      expect(container.textContent).toContain('new')

      // The CSS hook's DOM contract: inside the DiffFiles document, every
      // expandable file header is a button[aria-expanded] whose RENDERED
      // body is its NEXT-SIBLING div (the changes sheet caps that sibling
      // and sticks the button); a folded header carries no div body (its
      // trailing 「查看原文件」 action may follow instead). The summary rows
      // and their open actions sit OUTSIDE this adjacency on purpose. A
      // DiffFiles DOM drift must fail here, not the styling.
      const headers = [...container.querySelectorAll<HTMLButtonElement>(`.${diffCss.fileBlock} > button[aria-expanded]`)]
      expect(headers).toHaveLength(2)
      for (const header of headers) {
        const sibling = header.nextElementSibling
        if (header.getAttribute('aria-expanded') === 'true') {
          expect(sibling!.tagName, header.textContent ?? '').toBe('DIV')
        } else {
          expect(sibling === null || sibling.tagName !== 'DIV', header.textContent ?? '').toBe(true)
        }
      }
      // The modified source file opened by default (its body exists); the
      // new doc stayed folded (header only).
      const expanded = headers.filter(header => header.getAttribute('aria-expanded') === 'true')
      expect(expanded).toHaveLength(1)
      expect(expanded[0]!.textContent).toContain('src/a.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('aims at the empty tree when every commit sits inside the round', async () => {
    const inRound = logEntry({ date: new Date(NOW - 10_000).toISOString() })
    vi.spyOn(api, 'gitLog').mockResolvedValue([inRound])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens({ roundStart: NOW - 120_000 })
    try {
      expect(diffRange).toHaveBeenCalledTimes(1)
      expect(diffRange.mock.calls[0]![1]).toBe(EMPTY_TREE_HASH)
      expect(container.querySelector('[data-round-file="src/a.ts"]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('answers the empty state without a diff fetch for a repository without commits', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      expect(diffRange).not.toHaveBeenCalled()
      expect(container.textContent).toContain(t('changesRoundDiffEmpty'))
      expect(container.querySelector('[data-round-file]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reads an empty patch as the round empty state', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: '' })

    const { container, root } = await renderLens()
    try {
      expect(container.textContent).toContain(t('changesRoundDiffEmpty'))
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reads a workspace without a repository as notRepo, not as a failure', async () => {
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    const log = vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      expect(container.textContent).toContain(t('notRepo'))
      expect(diffRange).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('surfaces a failed log as the lens error notice', async () => {
    vi.spyOn(api, 'gitLog').mockRejectedValue(new Error('git died'))
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(container.textContent).toContain(t('changesRoundDiffLoadError'))
      expect(diffRange).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('gives every summary row a 查看原文件 action: a file opens it, a directory lands on the 文件 page', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })
    const opened: string[] = []
    const { ctx, openTab } = fakeContext(MAIN)
    const store = createSidebarStore()
    store.setSession('session')

    const { container, root } = await renderLens({ ctx, store, onOpenFile: (path) => { opened.push(path) } })
    try {
      // Every row carries the action, without folding anything.
      const fileRow = container.querySelector('[data-round-file="src/a.ts"]')!
      const dirRow = container.querySelector('button[data-round-dir="src"]')!
      const fileOpen = openButtonOf(fileRow)
      const dirOpen = openButtonOf(dirRow.parentElement!)
      expect(fileOpen).not.toBeNull()
      expect(dirOpen).not.toBeNull()

      // The FILE action resolves the repo-relative patch path against the
      // round's worktree root and hands the ABSOLUTE path to the tab's open.
      act(() => { fileOpen!.click() })
      expect(opened).toEqual(['C:/repo/main/src/a.ts'])
      // The patches kept their default fold states (no header toggled).
      expect(container.querySelector(`.${diffCss.fileBlock} > button[aria-expanded="true"]`)!.textContent).toContain('src/a.ts')

      // The DIRECTORY action activates the 「文件」 page (the path-less
      // editor open) and reveals the folder in its tree — the absolute
      // folder path lands in the store's reveal set.
      expect(store.getSnapshot().state?.revealed ?? []).toEqual([])
      act(() => { dirOpen!.click() })
      expect(openTab).toHaveBeenCalledWith({ type: 'editor' }, { sessionId: 'session' })
      expect(store.getSnapshot().state?.revealed).toEqual(['C:/repo/main/src'])
      // The action is not the disclosure: the directory row stayed open.
      expect(dirRow.getAttribute('aria-expanded')).toBe('true')
      expect(container.querySelector('[data-round-file="src/a.ts"]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('folds and unfolds a summary directory without disturbing the sibling branch', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      const src = container.querySelector<HTMLButtonElement>('button[data-round-dir="src"]')!
      const docs = container.querySelector<HTMLButtonElement>('button[data-round-dir="docs"]')!
      expect(container.querySelector('[data-round-file="src/a.ts"]')).not.toBeNull()

      // Folding the directory hides its whole subtree; the sibling stays.
      act(() => { src.click() })
      expect(src.getAttribute('aria-expanded')).toBe('false')
      expect(container.querySelector('[data-round-file="src/a.ts"]')).toBeNull()
      expect(container.querySelector('[data-round-file="docs/guide.md"]')).not.toBeNull()
      expect(docs.getAttribute('aria-expanded')).toBe('true')

      // Unfolding brings the leaf back.
      act(() => { src.click() })
      expect(container.querySelector('[data-round-file="src/a.ts"]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('drives BOTH fold axes from the handle: summary directories and the patch headers', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })
    const ref = createRef<LensControl>()

    const { container, root } = await renderLens({ ref })
    try {
      const headers = (): HTMLButtonElement[] =>
        [...container.querySelectorAll<HTMLButtonElement>(`.${diffCss.fileBlock} > button[aria-expanded]`)]
      const dirRow = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>('button[data-round-dir="docs"]')

      // 全部收起: every summary directory folds AND every patch header closes
      // — including the one the source-open defaults had expanded.
      act(() => { ref.current!.collapseAll() })
      expect(dirRow()!.getAttribute('aria-expanded')).toBe('false')
      expect(container.querySelector('[data-round-file]')).toBeNull()
      expect(headers().map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
      expect(container.textContent).not.toContain('new')

      // 全部展开: both axes come back open (the born states).
      act(() => { ref.current!.expandAll() })
      expect(dirRow()!.getAttribute('aria-expanded')).toBe('true')
      expect(container.querySelector('[data-round-file="docs/guide.md"]')).not.toBeNull()
      expect(headers().map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
      expect(container.textContent).toContain('new')
      expect(container.textContent).toContain('hello')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
