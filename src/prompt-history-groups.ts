/**
 * 「历史发送」纯逻辑之三：分组归并与过滤。
 *
 * 发送记录本身不持久化——服务端每次从会话日志现读，客户端拿到的是一张
 * 跨会话的平面记录表。本模块负责把平面表收敛成 UI 的两种视图形状：
 * - {@link groupRecordsBySession}：按所属会话归并成组（组头要的会话标识、
 *   最近时间、条数都在组上），组内按时间正序（旧→新的聊天顺序），组间按
 *   最近一条记录的时间倒序；
 * - {@link filterHistoryRecords}：顶部文本搜索（大小写不敏感的子串）与
 *   标签过滤（任一命中即保留）都作用在平面上，先过滤再分组，空组不出现；
 * - {@link collectHistoryTags}：全库标签聚合（过滤条的 chips 来源，按名字
 *   去重排序）。
 *
 * 关联组（命名组）不参与会话归并——它是注解库里的成员表，组内记录仍保留
 * 在原会话分组里，两套形状互不干扰（见 prompt-history-store.ts）。
 * 框架自由、无 I/O，客户端视图与测试环境直接导入。
 */
import type { HistorySendRecord } from './prompt-history-extract.ts'
import type { HistoryAnnotations } from './prompt-history-store.ts'

/** 一个会话分组：组头字段 + 该组记录（时间正序，旧→新的聊天顺序）。 */
export interface HistorySessionGroup {
  sessionId: string
  /** 该组最近一条记录的时间（epoch ms；空组不存在）。 */
  lastTime: number
  /** 记录条数（= records.length，组头展示用，展开语义上无歧义）。 */
  count: number
  /** 组内记录（时间正序：一场对话按聊天顺序旧→新读）。 */
  records: HistorySendRecord[]
}

/** 一条记录的时间排序键（信封时间缺失时回退 seq，保持稳定顺序）。 */
function timeKeyOf(record: HistorySendRecord): number {
  return record.time !== 0 ? record.time : record.seq
}

/**
 * 平面记录 → 会话分组。组内是聊天顺序：时间正序（旧→新，一场对话从上往下
 * 读）；组间按最近一条记录的时间倒序（最新的一场对话在最上）。输入顺序无关，
 * 输出只由记录内容决定。
 */
export function groupRecordsBySession(records: readonly HistorySendRecord[]): HistorySessionGroup[] {
  const bySession = new Map<string, HistorySendRecord[]>()
  for (const record of records) {
    const bucket = bySession.get(record.sessionId)
    if (bucket === undefined) bySession.set(record.sessionId, [record])
    else bucket.push(record)
  }
  const groups: HistorySessionGroup[] = []
  for (const [sessionId, bucket] of bySession) {
    const ordered = [...bucket].sort((a, b) => timeKeyOf(a) - timeKeyOf(b))
    groups.push({
      sessionId,
      lastTime: ordered.length > 0 ? timeKeyOf(ordered[ordered.length - 1]!) : 0,
      count: ordered.length,
      records: ordered,
    })
  }
  return groups.sort((a, b) => b.lastTime - a.lastTime)
}

/** 过滤条件（两个维度都给时取交集；只给一维按单维过滤）。 */
export interface HistoryRecordFilter {
  /** 文本搜索词（大小写不敏感子串；trim 后为空 = 不过滤）。 */
  search?: string | undefined
  /** 标签名（精确匹配；空 = 不过滤）。 */
  tag?: string | undefined
  /** 记录 → 标签列表的取数口（注解库按 key 查询；缺省视为无标签）。 */
  tagSource?: ((record: HistorySendRecord) => readonly string[]) | undefined
}

/**
 * 平面记录过滤：文本搜索走大小写不敏感的子串匹配，标签走精确匹配（记录带
 * 该标签即保留）。返回新数组，不改入参。
 */
export function filterHistoryRecords(
  records: readonly HistorySendRecord[],
  filter: HistoryRecordFilter,
): HistorySendRecord[] {
  const search = filter.search?.trim().toLowerCase() ?? ''
  const tag = filter.tag?.trim() ?? ''
  if (search === '' && tag === '') return [...records]
  return records.filter(record => {
    if (search !== '' && !record.text.toLowerCase().includes(search)) return false
    return true
  }).filter(record => {
    if (tag === '') return true
    const tags = filter.tagSource?.(record) ?? []
    return tags.includes(tag)
  })
}

/** 全库标签聚合（过滤条 chips）：去重 + 字典序，标签归属无关记录可见性。 */
export function collectHistoryTags(store: HistoryAnnotations): string[] {
  const tags = new Set<string>()
  for (const list of Object.values(store.tags)) {
    for (const tag of list) tags.add(tag)
  }
  return [...tags].sort((a, b) => a.localeCompare(b))
}
