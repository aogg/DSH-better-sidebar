/**
 * 「历史发送」纯逻辑之一：会话事件日志 → 用户发送过的提示词记录。
 *
 * 与 src/client/sidechat-transcript.ts 约 442 行起的 user/message 映射同一套
 * 识别规则（框架自由，宿主路由与测试环境都能直接导入，同 sidechat-core.ts
 * 的先例）：
 * - 只认 `user/message` 事件；content 既可以是块数组也可以是裸字符串；
 * - 上下文注入（边界提示词、plugin 来源的注入消息）一律不算用户发送；
 * - 旧线程「边界提示词+问题挤在同一条 'user' 消息」的形态按 transcript 的
 *   切法拆开：注入行丢弃，边界之后的正文作为真正的用户发送保留；
 * - fork 种子里继承的前缀（seq < inheritedEventCount）整段跳过——那些消息
 *   已经在父会话里记过账，这里再收一遍就是重复行；
 * - 单条文本与单会话条数都有上限：超限只影响展示（带 truncated 标记由
 *   UI 说明），绝不抛错。
 *
 * 记录 key 恒为 `${sessionId}:${seq}`（会话内 seq 单调，跨会话靠 sessionId
 * 区分），是注解存储（prompt-history-store.ts）与关联组成员的稳定锚。
 */
import { isContextInjectionMessage, SIDE_BOUNDARY_PROMPT } from './sidechat-core.ts'

/** 一条用户发送记录（wire 与注解存储共用的形状）。 */
export interface HistorySendRecord {
  /** `${sessionId}:${seq}`，注解/关联的稳定 key。 */
  key: string
  /** 所属会话（分组头按它归并）。 */
  sessionId: string
  /** 源事件在会话日志里的 seq（key 的后半段）。 */
  seq: number
  /** 事件信封时间（epoch ms；信封缺时间时为 0，排序按提供方兜底）。 */
  time: number
  /** 提示词文本（text blocks 以空行拼接，超长截断）。 */
  text: string
  /** 文本因超过 {@link HISTORY_TEXT_MAX_CHARS} 被截断。 */
  textTruncated: boolean
}

/** 单条记录保留的最大文本长度（字符）；超出截断并打 textTruncated 标记。 */
export const HISTORY_TEXT_MAX_CHARS = 8000

/** content 的可见文本：text blocks 按空行拼接（对齐 transcript 的 blockText）。 */
function contentTextOf(data: Record<string, unknown>): string {
  const content = data.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n\n')
}

/** 一条日志事件的本模块最小结构面（接受宿主 SessionEvent 与宽松夹具）。 */
export interface HistorySourceEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** 截断到上限，并回答是否发生了截断。 */
function clampText(text: string): { text: string; textTruncated: boolean } {
  if (text.length <= HISTORY_TEXT_MAX_CHARS) return { text, textTruncated: false }
  return { text: text.slice(0, HISTORY_TEXT_MAX_CHARS), textTruncated: true }
}

/**
 * 从一个会话的事件日志抽取用户发送记录（时间升序）。
 * @param sessionId - 记录归属的会话 id（组成 key）。
 * @param events - 会话事件日志（宿主信封或宽松夹具）。
 * @param options.inheritedEventCount - fork 种子前缀长度，前缀内整段跳过。
 * @param options.limit - 最多返回最近多少条；超出时丢弃最旧的并置 truncated。
 * @returns 记录列表（升序）+ 是否因 limit 丢弃过记录。
 *
 * 种子切有两道（同 sidechat-core.ts threadOwnLogEvents 的口径）：fork 种子的
 * 最后一个 `session/end-seed` 标记之前（含标记）整段跳过——活会话快照拿不到
 * inheritedEventCount，标记切是唯一可用的种子识别；inheritedEventCount 则是
 * 持久句柄给出的精确前缀长度（老日志没有标记时的兜底）。两道同时生效。
 */
export function extractSendRecords(
  sessionId: string,
  events: readonly HistorySourceEvent[],
  options: { inheritedEventCount?: number; limit?: number } = {},
): { records: HistorySendRecord[]; truncated: boolean } {
  const seedSeq = typeof options.inheritedEventCount === 'number' && Number.isFinite(options.inheritedEventCount)
    ? Math.max(0, Math.floor(options.inheritedEventCount))
    : 0
  // 种子标记切：最后一个 session/end-seed 的数组下标（找不到为 -1）。
  let seedMarkerIndex = -1
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]?.type === 'session/end-seed') {
      seedMarkerIndex = index
      break
    }
  }
  const records: HistorySendRecord[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) continue
    // fork 种子继承的前缀：消息已在源会话记过账，这里整段跳过。
    if (event.seq < seedSeq || index <= seedMarkerIndex) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const raw = contentTextOf(data)
    // 空文本（纯注入/纯附件消息）不构成一条可见发送。
    if (raw.trim() === '') continue
    if (isContextInjectionMessage(data)) {
      // 旧线程边界+问题同条：按 transcript 的切法保留边界之后的正文。
      const source = data.source as { kind?: unknown } | undefined
      if (source?.kind !== 'user') continue
      if (!raw.startsWith(`${SIDE_BOUNDARY_PROMPT}\n\n`)) continue
      const body = raw.slice(SIDE_BOUNDARY_PROMPT.length + 2)
      if (body.trim() === '') continue
      const clamped = clampText(body)
      records.push({
        key: `${sessionId}:${event.seq}`,
        sessionId,
        seq: event.seq,
        time: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0,
        ...clamped,
      })
      continue
    }
    const clamped = clampText(raw)
    records.push({
      key: `${sessionId}:${event.seq}`,
      sessionId,
      seq: event.seq,
      time: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0,
      ...clamped,
    })
  }
  const limit = typeof options.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : undefined
  if (limit !== undefined && records.length > limit) {
    return { records: records.slice(records.length - limit), truncated: true }
  }
  return { records, truncated: false }
}
