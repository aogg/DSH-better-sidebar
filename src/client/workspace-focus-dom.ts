/**
 * 单工作区专注模式的 DOM 层（`?ws=<workspaceId>` 打开页面时生效）：
 * 把左侧工作区树收成只剩这一个工作区——工作区分组头、会话行（活跃/待确认
 * 状态行都是会话行，随成员集合一起过滤）、其它分组的展开按钮全部隐藏；
 * 侧边栏本身保留（搜索、加工作区、视图选项一概不动），并在树上方注入一条
 * 「专注模式」横幅，带「退出专注」按钮（清参数 + 就地恢复全量，不刷新页面）。
 *
 * 为什么是 DOM 行过滤而不是改核心数据：`workspaces.list` 快照可以安全地
 * 只影响工作区 UI，但把其它工作区滤掉会让它们的会话全部落进核心推导的
 * 「未分组」桶；而过滤 `sessions.list` 会伤到主对话区（它按 id 读会话摘要）。
 * 行级隐藏对三个展示分组（活跃/待确认会话行 + 工作区头）一次生效，且不碰
 * 任何共享 store。
 *
 * 契约边界（对齐 strip-add-button / guide-blocks 的降级哲学）：
 * - 只消费核心发布的稳定 DOM 钩子：行上的 `data-row-key`
 *   （`workspace:<key>` / `session:<id>` / `overflow:<key>`，核心自己的滚动
 *   与动画逻辑也按它查询）和列表容器的 `[role="tree"]`。核心改名 → 规则
 *   不再命中 → 什么都不隐藏，页面照常（最坏是「没进入专注」，绝不坏页）。
 * - 隐藏是**加标记属性**（`data-dsh-focus-hidden`）而非内联样式：核心的行
 *   动画会写行内 transform/opacity，内联 display 会和它的恢复逻辑打架；
 *   一条 `head` 里带标记的 style 规则（`display:none !important`）统一兑现。
 * - MutationObserver 在核心每次重渲染后重新对齐（React 换行元素时旧属性
 *   随元素消失，新元素在下一拍打上标记）；数据更新（工作区成员流）经
 *   `workspaces.list` 订阅同样触发重对齐。
 * - 服务读取全部 try/catch 兜底（cordis 对未声明 inject 的 get 会抛）：
 *   读不到成员集合就不隐藏，绝不因本功能抛错影响侧边栏。
 * - 未带 `?ws` 参数时本模块整体不启动（无 observer、无 style、无监听），
 *   对现有行为零影响。
 *
 * 全部资源由返回的 disposer 清理（ctx.effect — HMR / 插件停用安全）。
 */
import type { Context } from '../context-types.ts'
import { t } from './locales.ts'
import {
  dropFocusParam,
  focusMembership,
  focusRowVerdict,
  readFocusWorkspaceId,
  type FocusWorkspaceItem,
  type WorkspaceFocusMembership,
} from './workspace-focus.ts'

/** 行隐藏标记属性（也是 inspectable 的来源标识）。 */
const ROW_MARKER = 'data-dsh-focus-hidden'
/** 专注横幅的标记属性。 */
const BANNER_MARKER = 'data-dsh-focus-banner'
/** 注入样式表的标记属性。 */
const STYLE_TAG_MARKER = 'data-dsh-focus-style'

/** 隐藏规则：一条 !important 兑现所有标记行（带标记即藏，属性一摘即现）。 */
const FOCUS_CSS = `
[${ROW_MARKER}] { display: none !important; }
`

/** 核心客户端服务的最小读取面（全部可缺席；缺席即降级为不过滤）。 */
interface FocusServiceFaces {
  workspaces?: {
    list?: {
      getSnapshot?: () => { items?: FocusWorkspaceItem[]; phase?: string }
      subscribe?: (listener: () => void) => () => void
    }
  }
  sessions?: {
    list?: {
      getSnapshot?: () => {
        ids?: readonly string[]
        byId?: Record<string, { id?: string; updatedAt?: number; retainedBy?: { mainView?: number } } | undefined>
        phase?: string
      }
    }
  }
  uiWorkspace?: {
    openSession?: (sessionId: string) => void
  }
}

/**
 * Try/catch 地读一个客户端服务——cordis 对未声明 inject 的访问直接抛错，
 * 本模块不把 'workspaces'/'uiWorkspace' 加进插件的 inject（专注是可选增强，
 * 不该让插件激活被它们卡住），所以每次读都可能是异常。
 */
function serviceFace(ctx: Context, name: string): FocusServiceFaces[keyof FocusServiceFaces] | undefined {
  try {
    return (ctx as unknown as { get: (name: string) => unknown }).get(name) as
      | FocusServiceFaces[keyof FocusServiceFaces]
      | undefined
  } catch {
    return undefined
  }
}

/** 会话摘要里的主视图会话 id（与核心 `mainSessionId` 同一读法）。 */
function mainViewSessionId(list: NonNullable<NonNullable<FocusServiceFaces['sessions']>['list']>): string | undefined {
  const snapshot = list.getSnapshot?.()
  if (snapshot === undefined) return undefined
  for (const summary of Object.values(snapshot.byId ?? {})) {
    if (summary === undefined) continue
    if ((summary.retainedBy?.mainView ?? 0) > 0) return summary.id
  }
  return undefined
}

/**
 * 注册专注模式的 DOM 控制器。返回 disposer：断开 observer / 订阅、摘掉
 * 全部标记、移除横幅与样式表。未带 `?ws` 时返回 no-op。
 */
export function registerWorkspaceFocus(ctx: Context): () => void {
  const focusId = typeof window !== 'undefined' ? readFocusWorkspaceId(window.location.search) : null
  if (focusId === null) return () => {}

  const tag = document.createElement('style')
  tag.setAttribute(STYLE_TAG_MARKER, '')
  tag.textContent = FOCUS_CSS
  document.head.appendChild(tag)

  let disposed = false
  /** 行过滤用的成员集合（含主视图会话保底）。 */
  let membership: WorkspaceFocusMembership | null = null
  /** 工作区自身的成员集合（不含保底；auto-open 判定用）。 */
  let rawMembership: WorkspaceFocusMembership | null = null
  /** 已尝试过「主视图纠偏」就不再试（每激活一次；不与用户后续导航打架）。 */
  let autoOpenAttempted = false
  let unsubscribeWorkspaces: (() => void) | undefined
  let scheduled = false
  let cancelScheduled: (() => void) | undefined

  /** 组装成员集合：workspaces 快照给分组，sessions 快照给主视图保底。 */
  const computeMembership = (): { filter: WorkspaceFocusMembership | null; raw: WorkspaceFocusMembership | null } => {
    const workspaces = serviceFace(ctx, 'workspaces') as FocusServiceFaces['workspaces'] | undefined
    const snapshot = workspaces?.list?.getSnapshot?.()
    const items = snapshot?.items
    if (items === undefined) return { filter: null, raw: null }
    const sessions = serviceFace(ctx, 'sessions') as FocusServiceFaces['sessions'] | undefined
    const list = sessions?.list
    const keep: string[] = []
    const mainId = list !== undefined ? mainViewSessionId(list) : undefined
    if (mainId !== undefined) keep.push(mainId)
    // raw 是工作区自己的成员集（auto-open 判定用）；filter 在其上并入主视图
    // 会话保底——它可能还在入组流上，被过滤掉会闪没用户正开着的会话。
    const raw = focusMembership(items, focusId)
    const filter = raw === null ? null
      : {
          workspaceId: raw.workspaceId,
          memberSessionIds: new Set<string>([...raw.memberSessionIds, ...keep]),
        }
    return { filter, raw }
  }

  /** 找主树容器：带 `data-row-key` 行的 `[role="tree"]`（搜索结果树没有行键，不命中）。 */
  const findTree = (): HTMLElement | undefined => {
    for (const tree of document.querySelectorAll<HTMLElement>('[role="tree"]')) {
      if (tree.querySelector('[data-row-key^="workspace:"], [data-row-key^="session:"]') !== null) return tree
    }
    return undefined
  }

  /** 主视图纠偏：打开的是别的会话/空白页时，转到专注工作区最近的会话。 */
  const maybeAutoOpen = (): void => {
    if (autoOpenAttempted || rawMembership === null) return
    const workspaces = serviceFace(ctx, 'workspaces') as FocusServiceFaces['workspaces'] | undefined
    const snapshot = workspaces?.list?.getSnapshot?.()
    if (snapshot?.phase !== 'ready') return
    const sessions = serviceFace(ctx, 'sessions') as FocusServiceFaces['sessions'] | undefined
    const list = sessions?.list
    if (list === undefined) return
    const sessionSnapshot = list.getSnapshot?.()
    if (sessionSnapshot?.phase !== 'ready') return
    autoOpenAttempted = true
    const mainId = mainViewSessionId(list)
    // 判定按工作区「自己」的成员集（raw）：主视图保底并进来的那个非成员
    // 会话恰恰说明开错了工作区，正要被纠偏，不能算已就位。
    if (mainId !== undefined && rawMembership.memberSessionIds.has(mainId)) return
    const byId = sessionSnapshot.byId ?? {}
    const memberIds = [...rawMembership.memberSessionIds]
      .filter((id) => byId[id] !== undefined && id !== mainId)
      .sort((left, right) => (byId[right]?.updatedAt ?? 0) - (byId[left]?.updatedAt ?? 0))
    const target = memberIds[0]
    if (target === undefined) return
    try {
      const uiWorkspace = serviceFace(ctx, 'uiWorkspace') as FocusServiceFaces['uiWorkspace'] | undefined
      uiWorkspace?.openSession?.(target)
    } catch {
      // 纠偏失败就保持现状：侧边栏过滤照常，主视图是用户的自由。
    }
  }

  /** 一趟对齐：重算成员集合并把标记打到与判定一致。 */
  const sync = (): void => {
    if (disposed) return
    const computed = computeMembership()
    membership = computed.filter
    rawMembership = computed.raw
    for (const row of document.querySelectorAll<HTMLElement>('[data-row-key]')) {
      const key = row.getAttribute('data-row-key')
      if (key === null) continue
      const hide = focusRowVerdict(key, membership) === 'hidden'
      if (hide && !row.hasAttribute(ROW_MARKER)) row.setAttribute(ROW_MARKER, '')
      if (!hide && row.hasAttribute(ROW_MARKER)) row.removeAttribute(ROW_MARKER)
    }
    syncBanner()
    maybeAutoOpen()
  }

  /** 专注横幅：插在主树之前（列表体开头），退出按钮就地清参数恢复全量。 */
  const syncBanner = (): void => {
    const existing = document.querySelector<HTMLElement>(`[${BANNER_MARKER}]`)
    if (disposed) {
      existing?.remove()
      return
    }
    const tree = findTree()
    if (tree === undefined || tree.parentElement === null) {
      existing?.remove()
      return
    }
    if (existing !== null && tree.previousSibling === existing) return
    existing?.remove()
    const banner = document.createElement('div')
    banner.setAttribute(BANNER_MARKER, '')
    banner.setAttribute('role', 'status')
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = t('focusBannerLabel')
    const exit = document.createElement('button')
    exit.type = 'button'
    exit.className = 'exit'
    exit.textContent = t('focusExit')
    exit.addEventListener('click', () => {
      try {
        window.history.replaceState(window.history.state, '', dropFocusParam(window.location.href))
      } catch {
        // replaceState 失败（罕见）也不拦退出：下面的就地恢复照跑。
      }
      deactivate()
    })
    banner.append(label, exit)
    tree.parentElement.insertBefore(banner, tree)
  }

  /** 就地退出：停一切、摘全部标记、移除横幅与样式表；URL 已被调用方清干净。 */
  const deactivate = (): void => {
    disposed = true
    observer.disconnect()
    cancelScheduled?.()
    cancelScheduled = undefined
    scheduled = false
    unsubscribeWorkspaces?.()
    unsubscribeWorkspaces = undefined
    membership = null
    rawMembership = null
    for (const row of document.querySelectorAll(`[${ROW_MARKER}]`)) row.removeAttribute(ROW_MARKER)
    document.querySelector(`[${BANNER_MARKER}]`)?.remove()
    if (tag.isConnected) tag.remove()
  }

  const run = (): void => {
    scheduled = false
    cancelScheduled = undefined
    sync()
  }

  /** 观察器突发合并为一帧一次（无帧环境退 setTimeout，jsdom 测试 flush 用）。 */
  const schedule = (): void => {
    if (scheduled || disposed) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(run)
      cancelScheduled = () => { cancelAnimationFrame(frame) }
    } else {
      const timer = setTimeout(run, 0)
      cancelScheduled = () => { clearTimeout(timer) }
    }
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  // 核心的成员流一变（新会话入组、归档…）就重对齐；订阅失败静默（observer 兜底）。
  try {
    const workspaces = serviceFace(ctx, 'workspaces') as FocusServiceFaces['workspaces'] | undefined
    unsubscribeWorkspaces = workspaces?.list?.subscribe?.(schedule)
  } catch {
    unsubscribeWorkspaces = undefined
  }
  // 首趟同步执行：激活时树已在屏就立即生效（测试也免 flush）。
  sync()

  return () => { deactivate() }
}
