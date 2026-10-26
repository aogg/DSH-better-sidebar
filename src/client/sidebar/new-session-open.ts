/**
 * 新会话钩子：两件事，共用同一个「新会话」判定。
 *
 * 1. 固定打开网页（webview pinned，页面级配置）：`pinned: true` 的条目在每次
 *    新建会话上屏时按合并序依次打开（全局 + 当前工作区，工作区在前）。与既有
 *    `rightbarOpenOnNewSession` 偏好解耦——pinned 是页面级配置，不受该开关
 *    影响；该开关只管右栏展开，tab 打开本身不依赖展开，所以展开偏好关闭时
 *    pinned 打开照常执行。防重复靠 webview-page 的 dedupeKey（pageId）天然
 *    保证，这里不做额外记账。
 * 2. 自动展开右栏（`rightbarOpenOnNewSession`，默认开）：命中且上屏时展开。
 *
 * 「新建会话」的判定：对 `ctx.sessions.list` 快照的 `byId` 键做 diff，只认
 * **页面加载后新出现**的 id（首帧只装基线，恢复的旧会话永不触发）；`origin:
 * 'subagent'` / 带 `parentId` 的行不算——子代理与侧边对话线程的创建各有自己的
 * 表面（autoOpenSubagent / openTab），不重复展开。
 *
 * 展开动作：优先结构化探测 `ctx.get('sidebarRight')` 的 `isExpanded` /
 * `toggleExpanded`（ui-sidebar-right README 的公开 face；已展开则不动，避免把
 * 用户正在看的列收起来）；探测不到再降级为对可见的 `[data-sidebar-right-expand]`
 * 派发 click（可见性判读与 right-panel-open.ts 同一规则）。全部失败静默结束。
 *
 * 作用于「上屏的新会话」：宿主命令面按契约作用于在屏会话（无在屏会话或 store
 * 未铸出时 throw），所以只有 `ctx.sidebarRight.mounted` 等于新会话 id 时才动作；
 * 检测到 id 时座位可能尚未切换（列表快照先行），给一次短延迟重试，仍不等就放弃
 * ——绝不把别的会话的列收起或展开。pinned 打开还需要 store 的活动会话就绪
 * （openTab 落点是 store 快照的当前会话），未就绪时同样让给重试窗口；没有
 * pinned 条目时这层检查不参与，展开行为与旧版完全一致。
 */
import { useEffect, useRef } from 'react'
import type { Context, SidebarSessionList } from '../../context-types.ts'
import type { SidebarStore } from '../state.ts'
import { mountedSessionId } from '../native/surface.ts'
import { openWebviewPage, type WebviewOpenService } from '../webview-open.ts'
import { pinnedWebviewPagesFor } from '../webview-pages.ts'
import { clickVisibleRightbarExpand } from './right-panel-open.ts'

/** mounted 座位尚未切到新会话时的唯一一次重试延迟。 */
export const NEW_SESSION_MOUNT_RETRY_MS = 250

/** 宿主右栏控制器的结构化探测面（README 契约的展开动词）。 */
interface ExpandFace {
  isExpanded?: () => boolean
  toggleExpanded?: () => void
}

/** 一行列表摘要是否为子代理系（子代理 / 侧边对话线程）。 */
function isSubagentRow(summary: { origin?: 'subagent'; parentId?: string }): boolean {
  return summary.origin === 'subagent' || summary.parentId !== undefined
}

/**
 * 展开宿主右栏：face 动词优先，DOM click 兜底；都不可用就是无事可做。
 * @returns 是否发出了一个展开动作（测试断言用）。
 */
export function expandRightbar(ctx: Context): boolean {
  try {
    const face = ctx.get('sidebarRight') as ExpandFace | undefined
    if (typeof face?.isExpanded === 'function' && typeof face?.toggleExpanded === 'function') {
      if (face.isExpanded() === true) return false
      face.toggleExpanded()
      return true
    }
  } catch {
    // face 缺席 / 无在屏会话时宿主会 throw：走 DOM 兜底。
  }
  return clickVisibleRightbarExpand()
}

/** 探测 ctx 上的 betterSidebar 服务（测试 mock / 服务缺席 → undefined）。 */
function betterSidebarOf(ctx: Context): WebviewOpenService | undefined {
  try {
    const service = ctx.get('betterSidebar') as WebviewOpenService | undefined
    return typeof service?.openTab === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * 会话列表 diff → 命中新会话且上屏时：先开 pinned 网页（不受展开偏好影响），
 * 再按 `rightbarOpenOnNewSession` 决定是否展开右栏。挂在 Sidebar shell 里，
 * 与 useHostFeeds 同一节拍（列表快照每次发布都过一遍）。`cwd` 是当前会话的
 * 工作区根（Sidebar 里 useSessionRoot 的产物），决定工作区条目参与合并。
 */
export function useRightbarOpenOnNewSession(ctx: Context, store: SidebarStore, sessionList: SidebarSessionList, cwd?: string): void {
  // 页面加载后的第一批 id 是基线：此后新出现的 id 才算「新建」。
  const baselineRef = useRef<Set<string> | undefined>(undefined)
  // cwd 走 ref：fire 可能在 cwd 订阅发布之前由列表快照触发，读 ref 取最新值
  // 而不是把 cwd 拌进 effect 依赖（那样每次 worktree 跟随切换都重装基线）。
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const pendingRef = useRef<{ ids: string[]; timer: number } | null>(null)
  useEffect(() => () => {
    const pending = pendingRef.current
    if (pending !== null) window.clearTimeout(pending.timer)
    pendingRef.current = null
  }, [])

  useEffect(() => {
    const prev = baselineRef.current
    const summaries = sessionList.byId
    const ids = Object.keys(summaries).filter(id => !isSubagentRow(summaries[id] ?? {}))
    baselineRef.current = new Set(ids)
    if (prev === undefined) return
    const fresh = ids.filter(id => !prev.has(id))
    if (fresh.length === 0) return

    const fire = (): boolean => {
      const mounted = mountedSessionId(ctx)
      if (mounted === undefined || !fresh.includes(mounted)) return false
      // pinned 网页：与展开偏好解耦，tab 打开本身不依赖右栏展开。store 座位
      // 还没写入新会话时 openTab 会静默返回——让给 250ms 重试，pinned 页不能
      // 悄悄丢；没有 pinned 条目（或服务缺席）时跳过检查，展开时序与旧版一致。
      const service = betterSidebarOf(ctx)
      const pinned = service !== undefined
        ? pinnedWebviewPagesFor(store.getPrefs().pluginSettings, cwdRef.current)
        : []
      if (pinned.length > 0) {
        if (store.getSnapshot().sessionId === undefined) return false
        // 依次打开（合并序）；同一页的重复 open 由 dedupeKey 聚焦已开 tab。
        for (const page of pinned) openWebviewPage(service, page)
      }
      if (!store.getPrefs().rightbarOpenOnNewSession) return true
      expandRightbar(ctx)
      return true
    }
    // 座位通常已切好（宿主 mounted 在渲染前发布）：先试一次，不等再重试一次。
    if (fire()) return
    const pending = pendingRef.current
    if (pending !== null) window.clearTimeout(pending.timer)
    const timer = window.setTimeout(() => {
      pendingRef.current = null
      fire()
    }, NEW_SESSION_MOUNT_RETRY_MS)
    pendingRef.current = { ids: fresh, timer }
  }, [sessionList, ctx, store])
}
