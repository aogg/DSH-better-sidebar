/**
 * 「历史发送」纯逻辑之一：会话事件 → 用户发送记录的抽取
 * （src/prompt-history-extract.ts）。钉住识别规则与 transcript 的 user/message
 * 映射同口径：块数组/裸字符串 content、注入消息排除、旧线程边界+问题拆分、
 * 种子切（session/end-seed 标记 + inheritedEventCount）、单条文本上限、单会话
 * 条数上限（truncated 标记）与 key 形状 `${sessionId}:${seq}`。
 */
import { describe, expect, it } from 'vitest'
import { extractSendRecords, HISTORY_TEXT_MAX_CHARS, type HistorySourceEvent } from '../src/prompt-history-extract.ts'
import { SIDE_BOUNDARY_PROMPT, SIDE_INJECTION_SOURCE_KIND } from '../src/sidechat-core.ts'

/** 事件夹具工厂（宽松信封）。 */
function userMessage(seq: number, text: string, over: Partial<HistorySourceEvent> = {}): HistorySourceEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { content: [{ type: 'text', text }] },
    ...over,
  }
}

/** 旧线程形态：边界提示词 + 问题挤在同一条 'user' 消息里。 */
function legacyBoundaryMessage(seq: number, question: string): HistorySourceEvent {
  return userMessage(seq, `${SIDE_BOUNDARY_PROMPT}\n\n${question}`, {
    data: { content: [{ type: 'text', text: `${SIDE_BOUNDARY_PROMPT}\n\n${question}` }], source: { kind: 'user' } },
  })
}

describe('prompt-history extract（事件→发送记录）', () => {
  it('抽取 user/message 的可见文本：块数组拼接、裸字符串、key 形状', () => {
    const events: HistorySourceEvent[] = [
      userMessage(0, '第一问'),
      { type: 'assistant/message', seq: 1, time: 2, data: {} },
      userMessage(2, '第二问', { data: { content: '裸字符串问法' } }),
    ]
    const { records, truncated } = extractSendRecords('session-a', events)
    expect(truncated).toBe(false)
    expect(records.map(record => [record.key, record.text])).toEqual([
      ['session-a:0', '第一问'],
      ['session-a:2', '裸字符串问法'],
    ])
    expect(records[0]!.sessionId).toBe('session-a')
    expect(records[0]!.seq).toBe(0)
    expect(records[0]!.textTruncated).toBe(false)
  })

  it('assistant/tool 等其他事件一概不算用户发送', () => {
    const events: HistorySourceEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '回答' }] } } },
      { type: 'tool/call', seq: 2, time: 3, data: {} },
      userMessage(3, '唯一一问'),
    ]
    const { records } = extractSendRecords('s', events)
    expect(records.map(record => record.seq)).toEqual([3])
  })

  it('注入消息排除：plugin 来源的注入与边界提示词前缀都不算发送', () => {
    const events: HistorySourceEvent[] = [
      // 新线程：agent.inject 投递的边界提示（plugin 来源 kind）。
      userMessage(0, SIDE_BOUNDARY_PROMPT, { data: { content: [{ type: 'text', text: SIDE_BOUNDARY_PROMPT }], source: { kind: SIDE_INJECTION_SOURCE_KIND } } }),
      // 旧线程：边界+问题同条 'user' 消息 → 只保留边界之后的正文。
      legacyBoundaryMessage(1, '真正的追问'),
      // 纯注入（只有边界、没有正文）：整条丢弃。
      legacyBoundaryMessage(2, ''),
    ]
    const { records } = extractSendRecords('s', events)
    expect(records.map(record => record.text)).toEqual(['真正的追问'])
  })

  it('种子切：session/end-seed 标记之前的消息全部跳过（活快照无 inheritedEventCount 也能切干净）', () => {
    const events: HistorySourceEvent[] = [
      userMessage(0, '父会话的一问'),
      userMessage(1, '父会话的二问'),
      { type: 'session/end-seed', seq: 2, time: 3, data: {} },
      userMessage(3, '线程自己的问题'),
    ]
    const { records } = extractSendRecords('child', events)
    expect(records.map(record => record.key)).toEqual(['child:3'])
  })

  it('种子切：inheritedEventCount 兜底（没有标记的老日志）', () => {
    const events: HistorySourceEvent[] = [
      userMessage(0, '继承的一问'),
      userMessage(1, '自己的问题'),
    ]
    const { records } = extractSendRecords('child', events, { inheritedEventCount: 1 })
    expect(records.map(record => record.key)).toEqual(['child:1'])
  })

  it('limit 保留最近 N 条并置 truncated', () => {
    const events: HistorySourceEvent[] = [1, 2, 3, 4, 5].map(seq => userMessage(seq, `问 ${seq}`))
    const { records, truncated } = extractSendRecords('s', events, { limit: 2 })
    expect(truncated).toBe(true)
    expect(records.map(record => record.seq)).toEqual([4, 5])
    const exact = extractSendRecords('s', events, { limit: 5 })
    expect(exact.truncated).toBe(false)
    expect(exact.records).toHaveLength(5)
  })

  it('超长文本截断并打 textTruncated 标记', () => {
    const long = 'x'.repeat(HISTORY_TEXT_MAX_CHARS + 10)
    const { records } = extractSendRecords('s', [userMessage(0, long)])
    expect(records[0]!.textTruncated).toBe(true)
    expect(records[0]!.text).toHaveLength(HISTORY_TEXT_MAX_CHARS)
  })

  it('脏信封防御：无 content / 纯空白 / 非法 seq 的事件跳过，不抛错', () => {
    const events: HistorySourceEvent[] = [
      { type: 'user/message', seq: 0, time: 1, data: {} },
      { type: 'user/message', seq: 1, time: 2, data: { content: '   ' } },
      { type: 'user/message', seq: -1, time: 3, data: { content: 'bad' } },
      { type: 'user/message', seq: 2, time: 4, data: { content: [{ type: 'image' }] } },
      null as unknown as HistorySourceEvent,
      userMessage(3, 'ok'),
    ]
    const { records } = extractSendRecords('s', events)
    expect(records.map(record => record.key)).toEqual(['s:3'])
  })
})
