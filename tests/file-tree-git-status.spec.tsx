/**
 * FileTree git ink (VS Code style): the tree reads the plugin's SHARED
 * `useGitStatus` store — a changed file's name takes its tone class and a
 * letter badge whose tooltip is the status word, a directory with a change
 * anywhere below it is tinted without a letter, a clean file stays plain, and
 * a non-repo (or unavailable git) degrades silently to plain rows.
 */
// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { GitStatusResult } from '../src/client/api.ts'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the badge tooltip is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { gitStatus, fsTrees } = vi.hoisted(() => ({ gitStatus: vi.fn(), fsTrees: vi.fn() }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees,
    gitStatus,
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

const REPO: GitStatusResult = {
  isRepo: true,
  root: '/tmp',
  entries: [
    { path: 'a.ts', xy: ' M' },
    // A change strictly BELOW /tmp/sub: the directory is tinted, the file
    // itself is not rendered (its level is collapsed).
    { path: 'sub/inner.ts', xy: '??' },
  ],
}

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(options: { expanded?: readonly string[] } = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 'git-spec',
      cwd: '/tmp',
      expanded: [...(options.expanded ?? [])],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    // Settle the shared store's fetch (it starts in FileTree's mount effect).
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name. */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function nameSpan(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('[class*="explorerName"]')!
}

let harness: Harness
beforeEach(() => {
  // The default listing: the same three rows at every requested level (tests
  // that need a real subtree override this).
  fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
    levels: paths.map(path => ({ path, entries: [
      { name: 'sub', path: '/tmp/sub', isDir: true },
      { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
      { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
    ], truncated: false })),
  }))
})
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  gitStatus.mockReset()
  fsTrees.mockReset()
})

describe('FileTree git ink', () => {
  it('tints a changed file name and badges its porcelain letter', async () => {
    gitStatus.mockResolvedValue(REPO)
    harness = await mountTree()
    const row = rowByName(harness.container, 'a.ts')
    expect(nameSpan(row).getAttribute('data-git-tone')).toBe('modified')
    expect(nameSpan(row).className).toContain('explorerGitName')
    const badge = row.querySelector<HTMLElement>('[class*="statusBadge"]')
    expect(badge?.textContent).toBe('M')
    expect(badge?.getAttribute('data-tone')).toBe('modified')
    expect(badge?.getAttribute('title')).toBe('Modified')
  })

  it('tints a directory that contains a change below it, without a letter', async () => {
    gitStatus.mockResolvedValue(REPO)
    harness = await mountTree()
    const row = rowByName(harness.container, 'sub')
    expect(nameSpan(row).className).toContain('explorerDirChanged')
    expect(row.querySelector('[class*="statusBadge"]')).toBeNull()
  })

  it('leaves a clean file plain', async () => {
    gitStatus.mockResolvedValue(REPO)
    harness = await mountTree()
    const row = rowByName(harness.container, 'b.ts')
    expect(nameSpan(row).getAttribute('data-git-tone')).toBeNull()
    expect(row.querySelector('[class*="statusBadge"]')).toBeNull()
  })

  it('degrades silently outside a repository', async () => {
    gitStatus.mockResolvedValue({ isRepo: false, entries: [] })
    harness = await mountTree()
    const file = rowByName(harness.container, 'a.ts')
    expect(nameSpan(file).getAttribute('data-git-tone')).toBeNull()
    expect(nameSpan(file).className).not.toContain('explorerGitName')
    const dir = rowByName(harness.container, 'sub')
    expect(nameSpan(dir).className).not.toContain('explorerDirChanged')
  })
})

describe('FileTree ignored overlay (the ⊘ that keeps .gitignore paths from the clean ✓)', () => {
  /** The overlay badge of one row, if the row carries one. */
  function overlayMark(row: HTMLElement): HTMLElement | null {
    return row.querySelector<HTMLElement>('[class*="explorerGitMark"]')
  }

  it('badges an ignored directory ⊘ instead of the green ✓', async () => {
    // No change anywhere under sub: the tone index is empty for it, so the
    // ignore answer decides the row's mark.
    gitStatus.mockResolvedValue({ ...REPO, entries: [{ path: 'a.ts', xy: ' M' }], ignored: ['sub/'] })
    harness = await mountTree()
    const mark = overlayMark(rowByName(harness.container, 'sub'))
    expect(mark).not.toBeNull()
    expect(mark!.getAttribute('data-mark')).toBe('ignored')
    expect(mark!.getAttribute('title')).toBe('Ignored')
    expect(mark!.textContent).toBe('⊘')
  })

  it('badges every file UNDER an ignored directory ⊘ (the ancestor walk)', async () => {
    // No change row under sub (git cannot track files there): the file's own
    // tone is undefined, so the ancestor's ignore answer decides.
    gitStatus.mockResolvedValue({ ...REPO, entries: [{ path: 'a.ts', xy: ' M' }], ignored: ['sub/'] })
    // A real subtree: /tmp/sub holds one file (the mock's default listing is
    // overridden for that one level).
    fsTrees.mockImplementation(async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: path === '/tmp/sub'
        ? [{ name: 'inner.ts', path: '/tmp/sub/inner.ts', isDir: false }]
        : [
            { name: 'sub', path: '/tmp/sub', isDir: true },
            { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
            { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
          ], truncated: false })),
    }))
    harness = await mountTree({ expanded: ['/tmp/sub'] })
    const inner = overlayMark(rowByName(harness.container, 'inner.ts'))
    expect(inner).not.toBeNull()
    expect(inner!.getAttribute('data-mark')).toBe('ignored')
    // A file outside the ignored directory keeps its own vocabulary.
    expect(overlayMark(rowByName(harness.container, 'b.ts'))!.getAttribute('data-mark')).toBe('clean')
  })

  it('badges an ignored FILE exactly, and leaves the changed vocabulary untouched', async () => {
    gitStatus.mockResolvedValue({ ...REPO, ignored: ['b.ts'] })
    harness = await mountTree()
    expect(overlayMark(rowByName(harness.container, 'b.ts'))!.getAttribute('data-mark')).toBe('ignored')
    // The status tone still outranks everything: a modified file keeps its
    // mark even while a sibling is ignored.
    expect(overlayMark(rowByName(harness.container, 'a.ts'))!.getAttribute('data-mark')).toBe('modified')
  })

  it('keeps the clean ✓ off when the ignore list is truncated (unknown ≠ clean)', async () => {
    gitStatus.mockResolvedValue({ ...REPO, entries: [{ path: 'a.ts', xy: ' M' }], ignored: ['sub/'], ignoredTruncated: true })
    harness = await mountTree()
    // A listed ignored path still badges ⊘; an UNLISTED clean path must not
    // claim ✓ from a partial answer.
    expect(overlayMark(rowByName(harness.container, 'sub'))!.getAttribute('data-mark')).toBe('ignored')
    expect(overlayMark(rowByName(harness.container, 'b.ts'))).toBeNull()
  })
})
