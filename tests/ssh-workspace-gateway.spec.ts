/**
 * ssh-workspace 网关（src/client/ssh-workspace/gateway.ts）。
 *
 * fetch 全程用 vi.stubGlobal 拦截（绝不发真实请求），定时器用
 * vi.useFakeTimers 控制（探测超时 4s 的 AbortController + TTL 60s 的
 * setInterval 重试）。钉住：2xx→available 且 status 缓存、404→定论不可用
 * 且 status 清空、网络错/超时→无旧数据判不可用（有旧数据保可用并记
 * error）、TTL 内不重复探测且 TTL 过后（含定时器通道）重试、force 跳过
 * TTL、不可用翻转只 warn 一次、listener 异常不拖垮广播、
 * UnavailableSshWorkspaceGateway 全方法 no-op 且 available 恒 false、
 * getSsh/disposeSsh 单例生命周期（dispose 后迟到读取安全）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSshWorkspaceGateway,
  disposeSshWorkspaceGateway,
  getSshWorkspaceGateway,
  SSH_PROBE_RETRY_TTL_MS,
  sshArrayOf,
  SSH_WORKSPACE_TAB_TYPE,
  UnavailableSshWorkspaceGateway,
  type SshWorkspaceGatewayState,
} from '../src/client/ssh-workspace/gateway.ts'

/** 探测路由（gateway 唯一会打到的地址，形态钉死防漂移）。 */
const STATUS_ROUTE = 'api/dsh-ssh-workspace/status'

type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response>

/** 用假体换掉全局 fetch；返回 vi.fn 供调用数/参数断言。 */
function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** 2xx 假应答（payload 原样返回）。 */
function okResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response
}

/** 404 假应答（路由不存在：插件未装/被禁用）。 */
function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    json: async () => { throw new Error('404 body must not be parsed') },
  } as unknown as Response
}

/** 永不主动完成的应答：只在 signal 中止时以 AbortError 拒绝（真实 fetch 语义）。 */
function hangingUntilAbort(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}

const payload = (): Record<string, unknown> => ({
  mounted: ['ssh://dev//home/u/a'],
  connections: [{ alias: 'dev', state: 'connected', inFlight: 0 }],
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // 单例归零：别让任何用例的真实网关（带着定时器）漏进下一个用例。
  disposeSshWorkspaceGateway()
})

describe('sshArrayOf（payload 宽松兜底）', () => {
  it('数组原样透传（同一引用），非数组一律空数组', () => {
    const list = ['ssh://dev//home/u/a']
    expect(sshArrayOf(list)).toBe(list)
    expect(sshArrayOf(undefined)).toEqual([])
    expect(sshArrayOf(null)).toEqual([])
    expect(sshArrayOf('ssh://dev//home/u/a')).toEqual([])
    expect(sshArrayOf({ length: 1 })).toEqual([])
  })
})

describe('createSshWorkspaceGateway（真实网关探测）', () => {
  it('2xx → available 且解析后的 status 被缓存；请求打在 status 路由且 no-store', async () => {
    const body = payload()
    const fetchMock = stubFetch(url => {
      expect(url).toContain(STATUS_ROUTE)
      return Promise.resolve(okResponse(body))
    })
    const gateway = createSshWorkspaceGateway()
    const state = await gateway.probe()
    expect(state.available).toBe(true)
    expect(state.status).toBe(body)
    expect(state.error).toBeNull()
    expect(state.probedAt).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.cache).toBe('no-store')
  })

  it('404 → 定论不可用：available=false 且 status 清空（零痕迹）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(() => Promise.resolve(notFoundResponse()))
    const gateway = createSshWorkspaceGateway()
    const state = await gateway.probe()
    expect(state.available).toBe(false)
    expect(state.status).toBeNull()
    expect(state.error).toContain('404')
    expect(state.probedAt).not.toBeNull()
    // 从未可用过的失败是常态路径：不刷 console。
    expect(warn).not.toHaveBeenCalled()
  })

  it('非对象 payload（异形应答）→ 判不可用并记 error，绝不抛', async () => {
    stubFetch(() => Promise.resolve(okResponse('not an object')))
    const gateway = createSshWorkspaceGateway()
    const state = await gateway.probe()
    expect(state.available).toBe(false)
    expect(state.status).toBeNull()
    expect(state.error).toContain('not an object')
  })

  it('网络错（fetch 拒绝）且无旧数据 → 判不可用；error 落快照不抛出', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    const gateway = createSshWorkspaceGateway()
    const state = await gateway.probe()
    expect(state.available).toBe(false)
    expect(state.status).toBeNull()
    expect(state.error).toBe('Failed to fetch')
    expect(warn).not.toHaveBeenCalled()
  })

  it('有旧数据的瞬时失败 → 保可用、旧 status 原样保留、error 记原因；「可用→不可用」翻转只 warn 一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = payload()
    let fail = false
    stubFetch(() => fail
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(okResponse(body)))
    const gateway = createSshWorkspaceGateway()
    const good = await gateway.probe()
    expect(good.available).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    fail = true
    const degraded = await gateway.refresh()
    // 瞬时失败 + 有旧数据：available 保持，页面走「读取失败 + 旧数据 + 重试」。
    expect(degraded.available).toBe(true)
    expect(degraded.status).toBe(body)
    expect(degraded.error).toBe('Failed to fetch')
    // 可用性没翻转（仍可用）：warn 一声都不发，翻转发声只属于「可用→不可用」。
    expect(warn).not.toHaveBeenCalled()
    const again = await gateway.refresh()
    expect(again.available).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('可用→不可用（404 清空旧数据）的翻转发一次 warn；再次可用后重置', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let mode: 'ok' | 'notfound' = 'ok'
    stubFetch(() => Promise.resolve(mode === 'ok' ? okResponse(payload()) : notFoundResponse()))
    const gateway = createSshWorkspaceGateway()
    await gateway.probe()
    expect(warn).not.toHaveBeenCalled()
    mode = 'notfound'
    const down = await gateway.refresh()
    expect(down.available).toBe(false)
    expect(down.status).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    mode = 'ok'
    const back = await gateway.refresh()
    expect(back.available).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1) // 重置后的失败才允许再 warn
    mode = 'notfound'
    await gateway.refresh()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('超时（AbortController 4s）→ 无旧数据判不可用；且该次尝试占住 TTL 窗口（立即重探不复发请求）', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch((_url, init) => hangingUntilAbort(init))
    const gateway = createSshWorkspaceGateway()
    const pending = gateway.probe()
    await vi.advanceTimersByTimeAsync(4_000)
    const state = await pending
    expect(state.available).toBe(false)
    expect(state.status).toBeNull()
    expect(state.error).toBeTruthy()
    // 超时也算一次尝试：TTL 内再 probe 直接返回现态。
    const again = await gateway.probe()
    expect(again).toBe(state)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('TTL 内不重复探测；TTL 过后定时器通道自动重试；force 跳过 TTL', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(() => Promise.resolve(okResponse(payload())))
    const gateway = createSshWorkspaceGateway()
    await gateway.probe()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // TTL 门控按「尝试」计：立即重探不发请求。
    await gateway.probe()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 网关自建的 setInterval（TTL 节拍）到期自动重试。
    await vi.advanceTimersByTimeAsync(SSH_PROBE_RETRY_TTL_MS + 1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 定时器刚探过：又落在 TTL 窗口内。
    await gateway.probe()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // force（手动刷新/页面轮询）无视 TTL。
    await gateway.probe({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('subscribe 广播状态变化；listener 抛错不拖垮其余订阅者（error 留痕一次）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => Promise.resolve(okResponse(payload())))
    const gateway = createSshWorkspaceGateway()
    const seen: SshWorkspaceGatewayState[] = []
    let firstCalls = 0
    const unsubscribe = gateway.subscribe(() => {
      firstCalls += 1
      throw new Error('listener boom')
    })
    gateway.subscribe(() => { seen.push(gateway.getState()) })
    await gateway.probe()
    expect(firstCalls).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.available).toBe(true)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    unsubscribe()
    await gateway.probe({ force: true })
    expect(firstCalls).toBe(1) // 退订后不再被叫
  })

  it('dispose 后：定时器清空、probe 返回现态不复发请求、subscribe 即时退订', async () => {
    vi.useFakeTimers()
    const fetchMock = stubFetch(() => Promise.resolve(okResponse(payload())))
    const gateway = createSshWorkspaceGateway()
    await gateway.probe()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const listener = vi.fn()
    gateway.dispose()
    gateway.subscribe(listener)
    await vi.advanceTimersByTimeAsync(SSH_PROBE_RETRY_TTL_MS * 3)
    const state = await gateway.probe()
    expect(fetchMock).toHaveBeenCalledTimes(1) // 定时器没了、probe 也 no-op
    expect(listener).not.toHaveBeenCalled()
    expect(state.available).toBe(true) // 返回的是销毁前的现态（安全旧值）
  })
})

describe('UnavailableSshWorkspaceGateway（Null-object）', () => {
  it('available 恒 false、四字段全空、probe/refresh 立即返回同一冻结快照', async () => {
    const gateway = new UnavailableSshWorkspaceGateway()
    const state = gateway.getState()
    expect(state).toEqual({ available: false, status: null, error: null, probedAt: null })
    expect(Object.isFrozen(state)).toBe(true)
    await expect(gateway.probe()).resolves.toBe(state)
    await expect(gateway.refresh()).resolves.toBe(state)
    await expect(gateway.probe({ force: true })).resolves.toBe(state)
    expect(() => { gateway.dispose() }).not.toThrow()
  })

  it('subscribe 返回退订函数且监听器永不触发', async () => {
    const gateway = new UnavailableSshWorkspaceGateway()
    const listener = vi.fn()
    const unsubscribe = gateway.subscribe(listener)
    expect(typeof unsubscribe).toBe('function')
    expect(() => { unsubscribe() }).not.toThrow()
    await gateway.probe()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('getSshWorkspaceGateway / disposeSshWorkspaceGateway（模块单例）', () => {
  it('未探测前惰性：取单例零请求零定时器；重复取是同一实例', () => {
    const fetchMock = stubFetch(() => Promise.resolve(okResponse(payload())))
    const first = getSshWorkspaceGateway()
    expect(getSshWorkspaceGateway()).toBe(first)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dispose 后回到 Null 态：下一次 getSsh 铸新实例（fresh 不可用），旧引用 probe 不复发请求', async () => {
    stubFetch(() => Promise.resolve(okResponse(payload())))
    const first = getSshWorkspaceGateway()
    await first.probe()
    expect(first.getState().available).toBe(true)
    disposeSshWorkspaceGateway()
    // 迟到的读取（仍在挂载的胶囊/页面）：拿到的是恒定不可用的安全空态。
    const second = getSshWorkspaceGateway()
    expect(second).not.toBe(first)
    expect(second.getState()).toEqual({ available: false, status: null, error: null, probedAt: null })
    // 半死的旧实例自身也安全：probe no-op、dispose 幂等。
    const fetchMock = vi.mocked(globalThis.fetch)
    await expect(first.probe()).resolves.toBe(first.getState())
    expect(fetchMock).toHaveBeenCalledTimes(1) // 只有最初那次成功探测
    expect(() => { first.dispose() }).not.toThrow()
  })

  it('tab 类型常量钉死（openTab 的落点不能漂）', () => {
    expect(SSH_WORKSPACE_TAB_TYPE).toBe('ssh-workspace')
  })
})
