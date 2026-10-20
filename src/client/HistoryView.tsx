/**
 * 「历史发送」页签（type: 'history'，单实例）：当前项目的聊天式提示词历史。
 *
 * 数据面（契约，v0.28.0+）：
 * - `history.list` 每次回一页当前项目的记录：新→旧的跨会话复合平铺序，
 *   `nextCursor` 翻页游标（「加载更多」透传），`seeding` 标记宿主索引还在
 *   建设中（此时不带 cursor 重拉首页会不断合并出新记录，本页每 ~1s 轮询到
 *   它翻 false 为止）；`degraded` 表示只降级到当前会话；
 * - 记录 key 恒为 `${sessionId}:${seq}`，是评论/标签/关联组成员的稳定锚；
 * - 评论/标签/关联组来自 `history.annotationsGet`，写操作走
 *   `history.annotationsUpdate`（单个 op 归并，返回写后的全量注解库——本页
 *   不自造乐观状态）。
 *
 * 交互流（渐进显示，绝不阻塞式 loading）：
 * 1. 首开立即渲染空列表 + 顶部细加载条，随后异步拉首页；
 * 2. 每页到达后新记录进入发送队列，按 ~40ms 一条的微节奏逐条上屏；
 * 3. `seeding` 期间轮询首页合并新记录；`connectSessionPush` 的
 *    `kind:'history'` 帧（sessionId 在已加载记录的会话集合内）同样走该
 *    队列实时逐条追加；
 * 4. 「加载更多」按 `hasMore`/`nextCursor` 拉下一页，追加走同一队列。
 *
 * 展示：按会话（=一场对话）分组保留，组内时间正序（旧→新的聊天顺序），
 * 组间按最近一条消息新→旧；组头 = 会话标识 + 最近时间 + 条数；行文本默认
 * 3 行截断、点击展开全文可收起。搜索/标签过滤/多选建组/评论/标签/关联组
 * 全部保留，作用域 = 已加载记录（工具条下有说明行）。
 *
 * 降级路径（绝不抛未捕获异常）：`history.list` 失败（宿主 persistence 缺席
 * 的 503 `history-error`、网络失败等）→ 页签内联降级提示 + 重试按钮；翻页
 * 失败 → 工具条下的内联错误行（可关闭）；ws 断连/轮询失败静默（现有列表
 * 继续可用，重连后自动恢复追加）；注解写失败 → 同一内联错误行；空库 →
 * 空态文案。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, SidebarApiError, type HistoryListResult } from './api.ts'
import { connectSessionPush } from './session-push.ts'
import { formatStamp, formatStampFull, t } from './locales.ts'
import { collectHistoryTags, filterHistoryRecords, groupRecordsBySession, type HistorySessionGroup } from '../prompt-history-groups.ts'
import { annotationOfRecord, emptyAnnotations, type HistoryAnnotationOpInput, type HistoryAnnotations, type HistoryComment } from '../prompt-history-store.ts'
import type { HistorySendRecord } from '../prompt-history-extract.ts'
import css from './HistoryView.module.css'

/** 逐条上屏的微节奏（一条接一条的间隔；太短看不出渐进，太长拖泥带水）。 */
const DRIP_INTERVAL_MS = 40
/** seeding 轮询首页的节奏。 */
const SEED_POLL_MS = 1000
/** 实时新记录提示条的停留时长。 */
const LIVE_NOTICE_MS = 4000
/** ws watch 集上限（当前会话 + 已加载记录出现过的会话，去重后截断）。 */
const WATCH_SESSIONS_MAX = 64

/** 会话标识的短拼法（去掉 `session-` 前缀，取前 8 位；完整 id 走 title）。 */
function shortSessionId(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

/** cwd 的末段（分组头的会话标识优先用项目名）。 */
function baseNameOf(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(part => part !== '')
  return parts.at(-1) ?? cwd
}

/** 记录文本的一行短拼（关联组成员 chip 用）。 */
function shortTextOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

/**
 * history 帧负载的宽松校验：只收形状完整的记录（key/sessionId/text 是串、
 * seq 是非负整数），脏帧静默丢弃——实时追加绝不能因一条坏帧抛异常。
 */
function historyRecordsOf(payload: unknown): HistorySendRecord[] {
  if (!Array.isArray(payload)) return []
  const out: HistorySendRecord[] = []
  for (const item of payload) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as Partial<HistorySendRecord>
    if (typeof candidate.key !== 'string' || candidate.key === '') continue
    if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') continue
    if (typeof candidate.seq !== 'number' || !Number.isSafeInteger(candidate.seq) || candidate.seq < 0) continue
    if (typeof candidate.text !== 'string') continue
    out.push({
      key: candidate.key,
      sessionId: candidate.sessionId,
      seq: candidate.seq,
      time: typeof candidate.time === 'number' && Number.isFinite(candidate.time) ? candidate.time : 0,
      text: candidate.text,
      textTruncated: candidate.textTruncated === true,
    })
  }
  return out
}

/** history.list 的请求负载（sessionId 取页签 scope；cursor 仅翻页时带）。 */
function listPayload(sessionId: string | undefined, cursor?: string): { sessionId?: string; cursor?: string } {
  return {
    ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    ...(cursor !== undefined && cursor !== '' ? { cursor } : {}),
  }
}

/** 一页响应收敛出的列表元数据（游标/翻页/索引/降级/项目根）。 */
interface HistoryMeta {
  nextCursor?: string
  hasMore: boolean
  seeding: boolean
  degraded: boolean
  projectCwd?: string
}

const HISTORY_META_EMPTY: HistoryMeta = { hasMore: false, seeding: false, degraded: false }

/** 一页响应 → 元数据（available 恒 true，已在类型层挡掉）。 */
function metaOf(list: HistoryListResult): HistoryMeta {
  return {
    nextCursor: list.nextCursor,
    hasMore: list.hasMore === true,
    seeding: list.seeding === true,
    degraded: list.degraded === true,
    projectCwd: list.project?.cwd,
  }
}

/** 一条发送记录行：时间、截断文本、评论/标签/组 chips 与行内编辑器。 */
function RecordRow(props: {
  record: HistorySendRecord
  comments: readonly HistoryComment[]
  tags: readonly string[]
  groupNames: readonly string[]
  expanded: boolean
  multiSelect: boolean
  selected: boolean
  onToggleExpand: (key: string) => void
  onToggleSelect: (key: string) => void
  onMutate: (op: HistoryAnnotationOpInput) => Promise<boolean>
}) {
  const { record, comments, tags, groupNames, expanded, multiSelect, selected } = props
  const [commentDraft, setCommentDraft] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  const submitComment = (): void => {
    const text = commentDraft.trim()
    if (text === '') return
    void props.onMutate({ op: 'commentAdd', key: record.key, text }).then(ok => {
      if (ok) setCommentDraft('')
    })
  }
  const submitTag = (): void => {
    const tag = tagDraft.trim()
    if (tag === '') return
    void props.onMutate({ op: 'tagAdd', key: record.key, tag }).then(ok => {
      if (ok) setTagDraft('')
    })
  }
  const timeLabel = record.time !== 0 ? formatStamp(record.time) : ''
  const timeFull = record.time !== 0 ? formatStampFull(record.time) : ''
  return (
    <div className={css.record} data-dsh-history-record={record.key}>
      {multiSelect && (
        <input
          type="checkbox"
          className={css.recordCheck}
          checked={selected}
          aria-label={t('historyMultiSelect')}
          onChange={() => { props.onToggleSelect(record.key) }}
        />
      )}
      <div className={css.rowMain}>
        <div className={css.rowMeta}>
          {timeLabel !== '' && <span className={css.time} title={timeFull}>{timeLabel}</span>}
          <button
            type="button"
            className={`${css.chip} ${css.chipButton}`}
            title={t('historyComments', { count: comments.length })}
            onClick={() => { props.onToggleExpand(record.key) }}
          >
            {t('historyComments', { count: comments.length })}
          </button>
          {tags.map(tag => (
            <span key={tag} className={css.chip}>
              {tag}
              <button
                type="button"
                className={css.chipRemove}
                aria-label={t('historyTagRemove')}
                onClick={() => { void props.onMutate({ op: 'tagRemove', key: record.key, tag }) }}
              >
                ×
              </button>
            </span>
          ))}
          {groupNames.map(name => (
            <span key={name} className={`${css.chip} ${css.groupChip}`}>{name}</span>
          ))}
          {record.textTruncated && <span className={css.note}>{t('historyTextTruncated')}</span>}
        </div>
        <div
          className={expanded ? css.text : css.textClamped}
          role="button"
          tabIndex={expanded ? -1 : 0}
          onClick={() => { if (!expanded) props.onToggleExpand(record.key) }}
          onKeyDown={event => {
            if (expanded) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              props.onToggleExpand(record.key)
            }
          }}
        >
          {record.text}
        </div>
        {expanded && (
          <button type="button" className={css.collapse} onClick={() => { props.onToggleExpand(record.key) }}>
            {t('historyCollapse')}
          </button>
        )}
        {expanded && (
          <div className={css.detail}>
            <div>
              <div className={css.detailTitle}>{t('historyComments', { count: comments.length })}</div>
              {comments.map(comment => (
                <div key={comment.id} className={css.commentRow}>
                  <span className={css.commentText}>{comment.text}</span>
                  <span className={css.commentTime} title={formatStampFull(comment.time)}>
                    {comment.time !== 0 ? formatStamp(comment.time) : ''}
                  </span>
                  <button
                    type="button"
                    className={css.commentDelete}
                    aria-label={t('historyCommentDelete')}
                    onClick={() => { void props.onMutate({ op: 'commentRemove', key: record.key, commentId: comment.id }) }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className={css.inlineForm}>
                <input
                  value={commentDraft}
                  placeholder={t('historyCommentPlaceholder')}
                  onChange={event => { setCommentDraft(event.target.value) }}
                  onKeyDown={event => { if (event.key === 'Enter') submitComment() }}
                />
                <button type="button" className={css.ghost} onClick={submitComment}>
                  {t('historyCommentAdd')}
                </button>
              </div>
            </div>
            <div>
              <div className={css.detailTitle}>{t('historyTagsLabel')}</div>
              <div className={css.inlineForm}>
                <input
                  value={tagDraft}
                  placeholder={t('historyTagPlaceholder')}
                  onChange={event => { setTagDraft(event.target.value) }}
                  onKeyDown={event => { if (event.key === 'Enter') submitTag() }}
                />
                <button type="button" className={css.ghost} onClick={submitTag}>
                  {t('historyTagAdd')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 「历史发送」页签本体。`visible` 是页签激活+面板展开信号（保留给后续的
 * 可见性懒加载；首屏挂载即渲染空列表 + 细加载条，随后异步渐进填充）。
 */
export function HistoryView(props: { visible?: boolean; sessionId?: string }): React.JSX.Element {
  void props.visible
  // 渐进上屏的记录（可见列表）与其元数据。
  const [records, setRecords] = useState<HistorySendRecord[]>([])
  const [meta, setMeta] = useState<HistoryMeta>(HISTORY_META_EMPTY)
  const [annotations, setAnnotations] = useState<HistoryAnnotations>(emptyAnnotations)
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  // 实时（轮询/ws）合并进来的新记录数（提示条展示几秒后自动清零）。
  const [liveCount, setLiveCount] = useState(0)
  // ws watch 集（当前会话 + 已加载记录出现过的会话；仅集合内容变化才更新，
  // 避免 drip 每条都重连 socket）。
  const [watchSessions, setWatchSessions] = useState<readonly string[]>([])
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [groupName, setGroupName] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')

  // ── 渐进队列：enqueue 去重入队，pump 按 ~40ms 一条 setRecords 上屏 ──
  const seenKeysRef = useRef<Set<string>>(new Set())
  const sessionKeysRef = useRef<Set<string>>(new Set())
  const queueRef = useRef<HistorySendRecord[]>([])
  const dripTimerRef = useRef<number | undefined>(undefined)
  const liveTimerRef = useRef<number | undefined>(undefined)
  const watchRef = useRef<readonly string[]>([])
  const metaRef = useRef<HistoryMeta>(HISTORY_META_EMPTY)

  const pumpRef = useRef<() => void>(() => {
    const next = queueRef.current.shift()
    if (next === undefined) {
      dripTimerRef.current = undefined
      return
    }
    setRecords(previous => [...previous, next])
    dripTimerRef.current = window.setTimeout(() => { pumpRef.current() }, DRIP_INTERVAL_MS)
  })
  const enqueue = useCallback((incoming: readonly HistorySendRecord[]): number => {
    let added = 0
    for (const record of incoming) {
      if (record === null || typeof record !== 'object') continue
      if (seenKeysRef.current.has(record.key)) continue
      seenKeysRef.current.add(record.key)
      sessionKeysRef.current.add(record.sessionId)
      queueRef.current.push(record)
      added += 1
    }
    if (added > 0 && dripTimerRef.current === undefined) {
      dripTimerRef.current = window.setTimeout(() => { pumpRef.current() }, DRIP_INTERVAL_MS)
    }
    return added
  }, [])

  // watch 集重算：只在集合内容变化时 setState（每次 merge 后调用一次，
  // 与 drip 的逐条上屏解耦——socket 不随单条记录重连）。
  const refreshWatch = useCallback((): void => {
    const set = new Set(sessionKeysRef.current)
    if (props.sessionId !== undefined && props.sessionId !== '') set.add(props.sessionId)
    const list = [...set].slice(0, WATCH_SESSIONS_MAX)
    if (list.length === watchRef.current.length && list.every((id, index) => id === watchRef.current[index])) return
    watchRef.current = list
    setWatchSessions(list)
  }, [props.sessionId])

  const flashLive = useCallback((added: number): void => {
    if (added <= 0) return
    setLiveCount(previous => previous + added)
    if (liveTimerRef.current !== undefined) window.clearTimeout(liveTimerRef.current)
    liveTimerRef.current = window.setTimeout(() => {
      liveTimerRef.current = undefined
      setLiveCount(0)
    }, LIVE_NOTICE_MS)
  }, [])

  // 卸载：清空 drip/live 定时器（队列本身随组件消亡，无需再清）。
  useEffect(() => () => {
    if (dripTimerRef.current !== undefined) window.clearTimeout(dripTimerRef.current)
    if (liveTimerRef.current !== undefined) window.clearTimeout(liveTimerRef.current)
  }, [])

  /** 一页响应落地：更新元数据 + 新记录入队（去重）。 */
  const applyListResult = useCallback((list: HistoryListResult): number => {
    const next = metaOf(list)
    metaRef.current = next
    setMeta(next)
    return enqueue(list.records)
  }, [enqueue])

  /** 首屏/刷新：清空队列后重拉首页（annotations 失败静默降级为空库）。 */
  const load = useCallback(async (): Promise<void> => {
    setInitialLoading(true)
    setLoadError(undefined)
    setActionError(undefined)
    queueRef.current = []
    if (dripTimerRef.current !== undefined) {
      window.clearTimeout(dripTimerRef.current)
      dripTimerRef.current = undefined
    }
    seenKeysRef.current = new Set()
    sessionKeysRef.current = new Set()
    setRecords([])
    setLiveCount(0)
    metaRef.current = HISTORY_META_EMPTY
    setMeta(HISTORY_META_EMPTY)
    try {
      const [list, notes] = await Promise.all([
        api.historyList(listPayload(props.sessionId)),
        api.historyAnnotationsGet().catch(() => emptyAnnotations()),
      ])
      setAnnotations(notes)
      applyListResult(list)
      refreshWatch()
    } catch (error) {
      // 降级为页签内联提示（任务要求的「服务缺席/读失败时不抛未捕获异常」）。
      setAnnotations(emptyAnnotations())
      setLoadError(error instanceof SidebarApiError ? `${error.code}: ${error.message}` : String(error))
    } finally {
      setInitialLoading(false)
    }
  }, [applyListResult, props.sessionId, refreshWatch])
  useEffect(() => { void load() }, [load])

  /** 翻页：透传 nextCursor 拉下一页，新记录走同一渐进队列；失败内联提示。 */
  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = metaRef.current.nextCursor
    if (loadingMore || metaRef.current.hasMore !== true || cursor === undefined || cursor === '') return
    setLoadingMore(true)
    setActionError(undefined)
    try {
      const list = await api.historyList(listPayload(props.sessionId, cursor))
      const added = applyListResult(list)
      refreshWatch()
      // 翻页是用户主动行为，不为它闪「实时新记录」提示。
      void added
    } catch (error) {
      setActionError(error instanceof SidebarApiError ? `${error.code}: ${error.message}` : String(error))
    } finally {
      setLoadingMore(false)
    }
  }, [applyListResult, loadingMore, props.sessionId, refreshWatch])

  const seeding = meta.seeding
  // seeding 轮询：每 ~1s 不带 cursor 重拉首页，合并新记录；seeding 翻 false
  // 停止。轮询失败静默（下一跳继续），绝不打断现有列表。
  useEffect(() => {
    if (seeding !== true) return undefined
    let cancelled = false
    const timer = window.setInterval(() => {
      void api.historyList(listPayload(props.sessionId))
        .then(list => {
          if (cancelled) return
          const added = applyListResult(list)
          refreshWatch()
          if (added > 0) flashLive(added)
        })
        .catch(() => { /* 轮询失败静默降级：现有列表仍可用 */ })
    }, SEED_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [applyListResult, flashLive, props.sessionId, refreshWatch, seeding])

  // ws 实时追加：watch 集变化才（重）连；帧过滤 = kind:'history' 且
  // sessionId 在当前 watch 集内；新记录去重后走同一渐进队列。
  useEffect(() => {
    if (watchSessions.length === 0) return undefined
    try {
      return connectSessionPush(watchSessions, frame => {
        try {
          if (frame.kind !== 'history') return
          if (!watchRef.current.includes(frame.sessionId)) return
          const incoming = historyRecordsOf(frame.records)
          const added = enqueue(incoming)
          refreshWatch()
          if (added > 0) flashLive(added)
        } catch { /* 一条脏帧/一次状态异常绝不冒泡 */ }
      }, () => { /* 开关状态对本页无动作：断连静默，重连自动恢复 */ })
    } catch {
      // ws 不可用（构造即抛等极端环境）：页签仍可用，只是没有实时追加。
      return undefined
    }
  }, [enqueue, flashLive, refreshWatch, watchSessions])

  const mutate = useCallback(async (op: HistoryAnnotationOpInput): Promise<boolean> => {
    setActionError(undefined)
    try {
      setAnnotations(await api.historyAnnotationsUpdate(op))
      return true
    } catch (error) {
      // 写失败内联展示（不静默：错误原文 + wire code 都在页面上）。
      setActionError(error instanceof SidebarApiError ? `${error.code}: ${error.message}` : String(error))
      return false
    }
  }, [])

  const toggleExpanded = useCallback((key: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const toggleSelected = useCallback((key: string): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const flat = records
  const filtered = useMemo(
    () => filterHistoryRecords(flat, {
      search,
      tag,
      tagSource: record => annotations.tags[record.key] ?? [],
    }),
    [annotations, flat, search, tag],
  )
  const sessionGroups = useMemo(() => groupRecordsBySession(filtered), [filtered])
  const allTags = useMemo(() => collectHistoryTags(annotations), [annotations])
  const recordIndex = useMemo(() => new Map(flat.map(record => [record.key, record])), [flat])
  const projectCwd = meta.projectCwd

  const createGroup = async (): Promise<void> => {
    const name = groupName.trim()
    if (name === '' || selected.size === 0) return
    if (await mutate({ op: 'groupCreate', name, keys: [...selected] })) {
      setGroupName('')
      setSelected(new Set())
      setMultiSelect(false)
    }
  }
  const mergeIntoGroup = async (): Promise<void> => {
    if (mergeTarget === '' || selected.size === 0) return
    if (await mutate({ op: 'groupAddMembers', id: mergeTarget, keys: [...selected] })) {
      setSelected(new Set())
      setMultiSelect(false)
    }
  }
  const submitRename = async (): Promise<void> => {
    const id = renamingId
    const name = renameDraft.trim()
    if (id === undefined || name === '') return
    if (await mutate({ op: 'groupRename', id, name })) {
      setRenamingId(undefined)
      setRenameDraft('')
    }
  }

  return (
    <div className={css.view} data-dsh-history-view="">
      <div className={css.toolbar}>
        <input
          className={css.search}
          value={search}
          placeholder={t('historySearchPlaceholder')}
          aria-label={t('historySearchPlaceholder')}
          onChange={event => { setSearch(event.target.value) }}
        />
        <select
          className={css.tagFilter}
          value={tag}
          aria-label={t('historyTagsLabel')}
          onChange={event => { setTag(event.target.value) }}
        >
          <option value="">{t('historyTagFilterAll')}</option>
          {allTags.map(item => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <button type="button" className={css.ghost} onClick={() => { void load() }}>
          {t('historyReload')}
        </button>
        <button
          type="button"
          className={`${css.ghost} ${multiSelect ? css.ghostOn : ''}`}
          onClick={() => {
            setMultiSelect(open => !open)
            setSelected(new Set())
          }}
        >
          {multiSelect ? t('historyMultiSelectExit') : t('historyMultiSelect')}
        </button>
      </div>
      <div className={css.note}>{t('historySearchScopeNote')}</div>

      {/* 首开的轻量细加载条：不阻塞布局，列表照常渲染（空态随后替换）。 */}
      {initialLoading && <div className={css.loadStrip} data-dsh-history-loading="" aria-hidden="true" />}
      {/* 实时状态：seeding 索引中 / 有新记录实时并入。 */}
      {seeding && <div className={css.liveStrip} data-dsh-history-seeding="">{t('historySeeding')}</div>}
      {liveCount > 0 && <div className={css.liveStrip} data-dsh-history-live="">{t('historyLiveNew', { count: liveCount })}</div>}

      {loadError !== undefined && (
        <div className={css.degraded} data-dsh-history-error="">
          <span>{t('historyUnavailable')}：{loadError}</span>
          <button type="button" className={css.ghost} onClick={() => { void load() }}>
            {t('historyRetry')}
          </button>
        </div>
      )}
      {meta.degraded && loadError === undefined && (
        <div className={css.note}>{t('historyDegradedNote')}</div>
      )}
      {actionError !== undefined && (
        <div className={css.actionError} data-dsh-history-action-error="">
          <span>{actionError}</span>
          <button type="button" className={css.ghost} onClick={() => { setActionError(undefined) }}>
            {t('dismiss')}
          </button>
        </div>
      )}

      {multiSelect && selected.size > 0 && (
        <div className={css.selectionBar} data-dsh-history-selection="">
          <span>{t('historySelectedCount', { count: selected.size })}</span>
          <input
            value={groupName}
            placeholder={t('historyGroupNamePlaceholder')}
            onChange={event => { setGroupName(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') void createGroup() }}
          />
          <button
            type="button"
            className={css.primary}
            disabled={groupName.trim() === ''}
            onClick={() => { void createGroup() }}
          >
            {t('historyGroupCreate')}
          </button>
          <select
            value={mergeTarget}
            aria-label={t('historyGroupMergeInto')}
            onChange={event => { setMergeTarget(event.target.value) }}
          >
            <option value="">{t('historyGroupMergeInto')}…</option>
            {annotations.groups.map(group => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
          <button
            type="button"
            className={css.ghost}
            disabled={mergeTarget === ''}
            onClick={() => { void mergeIntoGroup() }}
          >
            {t('historyGroupMergeInto')}
          </button>
        </div>
      )}

      <section className={css.groupsBlock} data-dsh-history-groups="">
        <h3 className={css.groupsTitle}>{t('historyGroupsTitle')}</h3>
        {annotations.groups.length === 0 && <div className={css.note}>{t('historyGroupsEmpty')}</div>}
        {annotations.groups.map(group => (
          <div key={group.id} className={css.groupRow} data-dsh-history-group={group.id}>
            {renamingId === group.id ? (
              <>
                <input
                  className={css.groupRename}
                  value={renameDraft}
                  onChange={event => { setRenameDraft(event.target.value) }}
                  onKeyDown={event => { if (event.key === 'Enter') void submitRename() }}
                />
                <button type="button" className={css.ghost} disabled={renameDraft.trim() === ''} onClick={() => { void submitRename() }}>
                  {t('historyGroupRenameSave')}
                </button>
              </>
            ) : (
              <span className={css.groupName}>{group.name}</span>
            )}
            <span className={css.note}>{t('historyGroupMembers', { count: group.members.length })}</span>
            {renamingId !== group.id && (
              <button
                type="button"
                className={css.ghost}
                onClick={() => {
                  setRenamingId(group.id)
                  setRenameDraft(group.name)
                }}
              >
                {t('historyGroupRename')}
              </button>
            )}
            <button
              type="button"
              className={css.ghost}
              onClick={() => {
                void mutate({ op: 'groupDelete', id: group.id }).then(ok => {
                  if (ok && mergeTarget === group.id) setMergeTarget('')
                })
              }}
            >
              {t('historyGroupDelete')}
            </button>
            <div className={css.groupMembers}>
              {group.members.map(key => {
                const record = recordIndex.get(key)
                return (
                  <span key={key} className={css.memberChip} title={key}>
                    <span className={css.memberChipText}>
                      {record === undefined ? shortSessionId(key) : shortTextOf(record.text)}
                    </span>
                    <button
                      type="button"
                      className={css.memberRemove}
                      aria-label={t('historyGroupMemberRemove')}
                      onClick={() => { void mutate({ op: 'groupRemoveMember', id: group.id, key }) }}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          </div>
        ))}
        {annotations.groups.length > 0 && <div className={css.note}>{t('historyRelatedNote')}</div>}
      </section>

      {!initialLoading && loadError === undefined && records.length === 0 && (
        <div className={css.empty} data-dsh-history-empty="">
          <span className={css.emptyTitle}>{t('historyEmpty')}</span>
          <span>{t('historyEmptyDesc')}</span>
        </div>
      )}

      {sessionGroups.map(group => (
        <SessionGroupSection
          key={group.sessionId}
          group={group}
          projectCwd={projectCwd}
          annotations={annotations}
          expanded={expanded}
          multiSelect={multiSelect}
          selected={selected}
          onToggleExpand={toggleExpanded}
          onToggleSelect={toggleSelected}
          onMutate={mutate}
        />
      ))}

      {/* 分页：hasMore 时显示「加载更多」，加载中禁用 + 文案。 */}
      {loadError === undefined && meta.hasMore === true && (
        <div className={css.loadMoreRow} data-dsh-history-load-more="">
          <button
            type="button"
            className={css.ghost}
            disabled={loadingMore}
            onClick={() => { void loadMore() }}
          >
            {loadingMore ? t('historyLoadingMore') : t('historyLoadMore')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 一个会话分组：组头（会话标识 + 最近时间 + 条数）+ 组内记录行（聊天正序）。 */
function SessionGroupSection(props: {
  group: HistorySessionGroup
  projectCwd: string | undefined
  annotations: HistoryAnnotations
  expanded: ReadonlySet<string>
  multiSelect: boolean
  selected: ReadonlySet<string>
  onToggleExpand: (key: string) => void
  onToggleSelect: (key: string) => void
  onMutate: (op: HistoryAnnotationOpInput) => Promise<boolean>
}) {
  const { group, projectCwd, annotations } = props
  const label = projectCwd !== undefined && projectCwd !== ''
    ? baseNameOf(projectCwd)
    : t('historySessionLabel', { id: shortSessionId(group.sessionId) })
  return (
    <section className={css.sessionGroup} data-dsh-history-session={group.sessionId}>
      <header className={css.sessionHead}>
        <span className={css.sessionId} title={projectCwd !== undefined && projectCwd !== '' ? group.sessionId : label}>{label}</span>
        <span className={css.time} title={formatStampFull(group.lastTime)}>
          {group.lastTime !== 0 ? formatStamp(group.lastTime) : ''}
        </span>
        <span className={css.sessionCount}>{t('historyGroupMembers', { count: group.count })}</span>
      </header>
      {group.records.map(record => {
        const note = annotationOfRecord(annotations, record)
        return (
          <RecordRow
            key={record.key}
            record={record}
            comments={note.comments}
            tags={[...note.tags]}
            groupNames={note.groupIds.map(id => annotations.groups.find(candidate => candidate.id === id)?.name ?? id)}
            expanded={props.expanded.has(record.key)}
            multiSelect={props.multiSelect}
            selected={props.selected.has(record.key)}
            onToggleExpand={props.onToggleExpand}
            onToggleSelect={props.onToggleSelect}
            onMutate={props.onMutate}
          />
        )
      })}
    </section>
  )
}
