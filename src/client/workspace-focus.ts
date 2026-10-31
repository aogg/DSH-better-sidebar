/**
 * 单工作区/独立工作区组专注模式（workspace focus mode）的纯逻辑层：URL
 * 参数的读/写/清除、scope 值解析、工作区成员集合的计算、以及「某个树行该
 * 不该被隐藏」的判定。
 *
 * 参数契约：`?ws=<scope>` 挂在当前页面 URL 的 query 上，scope 语义向后兼容：
 * - 裸 workspaceId = 单工作区专注（存量链接不变）；
 * - `g:<groupId>` = 独立工作区组（组 id 即唯一值），打开时按设置里的
 *   `pluginSettings.workspaceGroups` 反查组，专注视图显示组内全部工作区。
 *
 * 核心 web 前端自己不用任何 query 参数做路由（shell 无 pushState/
 * replaceState，查询串一直为空），`ws` 因此不与既有路由冲突；参数留在
 * URL 上，刷新/转发链接都保持专注态。DOM 层消费者见
 * `workspace-focus-dom.ts`（行隐藏 + 退出入口），「独立工作区」菜单
 * （复制 / 新窗口打开 / 组动作）见 `workspace-link-menu.ts`。
 *
 * 本模块不碰任何服务与 DOM——全部输入显式传参，vitest 直测
 * （tests/workspace-focus.spec.ts）。
 */

/** 专注模式的 URL 参数名。核心前端不消费 query，`ws` 无冲突。 */
export const FOCUS_URL_PARAM = 'ws'

/** 组 scope 的值前缀：`?ws=g:<groupId>`。 */
export const GROUP_SCOPE_PREFIX = 'g:'

/** `?ws=` 参数值的两种语义（解析失败为 null，退全量）。 */
export type FocusScope =
  | { kind: 'workspace'; id: string }
  | { kind: 'group'; id: string }

/**
 * 把 `ws` 参数值解析成 scope：裸值 = 单工作区；`g:` 前缀 = 组（组 id 即
 * 唯一值）；空值 / 空 id / 超长 → null（调用方不过滤）。
 */
export function parseFocusScope(value: string | null | undefined): FocusScope | null {
  if (value === null || value === undefined) return null
  const raw = value.trim()
  if (raw === '' || raw.length > 200) return null
  if (raw.startsWith(GROUP_SCOPE_PREFIX)) {
    const id = raw.slice(GROUP_SCOPE_PREFIX.length).trim()
    return id === '' || id.length > 200 ? null : { kind: 'group', id }
  }
  return { kind: 'workspace', id: raw }
}

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

/** 组专注链接：`?ws=g:<groupId>`（整组一条链接，一个窗口显示整组）。 */
export function buildGroupFocusLink(href: string, groupId: string): string {
  return buildWorkspaceFocusLink(href, `${GROUP_SCOPE_PREFIX}${groupId}`)
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

/**
 * 一次专注过滤所依据的成员集合：专注工作区 id 集合（单工作区=单元素集，
 * 组=组内 id 集）+ 这些工作区的会话全集。
 */
export interface WorkspaceFocusMembership {
  /** 专注视图保留的工作区 id 集合（`workspace:<id>` / `overflow:<id>` 行按它判定）。 */
  readonly workspaceIds: ReadonlySet<string>
  /** 保留工作区的会话全集（`session:<id>` 行按它判定）。 */
  readonly memberSessionIds: ReadonlySet<string>
}

/**
 * 由核心快照算成员集合；专注集合里一个工作区都找不到（快照未就绪或 id 全部
 * 失效）时返回 null（调用方应完全不隐藏，宁可多显示也不空白）。
 * `extraKeepSessionIds` 并入会话集合——典型是当前主视图会话：它可能尚在
 * 入组流上（新会话刚建、sessionIds 未及更新），被过滤掉会闪没自己的会话。
 * `focus` 传单 id（单工作区，存量语义）或 id 集合（组）。
 */
export function focusMembership(
  items: readonly FocusWorkspaceItem[],
  focus: string | ReadonlySet<string>,
  extraKeepSessionIds: readonly string[] = [],
): WorkspaceFocusMembership | null {
  const ids = typeof focus === 'string' ? new Set<string>([focus]) : focus
  const memberSessionIds = new Set<string>(extraKeepSessionIds)
  let matched = 0
  for (const item of items) {
    if (!ids.has(item.workspaceId)) continue
    matched += 1
    for (const sessionId of item.sessionIds) memberSessionIds.add(sessionId)
  }
  if (matched === 0) return null
  return { workspaceIds: new Set<string>(ids), memberSessionIds }
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
    return membership.workspaceIds.has(rowKey.slice('workspace:'.length)) ? 'visible' : 'hidden'
  }
  if (rowKey.startsWith('overflow:')) {
    return membership.workspaceIds.has(rowKey.slice('overflow:'.length)) ? 'visible' : 'hidden'
  }
  if (rowKey.startsWith('session:')) {
    return membership.memberSessionIds.has(rowKey.slice('session:'.length)) ? 'visible' : 'hidden'
  }
  return 'outside'
}
