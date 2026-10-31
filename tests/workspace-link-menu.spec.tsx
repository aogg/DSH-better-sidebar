// @vitest-environment jsdom
/**
 * 工作区「更多」菜单的「独立工作区」注入：一级项 + 自绘子菜单
 * （src/client/workspace-link-menu.ts）。
 *
 * 核心契约：工作区锚按钮的 aria-label 是 locale 模板（zh「工作区“…”的操作」
 * / en "Workspace actions for …"），所属行带 `data-row-key="workspace:<id>"`；
 * 菜单是 portal 的 `[role="menu"]`（直接挂在 body 下），内容区是带
 * `_viewport` 类名片段的元素。用同形 DOM 钉住：
 *   1. 锚点击 → 菜单挂载 → 追加目标 = viewport 内（`[class*="_viewport"]`
 *      优先，与 dsh-ao-local 同查询；找不到退菜单本体）；
 *   2. 注入的是「分隔线 + 一级项（独立工作区，aria-haspopup=menu）+ 隐藏
 *      子菜单卡」，旧的两项平铺（复制独立工作区链接/新窗口打开独立工作区）
 *      不再直接出现在菜单上；
 *   3. 点/hover 一级项开子菜单：body 拿到 `data-dsh-sidebar-submenu` flip
 *      令牌，收起即摘；Escape / 菜单外 pointerdown 也收；
 *   4. 子菜单「复制链接」写剪贴板的是 `?ws=<id>` 完整链接 + toast，经锚按钮
 *      原生 click 收起菜单；「新窗口打开」window.open(_blank, noopener)；
 *   5. 注入增高后做视口夹取（超视口底部把 menu.style.top 上移）；
 *   6. 未分组行不注入；无 pending 不碰菜单；800ms 窗口过期不注入；dispose
 *      后不再注入且样式表移除。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import type { SidebarStore } from '../src/client/state.ts'
import { registerWorkspaceLinkMenu } from '../src/client/workspace-link-menu.ts'
import type { WorkspaceGroup } from '../src/client/workspace-groups.ts'
import { buildWorkspaceFocusLink } from '../src/client/workspace-focus.ts'

/** The disposer of the registration under test (disposed again in afterEach). */
let dispose: (() => void) | undefined

/** Point the browser-language fallback at a specific language. */
function stubLanguage(lang: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: lang },
    configurable: true,
  })
}

/** Stub a Clipboard API onto jsdom's navigator (absent by default there). */
function stubClipboard(writeText: ReturnType<typeof vi.fn>, language = 'zh-CN'): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language, clipboard: { writeText } },
    configurable: true,
  })
}

function ctxFake(): Context {
  return { get: () => undefined } as unknown as Context
}

/** A minimal prefs store fake: the module reads pluginSettings through it. */
function storeFake(pluginSettings: Record<string, Record<string, unknown>> = {}): SidebarStore {
  return { getPrefs: () => ({ pluginSettings }) } as unknown as SidebarStore
}

/** Seed a store with a groups list (the persisted `pluginSettings.workspaceGroups` blob). */
function storeWithGroups(groups: unknown): SidebarStore {
  return storeFake({ workspaceGroups: { groups } })
}

/**
 * 组写入走 settings.update（测试里无宿主必然失败），失败由 plugin-settings
 * 的队列记 console.error——这里静音掉，断言的是草稿态驱动的界面。
 */
function silenceWriteErrors(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

/**
 * Build the host-shaped workspace row: `[data-row-key="workspace:<id>"]`
 * holding the (…) anchor whose aria-label follows the core's locale template.
 */
function buildRow(workspaceId: string, anchorLabel: string): { row: HTMLElement; anchor: HTMLButtonElement } {
  const row = document.createElement('div')
  row.setAttribute('data-row-key', `workspace:${workspaceId}`)
  const holder = document.createElement('span')
  const anchor = document.createElement('button')
  anchor.type = 'button'
  anchor.setAttribute('aria-label', anchorLabel)
  holder.appendChild(anchor)
  row.appendChild(holder)
  document.body.appendChild(row)
  return { row, anchor }
}

/** Append a host-shaped portaled menu: role=menu > viewport(class *_viewport*) > items. */
function appendMenu(withViewport = true): { menu: HTMLElement; viewport: HTMLElement } {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const viewport = document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  if (withViewport) viewport.className = 'dsh-test_viewport'
  menu.appendChild(viewport)
  document.body.appendChild(menu)
  return { menu, viewport }
}

/** Let the MutationObserver microtask (and promise chains) settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

/** A native click with bubbling (plain DOM listeners, no React involved). */
function click(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** A mouseover with bubbling (the hover-open path uses delegated mouseover). */
function hover(target: Element): void {
  target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

/** The injected wrap (separator + top item + submenu) inside a host menu. */
function wrapOf(menu: HTMLElement): HTMLElement {
  return menu.querySelector<HTMLElement>('[data-dsh-workspace-link-item]')!
}

/** The「独立工作区」top item button. */
function topItemOf(menu: HTMLElement): HTMLButtonElement {
  return menu.querySelector<HTMLButtonElement>('[data-dsh-workspace-link-item] .row-holder > button')!
}

/** The self-drawn submenu card of the top item. */
function submenuOf(menu: HTMLElement): HTMLElement {
  return menu.querySelector<HTMLElement>('[data-dsh-workspace-submenu]')!
}

/** The (lazily rendered) nested card of one row: anchored inside the row holder. */
function cardOf(rowButton: Element): HTMLElement {
  return rowButton.parentElement!.querySelector<HTMLElement>('[data-dsh-workspace-submenu]')!
}

/** Submenu action buttons by label (复制链接 / 新窗口打开 / …). */
function subItemOf(scope: HTMLElement, label: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('.menu-btn')]
    .find(candidate => candidate.textContent?.includes(label))
  expect(button, `submenu item ${label} must exist`).not.toBeUndefined()
  return button!
}

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ''
  for (const tag of [...document.head.querySelectorAll('style[data-dsh-workspace-link-style]')]) tag.remove()
  stubLanguage('zh-CN')
  // 移除测试加的 clipboard stub（defineProperty 留下的配置项一并还原）。
  delete (globalThis as { navigator?: unknown }).navigator
  document.body.removeAttribute('data-dsh-sidebar-submenu')
  vi.restoreAllMocks()
})

describe('registerWorkspaceLinkMenu（注入落点 + 一级子菜单）', () => {
  it('injects into the `_viewport` element (ao-local’s container query), not the raw menu', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu, viewport } = appendMenu()
    await settle()
    const wrap = wrapOf(menu)
    expect(wrap, 'the pending window must inject the wrap').not.toBeNull()
    // 追加目标 = viewport（class 含 _viewport 片段）本身，不再是裸 menu。
    expect(wrap.parentElement).toBe(viewport)
    expect(wrap.parentElement).not.toBe(menu)
  })

  it('falls back to the menu itself when no viewport-classed child exists (older host)', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', 'Workspace actions for My Project')
    click(anchor)
    const { menu } = appendMenu(false)
    await settle()
    expect(wrapOf(menu).parentElement).toBe(menu)
  })

  it('renders one top-level item (aria-haspopup) and no longer the two flat legacy items', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    const top = topItemOf(menu)
    expect(top.getAttribute('role')).toBe('menuitem')
    expect(top.getAttribute('aria-haspopup')).toBe('menu')
    expect(top.getAttribute('aria-expanded')).toBe('false')
    expect(top.textContent).toContain('独立工作区')
    // 旧两项平铺已废弃：文案不再直接出现在菜单一级。
    expect(menu.textContent).not.toContain('复制独立工作区链接')
    expect(menu.textContent).not.toContain('新窗口打开独立工作区')
    // 分隔线 + 行结构，整块在注入 wrap 里。
    expect(menu.querySelector('[data-dsh-workspace-link-item] .separator')).not.toBeNull()
  })

  it('opens the self-drawn submenu on click (and publishes the flip tokens), closes on second click', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    const top = topItemOf(menu)
    const submenu = submenuOf(menu)
    expect(submenu.hasAttribute('data-dsh-submenu-open')).toBe(false)
    click(top)
    expect(submenu.hasAttribute('data-dsh-submenu-open')).toBe(true)
    expect(top.getAttribute('aria-expanded')).toBe('true')
    // flip 令牌挂在 body 上（layout.css 只在属性存在时翻转我们的子菜单）。
    expect(document.body.hasAttribute('data-dsh-sidebar-submenu')).toBe(true)
    // 子菜单内容：复制链接 / 新窗口打开（两条 role=menuitem）。
    expect(subItemOf(submenu, '复制链接').getAttribute('role')).toBe('menuitem')
    expect(subItemOf(submenu, '新窗口打开').getAttribute('role')).toBe('menuitem')
    click(top)
    expect(submenu.hasAttribute('data-dsh-submenu-open')).toBe(false)
    expect(document.body.hasAttribute('data-dsh-sidebar-submenu')).toBe(false)
  })

  it('opens on hover (delegated mouseover) as the primary gesture', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    hover(topItemOf(menu))
    expect(submenuOf(menu).hasAttribute('data-dsh-submenu-open')).toBe(true)
  })

  it('closes the submenu on Escape and on pointerdown outside the injected wrap', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    click(topItemOf(menu))
    expect(submenuOf(menu).hasAttribute('data-dsh-submenu-open')).toBe(true)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(submenuOf(menu).hasAttribute('data-dsh-submenu-open')).toBe(false)
    expect(document.body.hasAttribute('data-dsh-sidebar-submenu')).toBe(false)
    // 再开，菜单外 pointerdown 也收。
    click(topItemOf(menu))
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(submenuOf(menu).hasAttribute('data-dsh-submenu-open')).toBe(false)
  })

  it('copy item writes the ws link, toasts success, and closes through the anchor', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    const anchorClick = vi.fn()
    anchor.addEventListener('click', anchorClick)
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    anchorClick.mockClear()
    click(topItemOf(menu))
    click(subItemOf(submenuOf(menu), '复制链接'))
    await settle()
    await settle()
    expect(writeText).toHaveBeenCalledTimes(1)
    const link = writeText.mock.calls[0]![0] as string
    expect(link.startsWith(window.location.origin)).toBe(true)
    expect(link).toContain('ws=w1')
    const toast = document.querySelector('[data-dsh-workspace-link-toast]')
    expect(toast).not.toBeNull()
    expect(toast!.textContent).toBe('已复制独立工作区链接，打开后左侧仅显示该工作区')
    // 菜单经锚按钮自己的 click 收起（核心 toggle 语义）。
    expect(anchorClick).toHaveBeenCalledTimes(1)
    // 子菜单随菜单收起流程一起收。
    expect(submenuOf(menu).hasAttribute('data-dsh-submenu-open')).toBe(false)
  })

  it('open item window.opens the ws link with _blank+noopener and closes through the anchor', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    const anchorClick = vi.fn()
    anchor.addEventListener('click', anchorClick)
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    anchorClick.mockClear()
    click(topItemOf(menu))
    click(subItemOf(submenuOf(menu), '新窗口打开'))
    await settle()
    expect(openSpy).toHaveBeenCalledTimes(1)
    const [url, target, features] = openSpy.mock.calls[0]!
    expect(url).toBe(buildWorkspaceFocusLink(window.location.href, 'w1'))
    expect(new URL(url as string).searchParams.get('ws')).toBe('w1')
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')
    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dsh-workspace-link-toast]')).toBeNull()
    expect(anchorClick).toHaveBeenCalledTimes(1)
  })

  it('clamps the menu back into the viewport after the injection grows it', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    const rect = { top: 640, bottom: 900, height: 260, width: 200, left: 0, right: 200, x: 0, y: 640, toJSON: () => ({}) }
    vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    await settle()
    // overflow = 900 - (768 - 12) = 144 → top 上移 144px（ao-local 同款 12px 边距）。
    expect(menu.style.top).toBe('496px')
  })

  it('degrades to the execCommand fallback and toasts failure without the Clipboard API', async () => {
    stubLanguage('zh-CN')
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const execCommand = vi.fn(() => false)
    document.execCommand = execCommand as unknown as typeof document.execCommand
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    click(topItemOf(menu))
    click(subItemOf(submenuOf(menu), '复制链接'))
    await settle()
    await settle()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('[data-dsh-workspace-link-toast]')!.textContent)
      .toBe('复制失败，请手动复制地址后在链接后附加 ?ws= 工作区参数')
    delete (document as { execCommand?: unknown }).execCommand
  })

  it('skips the ungrouped bucket (no workspace id to link)', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { anchor } = buildRow('', '工作区“未分组”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    expect(menu.querySelector('[data-dsh-workspace-link-item]')).toBeNull()
  })

  it('never touches menus that open without a workspace anchor pending', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    const { menu } = appendMenu()
    await settle()
    expect(menu.querySelector('[data-dsh-workspace-link-item]')).toBeNull()
  })

  it('ignores a menu mounted after the pending window expires', async () => {
    vi.useFakeTimers()
    try {
      stubClipboard(vi.fn().mockResolvedValue(undefined))
      dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
      const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
      click(anchor)
      vi.advanceTimersByTime(900)
      const { menu } = appendMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(menu.querySelector('[data-dsh-workspace-link-item]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose stops injecting and removes the stylesheet', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake(), storeFake())
    expect(document.head.querySelector('style[data-dsh-workspace-link-style]')).not.toBeNull()
    dispose()
    dispose = undefined
    expect(document.head.querySelector('style[data-dsh-workspace-link-style]')).toBeNull()
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    expect(menu.querySelector('[data-dsh-workspace-link-item]')).toBeNull()
  })
})

/** Seed groups shape used across the group cases. */
function groupsFixture(): WorkspaceGroup[] {
  return [
    { id: 'grp1', name: '组A', workspaceIds: ['w1'] },
    { id: 'grp2', name: '组B', workspaceIds: [] },
  ]
}

/** Arm the menu for w1 against a seeded store and return the mounted nodes. */
async function openMenuWithGroups(store: SidebarStore, ctx: Context = ctxFake()): Promise<{ menu: HTMLElement; anchor: HTMLButtonElement; top: HTMLButtonElement; submenu: HTMLElement }> {
  stubClipboard(vi.fn().mockResolvedValue(undefined))
  dispose = registerWorkspaceLinkMenu(ctx, store)
  const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
  click(anchor)
  const { menu } = appendMenu()
  await settle()
  const top = topItemOf(menu)
  const submenu = submenuOf(menu)
  click(top)
  return { menu, anchor, top, submenu }
}

describe('registerWorkspaceLinkMenu（独立工作区组）', () => {
  it('renders the group rows: 加入到组, one row per owning group, and the manage entry', async () => {
    silenceWriteErrors()
    await openMenuWithGroups(storeWithGroups(groupsFixture()))
    const submenu = document.querySelector<HTMLElement>('[data-dsh-workspace-submenu]')!
    // 加入到组 ▸（带子菜单的行）
    const addToGroup = subItemOf(submenu, '加入到组')
    expect(addToGroup.getAttribute('aria-haspopup')).toBe('menu')
    // 所属组：w1 ∈ 组A → 一条组行（aria-label 带组动作前缀）；组B 不属于 w1 不出现。
    const groupRow = subItemOf(submenu, '组A')
    expect(groupRow.getAttribute('aria-label')).toBe('组动作：组A')
    expect([...submenu.querySelectorAll('.menu-btn')].some(row => row.textContent?.includes('组B'))).toBe(false)
    // 管理独立工作区组… 入口在。
    expect(subItemOf(submenu, '管理独立工作区组')).toBeDefined()
  })

  it('加入到组 card lists every group as a checkbox row and toggles membership in place', async () => {
    silenceWriteErrors()
    const { submenu } = await openMenuWithGroups(storeWithGroups(groupsFixture()))
    const addToGroup = subItemOf(submenu, '加入到组')
    hover(addToGroup)
    // 卡按行定位（懒渲染的嵌套卡挂在所属行的 holder 里），不按「最后一张卡」猜。
    const addCard = cardOf(addToGroup)
    // 组A 勾上（w1 已是成员）、组B 未勾。
    const checked = [...addCard.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    expect(checked).toHaveLength(2)
    expect(checked[0]!.getAttribute('aria-checked')).toBe('true')
    expect(checked[1]!.getAttribute('aria-checked')).toBe('false')
    // 点组A → 移出：勾选态原位翻 false（卡片不闪）。
    click(checked[0]!)
    const after = [...addCard.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    expect(after[0]!.getAttribute('aria-checked')).toBe('false')
    expect(addCard.hasAttribute('data-dsh-submenu-open')).toBe(true)
  })

  it('＋ 新建组… inline input creates a group with the workspace checked and refreshes the submenu', async () => {
    silenceWriteErrors()
    const { submenu } = await openMenuWithGroups(storeWithGroups(groupsFixture()))
    hover(subItemOf(submenu, '加入到组'))
    const addCard = cardOf(subItemOf(submenu, '加入到组'))
    const newButton = [...addCard.querySelectorAll<HTMLButtonElement>('.menu-btn')].find(row => row.textContent?.includes('新建组'))!
    click(newButton)
    const input = addCard.querySelector<HTMLInputElement>('input.new-group-input')!
    expect(input).not.toBeNull()
    input.value = '新建的组'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    // 子菜单整体重画：所属组区多出「新建的组」。
    const rows = [...submenu.querySelectorAll('.menu-btn')].map(row => row.textContent)
    expect(rows.some(text => text?.includes('新建的组'))).toBe(true)
    // 重画后重新展开加入到组卡（懒渲染），新建的组是勾上的。
    const reopened = subItemOf(submenu, '加入到组')
    hover(reopened)
    const freshCard = cardOf(reopened)
    const boxes = [...freshCard.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    const created = boxes.find(box => box.textContent?.includes('新建的组'))
    expect(created?.getAttribute('aria-checked')).toBe('true')
  })

  it('组动作 card: 新窗口打开全组 opens one g: link; 复制全组链接 copies that single link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const { anchor, submenu } = await openMenuWithGroups(storeWithGroups(groupsFixture()))
    // openMenuWithGroups 内部会再 stub 一次剪贴板：这里恢复成本用例的 spy。
    stubClipboard(writeText)
    hover(subItemOf(submenu, '组A'))
    const cards = document.querySelectorAll<HTMLElement>('[data-dsh-workspace-submenu]')
    const groupCard = cards[cards.length - 1]!
    // 新窗口打开全组：一条 ?ws=g:grp1 链接，一个窗口显示整组。
    click(subItemOf(groupCard, '新窗口打开全组'))
    expect(openSpy).toHaveBeenCalledTimes(1)
    const [url, target, features] = openSpy.mock.calls[0]!
    expect(new URL(url as string).searchParams.get('ws')).toBe('g:grp1')
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')
    // 复制全组链接：剪贴板里是同一条 g: 链接 + 成功 toast。
    click(subItemOf(groupCard, '复制全组链接'))
    await settle()
    await settle()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(new URL(writeText.mock.calls[0]![0] as string).searchParams.get('ws')).toBe('g:grp1')
    const toast = document.querySelector('[data-dsh-workspace-link-toast]')
    expect(toast?.textContent).toBe('已复制组链接「组A」：打开后左侧显示该组的 1 个工作区')
    // 菜单照旧经锚按钮收起。
    expect(anchor.isConnected).toBe(true)
  })

  it('从该组移出 drops the workspace from the group and re-renders the owning-group rows', async () => {
    silenceWriteErrors()
    const { submenu } = await openMenuWithGroups(storeWithGroups(groupsFixture()))
    hover(subItemOf(submenu, '组A'))
    const cards = document.querySelectorAll<HTMLElement>('[data-dsh-workspace-submenu]')
    const groupCard = cards[cards.length - 1]!
    click(subItemOf(groupCard, '从该组移出'))
    await settle()
    // 子菜单重画后「组A」不再出现在所属组区。
    const rows = [...submenu.querySelectorAll('.menu-btn')].map(row => row.textContent)
    expect(rows.some(text => text?.includes('组A'))).toBe(false)
  })

  it('管理独立工作区组… opens the management panel dialog', async () => {
    silenceWriteErrors()
    const { submenu } = await openMenuWithGroups(storeWithGroups(groupsFixture()))
    click(subItemOf(submenu, '管理独立工作区组'))
    const panel = document.querySelector<HTMLElement>('[data-dsh-workspace-groups-panel]')
    expect(panel).not.toBeNull()
    expect(panel!.getAttribute('role')).toBe('dialog')
    expect(panel!.textContent).toContain('独立工作区组')
    expect(panel!.querySelectorAll('.group-card')).toHaveLength(2)
    // Escape 关面板。
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('[data-dsh-workspace-groups-panel]')).toBeNull()
  })
})

describe('独立工作区组管理面板', () => {
  it('renders an empty-state hint without groups and creates one via ＋ 新建组', async () => {
    silenceWriteErrors()
    await openMenuWithGroups(storeFake())
    click(subItemOf(document.querySelector<HTMLElement>('[data-dsh-workspace-submenu]')!, '管理独立工作区组'))
    const panel = document.querySelector<HTMLElement>('[data-dsh-workspace-groups-panel]')!
    expect(panel.textContent).toContain('还没有组')
    const add = [...panel.querySelectorAll<HTMLButtonElement>('.panel-btn')].find(button => button.textContent?.includes('新建组'))!
    click(add)
    const input = panel.querySelector<HTMLInputElement>('input.new-group-input')!
    input.value = '面板建的组'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(panel.querySelectorAll('.group-card')).toHaveLength(1)
    const name = panel.querySelector<HTMLInputElement>('.group-name')!
    expect(name.value).toBe('面板建的组')
  })

  it('renames and deletes a group inline; add-member select chips work', async () => {
    silenceWriteErrors()
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    // 候选 = workspaces.list 快照：给 ctx 钉住 w1/w2（w1 不在组B，是它的候选）。
    const ctx = {
      get: (name: string) => name === 'workspaces'
        ? { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }], phase: 'ready' }) } }
        : undefined,
    } as unknown as Context
    dispose = registerWorkspaceLinkMenu(ctx, storeWithGroups(groupsFixture()))
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    click(subItemOf(submenuOf(menu), '管理独立工作区组'))
    const panel = document.querySelector<HTMLElement>('[data-dsh-workspace-groups-panel]')!
    // 组B（空组）的卡片：添加成员下拉（w1 是候选）→ 选上出 chip。
    const cards = [...panel.querySelectorAll<HTMLElement>('.group-card')]
    const groupB = cards.find(card => card.querySelector<HTMLInputElement>('.group-name')?.value === '组B')!
    const select = groupB.querySelector<HTMLSelectElement>('select.members-add')!
    expect([...select.options].some(option => option.textContent === 'w1')).toBe(true)
    select.value = 'w1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    const groupBAfter = [...panel.querySelectorAll<HTMLElement>('.group-card')]
      .find(card => card.querySelector<HTMLInputElement>('.group-name')?.value === '组B')!
    expect(groupBAfter.querySelector('.chip .chip-text')?.textContent).toBe('w1')
    // 重命名：改值 + change → 草稿更新（输入不重渲染不打字）。
    const name = groupBAfter.querySelector<HTMLInputElement>('.group-name')!
    name.value = '组B 改名'
    name.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    // 删除组：移除按钮（aria-label = 删除组）。
    const panelAfter = document.querySelector<HTMLElement>('[data-dsh-workspace-groups-panel]')!
    const groupBFinal = [...panelAfter.querySelectorAll<HTMLElement>('.group-card')]
      .find(card => card.querySelector<HTMLInputElement>('.group-name')?.value === '组B 改名')!
    groupBFinal.querySelector<HTMLButtonElement>('.group-remove')!.click()
    expect(panelAfter.querySelectorAll('.group-card')).toHaveLength(1)
    // 关闭按钮收面板。
    panelAfter.querySelector<HTMLButtonElement>('.panel-close')!.click()
    expect(document.querySelector('[data-dsh-workspace-groups-panel]')).toBeNull()
    void anchor
  })

  it('copies the whole group as ONE g: link and every workspace as bare per-line links', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const { submenu } = await openMenuWithGroups(storeWithGroups([
      { id: 'grp9', name: '组C', workspaceIds: ['w1', 'w2'] },
    ]))
    // openMenuWithGroups 内部会再 stub 一次剪贴板：这里恢复成本用例的 spy。
    stubClipboard(writeText)
    click(subItemOf(submenu, '管理独立工作区组'))
    const panel = document.querySelector<HTMLElement>('[data-dsh-workspace-groups-panel]')!
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('.panel-btn')]
    buttons.find(button => button.textContent?.includes('复制全组链接'))!.click()
    await settle()
    await settle()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]![0]).toContain('ws=g%3Agrp9')
    // 复制全部单工作区链接：每行一条裸 ?ws=<id>。
    buttons.find(button => button.textContent?.includes('复制全部单工作区链接'))!.click()
    await settle()
    await settle()
    expect(writeText).toHaveBeenCalledTimes(2)
    const lines = (writeText.mock.calls[1]![0] as string).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('ws=w1')
    expect(lines[1]).toContain('ws=w2')
  })

  it('marks stale member ids (deleted workspaces) greyed with the 已失效 note and lets them be cleared', async () => {
    silenceWriteErrors()
    const ctx = {
      get: (name: string) => name === 'workspaces'
        ? { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }], phase: 'ready' }) } }
        : undefined,
    } as unknown as Context
    await openMenuWithGroups(storeWithGroups([
      { id: 'grp1', name: '组A', workspaceIds: ['w1', 'w-gone'] },
    ]), ctx)
    click(subItemOf(document.querySelector<HTMLElement>('[data-dsh-workspace-submenu]')!, '管理独立工作区组'))
    const panel = document.querySelector<HTMLElement>('[data-dsh-workspace-groups-panel]')!
    const staleChip = panel.querySelector<HTMLElement>('.chip.stale')
    expect(staleChip).not.toBeNull()
    expect(staleChip!.textContent).toContain('已失效')
    // 清掉失效成员：chip 的移除按钮。
    staleChip!.querySelector<HTMLButtonElement>('.chip-remove')!.click()
    expect(panel.querySelector('.chip.stale')).toBeNull()
  })
})
