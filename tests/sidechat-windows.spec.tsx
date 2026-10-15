/**
 * The popped-out side conversations: the floating-window layer.
 *
 * Covered here: the window store (open/close/has, dedupe per thread, the
 * open-order slot that drives the cascade), the layer rendering ONE
 * FloatingWindow per open thread with the thread's live transcript inside,
 * multi-open (two threads → two windows at once), the composer bar's pop-out
 * button, and the dock-back gesture — 收回侧栏 takes the window down and
 * focuses the sidebar tab still bound to the thread.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SidechatWindows } from '../src/client/SidechatWindows.tsx'
import { SideChatView } from '../src/client/SideChatView.tsx'
import { sidechatWindows } from '../src/client/sidechat-windows.ts'
import { createSidebarStore, openTabInBottomPane, type SidebarStore } from '../src/client/state.ts'
import { attachLocale } from '../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarTab } from '../src/client/state.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  readonly active = 'zh'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
  register(_ns: string, _locale: string, _dict: Record<string, string>): () => void {
    return () => {}
  }
}

/** The thread log the sidechat.events stub serves (one settled answer). */
const EVENTS = [
  { type: 'session/end-seed', seq: 0, time: 0, data: {} },
  { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  {
    type: 'assistant/message',
    seq: 2,
    time: 2_000,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } },
  },
]

/** The smallest WebSocket the view's push hook talks to (never a real one). */
class FakeSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  readyState = FakeSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send(_frame: string): void {}
  close(): void { this.readyState = 3 }
}

/** A sessions-list snapshot with the two side threads bound to 'root'. */
function threadStore(): SidebarSessionList {
  return {
    byId: {
      root: { id: 'root', displayTitle: '主会话', running: false },
      t1: { id: 't1', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
      t2: { id: 't2', displayTitle: 'Side: 线程二', origin: 'subagent', parentId: 'root', running: false },
    },
  } as SidebarSessionList
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

/** A subscribable sessions-list snapshot (the feed SideChatView subscribes to). */
function makeSessionsStore(list: SidebarSessionList): { getSnapshot(): SidebarSessionList; subscribe(fn: () => void): () => void } {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => list,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
  }
}

/** The client context face the window layer touches (everything inert). */
function makeCtx(): Context {
  return { sessions: { list: makeSessionsStore(threadStore()) }, get: () => undefined } as unknown as Context
}

/** The sidebar store with one session and one sidechat tab (thread t1) docked. */
function makeSidebarStore(): SidebarStore {
  const store = createSidebarStore()
  store.setSession('root')
  const tab: SidebarTab = { id: 'sidechat:t1', type: 'sidechat', title: '线程一', meta: { threadId: 't1' } }
  store.reduce(state => openTabInBottomPane(state, tab))
  return store
}

const floatingWindows = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[data-floating-window]')]

beforeEach(() => {
  attachLocale(new FakeLocale())
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const method = String(url).split('/').pop()
    if (method === 'sidechat.events') {
      return jsonResponse({ ok: true, value: { events: EVENTS, live: [], pending: [] } })
    }
    if (method === 'sidechat.info') return jsonResponse({ ok: true, value: { live: false, provider: 'deepseek', preset: 'side' } })
    if (method === 'sidechat.models') return jsonResponse({ ok: true, value: { available: false, groups: [], failures: [] } })
    return jsonResponse({ ok: true, value: {} })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  attachLocale(undefined)
  // The store is module state: every test starts with no windows open.
  for (const record of [...sidechatWindows.getSnapshot()]) sidechatWindows.close(record.threadId)
})

describe('sidechat window store', () => {
  it('opens, dedupes per thread, and frees the slot on close', () => {
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    expect(sidechatWindows.getSnapshot()).toHaveLength(1)
    expect(sidechatWindows.has('t1')).toBe(true)

    sidechatWindows.open({ threadId: 't2', sessionId: 'root', cwd: '/p', title: '线程二' })
    expect(sidechatWindows.getSnapshot().map(record => record.slot)).toEqual([0, 1])

    sidechatWindows.close('t1')
    expect(sidechatWindows.has('t1')).toBe(false)
    expect(sidechatWindows.has('t2')).toBe(true)
  })
})

describe('SidechatWindows layer', () => {
  it('renders one floating window per open thread, with the thread transcript inside', async () => {
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    const { container, unmount } = renderRoot(createElement(SidechatWindows, { ctx: makeCtx(), store: makeSidebarStore() }))
    await act(async () => {})  // flush the window view's transcript pull

    const windows = floatingWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.getAttribute('aria-label')).toBe('线程一')
    // The window body IS the side chat: the settled answer renders there.
    expect(document.body.textContent ?? '').toContain('done')
    expect(container.textContent).toBe('')
    unmount()
  })

  it('multi-open: two threads render two windows at once, cascaded by slot', async () => {
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    sidechatWindows.open({ threadId: 't2', sessionId: 'root', cwd: '/p', title: '线程二' })
    const { unmount } = renderRoot(createElement(SidechatWindows, { ctx: makeCtx(), store: makeSidebarStore() }))
    await act(async () => {})

    expect(floatingWindows()).toHaveLength(2)
    expect(floatingWindows().map(node => node.getAttribute('aria-label'))).toEqual(['线程一', '线程二'])
    unmount()
  })

  it('the title-bar ✕ closes just that window (the thread stays out of it)', async () => {
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    sidechatWindows.open({ threadId: 't2', sessionId: 'root', cwd: '/p', title: '线程二' })
    const { unmount } = renderRoot(createElement(SidechatWindows, { ctx: makeCtx(), store: makeSidebarStore() }))
    await act(async () => {})

    const first = floatingWindows()[0]
    if (first === undefined) throw new Error('the first window must render')
    const close = first.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
    if (close === null) throw new Error('the close button must render')
    await act(async () => { close.click() })

    expect(floatingWindows()).toHaveLength(1)
    expect(floatingWindows()[0]?.getAttribute('aria-label')).toBe('线程二')
    unmount()
  })

  it('收回侧栏 closes the window and activates the sidebar tab bound to the thread', async () => {
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    const store = makeSidebarStore()
    const { unmount } = renderRoot(createElement(SidechatWindows, { ctx: makeCtx(), store }))
    await act(async () => {})

    const dock = document.body.querySelector<HTMLButtonElement>('button[aria-label="收回侧栏"]')
    if (dock === null) throw new Error('the dock-back button must render')
    await act(async () => { dock.click() })

    expect(floatingWindows()).toHaveLength(0)
    const state = store.getSnapshot().state
    expect(state?.activePane).not.toBeNull()
    const pane = state?.bottomSplits
    // The docked tab is now its pane's active tab.
    const walk = (node: typeof pane): string | null => {
      if (node === undefined) return null
      if (node.kind === 'leaf') return node.active
      for (const child of node.children) {
        const found = walk(child)
        if (found !== null) return found
      }
      return null
    }
    expect(walk(pane)).toBe('sidechat:t1')
    unmount()
  })
})

describe('SideChatView pop-out button', () => {
  it('pops the bound thread out from the composer bar', async () => {
    const tab: SidebarTab = { id: 'tab1', type: 'sidechat', title: '线程一', meta: { threadId: 't1' } }
    const props = { ctx: makeCtx(), scope: { sessionId: 'root', cwd: '/p' }, tab, visible: true }
    // The view AND the window layer, as the sidebar root mounts them.
    const { container, unmount } = renderRoot(createElement(
      'div',
      null,
      createElement(SideChatView, props),
      createElement(SidechatWindows, { ctx: makeCtx(), store: makeSidebarStore() }),
    ))
    await act(async () => {})  // flush the transcript pull

    const pop = container.querySelector<HTMLButtonElement>('button[aria-label="弹出为浮窗（可与侧栏并存，可多开）"]')
    if (pop === null) throw new Error('the pop-out button must render')
    await act(async () => { pop.click() })

    expect(sidechatWindows.has('t1')).toBe(true)
    expect(floatingWindows()).toHaveLength(1)
    unmount()
  })

  it('offers dock-back instead of pop-out while floating', async () => {
    sidechatWindows.open({ threadId: 't1', sessionId: 'root', cwd: '/p', title: '线程一' })
    const tab: SidebarTab = { id: 'tab1', type: 'sidechat', title: '线程一', meta: { threadId: 't1' } }
    const props = {
      ctx: makeCtx(),
      scope: { sessionId: 'root', cwd: '/p' },
      tab,
      visible: true,
      floating: true,
      onDockBack: () => { sidechatWindows.close('t1') },
    }
    const { container, unmount } = renderRoot(createElement(SideChatView, props))
    await act(async () => {})

    expect(container.querySelector('button[aria-label="弹出为浮窗（可与侧栏并存，可多开）"]')).toBeNull()
    const dock = container.querySelector<HTMLButtonElement>('button[aria-label="收回侧栏"]')
    if (dock === null) throw new Error('the dock-back button must render')
    await act(async () => { dock.click() })
    expect(sidechatWindows.has('t1')).toBe(false)
    unmount()
  })
})
