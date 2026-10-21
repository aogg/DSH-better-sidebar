/**
 * The tab strip of one pane: tabs capped at TAB_MAX_WIDTH (ellipsized),
 * overflow scrolls horizontally, a close button per tab, a four-way split
 * button cluster, and the + menu that opens new tabs (explorer / git). Tabs
 * are draggable; dropping onto another tab inserts before it, dropping on the
 * strip background appends to this pane. Right-clicking a tab opens the tab
 * context menu (close / close others / close to the left / close to the
 * right / close all — every close scoped to this pane — copy the
 * right-clicked tab's file as a session-cwd-relative or absolute path, both
 * rows greyed out for a tab without a file — plus reveal the right-clicked
 * tab's file in the OS file manager).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCloseFillRegular, IconCopyOutlineRegular, IconPlusOutlineRegular, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTab } from './state.ts'
import { t } from './locales.ts'
import { relativeTo } from './paths.ts'
import { useTabLoading } from './tab-loading.ts'
import css from './sidebar.module.css'

/** One + menu option. */
export interface NewTabOption {
  id: string
  label: string
  disabled?: boolean
  /** Leading icon (Menu row). */
  icon?: ReactNode
}

/** Drag payload for tab moves (HTML5 DnD dataTransfer). */
export const TAB_DRAG_TYPE = 'application/x-dsh-tab'

export interface TabDragPayload {
  tabId: string
  paneId: string
}

export function serializeDrag(payload: TabDragPayload): string {
  return JSON.stringify(payload)
}

export function parseDrag(raw: string): TabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as TabDragPayload
    if (typeof parsed.tabId === 'string' && typeof parsed.paneId === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/** Global tab-drag flag: PDF iframes become non-interactive synchronously. */
function setTabDragging(active: boolean): void {
  if (active) document.body.setAttribute('data-dsh-tab-dragging', '')
  else document.body.removeAttribute('data-dsh-tab-dragging')
}

/**
 * One chip of the strip: the draggable / closable row. Extracted from
 * TabBar's map because the loading flag is a per-tab subscription
 * ({@link useTabLoading}) and a hook may not be called inside a loop or
 * conditionally — the chip calls it at its top level instead.
 *
 * Deliberately not `memo`-wrapped: its callback props are fresh closures of
 * the strip's render, so memoization could never bail out, and the
 * confinement the loading mark needs is already delivered by the
 * per-entry subscription — a load starting or settling re-renders only THAT
 * chip (the strip itself does not subscribe; the boolean snapshot lets every
 * other chip's `useSyncExternalStore` bail out), never the whole row set.
 */
function TabChip(props: {
  tab: SidebarTab
  active: boolean
  paneId: string
  /** The owning session (see TabBar's `sessionId`); absent → never loading. */
  sessionId: string | undefined
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  /** Drop of a tab ONTO this chip: (payload, insertBeforeTabId = this tab). */
  onDropTab: (payload: TabDragPayload, before: string | null) => void
  /** The right-click context menu opening on this chip (TabBar owns the
   *  menu state; opening it also dismisses the + menu there). */
  onTabMenu: (target: { tabId: string; x: number; y: number }) => void
  /** Middle mouse-down on this chip: TabBar records the press target and
   *  settles the close on the matching window-level mouseup. */
  onMiddlePress: (tabId: string, node: HTMLElement) => void
  /** A drag that started on this chip ended (or was cancelled): the strip's
   *  drag flags clear along with its drop overlay. */
  onDragEnded: () => void
  getTabIcon?: (tab: SidebarTab) => ReactNode
  getTabBadge?: (tab: SidebarTab) => ReactNode
  isTabUnread?: (tab: SidebarTab) => boolean
}) {
  const {
    tab, active, paneId, sessionId, onActivate, onClose, onDropTab, onTabMenu, onMiddlePress, onDragEnded,
    getTabIcon, getTabBadge, isTabUnread,
  } = props
  // This tab's read-in-flight flag (a file read, a page's first pull —
  // whoever reports it; see tab-loading.ts). While it holds, the spinner
  // REPLACES the leading icon — the favicon→spinner slot a browser tab uses.
  const loading = useTabLoading(sessionId, tab.id)
  return (
    <div
      className={clsx(css.tab, active && css.tabActive)}
      title={tab.title}
      draggable
      onDragStart={(event) => {
        setTabDragging(true)
        event.dataTransfer.setData(TAB_DRAG_TYPE, serializeDrag({ tabId: tab.id, paneId }))
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={onDragEnded}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, tab.id)
      }}
      onClick={() => { onActivate(tab.id) }}
      onMouseDown={(event) => {
        // Middle-click close: record the press target and disarm Chrome's
        // middle-click autoscroll (its indicator is inert here — the strip
        // scrolls via the wheel handler only). The close itself settles on
        // the first middle mouseup over this same tab (window-level), keeping
        // release semantics.
        if (event.button === 1) {
          event.preventDefault()
          onMiddlePress(tab.id, event.currentTarget)
        }
      }}
      onContextMenu={(event) => {
        // Take over the browser menu: the tab context menu offers the close
        // operations for this pane.
        event.preventDefault()
        onTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
      }}
    >
      {loading
        ? (
          <span
            className={css.tabLoading}
            role="img"
            aria-label={t('tabLoading')}
            title={t('tabLoading')}
          />
        )
        : getTabIcon?.(tab) ?? null}
      {getTabBadge?.(tab) ?? null}
      <span className={css.tabTitle}>{tab.title}</span>
      {isTabUnread?.(tab) === true
        ? (
          <span
            className={css.tabUnreadDot}
            role="img"
            aria-label={t('tabUnread')}
            title={t('tabUnread')}
          />
        )
        : null}
      <button
        type="button"
        className={css.tabClose}
        aria-label={t('close')}
        onClick={(event) => {
          event.stopPropagation()
          onClose(tab.id)
        }}
      >
        <IconCloseFillRegular size={14} />
      </button>
    </div>
  )
}

export function TabBar(props: {
  paneId: string
  tabs: SidebarTab[]
  active: string | null
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onNewTab: (optionId: string) => void
  newTabOptions: NewTabOption[]
  /** Drop of a tab from any pane: (payload, insertBeforeTabId | null). */
  onDropTab: (payload: TabDragPayload, before: string | null) => void
  /** Icon resolver for tab labels (reads from the tab descriptor registry). */
  getTabIcon?: (tab: SidebarTab) => ReactNode
  /** Badge resolver for tab labels (reads the descriptor's `badge`; the
   *  resolver returns the rendered pill or null). */
  getTabBadge?: (tab: SidebarTab) => ReactNode
  /**
   * Unread resolver for tab labels: the page has something the reader has not
   * looked at yet (a background activation opened it without taking the column
   * over). Rendered as a small dot beside the label; `false`/undefined draws
   * nothing, so a strip with no marks is byte-identical to one that never had
   * the feature.
   */
  isTabUnread?: (tab: SidebarTab) => boolean
  /**
   * Right-aligned action area resolver for the active tab: returns a
   * ReactNode rendered at the tab strip's right end (between the + button
   * and the panel's close control), or null/undefined for none. Lets a
   * descriptor (e.g. a terminal tab) inject its own toolbar (new / split /
   * restart) directly into the strip instead of a separate header row.
   * Receives the strip's `paneId` alongside the active tab so the resolver
   * can tell WHICH instance's strip it is decorating (split panes each
   * render their own).
   */
  getTabRightActions?: (tab: SidebarTab, paneId: string) => ReactNode
  /**
   * Reveal one tab's associated file in the OS file manager — the tab
   * context menu's reveal row, fed by the shell with the host's open-in-app
   * capability. The row is disabled for a tab with no associated file (no
   * `path`, e.g. the changes / tasks / side-chat / diff pages) and when the
   * shell passes no resolver at all.
   */
  onRevealInFileManager?: (path: string) => void
  /**
   * The session cwd the tab context menu's copy-relative row projects the
   * right-clicked tab's file against (FileTree's `relativeTo(cwd, path)`
   * semantics; the shell feeds the same `useSessionRoot` value the
   * explorer/git rows use). Absent → the relative copy still runs with the
   * FileTree fallback. Both copy rows stay disabled for a tab with no
   * associated file, like the reveal row.
   */
  tabMenuCwd?: string
  /**
   * The session this strip's tabs belong to: the scope the tab-loading
   * registry is read under, so a chip can swap its leading icon for a
   * spinner while its page's first load runs (the favicon→spinner slot a
   * browser tab uses; see tab-loading.ts). A tab id is unique only WITHIN a
   * session, so the flag is meaningless without the seat — absent (the
   * native right rail renders its own chip chrome) → no strip ever shows a
   * spinner and every tab renders exactly as before this prop existed.
   */
  sessionId?: string
}) {
  const {
    paneId, tabs, active, onActivate, onClose, onNewTab, newTabOptions, onDropTab, getTabIcon, getTabBadge, getTabRightActions,
    isTabUnread,
    onRevealInFileManager,
    tabMenuCwd,
    sessionId,
  } = props
  const [menuOpen, setMenuOpen] = useState(false)
  // The tab right-click context menu: the target tab plus the cursor
  // position (the portaled Menu anchors there, following the git lens/FileTree).
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // The context target's index in the render-time tab snapshot; -1 when the
  // tab disappeared since the menu opened (the menu hides then).
  const tabMenuIndex = tabMenu === null ? -1 : tabs.findIndex(tab => tab.id === tabMenu.tabId)
  // The context target's associated file: `path` carries it for file tabs
  // (editor windows, folder windows included). The changes / tasks /
  // side-chat / diff pages have none — a diff's repo-relative ref is not a
  // path the host could reveal — so the reveal row greys out for them.
  const tabMenuPath = tabs[tabMenuIndex]?.path
  const canReveal = onRevealInFileManager !== undefined && tabMenuPath !== undefined && tabMenuPath !== ''
  // The copy rows share the reveal row's "has a file" rule (the changes /
  // tasks / side-chat / diff pages copy nothing); unlike the reveal row they
  // do not depend on a resolver — a missing cwd just falls back inside
  // `relativeTo` below.
  const canCopyPath = tabMenuPath !== undefined && tabMenuPath !== ''

  // The active tab's right-actions node, resolved up front so the render
  // below can skip the wrapper entirely when there is nothing to show (an
  // empty wrapper is a flex item and would still affect the strip layout).
  // `false` is treated like null: React renders it as nothing anyway.
  const activeRightTab = tabs.find(tab => tab.id === active)
  const rightActions = getTabRightActions !== undefined && activeRightTab !== undefined
    ? getTabRightActions(activeRightTab, paneId)
    : null
  const hasRightActions = rightActions !== null && rightActions !== undefined && rightActions !== false

  // Middle-click close: the press target is recorded on middle mousedown
  // (preventDefaulted to disarm Chrome's middle-click autoscroll — its
  // indicator is inert here because the strip hides its scrollbar and only
  // the wheel handler scrolls) and the close settles on the first middle
  // mouseup OVER that same tab. Release-position semantics match VS Code
  // (microsoft/vscode#101028) and what users expect from Chrome tabs
  // (crbug/40679924): pressing on a tab and releasing elsewhere cancels the
  // close. The browser dispatches auxclick to the nearest common ancestor of
  // the press/release targets when they differ, so any drift, autoscroll
  // scroll, or tab-list reflow between press and release would otherwise
  // swallow the close; settling on the recorded press target at mouseup
  // keeps release semantics without depending on auxclick delivery.
  const onCloseRef = useRef(onClose)
  const middlePressed = useRef<{ id: string; node: HTMLElement } | null>(null)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 1) return
      const pressed = middlePressed.current
      middlePressed.current = null
      // Close only when the release lands on the pressed tab; a drag-away
      // release cancels the press (one-shot per press).
      if (pressed !== null && pressed.node.isConnected && pressed.node.contains(event.target as Node)) {
        onCloseRef.current(pressed.id)
      }
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => { window.removeEventListener('mouseup', onMouseUp) }
  }, [])

  // Wheel over the strip scrolls the tab row horizontally (a plain mouse
  // wheel emits deltaY, which overflow-x alone never consumes). Bound as a
  // native NON-passive listener: React registers onWheel passively at the
  // root, where preventDefault() is a no-op. Modifier keys keep their native
  // meaning (shift = horizontal scroll, ctrl/cmd = zoom), and a strip that
  // does not overflow leaves the event alone so the page scrolls normally.
  useEffect(() => {
    const el = listRef.current
    if (el === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
      if (el.scrollWidth <= el.clientWidth) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
      el.scrollLeft += (event.deltaX + event.deltaY) * unit
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  useEffect(() => {
    const clear = (): void => { setTabDragging(false); setDragOver(false) }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return (
    <div
      className={clsx(css.tabBar, dragOver && css.tabBarDrop)}
      onDragOver={(event) => {
        // The strip owns drops on itself (merge into this pane); stopping
        // propagation keeps the pane root from also running its edge-zone
        // handler on the same drop.
        event.preventDefault()
        event.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={() => { setDragOver(false) }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        setTabDragging(false)
        const raw = event.dataTransfer.getData(TAB_DRAG_TYPE)
        const payload = parseDrag(raw)
        if (payload !== null) onDropTab(payload, null)
      }}
    >
      <div ref={listRef} className={css.tabList}>
        {tabs.map(tab => (
          <TabChip
            key={tab.id}
            tab={tab}
            active={active === tab.id}
            paneId={paneId}
            sessionId={sessionId}
            onActivate={onActivate}
            onClose={onClose}
            onDropTab={onDropTab}
            onTabMenu={(target) => {
              // Opening the tab context menu dismisses the + menu (only one
              // menu at a time); the menu state itself stays here.
              setMenuOpen(false)
              setTabMenu(target)
            }}
            onMiddlePress={(id, node) => { middlePressed.current = { id, node } }}
            onDragEnded={() => { setTabDragging(false); setDragOver(false) }}
            getTabIcon={getTabIcon}
            getTabBadge={getTabBadge}
            isTabUnread={isTabUnread}
          />
        ))}
        {/*
          The + sits immediately after the rightmost tab (sticky at the
          right edge of the scrollport when the tabs overflow, so it stays
          reachable no matter how many tabs are open).
        */}
        <Menu
          open={menuOpen}
          onClose={() => { setMenuOpen(false) }}
          items={newTabOptions.map(option => ({
            id: option.id,
            label: option.label,
            ...(option.disabled === true ? { disabled: true } : {}),
            ...(option.icon !== undefined ? { icon: option.icon } : {}),
          }))}
          onSelect={(id) => {
            onNewTab(id)
            setMenuOpen(false)
          }}
          portal
          compact
          align="end"
          anchor={(
            <button
              type="button"
              className={css.tabBarPlus}
              aria-label={t('newTab')}
              title={t('newTab')}
              onClick={() => { setMenuOpen(v => !v); setTabMenu(null) }}
            >
              <IconPlusOutlineRegular />
            </button>
          )}
        />
        {/*
          The tab context menu, positioned at the right-click cursor (portal
          so the panel's overflow clip cannot crop it). Close operations are
          scoped to THIS pane: "close others/left/right/all" walk the
          render-time tab snapshot and reuse the per-tab onClose path (which
          routes through the service), so every closed tab runs its own
          lifecycle and the target tab is only closed by the operations that
          mean it (close / close all). "Close all" is always available: the
          menu only opens from a tab, so the pane always holds at least one.
        */}
        <Menu
          open={tabMenu !== null && tabMenuIndex >= 0}
          onClose={() => { setTabMenu(null) }}
          items={[
            { id: 'close', label: t('close') },
            { id: 'closeOthers', label: t('closeOtherTabs'), ...(tabs.length <= 1 ? { disabled: true } : {}) },
            { id: 'closeLeft', label: t('closeLeftTabs'), ...(tabMenuIndex <= 0 ? { disabled: true } : {}) },
            { id: 'closeRight', label: t('closeRightTabs'), ...(tabMenuIndex >= tabs.length - 1 ? { disabled: true } : {}) },
            { id: 'closeAll', label: t('closeAllTabs') },
            // The FileTree/git-lens copy pair, aimed at the right-clicked
            // tab's file: relative to the session cwd, or the absolute path.
            { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} />, ...(canCopyPath ? {} : { disabled: true }) },
            { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} />, ...(canCopyPath ? {} : { disabled: true }) },
            { id: 'revealInFileManager', label: t('revealTabInFileManager'), ...(canReveal ? {} : { disabled: true }) },
          ]}
          onSelect={(id) => {
            const target = tabMenu
            if (target === null) return
            setTabMenu(null)
            const index = tabs.findIndex(tab => tab.id === target.tabId)
            if (index < 0) return
            if (id === 'close') {
              onClose(target.tabId)
            } else if (id === 'closeOthers') {
              for (const tab of tabs) {
                if (tab.id !== target.tabId) onClose(tab.id)
              }
            } else if (id === 'closeLeft') {
              for (const tab of tabs.slice(0, index)) onClose(tab.id)
            } else if (id === 'closeRight') {
              for (const tab of tabs.slice(index + 1)) onClose(tab.id)
            } else if (id === 'closeAll') {
              // EVERY tab in this pane, the right-clicked one included (that
              // is what separates it from "close others") and the ones
              // scrolled out of the strip's viewport included.
              for (const tab of tabs) onClose(tab.id)
            } else if (id === 'relative') {
              // Disabled without a file, so the guard only covers a target
              // that vanished mid-menu; `relativeTo(cwd ?? '', …)` is
              // FileTree's own copy-relative projection.
              if (tabMenuPath !== undefined && tabMenuPath !== '') {
                void writeClipboard(relativeTo(tabMenuCwd ?? '', tabMenuPath))
              }
            } else if (id === 'absolute') {
              if (tabMenuPath !== undefined && tabMenuPath !== '') void writeClipboard(tabMenuPath)
            } else if (id === 'revealInFileManager') {
              const path = tabs[index]?.path
              if (path !== undefined && path !== '') onRevealInFileManager?.(path)
            }
          }}
          portal
          compact
          align="start"
          getAnchorRect={() => (tabMenu === null ? null : new DOMRect(tabMenu.x, tabMenu.y, 0, 0))}
          anchor={<span />}
        />
      </div>
      {/*
        The active tab's right-aligned action area: rendered at the tab
        strip's right end (after the + menu, before the panel's close
        control). A descriptor that declares `rightActions` supplies its own
        toolbar here (e.g. a terminal tab's new / split / restart buttons),
        so the page's controls live in the strip instead of a separate header
        row below it. The node is resolved BEFORE the wrapper is created: a
        resolver returning null/undefined (or false) must leave the strip
        exactly as it was — an empty flex item would still take part in the
        strip's layout and change every existing tab bar.
      */}
      {hasRightActions ? <div className={css.tabBarRightActions}>{rightActions}</div> : null}
    </div>
  )
}
