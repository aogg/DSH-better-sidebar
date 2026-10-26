/**
 * 「webview网页」的打开逻辑：配置页的「打开」按钮与固定打开（pinned 自动开）
 * 共用的同一个出口。
 *
 * - `openMode: 'window'`：真实新浏览器窗口。项目内 http(s) 外链没有宿主侧的
 *   统一出口（src/open-external.ts 只服务自定义 scheme，明确拒绝 http/https；
 *   link-intercept.ts 的兜底就是 window.open），所以沿用同一条
 *   `window.open(url, '_blank', 'noopener,noreferrer')`。
 * - `openMode: 'tab'`：在侧边栏开一个 `webview-page` tab。tab 的铸造由
 *   builtins/tabs.tsx 的 createTab 完成，这里只负责把「要开哪一页」park 进
 *   一次性 seed——createTab descriptor 会自铸 tab，openTab seed 自己的
 *   title/url 只能覆盖标题与地址，带不上 pageId（dedupe 的锚），所以照
 *   search-seed.ts / sidechat 的 hand-off 形状走模块级 one-shot：
 *   park 紧贴着唯一一次 openTab 调用，被拒绝的 open 不留残留。
 */
import { isValidWebviewPage, WEBVIEW_TAB_TYPE, type WebviewPage } from './webview-pages.ts'

/** openTab 服务里本模块真正用到的最小面（fake 友好，测试不必造全量服务）。 */
export interface WebviewOpenService {
  isTabEnabled(id: string): boolean
  openTab(seed: { type: string; url?: string; title?: string }): void
}

/** park 进一次性 seed 的内容：pageId（dedupe 锚）+ 地址 + 标题。 */
export interface WebviewOpenSeed {
  pageId: string
  url: string
  name: string
}

let parkedSeed: WebviewOpenSeed | undefined

/** park 一页，供下一次 webview-page 的 createTab 消费（调完立刻 openTab）。 */
export function parkWebviewOpen(seed: WebviewOpenSeed): void {
  parkedSeed = seed
}

/** 取走（并清空）parked seed；undefined = 无 seed（拒绝铸空白 tab）。 */
export function consumeWebviewOpen(): WebviewOpenSeed | undefined {
  const seed = parkedSeed
  parkedSeed = undefined
  return seed
}

/**
 * 打开一条网页配置。非法条目（空名 / 非 http(s)）是静默 no-op——pinned 自动
 * 打开的路径上没有用户可感知的错误面。tab 分支在类型被用户禁用（tabsEnabled）
 * 时不 park 不 open，避免 seed 残留泄漏给下一次不相干的铸造。
 */
export function openWebviewPage(service: WebviewOpenService, page: WebviewPage): void {
  if (!isValidWebviewPage(page)) return
  if (page.openMode === 'window') {
    // 配置页「打开」按钮是用户手势，弹窗拦截放行；固定打开（新会话钩子）不是
    // 手势，浏览器可能拦截——尽力而为的静默失败，不为此引入横幅/重试面。
    window.open(page.url, '_blank', 'noopener,noreferrer')
    return
  }
  if (!service.isTabEnabled(WEBVIEW_TAB_TYPE)) return
  parkWebviewOpen({ pageId: page.id, url: page.url, name: page.name })
  // seed.title/url 由 openTab seed 覆盖标题与地址（native record 的 title/path）；
  // pageId 走 createTab 消费的 meta——dedupeKey=pageId 由此保证同一页只开一个
  // tab（tab id 契约 webview:<pageId> 见 webview-pages.ts 的 webviewTabIdOf）。
  service.openTab({ type: WEBVIEW_TAB_TYPE, url: page.url, title: page.name })
}
