/**
 * 「搜索」页（SearchView）单测（设计稿 §8 / §4）：
 *
 * - 分组渲染：结果按文件分组（host 顺序 = 路径字典序）、块 = 命中行高亮 +
 *   上下各 2 行（search-blocks 合并）、文件头命中数与两级截断标记（文件级
 *   「truncated」+ 全局底部提示）；
 * - 「查看」按钮带块首命中行回调 openSidebarFile；双击命中行打开该行；
 * - Enter 提交：meta 落盘（query + runId 自增）、标题变 `Search: "…"`（超
 *   24 个 UTF-16 字符截断加 …）、历史落 storage；
 * - 自动重跑规则：chips / 开关变化（结果已展示时）自动重跑，查询词草稿
 *   变化绝不自动跑；历史回填三项不自动执行（Enter / runId 越过跳过闸）；
 * - 正则非法：本地行内报错、Enter 不发请求（宿主 bad-request 只是兜底）；
 * - visible=false：不发起新搜索、不打断在途；隐藏期间的 form 变化欠着，
 *   reveal 后补跑并中止在途旧请求（AbortController 契约）；
 * - meta 持久化：挂载时 query 非空按持久化的开关/chips 自动重跑；清空按钮
 *   清 query 并把标题送回「Search」。
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SearchView } from '../src/client/SearchView.tsx'
// Type-only: gives the mocked fsContentSearch fn the REAL api signature, so
// `mock.calls` entries stay typed (the same trick the tree specs use).
import type { api } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { SEARCH_HISTORY_KEY } from '../src/client/search-history.ts'
import { consumeSearchSeed } from '../src/client/search-seed.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so the page's copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { fsContentSearch } = vi.hoisted(() => ({
  fsContentSearch: vi.fn<typeof api.fsContentSearch>(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: { fsContentSearch },
}))

// The open action is asserted as a unit: the sidebar-file module needs a live
// host bridge, which the page contract abstracts away (ctx + session + line).
const { openSidebarFile } = vi.hoisted(() => ({
  openSidebarFile: vi.fn(),
}))
vi.mock('../src/client/sidebar-file.ts', () => ({
  openSidebarFile,
}))

/** The v2 wire answer the happy-path tests run on. `docs/guide.md` is
 *  file-truncated (count 2 > 1 hit); the top level carries the global flag. */
const RESULT = {
  matches: [
    {
      path: 'src/a.ts',
      count: 3,
      truncated: false,
      hits: [
        { line: 3, column: 6, length: 6, text: 'const answer = 42', before: ['one', 'two'], after: ['four', 'five'] },
        { line: 6, column: 0, length: 6, text: 'answer again', before: [], after: ['seven'] },
      ],
    },
    {
      path: 'docs/guide.md',
      count: 2,
      truncated: true,
      hits: [
        { line: 2, column: 4, length: 6, text: 'The Answer is 42', before: ['head'], after: [] },
      ],
    },
  ],
  truncated: true,
}
type Result = typeof RESULT

/** A deferred fsContentSearch: tests hold the resolver and the live signal. */
interface Deferred {
  resolve: (value: Result) => void
  signal: AbortSignal
}
function pendingImplementation(deferrals: Deferred[]): void {
  fsContentSearch.mockImplementation((_scope, _query, _include, _exclude, _pref, _match, signal) =>
    new Promise<Result>((resolve) => {
      deferrals.push({ resolve, signal: signal! })
    }))
}

interface Harness {
  container: HTMLDivElement
  updateTab: ReturnType<typeof vi.fn>
  /** Swap the tab record the way the real seat does after updateTab lands. */
  setTab: (meta: Record<string, unknown>, title?: string) => void
  setVisible: (visible: boolean) => void
  unmount: () => void
}

function mountView(
  meta: Record<string, unknown> = {},
  options: { visible?: boolean; title?: string } = {},
): Harness {
  const store = createSidebarStore()
  const updateTab = vi.fn()
  const ctx = {
    betterSidebar: { updateTab },
    get: (name: string) => name === 'betterSidebar' ? { updateTab } : undefined,
  } as unknown as Context
  let current: SidebarTab = { id: 'search:t1', type: 'search', title: options.title ?? 'Search', meta }
  let visible = options.visible !== false
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const render = (): void => {
    root.render(createElement(SearchView, {
      ctx,
      store,
      scope: { sessionId: 's1', cwd: '/tmp' },
      tab: current,
      visible,
    } satisfies ComponentProps<typeof SearchView>))
  }
  act(render)
  return {
    container,
    updateTab,
    setTab(meta2: Record<string, unknown>, title?: string): void {
      current = { ...current, title: title ?? current.title, meta: meta2 }
      act(render)
    },
    setVisible(next: boolean): void {
      visible = next
      act(render)
    },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Replay the seat's re-render with the LAST updateTab patch (the store
 *  round-trip the real app performs; the harness must simulate it). */
function applyLastUpdate(harness: Harness): void {
  const call = harness.updateTab.mock.calls.at(-1)
  if (call === undefined) throw new Error('updateTab was never called')
  const patch = call[1] as { title?: string; meta?: Record<string, unknown> }
  harness.setTab(patch.meta ?? {}, patch.title)
}

function queryInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('input[aria-label="Search"]')!
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressKey(input: HTMLInputElement, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

async function clickButton(container: HTMLElement, ariaLabel: string): Promise<void> {
  const node = container.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`)
  if (node === null) throw new Error(`button not found: ${ariaLabel}`)
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Drain the mocked request promise inside act (the view's .then setState). */
async function flushResults(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

let harness: Harness | undefined
beforeEach(() => {
  window.localStorage.clear()
  consumeSearchSeed()
  fsContentSearch.mockReset()
})
afterEach(() => {
  harness?.unmount()
  harness = undefined
  document.body.innerHTML = ''
})

describe('SearchView 分组渲染与打开', () => {
  it('runs once on mount from the persisted meta and renders the merged blocks', async () => {
    fsContentSearch.mockResolvedValue(RESULT)
    harness = mountView({ query: 'answer', runId: 1 })
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    const [scope, query, include, exclude, prefExclude, match, signal] = fsContentSearch.mock.calls[0]!
    expect(scope).toEqual({ sessionId: 's1', cwd: '/tmp' })
    expect(query).toBe('answer')
    expect(include).toEqual([])
    expect(exclude).toEqual([])
    // The store's DEFAULT explorerExclude preference rides along (the same
    // probe the tree and the name search carry).
    expect(prefExclude).toEqual(['.DS_Store', 'Thumbs.db'])
    expect(match).toEqual({ caseSensitive: false, wholeWord: false, regex: false })
    expect(signal).toBeInstanceOf(AbortSignal)
    await flushResults()
    // Grouped by file in the host's (path-sorted) order.
    const files = [...harness.container.querySelectorAll('[data-dsh-search-file]')]
    expect(files.map(file => file.getAttribute('data-dsh-search-file'))).toEqual(['src/a.ts', 'docs/guide.md'])
    // The two adjacent hits merged into ONE block (windows [1..5] + [4..8]).
    const block = files[0]!.querySelector('[data-dsh-search-block]')!
    const lines = [...block.querySelectorAll('[data-dsh-search-line]')]
    expect(lines.map(line => line.getAttribute('data-dsh-search-line'))).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    // The hit line renders the verbatim text with the sliced <mark> span.
    const hitLine = block.querySelector('[data-dsh-search-line="3"]')!
    expect(hitLine.textContent).toContain('const answer = 42')
    expect(hitLine.querySelectorAll('mark')).toHaveLength(1)
    expect(hitLine.querySelector('mark')!.textContent).toBe('answer')
    // File heads carry the TRUE totals; the two truncation tiers are honest.
    expect(files[0]!.textContent).toContain('3 matches')
    expect(files[0]!.textContent).not.toContain('truncated')
    expect(files[1]!.textContent).toContain('2 matches')
    expect(files[1]!.textContent).toContain('truncated')
    expect(harness.container.textContent).toContain('Too many results')
    expect(harness.container.textContent).toContain('2 files · 5 matches')
  })

  it('the View button opens the block\'s FIRST hit line; double-click opens the clicked line', async () => {
    fsContentSearch.mockResolvedValue(RESULT)
    harness = mountView({ query: 'answer', runId: 1 })
    await flushResults()
    // One「View」per block, on the block's first hit row.
    const views = [...harness.container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent === 'View')
    expect(views).toHaveLength(2)
    views[0]!.click()
    expect(openSidebarFile).toHaveBeenCalledWith(expect.anything(), 's1', '/tmp/src/a.ts', 3)
    views[1]!.click()
    expect(openSidebarFile).toHaveBeenLastCalledWith(expect.anything(), 's1', '/tmp/docs/guide.md', 2)
    // Double-clicking ANY hit line opens THAT line (line 6 is a hit with no
    // view button of its own); context lines are not clickable.
    const line = harness.container.querySelector('[data-dsh-search-line="6"]')!
    await act(async () => { line.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(openSidebarFile).toHaveBeenLastCalledWith(expect.anything(), 's1', '/tmp/src/a.ts', 6)
    const ctxLine = harness.container.querySelector('[data-dsh-search-line="1"]')!
    await act(async () => { ctxLine.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(openSidebarFile).toHaveBeenCalledTimes(3)
  })
})

describe('SearchView 提交与标题', () => {
  it('Enter commits: meta lands (query + runId), the title becomes Search: "…", history records', async () => {
    fsContentSearch.mockResolvedValue({ matches: [], truncated: false })
    harness = mountView({})
    expect(fsContentSearch).not.toHaveBeenCalled() // empty meta: no auto-run
    await typeInto(queryInput(harness.container), 'hello')
    await pressKey(queryInput(harness.container), 'Enter')
    // The commit wrote the tab record (title + query + FIRST runId)…
    expect(harness.updateTab.mock.calls[0]![0]).toBe('search:t1')
    const patch = harness.updateTab.mock.calls[0]![1] as { title: string; meta: Record<string, unknown> }
    expect(patch.title).toBe('Search: "hello"')
    expect(patch.meta).toEqual({ query: 'hello', runId: 1 })
    // …recorded the history…
    expect(window.localStorage.getItem(SEARCH_HISTORY_KEY)).toContain('hello')
    // …and did NOT auto-run on the draft typing: only the committed query
    // runs, which lands when the store round-trip re-renders the seat.
    expect(fsContentSearch).not.toHaveBeenCalled()
    applyLastUpdate(harness)
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    expect(fsContentSearch.mock.calls[0]![1]).toBe('hello')
  })

  it('a title query longer than 24 UTF-16 chars truncates with … in the record title', async () => {
    fsContentSearch.mockResolvedValue({ matches: [], truncated: false })
    harness = mountView({})
    const long = 'a'.repeat(30)
    await typeInto(queryInput(harness.container), long)
    await pressKey(queryInput(harness.container), 'Enter')
    const patch = harness.updateTab.mock.calls[0]![1] as { title: string }
    expect(patch.title).toBe(`Search: "${'a'.repeat(24)}…"`)
  })
})

describe('SearchView 自动重跑规则', () => {
  it('chips and toggles rerun when results are shown; the draft never runs by itself', async () => {
    fsContentSearch.mockResolvedValue(RESULT)
    harness = mountView({ query: 'answer', runId: 1 })
    await flushResults()
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    // A chip commit (Enter in the include input) reruns with the new scope…
    const includeInput = [...harness.container.querySelectorAll<HTMLInputElement>('input')]
      .find(input => input.placeholder.startsWith('Include'))!
    await typeInto(includeInput, 'src')
    await pressKey(includeInput, 'Enter')
    const chipPatch = harness.updateTab.mock.calls.at(-1)![1] as { meta: Record<string, unknown> }
    expect(chipPatch.meta.include).toEqual(['src'])
    applyLastUpdate(harness)
    expect(fsContentSearch).toHaveBeenCalledTimes(2)
    expect(fsContentSearch.mock.calls[1]![2]).toEqual(['src'])
    // …a toggle reruns with the new matcher…
    await clickButton(harness.container, 'match case')
    applyLastUpdate(harness)
    expect(fsContentSearch).toHaveBeenCalledTimes(3)
    expect(fsContentSearch.mock.calls[2]![5]).toEqual({ caseSensitive: true, wholeWord: false, regex: false })
    // …but TYPING the query draft never fires (Enter commits, §4.5).
    await typeInto(queryInput(harness.container), ' answer')
    expect(fsContentSearch).toHaveBeenCalledTimes(3)
  })

  it('history backfill fills query+include+exclude WITHOUT running; Enter runs it', async () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify([
      { query: 'legacy', include: ['src'], exclude: ['dist'], at: 5 },
    ]))
    fsContentSearch.mockResolvedValue({ matches: [], truncated: false })
    harness = mountView({ query: 'answer', runId: 1 })
    await flushResults()
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    // Open the dropdown and pick the entry.
    await clickButton(harness.container, 'Search history')
    const panel = harness.container.querySelector('[data-dsh-search-history]')
    expect(panel).not.toBeNull()
    const item = panel!.querySelector('[role="option"]')
    expect(item?.textContent).toContain('legacy')
    await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // The three form fields landed; runId did NOT move (回填 ≠ 运行)…
    const patch = harness.updateTab.mock.calls.at(-1)![1] as { meta: Record<string, unknown> }
    expect(patch.meta).toEqual({ query: 'legacy', runId: 1, include: ['src'], exclude: ['dist'] })
    applyLastUpdate(harness)
    // …and the pinned form change never auto-ran.
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    // The draft followed the committed query: Enter commits it for real.
    await pressKey(queryInput(harness.container), 'Enter')
    applyLastUpdate(harness)
    expect(fsContentSearch).toHaveBeenCalledTimes(2)
    expect(fsContentSearch.mock.calls[1]![1]).toBe('legacy')
    expect(fsContentSearch.mock.calls[1]![2]).toEqual(['src'])
    expect(fsContentSearch.mock.calls[1]![3]).toEqual(['dist'])
  })
})

describe('SearchView 正则与可见性', () => {
  it('an illegal regex is intercepted locally: inline hint, Enter never requests', async () => {
    fsContentSearch.mockResolvedValue({ matches: [], truncated: false })
    harness = mountView({ regex: true })
    expect(fsContentSearch).not.toHaveBeenCalled()
    await typeInto(queryInput(harness.container), '(')
    const hint = harness.container.querySelector('[class*="hintBad"]')
    expect(hint?.textContent).toContain('Invalid regular expression')
    await pressKey(queryInput(harness.container), 'Enter')
    expect(harness.updateTab).not.toHaveBeenCalled()
    expect(fsContentSearch).not.toHaveBeenCalled()
    // A compilable draft clears the hint and commits normally.
    await typeInto(queryInput(harness.container), 'ok')
    expect(harness.container.querySelector('[class*="hintBad"]')).toBeNull()
    await pressKey(queryInput(harness.container), 'Enter')
    applyLastUpdate(harness)
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    expect(fsContentSearch.mock.calls[0]![5]).toEqual({ caseSensitive: false, wholeWord: false, regex: true })
  })

  it('visible=false neither starts nor interrupts; the owed run fires on reveal', async () => {
    const deferrals: Deferred[] = []
    pendingImplementation(deferrals)
    harness = mountView({ query: 'answer', runId: 1 })
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    // Docked to the background: the in-flight request is NOT interrupted…
    harness.setVisible(false)
    expect(deferrals[0]!.signal.aborted).toBe(false)
    // …and a form change while hidden stays OWED (no request, no abort).
    harness.setTab({ query: 'answer', runId: 1, include: ['src'] })
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    expect(deferrals[0]!.signal.aborted).toBe(false)
    // Revealing catches up: the owed run fires and aborts the stale one.
    harness.setVisible(true)
    expect(fsContentSearch).toHaveBeenCalledTimes(2)
    expect(deferrals[0]!.signal.aborted).toBe(true)
    expect(fsContentSearch.mock.calls[1]![2]).toEqual(['src'])
    deferrals[1]!.resolve(RESULT)
    await flushResults()
    expect(harness.container.querySelectorAll('[data-dsh-search-file]')).toHaveLength(2)
  })

  it('a NEVER-started query does not fire while hidden, and starts on reveal', async () => {
    fsContentSearch.mockResolvedValue(RESULT)
    harness = mountView({ query: 'answer', runId: 1 }, { visible: false })
    expect(fsContentSearch).not.toHaveBeenCalled()
    harness.setVisible(true)
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    await flushResults()
    expect(harness.container.querySelectorAll('[data-dsh-search-file]')).toHaveLength(2)
  })
})

describe('SearchView meta 持久化与清空', () => {
  it('a restored meta runs ONCE with its toggles and chips; Clear resets query and title', async () => {
    fsContentSearch.mockResolvedValue({ matches: [], truncated: false })
    harness = mountView({
      query: 'x', caseSensitive: true, wholeWord: true, include: ['src'], exclude: ['dist'], runId: 2,
    })
    expect(fsContentSearch).toHaveBeenCalledTimes(1)
    expect(fsContentSearch.mock.calls[0]![2]).toEqual(['src'])
    expect(fsContentSearch.mock.calls[0]![3]).toEqual(['dist'])
    expect(fsContentSearch.mock.calls[0]![5]).toEqual({ caseSensitive: true, wholeWord: true, regex: false })
    // The × clears the input and the results: query → '' in meta, and the
    // title (already「Search」) gets no redundant write.
    await clickButton(harness.container, 'Clear')
    const patch = harness.updateTab.mock.calls.at(-1)![1] as { title?: string; meta: Record<string, unknown> }
    expect(patch.meta.query).toBe('')
    expect(patch.title).toBeUndefined()
    applyLastUpdate(harness)
    await flushResults()
    expect(fsContentSearch).toHaveBeenCalledTimes(1) // the empty query never fires
    expect(harness.container.querySelector('[data-dsh-search-file]')).toBeNull()
  })
})
