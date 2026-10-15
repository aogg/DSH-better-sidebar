/**
 * The settings page's scope tabs (全局设置 / 项目设置): the tab bar renders
 * over both surfaces, the choice persists in localStorage, the project tab
 * resolves the ACTIVE session's workspace root through api.sessionCwd, shows
 * the no-workspace hint without one, and its open-with panel writes the
 * reserved `pluginSettings["__project"][cwd]` blob (not the global editor blob) through the
 * same revision-guarded route. api is module-mocked (the
 * side-card-rightbar-settings手法); settingsUpdate records the patch.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'

setupReactAct()

const DEMO_CWD = '/code/www/my/demo'

vi.mock('../src/client/api.ts', () => ({
  api: {
    settingsGet: vi.fn(async () => ({ value: {}, revision: 7 })),
    settingsUpdate: vi.fn(async (patch: Record<string, unknown>) => ({ value: patch, revision: 8 })),
    sessionCwd: vi.fn(async () => ({ sessionId: 's1', cwd: DEMO_CWD, root: DEMO_CWD, parent: null })),
  },
}))

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { api } from '../src/client/api.ts'

function mount(store?: SidebarStore): { store: SidebarStore; service: BetterSidebarService; unmount: () => void } {
  const theStore = store ?? createSidebarStore()
  const service = createBetterSidebarService(theStore)
  const view = renderRoot(createElement(
    SideCardSection,
    { store: theStore, service } as unknown as SideCardSectionProps,
  ))
  return { store: theStore, service, unmount: view.unmount }
}

function scopeTab(label: 'Global' | 'Project'): HTMLButtonElement {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const node = tabs.find(tab => tab.textContent?.trim() === label)
  if (node === undefined) throw new Error(`scope tab ${label} not rendered`)
  return node
}

function click(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** React 受控输入要用原生 setter + input 事件，onChange 才收得到。 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 冲掉 mount 的 settingsGet / sessionCwd → setState（更新要在 act 里）。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

beforeEach(() => {
  window.localStorage.removeItem('dsh-sidebar:settings-tab')
  vi.mocked(api.settingsGet).mockClear()
  vi.mocked(api.settingsUpdate).mockClear()
  vi.mocked(api.sessionCwd).mockClear()
  vi.mocked(api.settingsUpdate).mockImplementation(async (patch: Record<string, unknown>) => ({ value: patch, revision: 8 }))
})

afterEach(() => {
  window.localStorage.removeItem('dsh-sidebar:settings-tab')
  vi.restoreAllMocks()
})

describe('SideCardSection 作用域 tab', () => {
  it('默认停在全局设置：版本徽标可见，项目面板不渲染', async () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const { unmount } = mount(store)
    try {
      await settle()
      expect(scopeTab('Global').getAttribute('aria-selected')).toBe('true')
      expect(document.querySelector('.versionBadge, [class*="versionBadge"]')).not.toBeNull()
      expect(document.querySelector('[data-dsh-project-scope]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('切到项目设置：解析活动会话的工作区根并渲染打开方式组', async () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const { unmount } = mount(store)
    try {
      await settle()
      click(scopeTab('Project'))
      await settle()
      expect(scopeTab('Project').getAttribute('aria-selected')).toBe('true')
      const group = document.querySelector('[data-dsh-project-scope]')
      expect(group?.getAttribute('data-dsh-project-scope')).toBe(DEMO_CWD)
      expect(document.querySelector('[class*="projectPathName"]')?.textContent).toBe('demo')
      // 全局体（版本徽标）随 tab 切换隐藏。
      expect(document.querySelector('[class*="versionBadge"]')).toBeNull()
      // 选择持久化。
      expect(window.localStorage.getItem('dsh-sidebar:settings-tab')).toBe('project')
    } finally {
      unmount()
    }
  })

  it('项目面板的 SSH 输入写入保留键 pluginSettings.__project[cwd].openWith（不动全局 editor blob）', async () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const { unmount } = mount(store)
    try {
      await settle()
      click(scopeTab('Project'))
      await settle()
      const ssh = document.querySelector<HTMLInputElement>('[data-dsh-project-scope] input:not([type])')
      expect(ssh).not.toBeNull()
      act(() => { typeInto(ssh!, 'prod') })
      await settle()
      const patch = vi.mocked(api.settingsUpdate).mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
      expect(patch).toBeDefined()
      const pluginSettings = patch?.pluginSettings as Record<string, Record<string, unknown>> | undefined
      const projectMap = pluginSettings?.['__project'] as Record<string, Record<string, unknown>> | undefined
      const openWith = projectMap?.[DEMO_CWD]?.openWith as Record<string, unknown> | undefined
      expect(openWith?.sshHost).toBe('prod')
      // 全局 editor blob 不被项目写入触碰。
      expect(pluginSettings?.['editor']).toBeUndefined()
    } finally {
      unmount()
    }
  })

  it('无活动会话：项目 tab 显示空态提示', async () => {
    const { unmount } = mount()
    try {
      await settle()
      click(scopeTab('Project'))
      await settle()
      expect(document.querySelector('[data-dsh-project-empty]')).not.toBeNull()
      expect(document.querySelector('[data-dsh-project-scope]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('记住上次停留的 tab（localStorage=project → 下次挂载直接在项目设置）', async () => {
    window.localStorage.setItem('dsh-sidebar:settings-tab', 'project')
    const store = createSidebarStore()
    store.setSession('s1')
    const { unmount } = mount(store)
    try {
      await settle()
      expect(scopeTab('Project').getAttribute('aria-selected')).toBe('true')
      expect(document.querySelector('[data-dsh-project-scope]')).not.toBeNull()
    } finally {
      unmount()
    }
  })
})
