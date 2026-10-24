/**
 * 「搜索」页（type: 'search'，多实例）：PhpStorm 式的 Find in Files——查询框
 * + 三开关（区分大小写 Aa / 全词 W / 正则 .*）+ include/exclude chips +
 * 「git 起点」输入框（提交 hash/ref 或日期：候选文件集限定为该基线到当前
 * 工作树之间 git 有差异的文件，内容仍搜工作树）+ 历史下拉；结果按文件分
 * 组，块 = 命中行高亮 + 上下各 2 行（全部带行号），块尾「查看」/ 双击 /
 * Enter 在编辑器打开该行（docs/plans/2026-10-21-find-in-files-page.md §4）。
 *
 * 状态分层（§4.8）：
 * - `tab.meta`（随布局持久化；updateTab 的 meta 是整体替换 → 读-改-写一次
 *   patch）：committed query、三开关、include/exclude chips、gitFrom
 *   （'' = 未启用）、runId（显式提交计数，Enter 每次自增——历史回填不增，
 *   是「回填 ≠ 运行」的实现抓手）。种子预填的 chips 由 createTab 铸进
 *   meta（search-seed.ts）。
 * - 组件态（不持久化）：结果、错误、运行中、折叠文件、选中块、草稿输入
 *   （查询词 + git 起点）、历史下拉。挂载时 committed query 非空自动重跑；
 *   chips / 开关 / git 起点 / explorerExclude 偏好变化在有 committed query
 *   时自动重跑（AbortController：下一次运行 / 卸载中止在途）；查询词草稿
 *   变化绝不自动跑。
 * - `visible === false`（tab 停靠后台）：不发起新搜索、不打断进行中的
 *   （重跑闸按 runKey 记账，reveal 回来只补跑「欠着的那一次」）。
 *
 * 结果打开：`openSidebarFile(ctx, sessionId, resolveSidebarPath(cwd, rel),
 * 行号)`——rel 为 root-relative（out-of-root 的 `..` 形态照旧展示/还原）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconClockOutlineRegular,
  IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, type ContentSearchResult, type SessionScope } from './api.ts'
import { builtinFileIcon } from './file-icons.tsx'
import { resolveSidebarPath } from './paths.ts'
import { openSidebarFile } from './sidebar-file.ts'
import { t } from './locales.ts'
import type { KeyboardEvent } from 'react'
import type { SidebarStore, SidebarTab } from './state.ts'
import type { BetterSidebarService } from './service.ts'
import { buildSearchBlocks, segmentsOfLine, type SearchBlock } from './search-blocks.ts'
import {
  historyKeyOf, readSearchHistory, removeSearchHistory, subscribeSearchHistory, upsertSearchHistory,
  type SearchHistoryEntry,
} from './search-history.ts'
import css from './SearchView.module.css'

/** 记录标题里查询词的 UTF-16 截断长度（超出加 …；tab strip 另有 CSS 截断）。 */
const TITLE_QUERY_MAX = 24

/** The tab's persisted meta object (a malformed meta reads as empty). */
function metaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** Merge a patch into the tab's persisted meta (rides the layout). Same
 *  read-modify-write shape as EditorHost's patchMeta — `updateTab`'s meta is
 *  a WHOLESALE replacement, so every write rebuilds from the current record. */
function patchMeta(ctx: Context, tab: SidebarTab, sessionId: string, patch: Record<string, unknown>): void {
  ctx.get('betterSidebar')?.updateTab(tab.id, { meta: { ...metaOf(tab), ...patch } }, sessionId)
}

/** The committed query ('' = nothing run yet). */
function queryOf(meta: Record<string, unknown>): string {
  return typeof meta.query === 'string' ? meta.query : ''
}

/** The persisted chip list (a restored layout may carry anything). */
function chipsOf(meta: Record<string, unknown>, field: string): string[] {
  const value = meta[field]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** One persisted toggle (default off = the v1 case-insensitive literal). */
function flagOf(meta: Record<string, unknown>, field: string): boolean {
  return meta[field] === true
}

/** The persisted「git 起点」（'' = 未启用；坏类型一律读作未启用）。 */
function gitFromOf(meta: Record<string, unknown>): string {
  return typeof meta.gitFrom === 'string' ? meta.gitFrom : ''
}

/** The explicit-submit counter (Enter bumps it; history backfill does not). */
function runIdOf(meta: Record<string, unknown>): number {
  return typeof meta.runId === 'number' && Number.isSafeInteger(meta.runId) ? meta.runId : 0
}

/** The ONE chip-append rule (the old panel's addChip, verbatim): trim, drop
 *  empties, silently ignore duplicates. */
function addChip(list: string[], value: string): string[] {
  const trimmed = value.trim()
  return trimmed === '' || list.includes(trimmed) ? list : [...list, trimmed]
}

/** 标题模板的查询词截断（≤24 个 UTF-16 字符，超出加 …）。 */
function titleQueryOf(query: string): string {
  return query.length > TITLE_QUERY_MAX ? `${query.slice(0, TITLE_QUERY_MAX)}…` : query
}

/** 一次请求的完整身份：会话/cwd + runId + 开关 + chips + 偏好排除 + git 起
 *  点（值的拼接，数组身份 churn 不影响比较——跑没跑过只看内容）。 */
function runKeyOf(
  sessionId: string,
  cwd: string | undefined,
  runId: number,
  matchKey: string,
  include: readonly string[],
  exclude: readonly string[],
  prefExcludeKey: string,
  gitFrom: string,
): string {
  return `${sessionId}\u0000${cwd ?? ''}\u0000${runId}\u0000${matchKey}\u0000` +
    `${include.join('\u0000')}\u0000${exclude.join('\u0000')}\u0000${prefExcludeKey}\u0000${gitFrom}`
}

/** 结果区一份文件的整体视图：host 分组 + 客户端合并块。 */
interface FileResultGroup {
  path: string
  count: number
  truncated: boolean
  blocks: SearchBlock[]
}

/** 结果区键盘导航的扁平块序（折叠文件的块不进序）。 */
interface FlatBlock {
  key: string
  path: string
  block: SearchBlock
}

/**
 * 「搜索」页本体。`visible` 是「页签激活 + 面板展开」信号：false 时不发起新
 * 搜索、不打断在途请求（见模块注释的状态分层）。
 */
export function SearchView(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  visible?: boolean
}) {
  const { ctx, store, scope, tab } = props
  const visible = props.visible !== false
  const sessionId = scope.sessionId
  const cwd = scope.cwd
  const service: BetterSidebarService | undefined = ctx.get('betterSidebar')

  const meta = metaOf(tab)
  const committed = queryOf(meta)
  const include = chipsOf(meta, 'include')
  const exclude = chipsOf(meta, 'exclude')
  const caseSensitive = flagOf(meta, 'caseSensitive')
  const wholeWord = flagOf(meta, 'wholeWord')
  const regexOn = flagOf(meta, 'regex')
  const gitFrom = gitFromOf(meta)

  // 组件态（不持久化）：草稿、结果、错误、运行中、折叠、选中块、历史下拉。
  const [draft, setDraft] = useState(committed)
  const [gitFromDraft, setGitFromDraft] = useState(gitFrom)
  const [results, setResults] = useState<ContentSearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState(-1)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [history, setHistory] = useState<readonly SearchHistoryEntry[]>(() => readSearchHistory())
  const [includeDraft, setIncludeDraft] = useState('')
  const [excludeDraft, setExcludeDraft] = useState('')

  const queryInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const blockRefs = useRef(new Map<string, HTMLDivElement>())
  const controllerRef = useRef<AbortController | null>(null)
  /** 已经发起过的 runKey（visible 折返、无关 re-render 都不重跑）。 */
  const startedKeyRef = useRef('')
  /** 历史回填钉住的 runKey：那一次 form 变化绝不自动跑（回填 ≠ 运行）。 */
  const skipKeyRef = useRef('')

  // explorerExclude 偏好（host 叠加在 exclude 之上，与文件树、文件名搜索同一
  // 份）：响应式读 store，值变化并入 runKey → 已有结果时自动重跑。
  const prefExclude = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.explorerExclude, [store]),
  )

  const matchKey = `${caseSensitive ? '1' : '0'}${wholeWord ? '1' : '0'}${regexOn ? '1' : '0'}`
  const prefExcludeKey = prefExclude.join('\u0000')
  const runKey = useMemo(
    () => runKeyOf(sessionId, cwd, runIdOf(meta), matchKey, include, exclude, prefExcludeKey, gitFrom),
    [sessionId, cwd, meta, matchKey, include, exclude, prefExcludeKey, gitFrom],
  )

  // 正则预校验（开启 .* 时）：new RegExp 抛错 → 输入框标红 + 行内提示，提交
  // 被本地拦下（不发请求；宿主 bad-request 只是兜底）。
  const regexProblem = useMemo(() => {
    if (!regexOn) return null
    try {
      new RegExp(draft)
      return null
    } catch (failure: unknown) {
      return failure instanceof Error ? failure.message : String(failure)
    }
  }, [regexOn, draft])

  // 草稿跟随 committed：Enter 提交（值相等，无感）、Esc 清空、历史回填时输入
  // 框落到回填词。打字只动草稿（committed 不变），永不互抢。
  useEffect(() => { setDraft(committed) }, [committed])
  // git 起点草稿同样跟随 committed（历史回填 / × 清除落盘后输入框归位）。
  useEffect(() => { setGitFromDraft(gitFrom) }, [gitFrom])

  // 历史的跨 tab / 跨会话同步：真实 storage 事件（他文档写入）+ 本模块写后
  // 派发的合成 storage 事件（同文档）都汇到这一个监听。
  useEffect(() => subscribeSearchHistory(() => { setHistory(readSearchHistory()) }), [])

  // 卸载：中止在途请求（运行中可被下一次运行/卸载 abort）。
  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // ── 运行闸（唯一的请求发起点）──────────────────────────────────────────
  useEffect(() => {
    const needle = committed.trim()
    if (needle === '') {
      // 空 query：不发请求、清结果（继承 v1「空查询不触引擎」）。
      controllerRef.current?.abort()
      setResults(null)
      setError(null)
      setRunning(false)
      startedKeyRef.current = ''
      return
    }
    // 历史回填钉住的那次 form 变化：不自动执行（钉住不清除——form 再变、
    // Enter（runId 自增）或 tab 折返都算新的身份，自然越过这道闸）。
    if (skipKeyRef.current === runKey) return
    // 停靠后台：不发起新搜索、不打断进行中的；欠下的运行在 reveal 时补上。
    if (!visible) return
    // 同一次请求身份只跑一次（visible 折返 / 无关 re-render 不重跑）。
    if (startedKeyRef.current === runKey) return
    startedKeyRef.current = runKey
    // 下一次运行 / chips 变化 / 清空都中止上一次（AbortController 契约）。
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setRunning(true)
    api.fsContentSearch(
      { sessionId, cwd },
      needle,
      include,
      exclude,
      prefExcludeKey === '' ? undefined : prefExcludeKey.split('\u0000'),
      { caseSensitive, wholeWord, regex: regexOn },
      // '' = 未启用：不发 wire 字段（宿主按未启用搜索）。
      gitFrom === '' ? undefined : gitFrom,
      controller.signal,
    ).then((found) => {
      if (controller.signal.aborted) return
      setResults(found)
      setError(null)
      setRunning(false)
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      setResults(null)
      setError(failure instanceof Error ? failure.message : String(failure))
      setRunning(false)
    })
    // chips/开关 ride 它们的 joined keys（内容稳定则身份稳定），偏好排除在
    // runKey 里——都是防 churn 的取值方式，不进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, runKey, visible])

  // 结果换了一代：键盘选中回零（旧索引指向的块可能已不存在）。
  useEffect(() => { setSelected(-1) }, [results])

  /** 结果分组 + 客户端合并块（host 顺序即文件排序：路径字典序）。 */
  const groups = useMemo<FileResultGroup[]>(() => {
    if (results === null) return []
    return results.matches.map(file => ({
      path: file.path,
      count: file.count,
      truncated: file.truncated,
      blocks: buildSearchBlocks(file.hits),
    }))
  }, [results])

  /** 键盘导航用的扁平块序（折叠文件的块不进序）。 */
  const flat = useMemo<FlatBlock[]>(() => {
    const out: FlatBlock[] = []
    for (const group of groups) {
      if (collapsed.has(group.path)) continue
      group.blocks.forEach((block, index) => {
        out.push({ key: `${group.path}#${index}`, path: group.path, block })
      })
    }
    return out
  }, [groups, collapsed])

  const totalMatches = useMemo(
    () => (results === null ? 0 : results.matches.reduce((sum, file) => sum + file.count, 0)),
    [results],
  )

  // 选中块滚动到可见（jsdom 没有 scrollIntoView —— 可选调用兜底）。
  useEffect(() => {
    if (selected < 0) return
    const row = flat[selected]
    if (row === undefined) return
    blockRefs.current.get(row.key)?.scrollIntoView?.({ block: 'nearest' })
  }, [selected, flat])

  /** 在编辑器打开一个命中（「查看」/ 双击 / 结果区 Enter 同一个出口）。 */
  const openLine = useCallback((rel: string, line: number): void => {
    if (cwd === undefined) return
    openSidebarFile(ctx, scope.sessionId, resolveSidebarPath(cwd, rel), line)
  }, [ctx, scope.sessionId, cwd])

  /** Enter 提交：写 meta（query + runId 自增，读-改-写一次 patch）、改记录
   *  标题、记历史；运行本身交给上面的运行闸（单一请求发起点）。git 起点
   *  记的是 committed 值（自己的输入框 Enter 另行提交）。 */
  const commitRun = (): void => {
    const next = draft.trim()
    if (next === '' || cwd === undefined) return
    if (regexOn && regexProblem !== null) return // 正则非法：本地拦截，不发请求
    const rid = runIdOf(meta) + 1
    service?.updateTab(tab.id, {
      title: t('searchTitleQuery', { query: titleQueryOf(next) }),
      meta: { ...meta, query: next, runId: rid },
    }, sessionId)
    setHistory(upsertSearchHistory({ query: next, include, exclude, gitFrom }))
    setHistoryOpen(false)
    setHistoryIndex(-1)
  }

  /** 清空（查询框 × / 无输入 Esc / 结果区 Esc）：清输入 + 清结果 + 收历史 +
   *  标题回「搜索」。结果的落清由运行闸的空 query 分支完成（含 abort）。 */
  const clearAll = (): void => {
    setDraft('')
    setHistoryOpen(false)
    setHistoryIndex(-1)
    setSelected(-1)
    if (committed !== '') {
      patchMeta(ctx, tab, sessionId, { query: '' })
      if (tab.title !== t('search')) service?.updateTab(tab.id, { title: t('search') }, sessionId)
    }
  }

  /** 历史回填：四项进表单、不自动执行——先把「回填后的 runKey」钉进跳过
   *  清单，再一次 patch 写入 query + 两列 chips + git 起点（runId 不动）。
   *  开关保持页面当前值（不在回填范围内）。旧条目无 gitFrom → ''（未启用）。 */
  const backfillHistory = (entry: SearchHistoryEntry): void => {
    const nextGitFrom = entry.gitFrom ?? ''
    skipKeyRef.current = runKeyOf(sessionId, cwd, runIdOf(meta), matchKey, entry.include, entry.exclude, prefExcludeKey, nextGitFrom)
    patchMeta(ctx, tab, sessionId, { query: entry.query, include: [...entry.include], exclude: [...entry.exclude], gitFrom: nextGitFrom })
    setHistoryOpen(false)
    setHistoryIndex(-1)
    setSelected(-1)
  }

  /** git 起点落盘（Enter 提交）：runKey 随内容变化，已有 committed query 时
   *  由运行闸自动重跑（与 chips 同一套模式）。 */
  const commitGitFrom = (): void => {
    const next = gitFromDraft.trim()
    setGitFromDraft(next)
    if (next !== gitFrom) patchMeta(ctx, tab, sessionId, { gitFrom: next })
  }

  /** git 起点 × 清除：清草稿；已落盘的 committed 值一并清（runKey 随变，
   *  自动重跑）。 */
  const clearGitFrom = (): void => {
    setGitFromDraft('')
    if (gitFrom !== '') patchMeta(ctx, tab, sessionId, { gitFrom: '' })
  }

  /** chips 落盘（增/删同一条路）：runKey 随内容变化，已有 committed query 时
   *  由运行闸自动重跑。 */
  const commitChips = (field: 'include' | 'exclude', next: string[]): void => {
    patchMeta(ctx, tab, sessionId, { [field]: next })
  }

  /** 三开关落盘：同 chips——变化即新 runKey，运行闸自动重跑。 */
  const toggleFlag = (field: 'caseSensitive' | 'wholeWord' | 'regex'): void => {
    patchMeta(ctx, tab, sessionId, { [field]: !flagOf(meta, field) })
  }

  /** 历史下拉里 ↑/↓ 的循环移动。 */
  const moveHistory = (delta: number): void => {
    if (history.length === 0) return
    setHistoryIndex(index => {
      const next = index + delta
      if (next < 0) return history.length - 1
      if (next >= history.length) return 0
      return next
    })
  }

  /** 查询框键盘：Enter 运行（下拉开 → 回填选中项）；Esc 分层（历史下拉 →
   *  草稿 → 结果）；↓ 焦点交给结果区 / 历史项。 */
  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      const picked = historyOpen && historyIndex >= 0 ? history[historyIndex] : undefined
      if (picked !== undefined) backfillHistory(picked)
      else commitRun()
      return
    }
    if (event.key === 'Escape') {
      if (historyOpen) {
        setHistoryOpen(false)
        setHistoryIndex(-1)
        return
      }
      if (draft !== '') {
        setDraft('')
        return
      }
      clearAll()
      return
    }
    if (event.key === 'ArrowDown') {
      if (historyOpen) {
        event.preventDefault()
        moveHistory(1)
        return
      }
      if (flat.length > 0) {
        event.preventDefault()
        setSelected(index => index < 0 || index >= flat.length ? 0 : index)
        bodyRef.current?.focus()
      }
    }
    if (event.key === 'ArrowUp' && historyOpen) {
      event.preventDefault()
      moveHistory(-1)
    }
  }

  /** 结果区键盘：↑/↓ 块间移动、Enter 打开选中块首命中行、Esc 清空并回焦点。 */
  const onBodyKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length === 0) return
      setSelected(index => {
        const base = index < 0 ? (event.key === 'ArrowDown' ? -1 : 0) : index
        const next = event.key === 'ArrowDown' ? base + 1 : base - 1
        return Math.min(flat.length - 1, Math.max(0, next))
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = flat[selected]
      if (row !== undefined) openLine(row.path, row.block.firstHitLine)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      clearAll()
      queryInputRef.current?.focus()
    }
  }

  /** 文件头折叠。 */
  const toggleCollapsed = (path: string): void => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const disabled = cwd === undefined

  return (
    <div className={css.view} data-dsh-search-view="true">
      <div className={css.toolbar}>
        <div className={css.queryRow}>
          <input
            ref={queryInputRef}
            className={clsx(css.queryInput, regexProblem !== null && css.queryInputBad)}
            value={draft}
            placeholder={t('searchQueryPlaceholder')}
            spellCheck={false}
            disabled={disabled}
            aria-label={t('search')}
            onChange={(event) => { setDraft(event.target.value) }}
            onKeyDown={onQueryKeyDown}
          />
          {draft !== '' && (
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('searchClear')}
              title={t('searchClear')}
              onClick={clearAll}
            >
              <IconCloseOutlineRegular size={14} />
            </button>
          )}
          <button
            type="button"
            className={clsx(css.mode, caseSensitive && css.modeOn)}
            aria-pressed={caseSensitive}
            aria-label={t('searchMatchCase')}
            title={t('searchMatchCase')}
            disabled={disabled}
            onClick={() => { toggleFlag('caseSensitive') }}
          >
            Aa
          </button>
          <button
            type="button"
            className={clsx(css.mode, wholeWord && css.modeOn)}
            aria-pressed={wholeWord}
            aria-label={t('searchWholeWord')}
            title={t('searchWholeWord')}
            disabled={disabled}
            onClick={() => { toggleFlag('wholeWord') }}
          >
            W
          </button>
          <button
            type="button"
            className={clsx(css.mode, regexOn && css.modeOn)}
            aria-pressed={regexOn}
            aria-label={t('searchRegexp')}
            title={t('searchRegexp')}
            disabled={disabled}
            onClick={() => { toggleFlag('regex') }}
          >
            .*
          </button>
          <div className={css.historyWrap}>
            <button
              type="button"
              className={clsx(css.iconButton, historyOpen && css.iconButtonOn)}
              aria-label={t('searchHistoryToggle')}
              title={t('searchHistoryToggle')}
              aria-expanded={historyOpen}
              disabled={disabled}
              onClick={() => {
                setHistoryIndex(-1)
                setHistoryOpen(open => {
                  if (!open) setHistory(readSearchHistory())
                  return !open
                })
              }}
            >
              <IconClockOutlineRegular size={14} />
            </button>
            {historyOpen && (
              <div className={css.historyPanel} data-dsh-search-history="true" role="listbox">
                {history.length === 0 && <div className={css.historyEmpty}>{t('searchHistoryEmpty')}</div>}
                {history.map((entry, index) => (
                  <div
                    key={`${entry.at}:${historyKeyOf(entry)}`}
                    className={clsx(css.historyItem, index === historyIndex && css.historyItemOn)}
                    role="option"
                    aria-selected={index === historyIndex}
                    onClick={() => { backfillHistory(entry) }}
                    onMouseEnter={() => { setHistoryIndex(index) }}
                  >
                    <span className={css.historyQuery} title={entry.query}>{entry.query}</span>
                    {entry.include.length > 0 && (
                      <span className={css.historyBadge}>{t('searchHistoryIncludeCount', { count: entry.include.length })}</span>
                    )}
                    {entry.exclude.length > 0 && (
                      <span className={css.historyBadge}>{t('searchHistoryExcludeCount', { count: entry.exclude.length })}</span>
                    )}
                    {(entry.gitFrom ?? '') !== '' && (
                      <span className={css.historyBadge} title={entry.gitFrom}>{t('searchHistoryGitFrom')}</span>
                    )}
                    <button
                      type="button"
                      className={css.historyDelete}
                      aria-label={t('searchHistoryDelete')}
                      title={t('searchHistoryDelete')}
                      onClick={(event) => {
                        event.stopPropagation()
                        setHistory(removeSearchHistory(entry))
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {regexProblem !== null && (
          <div className={css.hintBad}>{t('searchRegexInvalid', { message: regexProblem })}</div>
        )}
        <div className={css.chipGroup}>
          <input
            className={css.chipInput}
            value={includeDraft}
            placeholder={t('searchIncludePlaceholder')}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => { setIncludeDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                const next = addChip(include, includeDraft)
                setIncludeDraft('')
                if (next !== include) commitChips('include', next)
              }
            }}
          />
          {include.length > 0 && (
            <div className={css.chipRow}>
              {include.map(entry => (
                <span key={entry} className={css.chip}>
                  {entry}
                  <button
                    type="button"
                    className={css.chipRemove}
                    aria-label={t('searchChipRemove')}
                    title={t('searchChipRemove')}
                    onClick={() => { commitChips('include', include.filter(item => item !== entry)) }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={css.chipGroup}>
          <input
            className={css.chipInput}
            value={excludeDraft}
            placeholder={t('searchExcludePlaceholder')}
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => { setExcludeDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                const next = addChip(exclude, excludeDraft)
                setExcludeDraft('')
                if (next !== exclude) commitChips('exclude', next)
              }
            }}
          />
          {exclude.length > 0 && (
            <div className={css.chipRow}>
              {exclude.map(entry => (
                <span key={entry} className={css.chip}>
                  {entry}
                  <button
                    type="button"
                    className={css.chipRemove}
                    aria-label={t('searchChipRemove')}
                    title={t('searchChipRemove')}
                    onClick={() => { commitChips('exclude', exclude.filter(item => item !== entry)) }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={css.chipGroup}>
          <div className={css.gitRow}>
            <input
              className={css.chipInput}
              value={gitFromDraft}
              placeholder={t('searchGitFromPlaceholder')}
              spellCheck={false}
              disabled={disabled}
              aria-label={t('searchGitFromLabel')}
              title={t('searchGitFromLabel')}
              onChange={(event) => { setGitFromDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitGitFrom()
                }
              }}
            />
            {gitFromDraft !== '' && (
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('searchGitFromClear')}
                title={t('searchGitFromClear')}
                onClick={clearGitFrom}
              >
                <IconCloseOutlineRegular size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
      {cwd === undefined ? (
        <div className={css.empty}>{t('searchNoWorkspace')}</div>
      ) : (
        <div className={css.body} ref={bodyRef} tabIndex={0} data-dsh-search-results="true" onKeyDown={onBodyKeyDown}>
          {error !== null && <div className={css.errorLine}>{error}</div>}
          {error === null && running && results === null && <div className={css.statusLine}>{t('loading')}</div>}
          {error === null && !running && results !== null && results.matches.length === 0 && (
            <div className={css.statusLine}>{t('searchNoResults')}</div>
          )}
          {results !== null && results.matches.length > 0 && (
            <div className={css.summary}>
              {t('searchFilesCount', { count: results.matches.length })}
              {' · '}
              {t('searchMatchesCount', { count: totalMatches })}
              {running ? ` · ${t('loading')}` : ''}
            </div>
          )}
          {groups.map(group => (
            <div key={group.path} className={css.fileBlock} data-dsh-search-file={group.path}>
              <button
                type="button"
                className={css.fileHead}
                aria-expanded={!collapsed.has(group.path)}
                onClick={() => { toggleCollapsed(group.path) }}
              >
                {collapsed.has(group.path)
                  ? <IconChevronRightOutlineRegular size={14} className={css.fileCaret} />
                  : <IconChevronDownOutlineRegular size={14} className={css.fileCaret} />}
                <span className={css.fileIcon} aria-hidden="true">{builtinFileIcon(group.path, 14)}</span>
                <span className={css.filePath} title={group.path}>{group.path}</span>
                <span className={css.fileCount}>{t('searchMatchesCount', { count: group.count })}</span>
                {group.truncated && <span className={css.fileTruncated}>{t('searchFileTruncated')}</span>}
              </button>
              {!collapsed.has(group.path) && group.blocks.map((block, index) => {
                const key = `${group.path}#${index}`
                return (
                  <div
                    key={key}
                    className={clsx(css.block, flat[selected]?.key === key && css.blockSelected)}
                    data-dsh-search-block={key}
                    ref={node => {
                      if (node === null) blockRefs.current.delete(key)
                      else blockRefs.current.set(key, node)
                    }}
                  >
                    {block.lines.map(line => {
                      const isHit = line.hits.length > 0
                      return (
                        <div
                          key={line.line}
                          className={clsx(css.line, isHit ? css.lineHit : css.lineCtx)}
                          data-dsh-search-line={line.line}
                          onDoubleClick={isHit ? () => { openLine(group.path, line.line) } : undefined}
                        >
                          <span className={css.lineNo}>{line.line}</span>
                          <span className={css.lineText}>
                            {segmentsOfLine(line.text, line.hits).map((segment, segIndex) =>
                              segment.hit
                                ? <mark key={segIndex} className={css.mark}>{segment.text}</mark>
                                : <span key={segIndex}>{segment.text}</span>,
                            )}
                          </span>
                          {line.line === block.firstHitLine && (
                            <button
                              type="button"
                              className={css.viewButton}
                              title={t('searchOpenHint')}
                              onClick={() => { openLine(group.path, block.firstHitLine) }}
                            >
                              {t('searchView')}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          ))}
          {results?.truncated === true && (
            <div className={css.statusLine}>{t('searchTruncated')}</div>
          )}
        </div>
      )}
    </div>
  )
}
