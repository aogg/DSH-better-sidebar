/**
 * "Show in folder" reveal scrolling: the tree body is the ONLY thing that
 * may scroll. The reveal used native scrollIntoView, which scrolls every
 * scrollable ancestor — and the clipping fixed panel host
 * ([data-dsh-panel-host], overflow hidden at the time) is still
 * programmatically scrollable, so a deep reveal shifted the whole panel,
 * tab bar included, out of the viewport (reported on DSH 0.1.2-alpha.1).
 * The regression guard: body.scrollTo receives the centered, clamped
 * target; row.scrollIntoView is never called.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// jsdom defines no scrollIntoView; counting calls needs a real function.
const scrollIntoView = vi.fn()
beforeAll(() => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView
})
afterEach(() => { scrollIntoView.mockClear() })

/** Per-test fsTrees override (the lazy-load timing test swaps it in); null
 *  answers the static listing below. Referenced lazily — the mock factory
 *  runs before this module body, only the CALLS may touch the binding. */
type FsTreesMock = (scope: unknown, paths: readonly string[]) => Promise<{
  levels: Array<{ path: string; entries: Array<{ name: string; path: string; isDir: boolean }>; truncated: boolean }>
}>
let mockFsTrees: FsTreesMock | null = null

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTrees: (scope: unknown, paths: readonly string[]) =>
      mockFsTrees !== null
        ? mockFsTrees(scope, paths)
        : Promise.resolve({
            levels: paths.map(path => ({ path, entries: [
              { name: 'src', path: '/tmp/src', isDir: true },
              { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
            ], truncated: false })),
          }),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the reveal scroll).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
}))

interface TreeHarness {
  /** Re-render with new props; the refresh tick reloads the level cache. */
  rerender: (revealed: string[], refreshTick: number, hidden?: boolean, expanded?: string[]) => Promise<void>
  body: HTMLElement
  /** Pin one row's geometry (jsdom has no layout). */
  layoutRow: (top: number, height: number) => void
  scrollTo: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(bodyScroll: { top: number; client: number; height: number }): Promise<TreeHarness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (revealed: string[], refreshTick: number, hidden?: boolean, expanded: string[] = []): void => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      expanded,
      revealed,
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick,
      onUploadRequest: () => {},
      busy: false,
      ...(hidden === undefined ? {} : { hidden }),
    }))
  }
  await act(async () => { render([], 0) })
  const body = container.firstElementChild as HTMLElement
  const scrollTo = vi.fn()
  Object.defineProperty(body, 'scrollTo', { value: scrollTo })
  Object.defineProperty(body, 'getBoundingClientRect', { value: () => ({ top: 100, height: bodyScroll.client }) })
  Object.defineProperty(body, 'clientHeight', { value: bodyScroll.client })
  Object.defineProperty(body, 'scrollHeight', { value: bodyScroll.height })
  Object.defineProperty(body, 'scrollTop', { value: bodyScroll.top, writable: true })
  return {
    rerender: async (revealed, refreshTick, hidden, expanded) => { await act(async () => { render(revealed, refreshTick, hidden, expanded) }) },
    body,
    layoutRow: (top, height) => {
      const row = body.querySelector('[data-dsh-revealed]')
      expect(row).not.toBeNull()
      Object.defineProperty(row as Element, 'getBoundingClientRect', { value: () => ({ top, height }) })
    },
    scrollTo,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

afterEach(() => {
  mockFsTrees = null
  document.body.innerHTML = ''
})

describe('FileTree reveal scrolling (show in folder)', () => {
  it('centers the revealed row in the tree body only', async () => {
    // Body: top 100, 300 tall, scrolled 40; row lands at 400, 20 tall →
    // target = 40 + (400 + 10) − (100 + 150) = 200.
    const tree = await mountTree({ top: 40, client: 300, height: 1000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    tree.layoutRow(400, 20)
    await tree.rerender(['/tmp/a.ts'], 1)
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(tree.scrollTo.mock.calls.map(call => call[0])).toContainEqual({ top: 200, behavior: 'smooth' })
    tree.unmount()
  })

  it('clamps the target to the scrollable range', async () => {
    // 5000px-tall scroller with 300 visible: max scrollTop 4700.
    const tree = await mountTree({ top: 0, client: 300, height: 5000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    tree.layoutRow(9000, 20)
    await tree.rerender(['/tmp/a.ts'], 1)
    expect(tree.scrollTo.mock.calls.map(call => call[0]?.top)).toContainEqual(4700)
    tree.unmount()
  })

  it('scrolls nothing without a reveal', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    await tree.rerender([], 1)
    expect(tree.scrollTo).not.toHaveBeenCalled()
    tree.unmount()
  })

  it('a folder-link reveal scrolls once the lazily loaded level lands (no extra render)', async () => {
    // The lazy-load timing a folder link hits on a closed tree: the reveal
    // lands (revealed set + ancestors AND the folder itself in `expanded`)
    // while the level listing that carries the revealed row is still in
    // flight — the scroll effect's first pass finds no row — and the DATA
    // ARRIVAL alone must re-run it ([revealed, data] deps) and scroll. No
    // rAF retry, no extra render: the lazy level is the only wait.
    const rootEntries = [
      { name: 'src', path: '/tmp/src', isDir: true },
      { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
    ]
    const deeperEntries = [{ name: 'sub', path: '/tmp/src/sub', isDir: true }]
    let holdDeeper = true
    let held: Array<() => void> = []
    const answer = (paths: readonly string[]) => ({
      levels: paths.map(path => ({
        path,
        // Only /tmp/src lists `sub`; the folder's own level lists nothing
        // (a self-containing listing would recurse the row walk forever).
        entries: path === '/tmp' ? rootEntries : path === '/tmp/src' ? deeperEntries : [],
        truncated: false,
      })),
    })
    mockFsTrees = async (_scope: unknown, paths: readonly string[]) => {
      // The root level answers at once (the tree renders its rows); every
      // deeper listing waits for the test to release it.
      if (!holdDeeper || paths.every(path => path === '/tmp')) return answer(paths)
      return new Promise(resolve => { held.push(() => resolve(answer(paths))) })
    }
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    // The reveal round: the expanded set is what `revealPaths(…,
    // { expandTarget: true })` produced for the folder link `src/sub`.
    await tree.rerender(['/tmp/src/sub'], 0, undefined, ['/tmp/src', '/tmp/src/sub'])
    // The listing is still in flight: no revealed row rendered, no scroll.
    expect(tree.body.querySelector('[data-dsh-revealed]')).toBeNull()
    expect(tree.scrollTo).not.toHaveBeenCalled()
    // The listings land — the tree re-renders, the row appears, and the
    // data-triggered effect pass scrolls it into view by itself.
    await act(async () => {
      holdDeeper = false
      const pending = held
      held = []
      for (const release of pending) release()
      await Promise.resolve()
    })
    expect(tree.body.querySelector('[data-dsh-revealed]')).not.toBeNull()
    expect(tree.scrollTo.mock.calls.length).toBeGreaterThan(0)
    expect(tree.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
    tree.unmount()
  })
})

/**
 * The reveal FLASH (VSCode-style one-shot highlight on the revealed row):
 * every fresh reveal round restarts the animation by ALTERNATING two
 * interchangeable classes (changing animation-name is what restarts a CSS
 * animation — re-applying the same class would not). `revealPaths` hands out
 * a fresh `revealed` array on every call, even for an unchanged set, so the
 * identity change is the replay trigger.
 */
describe('FileTree reveal flash (one-shot highlight, replayable)', () => {
  /** The revealed file row (the tree lists /tmp/a.ts at the root). */
  function revealedRow(tree: TreeHarness): HTMLElement {
    const row = tree.body.querySelector('[data-dsh-revealed]')
    expect(row).not.toBeNull()
    return row as HTMLElement
  }

  it('flashes the revealed row on a fresh reveal', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    tree.unmount()
  })

  it('no flash without a reveal', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    // The reveal set clearing drops the flash with the highlight.
    await tree.rerender([], 0)
    expect(tree.body.querySelector('[data-dsh-revealed]')).toBeNull()
    tree.unmount()
  })

  it('repeats of the same reveal ALTERNATE the flash class (the animation restarts)', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    await tree.rerender(['/tmp/a.ts'], 0)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    // A second revealPaths call hands out a NEW array with the SAME contents
    // — exactly the "reveal an already-revealed file" replay.
    await tree.rerender(['/tmp/a.ts'], 0)
    const row = revealedRow(tree)
    expect(row.className).toContain('explorerRowFlashB')
    expect(row.className).not.toContain('explorerRowFlashA')
    // And a third round alternates back.
    await tree.rerender(['/tmp/a.ts'], 0)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    tree.unmount()
  })

  it('the same array IDENTITY does not re-flash (a re-render is not a reveal)', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    const revealed = ['/tmp/a.ts']
    await tree.rerender(revealed, 0)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    // Re-render with the SAME array (e.g. an unrelated parent re-render):
    // no identity change, no replay — the class stays A.
    await tree.rerender(revealed, 0)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    tree.unmount()
  })

  it('a reveal while the tree is parked (search) flashes only when it surfaces', async () => {
    const tree = await mountTree({ top: 0, client: 300, height: 1000 })
    // Hidden tree (the search panel owns the surface): the reveal is skipped
    // entirely — no flash while nobody can see it.
    await tree.rerender(['/tmp/a.ts'], 0, true)
    expect(revealedRow(tree).className).not.toContain('explorerRowFlash')
    // Surfacing with a FRESH reveal round plays the flash.
    await tree.rerender(['/tmp/a.ts'], 0, false)
    expect(revealedRow(tree).className).toContain('explorerRowFlashA')
    tree.unmount()
  })
})
