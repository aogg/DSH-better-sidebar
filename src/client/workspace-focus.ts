/**
 * 单工作区专注模式（single-workspace focus mode）的纯逻辑层：URL 参数的
 * 读/写/清除、工作区成员集合的计算、以及「某个树行该不该被隐藏」的判定。
 *
 * 参数契约：`?ws=<workspaceId>` 挂在当前页面 URL 的 query 上。核心 web 前端
 * 自己不用任何 query 参数做路由（shell 无 pushState/replaceState，查询串一直
 * 为空），`ws` 因此不与既有路由冲突；参数留在 URL 上，刷新/转发链接都保持
 * 专注态。DOM 层消费者见 `workspace-focus-dom.ts`（行隐藏 + 退出入口），
 * 「独立工作区链接」两项（复制 / 新窗口打开）见 `workspace-link-menu.ts`。
 *
 * 本模块不碰任何服务与 DOM——全部输入显式传参，vitest 直测
 * （tests/workspace-focus.spec.ts）。
 */

/** 专注模式的 URL 参数名。核心前端不消费 query，`ws` 无冲突。 */
export const FOCUS_URL_PARAM = 'ws'

/** 读取 query 串（带或不带前导 `?`）里的专注工作区 id；无/空白/超长视为没有。 */
export function readFocusWorkspaceId(query: string): string | null {
  const withMark = query.startsWith('?') ? query : `?${query}`
  let raw: string
  try {
    raw = new URLSearchParams(withMark).get(FOCUS_URL_PARAM)?.trim() ?? ''
  } catch {
    return null
  }
  if (raw === '' || raw.length > 200) return null
  return raw
}

/** 在完整 href 上设置（或替换）`ws` 参数，其余部分原样保留；href 非法时抛出。 */
export function buildWorkspaceFocusLink(href: string, workspaceId: string): string {
  const url = new URL(href)
  url.searchParams.set(FOCUS_URL_PARAM, workspaceId)
  return url.href
}

/** 从完整 href 上移除 `ws` 参数（退出专注），其余部分原样保留；href 非法时抛出。 */
export function dropFocusParam(href: string): string {
  const url = new URL(href)
  url.searchParams.delete(FOCUS_URL_PARAM)
  return url.href
}

/** 核心工作区快照里本插件消费的最小字段形状（只读）。 */
export interface FocusWorkspaceItem {
  readonly workspaceId: string
  readonly sessionIds: readonly string[]
}

/** 一次专注过滤所依据的成员集合：专注工作区 id + 它的会话全集。 */
export interface WorkspaceFocusMembership {
  readonly workspaceId: string
  readonly memberSessionIds: ReadonlySet<string>
}

/**
 * 由核心快照算成员集合；专注 id 在 items 里找不到（快照未就绪或 id 失效）
 * 时返回 null（调用方应完全不隐藏，宁可多显示也不空白）。
 * `extraKeepSessionIds` 并入会话集合——典型是当前主视图会话：它可能尚在
 * 入组流上（新会话刚建、sessionIds 未及更新），被过滤掉会闪没自己的会话。
 */
export function focusMembership(
  items: readonly FocusWorkspaceItem[],
  focusId: string,
  extraKeepSessionIds: readonly string[] = [],
): WorkspaceFocusMembership | null {
  const workspace = items.find((item) => item.workspaceId === focusId)
  if (workspace === undefined) return null
  return {
    workspaceId: focusId,
    memberSessionIds: new Set<string>([...workspace.sessionIds, ...extraKeepSessionIds]),
  }
}

/** 单行的过滤判定：`visible` 保留、`hidden` 隐藏、`outside` 不是本机制管的行。 */
export type FocusRowVerdict = 'visible' | 'hidden' | 'outside'

/**
 * 按 `data-row-key` 判定一个树行的去留。认识的键形（核心 WorkspaceBrowser
 * 的稳定 DOM 契约）：`workspace:<key>`（分组头，未分组 key 为空串）、
 * `session:<id>`（会话行）、`overflow:<key>`（折叠会话的展开按钮）；
 * 其余（空态 `empty`、搜索结果、文件树等）一律 `outside` 不动。
 * membership 为 null（未激活/数据未就绪）时全部 `outside`。
 */
export function focusRowVerdict(rowKey: string, membership: WorkspaceFocusMembership | null): FocusRowVerdict {
  if (membership === null) return 'outside'
  if (rowKey.startsWith('workspace:')) {
    return rowKey.slice('workspace:'.length) === membership.workspaceId ? 'visible' : 'hidden'
  }
  if (rowKey.startsWith('overflow:')) {
    return rowKey.slice('overflow:'.length) === membership.workspaceId ? 'visible' : 'hidden'
  }
  if (rowKey.startsWith('session:')) {
    return membership.memberSessionIds.has(rowKey.slice('session:'.length)) ? 'visible' : 'hidden'
  }
  return 'outside'
}
