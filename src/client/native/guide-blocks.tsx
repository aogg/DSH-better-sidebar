/**
 * Grouped-block replacement for the HOST guide start page (the native right
 * Sidebar's start page under `[data-sidebar-right-guide]`).
 *
 * Why the plugin renders its own structure: the host lays every guide entry
 * out as a flat list of `.entryCell`s (compass hero + one cell per entry) and
 * CSS cannot RE-GROUP the DOM — the user asked for bigger single entries laid
 * out as titled blocks (a block holding several entries, with breathing
 * room), so this module hides the host's own entry list with one injected
 * rule, keeps the compass hero, and portals a `GuideBlocks` component to the
 * END of every guide root (the same portal-replacement pattern as
 * sidebar/start-links.tsx). The tiles are re-grouped from the plugin's OWN
 * registry — the exact same descriptors and filters that
 * native/index.ts `registerNativeSurface` turns into host guide entries — so
 * the blocks always mirror what the stock guide would have listed (an entry
 * disabled in the side-card settings, a `hidden` type, or an external
 * plugin's registration appears/disappears here in step).
 *
 * Block layout (each block is one section with a title row and its own grid):
 * - `workspace`: the files / search / git pages (the workspace-facing doors);
 * - `session & tasks`: the HOST-owned terminal (the plugin registry has no
 *   terminal descriptor — the host owns the right-Sidebar `terminal` kind
 *   outright, so the tile is synthesized: `t('startNewTerminal')` +
 *   `terminalTabIcon` + `terminalShortcutKeys(ctx)`, clicking through the
 *   same `openStartLink('terminal', …)` mounted-gated path as the hero row)
 *   plus the subagent / side chat / history pages;
 * - `plugins & settings`: the settings page plus EVERY other kind — external
 *   plugins' kinds (e.g. `dsh-context`) and any builtin not in the first two
 *   groups. Known kinds click through `openStartLink` (the hero row's exact
 *   open paths); unknown/external kinds click `service.openTab({ type })`.
 *   An empty block renders nothing (the whole section is dropped).
 *
 * Contract boundaries:
 * - only the host's published `data-*` hooks are consumed
 *   (`[data-sidebar-right-guide]` +
 *   `[data-slot='sidebar.right.tab.guide.entry']`); the host's class names
 *   are build-time hashes and are never hardcoded (the same contract as
 *   strip-compression.ts / start-links.tsx). A host rename makes the injected
 *   hide-rule stop matching and the portal render below the stock list —
 *   a harmless degrade, never a broken page.
 * - the hide rule is the ONLY injected CSS (one tagged `data-dsh-guide-blocks`
 *   style in `document.head`), and `:has()` is an enhancement: without it the
 *   rule never matches and the stock entry list stays visible under the
 *   blocks — duplicates, but nothing broken.
 * - every guide root gets its own portal root (a Map keyed by the root
 *   element): the host may render several guide panes, and a replaced root
 *   (SPA navigation, HMR) unmounts its stale portal on the next sync. When
 *   the LAST guide disappears, all portals unmount and the style tag is
 *   removed.
 * - the MutationObserver, every portal root and the style tag are cleaned up
 *   by the returned disposer (ctx.effect — HMR / plugin deactivation).
 */
import { createElement, useEffect, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { terminalTabIcon } from '../builtins/tab-icons.tsx'
import { t } from '../locales.ts'
import type { BetterSidebarService, TabDescriptor } from '../service.ts'
import { openStartLink, terminalShortcutKeys } from '../sidebar/start-links.tsx'
import css from './guide-blocks.module.css'

/** The descriptor whose page identity is the `files`-kind takeover. */
const EDITOR_KIND = 'editor'

/** The takeover kind that carries the editor's guide row (native/index.ts). */
const FILES_KIND = 'files'

/** The host-owned terminal kind: never a plugin descriptor, always synthesized. */
const TERMINAL_KIND = 'terminal'

/** Kinds grouped into the「工作区」block. */
const WORKSPACE_KINDS: ReadonlySet<string> = new Set([FILES_KIND, 'search', 'git'])

/** Registry kinds grouped into the「会话与任务」block (terminal joins synthetically). */
const SESSION_KINDS: ReadonlySet<string> = new Set(['subagent', 'sidechat', 'history'])

/**
 * A registry kind's hero-row entry (`start-links.tsx` openStartLink). Keys are
 * the NATIVE kind strings (what native/index.ts registers and what the host
 * guide would list); values are openStartLink's own link kinds — `git` is the
 * changes page and `subagent` the tasks page there.
 */
const START_LINK_KIND_OF: Readonly<Record<string, Parameters<typeof openStartLink>[0]>> = {
  [FILES_KIND]: 'files',
  search: 'search',
  git: 'changes',
  subagent: 'jobs',
  sidechat: 'sidechat',
  history: 'history',
  webview: 'webview',
  commands: 'commands',
  settings: 'settings',
}

/** One tile's display + action (`kind` anchors `data-dsh-guide-tile`). */
interface GuideTile {
  kind: string
  label: () => string
  /** Hover text — the descriptor's own guide line (omitted when it has none). */
  description?: () => string
  /** Function icons only, mirroring the native registration's `guideIconOf`. */
  icon?: (size: number) => React.ReactNode
  /** Terminal's shortcut hint (the host catalog's unboxed keycaps). */
  keys?: readonly string[]
  open: () => void
}

/** The descriptor's title text, evaluated fresh for the current locale. */
function titleTextOf(descriptor: TabDescriptor): string {
  return typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
}

/** The descriptor's guide description line as a fresh evaluator (or nothing). */
function descriptionOf(descriptor: TabDescriptor): (() => string) | undefined {
  const description = descriptor.description
  return description === undefined ? undefined : () => (typeof description === 'function' ? description() : description)
}

/**
 * The tile glyph: function icons render size-aware (the host guide renders
 * `entry.icon` the same way); ReactNode icons are dropped — exactly the
 * fields `guideIconOf` hands the native registration, so a tile never shows
 * an artwork the stock guide would not.
 */
function iconOf(descriptor: TabDescriptor): ((size: number) => React.ReactNode) | undefined {
  return typeof descriptor.icon === 'function' ? (descriptor.icon as (size: number) => React.ReactNode) : undefined
}

/**
 * Enumerate the guide-VISIBLE descriptors — the plugin registry's current
 * active set under the SAME source and filters that native/index.ts
 * `registerNativeSurface` applies when deciding which descriptors become
 * native tab types with a host guide entry: disabled types are out, a
 * `bottomOnly` type has no native tab at all, a `hidden` type registers
 * without a guide field, and the `editor` descriptor has no guide row of its
 * own (its page identity is the `files`-kind takeover below — same title,
 * description and icon). Sorted by the guide order the host sorts by.
 */
function collectGuideTiles(ctx: Context, service: BetterSidebarService): GuideTile[] {
  const tiles: Array<GuideTile & { order: number }> = []
  for (const descriptor of service.getTabs()) {
    if (!service.isTabEnabled(descriptor.id)) continue
    if (descriptor.bottomOnly === true) continue
    if (descriptor.id === EDITOR_KIND) continue
    if (descriptor.hidden === true) continue
    const kind = descriptor.id
    const description = descriptionOf(descriptor)
    const icon = iconOf(descriptor)
    const startKind = START_LINK_KIND_OF[kind]
    tiles.push({
      kind,
      order: descriptor.order ?? 100,
      label: () => titleTextOf(descriptor),
      ...(description !== undefined ? { description } : {}),
      ...(icon !== undefined ? { icon } : {}),
      open: startKind === undefined
        // External/unknown kind: straight through the service (the same face
        // an external plugin's own UI uses); a disabled type is refused
        // inside, a missing active session returns silently.
        ? () => { service.openTab({ type: kind }) }
        : () => { openStartLink(startKind, ctx, service) },
    })
  }
  // The `files` takeover follows the editor type's switch (wantsFiles in
  // native/index.ts): with the editor disabled the plugin has no explorer to
  // list, so the tile disappears with it.
  if (service.isTabEnabled(EDITOR_KIND)) {
    const editor = service.getTab(EDITOR_KIND)
    const description = editor === undefined ? undefined : descriptionOf(editor)
    const icon = editor === undefined ? undefined : iconOf(editor)
    tiles.push({
      kind: FILES_KIND,
      order: 10,
      label: () => t('files'),
      ...(description !== undefined ? { description } : {}),
      ...(icon !== undefined ? { icon } : {}),
      open: () => { openStartLink('files', ctx, service) },
    })
  }
  tiles.sort((a, b) => a.order - b.order)
  return tiles
}

/** The synthesized「新建终端」tile (the host owns the terminal kind, the
 *  plugin registry has no descriptor for it — hero-row parity). */
function terminalTile(ctx: Context, service: BetterSidebarService): GuideTile {
  const shortcut = terminalShortcutKeys(ctx)
  return {
    kind: TERMINAL_KIND,
    label: () => t('startNewTerminal'),
    icon: terminalTabIcon,
    // The host catalog's keycaps when reachable, the static Ctrl+` fallback
    // otherwise — the same fallback the hero row uses.
    keys: shortcut?.keys ?? ['Ctrl', '`'],
    open: () => { openStartLink('terminal', ctx, service) },
  }
}

/** One block's render shape (`name` anchors `data-dsh-guide-block`). */
interface GuideBlock {
  name: 'workspace' | 'session' | 'more'
  title: string
  tiles: GuideTile[]
}

/**
 * The blocks themselves (portal content): workspace / session & tasks /
 * plugins & settings, each a titled section with its own tile grid. The
 * registry is re-read on every render, and the component subscribes to both
 * the registry (register/dispose) and the state/pref store (the side-card
 * enable switches) so the blocks keep mirroring the stock guide's membership.
 */
function GuideBlocks(props: { ctx: Context; service: BetterSidebarService }) {
  const { ctx, service } = props
  const [, bump] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    const offRegistry = service.subscribe(bump)
    const offPrefs = service.subscribeState(bump)
    return () => { offRegistry(); offPrefs() }
  }, [service, bump])

  const registryTiles = collectGuideTiles(ctx, service)
  const blocks: GuideBlock[] = [
    { name: 'workspace', title: t('guideBlockWorkspace'), tiles: registryTiles.filter(tile => WORKSPACE_KINDS.has(tile.kind)) },
    { name: 'session', title: t('guideBlockSession'), tiles: [terminalTile(ctx, service), ...registryTiles.filter(tile => SESSION_KINDS.has(tile.kind))] },
    { name: 'more', title: t('guideBlockMore'), tiles: registryTiles.filter(tile => !WORKSPACE_KINDS.has(tile.kind) && !SESSION_KINDS.has(tile.kind)) },
  ]
  return (
    <div className={css.container} data-dsh-guide-blocks="">
      {blocks.filter(block => block.tiles.length > 0).map(block => (
        <section key={block.name} data-dsh-guide-block={block.name} className={css.block} aria-label={block.title}>
          <div className={css.blockTitle}>{block.title}</div>
          <div className={css.blockGrid}>
            {block.tiles.map(tile => (
              <button
                key={tile.kind}
                type="button"
                className={css.tile}
                data-dsh-guide-tile={tile.kind}
                {...(tile.description !== undefined ? { title: tile.description() } : {})}
                onClick={tile.open}
              >
                <span className={css.tileIcon} aria-hidden="true">{tile.icon?.(20)}</span>
                <span className={css.tileLabel}>{tile.label()}</span>
                {tile.keys !== undefined && tile.keys.length > 0 && (
                  <ShortcutKeys keys={tile.keys} className={css.tileKeys} />
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/**
 * The injected hide-rule — the ONLY CSS this module adds. It hides the host's
 * own entry CELLS (each carries the guide-entry slot wrapper) while leaving
 * the compass hero (`> span[aria-hidden]`) and this module's own portal host
 * (a `> div` WITHOUT a guide entry inside) visible. Scoped to the host's
 * published data-* hooks: a host rename simply stops matching — the stock
 * list returns and the page degrades harmlessly.
 */
const GUIDE_BLOCKS_CSS = `
[data-sidebar-right-guide] > div:has([data-slot='sidebar.right.tab.guide.entry']) { display: none; }
`

/**
 * Register the guide grouped blocks: watch the document for
 * `[data-sidebar-right-guide]` roots, keep one tagged hide-rule stylesheet in
 * `document.head` while any root exists, and portal one `GuideBlocks` per
 * root (appended to the root's END, after the host's own entry cells). A
 * replaced root unmounts its stale portal; when the last guide disappears all
 * portals unmount and the stylesheet is removed.
 * @param ctx - the client context (terminal shortcut catalog + open faces).
 * @param service - the plugin registry service the tiles enumerate.
 * @returns a disposer disconnecting the observer, unmounting every portal
 *   and removing the stylesheet.
 */
export function registerGuideBlocks(ctx: Context, service: BetterSidebarService): () => void {
  const doc = document
  /** One portal root per guide root element (identity-keyed: a replaced host
   *  root is a NEW element and gets a fresh portal; the stale one unmounts). */
  const portals = new Map<HTMLElement, Root>()
  let styleTag: HTMLStyleElement | undefined

  const ensureStyle = (): void => {
    if (styleTag?.isConnected) return
    const tag = doc.createElement('style')
    // Tagged like the sibling patches: the attribute carries the source
    // identity so the running patch is inspectable in DevTools.
    tag.setAttribute('data-dsh-guide-blocks', '')
    tag.textContent = GUIDE_BLOCKS_CSS
    doc.head.appendChild(tag)
    styleTag = tag
  }

  const removeStyle = (): void => {
    styleTag?.remove()
    styleTag = undefined
  }

  const unmountPortal = (rootElement: HTMLElement): void => {
    const root = portals.get(rootElement)
    if (root === undefined) return
    portals.delete(rootElement)
    try {
      root.unmount()
    } catch {
      // 已脱离的 root：卸载失败不影响后续挂载（start-links.tsx 同款处理）。
    }
  }

  const unmountAll = (): void => {
    for (const rootElement of [...portals.keys()]) unmountPortal(rootElement)
  }

  const sync = (): void => {
    const guideRoots = Array.from(doc.querySelectorAll<HTMLElement>('[data-sidebar-right-guide]'))
    if (guideRoots.length === 0) {
      // guide 全部消失（SPA 导走 / 面板关闭）：收掉全部 portal 与样式标签，
      // 下次 guide 出现时按需重建。
      unmountAll()
      removeStyle()
      return
    }
    ensureStyle()
    // 宿主替换过 guide 根（或根已脱离文档）：旧 portal 一并卸载。
    for (const rootElement of [...portals.keys()]) {
      if (!guideRoots.includes(rootElement)) unmountPortal(rootElement)
    }
    for (const rootElement of guideRoots) {
      if (portals.has(rootElement)) continue
      // 追加到 guide 根**末尾**：藏在原入口列表之后，罗盘 hero 保持在最上。
      const host = doc.createElement('div')
      host.setAttribute('data-dsh-guide-blocks-host', '')
      // 宿主 guide 根是 column + center 的 flex 容器：无宽度样式的 flex 项会
      // 收缩成 fit-content（≈最宽子元素），.container 的 width:100% 只解析到
      // 百来 px，minmax 网格永远只出一轨。显式撑满 flex 根修掉收缩根因。
      host.style.width = '100%'
      // .module.css 的 @container 按**最近的容器查询锚**取尺寸：host 自身设
      // inline-size 容器（只约束行内尺寸、不影响高度生长），分块网格的
      // 跨行分档才有正确的查询宽度。
      host.style.setProperty('container-type', 'inline-size')
      rootElement.appendChild(host)
      const root = createRoot(host)
      root.render(createElement(GuideBlocks, { ctx, service }))
      portals.set(rootElement, root)
    }
  }

  const observer = new MutationObserver(sync)
  observer.observe(doc.documentElement, {
    childList: true,
    subtree: true,
  })
  sync()
  return () => {
    observer.disconnect()
    unmountAll()
    removeStyle()
  }
}
