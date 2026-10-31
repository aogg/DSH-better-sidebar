/**
 * 「命令」页的「执行历史」tab 视图（CommandHistoryView + CommandsPageView
 * 的页内双 tab）：首拉渲染（新→旧、状态徽标、工具徽标、running 行）、关键字
 * 本地筛选、行点击展开详情（env 未记录提示 / 结果块）、再次运行的禁用与
 * mint 契约（parkCmdRun + openTab）、tab 切换回「命令」内容、WS ops 帧驱动
 * 的失效重拉与断线重连补拉（无计时器）。
 *
 * 文案断言钉 zh 串（测试环境的 navigator 显式置 zh-CN），裸子串不会在别的
 * 语言下碰巧通过。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { CommandHistoryView } from '../src/client/CommandHistoryView.tsx'
import { CommandsPageView } from '../src/client/CommandsPageView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api } from '../src/client/api.ts'
import { consumeCmdRun } from '../src/client/commands-open.ts'
import { CMD_RUN_TAB_TYPE } from '../src/commands-config.ts'
import { t } from '../src/client/locales.ts'
import type { ExecCommandRow } from '../src/command-history-extract.ts'
import type { Context } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'

/** 三行夹具：ok / fail / running（新→旧），覆盖工具名与后台徽标。 */
const ROWS: ExecCommandRow[] = [
  {
    callId: 'c3', tool: 'bash', seq: 9, time: 1_700_000_003_000,
    command: 'pnpm test', status: 'ok', exitCode: 0,
    resultText: 'all green\n[exit code: 0]', background: false,
  },
  {
    callId: 'c2', tool: 'pwsh', seq: 5, time: 1_700_000_002_000,
    command: 'Get-ChildItem', description: '列目录', workdir: `${MAIN}/packages`,
    status: 'fail', exitCode: 2, resultText: 'boom [exit code: 2]', background: false,
  },
  {
    callId: 'c1', tool: 'bash', seq: 2, time: 1_700_000_001_000,
    command: '', status: 'running', resultText: '', background: true,
  },
]

function mockHistory(rows: ExecCommandRow[], truncated = false): void {
  vi.spyOn(api, 'commandsExecHistory').mockResolvedValue({ rows, truncated })
}

/** ctx 的服务面：不给服务 → 运行能力缺席；给了 → fake 终端 + openTab 间谍。 */
function fakeContext(services?: { openTab: (seed: { type: string; title?: string }) => void }): Context {
  const get = (key: string): unknown => {
    if (services === undefined) return undefined
    if (key === 'webTerminals') return { view: () => undefined, close: () => undefined, recover: () => undefined }
    if (key === 'betterSidebar') return { isTabEnabled: () => true, openTab: services.openTab }
    return undefined
  }
  return { get } as unknown as Context
}

/** A controllable WebSocket double（changes-tab.spec 同款）。 */
class PushSocket {
  static readonly OPEN = 1
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) { pushSockets.push(this) }
  send(): void {}
  close(): void { this.closed = true }
}

const pushSockets: PushSocket[] = []

async function deliverOps(sessionId: string): Promise<void> {
  await act(async () => {
    for (const socket of pushSockets) {
      if (socket.closed || !socket.url.includes('/sidebar/ws/feed')) continue
      if (socket.readyState !== PushSocket.OPEN) { socket.readyState = 1; socket.onopen?.() }
      socket.onmessage?.({ data: JSON.stringify({ channel: 'session', sessionId, data: { kind: 'ops', sessionId, seq: 1 } }) })
    }
    await Promise.resolve()
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

interface MountOptions {
  ctx: Context
  sessionId?: string
  cwd?: string
}

async function mountView(options: MountOptions): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const element = createElement(CommandHistoryView, {
    ctx: options.ctx,
    store: createSidebarStore(),
    scope: { sessionId: options.sessionId ?? 'session', ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
  })
  await act(async () => { root.render(element) })
  await flushEffects()
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

/** 行的可点主区（展开/收起）。 */
function rowMain(container: HTMLElement, callId: string): HTMLButtonElement {
  const rows = [...container.querySelectorAll<HTMLButtonElement>('button[data-dsh-history-row]')]
  const row = rows.find(button => button.closest('[data-dsh-history-item]')?.getAttribute('data-dsh-history-item') === callId)
  expect(row, `history row ${callId}`).toBeDefined()
  return row!
}

async function mountPage(): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(CommandsPageView, {
      ctx: fakeContext(),
      store: createSidebarStore(),
      scope: { sessionId: 'session', cwd: MAIN },
    }))
  })
  await flushEffects()
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  pushSockets.length = 0
  vi.stubGlobal('WebSocket', PushSocket)
})

afterEach(() => {
  // 吃掉 parked seed，避免泄漏进下一个用例的断言。
  consumeCmdRun()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('CommandHistoryView', () => {
  it('首拉渲染：新→旧、状态/工具/后台徽标、running 行不渲染再次运行', async () => {
    mockHistory(ROWS)
    const view = await mountView({ ctx: fakeContext() })
    try {
      const items = [...view.container.querySelectorAll('[data-dsh-history-item]')]
      expect(items.map(item => item.getAttribute('data-dsh-history-item'))).toEqual(['c3', 'c2', 'c1'])
      expect(view.container.textContent).toContain('✓')
      expect(view.container.textContent).toContain('exit 2')
      expect(view.container.textContent).toContain(t('commandsHistoryStatusRunning'))
      expect(view.container.textContent).toContain('pwsh')
      expect(view.container.textContent).toContain('run_in_background')
      // 无命令文本的行没有再次运行按钮。
      const reruns = [...view.container.querySelectorAll<HTMLButtonElement>('[data-dsh-history-rerun]')]
      expect(reruns).toHaveLength(2)
    } finally {
      await view.unmount()
    }
  })

  it('筛选：command+description 不区分大小写子串，条数徽标随之更新', async () => {
    mockHistory(ROWS)
    const view = await mountView({ ctx: fakeContext() })
    try {
      const input = view.container.querySelector<HTMLInputElement>('input[data-dsh-history-filter]')
      expect(input).not.toBeNull()
      await act(async () => {
        // React 的受控输入去重认原型 setter：直接赋 .value 会被当作未变更。
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input!, 'get-child')
        input!.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await flushEffects()
      const items = [...view.container.querySelectorAll('[data-dsh-history-item]')]
      expect(items.map(item => item.getAttribute('data-dsh-history-item'))).toEqual(['c2'])
      expect(view.container.querySelector('[data-dsh-history-count]')!.textContent).toContain('1')
    } finally {
      await view.unmount()
    }
  })

  it('行点击展开详情：完整命令 / env 未记录提示 / 结果块；running 行显示运行中', async () => {
    mockHistory(ROWS)
    const view = await mountView({ ctx: fakeContext() })
    try {
      await act(async () => { rowMain(view.container, 'c2').click() })
      await flushEffects()
      const details = [...view.container.querySelectorAll('[data-dsh-history-detail]')]
      expect(details).toHaveLength(1)
      expect(details[0]!.textContent).toContain('Get-ChildItem')
      expect(details[0]!.textContent).toContain(t('commandsHistoryEnvUnrecorded'))
      expect(details[0]!.textContent).toContain('boom [exit code: 2]')
      // 再点同一行收起。
      await act(async () => { rowMain(view.container, 'c2').click() })
      await flushEffects()
      expect(view.container.querySelectorAll('[data-dsh-history-detail]')).toHaveLength(0)
      // running 行展开：结果区显示「运行中」。
      await act(async () => { rowMain(view.container, 'c1').click() })
      await flushEffects()
      expect(view.container.querySelector('[data-dsh-history-detail]')!.textContent)
        .toContain(t('commandsHistoryStatusRunning'))
    } finally {
      await view.unmount()
    }
  })

  it('无终端服务：再次运行按钮禁用并给提示行', async () => {
    mockHistory(ROWS)
    const view = await mountView({ ctx: fakeContext() })
    try {
      for (const button of view.container.querySelectorAll<HTMLButtonElement>('[data-dsh-history-rerun]')) {
        expect(button.disabled).toBe(true)
        expect(button.title).toBe(t('commandsRunUnavailable'))
      }
      expect(view.container.textContent).toContain(t('commandsRunUnavailable'))
    } finally {
      await view.unmount()
    }
  })

  it('有 fake 服务：点击再次运行 park seed + openTab（sourceKey history:<callId>，workdir 拼进命令行）', async () => {
    mockHistory(ROWS)
    const openTab = vi.fn()
    const view = await mountView({ ctx: fakeContext({ openTab }), cwd: MAIN })
    try {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>('[data-dsh-history-rerun]')]
        .find(candidate => candidate.closest('[data-dsh-history-item]')?.getAttribute('data-dsh-history-item') === 'c2')
      expect(button!.disabled).toBe(false)
      await act(async () => { button!.click() })
      expect(openTab).toHaveBeenCalledTimes(1)
      expect(openTab).toHaveBeenCalledWith({ type: CMD_RUN_TAB_TYPE, title: '列目录' })
      const seed = consumeCmdRun()
      expect(seed).toBeDefined()
      expect(seed!.sourceKey).toBe('history:c2')
      expect(seed!.commandline).toBe(`cd '${MAIN}/packages' && Get-ChildItem`)
    } finally {
      await view.unmount()
    }
  })

  it('WS ops 帧 → 一次重拉；断线重连 → onReconnect 补拉（无计时器）', async () => {
    mockHistory(ROWS)
    const spy = vi.spyOn(api, 'commandsExecHistory')
    const view = await mountView({ ctx: fakeContext() })
    try {
      expect(spy).toHaveBeenCalledTimes(1)
      await deliverOps('session')
      await flushEffects()
      expect(spy).toHaveBeenCalledTimes(2)
      // 断开再重连：recovered 分支触发 onReconnect 的补拉。
      await act(async () => {
        for (const socket of pushSockets) {
          if (!socket.url.includes('/sidebar/ws/feed') || socket.closed) continue
          socket.readyState = 0
          socket.onclose?.()
        }
      })
      await act(async () => {
        for (const socket of pushSockets) {
          if (socket.closed || !socket.url.includes('/sidebar/ws/feed')) continue
          socket.readyState = 1
          socket.onopen?.()
        }
        await Promise.resolve()
      })
      await flushEffects()
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      await view.unmount()
    }
  })

  it('接口失败静默降级：保留空列表 + 失败提示行', async () => {
    vi.spyOn(api, 'commandsExecHistory').mockRejectedValue(new Error('down'))
    const view = await mountView({ ctx: fakeContext() })
    try {
      expect(view.container.textContent).toContain(t('commandsHistoryLoadFailed'))
      expect(view.container.textContent).not.toContain(t('loading'))
    } finally {
      await view.unmount()
    }
  })
})

describe('CommandsPageView 页内双 tab', () => {
  it('默认「命令」；切「执行历史」拉取并渲染；切回「命令」内容原样', async () => {
    mockHistory([])
    const view = await mountPage()
    try {
      const tabs = [...view.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      expect(tabs.map(tab => tab.textContent)).toEqual([t('commandsPage'), t('commandsHistoryTab')])
      expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
      // 命令 tab：既有空态在。
      expect(view.container.textContent).toContain(t('commandsEmpty'))
      expect(view.container.querySelector('[data-dsh-commands-history]')).toBeNull()

      await act(async () => { tabs[1]!.click() })
      await flushEffects()
      expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
      expect(api.commandsExecHistory).toHaveBeenCalledTimes(1)
      expect(view.container.querySelector('[data-dsh-commands-history]')).not.toBeNull()
      expect(view.container.textContent).toContain(t('commandsHistoryEmpty'))
      expect(view.container.textContent).not.toContain(t('commandsEmpty'))

      await act(async () => { tabs[0]!.click() })
      await flushEffects()
      expect(view.container.querySelector('[data-dsh-commands-history]')).toBeNull()
      expect(view.container.textContent).toContain(t('commandsEmpty'))
    } finally {
      await view.unmount()
    }
  })
})
