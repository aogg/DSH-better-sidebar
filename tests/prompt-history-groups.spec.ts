/**
 * 「历史发送」纯逻辑之三：分组归并与过滤（src/prompt-history-groups.ts）。
 * 钉住：按会话归并（组内旧→新的聊天顺序、组间按最近记录倒序）、文本搜索
 * （大小写不敏感子串）与标签过滤（精确匹配、取数口注入）的交集语义、全库
 * 标签聚合，以及 mergeHistoryRecords 的按 key 幂等合并（同一条记录从首页/
 * 翻页/ws 哪条路径到达几次都只上屏一次——列表重复堆叠的回归锁）。
 */
import { describe, expect, it } from 'vitest'
import { collectHistoryTags, filterHistoryRecords, groupRecordsBySession, mergeHistoryRecords } from '../src/prompt-history-groups.ts'
import { emptyAnnotations, type HistoryAnnotations } from '../src/prompt-history-store.ts'
import type { HistorySendRecord } from '../src/prompt-history-extract.ts'

/** 记录夹具工厂（key 按 `${sessionId}:${seq}` 约定）。 */
function record(sessionId: string, seq: number, text: string, time = 1_700_000_000_000 + seq): HistorySendRecord {
  return { key: `${sessionId}:${seq}`, sessionId, seq, time, text, textTruncated: false }
}

describe('prompt-history groups（分组归并）', () => {
  it('平面记录按会话归并：组内旧→新（聊天顺序），组间按最近记录倒序', () => {
    const groups = groupRecordsBySession([
      record('b', 1, 'b1', 500),
      record('a', 1, 'a1', 900),
      record('b', 2, 'b2', 1000),
      record('a', 2, 'a2', 800),
    ])
    expect(groups.map(group => group.sessionId)).toEqual(['b', 'a'])
    expect(groups[0]!.records.map(item => item.seq)).toEqual([1, 2])
    expect(groups[0]!.count).toBe(2)
    expect(groups[0]!.lastTime).toBe(1000)
    expect(groups[1]!.lastTime).toBe(900)
  })

  it('信封时间缺失时用 seq 兜底排序（time=0 的记录不掉队）', () => {
    const groups = groupRecordsBySession([
      record('s', 1, '旧', 0),
      record('s', 5, '新', 0),
      record('s', 3, '中', 0),
    ])
    expect(groups[0]!.records.map(item => item.seq)).toEqual([1, 3, 5])
    expect(groups[0]!.lastTime).toBe(5)
  })

  it('空输入给空分组', () => {
    expect(groupRecordsBySession([])).toEqual([])
  })
})

describe('prompt-history groups（过滤）', () => {
  const records = [
    record('s', 1, 'Hello World'),
    record('s', 2, '写一个 Vue 组件'),
    record('s', 3, 'HELLO again'),
  ]

  it('文本搜索：大小写不敏感子串；空白词 = 不过滤', () => {
    expect(filterHistoryRecords(records, { search: 'hello' }).map(item => item.seq)).toEqual([1, 3])
    expect(filterHistoryRecords(records, { search: 'VUE' }).map(item => item.seq)).toEqual([2])
    expect(filterHistoryRecords(records, { search: '  ' })).toEqual(records)
    expect(filterHistoryRecords(records, {})).toEqual(records)
  })

  it('标签过滤走取数口：精确匹配，无取数口视为无标签', () => {
    const tagsOf = (item: HistorySendRecord): string[] => (item.seq === 1 ? ['研究'] : item.seq === 2 ? ['研究', 'vue'] : [])
    expect(filterHistoryRecords(records, { tag: '研究', tagSource: tagsOf }).map(item => item.seq)).toEqual([1, 2])
    expect(filterHistoryRecords(records, { tag: 'vue', tagSource: tagsOf }).map(item => item.seq)).toEqual([2])
    expect(filterHistoryRecords(records, { tag: '研究' })).toEqual([])
    // 文本 + 标签取交集。
    expect(filterHistoryRecords(records, { search: 'hello', tag: '研究', tagSource: tagsOf }).map(item => item.seq)).toEqual([1])
  })

  it('过滤不改入参（返回新数组）', () => {
    const snapshot = [...records]
    filterHistoryRecords(records, { search: 'hello' })
    expect(records).toEqual(snapshot)
  })
})

describe('prompt-history groups（标签聚合）', () => {
  it('全库标签去重 + 字典序，与记录可见性无关', () => {
    const store: HistoryAnnotations = emptyAnnotations()
    store.tags['s:1'] = ['研究', 'vue']
    store.tags['s:2'] = ['bug']
    expect(collectHistoryTags(store)).toEqual(['bug', 'vue', '研究'])
    expect(collectHistoryTags(emptyAnnotations())).toEqual([])
  })
})

describe('prompt-history groups（mergeHistoryRecords：多路径合并的幂等兜底）', () => {
  it('同 key 记录多路径到达只上屏一次：首页 + ws 帧 + 补拉各来一遍', () => {
    // 首页已上屏两条。
    const onScreen = [record('s', 1, '首页一'), record('s', 2, '首页二')]
    // ws 实时帧：一条新账 + 一条与首页相同的账（扫描/实时竞态的重复出站）。
    const wsFrame = [record('s', 3, '实时新账'), record('s', 1, '首页一')]
    const afterWs = mergeHistoryRecords(onScreen, wsFrame)
    expect(afterWs.map(item => item.key)).toEqual(['s:1', 's:2', 's:3'])
    // 扫描收尾补拉首页：整页全是已上屏的账 + 一条翻页前的漏网新账。
    const refetchPage = [record('s', 4, '补拉新账'), record('s', 3, '实时新账'), record('s', 2, '首页二')]
    const afterRefetch = mergeHistoryRecords(afterWs, refetchPage)
    expect(afterRefetch.map(item => item.key)).toEqual(['s:1', 's:2', 's:3', 's:4'])
  })

  it('incoming 批次内部同 key 也只留第一条；空 incoming 原样返回同内容新数组', () => {
    const existing = [record('s', 1, '一')]
    const merged = mergeHistoryRecords(existing, [record('s', 2, '二'), record('s', 2, '二重复'), record('s', 1, '一重复')])
    expect(merged.map(item => item.key)).toEqual(['s:1', 's:2'])
    expect(merged[1]!.text).toBe('二')
    const untouched = mergeHistoryRecords(existing, [])
    expect(untouched).toEqual(existing)
    expect(untouched).not.toBe(existing)
  })

  it('不改入参；垃圾项（null/非对象）跳过不抛', () => {
    const existing = [record('s', 1, '一')]
    const snapshot = [...existing]
    const incoming = [null, undefined, record('s', 2, '二')] as unknown as HistorySendRecord[]
    const merged = mergeHistoryRecords(existing, incoming)
    expect(existing).toEqual(snapshot)
    expect(merged.map(item => item.key)).toEqual(['s:1', 's:2'])
  })
})
