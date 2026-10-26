/**
 * 「webview网页」tab 的正文（type: 'webview-page'，builtins/tabs.tsx 铸出的
 * 每页一个 tab）：一个沙箱 iframe 渲染配置条目的 URL。
 *
 * 安全契约：
 * - sandbox tokens 沿用 src/client/html-preview.ts 的 HTML_IFRAME_SANDBOX——
 *   明确不含 allow-same-origin（页面必须留在 opaque origin，碰不到 GUI 的
 *   会话数据与内部 API），也不含 allow-top-navigation（不许劫持宿主界面）。
 *   与宿主 browser tab 的沙箱策略同一基调；不做「关闭沙箱」旁路——配置化的
 *   网页是长期驻留面，风险面比一次性预览大。
 * - 只有 http/https 会进 iframe（isValidWebviewPage 已在打开侧把关，这里再
 *   兜一层：meta 兜底地址也可能被外部改坏）。
 *
 * URL 即时更新契约：tab 记录里的 meta 只是铸造时刻的快照；正文渲染时按
 * meta.pageId 从「全局+当前工作区」合并后的配置里解析现行条目，配置改了
 * （含改 URL/改名）立即跟随（iframe 以 key={url} 强制重载）；条目被删除时
 * 退回 meta 快照，已开的 tab 不至于白屏。改名/改地址同时经 updateTab 回写
 * tab 记录（native chip 读 record.title，reload 后的兜底快照也保持新鲜）。
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import type { SidebarStore, SidebarTab } from './state.ts'
import { HTML_IFRAME_SANDBOX } from './html-preview.ts'
import { t } from './locales.ts'
import {
  isWebviewUrl,
  mergeWebviewPages,
  readGlobalWebviewPages,
  readWorkspaceWebviewPages,
  webviewPageIdOfTab,
  type WebviewPage,
} from './webview-pages.ts'
import css from './webview.module.css'

/** 铸 tab 时写进 meta 的快照（webview-open.ts park 的形状）。 */
function metaSnapshotOf(tab: SidebarTab): WebviewPage | undefined {
  const pageId = webviewPageIdOfTab(tab)
  if (pageId === undefined) return undefined
  const meta = tab.meta as Record<string, unknown>
  return {
    id: pageId,
    name: typeof meta.name === 'string' ? meta.name : '',
    // path 是地址的另一份落点（url seed 落 record.path），meta.url 缺席时兜底。
    url: typeof meta.url === 'string' ? meta.url : (tab.path ?? ''),
    openMode: 'tab',
    pinned: false,
  }
}

/** 订阅 prefs 快照：配置任何一次写回（本页签改、配置页改、别的窗口改）都会
 *  发布新快照，正文随之重渲染。 */
function usePrefsSnapshot(store: SidebarStore): ReturnType<SidebarStore['getSnapshot']> {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  )
}

export function WebviewPageView(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
}) {
  const { ctx, store, scope, tab } = props
  const snapshot = usePrefsSnapshot(store)
  const pluginSettings = snapshot.prefs.pluginSettings
  const minted = useMemo(() => metaSnapshotOf(tab), [tab])
  // 现行配置优先，meta 快照兜底（条目被删除的 tab 继续按铸造时的地址渲染）。
  const entry = useMemo(() => {
    const pageId = minted?.id
    if (pageId === undefined) return undefined
    const merged = mergeWebviewPages(
      readGlobalWebviewPages(pluginSettings),
      readWorkspaceWebviewPages(pluginSettings, scope.cwd),
    )
    return merged.find(page => page.id === pageId)
  }, [pluginSettings, scope.cwd, minted])
  const url = entry !== undefined && entry.url !== '' ? entry.url : (minted?.url ?? tab.path ?? '')
  const name = entry?.name ?? minted?.name ?? tab.title

  // 改名/改地址回写 tab 记录：tab 条标题立即跟随，meta 快照也保持新鲜。
  // updateTab 对已关 tab 是 no-op；等值时不动，避免 store 空转。服务探测失败
  // （minimal mock / 服务缺席）静默跳过——正文仍按现行配置渲染。
  const service = useMemo(() => {
    try {
      return ctx.get('betterSidebar')
    } catch {
      return undefined
    }
  }, [ctx])
  useEffect(() => {
    if (entry === undefined || service === undefined) return
    const patch: { title?: string; meta?: unknown } = {}
    if (tab.title !== entry.name) patch.title = entry.name
    const nextMeta = { pageId: entry.id, url: entry.url, name: entry.name }
    if (JSON.stringify(tab.meta) !== JSON.stringify(nextMeta)) patch.meta = nextMeta
    if (patch.title === undefined && patch.meta === undefined) return
    service.updateTab(tab.id, patch, scope.sessionId)
  }, [entry, service, tab.id, tab.title, tab.meta, scope.sessionId])

  if (!isWebviewUrl(url)) {
    return (
      <div className={css.frameStatus} data-dsh-webview-blocked="">
        <span className={css.frameStatusText}>{t('browserBlockedScheme')}</span>
      </div>
    )
  }
  return (
    <div className={css.frameHost} data-dsh-webview-frame="">
      {/* key={url}：编辑地址后强制重铸 iframe（复用节点不会重新导航跨域地址）。 */}
      <iframe
        key={url}
        className={css.frame}
        src={url}
        title={name}
        sandbox={HTML_IFRAME_SANDBOX}
      />
      <div className={css.hint} role="note">{t('webviewFrameHint')}</div>
    </div>
  )
}
