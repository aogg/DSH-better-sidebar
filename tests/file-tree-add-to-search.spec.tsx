/**
 * 文件树「添加到搜索中」的迁移后语义。旧链路（TreePanel 持 chips、原地展开
 * 面板）已随内容搜索迁往「搜索」页；现在的分工（docs/plans/2026-10-21
 * -find-in-files-page.md §3.3）：
 *
 * - FileTree 只上报：右键行（文件或目录，绝对路径）+ 所选列表
 *   (`include` / `exclude`)，挂在改名的 `onAddToSearch` prop 后，prop 缺席
 *   时整个子菜单隐藏（与 open-with 同一契约）。两级菜单结构与图标逐字保留。
 * - TreePanel 是单一透传：不持有任何 chips 状态/输入行，只把树的上报交给
 *   调用方。真正的动作（折算 chip、parkSearchSeed、开新搜索 tab、门控）在
 *   EditorHost —— 由 editor-host.spec.tsx 钉住。
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { TreePanel } from '../src/client/TreePanel.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
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

const { fsTrees, fsContentSearch } = vi.hoisted(() => ({
  fsTrees: vi.fn(async (_scope: unknown, _paths: readonly string[]) => ({ levels: [] as unknown[] })),
  fsContentSearch: vi.fn(async () => ({ matches: [], truncated: false })),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    // The migration lock: nothing in the tree may touch the content search.
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
  onAddToSearch?: (path: string, target: 'include' | 'exclude') => void
} = {}): Promise<TreeHarness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onAdd = vi.fn()
  // Property-presence semantics: an explicit `onAddToSearch: undefined`
  // must reach FileTree (the submenu hides) instead of falling back.
  const wired = Object.prototype.hasOwnProperty.call(overrides, 'onAddToSearch')
    ? overrides.onAddToSearch
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
      onAddToSearch: wired,
    }))
    await Promise.resolve()
  })
  return {
    container,
    onAdd,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('FileTree add-to-search submenu（改名后的上报契约）', () => {
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
    harness = await mountTree({ onAddToSearch: undefined })
    openMenuOn(harness.container, 'a.ts')
    expect(menuItems().some(item => item.textContent?.includes('Add to Search'))).toBe(false)
    expect(menuItems().some(item => item.getAttribute('aria-haspopup') === 'menu')).toBe(false)
  })
})

// ── TreePanel: single passthrough, no chip state of its own ──────────────

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

describe('TreePanel add-to-search 透传（无本地 chips）', () => {
  let harness: PanelHarness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-dsh-sidebar-submenu')
    fsTrees.mockReset()
    installListings(DEFAULT_ROOT)
  })

  it('forwards the tree report to onAddToSearch verbatim (absolute path + list)', async () => {
    const onAddToSearch = vi.fn()
    harness = mountPanel({ onAddToSearch })
    await act(async () => {})
    addToSearch(harness.container, 'a.ts', 'Add to Include')
    expect(onAddToSearch).toHaveBeenCalledTimes(1)
    expect(onAddToSearch).toHaveBeenCalledWith('/tmp/a.ts', 'include')
    addToSearch(harness.container, 'sub', 'Add to Exclude')
    expect(onAddToSearch).toHaveBeenCalledWith('/tmp/sub', 'exclude')
    // The menu action never touches the content search (it belongs to the
    //「搜索」page now; the redirect handler's opens are EditorHost's).
    expect(fsContentSearch).not.toHaveBeenCalled()
  })

  it('renders no chip lists or content-search inputs of its own', async () => {
    const onAddToSearch = vi.fn()
    harness = mountPanel({ onAddToSearch })
    await act(async () => {})
    // The panel's only input is the file-name search; the chip rows live on
    // the search page exclusively.
    const inputs = [...harness.container.querySelectorAll<HTMLInputElement>('input')]
      .map(input => input.placeholder)
    expect(inputs.some(placeholder => placeholder.startsWith('Search files'))).toBe(true)
    expect(inputs.some(placeholder => placeholder.includes('Include'))).toBe(false)
    expect(inputs.some(placeholder => placeholder.includes('Exclude'))).toBe(false)
    expect(inputs.some(placeholder => placeholder.includes('file contents'))).toBe(false)
  })
})
