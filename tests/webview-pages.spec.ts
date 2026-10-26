/**
 * 「webview网页」纯逻辑（src/client/webview-pages.ts）+ 打开逻辑
 * （src/client/webview-open.ts）。
 *
 * 钉住：blob 容错解析（非数组/坏行兜底，openMode/pinned 只认严格值）、
 * 全局+工作区合并（工作区在前、id 冲突工作区赢）、pinned 挑选（合并序 +
 * 严格合法性）、两个 scope 的读取（`pluginSettings['webview'].pages` 与
 * `pluginSettings['__project'][cwd].webviewPages`）、upsert/remove，以及
 * 打开出口（window 模式走 window.open noopener；tab 模式 park 一次性 seed
 * 再 openTab；类型被禁用时不 park 不 open；非法条目静默 no-op）。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isWebviewUrl,
  isValidWebviewPage,
  mergeWebviewPageRows,
  mergeWebviewPages,
  newWebviewPageId,
  parseWebviewPages,
  pinnedWebviewPages,
  pinnedWebviewPagesFor,
  readGlobalWebviewPages,
  readWorkspaceWebviewPages,
  upsertWebviewPage,
  webviewPageIdOfTab,
  webviewTabIdOf,
  WEBVIEW_SETTINGS_ID,
  withoutWebviewPage,
  type WebviewPage,
} from '../src/client/webview-pages.ts'
import { consumeWebviewOpen, openWebviewPage, parkWebviewOpen, type WebviewOpenService } from '../src/client/webview-open.ts'

function page(patch: Partial<WebviewPage>): WebviewPage {
  return { id: 'p1', name: 'Docs', url: 'https://example.com', openMode: 'tab', pinned: false, ...patch }
}

describe('parseWebviewPages（容错解析）', () => {
  it('非数组一律空表', () => {
    expect(parseWebviewPages(undefined)).toEqual([])
    expect(parseWebviewPages(null)).toEqual([])
    expect(parseWebviewPages('nope')).toEqual([])
    expect(parseWebviewPages({ id: 'p1' })).toEqual([])
  })

  it('坏行丢弃；缺字段行兜底默认值（openMode→tab、pinned→false）', () => {
    const parsed = parseWebviewPages([
      null,
      'nope',
      { no: 'id' },
      { id: 'p1' },
      { id: 'p2', name: 'B', url: 'http://b.dev', openMode: 'window', pinned: true },
      { id: 'p3', name: 'C', url: 'ftp://c.dev', openMode: 'other', pinned: 'yes' },
    ])
    expect(parsed).toEqual([
      { id: 'p1', name: '', url: '', openMode: 'tab', pinned: false },
      { id: 'p2', name: 'B', url: 'http://b.dev', openMode: 'window', pinned: true },
      // openMode 只认严格 'window'，pinned 只认严格 true：脏值都落回默认。
      { id: 'p3', name: 'C', url: 'ftp://c.dev', openMode: 'tab', pinned: false },
    ])
  })
})

describe('isWebviewUrl / isValidWebviewPage（打开侧校验）', () => {
  it('仅 http/https 可解析的地址合法', () => {
    expect(isWebviewUrl('https://example.com/a?b=c')).toBe(true)
    expect(isWebviewUrl('http://localhost:8080/x')).toBe(true)
    expect(isWebviewUrl('ftp://example.com')).toBe(false)
    expect(isWebviewUrl('file:///etc/passwd')).toBe(false)
    expect(isWebviewUrl('javascript:alert(1)')).toBe(false)
    expect(isWebviewUrl('not a url')).toBe(false)
    expect(isWebviewUrl('')).toBe(false)
  })

  it('严格校验 = 名称非空 + URL 合法', () => {
    expect(isValidWebviewPage(page({}))).toBe(true)
    expect(isValidWebviewPage(page({ name: '  ' }))).toBe(false)
    expect(isValidWebviewPage(page({ url: 'javascript:alert(1)' }))).toBe(false)
  })
})

describe('mergeWebviewPages（全局+工作区合并）', () => {
  it('工作区在前、全局在后；id 冲突工作区赢（同 open-with 的项目侧优先语义）', () => {
    const globalPages = [
      page({ id: 'shared', name: 'GlobalName', url: 'https://g.dev' }),
      page({ id: 'only-g', name: 'OnlyGlobal', url: 'https://g2.dev' }),
    ]
    const workspacePages = [
      page({ id: 'shared', name: 'WorkspaceName', url: 'https://w.dev' }),
      page({ id: 'only-w', name: 'OnlyWorkspace', url: 'https://w2.dev' }),
    ]
    const merged = mergeWebviewPages(globalPages, workspacePages)
    expect(merged.map(p => p.id)).toEqual(['shared', 'only-w', 'only-g'])
    expect(merged[0]?.name).toBe('WorkspaceName')
    expect(merged[0]?.url).toBe('https://w.dev')
  })

  it('带来源的合并行：source 标注全局/工作区（列表徽章用）', () => {
    const rows = mergeWebviewPageRows(
      [page({ id: 'g1' })],
      [page({ id: 'w1' })],
    )
    expect(rows).toEqual([
      { page: page({ id: 'w1' }), source: 'workspace' },
      { page: page({ id: 'g1' }), source: 'global' },
    ])
  })

  it('任一侧为空时另一侧原样保留', () => {
    const globalPages = [page({ id: 'g1' })]
    expect(mergeWebviewPages(globalPages, [])).toEqual(globalPages)
    expect(mergeWebviewPages([], [page({ id: 'w1' })]).map(p => p.id)).toEqual(['w1'])
  })
})

describe('pinned 挑选（固定打开）', () => {
  it('只留 pinned 且严格合法的行，保持合并序', () => {
    const pinned = pinnedWebviewPages([
      page({ id: 'a', pinned: true }),
      page({ id: 'b', pinned: false }),
      page({ id: 'c', pinned: true, url: 'javascript:alert(1)' }),
      page({ id: 'd', pinned: true, name: '' }),
    ])
    expect(pinned.map(p => p.id)).toEqual(['a'])
  })

  it('pinnedWebviewPagesFor 直接从 prefs 形状算（工作区 id 冲突赢 + cwd 缺席跳过工作区）', () => {
    const pluginSettings = {
      [WEBVIEW_SETTINGS_ID]: { pages: [page({ id: 'shared', pinned: true, name: 'G', url: 'https://g.dev' }), page({ id: 'g-only', pinned: true })] },
      __project: {
        '/w': { webviewPages: [page({ id: 'shared', pinned: true, name: 'W', url: 'https://w.dev' }), page({ id: 'w-unpinned' })] },
      },
    }
    const pinned = pinnedWebviewPagesFor(pluginSettings, '/w')
    expect(pinned.map(p => p.id)).toEqual(['shared', 'g-only'])
    expect(pinned[0]?.name).toBe('W')
    // cwd 缺席：工作区 blob 不可达，全局 pinned 仍生效。
    expect(pinnedWebviewPagesFor(pluginSettings, undefined).map(p => p.id)).toEqual(['shared', 'g-only'])
    expect(pinnedWebviewPagesFor(undefined, '/w')).toEqual([])
  })
})

describe('scope 读写辅助', () => {
  it('readGlobalWebviewPages 读 pluginSettings[webview].pages（脏 blob 空表）', () => {
    expect(readGlobalWebviewPages({ [WEBVIEW_SETTINGS_ID]: { pages: [page({})] } })).toEqual([page({})])
    expect(readGlobalWebviewPages({ [WEBVIEW_SETTINGS_ID]: 'junk' })).toEqual([])
    expect(readGlobalWebviewPages({})).toEqual([])
    expect(readGlobalWebviewPages(undefined)).toEqual([])
  })

  it('readWorkspaceWebviewPages 读 __project[cwd].webviewPages；cwd 缺席/空串一律空表', () => {
    const pluginSettings = { __project: { '/w': { webviewPages: [page({})] } } }
    expect(readWorkspaceWebviewPages(pluginSettings, '/w')).toEqual([page({})])
    expect(readWorkspaceWebviewPages(pluginSettings, undefined)).toEqual([])
    expect(readWorkspaceWebviewPages(pluginSettings, '')).toEqual([])
    expect(readWorkspaceWebviewPages(pluginSettings, '/other')).toEqual([])
  })

  it('upsert 覆盖同名 id 或追加；without 按 id 摘除', () => {
    const pages = [page({ id: 'a' }), page({ id: 'b' })]
    expect(upsertWebviewPage(pages, page({ id: 'a', name: 'New' })).map(p => p.name)).toEqual(['New', 'Docs'])
    expect(upsertWebviewPage(pages, page({ id: 'c' })).map(p => p.id)).toEqual(['a', 'b', 'c'])
    expect(withoutWebviewPage(pages, 'a').map(p => p.id)).toEqual(['b'])
  })

  it('tab id 契约与 meta.pageId 提取（脏 meta 不去重）', () => {
    expect(webviewTabIdOf('p1')).toBe('webview:p1')
    expect(webviewPageIdOfTab({ meta: { pageId: 'p1' } })).toBe('p1')
    expect(webviewPageIdOfTab({ meta: { pageId: '' } })).toBeUndefined()
    expect(webviewPageIdOfTab({ meta: 'junk' })).toBeUndefined()
    expect(webviewPageIdOfTab({})).toBeUndefined()
  })

  it('新 id 生成非空', () => {
    expect(newWebviewPageId()).not.toBe('')
    expect(newWebviewPageId()).not.toBe(newWebviewPageId())
  })
})

describe('openWebviewPage（打开出口）', () => {
  afterEach(() => {
    consumeWebviewOpen()
    vi.restoreAllMocks()
  })

  const fakeService = (enabled = true): { service: WebviewOpenService; openTab: ReturnType<typeof vi.fn> } => {
    const openTab = vi.fn()
    return { service: { isTabEnabled: () => enabled, openTab: openTab as unknown as WebviewOpenService['openTab'] }, openTab }
  }

  it('openMode=window：window.open 新窗口（noopener/noreferrer），不碰 tab 服务', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const { service, openTab } = fakeService()
    openWebviewPage(service, page({ openMode: 'window', url: 'https://example.com/x' }))
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')
    expect(openTab).not.toHaveBeenCalled()
    // 打开动作不 park seed（seed 是 tab 通道的一次性凭据）。
    expect(consumeWebviewOpen()).toBeUndefined()
  })

  it('openMode=tab：park 一次性 seed 后 openTab（title/url 随 openTab seed）', () => {
    const { service, openTab } = fakeService()
    openWebviewPage(service, page({ id: 'p9', name: 'Docs', url: 'https://example.com/a' }))
    expect(openTab).toHaveBeenCalledWith({ type: 'webview-page', url: 'https://example.com/a', title: 'Docs' })
    // createTab 将消费的 seed：pageId 是 dedupe 的锚。
    expect(consumeWebviewOpen()).toEqual({ pageId: 'p9', url: 'https://example.com/a', name: 'Docs' })
  })

  it('类型被禁用：不 park 不 open（seed 不残留给下一次不相干的铸造）', () => {
    const { service, openTab } = fakeService(false)
    openWebviewPage(service, page({}))
    expect(openTab).not.toHaveBeenCalled()
    expect(consumeWebviewOpen()).toBeUndefined()
  })

  it('非法条目（空名/非 http(s)）静默 no-op', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const { service, openTab } = fakeService()
    openWebviewPage(service, page({ url: 'file:///etc/passwd', openMode: 'window' }))
    openWebviewPage(service, page({ name: ' ', openMode: 'tab' }))
    expect(openSpy).not.toHaveBeenCalled()
    expect(openTab).not.toHaveBeenCalled()
    expect(consumeWebviewOpen()).toBeUndefined()
  })

  it('seed 的 park/consume 是一次性手递手', () => {
    parkWebviewOpen({ pageId: 'a', url: 'https://a.dev', name: 'A' })
    expect(consumeWebviewOpen()?.pageId).toBe('a')
    expect(consumeWebviewOpen()).toBeUndefined()
  })
})
