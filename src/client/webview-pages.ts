/**
 * 「webview网页」配置的纯逻辑词汇表：单条网页配置（名称 + URL + 打开方式 +
 * 固定打开）、持久化 blob 的容错解析、全局与工作区两个 scope 的合并（工作区
 * 在前、id 冲突工作区赢——与 open-with.ts 的 mergeOpenWithConfigs 同一语义）、
 * 以及固定打开（pinned）条目的挑选。
 *
 * 纯函数、无 React、无 api：整个面（含 pinned 挑选）都可以在没有 DOM 和宿主
 * 路由的情况下单测。配置页组件与打开逻辑只消费这里导出的类型与函数。
 *
 * 存储契约（v0.28.x）：
 * - 全局：`pluginSettings['webview'].pages`（webview 配置页自己的 descriptor
 *   blob，键 {@link WEBVIEW_SETTINGS_ID} / {@link WEBVIEW_PAGES_KEY}）；
 * - 工作区：`pluginSettings['__project'][<cwd>].webviewPages`（保留键
 *   `__project` 下的 per-workspace blob，见 prefs-shared.ts 的
 *   PROJECT_SETTINGS_KEY）。读写一律走 plugin-settings.ts 的
 *   updatePluginSettings / updateProjectSettings（同一条串行写队列）。
 */
import { PROJECT_SETTINGS_KEY } from '../prefs-shared.ts'

/** 一条网页配置的打开方式：当前侧边栏开 tab，或丢给系统浏览器开新窗口。 */
export type WebviewOpenMode = 'tab' | 'window'

/** 一条网页配置（持久化行；parse 容错后的形状）。 */
export interface WebviewPage {
  id: string
  /** 菜单/tab 标题用的人读名称（保存时已 trim；parse 兜底 ''）。 */
  name: string
  /** 仅允许 http/https（{@link isWebviewUrl} 是打开侧的最终裁判）。 */
  url: string
  openMode: WebviewOpenMode
  /** 固定打开：新会话上屏时自动打开（与 rightbarOpenOnNewSession 偏好解耦）。 */
  pinned: boolean
}

/** 一条配置的归属 scope。 */
export type WebviewScope = 'global' | 'workspace'

/** 全局 blob 的 descriptor id：`pluginSettings['webview']`。取 id 形态即可与
 *  保留键 `__project` 区分开（descriptor id 永不以双下划线开头）。 */
export const WEBVIEW_SETTINGS_ID = 'webview'

/** 全局 blob 里网页列表的键。 */
export const WEBVIEW_PAGES_KEY = 'pages'

/** 工作区 blob（`pluginSettings['__project'][cwd]`）里网页列表的键。 */
export const WEBVIEW_PROJECT_PAGES_KEY = 'webviewPages'

/** 网页 tab 的内置类型 id（见 builtins/tabs.tsx 的 webview-page descriptor）。
 *  注意与配置页类型 `webview` 是两个 type：后者是单实例页面，前者是
 *  createTab 多实例（每页一个 tab）。 */
export const WEBVIEW_TAB_TYPE = 'webview-page'

/** 网页 tab 的 id 契约：`webview:<pageId>`（dedupeKey=pageId 配对使用）。 */
export function webviewTabIdOf(pageId: string): string {
  return `webview:${pageId}`
}

/** 从一个 tab 的 meta 里取 pageId（webview-open.ts 铸 tab 时写入的契约字段）。
 *  脏数据一律返回 undefined——undefined 的 dedupeKey 表示「不去重」。 */
export function webviewPageIdOfTab(tab: { meta?: unknown }): string | undefined {
  const meta = tab.meta
  if (meta === null || typeof meta !== 'object') return undefined
  const pageId = (meta as Record<string, unknown>).pageId
  return typeof pageId === 'string' && pageId !== '' ? pageId : undefined
}

/** 是否为合法的网页 URL：可解析且仅 http/https（与其余入口（iframe/新窗口）
 *  的安全契约一致，file:/javascript: 等一律拒绝）。 */
export function isWebviewUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 打开侧（配置页「打开」按钮 / pinned 自动打开）的严格校验：名称非空 +
 *  URL 合法。parse 只做结构容错，这一层才决定能不能开。 */
export function isValidWebviewPage(page: WebviewPage): boolean {
  return page.name.trim() !== '' && isWebviewUrl(page.url)
}

/** 单行的结构校验（parse 容错的准入线）：id 必须是非空字符串，其余字段缺席
 *  时兜底默认值（openMode→tab、pinned→false）——半坏的行尽量保住可用部分，
 *  而不是整条丢弃。 */
function isWebviewPageRow(value: unknown): value is WebviewPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
}

/**
 * 解析持久化的网页列表（容错）：非数组返回空表；行缺字段兜底默认值，
 * openMode 只认 'window'（其余一律落回 'tab'），pinned 只认严格 true。
 */
export function parseWebviewPages(raw: unknown): WebviewPage[] {
  if (!Array.isArray(raw)) return []
  const pages: WebviewPage[] = []
  for (const row of raw) {
    if (!isWebviewPageRow(row)) continue
    const record = row as unknown as Record<string, unknown>
    pages.push({
      id: row.id,
      name: typeof record.name === 'string' ? record.name : '',
      url: typeof record.url === 'string' ? record.url : '',
      openMode: record.openMode === 'window' ? 'window' : 'tab',
      pinned: record.pinned === true,
    })
  }
  return pages
}

/**
 * 合并全局与工作区两份网页列表：工作区条目在前、全局在后；id 冲突工作区赢
 * （与 mergeOpenWithConfigs 的 customEditors 同一语义——两个 scope 都可编辑，
 * 冲突时项目侧覆盖，其余各归各）。合并序就是 pinned 打开与列表展示的顺序。
 */
export function mergeWebviewPages(globalPages: readonly WebviewPage[], workspacePages: readonly WebviewPage[]): WebviewPage[] {
  return mergeWebviewPageRows(globalPages, workspacePages).map(row => row.page)
}

/** 带来源标注的合并行（配置页列表用）：工作区在前、全局在后、id 冲突工作区赢。 */
export interface WebviewPageRow {
  page: WebviewPage
  source: WebviewScope
}

export function mergeWebviewPageRows(globalPages: readonly WebviewPage[], workspacePages: readonly WebviewPage[]): WebviewPageRow[] {
  const workspaceIds = new Set(workspacePages.map(page => page.id))
  return [
    ...workspacePages.map(page => ({ page, source: 'workspace' as const })),
    ...globalPages.filter(page => !workspaceIds.has(page.id)).map(page => ({ page, source: 'global' as const })),
  ]
}

/** 固定打开条目（按合并序）：只保留 pinned 且严格合法的行——pinned 是
 *  「新会话自动打开」的语义，一条坏 URL 的行开出来只能是空白页。 */
export function pinnedWebviewPages(pages: readonly WebviewPage[]): WebviewPage[] {
  return pages.filter(page => page.pinned && isValidWebviewPage(page))
}

/** 从 prefs 的 pluginSettings 直接算出当前工作区应自动打开的 pinned 列表
 *  （合并 + 挑选一步到位；cwd 缺席时工作区条目自然为空）。 */
export function pinnedWebviewPagesFor(
  pluginSettings: Record<string, unknown> | undefined,
  cwd: string | undefined,
): WebviewPage[] {
  return pinnedWebviewPages(mergeWebviewPages(
    readGlobalWebviewPages(pluginSettings),
    readWorkspaceWebviewPages(pluginSettings, cwd),
  ))
}

/** 读全局 scope 的网页列表（`pluginSettings['webview'].pages`）。 */
export function readGlobalWebviewPages(pluginSettings: Record<string, unknown> | undefined): WebviewPage[] {
  const blob = pluginSettings?.[WEBVIEW_SETTINGS_ID]
  if (blob === null || typeof blob !== 'object') return []
  return parseWebviewPages((blob as Record<string, unknown>)[WEBVIEW_PAGES_KEY])
}

/** 读工作区 scope 的网页列表（`pluginSettings['__project'][cwd].webviewPages`）。
 *  cwd 缺席/空串一律空表——没有工作区就没有项目 scope 可言。 */
export function readWorkspaceWebviewPages(pluginSettings: Record<string, unknown> | undefined, cwd: string | undefined): WebviewPage[] {
  if (cwd === undefined || cwd === '') return []
  const map = pluginSettings?.[PROJECT_SETTINGS_KEY]
  if (map === null || typeof map !== 'object') return []
  const blob = (map as Record<string, unknown>)[cwd]
  if (blob === null || typeof blob !== 'object') return []
  return parseWebviewPages((blob as Record<string, unknown>)[WEBVIEW_PROJECT_PAGES_KEY])
}

/** 按 id 覆盖或追加一条配置（保持列表序；改范围/编辑共用）。 */
export function upsertWebviewPage(pages: readonly WebviewPage[], page: WebviewPage): WebviewPage[] {
  const at = pages.findIndex(candidate => candidate.id === page.id)
  if (at === -1) return [...pages, page]
  return pages.map(candidate => candidate.id === page.id ? page : candidate)
}

/** 按 id 移除一条配置（删除 / 改范围时从原 scope 摘除）。 */
export function withoutWebviewPage(pages: readonly WebviewPage[], id: string): WebviewPage[] {
  return pages.filter(page => page.id !== id)
}

/** 一条新配置的 id（uuid 优先，无 crypto 环境退化为时间+随机后缀）。 */
export function newWebviewPageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}
