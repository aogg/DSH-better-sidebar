/**
 * 移除回归锁：文件页（TreePanel）不再持有「文本内容搜索」。该折叠区已整体
 * 迁往独立「搜索」页（SearchView，type: 'search'，docs/plans/2026-10-21
 * -find-in-files-page.md §6.1），这里钉住三件事：
 *
 * - TreePanel 不再渲染任何 content-search 锚点（toggle / panel / 结果分支
 *   的 data-dsh-content-search-* 与占位文案都已消失），挂载与使用全程绝不
 *   调用 fsContentSearch；
 * - 文件名搜索逐字未动：300ms 防抖、fs.search、结果区与截断提示照旧；
 * - 「添加到搜索中」只以 onAddToSearch 透传（回调语义见
 *   file-tree-add-to-search.spec.tsx / editor-host.spec.tsx）。
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'
// Type-only: gives the mocked fns the REAL api signatures, so `mock.calls`
// entries stay typed (the same trick the other tree specs use).
import type { api } from '../src/client/api.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the panel's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

interface Listing {
  path: string
  entries: { name: string; path: string; isDir: boolean }[]
  truncated: boolean
}

function defaultListing(path: string): Listing {
  return { path, entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }], truncated: false }
}

const { fsTrees, fsSearch, fsContentSearch } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => defaultListing(path)) })),
  fsSearch: vi.fn<typeof api.fsSearch>(async () =>
    ({ matches: [], dirs: [], truncated: false })),
  fsContentSearch: vi.fn<typeof api.fsContentSearch>(async () =>
    ({ matches: [], truncated: false })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsSearch,
    // The removal lock's whole point: this must never be touched again.
    fsContentSearch,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

function mountPanel(overrides: Partial<ComponentProps<typeof TreePanel>> = {}): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TreePanel, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      ...overrides,
    }))
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The file-name search input (the ONLY search input the panel still has). */
function nameInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!
}

/** The results region body (the explorer body that is NOT the file tree). */
function resultsBody(container: HTMLElement): HTMLElement {
  const tree = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el.querySelector('[class*="explorerName"]') !== null)
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el !== tree)
  if (body === undefined) throw new Error('results body not mounted')
  return body
}

async function typeName(container: HTMLElement, value: string): Promise<void> {
  const input = nameInput(container)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The name search debounces 300ms — wait past it.
  await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, 350) }) })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  fsTrees.mockReset()
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({ levels: paths.map(path => defaultListing(path)) }))
  fsSearch.mockReset()
  fsSearch.mockImplementation(async () => ({ matches: [], dirs: [], truncated: false }))
  fsContentSearch.mockReset()
  fsContentSearch.mockImplementation(async () => ({ matches: [], truncated: false }))
})

describe('文件页内容搜索移除回归锁', () => {
  it('renders no content-search anchor, panel, or copy — at rest and while searching', async () => {
    harness = mountPanel()
    await act(async () => {})
    expect(harness.container.querySelectorAll('[data-dsh-content-search-toggle]')).toHaveLength(0)
    expect(harness.container.querySelectorAll('[data-dsh-content-search-panel]')).toHaveLength(0)
    expect(harness.container.querySelectorAll('[data-dsh-content-search-]')).toHaveLength(0)
    // Any data-dsh-content-search-* attribute at all is a regression.
    expect([...harness.container.querySelectorAll('*')]
      .some(el => [...el.attributes].some(attr => attr.name.startsWith('data-dsh-content-search')))).toBe(false)
    // The migrated copy is gone from the files window.
    expect(harness.container.textContent).not.toContain('Search in file contents')
    expect(harness.container.textContent).not.toContain('Include: dir, file or glob')
    expect(harness.container.textContent).not.toContain('Exclude: dir, file or glob')
    // And using the window never touches the content-search route.
    await typeName(harness.container, 'a')
    expect(fsSearch).toHaveBeenCalledTimes(1)
    expect(fsContentSearch).not.toHaveBeenCalled()
  })

  it('the file-name search is verbatim what it was: debounce, results, truncation copy', async () => {
    fsSearch.mockResolvedValue({ matches: ['src/a.ts'], dirs: [], truncated: true })
    const onOpenFile = vi.fn()
    harness = mountPanel({ onOpenFile })
    await act(async () => {})
    // Typing waits for the debounce — a commit-per-keystroke search would
    // already have fired here.
    expect(fsSearch).not.toHaveBeenCalled()
    await typeName(harness.container, 'a')
    expect(fsSearch).toHaveBeenCalledTimes(1)
    const [scope, query] = fsSearch.mock.calls[0]!
    expect(scope).toEqual({ sessionId: 's1', cwd: '/tmp' })
    expect(query).toBe('a')
    // The results region shows the name rows and the truncation hint.
    const body = resultsBody(harness.container)
    expect(body.textContent).toContain('src/a.ts')
    expect(body.textContent).toContain('Too many results')
    // A row opens its file like before.
    const row = body.querySelector<HTMLButtonElement>('button[class*="editorSearchResult"]')!
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/src/a.ts')
    expect(fsContentSearch).not.toHaveBeenCalled()
  })

  it('clearing the name query returns to the tree with nothing left over', async () => {
    fsSearch.mockResolvedValue({ matches: ['src/a.ts'], dirs: [], truncated: false })
    harness = mountPanel()
    await act(async () => {})
    await typeName(harness.container, 'a')
    expect(resultsBody(harness.container).textContent).toContain('src/a.ts')
    await typeName(harness.container, '')
    expect(fsSearch).toHaveBeenCalledTimes(1) // an empty needle never fires
    expect(resultsBody(harness.container).getAttribute('hidden')).not.toBeNull()
    expect(fsContentSearch).not.toHaveBeenCalled()
  })
})
