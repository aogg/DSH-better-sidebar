/**
 * 「历史发送」服务路由（/sidebar JSON API 的 history.list /
 * history.annotationsGet / history.annotationsUpdate），由 src/index.ts 的
 * buildApi 合入 api 记录、经 /sidebar/api 分发器按方法名调用。
 *
 * 读路径：发送记录本身**不持久化**，每次从宿主 `sessionPersistence` 现读——
 * - 会话范围优先 `persistence.list()`（宿主 listStoredHeaders 能力，特征探测，
 *   见 context-types.ts 的说明）；能力缺席或列取失败时静默降级为当前会话
 *   （payload 的 sessionId），绝不抛错；
 * - 会话日志可能很大：持久读取走 `handle.read(offset, length)` 分页窗口
 *   （每窗 {@link HISTORY_READ_WINDOW} 条事件），逐窗抽取 user/message 后即
 *   释放，只保留最近 {@link HISTORY_SESSION_RECORDS} 条，绝不把整份日志一次
 *   性拉进内存；活会话优先进程内快照（那份数组本就驻留，只做 O(n) 扫描），
 *   与 changes.ops 的取舍一致；
 * - 种子切在 prompt-history-extract.ts（session/end-seed 标记 +
 *   inheritedEventCount 双保险），fork 子会话不会把父会话的消息重复记账。
 *
 * 写路径：评论/标签/关联组存插件服务端 JSON 文件 {@link historyStorePath}
 * （DSH_HOME 优先，同 search-debug.ts 的解析顺序；宿主没有插件数据目录
 * API，这是任务约定的落点），tmp 兄弟文件 + rename 原子写（同
 * fs-operations.ts 的上传落盘手法）。文件缺席/损坏时归一化为空库
 * （prompt-history-store.ts 的 normalizeAnnotations 逐字段防御），路由只记
 * 一条 warn。
 *
 * 降级边界：宿主 persistence 服务整个缺席时 history.list 抛 503 的
 * history-error（页签内联展示）；读会话失败逐会话跳过（坏日志不拖垮整个
 * 列表）；注解写盘失败抛 history-error 由页签内联提示——除此之外没有向上
 * 传播的失败，绝不未捕获。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from './context-types.ts'
import { extractSendRecords, type HistorySendRecord } from './prompt-history-extract.ts'
import {
  applyAnnotationOp,
  emptyAnnotations,
  HISTORY_ANNOTATION_OPS,
  normalizeAnnotations,
  type HistoryAnnotationOp,
  type HistoryAnnotations,
} from './prompt-history-store.ts'
import { SidebarError } from './wire.ts'

/** 「历史发送」路由的 wire 方法名 → 处理器签名（合入 api 记录的形状）。 */
export interface HistoryRoutes {
  /** 跨会话的用户发送记录（会话范围见模块注释；limit 为单会话条数上限）。 */
  'history.list'(payload: unknown): Promise<{
    available: true
    sessions: { id: string; cwd?: string; records: HistorySendRecord[]; truncated: boolean }[]
    /** 会话枚举降级成了当前会话（宿主没有 list 能力或列取失败）。 */
    degraded: boolean
  }>
  /** 注解库全量（评论/标签/关联组，记录 key → 注解）。 */
  'history.annotationsGet'(payload: unknown): Promise<HistoryAnnotations>
  /** 归并一个注解写操作，返回写后的全量注解库。 */
  'history.annotationsUpdate'(payload: unknown): Promise<HistoryAnnotations>
}

/** 持久读取的事件窗口（每窗条数；整份日志从不整段驻留）。 */
const HISTORY_READ_WINDOW = 1000

/** 单会话最多读多少窗（1000×100 = 10 万事件的防御上限，超出置 truncated）。 */
const HISTORY_READ_WINDOW_MAX = 100

/** 默认单会话返回条数（payload.limit 可在 1..200 内调整）。 */
export const HISTORY_SESSION_RECORDS = 50

/** 单会话返回条数的硬上限。 */
export const HISTORY_SESSION_RECORDS_MAX = 200

/** 默认扫描多少个会话（list 顺序即宿主存储序；payload.sessionLimit 可调整）。 */
export const HISTORY_SESSION_SCAN = 40

/** 会话扫描数的硬上限。 */
export const HISTORY_SESSION_SCAN_MAX = 200

/** 事件信封的最小结构面（宿主 SessionEvent 与宽松夹具都能进来）。 */
interface HistoryWireEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
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
 * 注解库的磁盘落点：`$DSH_HOME/plugins/dsh-better-sidebar/prompt-history.json`，
 * DSH_HOME 未设时 `~/.dsh`（与 search-debug.ts 的解析顺序一致）。
 */
export function historyStorePath(env: { DSH_HOME?: string | undefined } = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, 'plugins', 'dsh-better-sidebar', 'prompt-history.json')
}

/** 从磁盘读注解库：缺席→空库；损坏→空库 + warn（半损坏不丢另一半已由
 *  normalizeAnnotations 逐字段防御，这里挡的是整体不可解析）。 */
async function readAnnotations(path: string, warn?: (message: string, error?: unknown) => void): Promise<HistoryAnnotations> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // 首次使用文件还不存在：空库就是正确答案，不是错误。
    return emptyAnnotations()
  }
  try {
    return normalizeAnnotations(JSON.parse(text))
  } catch (error) {
    warn?.('dsh-better-sidebar: prompt-history.json is not valid JSON; starting from an empty annotation store', error)
    return emptyAnnotations()
  }
}

/** 原子落盘：同目录 tmp 兄弟文件（随机名防撞）写好后 rename 到位。 */
async function writeAnnotations(path: string, store: HistoryAnnotations): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.prompt-history-${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  try {
    await rename(tmp, path)
  } catch (error) {
    // rename 失败时 tmp 已成孤儿，先清掉再上抛（错误由调用方内联展示）。
    await rm(tmp).catch(() => {})
    throw error
  }
}

/** 收尾：升序收集的记录取最近 limit 条、倒序交付（UI 组内最近在上）。 */
function trimToLimit(
  collected: HistorySendRecord[],
  limit: number,
  truncatedSoFar: boolean,
): { records: HistorySendRecord[]; truncated: boolean } {
  const ordered = [...collected].sort((a, b) => a.time - b.time || a.seq - b.seq)
  const truncated = truncatedSoFar || ordered.length > limit
  return { records: ordered.slice(Math.max(0, ordered.length - limit)).reverse(), truncated }
}

/**
 * 从一个会话抽取发送记录：活快照优先（快照本就驻留进程内，只做 O(n) 扫描），
 * 持久分页读兜底。会话读不出来时上抛，由调用方逐会话跳过。
 */
async function recordsOfSession(
  ctx: Context,
  persistence: HistoryPersistenceFace,
  sessionId: string,
  limit: number,
): Promise<{ records: HistorySendRecord[]; truncated: boolean }> {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    // 与持久路径同一收尾：最近在前（wire 顺序即组内展示顺序）。
    const extracted = extractSendRecords(sessionId, live.snapshotEvents(), { limit })
    return trimToLimit(extracted.records, limit, extracted.truncated)
  }
  const handle = await persistence.open(sessionId, 'read')
  try {
    const inherited = typeof handle.inheritedEventCount === 'number' ? handle.inheritedEventCount : 0
    const collected: HistorySendRecord[] = []
    let truncated = false
    // 分页窗口逐段抽取：seq 连续，下一窗从 last+1 起；读不满一窗即到底。
    // 每窗带一次种子切（inheritedEventCount 只在首窗有意义），窗口内先不限量
    // （≤1000 条），归并后随时裁到最近 limit 条，内存有界。
    let offset = 0
    for (let page = 0; page < HISTORY_READ_WINDOW_MAX; page++) {
      const { events } = await handle.read(offset, HISTORY_READ_WINDOW)
      const windowEvents = events as readonly HistoryWireEvent[]
      const windowRecords = extractSendRecords(sessionId, windowEvents, {
        inheritedEventCount: offset === 0 ? inherited : 0,
      }).records
      collected.push(...windowRecords)
      if (collected.length > limit) {
        collected.sort((a, b) => a.time - b.time || a.seq - b.seq)
        collected.splice(0, collected.length - limit)
        truncated = true
      }
      if (events.length < HISTORY_READ_WINDOW) return trimToLimit(collected, limit, truncated)
      const lastSeq = (events as { seq?: number }[]).at(-1)?.seq
      if (typeof lastSeq !== 'number') {
        // 窗口读满却拿不到最后 seq（异常信封）：无法继续分页，按截断收尾。
        return trimToLimit(collected, limit, true)
      }
      offset = lastSeq + 1
    }
    return trimToLimit(collected, limit, true)
  } finally {
    await handle.close()
  }
}

/** 读会话范围：list 能力优先，缺席/失败/空列表降级到 payload 的当前会话。 */
async function sessionScopeOf(
  ctx: Context,
  persistence: HistoryPersistenceFace | undefined,
  fallbackSessionId: string | undefined,
  sessionLimit: number,
): Promise<{ ids: string[]; cwds: Map<string, string | undefined>; degraded: boolean }> {
  if (persistence?.list !== undefined) {
    try {
      const listed = await persistence.list()
      const ids: string[] = []
      const cwds = new Map<string, string | undefined>()
      for (const row of listed) {
        const header = row?.header
        const id = header?.id
        if (typeof id !== 'string' || id === '' || ids.includes(id)) continue
        const cwd = header.cwd
        ids.push(id)
        cwds.set(id, typeof cwd === 'string' && cwd !== '' ? cwd : undefined)
        if (ids.length >= sessionLimit) break
      }
      if (ids.length > 0) return { ids, cwds, degraded: false }
    } catch (error) {
      ctx.logger?.warn?.('dsh-better-sidebar: stored session header list failed; prompt history degrades to the current session')
      ctx.logger?.warn?.(error)
    }
  }
  // 降级：只读当前会话（宿主没有 list 能力 / 列取失败 / 列表为空）。
  if (fallbackSessionId === undefined || fallbackSessionId === '') {
    return { ids: [], cwds: new Map(), degraded: true }
  }
  return { ids: [fallbackSessionId], cwds: new Map(), degraded: true }
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

/**
 * 组装「历史发送」路由（key 即 /sidebar/api 的完整方法名）。宿主 persistence
 * 缺席时 history.list 抛 503 的 history-error（页签内联展示），注解路由只在
 * 磁盘读写失败时抛 history-error。
 */
export function buildPromptHistoryApi(ctx: Context): HistoryRoutes {
  const path = historyStorePath()
  const warn = (message: string, error?: unknown): void => {
    ctx.logger?.warn?.(message)
    if (error !== undefined) ctx.logger?.warn?.(error)
  }
  return {
    'history.list': async (payload: unknown) => {
      const record = (payload ?? {}) as { sessionId?: unknown; limit?: unknown; sessionLimit?: unknown }
      const persistence = ctx.get('sessionPersistence') as HistoryPersistenceFace | undefined
      if (persistence === undefined) {
        throw new SidebarError('history-error', 'the session persistence service is unavailable', 503)
      }
      const fallbackSessionId = typeof record.sessionId === 'string' && record.sessionId !== ''
        ? record.sessionId
        : undefined
      const limit = typeof record.limit === 'number' && Number.isSafeInteger(record.limit) && record.limit > 0
        ? Math.min(record.limit, HISTORY_SESSION_RECORDS_MAX)
        : HISTORY_SESSION_RECORDS
      const sessionLimit = typeof record.sessionLimit === 'number' && Number.isSafeInteger(record.sessionLimit) && record.sessionLimit > 0
        ? Math.min(record.sessionLimit, HISTORY_SESSION_SCAN_MAX)
        : HISTORY_SESSION_SCAN
      const scope = await sessionScopeOf(ctx, persistence, fallbackSessionId, sessionLimit)
      const sessions: { id: string; cwd?: string; records: HistorySendRecord[]; truncated: boolean }[] = []
      for (const id of scope.ids) {
        try {
          const { records, truncated } = await recordsOfSession(ctx, persistence, id, limit)
          // 没有任何用户发送的会话不出组（空组没有可展示的东西）。
          if (records.length === 0) continue
          const cwd = scope.cwds.get(id)
          sessions.push({ id, ...(cwd !== undefined ? { cwd } : {}), records, truncated })
        } catch (error) {
          // 逐会话跳过：一份坏日志/一个读不出的句柄不能拖垮整个列表。
          warn(`dsh-better-sidebar: session "${id}" could not be read for prompt history; skipped`, error)
        }
      }
      return { available: true, sessions, degraded: scope.degraded }
    },

    'history.annotationsGet': async () => readAnnotations(path, warn),

    'history.annotationsUpdate': async (payload: unknown) => {
      const op = parseAnnotationOp(payload)
      const store = await readAnnotations(path, warn)
      const next = applyAnnotationOp(store, op)
      try {
        await writeAnnotations(path, next)
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
