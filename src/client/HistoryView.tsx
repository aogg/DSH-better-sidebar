/**
 * 「历史发送」页签（type: 'history'，单实例）：当前项目的聊天式提示词历史。
 *
 * 数据面（契约，v0.28.0+）：
 * - `history.list` 每次回一页当前项目的记录：新→旧的跨会话复合平铺序，
 *   `nextCursor` 翻页游标（「加载更多」透传）；`seeding` 标记宿主索引还在
 *   建设中；`degraded` 表示只降级到当前会话。本页对 history.list 只有三种
 *   一次性调用：首开拉首页、用户点「加载更多」、以及 ws 报告扫描收尾后的
 *   一次性补拉——没有任何定时轮询（v0.28.15 起轮询移除）；
 * - 实时通道只有 ws（`connectSessionPush`）：`kind:'history'` 帧推新记录
 *   （服务端种子扫描期每次 append 的新账也推，扫描期无需客户端补拉），
 *   `kind:'history-seed'` 帧推某项目扫描开始/结束（cwd 与 history.list 的
 *   `project.cwd` 同源）；老宿主不发 seed 帧，页签退化为「提示条常亮到手动
 *   刷新为止」，功能不受损；
 * - 记录 key 恒为 `${sessionId}:${seq}`，是评论/标签/关联组成员的稳定锚；
 * - 评论/标签/关联组来自 `history.annotationsGet`，写操作走
 *   `history.annotationsUpdate`（单个 op 归并，返回写后的全量注解库——本页
 *   不自造乐观状态）。
 *
 * 交互流（渐进显示，绝不阻塞式 loading）：
 * 1. 首开立即渲染空列表 + 顶部细加载条，随后异步拉首页；
 * 2. 每页到达后新记录进入发送队列，按 ~40ms 一条的微节奏逐条上屏；
 * 3. ws `kind:'history'` 帧的记录走同一队列实时逐条追加；合并按 key 双层
 *    幂等（入队侧 seen 剪枝 + 上屏侧 mergeHistoryRecords），同一条记录无论
 *    从首页/翻页/实时哪条路径到达几次，都只上屏一次；
 * 4. `kind:'history-seed'`（seeding:true）亮「索引建设中」提示条；
 *    （seeding:false）熄条并补拉一次首页——把 watch 建立前错过的会话记录
 *    补齐；用户已翻页时跳过补拉（翻页游标语义优先，绝不回卷）；
 * 5. 「加载更多」按 `hasMore`/`nextCursor` 拉下一页，追加走同一队列。游标
 *    是复合键（`${time}:${sessionId}:${seq}`），实时新账都落在游标之前
 *    （更新端），不破坏下一页语义。
 *
 * 顶部作用域 tab（v0.28.16+）：「当前会话」（默认激活，第一）只看本页签
 * 会话（props.sessionId）的发送记录，每页 50；「总发送历史」是现状的项目
 * 全量视图，每页 20。切 tab = 一次完整 reload（清空渐进队列/seen/meta 再
 * 重拉首页，两个 tab 共用同一套状态机，绝不串仓）；在途的上一 tab 响应落
 * 地时按 scope 快照核对丢弃。ws 实时追加两个 tab 都生效：session tab 只
 * 合并当前 sessionId 的帧记录，project tab 保持 watch 集逻辑；
 * seeding/history-seed 帧驱动的收尾补拉两个 tab 都保留。tab 选择不持久化。
 *
 * 记录跳转（v0.28.16+）：每条记录的 chips 区有「跳转」按钮——跨会话的记录
 * 先经 `ctx.get('uiWorkspace').openSession` 打开目标会话（本会话的记录主视
 * 图已开着，不重复切换），然后等待主视图渲染并滚动定位到那条发送、短暂高
 * 亮（详见 history-jump.ts 的机制与降级）；没滚到就把按钮 title 换成
 * 「已打开会话」。
 *
 * 展示：按会话（=一场对话）分组保留，组内时间正序（旧→新的聊天顺序），
 * 组间按最近一条消息新→旧；组头 = 会话标识 + 最近时间 + 条数；行文本默认
 * 3 行截断、点击展开全文可收起。搜索/标签过滤/多选建组/评论/标签/关联组
 * 全部保留，作用域 = 已加载记录（工具条下有说明行）。
 *
 * 降级路径（绝不抛未捕获异常）：`history.list` 失败（宿主 persistence 缺席
 * 的 503 `history-error`、网络失败等）→ 页签内联降级提示 + 重试按钮；翻页
 * 失败 → 工具条下的内联错误行（可关闭）；ws 断连静默（现有列表继续可用，
 * 重连后自动恢复追加）；注解写失败 → 同一内联错误行；空库 → 空态文案。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '../context-types.ts'
import { api, SidebarApiError, type HistoryListResult } from './api.ts'
import { connectSessionPush, type SessionPushFrame } from './session-push.ts'
import { formatStamp, formatStampFull, t } from './locales.ts'
import { collectHistoryTags, filterHistoryRecords, groupRecordsBySession, mergeHistoryRecords, type HistorySessionGroup } from '../prompt-history-groups.ts'
import { annotationOfRecord, emptyAnnotations, type HistoryAnnotationOpInput, type HistoryAnnotations, type HistoryComment } from '../prompt-history-store.ts'
import type { HistorySendRecord } from '../prompt-history-extract.ts'
import { jumpToHistoryRecord, type HistoryJumpOutcome, type HistoryLocateOptions } from './history-jump.ts'
import css from './HistoryView.module.css'

/** 逐条上屏的微节奏（一条接一条的间隔；太短看不出渐进，太长拖泥带水）。 */
const DRIP_INTERVAL_MS = 40
/** 实时新记录提示条的停留时长。 */
const LIVE_NOTICE_MS = 4000
/** ws watch 集上限（当前会话 + 已加载记录出现过的会话，去重后截断）。 */
const WATCH_SESSIONS_MAX = 64

/** 顶部作用域 tab：'session' = 当前会话（默认第一），'project' = 总发送历史。 */
export type HistoryScope = 'session' | 'project'

/** 各 tab 的每页条数（客户端显式传 limit；服务端默认值不动）。 */
const HISTORY_SCOPE_LIMITS: Record<HistoryScope, number> = { session: 50, project: 20 }

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

/** history.list 的请求负载（sessionId 取页签 scope；scope/limit 按 tab 定；
 *  cursor 仅翻页时带）。limit 显式传：当前会话 50 / 总发送历史 20。 */
function listPayload(
  sessionId: string | undefined,
  scope: HistoryScope,
  cursor?: string,
): { sessionId?: string; scope: HistoryScope; limit: number; cursor?: string } {
  return {
    ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    scope,
    limit: HISTORY_SCOPE_LIMITS[scope],
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

/** 一条发送记录行：时间、截断文本、评论/标签/组 chips、跳转与行内编辑器。 */
function RecordRow(props: {
  record: HistorySendRecord
  comments: readonly HistoryComment[]
  tags: readonly string[]
  groupNames: readonly string[]
  expanded: boolean
  multiSelect: boolean
  selected: boolean
  /** 该记录的跳转是否已降级成「只打开了会话」（换 title 说明）。 */
  jumpDegraded: boolean
  onToggleExpand: (key: string) => void
  onToggleSelect: (key: string) => void
  onJump: (record: HistorySendRecord) => void
  onMutate: (op: HistoryAnnotationOpInput) => Promise<boolean>
}) {
  const { record, comments, tags, groupNames, expanded, multiSelect, selected, jumpDegraded } = props
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
          {/* 跳转：打开记录所属会话并定位到这条发送（降级时 title 说明）。 */}
          <button
            type="button"
            className={`${css.chip} ${css.chipButton}`}
            data-dsh-history-jump={record.key}
            title={jumpDegraded ? t('historyJumpOpenedTitle') : t('historyJumpTitle')}
            aria-label={jumpDegraded ? t('historyJumpOpenedTitle') : t('historyJumpTitle')}
            onClick={() => { props.onJump(record) }}
          >
            {t('historyJump')}
          </button>
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
 * `ctx` 供记录跳转读宿主的 uiWorkspace 桥（缺席时跳转只剩同会话定位）。
 * `jumpLocateOptions` 只在测试里注入（定位超时/高亮时长）；生产走缺省。
 */
export function HistoryView(props: {
  visible?: boolean
  sessionId?: string
  ctx?: Context
  jumpLocateOptions?: HistoryLocateOptions
}): React.JSX.Element {
  void props.visible
  // 顶部作用域 tab（当前会话默认第一；选择不持久化）。
  const [scope, setScope] = useState<HistoryScope>('session')
  // 渐进上屏的记录（可见列表）与其元数据。
  const [records, setRecords] = useState<HistorySendRecord[]>([])
  const [meta, setMeta] = useState<HistoryMeta>(HISTORY_META_EMPTY)
  const [annotations, setAnnotations] = useState<HistoryAnnotations>(emptyAnnotations)
  const [initialLoading, setInitialLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  // 实时（ws）合并进来的新记录数（提示条展示几秒后自动清零）。
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
  // seeding 状态镜像（ws 回调读 ref，不依赖渲染快照）+ 已收尾项目的 cwd 集
  // （history-seed 结束帧先于 history.list 响应落地时，响应不得把 seeding
  // 标回去）。
  const seedingRef = useRef(false)
  const seedDoneRef = useRef<Set<string>>(new Set())
  // 用户是否已翻页（越过首页）：扫描收尾的一次性补拉只在未翻页时执行，
  // 翻页游标语义优先，绝不回卷。
  const pagedRef = useRef(false)
  // 扫描收尾补拉的在途闸（同一收尾只补拉一次）。
  const seedRefetchRef = useRef(false)
  // 当前 tab 的同步镜像（ws 回调/在途响应落地时读，不依赖渲染快照；切 tab
  // 先写镜像再 setState，落地判 scopes 变化丢弃串仓响应）。
  const scopeRef = useRef<HistoryScope>('session')

  const pumpRef = useRef<() => void>(() => {
    const next = queueRef.current.shift()
    if (next === undefined) {
      dripTimerRef.current = undefined
      return
    }
    // 上屏合并的幂等兜底：key 已在屏上的记录直接丢弃——入队侧 seen 剪枝
    // 失守（多路径/状态重置竞态）也绝不让同一条记录二次上屏。
    setRecords(previous => mergeHistoryRecords(previous, [next]))
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

  /**
   * 扫描收尾后的一次性补拉首页（非定时器）：把 watch 建立前错过的会话记录
   * 补齐。只合并新账，绝不回卷翻页游标（已翻页时直接跳过）；在途闸保证同
   * 一收尾只补拉一次。负载按发起时的 tab 快照构建，落地时 tab 已切走则丢弃
   * （两个 tab 各自的 records/游标绝不串仓）。
   */
  const refetchFirstPageOnce = useCallback((): void => {
    if (pagedRef.current || seedRefetchRef.current) return
    seedRefetchRef.current = true
    const payload = listPayload(props.sessionId, scopeRef.current)
    void (async (): Promise<void> => {
      try {
        const list = await api.historyList(payload)
        if (scopeRef.current !== payload.scope) return
        const added = enqueue(list.records)
        refreshWatch()
        if (added > 0) flashLive(added)
      } catch {
        // 补拉失败静默：已收到的记录仍可用，手动刷新兜底。
      } finally {
        seedRefetchRef.current = false
      }
    })()
  }, [enqueue, flashLive, props.sessionId, refreshWatch])

  /** 一页响应落地：更新元数据 + 新记录入队（去重）。seeding 以 ws 的收尾帧
   *  为准：结束帧先于本响应落地（响应生成晚于扫描收尾的竞态）时不再标回，
   *  并同样触发一次性补拉（响应快照可能落后于扫描收尾）。 */
  const applyListResult = useCallback((list: HistoryListResult): number => {
    const next = metaOf(list)
    if (next.seeding === true && next.projectCwd !== undefined && seedDoneRef.current.has(next.projectCwd)) {
      next.seeding = false
      refetchFirstPageOnce()
    }
    seedingRef.current = next.seeding
    metaRef.current = next
    setMeta(next)
    return enqueue(list.records)
  }, [enqueue, refetchFirstPageOnce])

  /** 首屏/刷新/tab 切换：清空队列后重拉首页（annotations 失败静默降级为空
   *  库）。请求 scope 取本次渲染的 state（切 tab 重建本回调 → 下面的 effect
   *  随之重拉）；响应落地（或失败）时 tab 已切走（scopeRef 镜像已变）则整体
   *  丢弃——上一 tab 的在途结果绝不写进新 tab 的状态。 */
  const load = useCallback(async (): Promise<void> => {
    const scopeAtStart = scope
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
    seedingRef.current = false
    pagedRef.current = false
    setMeta(HISTORY_META_EMPTY)
    try {
      const [list, notes] = await Promise.all([
        api.historyList(listPayload(props.sessionId, scopeAtStart)),
        api.historyAnnotationsGet().catch(() => emptyAnnotations()),
      ])
      if (scopeRef.current !== scopeAtStart) return
      setAnnotations(notes)
      applyListResult(list)
      refreshWatch()
    } catch (error) {
      if (scopeRef.current !== scopeAtStart) return
      // 降级为页签内联提示（任务要求的「服务缺席/读失败时不抛未捕获异常」）。
      setAnnotations(emptyAnnotations())
      setLoadError(error instanceof SidebarApiError ? `${error.code}: ${error.message}` : String(error))
    } finally {
      if (scopeRef.current === scopeAtStart) setInitialLoading(false)
    }
  }, [applyListResult, props.sessionId, refreshWatch, scope])
  useEffect(() => { void load() }, [load])

  /** 切顶部 tab：先写镜像（ws 回调/在途响应判仓用），再 setState——scope 进
   *  load 依赖，重建即触发一次完整 reload。状态机只有一套，切 tab 不保留上
   *  一 tab 的 records/游标，绝不串仓。 */
  const switchScope = useCallback((next: HistoryScope): void => {
    if (scopeRef.current === next) return
    scopeRef.current = next
    setScope(next)
  }, [])

  /** 翻页：透传 nextCursor 拉下一页，新记录走同一渐进队列；失败内联提示。
   *  成功即标记已翻页——扫描收尾的一次性补拉不再执行（游标语义优先）。
   *  响应落地时 tab 已切走则丢弃。 */
  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = metaRef.current.nextCursor
    if (loadingMore || metaRef.current.hasMore !== true || cursor === undefined || cursor === '') return
    const scopeAtStart = scopeRef.current
    setLoadingMore(true)
    setActionError(undefined)
    try {
      const list = await api.historyList(listPayload(props.sessionId, scopeAtStart, cursor))
      if (scopeRef.current !== scopeAtStart) return
      const added = applyListResult(list)
      refreshWatch()
      // 翻页是用户主动行为，不为它闪「实时新记录」提示。
      void added
      pagedRef.current = true
    } catch (error) {
      if (scopeRef.current !== scopeAtStart) return
      setActionError(error instanceof SidebarApiError ? `${error.code}: ${error.message}` : String(error))
    } finally {
      setLoadingMore(false)
    }
  }, [applyListResult, loadingMore, props.sessionId, refreshWatch])

  /**
   * ws `history-seed` 帧：某项目种子扫描开始/结束。cwd 与 `project.cwd`
   * 同源字符串，认领后才动作（别的项目的扫描与本页无关）。开始 → 亮提示条；
   * 结束 → 熄条 + 一次性补拉首页（见 refetchFirstPageOnce）。
   */
  const handleSeedFrame = useCallback((frame: SessionPushFrame): void => {
    const cwd = typeof frame.cwd === 'string' ? frame.cwd : ''
    if (cwd === '' || cwd !== metaRef.current.projectCwd) return
    if (frame.seeding === true) {
      seedDoneRef.current.delete(cwd)
      seedingRef.current = true
      setMeta(previous => ({ ...previous, seeding: true }))
      return
    }
    seedDoneRef.current.add(cwd)
    if (seedingRef.current !== true) return
    seedingRef.current = false
    setMeta(previous => ({ ...previous, seeding: false }))
    refetchFirstPageOnce()
  }, [refetchFirstPageOnce])

  // ws 实时追加：watch 集变化才（重）连；帧过滤 = kind:'history' 且
  // sessionId 在当前 watch 集内；新记录去重后走同一渐进队列。
  // kind:'history-seed' 帧驱动 seeding 提示条与收尾补拉（见 handleSeedFrame）。
  // 两个 tab 都吃实时帧，但按 tab 收窄：session tab 只合并当前页签会话的
  // 帧（别的会话的新账与本 tab 无关，绝不串仓）；project tab 保持 watch 集
  // 逻辑。帧处理读 scopeRef 镜像，切 tab 后旧 watch 连接的尾巴帧也不会进错
  // 仓（watch 集本身随 tab 重载重建）。
  useEffect(() => {
    if (watchSessions.length === 0) return undefined
    try {
      return connectSessionPush(watchSessions, frame => {
        try {
          if (frame.kind === 'history-seed') {
            handleSeedFrame(frame)
            return
          }
          if (frame.kind !== 'history') return
          if (scopeRef.current === 'session') {
            if ((frame.sessionId ?? '') !== (props.sessionId ?? '')) return
          } else if (!watchRef.current.includes(frame.sessionId ?? '')) {
            return
          }
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
  }, [enqueue, flashLive, handleSeedFrame, props.sessionId, refreshWatch, watchSessions])

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

  // 跳转降级簿：定位失败（只打开了会话没滚到）的记录 key → 按钮 title 换
  // 「已打开会话」说明。成功定位/不可用都不进簿。
  const [jumpDegraded, setJumpDegraded] = useState<ReadonlySet<string>>(new Set())
  const handleJump = useCallback((record: HistorySendRecord): void => {
    void jumpToHistoryRecord(props.ctx, record, props.sessionId, props.jumpLocateOptions).then((outcome: HistoryJumpOutcome) => {
      if (outcome !== 'opened') return
      setJumpDegraded(previous => {
        if (previous.has(record.key)) return previous
        const next = new Set(previous)
        next.add(record.key)
        return next
      })
    }).catch(() => { /* 跳转链路绝不冒泡（最坏就是没滚到） */ })
  }, [props.ctx, props.jumpLocateOptions, props.sessionId])

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
  // seeding 提示条：首页响应的 seeding + ws history-seed 帧共同驱动（帧翻转
  // 走 setMeta，这里只是读取）。
  const seeding = meta.seeding

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
    <div className={css.view} data-dsh-history-view="" data-dsh-history-active-scope={scope}>
      {/* 顶部作用域 tab：当前会话（默认第一）每页 50 / 总发送历史每页 20。
          切 tab = 一次完整 reload（见 switchScope），选择不持久化。 */}
      <div className={css.scopeTabs} role="tablist" aria-label={t('historySent')} data-dsh-history-scope-tabs="">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'session'}
          className={scope === 'session' ? `${css.scopeTab} ${css.scopeTabOn}` : css.scopeTab}
          onClick={() => { switchScope('session') }}
        >
          {t('historyScopeSession')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'project'}
          className={scope === 'project' ? `${css.scopeTab} ${css.scopeTabOn}` : css.scopeTab}
          onClick={() => { switchScope('project') }}
        >
          {t('historyScopeProject')}
        </button>
      </div>
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
          jumpDegraded={jumpDegraded}
          onToggleExpand={toggleExpanded}
          onToggleSelect={toggleSelected}
          onJump={handleJump}
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
  jumpDegraded: ReadonlySet<string>
  onToggleExpand: (key: string) => void
  onToggleSelect: (key: string) => void
  onJump: (record: HistorySendRecord) => void
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
            jumpDegraded={props.jumpDegraded.has(record.key)}
            onToggleExpand={props.onToggleExpand}
            onToggleSelect={props.onToggleSelect}
            onJump={props.onJump}
            onMutate={props.onMutate}
          />
        )
      })}
    </section>
  )
}
