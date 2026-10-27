/**
 * 工作区行「更多」(…) 菜单的「复制工作区独立链接」项（DOM 注入）。
 *
 * 为什么是 DOM 注入：核心 WorkspaceBrowser 的菜单项是组件内硬编码数组
 * （rename/delete 两项），`sidebar.workspaces` 只有会话级菜单孔位
 * （`sidebar.workspaces.session.menu.item`），工作区级没有 slot；单 slot 的
 * 注册表允许低优先级遮蔽整棵 WorkspaceBrowser，但那要求本插件复刻整套
 * inject 面（开/搜/重命名/删除…），远重于一个菜单项。因此走本仓库既有的
 * DOM 注入先例（strip-add-button / guide-blocks 同一族）：
 *
 * 1. 捕获阶段监听点击——工作区「更多」锚按钮的 `aria-label` 是核心 locale
 *    模板（zh「工作区“{name}”的操作」/ en "Workspace actions for {name}"），
 *    命中即记下所属行的 `data-row-key="workspace:<id>"`（未分组行没有 id，
 *    跳过）。
 * 2. 菜单是 `portal: true` 的 React portal（`[role="menu"]` 直接挂在 body
 *    下）；body 观察器看到它在 pending 窗口内出现，就把「分隔线 + 菜单项」
 *    追加进菜单内容区末尾。
 * 3. 点击注入项：拼 `?ws=<id>` 独立链接（workspace-focus.ts 的纯函数）→
 *    写剪贴板（Clipboard API 优先，http 非安全上下文退 execCommand）→
 *    toast 反馈 → 复原锚按钮的 click 让核心按自己的语义收起菜单（锚已被
 *    卸载时退化为派发 Escape，走核心菜单自己的关闭路径）。
 *
 * 降级契约（同族先例）：核心改了 aria 模板或行键 → 捕获不命中，菜单保持
 * 原样（缺一项，绝不坏页）；注入项样式全部走 `--dsw-*` 令牌转录核心
 * Menu.module.css 的 .item 配方（类名是构建产物，不作为钩子消费）。
 * 观察器、监听、计时器、样式表与 toast 都由 disposer 清理（ctx.effect）。
 */
import type { Context } from '../context-types.ts'
import { t } from './locales.ts'
import { buildWorkspaceFocusLink } from './workspace-focus.ts'

/** 注入项（与分隔线）的标记属性。 */
const ITEM_MARKER = 'data-dsh-workspace-link-item'
/** 成功/失败 toast 的标记属性。 */
const TOAST_MARKER = 'data-dsh-workspace-link-toast'
/** 注入样式表的标记属性。 */
const STYLE_TAG_MARKER = 'data-dsh-workspace-link-style'

/**
 * 样式：`.itemWrap`/`.item`/`.itemIcon`/`.itemLabel`/`.separator` 五块的
 * 逐字转录（来源 dsh-client-ui-primitives Menu.module.css；颜色走既有令牌
 * ——皮肤换肤时与原生菜单项一起重着色），加上 toast 的最小配方。
 */
const LINK_ITEM_CSS = `
[${ITEM_MARKER}] { position: relative; }
[${ITEM_MARKER}] > button { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; }
[${ITEM_MARKER}] > button:hover:not(:disabled), [${ITEM_MARKER}] > button:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
[${ITEM_MARKER}] .icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon); }
[${ITEM_MARKER}] .icon svg { width: 14px; height: 14px; }
[${ITEM_MARKER}] .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${ITEM_MARKER}] .separator { height: 0.5px; margin: 3px 2px; background: var(--dsw-alias-border-l2); }
[${TOAST_MARKER}] { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483000; max-width: 70vw; padding: 8px 14px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #1b1b22)); border: 0.5px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent); pointer-events: none; }
`

/** 链条图标（14px、stroke=currentColor，与核心菜单 14px 图标同规格）。 */
const LINK_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.7 9.3l2.6-2.6"/><path d="M7.4 4.9l1.5-1.5a2.6 2.6 0 0 1 3.7 3.7L11.1 8.6"/><path d="M8.6 11.1l-1.5 1.5a2.6 2.6 0 0 1-3.7-3.7l1.5-1.5"/></svg>'

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
 * 注册「复制工作区独立链接」菜单项。返回 disposer：摘监听、断观察器、
 * 清计时器、移除样式表与仍在屏的 toast。
 */
export function registerWorkspaceLinkMenu(ctx: Context): () => void {
  // ctx 眼下面未消费（链接是纯前端 URL 拼装）；保留形参对齐本仓库
  // register*(ctx) 的注册面惯例，也让未来接服务读取不需要改调用点。
  void ctx

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

  const onItemMounted = (menu: Element): void => {
    if (pendingWorkspaceId === null || disposed) return
    if (menu.querySelector(`[${ITEM_MARKER}]`) !== null) return
    const viewport = menu.firstElementChild
    if (viewport === null) return
    const workspaceId = pendingWorkspaceId
    const anchor = pendingAnchor
    clearPending()

    const wrap = document.createElement('div')
    wrap.setAttribute(ITEM_MARKER, '')

    const separator = document.createElement('div')
    separator.className = 'separator'
    separator.setAttribute('role', 'separator')
    wrap.appendChild(separator)

    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    const label = t('workspaceCopyLink')
    button.setAttribute('aria-label', label)
    const icon = document.createElement('span')
    icon.className = 'icon'
    icon.innerHTML = LINK_ICON_SVG
    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = label
    button.append(icon, text)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      // 点击时刻的 location.href：SPA 不改 URL，但万一未来改了也拿的是当下。
      const link = buildWorkspaceFocusLink(window.location.href, workspaceId)
      void copyText(link).then((ok) => {
        showToast(ok ? t('workspaceLinkCopied') : t('workspaceLinkCopyFailed'))
      })
      closeMenu(anchor)
    })
    wrap.appendChild(button)
    viewport.appendChild(wrap)
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
