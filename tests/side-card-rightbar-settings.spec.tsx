/**
 * Side card 设置区的新会话/宽度两行（SideCardSection.tsx 的 DragNumberInput 与
 * RadioPair）：百分比显示、水平拖动 3px 记 1%、键盘输入 + blur/Enter 提交、
 * 提交前 clamp 到 15–70、radio 两条路径的写入。api 模块整体 mock（dock-fallback
 * spec 的手法），settingsUpdate 记录补丁。
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

vi.mock('../src/client/api.ts', () => ({
  api: {
    settingsGet: vi.fn(async () => ({ value: {}, revision: 7 })),
    settingsUpdate: vi.fn(async (patch: Record<string, unknown>) => ({ value: patch, revision: 8 })),
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

function dragNumber(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>('[data-dsh-drag-number] input')
  if (node === null) throw new Error('drag number input not rendered')
  return node
}

function pointer(target: EventTarget, type: string, x: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { clientX?: number; button?: number; pointerId?: number }
  Object.assign(event, { clientX: x, button: 0, pointerId: 1 })
  target.dispatchEvent(event)
}

/** React 受控输入要用原生 setter + input 事件，onChange 才收得到。 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** 冲掉 mount 的异步 settingsGet→setPrefs（React 状态更新要在 act 里）。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

function radio(value: 'on' | 'off'): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>(`[data-dsh-radio-pair="dsh-rightbar-open-on-new-session"] input[value="${value}"]`)
  if (node === null) throw new Error(`radio ${value} not rendered`)
  return node
}

beforeEach(() => {
  vi.mocked(api.settingsGet).mockClear()
  vi.mocked(api.settingsUpdate).mockClear()
  vi.mocked(api.settingsUpdate).mockImplementation(async (patch: Record<string, unknown>) => ({ value: patch, revision: 8 }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SideCardSection 新增的两行（宽度占比 + 新会话自动打开）', () => {
  it('渲染占比行（默认 35）与新会话行（radio「打开」选中、「不打开」未选）', async () => {
    const { unmount } = mount()
    try {
      await settle()
      expect(dragNumber().value).toBe('35')
      expect(radio('on').checked).toBe(true)
      expect(radio('off').checked).toBe(false)
    } finally {
      unmount()
    }
  })

  it('键盘输入 50 + Enter → 写入 rightbarOpenRatio 0.5，输入框显示规范值', async () => {
    const { unmount } = mount()
    try {
      await settle()
      const input = dragNumber()
      // jsdom 里元素要先持有焦点，blur/Enter 才会派发 blur 事件。
      act(() => { input.focus() })
      act(() => { typeInto(input, '50') })
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      await act(async () => { await vi.waitFor(() => {
        expect(vi.mocked(api.settingsUpdate)).toHaveBeenCalledWith({ rightbarOpenRatio: 0.5 }, 7)
      }) })
      await settle()
      expect(input.value).toBe('50')
    } finally {
      unmount()
    }
  })

  it('越界输入 clamp：90 → 70（0.7），非数字回到现值', async () => {
    const { unmount } = mount()
    try {
      await settle()
      const input = dragNumber()
      act(() => { input.focus() })
      act(() => { typeInto(input, '90') })
      act(() => { input.blur() })
      await act(async () => { await vi.waitFor(() => {
        expect(vi.mocked(api.settingsUpdate)).toHaveBeenCalledWith({ rightbarOpenRatio: 0.7 }, 7)
      }) })
      await settle()
      expect(input.value).toBe('70')
    } finally {
      unmount()
    }
  })

  it('水平拖动：3px 记 1%，松手提交（100 → 112 即 +4 → 0.39）', async () => {
    const { unmount } = mount()
    try {
      await settle()
      const box = document.querySelector<HTMLElement>('[data-dsh-drag-number]')
      if (box === null) throw new Error('drag number box not rendered')
      act(() => { pointer(box, 'pointerdown', 100) })
      act(() => { pointer(box, 'pointermove', 112) })
      expect(dragNumber().value).toBe('39')
      act(() => { pointer(box, 'pointerup', 112) })
      await act(async () => { await vi.waitFor(() => {
        expect(vi.mocked(api.settingsUpdate)).toHaveBeenCalledWith({ rightbarOpenRatio: 0.39 }, 7)
      }) })
    } finally {
      unmount()
    }
  })

  it('radio 点「不打开」写入 rightbarOpenOnNewSession: false', async () => {
    const { unmount } = mount()
    try {
      await settle()
      act(() => { radio('off').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      await act(async () => { await vi.waitFor(() => {
        expect(vi.mocked(api.settingsUpdate)).toHaveBeenCalledWith({ rightbarOpenOnNewSession: false }, 7)
      }) })
      await settle()
      expect(radio('off').checked).toBe(true)
      expect(radio('on').checked).toBe(false)
    } finally {
      unmount()
    }
  })

  it('写入失败回滚：update 抛错时 radio 回到乐观前状态并显示错误', async () => {
    vi.mocked(api.settingsUpdate).mockImplementation(async () => {
      throw Object.assign(new Error('boom'), { code: 'settings-conflict' })
    })
    const { unmount } = mount()
    try {
      await settle()
      act(() => { radio('off').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      await settle()
      expect(document.querySelector('[role="alert"]')).not.toBeNull()
      // 失败回滚：on 又回到选中。
      expect(radio('on').checked).toBe(true)
    } finally {
      unmount()
    }
  })
})
