/**
 * 工作区行「更多」(…) 菜单的「独立工作区」注入（DOM 注入）：一个一级项 +
 * 自绘子菜单（复制链接 / 新窗口打开；后续独立工作区功能都收进这个子菜单）。
 *
 * 为什么是 DOM 注入：核心 WorkspaceBrowser 的菜单项是组件内硬编码数组
 * （rename/delete 两项），`sidebar.workspaces` 只有会话级菜单孔位，工作区级
 * 没有 slot；复刻整套 inject 面远重于一个菜单项。因此走本仓库既有的 DOM
 * 注入先例（strip-add-button / guide-blocks 同一族）：
 *
 * 1. 捕获阶段监听点击——工作区「更多」锚按钮的 `aria-label` 是核心 locale
 *    模板（zh「工作区“{name}”的操作」/ en "Workspace actions for {name}"），
 *    命中即记下所属行的 `data-row-key="workspace:<id>"`（未分组行没有 id，
 *    跳过）。
 * 2. 菜单是 `portal: true` 的 React portal（`[role="menu"]` 直接挂在 body
 *    下）；body 观察器看到它在 pending 窗口内出现，就把「分隔线 + 一级项 +
 *    子菜单」追加进菜单内容区。内容区取
 *    `menu.querySelector('[class*="_viewport"]') ?? menu`——核心 Menu 的
 *    首个子元素是 viewport（role=presentation），但运行宿主的核心版本可能
 *    多一层包装，按类名片段匹配才是稳定落点（与 dsh-ao-local 的
 *    tryInjectOfficialMenu 同一查询）；找不到退 menu 本体。
 * 3. 注入增高后菜单本身不重摆——按 ao-local 同款做一次视口夹取
 *    （`rect.bottom` 超出视口 12px 边距就把 `menu.style.top` 上移）。
 * 4. 子菜单是自绘的嵌套 `div[role=menu]`：定位照核心配方
 *    `bottom:-4px` / `left:calc(100%+10px)`，贴边翻转复用本仓库 menu-flip
 *    的 `data-dsh-sidebar-submenu` body 属性令牌（layout.css 的翻转规则只在
 *    属性存在时生效，宿主自有菜单不受染）；hover 开（对齐核心 onMouseOver
 *    语义）+ 点击兜底；Escape / 菜单外 pointerdown 收起；子菜单挂在父菜单
 *    容器内，父菜单随官方 onClose 卸载时天然随迁。
 * 5. 点击注入项：
 *    - 「复制链接」：拼 `?ws=<id>` 独立链接（workspace-focus.ts 的纯函数）
 *      → 写剪贴板（Clipboard API 优先，http 非安全上下文退 execCommand）→
 *      toast 反馈；
 *    - 「新窗口打开」：同一链接 `window.open(url, '_blank', 'noopener')`
 *      ——在用户点击手势内同步调用，不受弹窗拦截；`noopener` 断开 opener。
 *    两项随后都复用锚按钮的 click 让核心按自己的语义收起菜单（锚已被卸载
 *    时退化为派发 Escape，走核心菜单自己的关闭路径）。
 *
 * 降级契约（同族先例）：核心改了 aria 模板或行键 → 捕获不命中，菜单保持
 * 原样（缺一项，绝不坏页）；注入项样式全部走 `--dsw-*` 令牌转录核心
 * Menu.module.css 的 .item 配方（类名是构建产物，不作为钩子消费）。
 * 观察器、监听、计时器、样式表与 toast 都由 disposer 清理（ctx.effect）。
 */
import type { Context } from '../context-types.ts'
import type { SidebarStore } from './state.ts'
import { updatePluginSettings } from './plugin-settings.ts'
import { t } from './locales.ts'
import { buildGroupFocusLink, buildWorkspaceFocusLink } from './workspace-focus.ts'
import {
  WORKSPACE_GROUPS_SETTING_KEY,
  addGroup,
  buildEachWorkspaceFocusLinks,
  deleteGroup,
  groupsContaining,
  parseWorkspaceGroups,
  renameGroup,
  setGroupWorkspace,
  type WorkspaceGroup,
} from './workspace-groups.ts'
import { SUBMENU_FLIP_ATTR, submenuFlipTokens } from './menu-flip.ts'

/** 注入块（分隔线 + 一级项 + 子菜单）的标记属性。 */
const ITEM_MARKER = 'data-dsh-workspace-link-item'
/** 自绘子菜单卡片的标记属性（嵌套任意层共用一套配方）。 */
const SUBMENU_MARKER = 'data-dsh-workspace-submenu'
/** 子菜单展开态标记属性。 */
const SUBMENU_OPEN_MARKER = 'data-dsh-submenu-open'
/** 成功/失败 toast 的标记属性。 */
const TOAST_MARKER = 'data-dsh-workspace-link-toast'
/** 注入样式表的标记属性。 */
const STYLE_TAG_MARKER = 'data-dsh-workspace-link-style'
/** 组管理面板的标记属性。 */
const PANEL_MARKER = 'data-dsh-workspace-groups-panel'

/**
 * 样式：菜单项配方转录自 dsh-client-ui-primitives Menu.module.css（颜色走
 * 既有令牌——皮肤换肤时与原生菜单项一起重着色），子菜单卡片照核心 submenu
 * 几何（bottom:-4px / left:calc(100%+10px)，贴边翻转由 layout.css 的
 * body 属性规则接管），加 toast 的最小配方。
 */
const LINK_ITEM_CSS = `
[${ITEM_MARKER}] { position: relative; }
[${ITEM_MARKER}] .row-holder, [${SUBMENU_MARKER}] .row-holder { position: relative; }
[${ITEM_MARKER}] .menu-btn, [${SUBMENU_MARKER}] .menu-btn { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; }
[${ITEM_MARKER}] .menu-btn:hover:not(:disabled), [${ITEM_MARKER}] .menu-btn:focus-visible:not(:disabled), [${SUBMENU_MARKER}] .menu-btn:hover:not(:disabled), [${SUBMENU_MARKER}] .menu-btn:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
[${ITEM_MARKER}] .menu-btn .icon, [${SUBMENU_MARKER}] .menu-btn .icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon); }
[${ITEM_MARKER}] .menu-btn .icon svg, [${SUBMENU_MARKER}] .menu-btn .icon svg { width: 14px; height: 14px; }
[${ITEM_MARKER}] .menu-btn .text, [${SUBMENU_MARKER}] .menu-btn .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${ITEM_MARKER}] .menu-btn .chevron, [${SUBMENU_MARKER}] .menu-btn .chevron { display: inline-flex; flex: none; width: 12px; height: 12px; align-items: center; justify-content: center; color: var(--dsw-alias-icon-secondary, var(--dsw-alias-label-secondary)); }
[${ITEM_MARKER}] .menu-btn .chevron svg, [${SUBMENU_MARKER}] .menu-btn .chevron svg { width: 12px; height: 12px; }
[${ITEM_MARKER}] .separator, [${SUBMENU_MARKER}] .separator { height: 0.5px; margin: 3px 2px; background: var(--dsw-alias-border-l2); }
[${SUBMENU_MARKER}] { position: absolute; bottom: -4px; left: calc(100% + 10px); min-width: 180px; max-width: 300px; padding: 4px; display: none; z-index: 1; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #1b1b22)); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); box-shadow: var(--dsw-elevation-prominent); }
[${SUBMENU_MARKER}][${SUBMENU_OPEN_MARKER}] { display: block; }
[${SUBMENU_MARKER}]::before { content: ''; position: absolute; top: 0; bottom: 0; left: -10px; width: 10px; }
[${SUBMENU_MARKER}] .menu-btn .check { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-label-primary); font-size: 12px; }
[${TOAST_MARKER}] { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483000; max-width: 70vw; padding: 8px 14px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #1b1b22)); border: 0.5px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent); pointer-events: none; }
/* 组管理面板（跟随 AnchoredPopover 的定位/关闭契约，自绘 DOM 卡）。 */
[${PANEL_MARKER}] { position: fixed; z-index: 2147483000; width: 340px; max-width: calc(100vw - 16px); max-height: min(72vh, 560px); overflow: auto; padding: 12px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #1b1b22)); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); box-shadow: var(--dsw-elevation-prominent); }
[${PANEL_MARKER}] .panel-head { display: flex; align-items: center; gap: 8px; }
[${PANEL_MARKER}] .panel-title { flex: 1; font-weight: 600; }
[${PANEL_MARKER}] .panel-hint { margin-top: 2px; color: var(--dsw-alias-label-secondary); }
[${PANEL_MARKER}] .panel-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }
[${PANEL_MARKER}] .panel-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[${PANEL_MARKER}] .panel-close svg { width: 12px; height: 12px; }
[${PANEL_MARKER}] .panel-btn { padding: 3px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); white-space: nowrap; }
[${PANEL_MARKER}] .panel-btn:hover:not(:disabled), [${PANEL_MARKER}] .panel-btn:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
[${PANEL_MARKER}] .panel-btn:disabled { opacity: 0.5; cursor: default; }
[${PANEL_MARKER}] .panel-empty { padding: 10px 0 2px; color: var(--dsw-alias-label-secondary); }
[${PANEL_MARKER}] .group-card { margin-top: 10px; padding: 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); display: flex; flex-direction: column; gap: 6px; }
[${PANEL_MARKER}] .group-line { display: flex; align-items: center; gap: 6px; }
[${PANEL_MARKER}] .group-name { flex: 1; min-width: 0; padding: 3px 6px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: transparent; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
[${PANEL_MARKER}] .group-name:focus { outline: none; border-color: var(--dsw-alias-border-focus, var(--dsw-alias-border-l2)); }
[${PANEL_MARKER}] .chip-remove, [${PANEL_MARKER}] .group-remove { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }
[${PANEL_MARKER}] .chip-remove:hover, [${PANEL_MARKER}] .group-remove:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
[${PANEL_MARKER}] .chip-remove svg, [${PANEL_MARKER}] .group-remove svg, [${PANEL_MARKER}] .panel-close svg { width: 10px; height: 10px; }
[${PANEL_MARKER}] .group-actions { display: flex; flex-wrap: wrap; gap: 6px; }
[${PANEL_MARKER}] .members-label { color: var(--dsw-alias-label-secondary); }
[${PANEL_MARKER}] .chips { display: flex; flex-wrap: wrap; gap: 4px; }
[${PANEL_MARKER}] .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 4px 2px 8px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover); }
[${PANEL_MARKER}] .chip .chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${PANEL_MARKER}] .chip.stale .chip-text { text-decoration: line-through; opacity: 0.65; }
[${PANEL_MARKER}] .members-add { margin-top: 2px; }
[${PANEL_MARKER}] select.members-add, [${PANEL_MARKER}] input.new-group-input { width: 100%; padding: 3px 6px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: transparent; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); }
[${PANEL_MARKER}] select.members-add option { color: #1b1b22; }
`

/** 链条图标（14px、stroke=currentColor，与核心菜单 14px 图标同规格）。 */
const LINK_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.7 9.3l2.6-2.6"/><path d="M7.4 4.9l1.5-1.5a2.6 2.6 0 0 1 3.7 3.7L11.1 8.6"/><path d="M8.6 11.1l-1.5 1.5a2.6 2.6 0 0 1-3.7-3.7l1.5-1.5"/></svg>'

/** 外链图标（同规格）：「新窗口打开」项——方框 + 右上箭头。 */
const EXTERNAL_LINK_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5H4.75A1.25 1.25 0 0 0 3.5 4.75v6.5a1.25 1.25 0 0 0 1.25 1.25h6.5a1.25 1.25 0 0 0 1.25-1.25V9.5"/><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5L7.75 8.25"/></svg>'

/** 层叠窗口图标（同规格）：「独立工作区」一级项。 */
const STANDALONE_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.5" width="9" height="8" rx="1.2"/><path d="M5.5 5.5V4.75A1.25 1.25 0 0 1 6.75 3.5h4.5a1.25 1.25 0 0 1 1.25 1.25v4.5a1.25 1.25 0 0 1-1.25 1.25H10.5"/></svg>'

/** 右箭头图标（12px）：带子菜单的行的尾部箭头。 */
const CHEVRON_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>'

/** 关闭/移除图标（✕，10-12px）：管理面板的关闭按钮与 chip/组的移除按钮。 */
const CLOSE_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8"/><path d="M12 4l-8 8"/></svg>'

/** 加号图标（同规格）：「＋ 新建组…」行。 */
const PLUS_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5v9"/><path d="M3.5 8h9"/></svg>'

/** 加组图标（同规格）：「加入到组」行——方框 + 内部加号。 */
const GROUP_ADD_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 5.5v5"/><path d="M5.5 8h5"/></svg>'

/** 文件夹图标（同规格）：「所属组」行的组名行。 */
const FOLDER_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.75A1.25 1.25 0 0 1 3.25 3.5h2.9a1.25 1.25 0 0 1 .9.38L8.1 5h4.65A1.25 1.25 0 0 1 14 6.25v5A1.25 1.25 0 0 1 12.75 12.5H3.25A1.25 1.25 0 0 1 2 11.25Z"/></svg>'

/** 齿轮图标（同规格）：「管理独立工作区组…」行。 */
const GEAR_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1.8l.9 1.6 1.8-.4 .5 1.8 1.8.5-.4 1.8 1.6.9-1.6.9.4 1.8-1.8.5-.5 1.8-1.8-.4-.9 1.6-.9-1.6-1.8.4-.5-1.8-1.8-.5.4-1.8L1.8 8l1.6-.9-.4-1.8 1.8-.5.5-1.8 1.8.4Z"/></svg>'

/** 核心工作区快照里本插件消费的最小字段形状（path 给管理面板取展示名）。 */
interface WorkspaceSnapshotItem {
  readonly workspaceId: string
  readonly path?: string
}

/** 工作区「更多」锚按钮的 aria-label 形状（核心 locale 模板，zh/en 两档）。 */
function isWorkspaceMenuAnchor(anchor: Element): boolean {
  const label = anchor.getAttribute('aria-label') ?? ''
  return label.startsWith('Workspace actions for ') || /^工作区“.+”的操作$/.test(label)
}

/** 把文本写进剪贴板；Clipboard API 不可用（http 非安全上下文）退 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到 execCommand 兜底。
  }
  try {
    const scratch = document.createElement('textarea')
    scratch.value = text
    scratch.setAttribute('readonly', '')
    scratch.style.cssText = 'position:fixed;left:-9999px;top:0;'
    document.body.appendChild(scratch)
    scratch.select()
    const ok = document.execCommand !== undefined && document.execCommand('copy')
    scratch.remove()
    return ok
  } catch {
    return false
  }
}

/**
 * 菜单定位在打开时按「未注入前」的尺寸计算，注入增高后手动夹回视口内
 * （与 dsh-ao-local 同款：超视口底部就把菜单 top 上移回 12px 边距内；
 * 夹取失败只记 warn，不影响功能——官方 scrollable 的 max-height 兜底）。
 */
function clampMenuIntoViewport(menu: Element): void {
  try {
    const rect = menu.getBoundingClientRect()
    const overflowBottom = rect.bottom - (window.innerHeight - 12)
    if (overflowBottom > 0 && rect.top - overflowBottom >= 12) {
      ;(menu as HTMLElement).style.top = `${rect.top - overflowBottom}px`
    }
  } catch (error) {
    console.warn('[dsh-better-sidebar] 菜单视口夹取失败（不影响功能）:', error)
  }
}

/**
 * 读取核心 workspaces.list 快照里本插件消费的最小字段（try/catch——cordis
 * 对未声明 inject 的 get 会抛；读不到按空快照兜底，菜单照常）。
 */
function workspaceSnapshotItems(ctx: Context): WorkspaceSnapshotItem[] {
  try {
    const face = (ctx as unknown as { get: (name: string) => unknown }).get('workspaces') as
      | { list?: { getSnapshot?: () => { items?: WorkspaceSnapshotItem[] } } }
      | undefined
    return face?.list?.getSnapshot?.()?.items ?? []
  } catch {
    return []
  }
}

/**
 * 注册「独立工作区」菜单注入（一级项 + 子菜单 + 组动作 + 组管理面板）。
 * `store` 是侧边栏 prefs store：组数据读 `pluginSettings.workspaceGroups`、
 * 写走 plugin-settings 的串行写队列（settings.update 返回后 store prefs
 * 原地更新）。返回 disposer：摘监听、断观察器、清计时器、移除样式表、
 * toast 与在屏的管理面板。
 */
export function registerWorkspaceLinkMenu(ctx: Context, store: SidebarStore): () => void {

  const tag = document.createElement('style')
  tag.setAttribute(STYLE_TAG_MARKER, '')
  tag.textContent = LINK_ITEM_CSS
  document.head.appendChild(tag)

  let disposed = false
  /** 锚点击记下的待注入目标；null = 没有（点击别处/超时即失效）。 */
  let pendingWorkspaceId: string | null = null
  /** 记 pending 时的锚按钮（点完菜单项后按它收起；被核心重渲染即退 Escape）。 */
  let pendingAnchor: Element | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  /** 当前注入块（菜单在屏期间有效；菜单卸载即 null）。 */
  let injectedWrap: HTMLElement | null = null
  /** 当前注入所在的官方菜单（flip 令牌取它的卡片边缘）。 */
  let injectedMenu: HTMLElement | null = null
  /** 展开中的自绘子菜单栈（外层在前；收起按栈深倒序）。 */
  const openSubmenus: Array<{ holder: HTMLElement; sub: HTMLElement }> = []
  /**
   * 嵌套子菜单卡的懒渲染器：卡片建空壳，**展开时**才画内容——组清单/成员
   * 勾选态按当下草稿现算（不快照在菜单打开那一刻），也让未展开的空卡不
   * 干扰菜单内容的查询。每次展开都重画，保证数据新鲜。
   */
  const cardRenderers = new WeakMap<HTMLElement, () => void>()
  /**
   * 组数据的本地草稿：菜单/面板打开时从 store prefs 播种，之后一切改动先落
   * 草稿再串行写穿设置通道（写失败只记 error，界面按草稿继续——与
   * open-with-settings 的「弹窗打开期间本地草稿权威」同一语义）。
   */
  let draftGroups: WorkspaceGroup[] = []
  /** 在屏的组管理面板（同时最多一个）。 */
  let panel: HTMLElement | null = null

  const clearPending = (): void => {
    pendingWorkspaceId = null
    pendingAnchor = null
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer)
      pendingTimer = undefined
    }
  }

  const showToast = (text: string): void => {
    if (disposed) return
    document.querySelector(`[${TOAST_MARKER}]`)?.remove()
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    const toast = document.createElement('div')
    toast.setAttribute(TOAST_MARKER, '')
    toast.setAttribute('role', 'status')
    toast.setAttribute('aria-live', 'polite')
    toast.textContent = text
    document.body.appendChild(toast)
    toastTimer = setTimeout(() => {
      toastTimer = undefined
      toast.remove()
    }, 1900)
  }

  /** 收起菜单：优先复用锚按钮的原生 click（核心自己的 toggle 语义收起）。 */
  const closeMenu = (anchor: Element | null): void => {
    if (anchor !== null && anchor.isConnected) {
      ;(anchor as HTMLElement).click()
      return
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  /** 从 store prefs 读组清单（坏值兜底空数组——解析器内部已容错）。 */
  const readGroupsFromStore = (): WorkspaceGroup[] =>
    parseWorkspaceGroups(store.getPrefs().pluginSettings[WORKSPACE_GROUPS_SETTING_KEY])

  /**
   * 提交一次组改动：先落本地草稿（界面即时按草稿重画），再经 plugin-settings
   * 的串行写队列写穿设置通道（descriptor = `pluginSettings.workspaceGroups`；
   * 写失败由队列记 error，草稿不受影响）。
   */
  const commitGroups = (next: WorkspaceGroup[]): void => {
    draftGroups = next
    updatePluginSettings(store, WORKSPACE_GROUPS_SETTING_KEY, () => ({
      groups: next.map((group) => ({ id: group.id, name: group.name, workspaceIds: [...group.workspaceIds] })),
    }))
  }

  /** 工作区展示名：快照 path 的末段（basename），取不到退 id 本身。 */
  const workspaceNameOf = (workspaceId: string): string => {
    const path = workspaceSnapshotItems(ctx).find((item) => item.workspaceId === workspaceId)?.path
    const base = path !== undefined && path !== '' ? path.split(/[\\/]/).filter(Boolean).pop() : undefined
    return base ?? workspaceId
  }

  /** 收起全部展开中的子菜单（栈深倒序；全空时摘掉 body 的 flip 令牌）。 */
  const closeAllSubmenus = (): void => {
    for (const entry of [...openSubmenus].reverse()) {
      entry.sub.removeAttribute(SUBMENU_OPEN_MARKER)
      entry.holder.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false')
      openSubmenus.splice(openSubmenus.indexOf(entry), 1)
    }
    if (openSubmenus.length === 0) document.body.removeAttribute(SUBMENU_FLIP_ATTR)
  }

  /** 当前指针位置对一个子菜单的 flip 令牌：x 取所属菜单卡右缘，y 取行中线。 */
  const publishFlipTokens = (holder: HTMLElement, ownerCard: Element): void => {
    const rowRect = holder.getBoundingClientRect()
    const cardRect = ownerCard.getBoundingClientRect()
    document.body.setAttribute(
      SUBMENU_FLIP_ATTR,
      submenuFlipTokens(cardRect.right, rowRect.top + rowRect.height / 2, window.innerWidth, window.innerHeight),
    )
  }

  /** 展开一个子菜单（先收起非祖先的已开卡片；展开时懒渲染内容；发 flip 令牌；同步 aria）。 */
  const openSubmenu = (entry: { holder: HTMLElement; sub: HTMLElement }): void => {
    for (const existing of [...openSubmenus].reverse()) {
      if (!existing.sub.contains(entry.holder)) {
        existing.sub.removeAttribute(SUBMENU_OPEN_MARKER)
        existing.holder.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false')
        openSubmenus.splice(openSubmenus.indexOf(existing), 1)
      }
    }
    cardRenderers.get(entry.sub)?.()
    entry.sub.setAttribute(SUBMENU_OPEN_MARKER, '')
    entry.holder.querySelector('button[aria-haspopup="menu"]')?.setAttribute('aria-expanded', 'true')
    openSubmenus.push(entry)
    // 所属卡片：行的最近 [role=menu] 祖先（一级=官方菜单，二级=上一层自绘卡）。
    const ownerCard = entry.holder.parentElement?.closest('[role="menu"]')
    if (ownerCard !== null && ownerCard !== undefined) publishFlipTokens(entry.holder, ownerCard)
  }

  /** hover 开（对齐核心 onMouseOver 语义）：命中带子菜单的行开它的卡，命中普通行收起非祖先卡。 */
  const onWrapMouseOver = (event: MouseEvent): void => {
    if (injectedWrap === null) return
    const target = event.target instanceof Element ? event.target : null
    const holder = target?.closest<HTMLElement>('.row-holder')
    if (holder === null || holder === undefined || !injectedWrap.contains(holder)) return
    const sub = holder.querySelector<HTMLElement>(`[${SUBMENU_MARKER}]`)
    if (sub !== null) {
      if (!sub.hasAttribute(SUBMENU_OPEN_MARKER)) openSubmenu({ holder, sub })
      return
    }
    // 普通行：收起一切不包含该行的已开卡片（指针已经走到别处）。
    for (const entry of [...openSubmenus].reverse()) {
      if (!entry.sub.contains(holder)) {
        entry.sub.removeAttribute(SUBMENU_OPEN_MARKER)
        entry.holder.querySelector('button[aria-expanded]')?.setAttribute('aria-expanded', 'false')
        openSubmenus.splice(openSubmenus.indexOf(entry), 1)
      }
    }
    if (openSubmenus.length === 0) document.body.removeAttribute(SUBMENU_FLIP_ATTR)
  }

  /** Escape / 菜单外 pointerdown 收起全部子菜单（菜单本体由核心自己管）。 */
  const onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeAllSubmenus()
  }
  const onGlobalPointerDown = (event: PointerEvent | MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    if (injectedWrap === null || target === null || !injectedWrap.contains(target)) closeAllSubmenus()
  }

  /** 菜单被核心卸载（onClose）后摘掉子菜单状态与全局监听。 */
  const teardownInjection = (): void => {
    openSubmenus.length = 0
    document.body.removeAttribute(SUBMENU_FLIP_ATTR)
    document.removeEventListener('keydown', onGlobalKeyDown, true)
    document.removeEventListener('pointerdown', onGlobalPointerDown, true)
    injectedWrap = null
    injectedMenu = null
  }

  /**
   * 造一个注入菜单项按钮：`role=menuitem` + aria-label + 图标 + 文案
   * （键盘可达性走核心菜单自身的上下键漫游，注入项天然在漫游序里）。
   * `ariaLabel` 覆盖默认的「文案即 aria-label」（组行用它带「组动作：」前缀）。
   */
  const buildMenuButton = (label: string, iconSvg: string, options?: { chevron?: boolean; hasPopUp?: 'menu' }, ariaLabel?: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'menu-btn'
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-label', ariaLabel ?? label)
    if (options?.hasPopUp !== undefined) {
      button.setAttribute('aria-haspopup', options.hasPopUp)
      button.setAttribute('aria-expanded', 'false')
    }
    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.innerHTML = iconSvg
    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = label
    button.append(icon, text)
    if (options?.chevron === true) {
      const chevron = document.createElement('span')
      chevron.className = 'chevron'
      chevron.innerHTML = CHEVRON_ICON_SVG
      button.appendChild(chevron)
    }
    return button
  }

  /** 造一个行容器（position:relative，子菜单锚定它），按钮/输入框 + 子菜单卡放里面。 */
  const buildRowHolder = (control: HTMLElement, sub?: HTMLElement): HTMLElement => {
    const holder = document.createElement('div')
    holder.className = 'row-holder'
    holder.appendChild(control)
    if (sub !== undefined) holder.appendChild(sub)
    return holder
  }

  /** 造一张自绘子菜单卡（嵌套 div[role=menu]，隐藏待开；配方见文件头）。 */
  const buildSubmenuCard = (): HTMLElement => {
    const sub = document.createElement('div')
    sub.setAttribute('role', 'menu')
    sub.setAttribute(SUBMENU_MARKER, '')
    return sub
  }

  /** 造一个行内分隔线。 */
  const buildSeparator = (): HTMLElement => {
    const separator = document.createElement('div')
    separator.className = 'separator'
    separator.setAttribute('role', 'separator')
    return separator
  }

  /** 造一个普通动作行（点击执行 action；action 内部负责收起菜单）。 */
  const buildActionRow = (label: string, iconSvg: string, onClick: (event: MouseEvent) => void, ariaLabel?: string): HTMLElement => {
    const button = buildMenuButton(label, iconSvg)
    if (ariaLabel !== undefined) button.setAttribute('aria-label', ariaLabel)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onClick(event)
    })
    return buildRowHolder(button)
  }

  /**
   * 「加入到组 ▸」行：子卡 = 组清单勾选（menuitemcheckbox，点选切换归属）
   * + 分隔线 + 「＋ 新建组…」行内输入。勾选切换只重画这张子卡（卡片保持
   * 展开不闪）；新建组提交后整棵子菜单重画（「所属组」区多出一条）。
   */
  const buildAddToGroupRow = (submenu: HTMLElement, workspaceId: string, anchor: Element | null): HTMLElement => {
    const label = t('workspaceMenuAddToGroup')
    const button = buildMenuButton(label, GROUP_ADD_ICON_SVG, { chevron: true, hasPopUp: 'menu' })
    const sub = buildSubmenuCard()
    const renderCard = (): void => {
      sub.textContent = ''
      for (const group of draftGroups) {
        const member = group.workspaceIds.includes(workspaceId)
        const check = document.createElement('span')
        check.className = 'check'
        check.textContent = member ? '✓' : ''
        const rowButton = document.createElement('button')
        rowButton.type = 'button'
        rowButton.className = 'menu-btn'
        rowButton.setAttribute('role', 'menuitemcheckbox')
        rowButton.setAttribute('aria-label', group.name)
        rowButton.setAttribute('aria-checked', member ? 'true' : 'false')
        const text = document.createElement('span')
        text.className = 'text'
        text.textContent = group.name
        rowButton.append(check, text)
        rowButton.addEventListener('click', (event) => {
          event.stopPropagation()
          commitGroups(setGroupWorkspace(draftGroups, group.id, workspaceId, !member))
          renderCard()
        })
        sub.appendChild(buildRowHolder(rowButton))
      }
      sub.appendChild(buildSeparator())
      const newButton = buildMenuButton(t('workspaceMenuNewGroup'), PLUS_ICON_SVG)
      newButton.addEventListener('click', (event) => {
        event.stopPropagation()
        // 行内输入建组：Enter 提交（建组 + 勾上本工作区 + 整棵重画），
        // Escape / 失焦回清单。
        sub.textContent = ''
        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'new-group-input'
        input.placeholder = t('workspaceGroupNamePlaceholder')
        const finish = (): void => renderCard()
        input.addEventListener('keydown', (keyEvent) => {
          if (keyEvent.key === 'Enter') {
            keyEvent.stopPropagation()
            const name = input.value.trim()
            if (name === '') return
            keyEvent.preventDefault()
            const created = addGroup(draftGroups, name)
            commitGroups(setGroupWorkspace(created.groups, created.group.id, workspaceId, true))
            renderSubmenuContent(submenu, workspaceId, anchor)
          } else if (keyEvent.key === 'Escape') {
            keyEvent.stopPropagation()
            finish()
          }
        })
        input.addEventListener('blur', finish)
        const inputHolder = buildRowHolder(input)
        sub.appendChild(inputHolder)
        input.focus()
      })
      sub.appendChild(buildRowHolder(newButton))
    }
    // 懒渲染：建卡时只留空壳，展开时才按当下草稿画内容（见 cardRenderers）。
    cardRenderers.set(sub, renderCard)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (sub.hasAttribute(SUBMENU_OPEN_MARKER)) closeAllSubmenus()
      else openSubmenu({ holder: button.parentElement as HTMLElement, sub })
    })
    return buildRowHolder(button, sub)
  }

  /**
   * 「所属组」行（每个包含本工作区的组一条）：子卡 = 新窗口打开全组 /
   * 复制全组链接 / 从该组移出。组链接 = 一条 `?ws=g:<groupId>`（整组一个
   * 窗口，打开时按组解析显示多少——不做每工作区各开一窗）。
   */
  const buildGroupRow = (group: WorkspaceGroup, submenu: HTMLElement, workspaceId: string, anchor: Element | null): HTMLElement => {
    const button = buildMenuButton(group.name, FOLDER_ICON_SVG, { chevron: true, hasPopUp: 'menu' }, `${t('workspaceGroupActions')}：${group.name}`)
    const sub = buildSubmenuCard()
    // 懒渲染（同加入到组卡）：展开时才画，未展开的空卡不干扰菜单内容查询。
    const renderCard = (): void => {
      sub.textContent = ''
      sub.appendChild(buildActionRow(t('workspaceGroupOpenAll'), EXTERNAL_LINK_ICON_SVG, () => {
        window.open(buildGroupFocusLink(window.location.href, group.id), '_blank', 'noopener')
        closeAllSubmenus()
        closeMenu(anchor)
      }))
      sub.appendChild(buildActionRow(t('workspaceGroupCopyLink'), LINK_ICON_SVG, () => {
        const link = buildGroupFocusLink(window.location.href, group.id)
        void copyText(link).then((ok) => {
          showToast(ok
            ? t('workspaceGroupLinkCopied', { name: group.name, count: group.workspaceIds.length })
            : t('workspaceLinkCopyFailed'))
        })
        closeAllSubmenus()
        closeMenu(anchor)
      }))
      sub.appendChild(buildSeparator())
      sub.appendChild(buildActionRow(t('workspaceGroupLeave'), CLOSE_ICON_SVG, () => {
        commitGroups(setGroupWorkspace(draftGroups, group.id, workspaceId, false))
        closeAllSubmenus()
        renderSubmenuContent(submenu, workspaceId, anchor)
      }))
    }
    cardRenderers.set(sub, renderCard)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (sub.hasAttribute(SUBMENU_OPEN_MARKER)) closeAllSubmenus()
      else openSubmenu({ holder: button.parentElement as HTMLElement, sub })
    })
    return buildRowHolder(button, sub)
  }

  /** 画「独立工作区」子菜单的完整内容（注入时 + 每次组改动后整体重画）。 */
  const renderSubmenuContent = (submenu: HTMLElement, workspaceId: string, anchor: Element | null): void => {
    closeAllSubmenus()
    submenu.textContent = ''
    // 复制链接 / 新窗口打开（单工作区，逻辑与 0.28.31/32 的两项一致）。
    submenu.appendChild(buildActionRow(t('workspaceMenuCopyLink'), LINK_ICON_SVG, () => {
      const link = buildWorkspaceFocusLink(window.location.href, workspaceId)
      void copyText(link).then((ok) => {
        showToast(ok ? t('workspaceLinkCopied') : t('workspaceLinkCopyFailed'))
      })
      closeAllSubmenus()
      closeMenu(anchor)
    }))
    submenu.appendChild(buildActionRow(t('workspaceMenuOpenWindow'), EXTERNAL_LINK_ICON_SVG, () => {
      const link = buildWorkspaceFocusLink(window.location.href, workspaceId)
      window.open(link, '_blank', 'noopener')
      closeAllSubmenus()
      closeMenu(anchor)
    }))
    submenu.appendChild(buildSeparator())
    // 加入到组 ▸（组清单勾选 + 新建组）
    submenu.appendChild(buildAddToGroupRow(submenu, workspaceId, anchor))
    // 所属组各一条 ▸（组动作子卡）
    for (const group of groupsContaining(draftGroups, workspaceId)) {
      submenu.appendChild(buildGroupRow(group, submenu, workspaceId, anchor))
    }
    submenu.appendChild(buildSeparator())
    // 管理独立工作区组…（自绘面板；打开前记菜单卡位置作为锚）
    submenu.appendChild(buildActionRow(t('workspaceMenuManageGroups'), GEAR_ICON_SVG, () => {
      const menuRect = injectedMenu?.getBoundingClientRect() ?? null
      closeAllSubmenus()
      closeMenu(anchor)
      if (menuRect !== null) openGroupsPanel(menuRect)
    }))
  }

  /** 造一个面板按钮（panel-btn；disabled 时点击无效）。 */
  const buildPanelButton = (label: string, onClick: () => void, disabled = false, ariaLabel?: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'panel-btn'
    if (ariaLabel !== undefined) button.setAttribute('aria-label', ariaLabel)
    button.disabled = disabled
    button.textContent = label
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (button.disabled) return
      onClick()
    })
    return button
  }

  /**
   * 造一个移除小按钮（✕；chip 与组删除共用）。`className` 区分触点：
   * chip 用 `chip-remove`（小号），组删除用 `group-remove`（同一配方，语义
   * 类名给测试与样式钩子，CSS 两类同规则）。
   */
  const buildRemoveButton = (ariaLabel: string, onClick: () => void, className = 'chip-remove'): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.setAttribute('aria-label', ariaLabel)
    button.setAttribute('title', ariaLabel)
    button.innerHTML = CLOSE_ICON_SVG
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onClick()
    })
    return button
  }

  /** 重画管理面板内容（组/成员的一切改动后整体重画；输入框按行内受控处理）。 */
  const renderPanel = (): void => {
    if (panel === null) return
    panel.textContent = ''
    const head = document.createElement('div')
    head.className = 'panel-head'
    const title = document.createElement('span')
    title.className = 'panel-title'
    title.textContent = t('workspaceGroupsPanelTitle')
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'panel-close'
    close.setAttribute('aria-label', t('workspaceGroupsClose'))
    close.setAttribute('title', t('workspaceGroupsClose'))
    close.innerHTML = CLOSE_ICON_SVG
    close.addEventListener('click', () => { closePanel() })
    head.append(title, close)
    panel.appendChild(head)
    const hint = document.createElement('div')
    hint.className = 'panel-hint'
    hint.textContent = t('workspaceGroupsPanelHint')
    panel.appendChild(hint)

    if (draftGroups.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'panel-empty'
      empty.textContent = t('workspaceGroupsEmpty')
      panel.appendChild(empty)
    }

    // ＋ 新建组（行内输入：Enter 提交，Escape/失焦收回按钮）。
    const addArea = document.createElement('div')
    addArea.className = 'members-add'
    const addBtn = buildPanelButton(t('workspaceGroupsAdd'), () => {
      addArea.textContent = ''
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'new-group-input'
      input.placeholder = t('workspaceGroupNamePlaceholder')
      const finish = (): void => renderPanel()
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.stopPropagation()
          const name = input.value.trim()
          if (name === '') return
          event.preventDefault()
          commitGroups(addGroup(draftGroups, name).groups)
          renderPanel()
        } else if (event.key === 'Escape') {
          event.stopPropagation()
          finish()
        }
      })
      input.addEventListener('blur', finish)
      addArea.appendChild(input)
      input.focus()
    })
    addArea.appendChild(addBtn)
    panel.appendChild(addArea)

    // 快照 id 集（就绪与否决定「已失效」标灰；未就绪时不猜）。
    const items = workspaceSnapshotItems(ctx)
    const knownIds = new Set(items.map((item) => item.workspaceId))
    const idsReady = items.length > 0

    for (const group of draftGroups) {
      const card = document.createElement('div')
      card.className = 'group-card'
      card.dataset.groupId = group.id

      // 组名行：行内重命名（受控输入 + 串行写穿，无重渲染不打字）。
      const nameLine = document.createElement('div')
      nameLine.className = 'group-line'
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.className = 'group-name'
      nameInput.value = group.name
      nameInput.setAttribute('aria-label', `${t('workspaceGroupsPanelTitle')}：${group.name}`)
      nameInput.addEventListener('change', () => {
        const name = nameInput.value.trim()
        if (name === '' || name === group.name) { nameInput.value = group.name; return }
        commitGroups(renameGroup(draftGroups, group.id, name))
      })
      nameLine.append(nameInput, buildRemoveButton(t('workspaceGroupsDelete'), () => {
        commitGroups(deleteGroup(draftGroups, group.id))
        renderPanel()
      }, 'group-remove'))
      card.appendChild(nameLine)

      // 组动作行：新窗口打开全组（一条 g: 链接整组一个窗口）/ 复制全组链接 /
      // 复制全部单工作区链接（每行一条裸链接的兜底格式）。
      const actions = document.createElement('div')
      actions.className = 'group-actions'
      actions.append(
        buildPanelButton(t('workspaceGroupOpenAll'), () => {
          window.open(buildGroupFocusLink(window.location.href, group.id), '_blank', 'noopener')
        }, false),
        buildPanelButton(t('workspaceGroupCopyLink'), () => {
          const link = buildGroupFocusLink(window.location.href, group.id)
          void copyText(link).then((ok) => {
            showToast(ok
              ? t('workspaceGroupLinkCopied', { name: group.name, count: group.workspaceIds.length })
              : t('workspaceLinkCopyFailed'))
          })
        }, false),
        buildPanelButton(t('workspaceGroupsCopyEach'), () => {
          if (group.workspaceIds.length === 0) return
          void copyText(buildEachWorkspaceFocusLinks(window.location.href, group.workspaceIds)).then((ok) => {
            showToast(ok
              ? t('workspaceGroupsCopiedAll', { count: group.workspaceIds.length })
              : t('workspaceLinkCopyFailed'))
          })
        }, group.workspaceIds.length === 0),
      )
      card.appendChild(actions)

      // 成员区：chip（失效 id 标灰划线可清）+ 候选下拉（快照 − 现有成员）。
      const membersLabel = document.createElement('div')
      membersLabel.className = 'members-label'
      membersLabel.textContent = t('workspaceGroupsMembersLabel')
      card.appendChild(membersLabel)
      const chips = document.createElement('div')
      chips.className = 'chips'
      for (const workspaceId of group.workspaceIds) {
        const stale = idsReady && !knownIds.has(workspaceId)
        const chip = document.createElement('span')
        chip.className = stale ? 'chip stale' : 'chip'
        chip.title = stale ? `${workspaceId}（${t('workspaceGroupsStale')}）` : workspaceId
        const text = document.createElement('span')
        text.className = 'chip-text'
        text.textContent = stale ? `${workspaceNameOf(workspaceId)}（${t('workspaceGroupsStale')}）` : workspaceNameOf(workspaceId)
        chip.append(text, buildRemoveButton(t('workspaceGroupsRemove'), () => {
          commitGroups(setGroupWorkspace(draftGroups, group.id, workspaceId, false))
          renderPanel()
        }))
        chips.appendChild(chip)
      }
      card.appendChild(chips)
      const candidates = items.filter((item) => !group.workspaceIds.includes(item.workspaceId))
      if (candidates.length > 0) {
        const select = document.createElement('select')
        select.className = 'members-add'
        const placeholder = document.createElement('option')
        placeholder.value = ''
        placeholder.textContent = t('workspaceGroupsAddMember')
        placeholder.disabled = true
        placeholder.selected = true
        select.appendChild(placeholder)
        for (const item of candidates) {
          const option = document.createElement('option')
          option.value = item.workspaceId
          option.textContent = workspaceNameOf(item.workspaceId)
          select.appendChild(option)
        }
        select.addEventListener('change', () => {
          if (select.value === '') return
          commitGroups(setGroupWorkspace(draftGroups, group.id, select.value, true))
          renderPanel()
        })
        card.appendChild(select)
      }
      panel.appendChild(card)
    }
  }

  /** 关掉管理面板（摘全局监听 + 移除节点）。 */
  const closePanel = (): void => {
    if (panel === null) return
    document.removeEventListener('keydown', onPanelKeyDown, true)
    document.removeEventListener('pointerdown', onPanelPointerDown, true)
    panel.remove()
    panel = null
  }

  const onPanelKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePanel()
  }
  const onPanelPointerDown = (event: PointerEvent | MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    if (panel !== null && (target === null || !panel.contains(target))) closePanel()
  }

  /**
   * 打开组管理面板（跟随 AnchoredPopover 的定位契约：锚下方 6px，底部放不
   * 下翻到锚上方，左右夹回 8px 边距；Escape / 外点 / 关闭按钮收起）。
   */
  const openGroupsPanel = (anchorRect: DOMRect): void => {
    closePanel()
    const card = document.createElement('div')
    card.setAttribute(PANEL_MARKER, '')
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', t('workspaceGroupsPanelTitle'))
    panel = card
    renderPanel()
    document.body.appendChild(card)
    const width = Math.min(340, window.innerWidth - 16)
    let top = anchorRect.bottom + 6
    const height = card.offsetHeight
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchorRect.top - height - 6)
    const left = Math.min(Math.max(8, anchorRect.right - width), Math.max(8, window.innerWidth - width - 8))
    card.style.left = `${left}px`
    card.style.top = `${top}px`
    card.style.width = `${width}px`
    document.addEventListener('keydown', onPanelKeyDown, true)
    document.addEventListener('pointerdown', onPanelPointerDown, true)
  }

  const onItemMounted = (menu: Element): void => {
    if (pendingWorkspaceId === null || disposed) return
    if (menu.querySelector(`[${ITEM_MARKER}]`) !== null) return
    // 注入落点：viewport 类名片段匹配优先（稳定），找不到退菜单本体。
    const viewport = menu.querySelector('[class*="_viewport"]') ?? menu
    const workspaceId = pendingWorkspaceId
    const anchor = pendingAnchor
    clearPending()

    const wrap = document.createElement('div')
    wrap.setAttribute(ITEM_MARKER, '')

    const separator = document.createElement('div')
    separator.className = 'separator'
    separator.setAttribute('role', 'separator')
    wrap.appendChild(separator)

    // 一级项「独立工作区」：hover/点击开自绘子菜单（点击不收起菜单本体）。
    const topButton = buildMenuButton(t('workspaceMenuLabel'), STANDALONE_ICON_SVG, { chevron: true, hasPopUp: 'menu' })
    const submenu = buildSubmenuCard()
    const topHolder = buildRowHolder(topButton, submenu)
    topButton.addEventListener('click', (event) => {
      event.stopPropagation()
      if (submenu.hasAttribute(SUBMENU_OPEN_MARKER)) closeAllSubmenus()
      else openSubmenu({ holder: topHolder, sub: submenu })
    })
    wrap.appendChild(topHolder)

    // 组草稿播种（菜单每次打开读当下值）+ 子菜单内容整画。
    draftGroups = readGroupsFromStore()
    renderSubmenuContent(submenu, workspaceId, anchor)

    wrap.addEventListener('mouseover', onWrapMouseOver)
    viewport.appendChild(wrap)
    injectedWrap = wrap
    injectedMenu = menu as HTMLElement
    document.addEventListener('keydown', onGlobalKeyDown, true)
    document.addEventListener('pointerdown', onGlobalPointerDown, true)
    // 注入增高后把菜单底边夹回视口（ao-local 同款，见 clampMenuIntoViewport）。
    clampMenuIntoViewport(menu)
  }

  /** 捕获阶段：命中「更多」锚 → 记 pending；其余点击清掉 stale pending。 */
  const onCaptureClick = (event: MouseEvent): void => {
    if (disposed) return
    const target = event.target instanceof Element ? event.target : null
    const anchor = target?.closest('button') ?? null
    if (anchor === null || !isWorkspaceMenuAnchor(anchor)) {
      if (pendingWorkspaceId !== null) clearPending()
      return
    }
    const rowKey = anchor.closest('[data-row-key^="workspace:"]')?.getAttribute('data-row-key') ?? null
    const workspaceId = rowKey !== null && rowKey.startsWith('workspace:') ? rowKey.slice('workspace:'.length) : null
    if (workspaceId === null || workspaceId === '') {
      clearPending()
      return
    }
    // 已有 portal 菜单挂在 body 下时，这次锚点击是「收起」而非「打开」——
    // 不 arm pending，防止紧跟着打开的无关菜单被误注入。
    if (document.querySelector('body > [role="menu"]') !== null) {
      clearPending()
      return
    }
    pendingWorkspaceId = workspaceId
    pendingAnchor = anchor
    if (pendingTimer !== undefined) clearTimeout(pendingTimer)
    // portal 下一拍就挂载；窗口兜底防 pending 泄漏到无关菜单。
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined
      clearPending()
    }, 800)
  }

  const observer = new MutationObserver((records) => {
    // 菜单卸载（onClose / 重渲染换树）：摘子菜单状态与全局监听。
    if (injectedWrap !== null && !injectedWrap.isConnected) teardownInjection()
    if (pendingWorkspaceId === null || disposed) return
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.getAttribute('role') === 'menu') onItemMounted(node)
      }
    }
  })

  document.addEventListener('click', onCaptureClick, true)
  observer.observe(document.body, { childList: true })
  return () => {
    disposed = true
    document.removeEventListener('click', onCaptureClick, true)
    if (injectedWrap !== null) teardownInjection()
    closePanel()
    observer.disconnect()
    clearPending()
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer)
      toastTimer = undefined
      document.querySelector(`[${TOAST_MARKER}]`)?.remove()
    }
    if (tag.isConnected) tag.remove()
  }
}
