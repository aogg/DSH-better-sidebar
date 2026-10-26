/**
 * guide 分块（宿主 guide 起始页 portal 替换，src/client/native/guide-blocks.tsx）。
 *
 * 宿主 DOM 用假结构模拟（`[data-sidebar-right-guide]` + 罗盘 hero span + 含
 * `[data-slot="sidebar.right.tab.guide.entry"]` 的宿主入口 cell，与
 * start-links.spec 的假宿主同一手法）；service 用最小假体（native-surface.spec
 * 的注册表假体思路：getTabs/isTabEnabled/getTab/subscribe/subscribeState/openTab）。
 * 生产里 `files` 不是注册表描述符——它是 native/index.ts 的 files takeover，
 * 页面身份即 editor 描述符——所以假注册表放 editor 而不放 files，分块的
 * files tile 由 `isTabEnabled('editor')` 合成。钉住五件事：注入唯一
 * `data-dsh-guide-blocks` 隐藏样式且宿主入口 cell 仍在 DOM（仅 CSS 隐藏）、
 * portal 挂在 guide 根末尾、workspace/session/more 三块的 tile kind 集合
 * （含合成 terminal tile 与 guide 可见过滤）、tile 点击路由（已知 kind 走
 * openStartLink 的 service.openTab 参数、外部 kind 直通、设置不走 openTab）、
 * disposer / 宿主替换根 / 根移除的收敛与无残留。
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { createElement } from 'react'
import { setupReactAct } from './test-utils.ts'
import { registerGuideBlocks } from '../src/client/native/guide-blocks.tsx'
import { t } from '../src/client/locales.ts'
import type { BetterSidebarService, TabDescriptor } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'

setupReactAct()

// The module graph reaches the plugin api via start-links.tsx's settings page;
// nothing in these cases opens it — keep the RPC inert (start-links.spec 手法).
vi.mock('../src/client/api.ts', () => ({
  api: {
    settingsGet: vi.fn(async () => ({ value: {}, revision: 7 })),
    settingsUpdate: vi.fn(async (patch: Record<string, unknown>) => ({ value: patch, revision: 8 })),
  },
}))

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

/** 每个用例的注册句柄登记处（afterEach 兜底清理，防单用例失败泄漏 portal）。 */
const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) act(() => { dispose() })
  for (const node of document.querySelectorAll('[data-dsh-test-slot]')) node.remove()
  for (const node of document.querySelectorAll('[data-dsh-guide-blocks-host]')) node.remove()
})

/** 假宿主 guide 根：罗盘 hero span + 一个宿主入口 cell（`>div` 内含 guide entry 槽）。 */
function mountGuide(): { root: HTMLDivElement; entryCell: HTMLDivElement; compass: HTMLSpanElement } {
  const root = document.createElement('div')
  root.setAttribute('data-sidebar-right-guide', '')
  root.setAttribute('data-dsh-test-slot', '')
  const compass = document.createElement('span')
  compass.setAttribute('aria-hidden', 'true')
  compass.textContent = 'compass hero'
  const entryCell = document.createElement('div')
  const entry = document.createElement('div')
  entry.setAttribute('data-slot', 'sidebar.right.tab.guide.entry')
  entry.textContent = 'host guide entry'
  entryCell.appendChild(entry)
  root.append(compass, entryCell)
  document.body.appendChild(root)
  return { root, entryCell, compass }
}

/** 函数图标假体（ReactNode 图标会被丢弃，函数图标才渲染——native 注册的 guideIconOf 同款）。 */
const fakeIcon = (name: string) => (size: number) => createElement('i', { 'data-fake-icon': name, size })

/** 描述符假体补上必填的 component（分块只读元数据，组件体不会被渲染）。 */
const tabOf = (descriptor: Omit<TabDescriptor, 'component'>): TabDescriptor => ({ component: () => null, ...descriptor })

/**
 * 最小注册表（顺序即分块内 tile 的 order 排序）：editor 在注册表里但绝不
 * 出自己的 tile；其余 builtin + 一个外部插件 kind（`dsh-context`）。
 */
const BASE_TABS: readonly TabDescriptor[] = [
  tabOf({ id: 'editor', title: 'Editor', description: 'Browse the tree', icon: fakeIcon('editor'), order: 5 }),
  tabOf({ id: 'search', title: 'Search', description: 'Find in files', icon: fakeIcon('search'), order: 20 }),
  tabOf({ id: 'git', title: 'Changes', order: 30 }),
  tabOf({ id: 'subagent', title: 'Tasks', order: 40 }),
  tabOf({ id: 'sidechat', title: 'Side chat', order: 50 }),
  tabOf({ id: 'history', title: 'History', order: 60 }),
  tabOf({ id: 'settings', title: 'Settings', order: 70 }),
  tabOf({ id: 'webview', title: 'Webview pages', order: 80 }),
  tabOf({ id: 'commands', title: 'Commands', order: 90 }),
  tabOf({ id: 'dsh-context', title: 'Context pack', order: 95 }),
]

interface ServiceOptions {
  tabs?: readonly TabDescriptor[]
  enabled?: Record<string, boolean>
}

/** 假 service：注册表 + 启用开关 + 订阅面 + openTab 取证（collectGuideTiles 只消费这些）。 */
function fakeService(options: ServiceOptions = {}): {
  service: BetterSidebarService
  openTab: ReturnType<typeof vi.fn>
  notify: () => void
  setEnabled: (id: string, value: boolean) => void
} {
  const tabs = options.tabs ?? BASE_TABS
  const enabled: Record<string, boolean> = { ...options.enabled }
  const listeners = new Set<() => void>()
  const openTab = vi.fn()
  const service = {
    getTabs: () => tabs,
    getTab: (id: string) => tabs.find(descriptor => descriptor.id === id),
    isTabEnabled: (id: string) => enabled[id] !== false,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    subscribeState: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    openTab: (input: { type: string }) => { openTab(input) },
  } as unknown as BetterSidebarService
  return {
    service,
    openTab,
    notify: () => { for (const listener of [...listeners]) listener() },
    setEnabled: (id, value) => { enabled[id] = value },
  }
}

interface CtxOptions {
  mounted?: string | undefined
  openTab?: (kind: string, options?: unknown) => void
}

/** 最小 ctx 假体：sidebarRight（mounted + openTab），无快捷键目录（静态键帽回退）。 */
function makeCtx(options: CtxOptions = {}): Context {
  const sidebarRight = {
    mounted: {
      getSnapshot: (): string | undefined => options.mounted,
      subscribe: (_fn: () => void) => () => {},
    },
    ...(options.openTab !== undefined ? { openTab: options.openTab } : {}),
  }
  return {
    get: (name: string) => (name === 'sidebarRight' ? sidebarRight : undefined),
  } as unknown as Context
}

/** MutationObserver 回调跑在微任务里：一个宏任务把「变更 → 同步 → 渲染」冲完。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

function click(node: Element): void {
  act(() => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** portal 内容里的 tile kind 序（选择器限定 div，避免撞上 head 里同名的 style 标签）。 */
function tileKindsOf(block: string): string[] {
  return [...document.querySelectorAll(`div[data-dsh-guide-blocks] section[data-dsh-guide-block="${block}"] [data-dsh-guide-tile]`)]
    .map(node => node.getAttribute('data-dsh-guide-tile') ?? '')
}

function clickTile(kind: string): void {
  const node = document.querySelector(`div[data-dsh-guide-blocks] [data-dsh-guide-tile="${kind}"]`)
  if (node === null) throw new Error(`missing guide tile: ${kind}`)
  click(node)
}

describe('guide 分块（宿主 guide 起始页 portal 替换）', () => {
  it('注册后注入唯一 data-dsh-guide-blocks 隐藏样式，portal 挂在 guide 根末尾，宿主入口 cell 仍在 DOM（仅 CSS 隐藏）', async () => {
    const { root, entryCell, compass } = mountGuide()
    const { service } = fakeService()
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx(), service) })
    disposers.push(dispose)
    await flush()
    // 唯一的标记样式标签：内容是注入的那条隐藏规则（宿主钩子 + display: none）。
    const styles = document.head.querySelectorAll('style[data-dsh-guide-blocks]')
    expect(styles).toHaveLength(1)
    expect(styles[0]!.textContent).toContain('display: none')
    expect(styles[0]!.textContent).toContain('[data-sidebar-right-guide]')
    expect(styles[0]!.textContent).toContain("sidebar.right.tab.guide.entry")
    // portal 内容挂在 guide 根末尾：宿主 div（data-dsh-guide-blocks-host）是根的
    // 最后一个子节点，React 分块容器是它的孩子。
    const portal = root.querySelector('div[data-dsh-guide-blocks]')
    expect(portal, '分块容器必须存在').not.toBeNull()
    expect(portal!.parentElement?.getAttribute('data-dsh-guide-blocks-host')).toBe('')
    expect(portal!.parentElement?.parentElement).toBe(root)
    expect(root.lastElementChild).toBe(portal!.parentElement)
    // 宿主自己的内容原样保留（CSS 隐藏而非 DOM 移除）：入口 cell 与罗盘 hero 都在。
    expect(root.contains(entryCell), '宿主入口 cell 必须仍在 DOM').toBe(true)
    expect(root.contains(compass), '罗盘 hero 必须保留').toBe(true)
    expect(document.querySelectorAll('div[data-dsh-guide-blocks]')).toHaveLength(1)
  })

  it('三个分块与 tile kind 集合：workspace(files/search/git)、session(合成 terminal + subagent/sidechat/history)、more(settings/webview/commands/dsh-context)', async () => {
    mountGuide()
    const { service } = fakeService()
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx(), service) })
    disposers.push(dispose)
    await flush()
    const blocks = [...document.querySelectorAll('div[data-dsh-guide-blocks] section[data-dsh-guide-block]')]
    expect(blocks.map(node => node.getAttribute('data-dsh-guide-block'))).toEqual(['workspace', 'session', 'more'])
    // 块标题走 locales 的三键（en-US 快照）。
    expect(blocks[0]!.textContent).toContain(t('guideBlockWorkspace'))
    expect(blocks[1]!.textContent).toContain(t('guideBlockSession'))
    expect(blocks[2]!.textContent).toContain(t('guideBlockMore'))
    // kind 集合与 order 排序（guide order 升序；terminal 合成 tile 在 session 块首位）。
    expect(tileKindsOf('workspace')).toEqual(['files', 'search', 'git'])
    expect(tileKindsOf('session')).toEqual(['terminal', 'subagent', 'sidechat', 'history'])
    expect(tileKindsOf('more')).toEqual(['settings', 'webview', 'commands', 'dsh-context'])
    // editor 描述符不出自己的 tile：它的页面身份就是 files takeover。
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="editor"]')).toBeNull()
    // 合成 terminal tile 存在，且无快捷键目录时回退静态 Ctrl+` 键帽。
    const terminal = document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="terminal"]')
    expect(terminal, '合成终端 tile 必须存在').not.toBeNull()
    expect(terminal!.textContent).toContain('Ctrl')
    expect(terminal!.textContent).toContain('`')
    // files tile 复用 editor 描述符的 guide 说明文案（悬停提示，与 native 注册同一行）。
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="files"]')?.getAttribute('title')).toBe('Browse the tree')
  })

  it('tile 点击路由：已知 kind 走 openStartLink 的 service.openTab 参数，外部 kind 直通，设置不走 openTab', async () => {
    mountGuide()
    const { service, openTab } = fakeService()
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx({ mounted: 's1' }), service) })
    disposers.push(dispose)
    await flush()
    // 与 start-links.tsx 的 openStartLink 一一对应（files → path-less editor）。
    clickTile('files')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'editor' })
    clickTile('search')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'search' })
    clickTile('git')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'git' })
    clickTile('subagent')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'subagent' })
    clickTile('sidechat')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'sidechat' })
    clickTile('history')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'history' })
    clickTile('webview')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'webview' })
    clickTile('commands')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'commands' })
    // 外部/未知 kind：不经 openStartLink 映射，原样直通 service.openTab。
    clickTile('dsh-context')
    expect(openTab).toHaveBeenLastCalledWith({ type: 'dsh-context' })
    expect(openTab).toHaveBeenCalledTimes(9)
    // 「设置」tile 走宿主设置壳探测链（settings-entry 专测），不碰 service.openTab。
    expect(() => { clickTile('settings') }).not.toThrow()
    expect(openTab).toHaveBeenCalledTimes(9)
  })

  it('合成终端 tile：无在屏会话点击 no-op（不抛错），有在屏会话走宿主 sidebarRight.openTab("terminal")', async () => {
    mountGuide()
    const { service, openTab } = fakeService()
    const hostOpenTab = vi.fn()
    let dispose1: () => void = () => {}
    act(() => { dispose1 = registerGuideBlocks(makeCtx({ openTab: hostOpenTab }), service) })
    disposers.push(dispose1)
    await flush()
    // mounted 缺席（guide 页可以没有在屏会话）：宿主命令面按契约会 throw，先门控。
    expect(() => { clickTile('terminal') }).not.toThrow()
    expect(hostOpenTab).not.toHaveBeenCalled()
    // service.openTab 也不该被碰（terminal 不是插件注册表 kind）。
    expect(openTab).not.toHaveBeenCalled()
    act(() => { dispose1() })
    // 有在屏会话：结构化探测 ctx.sidebarRight.openTab('terminal', {})。
    let dispose2: () => void = () => {}
    act(() => { dispose2 = registerGuideBlocks(makeCtx({ mounted: 's1', openTab: hostOpenTab }), service) })
    disposers.push(dispose2)
    await flush()
    clickTile('terminal')
    expect(hostOpenTab).toHaveBeenCalledWith('terminal', {})
  })

  it('guide 可见过滤：禁用/bottomOnly/hidden/editor 不出 tile，注册表翻转后同一 portal 内实时跟随', async () => {
    mountGuide()
    const { service, notify, setEnabled } = fakeService({
      tabs: [
        ...BASE_TABS,
        tabOf({ id: 'dock-page', title: 'Dock', bottomOnly: true }),
        tabOf({ id: 'ghost-page', title: 'Ghost', hidden: true }),
      ],
      enabled: { git: false },
    })
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx(), service) })
    disposers.push(dispose)
    await flush()
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="git"]'), '禁用类型不出 tile').toBeNull()
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="dock-page"]'), 'bottomOnly 不出 guide tile').toBeNull()
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="ghost-page"]'), 'hidden 不出 guide tile').toBeNull()
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="files"]'), 'editor 未禁用时 files takeover 仍在').not.toBeNull()
    const portalBefore = document.querySelector('div[data-dsh-guide-blocks]')
    // 侧边卡片开关翻转（registry + state 两条订阅都触发 bump）：git tile 回来，
    // 且 portal 根不重建（注册表脉冲不换 DOM 身份）。
    act(() => { setEnabled('git', true); notify() })
    await flush()
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="git"]')).not.toBeNull()
    expect(document.querySelector('div[data-dsh-guide-blocks]')).toBe(portalBefore)
    act(() => { setEnabled('editor', false); notify() })
    await flush()
    // editor 禁用 → files takeover 一并消失（files 跟随 editor 开关）。
    expect(document.querySelector('div[data-dsh-guide-blocks] [data-dsh-guide-tile="files"]')).toBeNull()
  })

  it('disposer：portal 与样式标签移除；重复 register/dispose 无残留', async () => {
    mountGuide()
    const { service } = fakeService()
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx(), service) })
    await flush()
    expect(document.querySelectorAll('div[data-dsh-guide-blocks]')).toHaveLength(1)
    expect(document.querySelectorAll('style[data-dsh-guide-blocks]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-dsh-guide-tile]').length).toBeGreaterThan(0)
    act(() => { dispose() })
    expect(document.querySelector('div[data-dsh-guide-blocks]')).toBeNull()
    expect(document.head.querySelector('style[data-dsh-guide-blocks]')).toBeNull()
    expect(document.querySelectorAll('[data-dsh-guide-tile]')).toHaveLength(0)
    // 同一 guide 根再注册一轮：照常注入与渲染，再清理后仍无残留。
    let dispose2: () => void = () => {}
    act(() => { dispose2 = registerGuideBlocks(makeCtx(), service) })
    await flush()
    expect(document.querySelectorAll('div[data-dsh-guide-blocks]')).toHaveLength(1)
    expect(document.querySelectorAll('style[data-dsh-guide-blocks]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-dsh-guide-tile]').length).toBeGreaterThan(0)
    act(() => { dispose2() })
    expect(document.querySelector('div[data-dsh-guide-blocks]')).toBeNull()
    expect(document.head.querySelector('style[data-dsh-guide-blocks]')).toBeNull()
  })

  it('guide 根从 DOM 移除：observer 冲刷后 portal 与样式标签收敛（最后一个 guide 消失）', async () => {
    const { root } = mountGuide()
    const { service } = fakeService()
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx(), service) })
    disposers.push(dispose)
    await flush()
    expect(document.querySelectorAll('div[data-dsh-guide-blocks]')).toHaveLength(1)
    act(() => { root.remove() })
    await flush()
    expect(document.querySelector('div[data-dsh-guide-blocks]')).toBeNull()
    expect(document.querySelector('[data-dsh-guide-blocks-host]')).toBeNull()
    expect(document.head.querySelector('style[data-dsh-guide-blocks]')).toBeNull()
    expect(document.querySelectorAll('[data-dsh-guide-tile]')).toHaveLength(0)
  })

  it('宿主替换 guide 根：旧 portal 卸载，新根末尾挂新 portal，样式标签始终唯一', async () => {
    const { root: oldRoot } = mountGuide()
    const { service } = fakeService()
    let dispose: () => void = () => {}
    act(() => { dispose = registerGuideBlocks(makeCtx(), service) })
    disposers.push(dispose)
    await flush()
    expect(oldRoot.querySelector('div[data-dsh-guide-blocks]')).not.toBeNull()
    // SPA 导航式替换：新 guide 根顶替旧根（identity 键的 portal 表逐根换血）。
    const { root: newRoot } = mountGuide()
    act(() => { oldRoot.remove() })
    await flush()
    expect(oldRoot.querySelector('div[data-dsh-guide-blocks]'), '旧 portal 必须卸载').toBeNull()
    expect(newRoot.querySelector('div[data-dsh-guide-blocks]'), '新根末尾挂新 portal').not.toBeNull()
    expect(newRoot.lastElementChild?.getAttribute('data-dsh-guide-blocks-host')).toBe('')
    expect(document.querySelectorAll('style[data-dsh-guide-blocks]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-dsh-guide-tile]').length).toBeGreaterThan(0)
  })
})
