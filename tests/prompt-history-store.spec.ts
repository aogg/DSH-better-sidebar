/**
 * 「历史发送」纯逻辑之二：注解存储（评论/标签/关联组）的归一化与操作归并
 * （src/prompt-history-store.ts）。钉住：损坏/半损坏文件的防御性归一化、
 * 九个写操作的归并语义（含上限与去重）、纯函数性（不改入参）。
 */
import { describe, expect, it } from 'vitest'
import {
  annotationOfRecord,
  applyAnnotationOp,
  emptyAnnotations,
  normalizeAnnotations,
  HISTORY_TAGS_PER_RECORD,
  type HistoryAnnotations,
} from '../src/prompt-history-store.ts'

/** 一个合法库的基线（各用例在它的拷贝上改）。 */
function baseStore(): HistoryAnnotations {
  return {
    version: 1,
    comments: { 's:1': [{ id: 'c1', text: '好问题', time: 100 }] },
    tags: { 's:1': ['研究'] },
    groups: [{ id: 'g1', name: '调研组', members: ['s:1'], time: 100 }],
  }
}

describe('prompt-history store（注解归一化）', () => {
  it('非法输入整体归空：null / 数组 / 基本类型', () => {
    expect(normalizeAnnotations(undefined)).toEqual(emptyAnnotations())
    expect(normalizeAnnotations(null)).toEqual(emptyAnnotations())
    expect(normalizeAnnotations([1, 2])).toEqual(emptyAnnotations())
    expect(normalizeAnnotations('junk')).toEqual(emptyAnnotations())
  })

  it('合法字段逐个收窄：垃圾条目丢弃、合法条目保留（半损坏不丢另一半）', () => {
    const store = normalizeAnnotations({
      comments: {
        's:1': [
          { id: 'c1', text: '保留', time: 5 },
          { id: '', text: '无 id 丢弃' },
          { id: 'c2', text: '   ' },
          'junk',
          { id: 'c3', text: '无时间补零' },
        ],
        '': [{ id: 'cx', text: '空 key 丢弃' }],
        's:2': 'not-an-array',
      },
      tags: { 's:1': [' a ', 'a', '', 7, 'b'], bad: 'nope' },
      groups: [
        { id: 'g1', name: ' 组 ', members: ['s:1', 's:1', ''], time: 3 },
        { id: '', name: '无 id 丢弃' },
        { id: 'g2', name: '' },
        'junk',
      ],
    })
    expect(store.comments['s:1']).toEqual([
      { id: 'c1', text: '保留', time: 5 },
      { id: 'c3', text: '无时间补零', time: 0 },
    ])
    expect(store.comments['']).toBeUndefined()
    expect(store.tags['s:1']).toEqual(['a', 'b'])
    expect(store.groups).toEqual([{ id: 'g1', name: '组', members: ['s:1'], time: 3 }])
  })
})

describe('prompt-history store（操作归并）', () => {
  it('commentAdd 追加带时间评论；空文本/空 key 原样返回', () => {
    const store = baseStore()
    const next = applyAnnotationOp(store, { op: 'commentAdd', key: 's:1', text: ' 补充 ', id: 'c2', time: 200 })
    expect(next.comments['s:1']).toEqual([
      { id: 'c1', text: '好问题', time: 100 },
      { id: 'c2', text: '补充', time: 200 },
    ])
    expect(applyAnnotationOp(store, { op: 'commentAdd', key: 's:1', text: '   ', id: 'c3', time: 1 }).comments['s:1']).toHaveLength(1)
    expect(applyAnnotationOp(store, { op: 'commentAdd', key: '', text: 'x', id: 'c3', time: 1 })).toEqual(store)
  })

  it('commentRemove 删指定评论；删空后清掉挂载字段；未知 id 原样返回', () => {
    const store = baseStore()
    const both = applyAnnotationOp(store, { op: 'commentAdd', key: 's:1', text: 'b', id: 'c2', time: 2 })
    const removed = applyAnnotationOp(both, { op: 'commentRemove', key: 's:1', commentId: 'c1' })
    expect(removed.comments['s:1']).toEqual([{ id: 'c2', text: 'b', time: 2 }])
    const emptied = applyAnnotationOp(removed, { op: 'commentRemove', key: 's:1', commentId: 'c2' })
    expect(emptied.comments['s:1']).toBeUndefined()
    expect(applyAnnotationOp(store, { op: 'commentRemove', key: 's:1', commentId: 'nope' }).comments['s:1']).toEqual(store.comments['s:1'])
  })

  it('tagAdd 去重 + trim；tagRemove 删空清字段；单记录标签数有上限', () => {
    const store = baseStore()
    const added = applyAnnotationOp(store, { op: 'tagAdd', key: 's:1', tag: ' 研究 ' })
    expect(added.tags['s:1']).toEqual(['研究'])
    expect(applyAnnotationOp(store, { op: 'tagAdd', key: 's:1', tag: '研究' }).tags['s:1']).toEqual(['研究'])
    const removed = applyAnnotationOp(added, { op: 'tagRemove', key: 's:1', tag: '研究' })
    expect(removed.tags['s:1']).toBeUndefined()
    const capped = emptyAnnotations()
    for (let index = 0; index < HISTORY_TAGS_PER_RECORD + 5; index++) {
      Object.assign(capped, applyAnnotationOp(capped, { op: 'tagAdd', key: 's:9', tag: `t${index}` }))
    }
    expect(capped.tags['s:9']).toHaveLength(HISTORY_TAGS_PER_RECORD)
  })

  it('groupCreate 建组（成员去重保序）；groupRename/groupDelete 只作用于存在的组', () => {
    const store = applyAnnotationOp(baseStore(), { op: 'groupCreate', id: 'g2', name: ' 新组 ', keys: ['s:2', 's:2', '', 's:3'], time: 9 })
    expect(store.groups.at(-1)).toEqual({ id: 'g2', name: '新组', members: ['s:2', 's:3'], time: 9 })
    const renamed = applyAnnotationOp(store, { op: 'groupRename', id: 'g2', name: '改名' })
    expect(renamed.groups.at(-1)!.name).toBe('改名')
    expect(applyAnnotationOp(store, { op: 'groupRename', id: 'nope', name: 'x' }).groups).toEqual(store.groups)
    const deleted = applyAnnotationOp(renamed, { op: 'groupDelete', id: 'g2' })
    expect(deleted.groups.some(group => group.id === 'g2')).toBe(false)
    expect(applyAnnotationOp(store, { op: 'groupDelete', id: 'nope' }).groups).toEqual(store.groups)
  })

  it('groupAddMembers/groupRemoveMember 维护成员表（组内记录不动会话分组）', () => {
    const store = applyAnnotationOp(baseStore(), { op: 'groupAddMembers', id: 'g1', keys: ['s:2', 's:1'] })
    expect(store.groups[0]!.members).toEqual(['s:1', 's:2'])
    const removed = applyAnnotationOp(store, { op: 'groupRemoveMember', id: 'g1', key: 's:1' })
    expect(removed.groups[0]!.members).toEqual(['s:2'])
    expect(applyAnnotationOp(store, { op: 'groupAddMembers', id: 'nope', keys: ['s:2'] })).toEqual(store)
  })

  it('纯函数性：applyAnnotationOp 不修改入参', () => {
    const store = baseStore()
    const snapshot = JSON.stringify(store)
    applyAnnotationOp(store, { op: 'commentAdd', key: 's:1', text: 'x', id: 'c9', time: 1 })
    applyAnnotationOp(store, { op: 'groupAddMembers', id: 'g1', keys: ['s:5'] })
    applyAnnotationOp(store, { op: 'tagRemove', key: 's:1', tag: '研究' })
    expect(JSON.stringify(store)).toBe(snapshot)
  })

  it('annotationOfRecord：缺失字段给空值，组 id 映射留给调用方', () => {
    const store = baseStore()
    expect(annotationOfRecord(store, { key: 's:1', sessionId: 's', seq: 1, time: 0, text: '', textTruncated: false })).toEqual({
      comments: [{ id: 'c1', text: '好问题', time: 100 }],
      tags: ['研究'],
      groupIds: ['g1'],
    })
    expect(annotationOfRecord(store, { key: 'none', sessionId: 's', seq: 9, time: 0, text: '', textTruncated: false })).toEqual({
      comments: [],
      tags: [],
      groupIds: [],
    })
  })
})
