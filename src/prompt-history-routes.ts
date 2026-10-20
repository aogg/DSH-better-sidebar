/**
 * 「历史发送」服务路由（/sidebar JSON API 的 history.list /
 * history.annotationsGet / history.annotationsUpdate），由 src/index.ts 的
 * buildApi 合入 api 记录、经 /sidebar/api 分发器按方法名调用。
 *
 * 读路径（history.list）：发送记录在服务端持久仓里（prompt-history-persist.ts，
 * `<存储根>/prompt-history/records/<projectKey>.jsonl` + 内存索引），路由只做
 * 三件事：
 * - 解析当前会话的项目根（prompt-history-live.ts 的 resolveProjectRootOf，
 *   活会话头 → 持久头 → 活跃 worktree）并算出 projectKey——项目过滤在服务端
 *   做完，返回的只有当前项目的记录；
 * - 懒触发种子扫描（prompt-history-live.ts 的 kick：内存无该项目时后台扫，
 *   路由立即返回现有内容 + `seeding:true`，绝不让首屏等扫描）；
 * - 从内存索引出「新→旧」分页（复合键游标 `${time}:${sessionId}:${seq}`，
 *   见 prompt-history-persist.ts 的 historyPageOf；跨会话平铺，limit 默认
 *   50、上限 200）。
 *
 * 项目根解析不出（无活会话头、无持久头）时降级为「只读当前会话」的瞬时抽取
 * （活快照优先，持久日志分窗读，绝不落盘——没有可归属的 projectKey），
 * `degraded:true`；持久层整个缺席时按旧契约抛 503 的 history-error（页签内联
 * 展示）。
 *
 * 写路径：评论/标签/关联组存持久仓的 `<根>/prompt-history/annotations.json`
 * （形状与旧版一致；旧版小写目录下的文件由持久仓一次性搬入），tmp + rename
 * 原子写。文件缺席/损坏时归一化为空库（prompt-history-store.ts 的
 * normalizeAnnotations 逐字段防御），磁盘读失败只降级；写失败抛 history-error
 * 由页签内联提示。
 *
 * 降级边界：除此之外没有向上传播的失败——prefs 读失败/磁盘不可写/种子扫描
 * 失败都由持久仓与扫描器记 warn 后继续，绝不未捕获。
 */
import { randomUUID } from 'node:crypto'
import type { Context, SidebarSessionEvent } from './context-types.ts'
import { extractSendRecords, type HistorySendRecord, type HistorySourceEvent } from './prompt-history-extract.ts'
import {
  applyAnnotationOp,
  HISTORY_ANNOTATION_OPS,
  type HistoryAnnotationOp,
  type HistoryAnnotations,
} from './prompt-history-store.ts'
import {
  defaultAnnotationsPath,
  historyPageOf,
  normalizeHistoryLimit,
  projectKeyOf,
  PromptHistoryStore,
  type HistoryPage,
} from './prompt-history-persist.ts'
import {
  createPromptHistoryLive,
  HISTORY_READ_WINDOW,
  HISTORY_READ_WINDOW_MAX,
  type PromptHistoryLive,
  resolveProjectRootOf,
} from './prompt-history-live.ts'
import { SidebarError } from './wire.ts'

/** 「历史发送」路由的 wire 方法名 → 处理器签名（合入 api 记录的形状）。
 *  wire 契约固定：客户端按这些字段名实现，勿改名。 */
export interface HistoryRoutes {
  /** 当前项目的用户发送记录（新→旧平铺；分页见 HistoryListResult）。 */
  'history.list'(payload: unknown): Promise<HistoryListResult>
  /** 注解库全量（评论/标签/关联组，记录 key → 注解）。 */
  'history.annotationsGet'(payload: unknown): Promise<HistoryAnnotations>
  /** 归并一个注解写操作，返回写后的全量注解库。 */
  'history.annotationsUpdate'(payload: unknown): Promise<HistoryAnnotations>
}

/** history.list 的入参：当前会话（定位项目）+ 分页游标/条数。 */
export interface HistoryListPayload {
  sessionId?: string
  /** 上页返回的 nextCursor；缺省从最新一页开始。 */
  cursor?: string
  /** 单页条数（默认 50，上限 200）。 */
  limit?: number
}

/** history.list 的出参（wire 契约，客户端按此实现）。 */
export interface HistoryListResult extends HistoryPage {
  available: true
  /** 种子扫描进行中（首屏立即返回现有内容，扫描完成后客户端再拉即可）。 */
  seeding: boolean
  /** 命中的项目根（解析不出时本字段缺席，记录来自当前会话的瞬时抽取）。 */
  project?: { cwd: string }
  /** 会话枚举降级成了当前会话（宿主没有 list 能力或列取失败）。 */
  degraded?: boolean
}

/** 本路由消费的 sessionPersistence 结构面（open 必备，list 特征探测）。 */
interface HistoryPersistenceFace {
  open(id: string, access: 'read'): Promise<{
    header: Record<string, unknown>
    inheritedEventCount?: number
    read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
    close(): Promise<void>
  }>
  list?(): Promise<readonly { header: Record<string, unknown> }[]>
}

/**
 * 注解库的默认磁盘落点：`<DSH_HOME||~/.dsh>/plugins/DSH-better-sidebar/
 * prompt-history/annotations.json`（与 search-debug.ts 的解析顺序一致）。
 * 注意：用户配置了 `historyStoragePath` 时实际落点在其自定义根下——本函数只
 * 回答默认根（测试与诊断用；旧版语义是 `plugins/dsh-better-sidebar/
 * prompt-history.json` 小写目录，由持久仓一次性迁移）。
 */
export function historyStorePath(env: { DSH_HOME?: string | undefined } = process.env): string {
  return defaultAnnotationsPath(env)
}

/** op 的 wire 校验：op 名可识别 + 必填字段是非空字符串；其余字段交给
 *  applyAnnotationOp 的逐字段收窄（脏值按尽力而为处理，不抛）。 */
function parseAnnotationOp(payload: unknown): HistoryAnnotationOp {
  const record = (payload ?? {}) as Record<string, unknown>
  const name = record.op
  if (typeof name !== 'string' || !(HISTORY_ANNOTATION_OPS as readonly string[]).includes(name)) {
    throw new SidebarError('bad-request', `op must be one of ${HISTORY_ANNOTATION_OPS.join(', ')}`)
  }
  const requireField = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string' || value === '') {
      throw new SidebarError('bad-request', `"${key}" must be a non-empty string`)
    }
    return value
  }
  const keys = (): string[] => (Array.isArray(record.keys) ? record.keys : [])
  switch (name as HistoryAnnotationOp['op']) {
    case 'commentAdd':
      return { op: 'commentAdd', key: requireField('key'), text: requireField('text'), id: randomUUID(), time: Date.now() }
    case 'commentRemove':
      return { op: 'commentRemove', key: requireField('key'), commentId: requireField('commentId') }
    case 'tagAdd':
      return { op: 'tagAdd', key: requireField('key'), tag: requireField('tag') }
    case 'tagRemove':
      return { op: 'tagRemove', key: requireField('key'), tag: requireField('tag') }
    case 'groupCreate':
      return { op: 'groupCreate', id: randomUUID(), name: requireField('name'), keys: keys(), time: Date.now() }
    case 'groupRename':
      return { op: 'groupRename', id: requireField('id'), name: requireField('name') }
    case 'groupDelete':
      return { op: 'groupDelete', id: requireField('id') }
    case 'groupAddMembers':
      return { op: 'groupAddMembers', id: requireField('id'), keys: keys() }
    case 'groupRemoveMember':
      return { op: 'groupRemoveMember', id: requireField('id'), key: requireField('key') }
  }
}

/** 项目根解析不出时的瞬时读：只读当前会话（活快照优先，持久日志分窗读），
 *  绝不落盘。返回已分好页的一页。 */
async function transientPageOf(
  ctx: Context,
  persistence: HistoryPersistenceFace,
  sessionId: string | undefined,
  cursor: string | undefined,
  limit: number,
): Promise<HistoryPage> {
  const collected: HistorySendRecord[] = []
  if (sessionId !== undefined) {
    const live = ctx.sessions.get(sessionId) as { snapshotEvents?: () => readonly SidebarSessionEvent[] } | undefined
    const snapshot = typeof live?.snapshotEvents === 'function' ? live.snapshotEvents() : undefined
    if (snapshot !== undefined) {
      collected.push(...extractSendRecords(sessionId, snapshot as readonly HistorySourceEvent[]).records)
    } else {
      // 分窗读持久日志：窗口 1000×100 的防御上限，逐窗抽取后即释放。
      try {
        const handle = await persistence.open(sessionId, 'read')
        try {
          const inherited = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0
          let offset = 0
          for (let page = 0; page < HISTORY_READ_WINDOW_MAX; page++) {
            const { events } = await handle.read(offset, HISTORY_READ_WINDOW)
            collected.push(...extractSendRecords(sessionId, events as readonly HistorySourceEvent[], {
              inheritedEventCount: offset === 0 ? inherited : 0,
            }).records)
            if (events.length < HISTORY_READ_WINDOW) break
            const lastSeq = (events as { seq?: unknown }[]).at(-1)?.seq
            if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq)) break
            offset = lastSeq + 1
          }
        } finally {
          await handle.close()
        }
      } catch {
        // 读不出的日志按空列表处理（瞬时读没有可升级的失败面）。
      }
    }
  }
  return historyPageOf(collected, cursor, limit)
}

/** buildPromptHistoryApi 的依赖注入口（测试注入内存实现；缺省自建）。 */
export interface PromptHistoryApiDeps {
  /** 发送记录 + 注解库持久仓。 */
  store?: PromptHistoryStore
  /** 种子扫描 + 实时记录器（缺省自建并订阅 ctx.on）。 */
  live?: PromptHistoryLive
}

/**
 * 组装「历史发送」路由（key 即 /sidebar/api 的完整方法名）。宿主 persistence
 * 缺席且项目根解析不出时 history.list 抛 503 的 history-error（页签内联展示），
 * 注解路由只在磁盘写失败时抛 history-error。
 */
export function buildPromptHistoryApi(ctx: Context, deps: PromptHistoryApiDeps = {}): HistoryRoutes {
  const warn = (message: string, error?: unknown): void => {
    ctx.logger?.warn?.(message)
    if (error !== undefined) ctx.logger?.warn?.(error)
  }
  const store = deps.store ?? new PromptHistoryStore({ logger: { warn } })
  const live = deps.live ?? createPromptHistoryLive(ctx, store, { logger: { warn } })
  return {
    'history.list': async (payload: unknown) => {
      const record = (payload ?? {}) as HistoryListPayload
      const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
      const cursor = typeof record.cursor === 'string' && record.cursor !== '' ? record.cursor : undefined
      const limit = normalizeHistoryLimit(record.limit)
      const root = await resolveProjectRootOf(ctx, sessionId)
      if (root === undefined) {
        // 项目根解析不出：无从归属项目，退化为只读当前会话的瞬时抽取。
        const persistence = ctx.get('sessionPersistence') as HistoryPersistenceFace | undefined
        if (persistence === undefined) {
          throw new SidebarError('history-error', 'the session persistence service is unavailable', 503)
        }
        const page = await transientPageOf(ctx, persistence, sessionId, cursor, limit)
        return { available: true, ...page, seeding: false, degraded: true }
      }
      const projectKey = projectKeyOf(root)
      // 懒触发种子扫描（后台跑，绝不等待）；随后只做本地读：磁盘 JSONL 的
      // 载入是快路径，扫描本身永远不等。
      live.kick(projectKey, root, sessionId)
      const entry = await store.loadProject(projectKey)
      const page = historyPageOf(entry.records, cursor, limit)
      const degraded = live.degradedOf(projectKey)
      return {
        available: true,
        records: page.records,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        hasMore: page.hasMore,
        seeding: live.isSeeding(projectKey),
        project: { cwd: root },
        ...(degraded !== undefined ? { degraded } : {}),
      }
    },

    'history.annotationsGet': async () => store.annotations(),

    'history.annotationsUpdate': async (payload: unknown) => {
      const op = parseAnnotationOp(payload)
      const current = await store.annotations()
      const next = applyAnnotationOp(current, op)
      try {
        await store.writeAnnotations(next)
      } catch (error) {
        throw new SidebarError(
          'history-error',
          `cannot persist prompt history annotations: ${error instanceof Error ? error.message : String(error)}`,
          500,
        )
      }
      return next
    },
  }
}
