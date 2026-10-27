/**
 * 「远程工作区」状态页（src/client/ssh-workspace/page.tsx）核心路径。
 *
 * 网关走真实单例（fetch 用 vi.stubGlobal 拦截，绝不发真实请求）。钉住：
 * payload 渲染概览统计与已挂载列表（含 sshDisplayPath 展示拼写、停用
 * chip、会话数、broken 汇总点、事件最新在前）；sshDisplayPath 单元语义；
 * 复制按钮写剪贴板的是**原始拼写**（展示拼写只影响显示）；有过成功数据
 * 后的瞬时失败 → 旧数据保留 +「读取失败」行 + 重试按钮（点重试恢复）；
 * 不可用（404）→ 空态提示且描述符 available 门控跟随；visible=false 不发
 * 任何请求（页面不持有后台定时器）、visible=true 挂载即强拉一轮。
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { createElement } from 'react'
import { setupReactAct, renderRoot } from './test-utils.ts'
import { SshWorkspacePage, createSshWorkspaceTabDescriptor, sshDisplayPath } from '../src/client/ssh-workspace/page.tsx'
import { disposeSshWorkspaceGateway, getSshWorkspaceGateway, SSH_WORKSPACE_TAB_TYPE } from '../src/client/ssh-workspace/gateway.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // 单例归零：真实网关的 TTL 定时器不得漏进下一个用例。
  disposeSshWorkspaceGateway()
})

/** 概览用 payload：2 挂载 1 停用、1 断连、2 工作区（1 本地）、1 转发、2 事件。 */
const overviewPayload = (): Record<string, unknown> => ({
  mounted: ['ssh://dev//home/u/proj', 'ssh://lab//srv/data'],
  disabled: ['ssh://lab//srv/data'],
  connections: [
    { alias: 'dev', state: 'connected' },
    { alias: 'lab', state: 'broken' },
  ],
  workspaces: [
    { path: 'ssh://dev//home/u/proj', title: 'proj', sessionIds: ['s1', 's2'] },
    { path: 'ssh://lab//srv/data', title: '', sessionIds: [] },
  ],
  forwards: [
    { alias: 'web', localHost: '127.0.0.1', localPort: 3080, remoteHost: 'dev', remotePort: 80, live: true },
  ],
  events: [
    { at: 1_700_000_000_000, kind: 'probe', message: 'first' },
    { at: 1_700_000_060_000, kind: 'forward', message: 'second' },
  ],
})

/** 把全局 fetch 换成给定应答（每次调用 fresh payload，防用例间互相污染）。 */
function stubFetchOk(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 探测成功后挂载页面（visible 的强拉也在 act 里冲完）。 */
async function mountPage(ctx: Context, visible: boolean, payload: unknown) {
  stubFetchOk(payload)
  await getSshWorkspaceGateway().probe()
  const rendered = renderRoot(createElement(SshWorkspacePage, { ctx, visible }))
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
  return rendered
}

/**
 * 最小 ctx 假体：mounted 喂恒 undefined（无在屏会话 →「当前会话工作区」
 * 分区不渲染）；mounted 面必须存在——surface 的订阅回退会读 ctx.sessions。
 */
const bareCtx = (): Context => {
  const sidebarRight = {
    mounted: {
      getSnapshot: (): string | undefined => undefined,
      subscribe: (_fn: () => void) => () => {},
    },
  }
  return { get: (name: string) => (name === 'sidebarRight' ? sidebarRight : undefined) } as unknown as Context
}

async function flushClick(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

describe('sshDisplayPath（展示拼写，只影响显示）', () => {
  it('ssh://别名/rest → ssh://别名@/rest；非 ssh:// 拼写原样返回', () => {
    expect(sshDisplayPath('ssh://a/b')).toBe('ssh://a@/b')
    expect(sshDisplayPath('ssh://alias//home/u/proj')).toBe('ssh://alias@//home/u/proj')
    expect(sshDisplayPath('/code/www')).toBe('/code/www')
    expect(sshDisplayPath('ssh://a')).toBe('ssh://a')
    expect(sshDisplayPath('')).toBe('')
  })
})

describe('「远程工作区」状态页', () => {
  it('payload → 概览统计 + 已挂载列表（展示拼写/停用 chip/会话数）+ broken 汇总点 + 事件最新在前', async () => {
    const rendered = await mountPage(bareCtx(), true, overviewPayload())
    try {
      expect(rendered.container.querySelector('[data-dsh-ssh-page]')).not.toBeNull()
      const text = rendered.container.textContent ?? ''
      // 概览四格：主机 2、挂载 2、停用 1、转发 1（label+value 同 span 相连）。
      expect(text).toContain(`${t('sshStatHosts')}2`)
      expect(text).toContain(`${t('sshStatMounted')}2`)
      expect(text).toContain(`${t('sshStatDisabled')}1`)
      expect(text).toContain(`${t('sshStatForwards')}1`)
      // 头部汇总点：任一 broken → role=img + 计数文案（页面唯一的 role=img）。
      const dot = rendered.container.querySelector('[role="img"]')
      expect(dot?.getAttribute('aria-label')).toBe(t('sshConnBroken', { count: 1 }))
      // 已挂载列表：标题行 + 展示拼写（ssh://别名@/路径）+ 会话数 chip。
      expect(text).toContain(t('sshSectionWorkspaces'))
      expect(text).toContain('proj')
      expect(text).toContain('ssh://dev@//home/u/proj')
      expect(text).toContain(t('sshSessionsCount', { count: 2 }))
      // 停用工作区：标题回退到 path + 「已停用」chip。
      expect(text).toContain('ssh://lab@//srv/data')
      // 转发行 target 拼写与 alias chip。
      expect(text).toContain('127.0.0.1:3080 → dev:80')
      // 事件：最多 5 条、最新在前。
      const secondAt = (text ?? '').indexOf('second')
      const firstAt = (text ?? '').indexOf('first')
      expect(secondAt).toBeGreaterThan(-1)
      expect(firstAt).toBeGreaterThan(secondAt)
    } finally {
      rendered.unmount()
    }
  })

  it('复制按钮：写剪贴板的是原始拼写；成功后按钮变「已复制」', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const rendered = await mountPage(bareCtx(), true, overviewPayload())
    try {
      const copy = rendered.container.querySelector(`[aria-label="${t('sshCopy')}"]`)
      if (copy === null) throw new Error('missing copy button')
      await flushClick(copy)
      // 展示是 ssh://dev@//home/u/proj，写进去必须是原始拼写。
      expect(writeText).toHaveBeenCalledWith('ssh://dev//home/u/proj')
      await act(async () => { await Promise.resolve() })
      expect(rendered.container.querySelector(`[aria-label="${t('sshCopied')}"]`)).not.toBeNull()
      // 剪贴板被拒：按钮留在「复制」态，页面不抛错。先等第一颗按钮的
      // 1.5s「已复制」态复位，避免残留态污染断言。
      writeText.mockRejectedValueOnce(new Error('denied'))
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 1_600) }) })
      const copy2 = rendered.container.querySelector(`[aria-label="${t('sshCopy')}"]`)
      if (copy2 === null) throw new Error('missing copy button')
      await flushClick(copy2)
      expect(rendered.container.querySelector(`[aria-label="${t('sshCopied')}"]`)).toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('有过成功数据后的瞬时失败 → 旧数据保留 +「读取失败」行 + 重试；点重试恢复', async () => {
    const rendered = await mountPage(bareCtx(), true, overviewPayload())
    const gateway = getSshWorkspaceGateway()
    try {
      // 拉取转失败：旧数据还在（title 仍渲染），错误行出现。
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
      await act(async () => { await gateway.refresh() })
      expect(rendered.container.querySelector('[data-dsh-ssh-error]')).not.toBeNull()
      const text = rendered.container.textContent ?? ''
      expect(text).toContain(t('sshLoadFailed'))
      expect(text).toContain('proj')
      // 点重试：fetch 恢复 2xx → 错误行消失。
      stubFetchOk(overviewPayload())
      const retry = rendered.container.querySelector('[data-dsh-ssh-error] button')
      if (retry === null) throw new Error('missing retry button')
      await flushClick(retry)
      expect(rendered.container.querySelector('[data-dsh-ssh-error]')).toBeNull()
      expect(rendered.container.textContent).not.toContain(t('sshLoadFailed'))
    } finally {
      rendered.unmount()
    }
  })

  it('不可用（404）→ 空态提示 + tab 描述符 available 门控跟随网关', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    await getSshWorkspaceGateway().probe()
    const rendered = renderRoot(createElement(SshWorkspacePage, { ctx: bareCtx(), visible: false }))
    try {
      const text = rendered.container.textContent ?? ''
      expect(text).toContain(t('sshUnavailable'))
      expect(text).toContain(t('sshLoadFailed')) // 404 的原因也亮出来
      expect(rendered.container.querySelector('[data-dsh-ssh-error]')).toBeNull()
      // 描述符可用性门控：不可用为 false，恢复 2xx 后翻 true。
      const descriptor = createSshWorkspaceTabDescriptor()
      expect(descriptor.id).toBe(SSH_WORKSPACE_TAB_TYPE)
      expect(descriptor.order).toBe(42)
      expect(descriptor.available()).toBe(false)
      stubFetchOk(overviewPayload())
      await act(async () => { await getSshWorkspaceGateway().refresh() })
      expect(descriptor.available()).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('visible=false 不发任何请求；visible=true 挂载即强拉一轮（页面轮询语义）', async () => {
    stubFetchOk(overviewPayload())
    // 从未探测的干净单例：不可见挂载 → 零请求（页面不持有后台定时器）。
    const hidden = renderRoot(createElement(SshWorkspacePage, { ctx: bareCtx(), visible: false }))
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      const fetchMock = vi.mocked(globalThis.fetch)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      hidden.unmount()
    }
    // 可见挂载：effect 立即 refresh 一次。
    const shown = renderRoot(createElement(SshWorkspacePage, { ctx: bareCtx(), visible: true }))
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(shown.container.querySelector('[data-dsh-ssh-page]')).not.toBeNull()
    } finally {
      shown.unmount()
    }
  })
})
