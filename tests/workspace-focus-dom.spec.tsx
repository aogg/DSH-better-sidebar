// @vitest-environment jsdom
/**
 * 单工作区专注模式的 DOM 层（src/client/workspace-focus-dom.ts）。
 *
 * 核心发布的 DOM 契约是行上的 `data-row-key`（`workspace:<key>` /
 * `session:<id>` / `overflow:<key>`）与列表容器的 `[role="tree"]`；这里用
 * 同形 DOM 钉住：
 *   1. 未带 `?ws` 时整体不启动（无样式表、无标记、无横幅）；
 *   2. 带参激活：注册同步生效——非成员的工作区头/会话行/展开按钮打上隐藏
 *      标记，成员行、空态与树外行（文件树等）不动；横幅插在树之前；
 *   3. 核心重渲染（换行元素）后观察器重新对齐；workspaces 订阅触发时按新
 *      成员集合重算（新成员行摘标记、离组成员行补标记）；
 *   4. 专注 id 不在快照里（链接过期）→ 不过滤（宁可多显示也不空白）；
 *   5. 主视图会话不在专注工作区时自动转到该工作区最近的会话（一次）；
 *      已在专注工作区内则不打扰；
 *   6. 「退出专注」：URL 清掉 ws 参数、就地摘掉全部标记与横幅（不刷新）；
 *   7. disposer 清理一切，后续 DOM 变化不再产生标记。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { registerWorkspaceFocus } from '../src/client/workspace-focus-dom.ts'
import type { FocusWorkspaceItem } from '../src/client/workspace-focus.ts'

/** The disposer of the registration under test (disposed again in afterEach). */
let dispose: (() => void) | undefined

/** Point the browser-language fallback at Chinese so the copy asserts. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

/** The workspaces service face snapshot the module reads (mutated per case). */
interface FakeSnapshot {
  items: FocusWorkspaceItem[]
  phase: string
}

interface FakeServices {
  snapshot: FakeSnapshot
  sessions?: {
    ids: string[]
    byId: Record<string, { id: string; updatedAt: number; retainedBy?: { mainView?: number } } | undefined>
    phase: string
  }
  openSession?: ReturnType<typeof vi.fn>
}

/** Build the minimal service faces the module reads via try/catch `get`. */
function ctxWith(services: FakeServices): { ctx: Context; emitWorkspacesUpdate(): void } {
  const listeners = new Set<() => void>()
  const workspaces = {
    list: {
      getSnapshot: () => services.snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
  const sessions = services.sessions === undefined ? undefined : {
    list: {
      getSnapshot: () => services.sessions!,
    },
  }
  const uiWorkspace = services.openSession === undefined ? undefined : { openSession: services.openSession }
  const ctx = {
    get: (id: string) =>
      id === 'workspaces' ? workspaces
        : id === 'sessions' ? sessions
          : id === 'uiWorkspace' ? uiWorkspace
            : undefined,
  } as unknown as Context
  return {
    ctx,
    // 模块激活时订阅了 workspaces.list；这里触发一次成员流更新。
    emitWorkspacesUpdate: () => { for (const listener of [...listeners]) listener() },
  }
}

/** Build a host-shaped workspace tree: one [role=tree] with keyed rows. */
function buildTree(rows: Array<[string, string?]>): { tree: HTMLElement; rowOf(key: string): HTMLElement } {
  const body = document.createElement('div')
  const tree = document.createElement('div')
  tree.setAttribute('role', 'tree')
  tree.setAttribute('aria-label', '会话')
  const rowByKey = new Map<string, HTMLElement>()
  for (const [key, extra] of rows) {
    const row = document.createElement('div')
    row.setAttribute('data-row-key', key)
    if (extra !== undefined) row.setAttribute('data-kind', extra)
    tree.appendChild(row)
    rowByKey.set(key, row)
  }
  body.appendChild(tree)
  document.body.appendChild(body)
  return { tree, rowOf: (key) => rowByKey.get(key)! }
}

/** Standard member/non-member tree for the w1 focus cases. */
function buildStandardTree(): { tree: HTMLElement; rowOf(key: string): HTMLElement } {
  return buildTree([
    ['workspace:w1'],
    ['session:s1'],
    ['overflow:w1'],
    ['workspace:w2'],
    ['session:s3'],
    ['overflow:w2'],
    ['workspace:'],
    ['session:'],
    ['empty'],
    ['file:src/a.ts'],
  ])
}

/** All rows currently carrying the hidden marker. */
function markedKeys(): string[] {
  return [...document.querySelectorAll('[data-dsh-focus-hidden]')].map((row) => row.getAttribute('data-row-key') ?? '')
}

/**
 * Flush the observer's debounce: when the environment has frames (vitest's
 * jsdom does), the pending rAF must fire first; the trailing macrotask beat
 * also covers the setTimeout fallback path (environments without rAF).
 */
async function flushDebounce(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
  }
  await new Promise(resolve => { setTimeout(resolve, 25) })
}

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  stubZh()
})

describe('registerWorkspaceFocus', () => {
  it('stays fully dormant without the ws param', () => {
    const { rowOf } = buildStandardTree()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    expect(document.head.querySelector('style[data-dsh-focus-style]')).toBeNull()
    expect(document.querySelector('[data-dsh-focus-banner]')).toBeNull()
    expect(markedKeys()).toEqual([])
    expect(rowOf('workspace:w2').hasAttribute('data-dsh-focus-hidden')).toBe(false)
  })

  it('filters the tree to the focus workspace and injects the exit banner', () => {
    stubZh()
    window.history.replaceState(null, '', '/?ws=w1')
    const { tree, rowOf } = buildStandardTree()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }, { workspaceId: 'w2', sessionIds: ['s3'] }], phase: 'ready' },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    // 同步首趟即生效。
    expect(markedKeys().sort()).toEqual(['overflow:w2', 'session:s3', 'session:', 'workspace:w2', 'workspace:'].sort())
    expect(rowOf('session:s1').hasAttribute('data-dsh-focus-hidden')).toBe(false)
    expect(rowOf('workspace:w1').hasAttribute('data-dsh-focus-hidden')).toBe(false)
    // 树外行（空态/文件树）一概不动。
    expect(rowOf('empty').hasAttribute('data-dsh-focus-hidden')).toBe(false)
    expect(rowOf('file:src/a.ts').hasAttribute('data-dsh-focus-hidden')).toBe(false)
    // 横幅插在树之前，带 zh 文案与退出按钮。
    const banner = document.querySelector<HTMLElement>('[data-dsh-focus-banner]')
    expect(banner).not.toBeNull()
    expect(tree.previousSibling).toBe(banner)
    expect(banner!.querySelector('.label')!.textContent).toBe('专注模式：左侧仅显示此工作区')
    expect(banner!.querySelector<HTMLButtonElement>('.exit')!.textContent).toBe('退出专注')
    // 样式表按标记注入，颜色全走令牌。
    const tag = document.head.querySelector('style[data-dsh-focus-style]')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toContain('display: none')
  })

  it('re-aligns after core re-renders swap row elements', async () => {
    window.history.replaceState(null, '', '/?ws=w1')
    const { tree } = buildStandardTree()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    // 核心 React 重渲染：整棵树的原行被替换成新元素。
    const fresh = document.createElement('div')
    fresh.setAttribute('role', 'tree')
    for (const key of ['workspace:w1', 'session:s1', 'session:s3']) {
      const row = document.createElement('div')
      row.setAttribute('data-row-key', key)
      fresh.appendChild(row)
    }
    tree.replaceWith(fresh)
    await flushDebounce()
    const keys = markedKeys().sort()
    expect(keys).toEqual(['session:s3'])
    // 新出现的非成员行也会被补标记。
    const late = document.createElement('div')
    late.setAttribute('data-row-key', 'session:s9')
    fresh.appendChild(late)
    await flushDebounce()
    expect(late.hasAttribute('data-dsh-focus-hidden')).toBe(true)
  })

  it('does not filter when the focus id is unknown (stale link)', () => {
    window.history.replaceState(null, '', '/?ws=missing')
    const { rowOf } = buildStandardTree()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    expect(markedKeys()).toEqual([])
    expect(rowOf('workspace:w2').hasAttribute('data-dsh-focus-hidden')).toBe(false)
  })

  it('keeps the current main-view session visible even before it joins the snapshot', () => {
    window.history.replaceState(null, '', '/?ws=w1')
    const { rowOf } = buildTree([
      ['workspace:w1'],
      ['session:s1'],
      ['session:s9'],
      ['workspace:w2'],
      ['session:s3'],
    ])
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
      sessions: {
        ids: ['s1', 's9'],
        byId: {
          s1: { id: 's1', updatedAt: 2 },
          s9: { id: 's9', updatedAt: 9, retainedBy: { mainView: 1 } },
        },
        phase: 'ready',
      },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    // s9 还没进 w1 的 sessionIds（入组流在途），但它是主视图会话：保住。
    expect(rowOf('session:s9').hasAttribute('data-dsh-focus-hidden')).toBe(false)
  })

  it('auto-opens the most recent focus-workspace session when the main view is elsewhere', async () => {
    window.history.replaceState(null, '', '/?ws=w1')
    buildStandardTree()
    const openSession = vi.fn()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }], phase: 'ready' },
      sessions: {
        ids: ['s1', 's2', 's3'],
        byId: {
          s1: { id: 's1', updatedAt: 1 },
          s2: { id: 's2', updatedAt: 5 },
          s3: { id: 's3', updatedAt: 9, retainedBy: { mainView: 1 } },
        },
        phase: 'ready',
      },
      openSession,
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    await flushDebounce()
    // 主视图是 s3（别的会话）→ 转到 w1 里最近的 s2（不是当前主视图的 s1）。
    expect(openSession).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith('s2')
  })

  it('does not fight the user when the main view already shows a member session', async () => {
    window.history.replaceState(null, '', '/?ws=w1')
    buildStandardTree()
    const openSession = vi.fn()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
      sessions: {
        ids: ['s1'],
        byId: { s1: { id: 's1', updatedAt: 1, retainedBy: { mainView: 1 } } },
        phase: 'ready',
      },
      openSession,
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    await flushDebounce()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('exiting drops the ws param and restores the full tree in place', () => {
    stubZh()
    window.history.replaceState(null, '', '/?ws=w1&theme=dark')
    const { rowOf } = buildStandardTree()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    expect(markedKeys().length).toBeGreaterThan(0)
    const exit = document.querySelector<HTMLButtonElement>('[data-dsh-focus-banner] .exit')!
    exit.click()
    expect(window.location.search).toBe('?theme=dark')
    expect(markedKeys()).toEqual([])
    expect(document.querySelector('[data-dsh-focus-banner]')).toBeNull()
    expect(document.head.querySelector('style[data-dsh-focus-style]')).toBeNull()
    expect(rowOf('workspace:w2').hasAttribute('data-dsh-focus-hidden')).toBe(false)
  })

  it('dispose removes every trace and stops reacting to DOM churn', async () => {
    window.history.replaceState(null, '', '/?ws=w1')
    const { tree } = buildStandardTree()
    const handles = ctxWith({
      snapshot: { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' },
    })
    dispose = registerWorkspaceFocus(handles.ctx)
    expect(markedKeys().length).toBeGreaterThan(0)
    dispose()
    dispose = undefined
    expect(markedKeys()).toEqual([])
    expect(document.querySelector('[data-dsh-focus-banner]')).toBeNull()
    expect(document.head.querySelector('style[data-dsh-focus-style]')).toBeNull()
    const late = document.createElement('div')
    late.setAttribute('data-row-key', 'session:s3')
    tree.appendChild(late)
    await flushDebounce()
    expect(late.hasAttribute('data-dsh-focus-hidden')).toBe(false)
  })

  it('re-aligns through the workspaces subscription when membership changes', async () => {
    window.history.replaceState(null, '', '/?ws=w1')
    const { rowOf } = buildStandardTree()
    const snapshot: FakeSnapshot = { items: [{ workspaceId: 'w1', sessionIds: ['s1'] }], phase: 'ready' }
    const handles = ctxWith({ snapshot })
    dispose = registerWorkspaceFocus(handles.ctx)
    expect(rowOf('session:s3').hasAttribute('data-dsh-focus-hidden')).toBe(true)
    // 成员流：s3 加进了 w1 → 摘标记；s1 移出 → 补标记。
    snapshot.items = [{ workspaceId: 'w1', sessionIds: ['s3'] }]
    handles.emitWorkspacesUpdate()
    await flushDebounce()
    expect(rowOf('session:s3').hasAttribute('data-dsh-focus-hidden')).toBe(false)
    expect(rowOf('session:s1').hasAttribute('data-dsh-focus-hidden')).toBe(true)
  })
})
