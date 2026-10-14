/**
 * The file tree's 复制 / 剪切 / 黏贴 (the context-menu trio + the conflict
 * dialog + the async host job hand-off). The clipboard is the REAL page-wide
 * store (tree-clipboard.ts, reset per case); the wire is mocked, so these
 * cases pin the CLIENT contract:
 *  - 复制/剪切 take the whole selection into the clipboard (pure client, no
 *    wires) and a cut marks the clipboard mode;
 *  - 黏贴 lists the target level ONCE (fs.trees) for the conflict check: a
 *    clean target starts `fs.transfer` straight away (copy / move per the
 *    clipboard mode, `skip`), a conflicting target opens the Windows-style
 *    dialog whose 跳过/替换 choice becomes the job's conflict mode;
 *  - a cut-paste CLEARS the clipboard once the job is accepted.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsTrees, fsTransfer, fsTransferStatus } = vi.hoisted(() => ({
  fsTrees: vi.fn(),
  fsTransfer: vi.fn(),
  fsTransferStatus: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    fsTransfer,
    fsTransferStatus,
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  archiveDownloadUrl: (id: string) => `/sidebar/archive/${id}`,
  isOutsideWorkspaceMessage: () => false,
  SidebarApiError: class extends Error {},
}))

import { getTreeClipboard, setTreeClipboard } from '../src/client/tree-clipboard.ts'

interface Entry {
  name: string
  path: string
  isDir: boolean
}

/** The one-level listing every case sees: a directory and a file. */
const DEFAULT_ROOT: Entry[] = [
  { name: 'sub', path: '/tmp/sub', isDir: true },
  { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
]

/** (Re)arm the listings: `/tmp` answers `root`, any other level `extra`. */
function installListings(root: Entry[], extra: Entry[] = []): void {
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({ path, entries: path === '/tmp' ? root : extra, truncated: false })),
  }))
}

/** The accepted-job answer; status polling settles immediately. */
function installTransfer(): void {
  fsTransfer.mockImplementation(async () => ({ transferId: 't-1', totalFiles: 1, totalBytes: 5 }))
  fsTransferStatus.mockImplementation(async (id: string) => ({
    transferId: id,
    mode: 'copy',
    state: 'done',
    totalFiles: 1,
    totalBytes: 5,
    filesDone: 1,
    bytesDone: 5,
    itemErrors: [],
  }))
}

// The default wire before each case customizes it (every listing answers,
// every accepted transfer settles done immediately).
installListings(DEFAULT_ROOT)
installTransfer()

// ── Harness (the add-to-search spec's shape) ──────────────────────────────

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function menuItem(label: string): HTMLElement {
  const item = menuItems().find(node => node.textContent?.trim() === label)
  if (item === undefined) throw new Error(`menu item not found: ${label}`)
  return item
}

function rowOf(container: HTMLElement, name: string): HTMLElement {
  // Row = any explorer row div (file/dir rows carry role="button"; the ROOT
  // row deliberately does not — it is a header, not a click target).
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** One macrotask: the mount → listing → row-render chain settles inside it. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

function openMenuOn(container: HTMLElement, name: string): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { rowOf(container, name).dispatchEvent(event) })
}

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'clip',
      cwd: '/tmp',
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    await Promise.resolve()
  })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

describe('FileTree 复制 / 剪切 / 黏贴', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    setTreeClipboard(null)
    vi.mocked(fsTrees).mockReset()
    vi.mocked(fsTransfer).mockReset()
    vi.mocked(fsTransferStatus).mockReset()
    installListings(DEFAULT_ROOT)
    installTransfer()
  })

  it('空剪贴板：黏贴置灰；复制/剪切把整个选中写进剪贴板（不触网）', async () => {
    harness = await mountTree()
    await flush()
    openMenuOn(harness.container, 'a.ts')
    const paste = menuItem('Paste')
    expect((paste as HTMLButtonElement).disabled).toBe(true)
    act(() => { menuItem('Copy').click() })
    expect(fsTransfer).not.toHaveBeenCalled()
    expect(getTreeClipboard()).toEqual({
      cwd: '/tmp',
      mode: 'copy',
      entries: [{ path: '/tmp/a.ts', isDir: false }],
    })
    // 剪切 switches the same clipboard to cut mode.
    openMenuOn(harness.container, 'a.ts')
    act(() => { menuItem('Cut').click() })
    expect(getTreeClipboard()?.mode).toBe('cut')
  })

  it('根行右键：只有黏贴（根自身不是剪贴板行）', async () => {
    harness = await mountTree()
    // The root row prints the workspace basename — 'tmp'.
    openMenuOn(harness.container, 'tmp')
    const labels = menuItems().map(node => node.textContent?.trim())
    expect(labels).toContain('Paste')
    expect(labels).not.toContain('Copy')
    expect(labels).not.toContain('Cut')
  })

  it('黏贴（干净目标）：fs.trees 查一次目标层，直接受理 copy 任务', async () => {
    installListings(DEFAULT_ROOT, [])
    installTransfer()
    harness = await mountTree()
    await flush()
    openMenuOn(harness.container, 'a.ts')
    act(() => { menuItem('Copy').click() })
    openMenuOn(harness.container, 'sub')
    const paste = menuItem('Paste')
    expect((paste as HTMLButtonElement).disabled).toBe(false)
    act(() => { paste.click() })
    await act(async () => { await Promise.resolve() })
    // The paste pre-flight listed the TARGET level (the mount listing also
    // rides fs.trees, so only the call ARGUMENTS identify this one).
    expect(fsTrees.mock.calls.some(call => JSON.stringify(call[1]) === JSON.stringify(['/tmp/sub']))).toBe(true)
    expect(fsTransfer).toHaveBeenCalledTimes(1)
    expect(fsTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'clip', cwd: '/tmp' }),
      'copy',
      ['/tmp/a.ts'],
      '/tmp/sub',
      'skip',
    )
    // A COPY keeps the clipboard (Windows semantics: paste again anywhere).
    expect(getTreeClipboard()?.mode).toBe('copy')
  })

  it('剪切黏贴：任务是 move，受理后剪贴板清空', async () => {
    installListings(DEFAULT_ROOT, [])
    installTransfer()
    harness = await mountTree()
    await flush()
    openMenuOn(harness.container, 'a.ts')
    act(() => { menuItem('Cut').click() })
    openMenuOn(harness.container, 'sub')
    act(() => { menuItem('Paste').click() })
    await act(async () => { await Promise.resolve() })
    expect(fsTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'clip', cwd: '/tmp' }),
      'move',
      ['/tmp/a.ts'],
      '/tmp/sub',
      'skip',
    )
    expect(getTreeClipboard()).toBeNull()
  })

  it('冲突：目标层已有同名 → 弹窗让选择，跳过以 skip 受理', async () => {
    // The target level /tmp/sub already holds `a.ts`.
    installListings(DEFAULT_ROOT, [{ name: 'a.ts', path: '/tmp/sub/a.ts', isDir: false }])
    installTransfer()
    harness = await mountTree()
    await flush()
    openMenuOn(harness.container, 'a.ts')
    act(() => { menuItem('Copy').click() })
    openMenuOn(harness.container, 'sub')
    act(() => { menuItem('Paste').click() })
    await act(async () => { await Promise.resolve() })
    // The dialog is open with the conflict's name; no job yet.
    expect(document.querySelector('[data-dsh-paste-conflicts]')).not.toBeNull()
    expect(fsTransfer).not.toHaveBeenCalled()
    const skip = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(node => node.textContent?.trim() === 'Skip')
    if (skip === undefined) throw new Error('skip button not found')
    act(() => { skip.click() })
    await act(async () => { await Promise.resolve() })
    expect(fsTransfer).toHaveBeenCalledTimes(1)
    expect(fsTransfer.mock.calls[0]?.[4]).toBe('skip')
  })

  it('冲突：替换以 replace 受理', async () => {
    installListings(DEFAULT_ROOT, [{ name: 'a.ts', path: '/tmp/sub/a.ts', isDir: false }])
    installTransfer()
    harness = await mountTree()
    await flush()
    openMenuOn(harness.container, 'a.ts')
    act(() => { menuItem('Copy').click() })
    openMenuOn(harness.container, 'sub')
    act(() => { menuItem('Paste').click() })
    await act(async () => { await Promise.resolve() })
    const replace = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(node => node.textContent?.trim() === 'Replace')
    if (replace === undefined) throw new Error('replace button not found')
    act(() => { replace.click() })
    await act(async () => { await Promise.resolve() })
    expect(fsTransfer).toHaveBeenCalledTimes(1)
    expect(fsTransfer.mock.calls[0]?.[4]).toBe('replace')
  })
})
