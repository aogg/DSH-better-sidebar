/**
 * dsh-ssh-workspace（远程 SSH 工作区插件）的状态网关 —— 本插件对那个插件的
 * **唯一**探测通道。工厂模式 + Null-object 模式：
 *
 * - {@link createSshWorkspaceGateway} 铸造真实网关：GET
 *   `/api/dsh-ssh-workspace/status`（ssh 插件 lib/routes.js 的
 *   `ROUTES.status`，挂宿主 webServer，同源），2xx → available 并缓存解析后
 *   的 status；404（插件未装）/ 网络错 / 超时（AbortController 4s）→
 *   unavailable。探测按 TTL（60s）定期重试，让「后装插件」也能浮出徽章；
 *   重试失败**不刷 console**（见 {@link RealSshWorkspaceGateway#applyProbe} 的
 *   日志策略注释）。
 * - {@link UnavailableSshWorkspaceGateway} 是 Null-object：available 恒
 *   false，所有方法安全 no-op。模块单例在「从未注册」与「已 dispose」（HMR
 *   / 插件停用）两个窗口都退回它，迟到的读取（仍在挂载的胶囊/页面）拿到
 *   的是恒定不可用的安全空态，而不是半死的真实网关。
 *
 * 网关实例是模块级单例：由 {@link getSshWorkspaceGateway} 取用，
 * {@link disposeSshWorkspaceGateway}（注册 disposer）销毁并复位——重新激活
 * （HMR）时下一次 getSsh 再铸新实例。真实网关在被 probe() 之前完全惰性
 * （无定时器、无 fetch），所以误创建零副作用。
 */
import { hostRouteUrl } from '../host-route-url.ts'

/** ssh 插件 status 路由（hostRouteUrl 走页面基目录，反向代理前缀安全）。 */
const STATUS_ROUTE = 'api/dsh-ssh-workspace/status'

/** 单次探测的超时（AbortController）。 */
const PROBE_TIMEOUT_MS = 4_000

/** 探测重试 TTL：两次探测尝试之间的最小间隔（任务约定 ≥ 60s）。 */
export const SSH_PROBE_RETRY_TTL_MS = 60_000

/**
 * 本插件注册的 tab 类型 id（也是开始页胶囊 `service.openTab({ type })` 的
 * 落点）。放在 gateway 这个文件夹内最低层的共享模块里，让胶囊无须拖上
 * 页面模块（hero 路径保持轻）。
 */
export const SSH_WORKSPACE_TAB_TYPE = 'ssh-workspace'

/**
 * `GET /api/dsh-ssh-workspace/status` 的响应形状（宽松可选：字段缺失/异形
 * 一律由消费端兜底为空，绝不抛）。
 *
 * 来源（dsh-ssh-workspace 源码，只读参考）：
 * - `mounted`: lib/remote-fs.js `listRoots()`（210 行）——规范化的
 *   `ssh://别名/路径` 根数组（185 行 `addRoot` 的 canonical 拼写）；
 * - `disabled`: lib/remote-fs.js `listDisabled()`（248 行）——被停用（detach）
 *   工作区的 ssh:// 路径数组；
 * - `connections`: lib/routes.js 786-790 行——连接池快照
 *   `{ alias, state: 'connected'|'broken', inFlight, idleAt }`；
 * - `workspaces`: lib/routes.js 792-810 行——宿主 workspaceRegistry 里以
 *   `ssh://` 开头的注册工作区 `{ id, path, title, sessionIds }`；
 * - `forwards`: lib/forward.js `#describe()`（199-210 行）——活动转发
 *   `{ id, alias, state, localHost, localPort, remoteHost, remotePort,
 *   connections, reused }`；
 * - `forwardRows` / `forwardSettings`（可选，老版本插件没有）：lib/forward.js
 *   `joinForwards()`（366 行起）——已存映射与活动态的 join 行
 *   `{ …saved, persisted, live, connections, error? }` 与 `{ autoStart }`；
 * - `shells`（可选）：lib/shell.js `list()`（311 行）——持久 shell
 *   `{ alias, session, alive }`；
 * - `events`: lib/diagnostics.js `record()`（75-88 行）——最近 20 条诊断
 *   `{ at, kind, message, alias? }`；
 * - `upstreamWorkarounds`: lib/routes.js 828 行——上游 workaround 结论。
 */
export interface SshWorkspaceStatusPayload {
  /** 已挂载（在服）的规范化 ssh:// 根路径（remote-fs.js listRoots）。 */
  mounted?: unknown[]
  /** 被停用工作区的 ssh:// 路径（remote-fs.js listDisabled）。 */
  disabled?: unknown[]
  /** SSH 连接池快照（routes.js 786-790 行）。 */
  connections?: unknown[]
  /** 注册的远端工作区（routes.js 792-810 行）。 */
  workspaces?: unknown[]
  /** 活动端口转发（forward.js #describe）。 */
  forwards?: unknown[]
  /** 已存映射 join 活动态的行（forward.js joinForwards；老插件缺省）。 */
  forwardRows?: unknown[]
  /** 已存转发的偏好（forward.js settings；老插件缺省）。 */
  forwardSettings?: unknown
  /** 持久 shell 会话（shell.js list；老插件缺省）。 */
  shells?: unknown[]
  /** 最近诊断事件，最旧在前（diagnostics.js list(20)）。 */
  events?: unknown[]
  /** 上游 workaround 结论（routes.js 828 行）。 */
  upstreamWorkarounds?: unknown[]
}

/** 网关对外暴露的不可变快照（React `useSyncExternalStore` 友好：引用稳定）。 */
export interface SshWorkspaceGatewayState {
  /** 插件是否在（最近一次探测 2xx）。 */
  readonly available: boolean
  /** 最近一次成功解析的 status；从未成功或已判不可用时 null。 */
  readonly status: SshWorkspaceStatusPayload | null
  /** 最近一次失败的原因（可读短句）；无失败时 null。 */
  readonly error: string | null
  /** 最近一次探测尝试完成的时间（epoch ms）；从未尝试时 null。 */
  readonly probedAt: number | null
}

/** 网关的公共面：订阅 + 探测 + 销毁。胶囊徽章与状态页共用同一实例。 */
export interface SshWorkspaceGateway {
  getState(): SshWorkspaceGatewayState
  /** 订阅状态变化（引用变化即通知）；返回退订函数。 */
  subscribe(listener: () => void): () => void
  /**
   * 探测一次。`force: false`（默认）受 TTL 约束——距上次**尝试**不足
   * TTL 时直接返回现态不发请求；`force: true`（手动刷新/页面轮询）跳过
   * TTL。Promise 永不 reject：失败折叠进快照的 `error` 字段。
   */
  probe(options?: { force?: boolean }): Promise<SshWorkspaceGatewayState>
  /** 手动强拉（等价 `probe({ force: true })`）。 */
  refresh(): Promise<SshWorkspaceGatewayState>
  /** 停掉定时器与在途请求、清空订阅。之后 probe 一律返回现态（no-op）。 */
  dispose(): void
}

/** 从 unknown 里取数组：非数组一律空数组（payload 宽松消费的兜底）。 */
export function sshArrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

/** 404 与一切「路由不存在」的失败：插件未装/被禁用，判不可用是**定论**。 */
class SshRouteAbsentError extends Error {
  constructor() {
    super('dsh-ssh-workspace status route not found (404)')
    this.name = 'SshRouteAbsentError'
  }
}

/** Null-object：available 恒 false，探测/刷新是立即返回现态的 no-op。 */
export class UnavailableSshWorkspaceGateway implements SshWorkspaceGateway {
  private readonly frozen: SshWorkspaceGatewayState = Object.freeze({
    available: false,
    status: null,
    error: null,
    probedAt: null,
  })

  getState(): SshWorkspaceGatewayState {
    return this.frozen
  }

  subscribe(_listener: () => void): () => void {
    // Null 对象的状态永不变化，订阅即时退订即可（调用方无须感知差异）。
    return () => {}
  }

  async probe(): Promise<SshWorkspaceGatewayState> {
    return this.frozen
  }

  async refresh(): Promise<SshWorkspaceGatewayState> {
    return this.frozen
  }

  dispose(): void {
    // nothing to dispose：空实现即 Null-object 的语义本身。
  }
}

/** 模块级共享的 Null 网关（未注册 / 已销毁窗口的读取落点）。 */
const NULL_GATEWAY = new UnavailableSshWorkspaceGateway()

/** 真实网关：fetch + TTL 定时重试 + 订阅广播。 */
class RealSshWorkspaceGateway implements SshWorkspaceGateway {
  private state: SshWorkspaceGatewayState = Object.freeze({
    available: false,
    status: null,
    error: null,
    probedAt: null,
  })
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  /** 上次探测**尝试**开始的时间（TTL 按尝试计，超时也占窗口）。 */
  private lastAttemptAt = 0
  /** 在途请求的控制器：新探测顶掉旧探测（stale 响应不作数）。 */
  private inFlight: AbortController | undefined
  private disposed = false
  /** 是否已对「可用 → 不可用」发过一次 warn（重试期间静默）。 */
  private warnedUnavailable = false

  getState(): SshWorkspaceGatewayState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  probe(options?: { force?: boolean }): Promise<SshWorkspaceGatewayState> {
    if (this.disposed) return Promise.resolve(this.state)
    const force = options?.force === true
    const sinceAttempt = Date.now() - this.lastAttemptAt
    if (!force && this.lastAttemptAt !== 0 && sinceAttempt < SSH_PROBE_RETRY_TTL_MS) {
      return Promise.resolve(this.state)
    }
    return this.fetchNow()
  }

  refresh(): Promise<SshWorkspaceGatewayState> {
    return this.probe({ force: true })
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.inFlight?.abort()
    this.inFlight = undefined
    this.listeners.clear()
  }

  /** 发起一次真实探测并落地快照（含通知与日志策略）。 */
  private async fetchNow(): Promise<SshWorkspaceGatewayState> {
    this.lastAttemptAt = Date.now()
    // 定时重试通道在这里顺带建立：首次 probe 之前网关完全惰性（测试环境只
    // 渲染胶囊不触发 probe，就没有任何定时器与请求）。
    this.ensureTimer()
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    const timeout = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
    try {
      const response = await fetch(hostRouteUrl(STATUS_ROUTE).toString(), {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) {
        // 路由不存在（未装插件）与被禁用都落在这里；404 是**预期答案**，
        // 不是故障——判不可用即止。
        if (response.status === 404) throw new SshRouteAbsentError()
        throw new Error(`dsh-ssh-workspace status HTTP ${response.status}`)
      }
      const payload = await response.json() as unknown
      if (payload === null || typeof payload !== 'object') {
        throw new Error('dsh-ssh-workspace status payload is not an object')
      }
      this.apply({
        available: true,
        status: payload as SshWorkspaceStatusPayload,
        error: null,
        probedAt: Date.now(),
      })
    } catch (error) {
      this.applyFailure(error)
    } finally {
      clearTimeout(timeout)
      if (this.inFlight === controller) this.inFlight = undefined
    }
    return this.state
  }

  /**
   * 失败落地。可用性判定（任务约定）：
   * - 404（路由不存在：未装 / 被禁用）→ 定论不可用：available=false、
   *   status 清空（零痕迹的依据）；
   * - 其余（网络错、超时、非 JSON）→ **瞬时失败**：若手上有旧 status 则
   *   保持 available（页面显示「读取失败 + 旧数据 + 重试」），否则判不可用。
   *
   * 日志策略（抑制已注释）：探测是「在场检查」，未装插件时 404 与网络错是
   * 常态路径；TTL 重试一旦开始，每次失败都 console 会刷屏（任务明令禁止）。
   * 失败原因不丢——落在快照 `error` 字段里，状态页会展示。只在
   * 「可用 → 不可用」的状态翻转上发一次 console.warn（真实故障信号），
   * 之后保持静默，直到再次可用后重置。
   */
  private applyFailure(error: unknown): void {
    const absent = error instanceof SshRouteAbsentError
    const hadStatus = this.state.status !== null
    const wasAvailable = this.state.available
    if (!absent && hadStatus) {
      // 瞬时失败 + 有旧数据：保持可用，错误留给页面渲染。
      this.publish({
        available: true,
        status: this.state.status,
        error: error instanceof Error ? error.message : String(error),
        probedAt: Date.now(),
      })
      return
    }
    this.publish({
      available: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      probedAt: Date.now(),
    })
    // 只在「可用 → 不可用」的翻转上发一次 warn；从未可用的连续失败（未装
    // 插件的常态）全程静默，warnedUnavailable 由下次成功探测重置。
    if (wasAvailable && !this.warnedUnavailable) {
      this.warnedUnavailable = true
      console.warn(`[dsh-better-sidebar] ssh-workspace gateway unavailable: ${
        error instanceof Error ? error.message : String(error)}`)
    }
  }

  private apply(next: SshWorkspaceGatewayState): void {
    this.warnedUnavailable = false
    this.publish(next)
  }

  private publish(next: SshWorkspaceGatewayState): void {
    this.state = Object.freeze({ ...next })
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        // 订阅者异常不拖垮广播（React 渲染期抛错自有边界接管）；此处只留
        // 痕迹，绝不静默——与角色规则一致。
        console.error('[dsh-better-sidebar] ssh-workspace gateway listener failed:', error)
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.disposed) return
    this.timer = setInterval(() => {
      // TTL 门控在 probe() 内（lastAttemptAt）；定时触发一律非 force。
      void this.probe()
    }, SSH_PROBE_RETRY_TTL_MS)
  }
}

/** 工厂：铸造真实网关（每次调用一个新实例；单例走 getSshWorkspaceGateway）。 */
export function createSshWorkspaceGateway(): SshWorkspaceGateway {
  return new RealSshWorkspaceGateway()
}

/** 模块级单例。未创建 / 已销毁时是 Null-object（安全空态）。 */
let singleton: SshWorkspaceGateway = NULL_GATEWAY

/** 取单例；Null 态下惰性铸造真实网关（真实实例在 probe 前零副作用）。 */
export function getSshWorkspaceGateway(): SshWorkspaceGateway {
  if (singleton === NULL_GATEWAY) singleton = createSshWorkspaceGateway()
  return singleton
}

/**
 * 销毁单例并复位到 Null-object（注册 disposer 专用；HMR / 插件停用时，
 * 仍在挂载的胶囊/页面读到的下一个快照就是恒定不可用的安全空态）。重新
 * 激活时 getSshWorkspaceGateway 会再铸新实例。
 */
export function disposeSshWorkspaceGateway(): void {
  const outgoing = singleton
  singleton = NULL_GATEWAY
  outgoing.dispose()
}
