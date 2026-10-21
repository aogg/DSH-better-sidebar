/**
 * Clicking a highlighted row dismisses its reveal highlight. The reveal is a
 * transient "here it is" locator — a "Show in folder" mark, or the landing
 * highlight a conversation folder link paints — and the plain click on the
 * found row is the reader closing it:
 *   - file rows and directory rows behave the SAME (the row's normal action
 *     still runs: the file opens, the folder toggles);
 *   - only the clicked ROW's paths leave the set — a folded (compact) row
 *     renders one line for its whole chain, so whichever link carries the
 *     mark goes, and every other reveal survives;
 *   - modifier clicks are selection gestures and never clear a highlight;
 *   - clicking a row without the mark changes nothing.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const fsTrees = vi.fn()

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: (...args: unknown[]) => fsTrees(...args),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** A directory row entry. */
function dir(path: string, compact = false): {
  name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean; compact?: boolean
} {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    name, path, isDir: true,
    hidden: name.startsWith('.'), isSymlink: false, broken: false,
    ...(compact ? { compact: true } : {}),
  }
}

/** A file row entry. */
function file(path: string): {
  name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean
} {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, isDir: false, hidden: name.startsWith('.'), isSymlink: false, broken: false }
}

/** The FLAT workspace: one folder and one file at the root. */
function flatLevel(path: string): { path: string; entries: unknown[]; truncated: boolean } {
  if (path === '/tmp') return { path, entries: [dir('/tmp/src'), file('/tmp/a.ts')], truncated: false }
  return { path, entries: [], truncated: false }
}

/** The FOLDED workspace: a singleton chain a → a/b → a/b/c plus a sibling. */
function foldedLevel(path: string): { path: string; entries: unknown[]; truncated: boolean } {
  switch (path) {
    case '/tmp': return { path, entries: [dir('/tmp/a', true), file('/tmp/readme.md')], truncated: false }
    case '/tmp/a': return { path, entries: [dir('/tmp/a/b', true)], truncated: false }
    case '/tmp/a/b': return { path, entries: [dir('/tmp/a/b/c', true)], truncated: false }
    default: return { path, entries: [], truncated: false }
  }
}

/** The smallest WebSocket the directory watcher talks to. */
class FakeSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3 }
}

interface Harness {
  container: HTMLDivElement
  dismissed: string[][]
  opened: string[]
  toggled: string[]
  unmount: () => void
}

function mountTree(revealed: string[], levelOf: (path: string) => { path: string; entries: unknown[]; truncated: boolean } = flatLevel): Harness {
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(levelOf),
  }))
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const dismissed: string[][] = []
  const opened: string[] = []
  const toggled: string[] = []
  act(() => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded: [],
      revealed,
      onRevealDismiss: (paths) => { dismissed.push([...paths]) },
      onToggle: (path: string) => { toggled.push(path) },
      onOpenFile: (path: string) => { opened.push(path) },
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  // jsdom defines no Element.scrollTo; the reveal-scroll effect calls it.
  const body = container.firstElementChild as HTMLElement
  Object.defineProperty(body, 'scrollTo', { value: () => {} })
  return {
    container,
    dismissed,
    opened,
    toggled,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Flush the batch promise chain (the level loads resolve outside timers). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** The row whose label starts with `label` (a folded row's label is the chain). */
function rowByLabel(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(candidate => (candidate.textContent ?? '').startsWith(label))
  if (row === undefined) throw new Error(`no row "${label}"`)
  return row
}

/** A plain left click, React-observed. */
function click(row: HTMLElement, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}): void {
  act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers })) })
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('FileTree clicking a revealed row dismisses the highlight', () => {
  it('a revealed FILE row is dismissed and still opens', async () => {
    const tree = mountTree(['/tmp/a.ts'])
    await flush()
    click(rowByLabel(tree.container, 'a.ts'))
    expect(tree.dismissed).toEqual([['/tmp/a.ts']])
    expect(tree.opened).toEqual(['/tmp/a.ts'])
    tree.unmount()
  })

  it('a revealed FOLDER row is dismissed and still toggles', async () => {
    const tree = mountTree(['/tmp/src'])
    await flush()
    click(rowByLabel(tree.container, 'src'))
    expect(tree.dismissed).toEqual([['/tmp/src']])
    expect(tree.toggled).toEqual(['/tmp/src'])
    tree.unmount()
  })

  it('clicking a row without the mark dismisses nothing', async () => {
    const tree = mountTree(['/tmp/a.ts'])
    await flush()
    click(rowByLabel(tree.container, 'src'))
    expect(tree.dismissed).toEqual([])
    // …and the untouched highlight keeps its row.
    expect(tree.container.querySelector('[data-dsh-revealed]')).not.toBeNull()
    tree.unmount()
  })

  it('a modifier click is a selection gesture and keeps the highlight', async () => {
    const tree = mountTree(['/tmp/a.ts'])
    await flush()
    click(rowByLabel(tree.container, 'a.ts'), { ctrlKey: true })
    click(rowByLabel(tree.container, 'a.ts'), { metaKey: true })
    click(rowByLabel(tree.container, 'a.ts'), { shiftKey: true })
    expect(tree.dismissed).toEqual([])
    tree.unmount()
  })

  it('keyboard activation dismisses like a plain click', async () => {
    const tree = mountTree(['/tmp/a.ts'])
    await flush()
    act(() => { rowByLabel(tree.container, 'a.ts').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(tree.dismissed).toEqual([['/tmp/a.ts']])
    tree.unmount()
  })

  it('a folded row dismisses whichever chain link carries the mark', async () => {
    // `a/b/c` renders as ONE row; the revealed link is the MIDDLE one. The
    // click still closes exactly that link's mark — the head and tail were
    // never highlighted.
    const tree = mountTree(['/tmp/a/b'], foldedLevel)
    await flush()
    const row = rowByLabel(tree.container, 'a/b/c')
    expect(row.hasAttribute('data-dsh-revealed')).toBe(true)
    click(row)
    expect(tree.dismissed).toEqual([['/tmp/a/b']])
    // The row's own toggle still ran (the whole chain opens as one).
    expect(tree.toggled.sort()).toEqual(['/tmp/a', '/tmp/a/b', '/tmp/a/b/c'].sort())
    tree.unmount()
  })
})
