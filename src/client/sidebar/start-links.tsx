/**
 * 开始页面（hero）末尾的快捷入口行。
 *
 * DSH web 在主区没有会话内容时渲染 hero 开始页：宿主把相位打在
 * ConversationRoot 的 `data-phase` 上（"settling" | "hero" | "active"，宿主
 * ConversationMainPanel），`hero` 即开始页。本模块在该根元素**末尾**追加一行
 * 胶囊入口（portal 挂载，行落在输入框 `[data-composer-seat]` 之下），相位离开
 * hero 或宿主 DOM 被替换时整体移除。
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
 *   「设置」走 settings-entry.ts 的探测链（宿主无公开打开 API，全链静默降级）。
 * - MutationObserver 与 portal root 都由返回的 disposer 清理（ctx.effect，
 *   HMR / 插件停用时反向注销）。
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IconSettingsOutlineRegular, ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { changesTabIcon, filesTabIcon, sidechatTabIcon, tasksTabIcon, terminalTabIcon } from '../builtins/tab-icons.tsx'
import { mountedSessionId } from '../native/surface.ts'
import { t } from '../locales.ts'
import type { BetterSidebarService } from '../service.ts'
import { openSettingsEntry } from './settings-entry.ts'
import css from './start-links.module.css'

/** 一个入口的展示与动作（kind 也写进 data-dsh-start-link 供测试/样式锚定）。 */
interface StartLink {
  kind: 'files' | 'changes' | 'terminal' | 'jobs' | 'sidechat' | 'settings'
  label: () => string
  icon: (size: number) => React.ReactNode
  /** 终端按钮的快捷键提示（宿主 catalog 的 unboxed 键帽；探测不到给静态回退）。 */
  keys?: readonly string[]
  aria?: string
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
    case 'jobs':
      service.openTab({ type: 'subagent' })
      return
    case 'sidechat':
      service.openTab({ type: 'sidechat' })
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

/** 入口行本身（portal 内容）。 */
export function StartLinks(props: { ctx: Context; service: BetterSidebarService; keys?: readonly string[]; aria?: string }) {
  const { ctx, service } = props
  const links: StartLink[] = [
    { kind: 'files', label: () => t('files'), icon: filesTabIcon },
    { kind: 'changes', label: () => t('changes'), icon: changesTabIcon },
    {
      kind: 'terminal',
      label: () => t('startNewTerminal'),
      icon: terminalTabIcon,
      ...(props.keys !== undefined ? { keys: props.keys } : {}),
      ...(props.aria !== undefined ? { aria: props.aria } : {}),
    },
    { kind: 'jobs', label: () => t('subagent'), icon: tasksTabIcon },
    { kind: 'sidechat', label: () => t('sideChat'), icon: sidechatTabIcon },
    { kind: 'settings', label: () => t('startSettings'), icon: settingsStartIcon },
  ]
  return (
    <div className={css.row} data-dsh-start-links="" aria-label={t('startLinksAria')}>
      {links.map(link => (
        <button
          key={link.kind}
          type="button"
          className={css.pill}
          data-dsh-start-link={link.kind}
          aria-label={link.aria}
          onClick={() => { openStartLink(link.kind, ctx, service) }}
        >
          <span className={css.icon} aria-hidden="true">{link.icon(14)}</span>
          <span className={css.label}>{link.label()}</span>
          {link.keys !== undefined && link.keys.length > 0 && (
            <ShortcutKeys keys={link.keys} className={css.keys} />
          )}
        </button>
      ))}
    </div>
  )
}

/**
 * 注册 hero 快捷入口行：监听 `[data-slot="main.conversation"]` 内的
 * `data-phase` 属性变更（含子树增删，SPA 导航 / HMR 的 DOM 替换一并覆盖），
 * 仅 `hero` 时把入口行 portal 到相位根元素末尾。返回清理 disposer。
 */
export function registerStartLinks(ctx: Context, service: BetterSidebarService): () => void {
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
    // 追加到相位根**末尾**：composer seat 在会话内容槽里，行自然落在输入框下方。
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
