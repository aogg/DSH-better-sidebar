/**
 * The file tree's「添加到搜索中」context-menu chain. FileTree only REPORTS:
 * a right-clicked row (file or directory, absolute path) plus the picked
 * list (`include` / `exclude`) — behind an optional `onAddToContentSearch`
 * prop whose absence hides the whole submenu (the open-with contract).
 * TreePanel owns the chip lists: its `addToContentSearch` turns the row into
 * the cwd-relative chip (`relativeTo`; a path outside the cwd passes
 * through unchanged as an absolute entry), appends it deduped into the
 * matching list, force-expands the content-search section — and touches
 * nothing else: no content search is started, a live name search keeps
 * owning the results region, and the committed queries / drafts survive.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { TreePanel } from '../src/client/TreePanel.tsx'
// Type-only: gives the mocked fsContentSearch fn the REAL api signature, so
// `mock.calls` entries stay typed (the same trick the content-search spec uses).
import type { api } from '../src/client/api.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu and panel copy are English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

interface Entry {
  name: string
  path: string
  isDir: boolean
}

/** The one-level listing every harness sees: a directory and a file. */
const DEFAULT_ROOT: Entry[] = [
  { name: 'sub', path: '/tmp/sub', isDir: true },
  { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
]

const { fsTrees, fsSearch, fsContentSearch } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, _paths: readonly string[]) => ({ levels: [] as unknown[] })),
  fsSearch: vi.fn(async (): Promise<{ matches: string[]; dirs: string[]; truncated: boolean }> =>
    ({ matches: [], dirs: [], truncated: false })),
  fsContentSearch: vi.fn<typeof api.fsContentSearch>(async () =>
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

/** (Re)arm the root listing: the requested cwd level answers `root` verbatim. */
function installListings(root: Entry[]): void {
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({ path, entries: path === '/tmp' ? root : [] as Entry[], truncated: false })),
  }))
}

installListings(DEFAULT_ROOT)

// ── Shared context-menu helpers (the open-with spec's harness shape) ──────

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

/** The one submenu parent carrying exactly this label. */
function submenuParent(label: string): HTMLElement {
  const parent = menuItems().find(item =>
    item.getAttribute('aria-haspopup') === 'menu' && item.textContent?.trim() === label)
  if (parent === undefined) throw new Error(`submenu parent not found: ${label}`)
  return parent
}

function submenuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
}

/** The tree row (file or directory) printing exactly this name. */
function rowOf(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** Open the row's context menu at a fixed cursor position. */
function openMenuOn(container: HTMLElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowOf(container, name).dispatchEvent(event) })
}

/** Right-click the row, open the Add-to-Search submenu, click one child. */
function addToSearch(container: HTMLElement, rowName: string, childLabel: string): void {
  openMenuOn(container, rowName)
  act(() => { submenuParent('Add to Search').click() })
  const child = submenuRows().find(item => item.textContent?.trim() === childLabel)
  if (child === undefined) throw new Error(`submenu child not found: ${childLabel}`)
  act(() => { child.click() })
}

// ── FileTree: the submenu reports the row and the picked list ────────────

interface TreeHarness {
  container: HTMLDivElement
  onAdd: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(overrides: {
  onAddToContentSearch?: (path: string, target: 'include' | 'exclude') => void
} = {}): Promise<TreeHarness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onAdd = vi.fn()
  // Property-presence semantics: an explicit `onAddToContentSearch: undefined`
  // must reach FileTree (the submenu hides) instead of falling back.
  const wired = Object.prototype.hasOwnProperty.call(overrides, 'onAddToContentSearch')
    ? overrides.onAddToContentSearch
    : onAdd
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
      onAddToContentSearch: wired,
    }))
    await Promise.resolve()
  })
  return {
    container,
    onAdd,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('FileTree add-to-search submenu', () => {
  let harness: TreeHarness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-dsh-sidebar-submenu')
    fsTrees.mockReset()
    installListings(DEFAULT_ROOT)
  })

  it('offers the submenu on a file row with the include/exclude children', async () => {
    harness = await mountTree()
    openMenuOn(harness.container, 'a.ts')
    // The parent row copies the open-with label contract: the primitives Menu
    // draws no chevron for submenu parents, so the trailing arrow rides inside
    // the label (the same openWithLabel/openWithChevron structure).
    const parent = submenuParent('Add to Search')
    expect(parent.querySelector('[class*="openWithChevron"]')).not.toBeNull()
    expect(parent.querySelector('[class*="openWithLabel"]')).not.toBeNull()
    act(() => { parent.click() })
    expect(submenuRows().map(item => item.textContent?.trim())).toEqual(['Add to Include', 'Add to Exclude'])
  })

  it('reports the file row path with the picked list and closes the menu', async () => {
    harness = await mountTree()
    addToSearch(harness.container, 'a.ts', 'Add to Include')
    expect(harness.onAdd).toHaveBeenCalledTimes(1)
    expect(harness.onAdd).toHaveBeenCalledWith('/tmp/a.ts', 'include')
    // Selecting closes the row menu entirely.
    expect(menuItems()).toHaveLength(0)
  })

  it('offers the same submenu on a directory row and reports the directory path', async () => {
    harness = await mountTree()
    addToSearch(harness.container, 'sub', 'Add to Exclude')
    expect(harness.onAdd).toHaveBeenCalledTimes(1)
    expect(harness.onAdd).toHaveBeenCalledWith('/tmp/sub', 'exclude')
    expect(menuItems()).toHaveLength(0)
  })

  it('hides the whole submenu when the caller wires no callback', async () => {
    harness = await mountTree({ onAddToContentSearch: undefined })
    openMenuOn(harness.container, 'a.ts')
    expect(menuItems().some(item => item.textContent?.includes('Add to Search'))).toBe(false)
    expect(menuItems().some(item => item.getAttribute('aria-haspopup') === 'menu')).toBe(false)
  })
})

// ── TreePanel: the callback lands the chip and touches nothing else ──────

interface PanelHarness {
  container: HTMLDivElement
  unmount: () => void
}

function mountPanel(overrides: Partial<ComponentProps<typeof TreePanel>> = {}): PanelHarness {
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

function panel(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-dsh-content-search-panel]')
}

/** Type into one of the panel's inputs (by placeholder) and fire the event. */
async function type(container: HTMLElement, placeholder: string, value: string): Promise<void> {
  const input = [...panel(container)!.querySelectorAll<HTMLInputElement>('input')]
    .find(el => el.placeholder === placeholder)!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function inputByPlaceholder(container: HTMLElement, prefix: string): HTMLInputElement {
  const input = [...panel(container)!.querySelectorAll<HTMLInputElement>('input')]
    .find(el => el.placeholder.startsWith(prefix))
  if (input === undefined) throw new Error(`input not found: ${prefix}`)
  return input
}

/** The include (0) / exclude (1) group of the expanded panel, in panel order. */
function searchGroup(container: HTMLElement, index: 0 | 1): HTMLElement {
  const groups = [...panel(container)!.querySelectorAll<HTMLElement>('div[class*="contentSearchGroup"]')]
  if (groups[index] === undefined) throw new Error(`content search group ${index} not mounted`)
  return groups[index]!
}

function chipTexts(group: HTMLElement): string[] {
  return [...group.querySelectorAll<HTMLElement>('span[class*="contentChip"]')].map(chip => chip.textContent ?? '')
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

describe('TreePanel add-to-content-search chips', () => {
  let harness: PanelHarness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-dsh-sidebar-submenu')
    fsTrees.mockReset()
    installListings(DEFAULT_ROOT)
    fsSearch.mockReset()
    fsSearch.mockImplementation(async () => ({ matches: [], dirs: [], truncated: false }))
    fsContentSearch.mockReset()
    fsContentSearch.mockImplementation(async () => ({ matches: ['src/a.ts'], truncated: false }))
  })

  it('lands the cwd-relative chip, force-expands the section, and runs no search', async () => {
    installListings(DEFAULT_ROOT)
    harness = mountPanel()
    await act(async () => {})
    // Collapsed by default — the menu add must itself expand the section.
    expect(toggleButton(harness.container).getAttribute('aria-expanded')).toBe('false')
    expect(panel(harness.container)).toBeNull()

    addToSearch(harness.container, 'a.ts', 'Add to Include')
    expect(toggleButton(harness.container).getAttribute('aria-expanded')).toBe('true')
    expect(panel(harness.container)).not.toBeNull()
    // '/tmp/a.ts' projected against the cwd '/tmp' is the bare relative form
    // the host resolves against the session cwd.
    expect(chipTexts(searchGroup(harness.container, 0))).toEqual(['a.ts×'])
    expect(chipTexts(searchGroup(harness.container, 1))).toEqual([])
    // Adding a chip never STARTS a content search — it only feeds the lists.
    expect(fsContentSearch).not.toHaveBeenCalled()
  })

  it('passes a path outside the cwd through as an absolute chip', async () => {
    installListings([...DEFAULT_ROOT, { name: 'notes.log', path: '/var/elsewhere/notes.log', isDir: false }])
    harness = mountPanel()
    await act(async () => {})

    addToSearch(harness.container, 'notes.log', 'Add to Exclude')
    // relativeTo leaves the outside path unchanged: the host's resolveTarget
    // accepts absolute entries, so the chip classifies identically.
    expect(chipTexts(searchGroup(harness.container, 1))).toEqual(['/var/elsewhere/notes.log×'])
    expect(chipTexts(searchGroup(harness.container, 0))).toEqual([])
    expect(fsContentSearch).not.toHaveBeenCalled()
  })

  it('silently ignores a duplicate chip', async () => {
    installListings(DEFAULT_ROOT)
    harness = mountPanel()
    await act(async () => {})

    addToSearch(harness.container, 'a.ts', 'Add to Include')
    addToSearch(harness.container, 'a.ts', 'Add to Include')
    expect(chipTexts(searchGroup(harness.container, 0))).toEqual(['a.ts×'])
    expect(panel(harness.container)!.querySelectorAll('span[class*="contentChip"]')).toHaveLength(1)
  })

  it('touches neither the committed queries nor the drafts', async () => {
    installListings(DEFAULT_ROOT)
    harness = mountPanel()
    await act(async () => {})
    addToSearch(harness.container, 'a.ts', 'Add to Include')

    // Drafts (uncommitted — no Enter anywhere): keyword + include input.
    await type(harness.container, 'Search in file contents (Enter to run)…', 'zz')
    await type(harness.container, 'Include: dir, file or glob — Enter to add', 'draft-x')

    addToSearch(harness.container, 'sub', 'Add to Include')
    expect(inputByPlaceholder(harness.container, 'Search in file contents').value).toBe('zz')
    expect(inputByPlaceholder(harness.container, 'Include:').value).toBe('draft-x')
    // Both chips appended in order; still no content search ran.
    expect(chipTexts(searchGroup(harness.container, 0))).toEqual(['a.ts×', 'sub×'])
    expect(fsContentSearch).not.toHaveBeenCalled()
  })

  it('a live name search keeps owning the results when a chip lands', async () => {
    fsSearch.mockResolvedValue({ matches: ['src/b.ts'], dirs: [], truncated: false })
    installListings(DEFAULT_ROOT)
    harness = mountPanel()
    await act(async () => {})
    // Run a NAME search (300ms debounce).
    const nameInput = harness.container.querySelector<HTMLInputElement>('input[class*="editorSearchInput"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(nameInput, 'b')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise<void>(resolve => { window.setTimeout(resolve, 350) }) })
    expect(fsSearch).toHaveBeenCalledTimes(1)
    expect(resultsBody(harness.container).textContent).toContain('src/b.ts')

    addToSearch(harness.container, 'a.ts', 'Add to Include')
    // The chip landed (and the section expanded), but the name search was
    // neither cleared nor displaced by a content search.
    expect(chipTexts(searchGroup(harness.container, 0))).toEqual(['a.ts×'])
    expect(nameInput.value).toBe('b')
    expect(resultsBody(harness.container).textContent).toContain('src/b.ts')
    expect(fsContentSearch).not.toHaveBeenCalled()
  })
})
