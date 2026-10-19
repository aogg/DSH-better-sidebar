/**
 * 「历史发送」纯逻辑之二：注解存储（评论 / 标签 / 关联组）的形状、归一化与
 * 操作归并。
 *
 * 持久化形态是服务端一个 JSON 文件（prompt-history-routes.ts 负责 tmp+rename
 * 原子落盘），本模块只管形状与纯计算——框架自由、无 I/O，宿主路由与测试环境
 * 都能直接导入（同 sidechat-core.ts / prompt-history-extract.ts 的先例）：
 * - {@link normalizeAnnotations} 把磁盘上读到的任意 JSON 收敛成合法形状：
 *   文件缺席/损坏/字段是垃圾时回到空库（降级，不抛错——路由侧只记一条
 *   warn 日志），合法字段逐个收窄校验；
 * - {@link applyAnnotationOp} 把一个写操作归并进库（纯函数，返回新库，不改
 *   入参）：id / time 由调用方（路由）铸造，本模块保持可确定性、可单测；
 * - 记录 key 恒为 `${sessionId}:${seq}`（见 prompt-history-extract.ts），
 *   注解挂在 key 上；日志本身不持久化，key 对不上记录时注解静静留着
 *   （记录被 limit 截掉或会话尚未扫到，都只是暂时不可见）。
 */
import type { HistorySendRecord } from './prompt-history-extract.ts'

/** 一条评论（带落库时间）。 */
export interface HistoryComment {
  id: string
  text: string
  /** epoch ms，由路由铸造。 */
  time: number
}

/** 一个命名关联组：成员是记录 key 的有序集合。 */
export interface HistoryAnnotationGroup {
  id: string
  name: string
  members: string[]
  /** 组的创建时间（epoch ms，由路由铸造；仅展示用）。 */
  time: number
}

/** 注解库整体（JSON 文件的内存形状）。 */
export interface HistoryAnnotations {
  version: 1
  /** 记录 key → 评论列表（append 序）。 */
  comments: Record<string, HistoryComment[]>
  /** 记录 key → 标签（去重、保序）。 */
  tags: Record<string, string[]>
  /** 命名关联组（创建序）。 */
  groups: HistoryAnnotationGroup[]
}

/** 空库（文件缺席 / 损坏 / 归一化失败时的降级形态）。 */
export function emptyAnnotations(): HistoryAnnotations {
  return { version: 1, comments: {}, tags: {}, groups: [] }
}

/** 单条评论文本上限（字符）。 */
export const HISTORY_COMMENT_MAX_CHARS = 2000
/** 单条记录的标签数上限。 */
export const HISTORY_TAGS_PER_RECORD = 20
/** 单个标签长度上限（字符）。 */
export const HISTORY_TAG_MAX_CHARS = 40
/** 单条记录的评论数上限。 */
export const HISTORY_COMMENTS_PER_RECORD = 200
/** 关联组数量上限。 */
export const HISTORY_GROUPS_MAX = 200
/** 关联组名长度上限（字符）。 */
export const HISTORY_GROUP_NAME_MAX_CHARS = 80
/** 单个关联组成员数上限。 */
export const HISTORY_GROUP_MEMBERS_MAX = 500

/** 规范化一个标签：trim + 长度截断；空串返回 undefined（调用方丢弃）。 */
export function normalizeTag(raw: string): string | undefined {
  const tag = typeof raw === 'string' ? raw.trim().slice(0, HISTORY_TAG_MAX_CHARS) : ''
  return tag === '' ? undefined : tag
}

/**
 * 把磁盘 JSON（或任意 unknown）收敛成合法注解库。逐字段防御：形状不符的
 * 条目丢弃而不是整体拒绝——一份半损坏的文件不应该让用户丢失另一半注解。
 */
export function normalizeAnnotations(raw: unknown): HistoryAnnotations {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyAnnotations()
  const record = raw as { comments?: unknown; tags?: unknown; groups?: unknown }
  const comments: Record<string, HistoryComment[]> = {}
  if (record.comments !== null && typeof record.comments === 'object' && !Array.isArray(record.comments)) {
    for (const [key, list] of Object.entries(record.comments as Record<string, unknown>)) {
      if (typeof key !== 'string' || key === '' || !Array.isArray(list)) continue
      const items: HistoryComment[] = []
      for (const item of list) {
        if (item === null || typeof item !== 'object') continue
        const candidate = item as { id?: unknown; text?: unknown; time?: unknown }
        if (typeof candidate.id !== 'string' || candidate.id === '') continue
        if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue
        items.push({
          id: candidate.id,
          text: candidate.text.slice(0, HISTORY_COMMENT_MAX_CHARS),
          time: typeof candidate.time === 'number' && Number.isFinite(candidate.time) ? candidate.time : 0,
        })
      }
      if (items.length > 0) comments[key] = items.slice(0, HISTORY_COMMENTS_PER_RECORD)
    }
  }
  const tags: Record<string, string[]> = {}
  if (record.tags !== null && typeof record.tags === 'object' && !Array.isArray(record.tags)) {
    for (const [key, list] of Object.entries(record.tags as Record<string, unknown>)) {
      if (typeof key !== 'string' || key === '' || !Array.isArray(list)) continue
      const items: string[] = []
      for (const item of list) {
        const tag = normalizeTag(typeof item === 'string' ? item : '')
        if (tag !== undefined && !items.includes(tag)) items.push(tag)
        if (items.length >= HISTORY_TAGS_PER_RECORD) break
      }
      if (items.length > 0) tags[key] = items
    }
  }
  const groups: HistoryAnnotationGroup[] = []
  if (Array.isArray(record.groups)) {
    for (const item of record.groups) {
      if (item === null || typeof item !== 'object') continue
      const candidate = item as { id?: unknown; name?: unknown; members?: unknown; time?: unknown }
      if (typeof candidate.id !== 'string' || candidate.id === '') continue
      if (typeof candidate.name !== 'string' || candidate.name.trim() === '') continue
      const members = Array.isArray(candidate.members)
        ? [...new Set(candidate.members.filter((member): member is string => typeof member === 'string' && member !== ''))]
        : []
      groups.push({
        id: candidate.id,
        // 组名与写入路径（applyAnnotationOp）同一收窄：trim + 长度上限。
        name: candidate.name.trim().slice(0, HISTORY_GROUP_NAME_MAX_CHARS),
        members: members.slice(0, HISTORY_GROUP_MEMBERS_MAX),
        time: typeof candidate.time === 'number' && Number.isFinite(candidate.time) ? candidate.time : 0,
      })
      if (groups.length >= HISTORY_GROUPS_MAX) break
    }
  }
  return { version: 1, comments, tags, groups }
}

/** 一个注解写操作（wire 形状；`id`/`time` 由路由在写路径铸造）。 */
export type HistoryAnnotationOp =
  | { op: 'commentAdd'; key: string; text: string; id: string; time: number }
  | { op: 'commentRemove'; key: string; commentId: string }
  | { op: 'tagAdd'; key: string; tag: string }
  | { op: 'tagRemove'; key: string; tag: string }
  | { op: 'groupCreate'; id: string; name: string; keys: readonly string[]; time: number }
  | { op: 'groupRename'; id: string; name: string }
  | { op: 'groupDelete'; id: string }
  | { op: 'groupAddMembers'; id: string; keys: readonly string[] }
  | { op: 'groupRemoveMember'; id: string; key: string }

/** op 的可识别名字（路由用它先做 wire 校验）。 */
export const HISTORY_ANNOTATION_OPS: readonly HistoryAnnotationOp['op'][] = [
  'commentAdd', 'commentRemove', 'tagAdd', 'tagRemove',
  'groupCreate', 'groupRename', 'groupDelete', 'groupAddMembers', 'groupRemoveMember',
]

/**
 * wire 侧的写操作形状：`commentAdd` / `groupCreate` 的 `id`/`time` 由服务端
 * 路由铸造（客户端不传），其余变体原样。历史操作与 {@link HistoryAnnotationOp}
 * 的唯一差别就在这两个铸造字段上。
 */
export type HistoryAnnotationOpInput = HistoryAnnotationOp extends infer Op
  ? Op extends { id: string; time: number } ? Omit<Op, 'id' | 'time'> : Op
  : never

/** 把一个列表挂载字段（不存在则建空数组）的最小工具。 */
function listOf(map: Record<string, string[]>, key: string): string[] {
  const existing = map[key]
  if (existing !== undefined) return existing
  const created: string[] = []
  map[key] = created
  return created
}

/**
 * 把一个写操作归并进注解库（纯函数）：返回新库，不修改入参。操作落在不存在
 * 的 key / 组上时按「尽力而为」处理（能建则建、不能建则原样返回），绝不抛错
 * ——注解写入永远不该把页签打挂。
 */
export function applyAnnotationOp(store: HistoryAnnotations, op: HistoryAnnotationOp): HistoryAnnotations {
  const next: HistoryAnnotations = {
    version: 1,
    comments: Object.fromEntries(Object.entries(store.comments).map(([key, list]) => [key, [...list]])),
    tags: Object.fromEntries(Object.entries(store.tags).map(([key, list]) => [key, [...list]])),
    groups: store.groups.map(group => ({ ...group, members: [...group.members] })),
  }
  switch (op.op) {
    case 'commentAdd': {
      if (typeof op.key !== 'string' || op.key === '') return next
      const text = typeof op.text === 'string' ? op.text.trim().slice(0, HISTORY_COMMENT_MAX_CHARS) : ''
      if (text === '') return next
      const list = next.comments[op.key] ?? []
      if (list.length >= HISTORY_COMMENTS_PER_RECORD) return next
      next.comments[op.key] = [...list, {
        id: op.id,
        text,
        time: typeof op.time === 'number' && Number.isFinite(op.time) ? op.time : 0,
      }]
      return next
    }
    case 'commentRemove': {
      const list = next.comments[op.key]
      if (list === undefined) return next
      const filtered = list.filter(comment => comment.id !== op.commentId)
      if (filtered.length === list.length) return next
      if (filtered.length === 0) delete next.comments[op.key]
      else next.comments[op.key] = filtered
      return next
    }
    case 'tagAdd': {
      const tag = normalizeTag(typeof op.tag === 'string' ? op.tag : '')
      if (tag === undefined || typeof op.key !== 'string' || op.key === '') return next
      const list = listOf(next.tags, op.key)
      if (list.includes(tag) || list.length >= HISTORY_TAGS_PER_RECORD) return next
      next.tags[op.key] = [...list, tag]
      return next
    }
    case 'tagRemove': {
      const list = next.tags[op.key]
      if (list === undefined) return next
      const filtered = list.filter(item => item !== op.tag)
      if (filtered.length === list.length) return next
      if (filtered.length === 0) delete next.tags[op.key]
      else next.tags[op.key] = filtered
      return next
    }
    case 'groupCreate': {
      const name = typeof op.name === 'string' ? op.name.trim().slice(0, HISTORY_GROUP_NAME_MAX_CHARS) : ''
      if (name === '' || next.groups.length >= HISTORY_GROUPS_MAX) return next
      const members = [...new Set(
        (Array.isArray(op.keys) ? op.keys : []).filter((key): key is string => typeof key === 'string' && key !== ''),
      )].slice(0, HISTORY_GROUP_MEMBERS_MAX)
      next.groups.push({
        id: op.id,
        name,
        members,
        time: typeof op.time === 'number' && Number.isFinite(op.time) ? op.time : 0,
      })
      return next
    }
    case 'groupRename': {
      const name = typeof op.name === 'string' ? op.name.trim().slice(0, HISTORY_GROUP_NAME_MAX_CHARS) : ''
      if (name === '') return next
      const group = next.groups.find(candidate => candidate.id === op.id)
      if (group === undefined) return next
      group.name = name
      return next
    }
    case 'groupDelete': {
      const filtered = next.groups.filter(group => group.id !== op.id)
      if (filtered.length === next.groups.length) return next
      next.groups = filtered
      return next
    }
    case 'groupAddMembers': {
      const group = next.groups.find(candidate => candidate.id === op.id)
      if (group === undefined) return next
      for (const key of Array.isArray(op.keys) ? op.keys : []) {
        if (typeof key !== 'string' || key === '' || group.members.includes(key)) continue
        if (group.members.length >= HISTORY_GROUP_MEMBERS_MAX) break
        group.members.push(key)
      }
      return next
    }
    case 'groupRemoveMember': {
      const group = next.groups.find(candidate => candidate.id === op.id)
      if (group === undefined) return next
      group.members = group.members.filter(member => member !== op.key)
      return next
    }
  }
}

/**
 * 一条记录挂到的关联组 id 列表（行上的组名 chips 与过滤共用同一答案）。
 */
export function groupIdsOfRecord(store: HistoryAnnotations, key: string): string[] {
  return store.groups.filter(group => group.members.includes(key)).map(group => group.id)
}

/** 一条记录的完整注解视图（行渲染一次取齐）。 */
export interface HistoryRecordAnnotation {
  comments: readonly HistoryComment[]
  tags: readonly string[]
  groupIds: readonly string[]
}

/** 组装一条记录的注解视图（缺失字段给空值，调用方零防御）。 */
export function annotationOfRecord(store: HistoryAnnotations, record: HistorySendRecord): HistoryRecordAnnotation {
  return {
    comments: store.comments[record.key] ?? [],
    tags: store.tags[record.key] ?? [],
    groupIds: groupIdsOfRecord(store, record.key),
  }
}
