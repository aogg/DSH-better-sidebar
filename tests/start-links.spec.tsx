/**
 * Hero 快捷入口行（src/client/sidebar/start-links.tsx）。
 *
 * 宿主 DOM 用假结构模拟（`[data-slot="main.conversation"]` + `[data-phase]` +
 * `[data-composer-seat]`，与 dock-fallback spec 同一手法）：相位标记是宿主
 * ConversationMainPanel 的稳定 data-* 输出，类名是哈希值不进断言。钉住六件事：
 * 相位 hero 渲染 6 个胶囊、相位离开 hero 移除、点击走正确的 openTab 参数、
 * 无在屏会话时终端点击是 no-op（不抛错）、设置胶囊走 settings-entry 探测链
 * （已开直达分区 / 合成 settings.open 快捷键 / 探测失败静默 no-op）、
 * observer/portal 随 disposer 清理。
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { setupReactAct } from './test-utils.ts'
import { registerStartLinks, terminalShortcutKeys } from '../src/client/sidebar/start-links.tsx'
import { openSettingsEntry, settingsOpenBinding } from '../src/client/sidebar/settings-entry.ts'
import type { Context } from '../src/context-types.ts'
import type { BetterSidebarService } from '../src/client/service.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => {
  for (const node of document.querySelectorAll('[data-dsh-test-slot]')) node.remove()
  for (const node of document.querySelectorAll('[data-dsh-start-links-host]')) node.remove()
})

/** 假宿主 DOM：会话槽锚 + 相位根 + composer seat（相位根的最后一个宿主子节点之前）。 */
function mountHero(phase: string | undefined): { slot: HTMLDivElement; phaseRoot: HTMLDivElement } {
  const slot = document.createElement('div')
  slot.setAttribute('data-slot', 'main.conversation')
  slot.setAttribute('data-dsh-test-slot', '')
  const phaseRoot = document.createElement('div')
  if (phase !== undefined) phaseRoot.setAttribute('data-phase', phase)
  const composer = document.createElement('div')
  composer.setAttribute('data-composer-seat', '')
  phaseRoot.appendChild(composer)
  slot.appendChild(phaseRoot)
  document.body.appendChild(slot)
  return { slot, phaseRoot }
}

interface CtxOptions {
  mounted?: string | undefined
  openTab?: (kind: string, options?: unknown) => void
  shortcutEntries?: readonly { id?: unknown; keys?: readonly unknown[]; aria?: unknown; binding?: unknown }[] | undefined
}

/** 最小 ctx 假体：sidebarRight（mounted + openTab）与 shortcuts catalog。 */
function makeCtx(options: CtxOptions = {}): Context {
  const sidebarRight = {
    mounted: {
      getSnapshot: (): string | undefined => options.mounted,
      subscribe: (_fn: () => void) => () => {},
    },
    ...(options.openTab !== undefined ? { openTab: options.openTab } : {}),
  }
  const shortcuts = options.shortcutEntries === undefined ? undefined : {
    catalog: { getSnapshot: () => options.shortcutEntries },
  }
  return {
    get: (name: string) => {
      if (name === 'sidebarRight') return sidebarRight
      if (name === 'shortcuts') return shortcuts
      return undefined
    },
  } as unknown as Context
}

const service = (): { fake: BetterSidebarService; openTab: ReturnType<typeof vi.fn> } => {
  const openTab = vi.fn()
  return { fake: { openTab } as unknown as BetterSidebarService, openTab }
}

/** MutationObserver 回调跑在微任务里：一个宏任务把「变更 → 同步 → 渲染」冲完。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

function click(node: Element): void {
  act(() => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

describe('hero start links（开始页快捷入口）', () => {
  it('phase=hero 时渲染 6 个胶囊，行挂在相位根末尾（composer seat 之后）', async () => {
    const { phaseRoot } = mountHero('hero')
    const ctx = makeCtx()
    const { fake } = service()
    let dispose: () => void = () => {}
    act(() => { dispose = registerStartLinks(ctx, fake) })
    try {
      await flush()
      const links = document.querySelectorAll('[data-dsh-start-link]')
      expect(links).toHaveLength(6)
      expect([...links].map(node => node.getAttribute('data-dsh-start-link'))).toEqual([
        'files', 'changes', 'terminal', 'jobs', 'sidechat', 'settings',
      ])
      const host = document.querySelector('[data-dsh-start-links-host]')
      expect(host, '入口行宿主必须存在').not.toBeNull()
      // 追加到相位根末尾：composer seat 的下一个兄弟就是它。
      expect(phaseRoot.getAttribute('data-phase')).toBe('hero')
      const composer = phaseRoot.querySelector('[data-composer-seat]')
      expect(composer?.nextElementSibling).toBe(host)
    } finally {
      act(() => { dispose() })
    }
  })

  it('相位离开 hero（settling/active/锚消失）时整行移除', async () => {
    const { slot, phaseRoot } = mountHero('hero')
    const ctx = makeCtx()
    const { fake } = service()
    let dispose: () => void = () => {}
    act(() => { dispose = registerStartLinks(ctx, fake) })
    try {
      await flush()
      expect(document.querySelectorAll('[data-dsh-start-link]').length).toBe(6)
      act(() => { phaseRoot.setAttribute('data-phase', 'active') })
      await flush()
      expect(document.querySelector('[data-dsh-start-links-host]')).toBeNull()
      // 锚整个消失（SPA 导航）同样收敛。
      act(() => { phaseRoot.setAttribute('data-phase', 'hero') })
      await flush()
      act(() => { slot.remove() })
      await flush()
      expect(document.querySelector('[data-dsh-start-links-host]')).toBeNull()
    } finally {
      act(() => { dispose() })
    }
  })

  it('点击插件 tab 胶囊以正确的类型调 service.openTab', async () => {
    mountHero('hero')
    const ctx = makeCtx({ mounted: 's1' })
    const { fake, openTab } = service()
    let dispose: () => void = () => {}
    act(() => { dispose = registerStartLinks(ctx, fake) })
    try {
      await flush()
      const open = (kind: string): void => {
        const node = document.querySelector(`[data-dsh-start-link="${kind}"]`)
        if (node === null) throw new Error(`missing link: ${kind}`)
        click(node)
      }
      open('files')
      expect(openTab).toHaveBeenLastCalledWith({ type: 'editor' })
      open('changes')
      expect(openTab).toHaveBeenLastCalledWith({ type: 'git' })
      open('jobs')
      expect(openTab).toHaveBeenLastCalledWith({ type: 'subagent' })
      open('sidechat')
      expect(openTab).toHaveBeenLastCalledWith({ type: 'sidechat' })
    } finally {
      act(() => { dispose() })
    }
  })

  it('终端胶囊：有在屏会话才开宿主 terminal kind，无在屏会话是 no-op（不抛错）', async () => {
    mountHero('hero')
    const openTab = vi.fn()
    // mounted 缺席（hero 相位可以没有会话）：宿主命令面按契约会 throw，先门控。
    const { fake, openTab: unusedOpenTab } = service()
    void unusedOpenTab
    let dispose1: () => void = () => {}
    act(() => { dispose1 = registerStartLinks(makeCtx({ openTab }), fake) })
    try {
      await flush()
      const node = document.querySelector('[data-dsh-start-link="terminal"]')
      if (node === null) throw new Error('missing terminal link')
      expect(() => { click(node) }).not.toThrow()
      expect(openTab).not.toHaveBeenCalled()
      act(() => { dispose1() })
      // 有在屏会话：结构化探测 ctx.sidebarRight.openTab('terminal')。
      let dispose2: () => void = () => {}
      act(() => { dispose2 = registerStartLinks(makeCtx({ mounted: 's1', openTab }), fake) })
      try {
        await flush()
        const node2 = document.querySelector('[data-dsh-start-link="terminal"]')
        if (node2 === null) throw new Error('missing terminal link')
        click(node2)
        expect(openTab).toHaveBeenCalledWith('terminal', {})
      } finally {
        act(() => { dispose2() })
      }
    } finally {
      act(() => { dispose1() })
    }
  })

  it('终端快捷键提示：读宿主 catalog 的 terminal.new，读不到回退静态 Ctrl+`', async () => {
    mountHero('hero')
    const ctx = makeCtx({
      mounted: 's1',
      shortcutEntries: [{ id: 'terminal.new', keys: ['⌃', '`'], aria: 'Control backquote' }],
    })
    const { fake } = service()
    let dispose: () => void = () => {}
    act(() => { dispose = registerStartLinks(ctx, fake) })
    try {
      await flush()
      const terminal = document.querySelector('[data-dsh-start-link="terminal"]')
      if (terminal === null) throw new Error('missing terminal link')
      expect(terminal.textContent).toContain('⌃')
      expect(terminal.textContent).toContain('`')
      // aria 来目录（aria-keyshortcuts 由 ShortcutKeys 调用方决定，这里只钉键帽文本）。
      act(() => { dispose() })
      // 目录缺席：静态回退仍是 Ctrl + `。
      let dispose2: () => void = () => {}
      act(() => { dispose2 = registerStartLinks(makeCtx({ mounted: 's1' }), fake) })
      try {
        await flush()
        const fallback = document.querySelector('[data-dsh-start-link="terminal"]')
        if (fallback === null) throw new Error('missing terminal link')
        expect(fallback.textContent).toContain('Ctrl')
        expect(fallback.textContent).toContain('`')
      } finally {
        act(() => { dispose2() })
      }
    } finally {
      act(() => { dispose() })
    }
  })

  it('terminalShortcutKeys 对形状不符的目录条目拒绝（不给 ShortcutKeys 喂脏数据）', () => {
    const bad = makeCtx({ shortcutEntries: [{ id: 'terminal.new', keys: ['Ctrl', 7] }] })
    expect(terminalShortcutKeys(bad)).toBeUndefined()
    const empty = makeCtx({ shortcutEntries: [{ id: 'terminal.new', keys: [] }] })
    expect(terminalShortcutKeys(empty)).toBeUndefined()
    const other = makeCtx({ shortcutEntries: [{ id: 'sidebar.left.toggle', keys: ['Ctrl', 'B'] }] })
    expect(terminalShortcutKeys(other)).toBeUndefined()
  })

  it('disposer 清掉 portal 与 observer（再次进入 hero 不再渲染）', async () => {
    const { phaseRoot } = mountHero('hero')
    const ctx = makeCtx()
    const { fake } = service()
    let dispose: () => void = () => {}
    act(() => { dispose = registerStartLinks(ctx, fake) })
    await flush()
    expect(document.querySelectorAll('[data-dsh-start-link]').length).toBe(6)
    act(() => { dispose() })
    expect(document.querySelector('[data-dsh-start-links-host]')).toBeNull()
    act(() => { phaseRoot.setAttribute('data-phase', 'settling') })
    await flush()
    act(() => { phaseRoot.setAttribute('data-phase', 'hero') })
    await flush()
    expect(document.querySelector('[data-dsh-start-links-host]')).toBeNull()
  })
})

/** 收集 body 上的 keydown（宿主适配器在 window 气泡相监听，这里同相取证）。 */
function watchKeydown(): { events: KeyboardEvent[]; stop: () => void } {
  const events: KeyboardEvent[] = []
  const listener = (event: Event): void => { events.push(event as KeyboardEvent) }
  document.body.addEventListener('keydown', listener)
  return { events, stop: () => { document.body.removeEventListener('keydown', listener) } }
}

/**
 * 假设置壳面板：宿主 SettingsPanel 的稳定 data-* 锚（data-shortcut-modal）+
 * nav 行；tag data-dsh-test-slot 供 afterEach 清理。返回 nav 行（可挂 click 侦听）。
 */
function mountSettingsDialog(...labels: string[]): HTMLButtonElement[] {
  const dialog = document.createElement('div')
  dialog.setAttribute('data-shortcut-modal', 'settings')
  dialog.setAttribute('data-dsh-test-slot', '')
  const nav = document.createElement('nav')
  const rows = labels.map(label => {
    const row = document.createElement('button')
    row.type = 'button'
    row.textContent = label
    nav.append(row)
    return row
  })
  dialog.append(nav)
  document.body.append(dialog)
  return rows
}

/** settings.open 的目录行（binding 形状任意，供形状拒绝用例喂脏数据）。 */
function settingsCatalog(binding: unknown): readonly { id: string; binding: unknown }[] {
  return [{ id: 'settings.open', binding }]
}

describe('设置入口（宿主设置壳探测链，settings-entry.ts）', () => {
  it('设置壳已开：直达 Side card 分区行（与 settings-nav-icon 同一匹配规则），不派发快捷键', () => {
    const rows = mountSettingsDialog('General', 'Side card')
    const clicks = vi.fn()
    rows[1]!.addEventListener('click', clicks)
    const watch = watchKeydown()
    try {
      // beforeAll 已把 navigator.language 钉在 en-US：t('settingsNav') = 'Side card'。
      const ctx = makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['control', 'alt'] }) })
      expect(() => { openSettingsEntry(ctx) }).not.toThrow()
      expect(clicks).toHaveBeenCalledTimes(1)
      expect(watch.events).toHaveLength(0)
    } finally {
      watch.stop()
    }
  })

  it('设置壳未开：按公开目录 settings.open 的生效 binding 派发合成 keydown（点胶囊同路径）', async () => {
    mountHero('hero')
    const ctx = makeCtx({
      mounted: 's1',
      shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['control', 'alt'] }),
    })
    const { fake, openTab } = service()
    const watch = watchKeydown()
    let dispose: () => void = () => {}
    try {
      act(() => { dispose = registerStartLinks(ctx, fake) })
      await flush()
      const node = document.querySelector('[data-dsh-start-link="settings"]')
      if (node === null) throw new Error('missing settings link')
      click(node)
      expect(watch.events).toHaveLength(1)
      expect(watch.events[0]!.code).toBe('Comma')
      expect(watch.events[0]!.ctrlKey).toBe(true)
      expect(watch.events[0]!.altKey).toBe(true)
      expect(watch.events[0]!.bubbles).toBe(true)
      // 设置入口不走 service.openTab。
      expect(openTab).not.toHaveBeenCalled()
      // 面板始终未挂载：排空 0ms/120ms 两次直达尝试，定时器自灭不泄漏进后续用例。
      await new Promise(resolve => { setTimeout(resolve, 180) })
    } finally {
      watch.stop()
      act(() => { dispose() })
    }
  })

  it('打开后的直达尝试：面板异步挂载后点分区行，命中即停（不重复点）', async () => {
    const watch = watchKeydown()
    try {
      const ctx = makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['control', 'alt'] }) })
      // 先点（壳未开）→ 派发 + 排程；面板随后才挂载（模拟宿主 React 异步提交）。
      act(() => { openSettingsEntry(ctx) })
      expect(watch.events).toHaveLength(1)
      await new Promise(resolve => { setTimeout(resolve, 20) })
      const rows = mountSettingsDialog('General', 'Side card')
      const clicks = vi.fn()
      rows[1]!.addEventListener('click', clicks)
      await new Promise(resolve => { setTimeout(resolve, 200) })
      expect(clicks).toHaveBeenCalledTimes(1)
      // done 之后不再重复点击。
      await new Promise(resolve => { setTimeout(resolve, 150) })
      expect(clicks).toHaveBeenCalledTimes(1)
    } finally {
      watch.stop()
    }
  })

  it('binding 缺席/形状不符：静默 no-op（不派发、不抛错）', () => {
    const watch = watchKeydown()
    try {
      // 无 shortcuts 服务（hero 相位宿主服务可能缺席）。
      expect(() => { openSettingsEntry(makeCtx()) }).not.toThrow()
      // 目录里没有 settings.open 行。
      expect(() => { openSettingsEntry(makeCtx({ shortcutEntries: [{ id: 'terminal.new', keys: ['Ctrl', 'K'] }] })) }).not.toThrow()
      // unbound（用户清空了快捷键）。
      expect(() => { openSettingsEntry(makeCtx({ shortcutEntries: settingsCatalog(null) })) }).not.toThrow()
      // 二键 chord：单事件无法合成，拒绝。
      expect(() => {
        openSettingsEntry(makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['control'], secondCode: 'KeyK' }) }))
      }).not.toThrow()
      // 未知修饰键 / 非 string code：拒绝。
      expect(() => { openSettingsEntry(makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['hyper'] }) })) }).not.toThrow()
      expect(() => { openSettingsEntry(makeCtx({ shortcutEntries: settingsCatalog({ code: 7, modifiers: [] }) })) }).not.toThrow()
      expect(watch.events).toHaveLength(0)
    } finally {
      watch.stop()
    }
  })

  it('settingsOpenBinding 只接受单键的规范化 binding（脏数据不进合成事件）', () => {
    const good = { code: 'Comma', modifiers: ['control', 'alt'] }
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog(good) }))).toEqual(good)
    // 修饰键顺序无关（宿主 normalize 后 keycap 序，这里乱序给也一样接受）。
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['alt', 'control'] }) }))).toEqual(good)
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog(null) }))).toBeUndefined()
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: [{ id: 'terminal.new' }] }))).toBeUndefined()
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['control'], secondCode: 'KeyK' }) }))).toBeUndefined()
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog({ code: 'Comma', modifiers: ['hyper'] }) }))).toBeUndefined()
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog({ code: 7, modifiers: [] }) }))).toBeUndefined()
    expect(settingsOpenBinding(makeCtx({ shortcutEntries: settingsCatalog('Comma') }))).toBeUndefined()
    expect(settingsOpenBinding(makeCtx())).toBeUndefined()
  })
})
