/**
 * The tree panel's content-search section (「文本内容搜索」) over the mock
 * api: the permanent toggle row expands the keyword input plus the
 * include/exclude chip lists, Enter commits (the name query is cleared —
 * the two searches share ONE results region), chips add/remove, a result
 * row opens its file, the truncation hint reuses the name-search copy, and
 * collapsing closes back to the file tree.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TreePanel } from '../src/client/TreePanel.tsx'

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
  fsSearch: vi.fn(async (): Promise<{ matches: string[]; dirs: string[]; truncated: boolean }> =>
    ({ matches: [], dirs: [], truncated: false })),
  fsContentSearch: vi.fn(async (): Promise<{ matches: string[]; truncated: boolean }> =>
    ({ matches: ['src/a.ts'], truncated: false })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsSearch,
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

function toggleButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-dsh-content-search-toggle]')!
}

function panel(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-dsh-content-search-panel]')!
}

/** Type into one of the panel's inputs (by placeholder) and fire the event. */
async function type(container: HTMLElement, placeholder: string, value: string): Promise<void> {
  const input = [...panel(container).querySelectorAll<HTMLInputElement>('input')]
    .find(el => el.placeholder === placeholder)!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function resultsBody(container: HTMLElement): HTMLElement {
  const tree = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el.querySelector('[class*="explorerName"]') !== null)
  const body = [...container.querySelectorAll<HTMLElement>('div[class*="explorerBody"]')]
    .find(el => el !== tree)
  if (body === undefined) throw new Error('results body not mounted')
  return body
}

/** The keyword input (the first one inside the expanded panel). */
function keywordInput(container: HTMLElement): HTMLInputElement {
  return panel(container).querySelector<HTMLInputElement>('input')!
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
  fsContentSearch.mockImplementation(async () => ({ matches: ['src/a.ts'], truncated: false }))
})

describe('TreePanel content search', () => {
  it('starts collapsed, expands to the panel, and runs on Enter with no debounce', async () => {
    harness = mountPanel()
    await act(async () => {})
    expect(toggleButton(harness.container).getAttribute('aria-expanded')).toBe('false')
    expect(panel(harness.container)).toBeNull()
    expect(fsContentSearch).not.toHaveBeenCalled()

    await click(toggleButton(harness.container))
    expect(toggleButton(harness.container).getAttribute('aria-expanded')).toBe('true')

    await type(harness.container, 'Search in file contents (Enter to run)…', 'answer')
    expect(fsContentSearch).not.toHaveBeenCalled() // no debounce: Enter commits
    await pressEnter(keywordInput(harness.container))
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    const [scope, query, include, exclude] = fsContentSearch.mock.calls[0]!
    expect(scope).toEqual({ sessionId: 's1', cwd: '/tmp' })
    expect(query).toBe('answer')
    expect(include).toEqual([])
    expect(exclude).toEqual([])
    // The results region shows the content rows.
    expect(resultsBody(harness.container).textContent).toContain('src/a.ts')
  })

  it('adds and removes include/exclude chips and sends them along', async () => {
    harness = mountPanel()
    await act(async () => {})
    await click(toggleButton(harness.container))

    await type(harness.container, 'Include: dir, file or glob — Enter to add', 'src')
    await pressEnter([...panel(harness.container).querySelectorAll<HTMLInputElement>('input')]
      .find(el => el.placeholder.startsWith('Include'))!)
    await type(harness.container, 'Include: dir, file or glob — Enter to add', '*.log')
    await pressEnter([...panel(harness.container).querySelectorAll<HTMLInputElement>('input')]
      .find(el => el.placeholder.startsWith('Include'))!)
    await type(harness.container, 'Exclude: dir, file or glob — Enter to add', '*.md')
    await pressEnter([...panel(harness.container).querySelectorAll<HTMLInputElement>('input')]
      .find(el => el.placeholder.startsWith('Exclude'))!)

    const chips = [...panel(harness.container).querySelectorAll<HTMLElement>('span[class*="contentChip"]')]
    expect(chips.map(chip => chip.textContent)).toEqual(['src×', '*.log×', '*.md×'])

    await type(harness.container, 'Search in file contents (Enter to run)…', 'answer')
    await pressEnter(keywordInput(harness.container))
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    const [, , include, exclude] = fsContentSearch.mock.calls[0]!
    expect(include).toEqual(['src', '*.log'])
    expect(exclude).toEqual(['*.md'])

    // The × removes exactly its own chip.
    await click(chips[1]!.querySelector('button')!)
    const remaining = [...panel(harness.container).querySelectorAll<HTMLElement>('span[class*="contentChip"]')]
    expect(remaining.map(chip => chip.textContent)).toEqual(['src×', '*.md×'])
    await type(harness.container, 'Search in file contents (Enter to run)…', 'answer')
    await pressEnter(keywordInput(harness.container))
    expect(fsContentSearch).toHaveBeenCalledTimes(2)
    expect(fsContentSearch.mock.calls[1]![2]).toEqual(['src'])
  })

  it('clears the name query when the content search runs, and vice versa', async () => {
    harness = mountPanel()
    await act(async () => {})
    await click(toggleButton(harness.container))
    await type(harness.container, 'Search in file contents (Enter to run)…', 'answer')
    await pressEnter(keywordInput(harness.container))
    expect(resultsBody(harness.container).textContent).toContain('src/a.ts')

    // Typing a NAME query retires the content search (its results vanish).
    const nameInput = harness.container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(nameInput, 'a')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, 350) }) })
    expect(fsSearch).toHaveBeenCalledTimes(1)
    expect(resultsBody(harness.container).textContent).not.toContain('src/a.ts')
  })

  it('opens a content hit like a name-search file row and reuses the truncation copy', async () => {
    fsContentSearch.mockResolvedValue({ matches: ['src/a.ts', 'docs/guide.md'], truncated: true })
    const onOpenFile = vi.fn()
    harness = mountPanel({ onOpenFile })
    await act(async () => {})
    await click(toggleButton(harness.container))
    await type(harness.container, 'Search in file contents (Enter to run)…', 'answer')
    await pressEnter(keywordInput(harness.container))

    const rows = [...resultsBody(harness.container).querySelectorAll<HTMLButtonElement>('button[class*="editorSearchResult"]')]
    expect(rows.map(row => row.textContent)).toEqual(['src/a.ts', 'docs/guide.md'])
    // No directory rows: a content hit is always a file.
    expect(rows.every(row => row.getAttribute('data-dsh-search-dir') === null)).toBe(true)
    await click(rows[0]!)
    expect(onOpenFile).toHaveBeenCalledWith('/tmp/src/a.ts')
    expect(resultsBody(harness.container).textContent).toContain('Too many results')
  })

  it('closing the section clears the query and returns to the file tree', async () => {
    harness = mountPanel()
    await act(async () => {})
    await click(toggleButton(harness.container))
    await type(harness.container, 'Search in file contents (Enter to run)…', 'answer')
    await pressEnter(keywordInput(harness.container))
    expect(resultsBody(harness.container).getAttribute('hidden')).toBeNull()

    await click(toggleButton(harness.container))
    expect(resultsBody(harness.container).hasAttribute('hidden')).toBe(true)
    expect(panel(harness.container)).toBeNull()
    // The committed query is gone: reopening and re-running starts fresh.
    await click(toggleButton(harness.container))
    expect(keywordInput(harness.container).value).toBe('')
  })
})
