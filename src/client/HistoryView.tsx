/**
 * 「历史发送」页签（type: 'history'，单实例）：开始页胶囊
 * service.openTab({ type: 'history' }) 打开的插件页，展示历史上用户发送过的
 * 提示词。
 *
 * 数据面（契约）：
 * - 记录来自 `history.list`（宿主每次从会话日志现读，本页不缓存原始日志）；
 *   单会话有服务端条数上限，`truncated` 组头内联说明；`sessionId` 取页签的
 *   scope——宿主没有会话枚举能力时，路由按它降级为只读当前会话；
 * - 评论/标签/关联组来自 `history.annotationsGet`，所有写操作走
 *   `history.annotationsUpdate`（单个 op 归并，服务端原子落盘，返回写后的
 *   全量注解库——本页不自造乐观状态）；
 * - 记录 key 恒为 `${sessionId}:${seq}`，是评论/标签/关联组成员的稳定锚。
 *
 * 交互：顶部文本搜索（大小写不敏感子串）+ 标签过滤 chips；记录默认按所属
 * 会话分组（组头 = 会话标识 + 最近时间 + 条数）；行内文本默认 3 行截断、
 * 点击展开全文；评论增/删（带时间）、标签增/删；「多选」勾选多条记录后可
 * 新建命名关联组或并入已有组；关联组在独立区块重命名/删除/移除成员——组内
 * 记录仍保留在原会话分组里（关联组只是注解库里的成员表，不改变分组）。
 *
 * 降级路径（绝不抛未捕获异常）：`history.list` 失败（宿主 persistence 缺席
 * 的 503 `history-error`、网络失败等）→ 页签内联降级提示 + 重试按钮；注解
 * 写失败 → 工具条下的内联错误行（可关闭）；宿主没有会话枚举能力 →
 * `degraded` 标记的「仅当前会话」提示；空库/无记录 → 空态文案。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, SidebarApiError, type HistoryListResult } from './api.ts'
import { formatStamp, formatStampFull, t } from './locales.ts'
import { collectHistoryTags, filterHistoryRecords, groupRecordsBySession, type HistorySessionGroup } from '../prompt-history-groups.ts'
import { annotationOfRecord, emptyAnnotations, type HistoryAnnotationOpInput, type HistoryAnnotations, type HistoryComment } from '../prompt-history-store.ts'
import type { HistorySendRecord } from '../prompt-history-extract.ts'
import css from './HistoryView.module.css'

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
 * 可见性懒加载；首屏在挂载时拉一次，刷新按钮手动重拉）。
 */
export function HistoryView(props: { visible?: boolean; sessionId?: string }): React.JSX.Element {
  void props.visible
  const [listResult, setListResult] = useState<HistoryListResult | undefined>(undefined)
  const [annotations, setAnnotations] = useState<HistoryAnnotations>(emptyAnnotations)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [groupName, setGroupName] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [renameDraft, setRenameDraft] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(undefined)
    try {
      const [list, notes] = await Promise.all([
        api.historyList(props.sessionId !== undefined && props.sessionId !== '' ? { sessionId: props.sessionId } : {}),
        api.historyAnnotationsGet(),
      ])
      setListResult(list)
      setAnnotations(notes)
    } catch (error) {
      // 降级为页签内联提示（任务要求的「服务缺席/读失败时不抛未捕获异常」）。
      setListResult(undefined)
      setAnnotations(emptyAnnotations())
      setLoadError(error instanceof SidebarApiError ? `${error.code}: ${error.message}` : String(error))
    } finally {
      setLoading(false)
    }
  }, [props.sessionId])
  useEffect(() => { void load() }, [load])

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

  const flat = useMemo(() => listResult?.sessions.flatMap(session => session.records) ?? [], [listResult])
  const filtered = useMemo(
    () => filterHistoryRecords(flat, {
      search,
      tag,
      tagSource: record => annotations.tags[record.key] ?? [],
    }),
    [flat, search, tag, annotations],
  )
  const sessionGroups = useMemo(() => groupRecordsBySession(filtered), [filtered])
  const allTags = useMemo(() => collectHistoryTags(annotations), [annotations])
  const recordIndex = useMemo(() => new Map(flat.map(record => [record.key, record])), [flat])
  const cwdOf = useMemo(
    () => new Map((listResult?.sessions ?? []).map(session => [session.id, session.cwd])),
    [listResult],
  )

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

      {loadError !== undefined && (
        <div className={css.degraded} data-dsh-history-error="">
          <span>{t('historyUnavailable')}：{loadError}</span>
          <button type="button" className={css.ghost} onClick={() => { void load() }}>
            {t('historyRetry')}
          </button>
        </div>
      )}
      {listResult?.degraded === true && loadError === undefined && (
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

      {loading && <div className={css.note}>{t('loading')}</div>}
      {!loading && loadError === undefined && sessionGroups.length === 0 && (
        <div className={css.empty} data-dsh-history-empty="">
          <span className={css.emptyTitle}>{t('historyEmpty')}</span>
          <span>{t('historyEmptyDesc')}</span>
        </div>
      )}

      {sessionGroups.map(group => (
        <SessionGroupSection
          key={group.sessionId}
          group={group}
          truncated={listResult?.sessions.find(session => session.id === group.sessionId)?.truncated === true}
          cwd={cwdOf.get(group.sessionId)}
          annotations={annotations}
          expanded={expanded}
          multiSelect={multiSelect}
          selected={selected}
          onToggleExpand={toggleExpanded}
          onToggleSelect={toggleSelected}
          onMutate={mutate}
        />
      ))}
    </div>
  )
}

/** 一个会话分组：组头（会话标识 + 最近时间 + 条数）+ 组内记录行。 */
function SessionGroupSection(props: {
  group: HistorySessionGroup
  truncated: boolean
  cwd: string | undefined
  annotations: HistoryAnnotations
  expanded: ReadonlySet<string>
  multiSelect: boolean
  selected: ReadonlySet<string>
  onToggleExpand: (key: string) => void
  onToggleSelect: (key: string) => void
  onMutate: (op: HistoryAnnotationOpInput) => Promise<boolean>
}) {
  const { group, truncated, cwd, annotations } = props
  const label = cwd !== undefined && cwd !== '' ? baseNameOf(cwd) : t('historySessionLabel', { id: shortSessionId(group.sessionId) })
  return (
    <section className={css.sessionGroup} data-dsh-history-session={group.sessionId}>
      <header className={css.sessionHead}>
        <span className={css.sessionId} title={group.sessionId}>{label}</span>
        <span className={css.time} title={formatStampFull(group.lastTime)}>
          {group.lastTime !== 0 ? formatStamp(group.lastTime) : ''}
        </span>
        <span className={css.sessionCount}>{t('historyGroupMembers', { count: group.count })}</span>
        {truncated && <span className={css.note}>{t('historySessionTruncated', { limit: group.count })}</span>}
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
