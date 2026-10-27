/**
 * 开始页「远程工作区」胶囊（src/client/ssh-workspace/start-pill.tsx）。
 *
 * 网关走真实单例（fetch 用 vi.stubGlobal 拦截，绝不发真实请求），渲染用
 * test-utils 的 renderRoot。钉住六件事：网关不可用（404）→ 渲染 null
 * （零 DOM，开始页网格里不留格子）；可用 → 胶囊出现且徽章数字 = mounted
 * 数（0 不出数字 chip）；全部 connected → 状态点是 aria-hidden 小圆点，
 * 任一 broken → 变 role=img 警示并报「N broken」；当前会话工作区是
 * ssh:// → 追加「远程」标记（本地路径没有）；aria/title 用 guide 说明
 * 文案；点击走 service.openTab({ type: 'ssh-workspace' })；不可用态挂载后
 * 探测转可用 → 订阅实时把胶囊顶出来。
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { createElement } from 'react'
import { setupReactAct, renderRoot, type RenderedRoot } from './test-utils.ts'
import { SshWorkspaceStartPill } from '../src/client/ssh-workspace/start-pill.tsx'
import { disposeSshWorkspaceGateway, getSshWorkspaceGateway, SSH_WORKSPACE_TAB_TYPE } from '../src/client/ssh-workspace/gateway.ts'
import { t } from '../src/client/locales.ts'
import type { BetterSidebarService } from '../src/client/service.ts'
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

interface CtxOptions {
  /** 在屏会话 id（undefined = 无在屏会话）。 */
  mounted?: string | undefined
  /** 工作区注册表条目（path + sessionIds 成员）。 */
  workspaceItems?: readonly { path: string; sessionIds: readonly string[] }[] | undefined
}

/** 最小 ctx 假体：sidebarRight.mounted（在屏会话喂）+ workspaces.list（按会话匹配路径）。 */
function makeCtx(options: CtxOptions = {}): Context {
  const sidebarRight = {
    mounted: {
      getSnapshot: (): string | undefined => options.mounted,
      subscribe: (_fn: () => void) => () => {},
    },
  }
  const workspaces = options.workspaceItems === undefined ? undefined : {
    list: {
      getSnapshot: () => ({ phase: 'ready', state: 'idle', items: options.workspaceItems }),
      subscribe: (_fn: () => void) => () => {},
    },
  }
  return {
    get: (name: string) => {
      if (name === 'sidebarRight') return sidebarRight
      if (name === 'workspaces') return workspaces
      return undefined
    },
  } as unknown as Context
}

const fakeService = (): { service: BetterSidebarService; openTab: ReturnType<typeof vi.fn> } => {
  const openTab = vi.fn()
  return { service: { openTab } as unknown as BetterSidebarService, openTab }
}

/** 用探测把单例网关推进给定状态（挂载前完成，避免 act 外的 store 广播）。 */
async function primeGateway(response: 'ok' | 'notfound'): Promise<void> {
  const payload = {
    mounted: ['ssh://dev//home/u/a', 'ssh://dev//home/u/b'],
    connections: [{ alias: 'dev', state: 'connected' }],
  }
  vi.stubGlobal('fetch', vi.fn(async () => response === 'ok'
    ? { ok: true, status: 200, json: async () => payload } as unknown as Response
    : { ok: false, status: 404 } as unknown as Response))
  await getSshWorkspaceGateway().probe()
}

/** 挂一次胶囊（断言前已 prime）。 */
function mountPill(ctx: Context): { rendered: RenderedRoot; openTab: ReturnType<typeof vi.fn> } {
  const { service, openTab } = fakeService()
  const rendered = renderRoot(createElement(SshWorkspaceStartPill, { ctx, service }))
  return { rendered, openTab }
}

describe('开始页「远程工作区」胶囊', () => {
  it('网关不可用（404，插件未装）→ 渲染 null：零 DOM，网格里不留格子', async () => {
    await primeGateway('notfound')
    const { rendered } = mountPill(makeCtx({ mounted: 's1' }))
    try {
      expect(rendered.container.innerHTML).toBe('')
      expect(rendered.container.childNodes).toHaveLength(0)
      expect(document.querySelector('[data-dsh-start-link]')).toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('可用 → 胶囊出现：tab 落点、说明文案（aria/title）、徽章数字 = mounted 数', async () => {
    await primeGateway('ok')
    const { rendered, openTab } = mountPill(makeCtx({ mounted: 's1' }))
    try {
      const pill = rendered.container.querySelector(`[data-dsh-start-link="${SSH_WORKSPACE_TAB_TYPE}"]`)
      expect(pill, '可用时胶囊必须出现').not.toBeNull()
      expect(pill?.getAttribute('aria-label')).toBe(t('guideDescSshWorkspace'))
      expect(pill?.getAttribute('title')).toBe(t('guideDescSshWorkspace'))
      // 徽章三件套之外的文本只有 label：2 个已挂载 → 数字 chip「2」。
      expect(pill?.textContent).toBe(`${t('sshWorkspacePage')}2`)
      expect(openTab).not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
    }
  })

  it('mounted 为 0 → 不出数字 chip（只有 label 文本）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ mounted: [], connections: [] }),
    }) as unknown as Response))
    await getSshWorkspaceGateway().probe()
    const { rendered } = mountPill(makeCtx({ mounted: 's1' }))
    try {
      const pill = rendered.container.querySelector('[data-dsh-start-link]')
      expect(pill?.textContent).toBe(t('sshWorkspacePage'))
    } finally {
      rendered.unmount()
    }
  })

  it('全部 connected → 状态点是 aria-hidden 小圆点；任一 broken → role=img 警示并报「N broken」', async () => {
    await primeGateway('ok')
    const first = mountPill(makeCtx({ mounted: 's1' }))
    try {
      expect(first.rendered.container.querySelector('[role="img"]')).toBeNull()
      expect(first.rendered.container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    } finally {
      first.rendered.unmount()
    }
    // 任一连接 broken：同一颗点换警示语义，文案带计数。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        mounted: ['ssh://dev//home/u/a'],
        connections: [
          { alias: 'dev', state: 'connected' },
          { alias: 'lab', state: 'broken' },
        ],
      }),
    }) as unknown as Response))
    disposeSshWorkspaceGateway()
    await getSshWorkspaceGateway().probe()
    const second = mountPill(makeCtx({ mounted: 's1' }))
    try {
      const dot = second.rendered.container.querySelector('[role="img"]')
      expect(dot).not.toBeNull()
      expect(dot?.getAttribute('aria-label')).toBe(t('sshConnBroken', { count: 1 }))
    } finally {
      second.rendered.unmount()
    }
  })

  it('当前会话工作区是 ssh:// → 追加「远程」标记；本地路径 → 没有', async () => {
    await primeGateway('ok')
    const remote = mountPill(makeCtx({
      mounted: 's1',
      workspaceItems: [{ path: 'ssh://dev//home/u/proj', sessionIds: ['s1'] }],
    }))
    try {
      // DOM 顺序：label → 数字 chip → 状态点（无文本）→ 远程标记。
      expect(remote.rendered.container.querySelector('[data-dsh-start-link]')?.textContent)
        .toBe(`${t('sshWorkspacePage')}2${t('sshRemoteMark')}`)
    } finally {
      remote.rendered.unmount()
    }
    const local = mountPill(makeCtx({
      mounted: 's1',
      workspaceItems: [{ path: '/code/www/my/github/DSH-better-sidebar', sessionIds: ['s1'] }],
    }))
    try {
      expect(local.rendered.container.querySelector('[data-dsh-start-link]')?.textContent)
        .toBe(`${t('sshWorkspacePage')}2`)
    } finally {
      local.rendered.unmount()
    }
  })

  it('点击 → service.openTab({ type: "ssh-workspace" })（状态页落点）', async () => {
    await primeGateway('ok')
    const { rendered, openTab } = mountPill(makeCtx({ mounted: 's1' }))
    try {
      const pill = rendered.container.querySelector('[data-dsh-start-link]')
      if (pill === null) throw new Error('missing ssh-workspace pill')
      act(() => { pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      expect(openTab).toHaveBeenCalledTimes(1)
      expect(openTab).toHaveBeenCalledWith({ type: SSH_WORKSPACE_TAB_TYPE })
      expect(openTab).toHaveBeenCalledWith({ type: 'ssh-workspace' })
    } finally {
      rendered.unmount()
    }
  })

  it('不可用态挂载（null）后探测转可用 → 订阅实时把胶囊顶出来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    await getSshWorkspaceGateway().probe()
    const { rendered } = mountPill(makeCtx({ mounted: 's1' }))
    try {
      expect(rendered.container.querySelector('[data-dsh-start-link]')).toBeNull()
      // 后装插件浮出：TTL 重试/页面轮询拿到 2xx，订阅推给已挂载的胶囊。
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ mounted: ['ssh://dev//home/u/a'], connections: [] }),
      }) as unknown as Response))
      await act(async () => { await getSshWorkspaceGateway().refresh() })
      expect(rendered.container.querySelector('[data-dsh-start-link="ssh-workspace"]')).not.toBeNull()
    } finally {
      rendered.unmount()
    }
  })
})
