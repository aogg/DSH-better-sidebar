// @vitest-environment jsdom
/**
 * 工作区「更多」菜单的「独立工作区链接」两项注入
 * （src/client/workspace-link-menu.ts）。
 *
 * 核心契约：工作区锚按钮的 aria-label 是 locale 模板（zh「工作区“…”的操作」
 * / en "Workspace actions for …"），所属行带 `data-row-key="workspace:<id>"`；
 * 菜单是 portal 的 `[role="menu"]`（直接挂在 body 下），内容区是首个子元素。
 * 用同形 DOM 钉住：
 *   1. 锚点击 → 菜单挂载 → 两项注入出现（分隔线 + 2 个 role=menuitem +
 *      当前语言文案：复制在前、新窗口打开在后），未分组的空 key 行不注入；
 *   2. 点复制项：写剪贴板的是带 `?ws=<id>` 的完整链接，弹成功 toast，并复
 *      用锚按钮的原生 click 收起菜单（ spy 断言）；
 *   3. 点新窗口项：`window.open(链接, '_blank', 'noopener')`，不写剪贴板、
 *      不弹 toast，同样经锚按钮的原生 click 收起菜单；
 *   4. Clipboard API 缺席（http 非安全上下文）→ execCommand 兜底，失败走
 *      失败 toast；
 *   5. 没有 pending（菜单自己出现）→ 菜单不被碰；
 *   6. pending 800ms 窗口过期后再挂菜单 → 不注入；
 *   7. dispose 后不再注入，样式表移除。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { registerWorkspaceLinkMenu } from '../src/client/workspace-link-menu.ts'
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

/** Append a fresh host-shaped portaled menu (role=menu > viewport div). */
function appendMenu(): { menu: HTMLElement; viewport: HTMLElement } {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const viewport = document.createElement('div')
  viewport.setAttribute('role', 'presentation')
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

function itemOf(menu: HTMLElement): HTMLButtonElement | null {
  return menu.querySelector<HTMLButtonElement>('[data-dsh-workspace-link-item] button')
}

/** Both injected item buttons, in DOM order (copy first, open-in-new-window second). */
function itemsOf(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('[data-dsh-workspace-link-item] button')]
}

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ''
  for (const tag of [...document.head.querySelectorAll('style[data-dsh-workspace-link-style]')]) tag.remove()
  stubLanguage('zh-CN')
  // 移除测试加的 clipboard stub（defineProperty 留下的配置项一并还原）。
  delete (globalThis as { navigator?: unknown }).navigator
  vi.restoreAllMocks()
})

describe('registerWorkspaceLinkMenu', () => {
  it('injects the copy-link item into the portaled workspace menu', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    const item = itemOf(menu)
    expect(item, 'the pending window must inject the item into the fresh portal').not.toBeNull()
    expect(item!.getAttribute('role')).toBe('menuitem')
    expect(item!.textContent).toContain('复制独立工作区链接')
    // 分隔线在项内、项挂在内容区末尾。
    expect(menu.querySelector('[data-dsh-workspace-link-item] .separator')).not.toBeNull()
    expect(menu.querySelector('[data-dsh-workspace-link-item]')!.parentElement).toBe(menu.firstElementChild)
  })

  it('also recognizes the English anchor template and copies the English label', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined), 'en-US')
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { anchor } = buildRow('w2', 'Workspace actions for My Project')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    expect(itemOf(menu)!.textContent).toContain('Copy standalone workspace link')
  })

  it('writes the ws link, toasts success, and closes through the anchor', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    const anchorClick = vi.fn()
    anchor.addEventListener('click', anchorClick)
    click(anchor)
    // 开菜单的这次点击本身也是锚上的一次 click，先清零再断言「收起那次」。
    const { menu } = appendMenu()
    await settle()
    anchorClick.mockClear()
    click(itemOf(menu)!)
    await settle()
    await settle()
    // 完整链接：当前页面地址 + ws 参数（其余原样）。
    expect(writeText).toHaveBeenCalledTimes(1)
    const link = writeText.mock.calls[0]![0] as string
    expect(link.startsWith(window.location.origin)).toBe(true)
    expect(link).toContain('ws=w1')
    // 成功 toast（role=status，标记可查）。
    const toast = document.querySelector('[data-dsh-workspace-link-toast]')
    expect(toast).not.toBeNull()
    expect(toast!.textContent).toBe('已复制独立工作区链接，打开后左侧仅显示该工作区')
    // 菜单经锚按钮自己的 click 收起（核心 toggle 语义）。
    expect(anchorClick).toHaveBeenCalledTimes(1)
  })

  it('injects both items: copy first, then open-in-new-window, both keyboard-reachable menuitems', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    const items = itemsOf(menu)
    expect(items, 'separator + two items must be injected together').toHaveLength(2)
    expect(items[0]!.textContent).toContain('复制独立工作区链接')
    expect(items[1]!.textContent).toContain('新窗口打开独立工作区')
    for (const item of items) {
      // 与核心菜单项同规格：role=menuitem + aria-label（键盘上下键漫游由
      // 核心菜单覆盖，注入项天然在序）。
      expect(item.getAttribute('role')).toBe('menuitem')
      expect(item.getAttribute('aria-label')).toBe(item.textContent)
      expect(item.getAttribute('type')).toBe('button')
    }
    // 分隔线在 wrap 最前，整块 wrap 仍挂在菜单内容区末尾。
    const wrap = menu.querySelector('[data-dsh-workspace-link-item]')!
    expect(wrap.firstElementChild?.className).toContain('separator')
    expect(wrap.children).toHaveLength(3)
    expect(wrap.parentElement).toBe(menu.firstElementChild)
  })

  it('open item window.opens the ws link with _blank+noopener and closes through the anchor', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    const anchorClick = vi.fn()
    anchor.addEventListener('click', anchorClick)
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    anchorClick.mockClear()
    click(itemsOf(menu)[1]!)
    await settle()
    await settle()
    // 拼参正确：当前页地址 + ws 参数，_blank + noopener。
    expect(openSpy).toHaveBeenCalledTimes(1)
    const [url, target, features] = openSpy.mock.calls[0]!
    expect(url).toBe(buildWorkspaceFocusLink(window.location.href, 'w1'))
    expect(new URL(url as string).searchParams.get('ws')).toBe('w1')
    expect(target).toBe('_blank')
    expect(features).toBe('noopener')
    // 不写剪贴板、不弹 toast；菜单经锚按钮自己的 click 收起。
    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dsh-workspace-link-toast]')).toBeNull()
    expect(anchorClick).toHaveBeenCalledTimes(1)
  })

  it('degrades to the execCommand fallback and toasts failure without the Clipboard API', async () => {
    stubLanguage('zh-CN')
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const execCommand = vi.fn(() => false)
    document.execCommand = execCommand as unknown as typeof document.execCommand
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    click(itemOf(menu)!)
    await settle()
    await settle()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('[data-dsh-workspace-link-toast]')!.textContent)
      .toBe('复制失败，请手动复制地址后在链接后附加 ?ws= 工作区参数')
    delete (document as { execCommand?: unknown }).execCommand
  })

  it('skips the ungrouped bucket (no workspace id to link)', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { anchor } = buildRow('', '工作区“未分组”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    expect(itemOf(menu)).toBeNull()
  })

  it('never touches menus that open without a workspace anchor pending', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake())
    const { menu } = appendMenu()
    await settle()
    expect(menu.querySelector('[data-dsh-workspace-link-item]')).toBeNull()
  })

  it('ignores a menu mounted after the pending window expires', async () => {
    vi.useFakeTimers()
    try {
      stubClipboard(vi.fn().mockResolvedValue(undefined))
      dispose = registerWorkspaceLinkMenu(ctxFake())
      const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
      click(anchor)
      vi.advanceTimersByTime(900)
      const { menu } = appendMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(itemOf(menu)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose stops injecting and removes the stylesheet', async () => {
    stubClipboard(vi.fn().mockResolvedValue(undefined))
    dispose = registerWorkspaceLinkMenu(ctxFake())
    expect(document.head.querySelector('style[data-dsh-workspace-link-style]')).not.toBeNull()
    dispose()
    dispose = undefined
    expect(document.head.querySelector('style[data-dsh-workspace-link-style]')).toBeNull()
    const { anchor } = buildRow('w1', '工作区“我的工作区”的操作')
    click(anchor)
    const { menu } = appendMenu()
    await settle()
    expect(itemOf(menu)).toBeNull()
  })
})
