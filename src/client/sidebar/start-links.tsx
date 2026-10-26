/**
 * 开始页面（hero）末尾的快捷入口网格 + 内置设置页。
 *
 * DSH web 在主区没有会话内容时渲染 hero 开始页：宿主把相位打在
 * ConversationRoot 的 `data-phase` 上（"settling" | "hero" | "active"，宿主
 * ConversationMainPanel），`hero` 即开始页。本模块在该根元素**末尾**追加一组
 * 入口网格 tile（portal 挂载，网格落在输入框 `[data-composer-seat]` 之下），
 * 相位离开 hero 或宿主 DOM 被替换时整体移除。
 *
 * 「设置」胶囊打开的是**开始页里的设置页**（`data-dsh-start-settings`）：同一
 * portal 宿主内、入口网格下方渲染一张设置卡片，内容直接复用宿主设置壳的
 * SideCardSection（侧边卡片全部配置项 + 各功能的齿轮弹窗 + 添加插件弹窗，
 * 读写走同一条插件 settings 路由，两处所见即同一份数据）。Esc / 关闭按钮 /
 * 再次点击胶囊 / 相位离开 hero 都会收起。宿主设置壳没有公开打开 API，卡片头
 * 保留「打开宿主设置」按钮走 settings-entry.ts 的探测链作为降级出口（全链
 * 静默降级）。store 缺席（调用方未注入共享 store）时胶囊退回旧的
 * 「打开宿主设置」行为。
 *
 * 契约边界：
 * - 只消费 `data-*` 标记（`[data-slot="main.conversation"]` 的槽锚 +
 *   `[data-phase]`）；宿主类名是 CSS-module 哈希值，一律不碰。
 * - 打开动作复用既有路径：插件 tab 走 `service.openTab`（原生右栏分支），宿主
 *   `terminal` kind 走 `ctx.get('sidebarRight')` 的 `openTab`（结构化探测，
 *   subagent-chat.ts 的 SidebarRightFace 写法）。宿主命令面在没有上屏会话时
 *   会 throw（ui-sidebar-right README：命令作用于在屏会话），所以终端按钮先读
 *   `ctx.sidebarRight.mounted`，无在屏会话时点击是 no-op——hero 也可能是「无会话」
 *   相位，此时插件 tab 的 openTab 同样因无活动会话而静默返回，两条路径都不会抛。
 * - MutationObserver 与 portal root 都由返回的 disposer 清理（ctx.effect，
 *   HMR / 插件停用时反向注销）。
 */
import { useCallback, useEffect, useState, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IconCloseFillRegular, IconSettingsOutlineRegular, ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { changesTabIcon, filesTabIcon, historyTabIcon, searchTabIcon, sidechatTabIcon, tasksTabIcon, terminalTabIcon, webviewTabIcon, commandsTabIcon } from '../builtins/tab-icons.tsx'
import { mountedSessionId } from '../native/surface.ts'
import { t } from '../locales.ts'
import type { SidebarStore } from '../state.ts'
import type { BetterSidebarService } from '../service.ts'
import { SideCardSection } from '../SideCardSection.tsx'
import { openSettingsEntry } from './settings-entry.ts'
import css from './start-links.module.css'

/** 一个入口的展示与动作（kind 也写进 data-dsh-start-link 供测试/样式锚定）。 */
interface StartLink {
  kind: 'files' | 'changes' | 'search' | 'terminal' | 'jobs' | 'sidechat' | 'history' | 'webview' | 'commands' | 'settings'
  label: () => string
  icon: (size: number) => React.ReactNode
  /** 终端按钮的快捷键提示（宿主 catalog 的 unboxed 键帽；探测不到给静态回退）。 */
  keys?: readonly string[]
  aria?: string
  /** 悬停提示（「历史发送」的说明文案比标签长，title 与 aria 同文案）。 */
  title?: string
}

/** 宿主快捷键目录的结构化探测面（只取 terminal.new 的展示键帽）。 */
interface ShortcutCatalogFace {
  catalog?: {
    getSnapshot?(): readonly { id?: unknown; keys?: readonly unknown[]; aria?: unknown }[]
  }
}

/**
 * 从宿主快捷键目录读 `terminal.new` 的有效键帽（宿主 TerminalGuide 同款数据）。
 * 服务缺席 / 形状不符一律返回 undefined，由调用方回退静态提示。
 */
export function terminalShortcutKeys(ctx: Context): { keys: readonly string[]; aria?: string } | undefined {
  try {
    const catalog = (ctx.get('shortcuts') as ShortcutCatalogFace | undefined)?.catalog
    const entries = typeof catalog?.getSnapshot === 'function' ? catalog.getSnapshot() : undefined
    const entry = entries?.find(candidate => candidate?.id === 'terminal.new')
    const keys = entry?.keys
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every(key => typeof key === 'string')) return undefined
    return {
      keys: keys as readonly string[],
      ...(typeof entry?.aria === 'string' && entry.aria !== '' ? { aria: entry.aria } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * 执行一个入口的打开动作。插件 tab 复用 service.openTab（禁用类型内部已拒绝，
 * 无活动会话内部已静默返回）；宿主 terminal kind 结构化探测 + mounted 门控。
 */
export function openStartLink(kind: StartLink['kind'], ctx: Context, service: BetterSidebarService): void {
  switch (kind) {
    case 'files':
      // 无路径的 editor 打开即文件树（service.ts 的原生分支把 path-less editor
      // 落成宿主 `files` kind 页）。
      service.openTab({ type: 'editor' })
      return
    case 'changes':
      service.openTab({ type: 'git' })
      return
    case 'search':
      // 「搜索」(Find in Files)：每次点击铸一个新搜索 tab（search 描述符是
      // createTab 多实例语义，与文件页胶囊同一形态）；无活动会话时 openTab
      // 内部静默返回，点击不抛错。
      service.openTab({ type: 'search' })
      return
    case 'jobs':
      service.openTab({ type: 'subagent' })
      return
    case 'sidechat':
      service.openTab({ type: 'sidechat' })
      return
    case 'history':
      // 「历史发送」：打开共享的提示词历史页（type: 'history'，单实例去重）。
      // openTab 的插件分支在无活动会话时内部静默返回——hero 相位可以没有会话，
      // 点击不抛错。
      service.openTab({ type: 'history' })
      return
    case 'webview':
      // 「webview网页」：打开配置页（type: 'webview'，单实例去重）——列表 +
      // 表单都在页内，真正的网页 tab 由配置条目再铸。无活动会话时 openTab
      // 内部静默返回，与 history 同一形态，点击不抛错。
      service.openTab({ type: 'webview' })
      return
    case 'commands':
      // 「命令」：打开配置页（type: 'commands'，单实例去重）——命令与脚本
      // 规则的管理都在页内，真正的执行 tab 由运行动作再铸。无活动会话时
      // openTab 内部静默返回，与 webview 同一形态，点击不抛错。
      service.openTab({ type: 'commands' })
      return
    case 'terminal':
      // 宿主命令面按契约作用于「在屏会话」，无在屏会话时调用会 throw——先读
      // mounted，undefined 即 no-op（hero 相位可以完全没有会话，点击不应报错）。
      if (mountedSessionId(ctx) === undefined) return
      try {
        const face = ctx.get('sidebarRight') as
          | { openTab?(kind: string, options?: { params?: unknown }): void }
          | undefined
        face?.openTab?.('terminal', {})
      } catch {
        // 探测/调用失败：宿主没有这个 kind（或仍未铸出 store），无事可做。
      }
      return
    case 'settings':
      // 宿主设置壳没有公开打开 API：结构化探测链（settings-entry.ts），
      // 全链失败静默 no-op——hero 相位下宿主壳形状可能整体缺席，点击不抛错。
      openSettingsEntry(ctx)
      return
  }
}

/** 「设置」的齿轮 glyph：ui-primitives 官方齿轮（非 tab 类型，ink 令牌上色）。 */
function settingsStartIcon(size: number): React.ReactNode {
  return (
    <span className={css.iconSettings}>
      <IconSettingsOutlineRegular size={size} />
    </span>
  )
}

/**
 * 开始页里的设置页（`data-dsh-start-settings`）：入口网格下方的设置卡片，内容
 * 就是宿主设置壳的 Side card 分区本体（同一组件、同一 store、同一条 settings
 * 路由）。Esc 关闭；「打开宿主设置」是宿主设置壳的降级出口（探测链静默）。
 */
function StartSettingsPanel(props: { ctx: Context; service: BetterSidebarService; store: SidebarStore; onClose: () => void }) {
  const { ctx, service, store, onClose } = props
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <div className={css.settings} data-dsh-start-settings="" role="region" aria-label={t('startSettingsPanelAria')}>
      <div className={css.settingsHead}>
        <span className={css.settingsTitle}>{t('startSettings')}</span>
        <span className={css.settingsHeadActions}>
          <button type="button" className={css.settingsGhost} onClick={() => { openSettingsEntry(ctx) }}>
            {t('startSettingsOpenHost')}
          </button>
          <button type="button" className={css.settingsClose} aria-label={t('startSettingsClose')} onClick={onClose}>
            <IconCloseFillRegular size={14} />
          </button>
        </span>
      </div>
      <div className={css.settingsBody}>
        <SideCardSection store={store} service={service} />
      </div>
    </div>
  )
}

/** 入口网格本身（portal 内容；「设置」入口开关同一 portal 内的内置设置页）。 */
export function StartLinks(props: { ctx: Context; service: BetterSidebarService; store?: SidebarStore; keys?: readonly string[]; aria?: string }) {
  const { ctx, service, store } = props
  const [settingsOpen, setSettingsOpen] = useState(false)
  const closeSettings = useCallback(() => { setSettingsOpen(false) }, [])
  const links: StartLink[] = [
    { kind: 'files', label: () => t('files'), icon: filesTabIcon },
    { kind: 'changes', label: () => t('changes'), icon: changesTabIcon },
    { kind: 'search', label: () => t('search'), icon: searchTabIcon },
    {
      kind: 'terminal',
      label: () => t('startNewTerminal'),
      icon: terminalTabIcon,
      ...(props.keys !== undefined ? { keys: props.keys } : {}),
      ...(props.aria !== undefined ? { aria: props.aria } : {}),
    },
    { kind: 'jobs', label: () => t('subagent'), icon: tasksTabIcon },
    { kind: 'sidechat', label: () => t('sideChat'), icon: sidechatTabIcon },
    {
      kind: 'history',
      label: () => t('historySent'),
      icon: historyTabIcon,
      aria: t('startHistoryAria'),
      title: t('startHistoryAria'),
    },
    {
      // 「webview网页」：配置页入口，排在「历史发送」之后、「命令」之前；
      // 说明文案与 aria 同句（同 history 的形态）。
      kind: 'webview',
      label: () => t('webviewPages'),
      icon: webviewTabIcon,
      aria: t('guideDescWebview'),
      title: t('guideDescWebview'),
    },
    {
      // 「命令」：配置页入口，排在「webview网页」之后、「设置」之前——
      // 满足「webview 与 settings 之间」的排位要求；说明文案与 aria 同句。
      kind: 'commands',
      label: () => t('commandsPage'),
      icon: commandsTabIcon,
      aria: t('guideDescCommands'),
      title: t('guideDescCommands'),
    },
    { kind: 'settings', label: () => t('startSettings'), icon: settingsStartIcon },
  ]
  return (
    <>
      <div className={css.row} data-dsh-start-links="" aria-label={t('startLinksAria')}>
        {links.map(link => (
          <button
            key={link.kind}
            type="button"
            className={css.pill}
            data-dsh-start-link={link.kind}
            aria-label={link.aria}
            {...(link.title !== undefined ? { title: link.title } : {})}
            aria-expanded={link.kind === 'settings' && store !== undefined ? settingsOpen : undefined}
            onClick={() => {
              if (link.kind === 'settings' && store !== undefined) {
                setSettingsOpen(open => !open)
                return
              }
              openStartLink(link.kind, ctx, service)
            }}
          >
            <span className={css.icon} aria-hidden="true">{link.icon(14)}</span>
            <span className={css.label}>{link.label()}</span>
            {link.keys !== undefined && link.keys.length > 0 && (
              <ShortcutKeys keys={link.keys} className={css.keys} />
            )}
          </button>
        ))}
      </div>
      {settingsOpen && store !== undefined && (
        <StartSettingsPanel ctx={ctx} service={service} store={store} onClose={closeSettings} />
      )}
    </>
  )
}

/**
 * 注册 hero 快捷入口网格（+ 内置设置页）：监听 `[data-slot="main.conversation"]`
 * 内的 `data-phase` 属性变更（含子树增删，SPA 导航 / HMR 的 DOM 替换一并覆盖），
 * 仅 `hero` 时把入口网格 portal 到相位根元素末尾。`store` 是共享偏好 store：
 * 注入后「设置」胶囊打开内置设置页（SideCardSection 需要），缺席时退回
 * 「打开宿主设置」。返回清理 disposer。
 */
export function registerStartLinks(ctx: Context, service: BetterSidebarService, store?: SidebarStore): () => void {
  const doc = document
  let root: Root | undefined
  let host: HTMLElement | undefined
  let attachedTo: Element | undefined

  const unmount = (): void => {
    if (root !== undefined) {
      const pendingRoot = root
      root = undefined
      try {
        pendingRoot.unmount()
      } catch {
        // 已脱离的 root：卸载失败不影响后续挂载。
      }
    }
    host?.remove()
    host = undefined
    attachedTo = undefined
  }

  const sync = (): void => {
    // 槽锚是 display:contents 的包装，相位根是它的子节点——一个后代查询同时
    // 覆盖「锚在」与「相位在」。锚不在（SPA 导走 / 尚未挂载）即视为非 hero。
    const phaseRoot = doc.querySelector('[data-slot="main.conversation"] [data-phase]')
    if (phaseRoot === null || phaseRoot.getAttribute('data-phase') !== 'hero') {
      unmount()
      return
    }
    if (root !== undefined && phaseRoot === attachedTo) return
    unmount()
    // 追加到相位根**末尾**：composer seat 在会话内容槽里，网格自然落在输入框下方。
    host = doc.createElement('div')
    host.setAttribute('data-dsh-start-links-host', '')
    phaseRoot.appendChild(host)
    attachedTo = phaseRoot
    root = createRoot(host)
    // 快捷键提示读宿主目录一次（目录变化不追）；读不到回退静态 Ctrl+`。
    const shortcut = terminalShortcutKeys(ctx)
    root.render(createElement(StartLinks, {
      ctx,
      service,
      ...(store !== undefined ? { store } : {}),
      keys: shortcut?.keys ?? ['Ctrl', '`'],
      ...(shortcut?.aria !== undefined ? { aria: shortcut.aria } : {}),
    }))
  }

  const observer = new MutationObserver(sync)
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-phase', 'data-slot'],
  })
  sync()
  return () => {
    observer.disconnect()
    unmount()
  }
}
