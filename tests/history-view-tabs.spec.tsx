/**
 * 「历史发送」页签的顶 tab 与记录跳转（v0.28.16）：
 * - 顶 tab：当前会话（默认第一，payload scope:'session' + limit 50）/
 *   总发送历史（scope:'project' + limit 20）；切 tab = 完整 reload，两个
 *   tab 的 records 不串仓；
 * - ws `history` 帧：session tab 只合并当前 sessionId 的帧，project tab
 *   保持 watch 集逻辑（别的会话只要在 watch 集里就并入）；
 * - 跳转按钮：本会话的记录不重复 openSession，直接主视图定位（data-* 行
 *   命中 → 滚动 + 短暂高亮）；跨会话的记录先经 uiWorkspace.openSession 打
 *   开，定位不到就降级（按钮 title 换「已打开会话」说明）；宿主桥缺席静
 *   默不炸。api / session-push 模块级 mock（side-card-scope-tabs 手法），
 *   定位时长经 jumpLocateOptions 注入（不真等 5s）。
 * 分组展示与空文本占位（v0.28.27）：单条会话组不渲染组头（无边框平铺一
 * 行）、多条组头只有时间+条数（项目名不再重复、完整 sessionId 在 title）、
 * 空文本行渲染占位文案且无可点开的假交互、无文本记录可被 ws 后到的全文
 * 原位升级（不重复成两行）。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { HistorySendRecord } from '../src/prompt-history-extract.ts'

setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  SidebarApiError: class SidebarApiError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  api: {
    historyList: vi.fn(async () => ({ available: true, records: [], hasMore: false, seeding: false })),
    historyAnnotationsGet: vi.fn(async () => ({ version: 1, comments: {}, tags: {}, groups: [] })),
    historyAnnotationsUpdate: vi.fn(async () => ({ version: 1, comments: {}, tags: {}, groups: [] })),
  },
}))

// 注意顺序：vi.hoisted 放在 api mock 之后（实测放在它前面会让 api mock 工厂
// 失效——historyList 的 mockImplementation 落到另一个实例上，记录永远空页）。
/** connectSessionPush 的捕获状态：记录每次连接的帧回调（emitFrame 用最后一个）。 */
const { pushState } = vi.hoisted(() => ({
  pushState: { handlers: [] as ((frame: unknown) => void)[] },
}))

vi.mock('../src/client/session-push.ts', () => ({
  connectSessionPush: vi.fn((_sessionIds: readonly string[], onFrame: (frame: unknown) => void) => {
    pushState.handlers.push(onFrame)
    return () => { /* 测试用连接无需清理 */ }
  }),
}))

import { api } from '../src/client/api.ts'
import { HistoryView } from '../src/client/HistoryView.tsx'
import css from '../src/client/HistoryView.module.css'

beforeEach(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
  pushState.handlers.length = 0
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function rec(sessionId: string, seq: number, time: number, text: string): HistorySendRecord {
  return { key: `${sessionId}:${seq}`, sessionId, seq, time, text, textTruncated: false }
}

const CUR_RECORDS = [
  rec('cur', 0, 1_700_000_000_000, 'cur 的第一条提问'),
  rec('cur', 1, 1_700_000_001_000, 'cur 的第二条提问'),
]
const PROJECT_RECORDS = [
  rec('s2', 5, 1_700_000_010_000, 's2 要跳转的一条'),
  rec('cur', 0, 1_700_000_000_000, 'cur 的第一条提问'),
]

/** api.historyList 按 scope 发不同的页（两个 tab 的仓分开可辨）。 */
function mockHistoryListByScope(): void {
  ;(api.historyList as ReturnType<typeof vi.fn>).mockImplementation(async (payload: { scope?: string }) => ({
    available: true,
    records: payload.scope === 'session' ? CUR_RECORDS : PROJECT_RECORDS,
    hasMore: false,
    seeding: false,
  }))
}

interface JumpFace { openSession: ReturnType<typeof vi.fn> }

type HistoryViewProps = React.ComponentProps<typeof HistoryView>

/** 挂一个 HistoryView；uiWorkspaceFace 缺省给一个 openSession 间谍。 */
function mountView(options: { sessionId?: string; uiWorkspace?: JumpFace | 'absent'; jumpLocateOptions?: HistoryViewProps['jumpLocateOptions'] } = {}) {
  const face = options.uiWorkspace === 'absent' ? undefined : options.uiWorkspace ?? { openSession: vi.fn() }
  const ctx = { get: (name: string) => (name === 'uiWorkspace' ? face : undefined) }
  const view = renderRoot(createElement(HistoryView, {
    sessionId: options.sessionId ?? 'cur',
    ctx,
    ...(options.jumpLocateOptions !== undefined ? { jumpLocateOptions: options.jumpLocateOptions } : {}),
  } as unknown as HistoryViewProps))
  return { face: face as JumpFace, view }
}

function tabButton(label: string): HTMLButtonElement {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const node = tabs.find(tab => tab.textContent?.trim() === label)
  if (node === undefined) throw new Error(`scope tab ${label} not rendered`)
  return node
}

function click(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function jumpButton(key: string): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(`[data-dsh-history-jump="${key}"]`)
  if (node === null) throw new Error(`jump button for ${key} not rendered`)
  return node
}

/** 真定时器等待（act 作用域会扣住定时器调度的 React 提交——drip 的逐条
 *  上屏在 act 内轮询永远看不到，这里刻意在 act 外等待；act 警告是噪音）。 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, ms) })
}

/** 轮询等文本上屏（drip 一条 ~40ms，几十步足够）。 */
async function waitForText(text: string): Promise<void> {
  for (let step = 0; step < 60; step++) {
    if (document.body.textContent?.includes(text) === true) return
    await sleep(50)
  }
  expect(document.body.textContent).toContain(text)
}

/** 轮询等某条记录的跳转按钮上屏（主视图注入行可能与记录同文，不能拿文本等）。 */
async function waitForJump(key: string): Promise<HTMLButtonElement> {
  for (let step = 0; step < 60; step++) {
    const node = document.querySelector<HTMLButtonElement>(`[data-dsh-history-jump="${key}"]`)
    if (node !== null) return node
    await sleep(50)
  }
  return jumpButton(key)
}

describe('history view 顶 tab（当前会话 / 总发送历史）', () => {
  it('默认激活「当前会话」：payload scope=session + limit 50，只显示当前会话记录', async () => {
    mockHistoryListByScope()
    const { view } = mountView()
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(tabButton('Current Session').getAttribute('aria-selected')).toBe('true')
    expect(tabButton('All Sends').getAttribute('aria-selected')).toBe('false')
    await waitForText('cur 的第一条提问')
    expect(api.historyList).toHaveBeenCalledWith({ sessionId: 'cur', scope: 'session', limit: 50 })
    // project 仓的记录不在当前会话 tab 上。
    expect(document.body.textContent).not.toContain('s2 要跳转的一条')
    view.unmount()
  })

  it('切「总发送历史」= 完整 reload（scope=project + limit 20），切回不残留上一 tab 的记录', async () => {
    mockHistoryListByScope()
    const { view } = mountView()
    await waitForText('cur 的第一条提问')
    click(tabButton('All Sends'))
    expect(tabButton('All Sends').getAttribute('aria-selected')).toBe('true')
    await waitForText('s2 要跳转的一条')
    expect(api.historyList).toHaveBeenCalledWith({ sessionId: 'cur', scope: 'project', limit: 20 })
    // 会话 tab 的私有记录（cur:1 只在 session 仓里）不残留。
    expect(document.body.textContent).not.toContain('cur 的第二条提问')
    click(tabButton('Current Session'))
    await waitForText('cur 的第二条提问')
    expect(document.body.textContent).not.toContain('s2 要跳转的一条')
    view.unmount()
  })

  it('ws 合并不串仓：session tab 丢别的会话的帧；project tab 按 watch 集并入', async () => {
    mockHistoryListByScope()
    const { view } = mountView()
    await waitForText('cur 的第一条提问')
    // session tab：别的会话的帧绝不并入。
    act(() => {
      pushState.handlers.at(-1)?.({ kind: 'history', sessionId: 's2', records: [rec('s2', 0, 1, 's2 实时的一问')] })
    })
    await sleep(150)
    expect(document.body.textContent).not.toContain('s2 实时的一问')
    // 当前会话的帧照常并入（渐进队列 ~40ms/条）。
    act(() => {
      pushState.handlers.at(-1)?.({ kind: 'history', sessionId: 'cur', records: [rec('cur', 9, 9, 'cur 实时的一问')] })
    })
    await waitForText('cur 实时的一问')
    // 切 project tab：完整 reload 清掉会话 tab 的实时记录；别的会话的帧按
    // watch 集并入（s2 的记录已在仓里 → 在 watch 集内）。
    click(tabButton('All Sends'))
    await waitForText('s2 要跳转的一条')
    expect(document.body.textContent).not.toContain('cur 实时的一问')
    act(() => {
      pushState.handlers.at(-1)?.({ kind: 'history', sessionId: 's2', records: [rec('s2', 6, 10, 's2 实时的二问')] })
    })
    await waitForText('s2 实时的二问')
    view.unmount()
  })
})

describe('history view 记录跳转', () => {
  it('本会话的记录：不重复 openSession，主视图 data-* 行命中 → 滚动 + 短暂高亮后复原', async () => {
    mockHistoryListByScope()
    // 主视图 DOM：宿主的稳定滚动容器 + 用户消息 flow 行。
    const scrollport = document.createElement('div')
    scrollport.setAttribute('data-conversation-scroll', '')
    const row = document.createElement('div')
    row.setAttribute('data-chat-flow-key', 'f1')
    row.setAttribute('data-chat-flow-kind', 'user')
    row.textContent = 'cur 的第一条提问'
    scrollport.append(row)
    document.body.append(scrollport)
    const scrollTo = vi.fn((_options?: ScrollToOptions) => {})
    ;(scrollport as unknown as { scrollTo: unknown }).scrollTo = scrollTo

    const { face, view } = mountView({ jumpLocateOptions: { timeoutMs: 500, highlightMs: 40 } })
    await waitForJump('cur:0')
    click(jumpButton('cur:0'))
    // 立即定位路径：命中后滚动 + 高亮标记（等待渲染/定位的定时器步进）。
    for (let step = 0; step < 20 && scrollTo.mock.calls.length === 0; step++) {
      await sleep(50)
    }
    expect(scrollTo.mock.calls.length).toBeGreaterThan(0)
    expect(face.openSession).not.toHaveBeenCalled()
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    expect(row.dataset.dshHistoryHighlight).toBe('1')
    // 高亮到点复原（直接 DOM 定时器写回，不经 React）。
    await sleep(140)
    expect(row.dataset.dshHistoryHighlight).toBeUndefined()
    view.unmount()
  })

  it('跨会话的记录：先 uiWorkspace.openSession；定位不到就降级（title 换「已打开会话」）', async () => {
    mockHistoryListByScope()
    const { face, view } = mountView({ jumpLocateOptions: { timeoutMs: 150, highlightMs: 20 } })
    click(tabButton('All Sends'))
    await waitForJump('s2:5')
    click(jumpButton('s2:5'))
    expect(face.openSession).toHaveBeenCalledWith('s2')
    // 主视图里没有那条消息（也没造 DOM）：等定位超时 → 降级说明上 title。
    for (let step = 0; step < 40; step++) {
      if (jumpButton('s2:5').title.includes('Session opened')) break
      await sleep(50)
    }
    expect(jumpButton('s2:5').title).toContain('Session opened')
    view.unmount()
  })

  it('宿主桥缺席（无 uiWorkspace）：跨会话跳转静默不炸，title 保持默认', async () => {
    mockHistoryListByScope()
    const { view } = mountView({ uiWorkspace: 'absent', jumpLocateOptions: { timeoutMs: 150, highlightMs: 20 } })
    click(tabButton('All Sends'))
    await waitForJump('s2:5')
    expect(() => { click(jumpButton('s2:5')) }).not.toThrow()
    await sleep(250)
    expect(jumpButton('s2:5').title).toContain('Jump to this prompt')
    expect(jumpButton('s2:5').title).not.toContain('Session opened')
    view.unmount()
  })
})

describe('history view 分组展示与空文本占位（v0.28.27）', () => {
  // 一个项目页：solo 会话（1 条）、multi 会话（2 条）、ghost 会话（1 条空文本）。
  const GROUPED_RECORDS = [
    rec('solo', 0, 1_700_000_020_000, 'solo 会话只有这一条'),
    rec('multi', 1, 1_700_000_011_000, 'multi 的第二条'),
    rec('multi', 0, 1_700_000_010_000, 'multi 的第一条'),
    rec('ghost', 0, 1_700_000_030_000, ''),
  ]

  /** api.historyList：session 页给空，project 页带 project.cwd 返回分组页。 */
  function mockHistoryListProjectGroups(): void {
    ;(api.historyList as ReturnType<typeof vi.fn>).mockImplementation(async (payload: { scope?: string }) => ({
      available: true,
      records: payload.scope === 'session' ? [] : GROUPED_RECORDS,
      hasMore: false,
      seeding: false,
      project: { cwd: '/code/www/my/github/DSH-better-sidebar' },
    }))
  }

  /** 挂载视图并切到「总发送历史」tab，等分组页上屏后返回 mount 结果。 */
  async function openProjectTab(): Promise<ReturnType<typeof mountView>> {
    mockHistoryListProjectGroups()
    const mounted = mountView()
    click(tabButton('All Sends'))
    await waitForText('multi 的第一条')
    return mounted
  }

  it('单条会话组不渲染组头（无边框平铺），多条组头 = 时间+条数（无项目名，title=完整 sessionId）', async () => {
    const { view } = await openProjectTab()
    // solo 组：没有 <header>，行照常上屏，且挂上去边框类。
    const solo = document.querySelector<HTMLElement>('[data-dsh-history-session="solo"]')
    expect(solo).not.toBeNull()
    expect(solo!.querySelector('header')).toBeNull()
    expect(solo!.classList.contains(css.sessionGroupSolo!)).toBe(true)
    expect(document.querySelector('[data-dsh-history-record="solo:0"]')).not.toBeNull()
    // multi 组：组头存在 = 时间 + 条数（'2 records'），不含项目名与 sessionId。
    const head = document.querySelector<HTMLElement>('[data-dsh-history-session="multi"] header')
    expect(head).not.toBeNull()
    expect(head!.textContent).toContain('2 records')
    expect(head!.textContent).not.toContain('DSH-better-sidebar')
    expect(head!.getAttribute('title')).toBe('multi')
    for (const node of document.querySelectorAll('[data-dsh-history-session] header')) {
      expect(node.textContent).not.toContain('DSH-better-sidebar')
    }
    view.unmount()
  })

  it('空文本行渲染占位文案（次级键），且没有可点开展开的假交互（无 role="button" 正文）', async () => {
    const { view } = await openProjectTab()
    await waitForText('(no text captured)')
    const ghost = document.querySelector<HTMLElement>('[data-dsh-history-session="ghost"]')
    expect(ghost).not.toBeNull()
    // 正文区不是可点开的 role="button"（评论/跳转 chip 是原生 button，不算）。
    expect(ghost!.querySelector('div[role="button"]')).toBeNull()
    // 对照组：有文本的行仍保留可点开展开的正文。
    expect(document.querySelector('[data-dsh-history-session="multi"] div[role="button"]')).not.toBeNull()
    view.unmount()
  })

  it('无文本记录可升级：ws 后到的全文原位替换占位，同一条记录不重复成两行', async () => {
    const { view } = await openProjectTab()
    await waitForText('(no text captured)')
    act(() => {
      pushState.handlers.at(-1)?.({
        kind: 'history',
        sessionId: 'ghost',
        records: [rec('ghost', 0, 1_700_000_030_000, 'ghost 补来的完整正文')],
      })
    })
    await waitForText('ghost 补来的完整正文')
    expect(document.querySelectorAll('[data-dsh-history-record="ghost:0"]')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('(no text captured)')
    view.unmount()
  })
})
