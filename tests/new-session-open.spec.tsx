/**
 * 新会话自动展开右栏（src/client/sidebar/new-session-open.ts）。
 *
 * 钉住：基线只装一次（页面加载恢复的旧会话永不触发）、新 id 命中且上屏时经
 * 宿主 face（isExpanded/toggleExpanded）展开、已展开不动、配置关闭不动作、
 * 子代理系的行不算新会话、座位未切时唯一一次短延迟重试、face 缺席时对可见的
 * `[data-sidebar-right-expand]` 派发 click。
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { expandRightbar, NEW_SESSION_MOUNT_RETRY_MS, useRightbarOpenOnNewSession } from '../src/client/sidebar/new-session-open.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

interface FaceOptions {
  mounted: { current: string | undefined }
  isExpanded?: () => boolean
  toggleExpanded?: () => void
}

function makeCtx(options: FaceOptions): Context {
  const sidebarRight = {
    mounted: {
      getSnapshot: () => options.mounted.current,
      subscribe: (_fn: () => void) => () => {},
    },
    ...(options.isExpanded !== undefined && options.toggleExpanded !== undefined
      ? { isExpanded: options.isExpanded, toggleExpanded: options.toggleExpanded }
      : {}),
  }
  return {
    get: (name: string) => (name === 'sidebarRight' ? sidebarRight : undefined),
  } as unknown as Context
}

function list(...ids: string[]): SidebarSessionList {
  return {
    byId: Object.fromEntries(ids.map(id => [id, { id, displayTitle: `S ${id}` }])),
  }
}

function listWithRow(row: Record<string, unknown>): SidebarSessionList {
  return { byId: { s1: { id: 's1', displayTitle: 'S s1' }, ...row } as SidebarSessionList['byId'] }
}

/** 挂一个可反复喂列表快照的 harness（初始快照即基线，等价页面加载首帧）。 */
function harness(ctx: Context, store: SidebarStore, initial: SidebarSessionList): { feed: (next: SidebarSessionList) => void; unmount: () => void } {
  let current: SidebarSessionList = initial
  function Hook(): null {
    useRightbarOpenOnNewSession(ctx, store, current)
    return null
  }
  const view = renderRoot(createElement(Hook))
  return {
    feed: (next) => {
      current = next
      act(() => { view.rerender(createElement(Hook)) })
    },
    unmount: view.unmount,
  }
}

afterEach(() => {
  for (const node of document.querySelectorAll('[data-sidebar-right-expand]')) node.remove()
})

describe('expandRightbar（展开动作）', () => {
  it('face 动词优先：收起时 toggleExpanded，已展开时不动', () => {
    const toggleExpanded = vi.fn()
    const expandedCtx = makeCtx({
      mounted: { current: 's1' },
      isExpanded: () => true,
      toggleExpanded,
    })
    expect(expandRightbar(expandedCtx)).toBe(false)
    expect(toggleExpanded).not.toHaveBeenCalled()
    const collapsedCtx = makeCtx({
      mounted: { current: 's1' },
      isExpanded: () => false,
      toggleExpanded,
    })
    expect(expandRightbar(collapsedCtx)).toBe(true)
    expect(toggleExpanded).toHaveBeenCalledOnce()
  })

  it('face 缺席时对可见的 expand 控件派发 click；不可见/缺席则不动', () => {
    const button = document.createElement('button')
    button.setAttribute('data-sidebar-right-expand', 'true')
    button.getBoundingClientRect = () => ({
      width: 28, height: 28, x: 10, y: 10, left: 10, top: 10, right: 38, bottom: 38,
      toJSON: () => ({}),
    }) as DOMRect
    document.body.appendChild(button)
    const clicks: Event[] = []
    button.addEventListener('click', event => { clicks.push(event) })
    // face 抛错（宿主无在屏会话时的契约行为）→ DOM 兜底。
    const throwingCtx = {
      get: () => { throw new Error('no session on screen') },
    } as unknown as Context
    expect(expandRightbar(throwingCtx)).toBe(true)
    expect(clicks).toHaveLength(1)
    // 控件不可见（零盒子）：不点。
    button.getBoundingClientRect = () => ({
      width: 0, height: 0, x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0,
      toJSON: () => ({}),
    }) as DOMRect
    expect(expandRightbar(throwingCtx)).toBe(false)
    expect(clicks).toHaveLength(1)
  })
})

describe('useRightbarOpenOnNewSession（新会话检测）', () => {
  it('首帧只装基线；此后新出现的 id 且已上屏才展开', () => {
    const mounted = { current: 's1' as string | undefined }
    const toggleExpanded = vi.fn()
    const ctx = makeCtx({ mounted, isExpanded: () => false, toggleExpanded })
    const store = createSidebarStore()
    // 页面加载首帧就带着 s1、s2：两者都进基线，恢复不触发。
    const { feed, unmount } = harness(ctx, store, list('s1', 's2'))
    try {
      feed(list('s1', 's2'))
      expect(toggleExpanded).not.toHaveBeenCalled()
      mounted.current = 's3'
      feed(list('s1', 's2', 's3')) // s3 是加载后新建：命中
      expect(toggleExpanded).toHaveBeenCalledOnce()
    } finally {
      unmount()
    }
  })

  it('配置关闭时不动作', () => {
    const mounted = { current: 's2' as string | undefined }
    const toggleExpanded = vi.fn()
    const ctx = makeCtx({ mounted, isExpanded: () => false, toggleExpanded })
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), rightbarOpenOnNewSession: false })
    const { feed, unmount } = harness(ctx, store, list('s1'))
    try {
      feed(list('s1'))
      feed(list('s1', 's2'))
      expect(toggleExpanded).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('子代理系的行（origin/parentId）不算新会话', () => {
    const mounted = { current: 'kid' as string | undefined }
    const toggleExpanded = vi.fn()
    const ctx = makeCtx({ mounted, isExpanded: () => false, toggleExpanded })
    const store = createSidebarStore()
    const { feed, unmount } = harness(ctx, store, list('s1'))
    try {
      feed(list('s1'))
      feed(listWithRow({ kid: { id: 'kid', displayTitle: 'child', origin: 'subagent' } }))
      feed(listWithRow({ kid: { id: 'kid', displayTitle: 'child', parentId: 's1' } }))
      expect(toggleExpanded).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('座位未切到新会话时：立即不动作，重试窗口内切到位才展开；仍不在就放弃', async () => {
    vi.useFakeTimers()
    try {
      const mounted = { current: 's1' as string | undefined }
      const toggleExpanded = vi.fn()
      const ctx = makeCtx({ mounted, isExpanded: () => false, toggleExpanded })
      const store = createSidebarStore()
      const { feed, unmount } = harness(ctx, store, list('s1'))
      try {
        feed(list('s1'))
        mounted.current = undefined
        feed(list('s1', 's2')) // 列表先行，座位未切
        expect(toggleExpanded).not.toHaveBeenCalled()
        vi.advanceTimersByTime(NEW_SESSION_MOUNT_RETRY_MS - 1)
        mounted.current = 's2' // 重试触发前切到位
        vi.advanceTimersByTime(1)
        expect(toggleExpanded).toHaveBeenCalledOnce()
        // 已消费的挂起重试不会二次开火。
        mounted.current = 's1'
        vi.advanceTimersByTime(NEW_SESSION_MOUNT_RETRY_MS * 2)
        expect(toggleExpanded).toHaveBeenCalledOnce()
      } finally {
        unmount()
        vi.advanceTimersByTime(NEW_SESSION_MOUNT_RETRY_MS * 2)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('新会话从未上屏：重试一次后放弃，不误动别的会话的列', () => {
    vi.useFakeTimers()
    try {
      const mounted = { current: 's1' as string | undefined }
      const toggleExpanded = vi.fn()
      const ctx = makeCtx({ mounted, isExpanded: () => false, toggleExpanded })
      const store = createSidebarStore()
      const { feed, unmount } = harness(ctx, store, list('s1'))
      try {
        feed(list('s1'))
        feed(list('s1', 's2')) // s2 新建但没上屏（后台 fork）
        vi.advanceTimersByTime(NEW_SESSION_MOUNT_RETRY_MS * 2)
        expect(toggleExpanded).not.toHaveBeenCalled()
      } finally {
        unmount()
        vi.advanceTimersByTime(NEW_SESSION_MOUNT_RETRY_MS * 2)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
