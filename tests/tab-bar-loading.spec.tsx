/**
 * The tab strip's loading mark (TabBar's `sessionId` prop + the tab-loading
 * registry): a tab whose page reported a load renders the spinner INSTEAD of
 * its leading icon (the favicon→spinner slot a browser tab uses), the mark
 * goes when the load settles, a strip without a `sessionId` (the native right
 * rail's shape) never shows one, and the Workbench forwards the session
 * through the split tree so every pane's strip can show it.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TabBar } from '../src/client/TabBar.tsx'
import { Workbench, type WorkbenchActions } from '../src/client/split-pane.tsx'
import { clearTabLoading, setTabLoading } from '../src/client/tab-loading.ts'
import type { SidebarState, SidebarTab, SplitNode } from '../src/client/state.ts'

/** The strip's loading marks (empty while no tab is loading). */
function spinnerEls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[class*="tabLoading"]')]
}

function twoTabs(): SidebarTab[] {
  return [
    { id: 't1', type: 'demo:tool', title: 'Tool 1' },
    { id: 't2', type: 'demo:tool', title: 'Tool 2' },
  ]
}

/** A resolver the icon assertions can pin: each tab's icon is identifiable. */
function iconFor(tab: SidebarTab): ReactNode {
  return createElement('span', { 'data-testid': `icon-${tab.id}` }, 'icon')
}

function mountBar(opts: {
  tabs: SidebarTab[]
  active: string | null
  sessionId?: string
}): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(TabBar, {
      paneId: 'pane:1',
      tabs: opts.tabs,
      active: opts.active,
      onActivate: () => {},
      onClose: () => {},
      onNewTab: () => {},
      newTabOptions: [],
      onDropTab: () => {},
      getTabIcon: iconFor,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    }))
  })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  for (const id of ['t1', 't2']) clearTabLoading(id)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('TabBar loading mark', () => {
  it('a loading tab shows the spinner INSTEAD of its icon; the other tabs keep theirs', () => {
    act(() => { setTabLoading('t1', true, 's1') })
    const { container, unmount } = mountBar({ tabs: twoTabs(), active: 't1', sessionId: 's1' })
    try {
      const spinners = spinnerEls(container)
      expect(spinners).toHaveLength(1)
      // The mark replaces the leading icon (the favicon→spinner slot), and
      // it carries its own copy (the UnreadDot convention).
      expect(container.querySelector('[data-testid="icon-t1"]')).toBeNull()
      expect(spinners[0]!.getAttribute('aria-label')).toBe('Loading')
      expect(spinners[0]!.getAttribute('title')).toBe('Loading')
      // The unflagged sibling keeps its icon.
      expect(container.querySelector('[data-testid="icon-t2"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('clears the mark when the load settles and restores the icon', () => {
    act(() => { setTabLoading('t1', true, 's1') })
    const { container, unmount } = mountBar({ tabs: twoTabs(), active: 't1', sessionId: 's1' })
    try {
      expect(spinnerEls(container)).toHaveLength(1)
      act(() => { setTabLoading('t1', false, 's1') })
      expect(spinnerEls(container)).toHaveLength(0)
      expect(container.querySelector('[data-testid="icon-t1"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('never shows a spinner without the sessionId prop (the pre-feature strips)', () => {
    act(() => { setTabLoading('t1', true, 's1') })
    const { container, unmount } = mountBar({ tabs: twoTabs(), active: 't1' })
    try {
      expect(spinnerEls(container)).toHaveLength(0)
      expect(container.querySelector('[data-testid="icon-t1"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })
})

/** No-op workbench actions: these tests never interact with the panes. */
function stubActions(): WorkbenchActions {
  return {
    closeTab: () => {},
    activateTab: () => {},
    focusPane: () => {},
    moveTabToEdge: () => {},
    moveTabBefore: () => {},
    resizeSplit: () => {},
  }
}

describe('Workbench sessionId forwarding', () => {
  it('the pane strip reads the loading mark under the forwarded session', () => {
    const state: SidebarState = {
      activePane: 'p1',
      nextBrowser: 1,
      expanded: [],
      revealed: [],
      refreshingTabs: [],
      unread: [],
      bottomOpen: true,
      bottomHeight: 220,
      bottomSplits: {
        kind: 'leaf',
        id: 'p1',
        tabs: [{ id: 'a1', type: 'demo:tool', title: 'A' }],
        active: 'a1',
      } satisfies SplitNode,
    }
    act(() => { setTabLoading('a1', true, 'seat-1') })
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(createElement(Workbench, {
        state,
        newTabOptions: [],
        actions: stubActions(),
        onNewTab: () => {},
        renderTab: (tab: SidebarTab) => createElement('div', null, tab.title),
        getTabIcon: iconFor,
        sessionId: 'seat-1',
      }))
    })
    try {
      expect(spinnerEls(container)).toHaveLength(1)
      expect(container.querySelector('[data-testid="icon-a1"]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
