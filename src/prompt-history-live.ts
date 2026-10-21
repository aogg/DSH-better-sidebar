/**
 * 「历史发送」种子扫描 + 实时记录（host half）。
 *
 * 发送记录的持久仓（prompt-history-persist.ts）只回答「已经记下的」，本模块
 * 负责把会话日志里还没有记账的部分喂进去：
 *
 * - 种子扫描（懒触发）：第一次 history.list 命中某项目且内存无该项目时后台
 *   跑 `ensureProject`，路由立即返回现有内容 + `seeding:true`，绝不让首屏
 *   等扫描。扫描枚举 `sessionPersistence.list()`（能力缺席/列取失败 → 降级
 *   只扫当前会话，degraded=true），按 header.cwd 过滤当前项目（等于项目根
 *   或位于其下，path.sep 边界）；每个会话按 meta 水位 `read(lastSeq+1, …)`
 *   续扫（覆盖 dsh 重启空窗），无水位从头扫，复用 extractSendRecords（首窗
 *   传 inheritedEventCount，fork 种子不重复记账），窗口 1000×100 的防御上限
 *   与旧版读路径一致；扫完置 seeding=false，同项目并发防重入。
 * - 实时记录：挂载时订阅 `ctx.on('session/event')`，`user/message` 事件经
 *   extractSendRecords（注入消息已被它过滤）抽取后归属项目并 append；ctx.on
 *   缺席（测试替身）静默跳过。扫描与实时的竞态靠记录 key 幂等（谁先到谁记账，
 *   后到的被 byKey 挡住），且推送出口与存储幂等同源——appendRecords 只回本次
 *   真正新收的 fresh，emitRecords 只发 fresh，重复账绝不二次出站。
 * - 推送出口：新记录经 `onRecords` 注册的 sink 交给 ws hub（session-push 的
 *   `notifyHistory`），sink 异常不回流事件源。种子扫描期间每次 append 的新账
 *   同样走 onRecords——扫描期不再依赖客户端轮询补账，watch 中的会话实时收到。
 * - seeding 状态：kick 标记扫描开始、扫描收尾（含降级/失败）置 false，翻转经
 *   `onSeed` 注册的 sink 交给 ws hub（`notifyHistorySeed` 广播）——客户端的
 *   seeding 提示条与扫描完成后的「补拉一次首页」由该帧驱动，无需轮询。
 *   卸载由调用方（index.ts 的 ctx.effect）触发 dispose。
 *
 * 当前会话的项目根解析（{@link resolveProjectRootOf}）：活会话 header.cwd
 * 优先（容错 `.session.header.cwd` 形态），持久 header 兜底（session.cwd 路
 * 由 sessionCwdOf 的降级链，去掉 process.cwd 兜底——解析不出就交给调用方降
 * 级），最后按 session.cwd 的 root 语义过一遍活跃 worktree 解析（失败回落
 * cwd 本身）。
 * @module dsh-better-sidebar/prompt-history-live
 */
import type { Context, SidebarSessionEvent, SidebarSessionPersistenceService } from './context-types.ts'
import { activeWorktreeRootOf } from './active-worktree.ts'
import { readPersistedSessionOf } from './session-store.ts'
import { extractSendRecords, type HistorySendRecord, type HistorySourceEvent } from './prompt-history-extract.ts'
import { cwdIsUnderProject, projectKeyOf, type PromptHistoryStore } from './prompt-history-persist.ts'

/** 持久读取的事件窗口（每窗条数；整份日志从不整段驻留；同旧版读路径）。 */
export const HISTORY_READ_WINDOW = 1000

/** 单会话最多读多少窗（1000×100 = 10 万事件的防御上限，超出按窗口截断）。 */
export const HISTORY_READ_WINDOW_MAX = 100

/** 种子扫描 + 实时记录器的公开面（路由与 index.ts 只依赖这些成员）。 */
export interface PromptHistoryLive {
  /**
   * 懒触发某项目的种子扫描（幂等）：内存无该项目时标记 seeding 并后台起扫，
   * 已载入/扫描中的项目直接返回。绝不等待扫描完成。
   */
  kick(projectKey: string, projectRoot: string, currentSessionId?: string): void
  /** 该项目当前是否在扫描（路由的 seeding 字段）。 */
  isSeeding(projectKey: string): boolean
  /** 该项目上一次扫描是否降级（list 能力缺席）；从未扫描过为 undefined。 */
  degradedOf(projectKey: string): boolean | undefined
  /** 新记录 sink（ws 推送挂点）；返回退订函数。扫描期与实时路径都走这里。 */
  onRecords(sink: (sessionId: string, records: readonly HistorySendRecord[]) => void): () => void
  /**
   * seeding 状态 sink（ws 广播挂点）；返回退订函数。`seeding:true` = 该项目
   * 种子扫描开始，`false` = 扫描收尾（成功/降级/失败都发）。projectRoot 与
   * history.list 的 `project.cwd` 同源（同一解析路径），客户端按它认领。
   */
  onSeed(sink: (projectRoot: string, seeding: boolean) => void): () => void
  /** 退订事件源并清空 sink（幂等）。 */
  dispose(): void
}

export interface PromptHistoryLiveOptions {
  logger?: { warn?(message: string, error?: unknown): void }
}

/**
 * 解析当前会话的项目根：活会话 header.cwd → 持久 header.cwd → 活跃 worktree
 * （session.cwd 路由同款语义；失败回落 cwd 本身）。解析不出返回 undefined，
 * 由调用方降级（只扫/只读当前会话）。
 */
export async function resolveProjectRootOf(ctx: Context, sessionId: string | undefined | null): Promise<string | undefined> {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const live = ctx.sessions?.get(sessionId) as
    | { header?: { cwd?: unknown }; session?: { header?: { cwd?: unknown } } }
    | undefined
  const liveCwd = cwdStringOf(live?.header?.cwd) ?? cwdStringOf(live?.session?.header?.cwd)
  let base = liveCwd
  if (base === undefined) {
    const persisted = await readPersistedSessionOf(ctx, sessionId)
    base = cwdStringOf(persisted?.header?.cwd)
  }
  if (base === undefined) return undefined
  try {
    // 与 session.cwd 路由同一 root 语义（活跃 worktree 优先）；TTL 缓存在内。
    return await activeWorktreeRootOf(ctx, sessionId, base)
  } catch {
    return base
  }
}

function cwdStringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 组装种子扫描 + 实时记录器。
 * @param ctx - host plugin context（sessionPersistence / sessions / on）。
 * @param store - 发送记录持久仓（append 与水位都落在这里）。
 * @param options - logger 注入口（测试可换）。
 */
export function createPromptHistoryLive(ctx: Context, store: PromptHistoryStore, options?: PromptHistoryLiveOptions): PromptHistoryLive {
  const warn = (message: string, error?: unknown): void => {
    options?.logger?.warn?.(message, error)
  }
  const sinks = new Set<(sessionId: string, records: readonly HistorySendRecord[]) => void>()
  const seedSinks = new Set<(projectRoot: string, seeding: boolean) => void>()
  const scanning = new Set<string>()
  const degradedByProject = new Map<string, boolean>()

  const emitRecords = (sessionId: string, records: readonly HistorySendRecord[]): void => {
    if (records.length === 0) return
    for (const sink of sinks) {
      try {
        sink(sessionId, records)
      } catch (error) {
        // 一个坏 sink 不能把事件源（进而把宿主会话）拖挂。
        warn('dsh-better-sidebar: prompt-history push sink failed', error)
      }
    }
  }

  const emitSeed = (projectRoot: string, seeding: boolean): void => {
    for (const sink of seedSinks) {
      try {
        sink(projectRoot, seeding)
      } catch (error) {
        warn('dsh-better-sidebar: prompt-history seed-state sink failed', error)
      }
    }
  }

  const persistenceOf = (): SidebarSessionPersistenceService | undefined => ctx.get('sessionPersistence')

  /** 扫描范围：list 能力枚举 + 项目过滤；缺席/失败降级为只扫当前会话。 */
  const sessionScopeOf = async (projectRoot: string, currentSessionId: string | undefined): Promise<{ ids: string[]; degraded: boolean }> => {
    const persistence = persistenceOf()
    if (typeof persistence?.list === 'function') {
      try {
        const listed = await persistence.list()
        const ids: string[] = []
        for (const row of listed) {
          const id = (row?.header as { id?: unknown } | undefined)?.id
          if (typeof id !== 'string' || id === '' || ids.includes(id)) continue
          const cwd = (row?.header as { cwd?: unknown } | undefined)?.cwd
          if (typeof cwd === 'string' && cwdIsUnderProject(cwd, projectRoot)) ids.push(id)
        }
        if (currentSessionId !== undefined && !ids.includes(currentSessionId)) ids.push(currentSessionId)
        return { ids, degraded: false }
      } catch (error) {
        warn('dsh-better-sidebar: stored session header list failed; prompt-history seed scan degrades to the current session', error)
      }
    }
    return { ids: currentSessionId !== undefined ? [currentSessionId] : [], degraded: true }
  }

  /** 扫一个会话：水位续扫持久日志（窗口防御），无持久层时退化为活快照一次抽。
   *  每窗 append 的新账即时 emitRecords——扫描期 watch 该会话的客户端实时收账，
   *  不再靠轮询。 */
  const scanSession = async (projectKey: string, sessionId: string): Promise<void> => {
    const persistence = persistenceOf()
    if (persistence === undefined) {
      const live = ctx.sessions?.get(sessionId) as { snapshotEvents?: () => readonly SidebarSessionEvent[] } | undefined
      const events = typeof live?.snapshotEvents === 'function' ? live.snapshotEvents() : undefined
      if (events === undefined) return
      const extracted = extractSendRecords(sessionId, events as readonly HistorySourceEvent[]).records
      if (extracted.length === 0) return
      const lastSeq = (events as readonly { seq?: unknown }[]).at(-1)?.seq
      const fresh = await store.appendRecords(
        projectKey,
        extracted,
        typeof lastSeq === 'number' && Number.isSafeInteger(lastSeq) ? { [sessionId]: lastSeq } : undefined,
      )
      emitRecords(sessionId, fresh)
      return
    }
    const entry = await store.loadProject(projectKey)
    const watermark = entry.watermarks[sessionId]
    const handle = await persistence.open(sessionId, 'read')
    try {
      const inherited = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0
      let offset = typeof watermark === 'number' && Number.isSafeInteger(watermark) && watermark >= 0 ? watermark + 1 : 0
      for (let page = 0; page < HISTORY_READ_WINDOW_MAX; page++) {
        const { events } = await handle.read(offset, HISTORY_READ_WINDOW)
        if (events.length === 0) break
        const windowRecords = extractSendRecords(sessionId, events as readonly HistorySourceEvent[], {
          // inheritedEventCount 只在首窗有意义（窗口推进后种子前缀早已越过）。
          inheritedEventCount: offset === 0 ? inherited : 0,
        }).records
        const lastSeq = (events as readonly { seq?: unknown }[]).at(-1)?.seq
        if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq)) {
          // 窗口读满却拿不到最后 seq（异常信封）：无法推进水位，按截断收尾。
          emitRecords(sessionId, await store.appendRecords(projectKey, windowRecords))
          break
        }
        emitRecords(sessionId, await store.appendRecords(projectKey, windowRecords, { [sessionId]: lastSeq }))
        if (events.length < HISTORY_READ_WINDOW) break
        offset = lastSeq + 1
      }
    } finally {
      await handle.close()
    }
  }

  const ensureProject = async (projectKey: string, projectRoot: string, currentSessionId: string | undefined): Promise<void> => {
    if (scanning.has(projectKey)) return
    scanning.add(projectKey)
    let degraded = false
    try {
      await store.loadProject(projectKey)
      const scope = await sessionScopeOf(projectRoot, currentSessionId)
      degraded = scope.degraded
      for (const id of scope.ids) {
        try {
          await scanSession(projectKey, id)
        } catch (error) {
          // 逐会话跳过：一份坏日志/一个读不出的句柄不能拖垮整个项目。
          warn(`dsh-better-sidebar: session "${id}" could not be scanned for prompt history; skipped`, error)
        }
      }
    } catch (error) {
      warn(`dsh-better-sidebar: prompt-history seed scan failed for project ${projectKey}`, error)
    } finally {
      degradedByProject.set(projectKey, degraded)
      scanning.delete(projectKey)
      store.markSeeding(projectKey, false)
      // 扫描收尾（成功/降级/失败都发）：客户端据此熄掉 seeding 提示条并补拉
      // 一次首页，把扫描期没 watch 到的会话记录补齐（那些会话的实时帧在
      // watch 建立前已被 hub 过滤，补拉是唯一兜底）。
      emitSeed(projectRoot, false)
    }
  }

  /** 实时事件 → 记录 → 归属项目 → append + 推送（注入消息已被 extract 过滤）。
   *  只推 appendRecords 认下的 fresh：扫描已记过的账被 byKey 挡下后不再出站，
   *  ws 推送与存储幂等同源（同一条记录绝不二次推送）。 */
  const recordLiveEvent = async (sessionId: string, event: SidebarSessionEvent): Promise<void> => {
    const records = extractSendRecords(sessionId, [event as HistorySourceEvent]).records
    if (records.length === 0) return
    const root = await resolveProjectRootOf(ctx, sessionId)
    if (root === undefined) {
      // 项目根解析不出：无从归属，先不落盘——该事件已在持久日志里，下次种子
      // 扫描自然会补账。
      return
    }
    const fresh = await store.appendRecords(projectKeyOf(root), records, { [sessionId]: event.seq })
    emitRecords(sessionId, fresh)
  }

  const onSessionEvent = (session: unknown, event: SidebarSessionEvent): void => {
    try {
      if ((event as { type?: unknown } | null)?.type !== 'user/message') return
      const sessionId = (session as { id?: unknown } | null)?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      void recordLiveEvent(sessionId, event).catch(error => {
        warn(`dsh-better-sidebar: live prompt-history record failed for session "${sessionId}"`, error)
      })
    } catch (error) {
      // 订阅回调绝不同步上抛（cordis 会把 listener 错误传给事件发出方）。
      warn('dsh-better-sidebar: prompt-history event handler failed', error)
    }
  }

  // ctx.on 缺席（测试替身/裁剪宿主）时静默跳过：实时记录退化为纯种子扫描。
  const offEvent = typeof ctx.on === 'function' ? ctx.on('session/event', onSessionEvent) : undefined

  return {
    kick: (projectKey, projectRoot, currentSessionId) => {
      const entry = store.peekProject(projectKey)
      if (entry !== undefined && (entry.loaded || entry.seeding)) return
      store.markSeeding(projectKey, true)
      // 扫描开始即广播：已开着的页签（还没从 history.list 读到 seeding:true 的）
      // 也能立刻亮提示条；结束时同样广播（ensureProject 的 finally）。
      emitSeed(projectRoot, true)
      void ensureProject(projectKey, projectRoot, currentSessionId)
    },
    isSeeding: projectKey => store.peekProject(projectKey)?.seeding === true,
    degradedOf: projectKey => degradedByProject.get(projectKey),
    onRecords: sink => {
      sinks.add(sink)
      return () => { sinks.delete(sink) }
    },
    onSeed: sink => {
      seedSinks.add(sink)
      return () => { seedSinks.delete(sink) }
    },
    dispose: () => {
      offEvent?.()
      sinks.clear()
      seedSinks.clear()
      scanning.clear()
      degradedByProject.clear()
    },
  }
}
