/**
 * 「命令」页的「执行历史」tab（CommandsPageView 的第二个 tab）：本会话
 * （当前 sessionId 的会话日志）里执行过的命令类工具调用（bash/pwsh/
 * exec_command/write_stdin 与 terminal_* 前缀，识别在服务端的
 * command-history-extract.ts）做成的列表。
 *
 * 数据面（WS 驱动，绝无 setInterval 轮询）：
 * - 挂载时拉一次 `commands.execHistory`；之后订阅 useSessionOps 的共享
 *   `ops` 帧（当前 sessionId），每帧只触发一次重拉（in-flight 期间到达的
 *   帧合并为一次尾随重拉），socket 断线重连后的 onReconnect 同样接上——
 *   与 changes tab 的 session lens 同一套 invalidation 形制。
 * - 服务失败静默降级：保留旧列表，从未加载成功时给一条行内提示。
 *
 * 交互：关键字本地筛选（command+description 不区分大小写子串）；行点击
 * 展开/收起详情（完整命令可复制、workdir、env——仅当调用参数带 env 才有，
 * 宿主日志不逐条记录 env 时明确提示）；「▶ 再次运行」走 CommandsPageView
 * 同一套 mint 语义（parkCmdRun 紧贴 openTab 的 cmd-run 执行 tab），无命令
 * 文本或终端能力缺席的行禁用。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CMD_RUN_TAB_TYPE } from '../commands-config.ts'
import type { ExecCommandRow } from '../command-history-extract.ts'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import { api } from './api.ts'
import type { SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { formatDurationMs } from './sidechat-transcript.ts'
import { useSessionOps } from './ops-push.ts'
import { webTerminals } from './terminal-client.ts'
import { buildCommandCommandline, parkCmdRun } from './commands-open.ts'
import css from './commands.module.css'

/** openTab 服务里本页真正用到的最小面（与 CommandsPageView 同款，fake 友好）。 */
interface HistoryOpenService {
  isTabEnabled(id: string): boolean
  openTab(seed: { type: string; title?: string }): void
}

/** 探测 ctx 上的服务（minimal mock / 服务缺席 → undefined，运行动作静默跳过）。 */
function serviceOf(ctx: Context): HistoryOpenService | undefined {
  try {
    const service = ctx.get('betterSidebar') as HistoryOpenService | undefined
    return typeof service?.openTab === 'function' && typeof service?.isTabEnabled === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/** 目录的展示路径：cwd 之下显示相对（短），否则原样（CommandsPageView 同款）。 */
function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[\\/]+$/, '')
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized === base) return '.'
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : path
}

/** 行时间 HH:mm:ss（本地时区；缺时间显示占位）。 */
function timeText(time: number): string {
  if (!(time > 0)) return '--:--:--'
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 命令预览的首行（列表行的单行截断由 CSS 负责）。 */
function firstLineOf(command: string): string {
  for (const line of command.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 再次运行的 tab 标题：描述优先，退命令首行（超长截断）。 */
function titleOf(row: ExecCommandRow): string {
  const source = row.description !== undefined && row.description !== '' ? row.description : firstLineOf(row.command)
  return source.length > 60 ? `${source.slice(0, 59)}…` : source
}

/** 状态徽标的文案与色类（running=运行中 / ok=✓ / fail=exit N）。css 类映射
 *  在 noUncheckedIndexedAccess 下是 string | undefined（与全仓 css.x 用法一致，
 *  运行时类名恒存在）。 */
function statusViewOf(row: ExecCommandRow): { text: string; className: string | undefined; title?: string } {
  if (row.status === 'running') return { text: t('commandsHistoryStatusRunning'), className: css.historyStatusRunning }
  if (row.status === 'fail') {
    return {
      text: `exit ${row.exitCode ?? '?'}`,
      className: css.historyStatusFail,
      title: t('commandsHistoryStatusFail', { code: row.exitCode ?? '?' }),
    }
  }
  return { text: '✓', className: css.historyStatusOk, title: t('commandsHistoryStatusOk') }
}

/** WS 驱动的失效重拉：当前会话的 `ops` 帧——或共享 socket 断线重连——各
 *  触发一次重拉；没有计时器驱动任何请求（../ops-push.ts）。 */
function useSessionOpsBridge(sessionId: string, pull: () => Promise<void>): void {
  useSessionOps({
    sessionIds: [sessionId],
    onInvalidate: () => { void pull() },
    onReconnect: () => { void pull() },
  })
}

export function CommandHistoryView(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
}): ReactNode {
  const { ctx, scope } = props
  const sessionId = scope.sessionId
  const cwd = scope.cwd

  // ── 数据面：挂载首拉 + ops 帧驱动的重拉 ─────────────────────────────
  const [rows, setRows] = useState<ExecCommandRow[] | undefined>(undefined)
  const [truncated, setTruncated] = useState(false)
  const [failed, setFailed] = useState(false)
  const genRef = useRef(0)
  const pullingRef = useRef(false)
  const pendingRef = useRef(false)

  const pull = useCallback(async (): Promise<void> => {
    if (pullingRef.current) {
      // in-flight 期间到达的通知合并为一次尾随重拉（拉到的是旧答案时补一次）。
      pendingRef.current = true
      return
    }
    pullingRef.current = true
    const generation = genRef.current
    try {
      const view = await api.commandsExecHistory(sessionId)
      if (generation !== genRef.current) return
      setRows(view.rows)
      setTruncated(view.truncated === true)
      setFailed(false)
    } catch {
      // 静默降级：保留旧列表；从未加载成功时由 failed 提示行说明。
      if (generation === genRef.current) setFailed(true)
    } finally {
      pullingRef.current = false
      if (pendingRef.current) {
        pendingRef.current = false
        if (generation === genRef.current) void pull()
      }
    }
  }, [sessionId])

  // 会话切换：旧会话的 in-flight 答案作废（generation 守卫），重新加载。
  // 必须先于首拉 effect 声明——切换时先作废再重拉。
  useEffect(() => {
    genRef.current += 1
    setRows(undefined)
    setTruncated(false)
    setFailed(false)
  }, [sessionId])

  // 挂载首拉（pull 的身份随 sessionId 变化，切换会话时这里自然重拉）。
  useEffect(() => { void pull() }, [pull])

  useSessionOpsBridge(sessionId, pull)

  // ── 交互态 ─────────────────────────────────────────────────────────
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string | undefined>(undefined)

  const canRun = useMemo(() => {
    if (webTerminals(ctx) === undefined) return false
    return serviceOf(ctx)?.isTabEnabled(CMD_RUN_TAB_TYPE) === true
  }, [ctx])

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '' || rows === undefined) return rows ?? []
    return rows.filter(row =>
      row.command.toLowerCase().includes(needle)
      || (row.description !== undefined && row.description.toLowerCase().includes(needle)),
    )
  }, [rows, filter])

  /** 再次运行：与列表页的 mint 同一语义（park 紧贴 openTab；被拒的 open 不留残留）。 */
  const rerun = useCallback((row: ExecCommandRow): void => {
    if (row.command === '' || !canRun) return
    const service = serviceOf(ctx)
    if (service === undefined || !service.isTabEnabled(CMD_RUN_TAB_TYPE)) return
    const title = titleOf(row)
    parkCmdRun({
      title,
      commandline: buildCommandCommandline(row.command, cwd, row.workdir),
      sourceKey: `history:${row.callId}`,
    })
    service.openTab({ type: CMD_RUN_TAB_TYPE, title })
  }, [ctx, cwd, canRun])

  const copyText = useCallback((text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }, [])

  const rowKey = (row: ExecCommandRow): string => `${row.seq}:${row.callId}`

  /* ── 渲染 ────────────────────────────────────────────────────────── */

  return (
    <div className={css.historyRoot} data-dsh-commands-history="">
      <div className={css.historyToolbar}>
        <input
          type="text"
          className={`${css.input} ${css.historySearch}`}
          value={filter}
          placeholder={t('commandsHistorySearchPlaceholder')}
          spellCheck={false}
          data-dsh-history-filter=""
          onChange={(event) => { setFilter(event.target.value) }}
        />
        <span className={css.badge} data-dsh-history-count="">{t('commandsHistoryCount', { count: filtered.length })}</span>
        <button
          type="button"
          className={css.ghostButton}
          disabled={rows === undefined}
          title={t('commandsHistoryRefresh')}
          onClick={() => { void pull() }}
        >
          {t('commandsHistoryRefresh')}
        </button>
      </div>

      {rows === undefined && !failed && <div className={css.hint}>{t('loading')}</div>}
      {failed && (
        <div className={`${css.hint} ${css.hintInvalid}`} role="alert">{t('commandsHistoryLoadFailed')}</div>
      )}
      {rows !== undefined && !failed && rows.length === 0 && <div className={css.empty}>{t('commandsHistoryEmpty')}</div>}
      {rows !== undefined && rows.length > 0 && filtered.length === 0 && (
        <div className={css.hint}>{t('searchNoResults')}</div>
      )}
      {truncated && <div className={css.hint}>{t('commandsHistoryTruncated', { count: rows?.length ?? 0 })}</div>}

      <div className={css.historyList}>
        {filtered.map(row => {
          const key = rowKey(row)
          const open = expanded === key
          const status = statusViewOf(row)
          const described = row.description !== undefined && row.description !== ''
          const preview = described ? row.description! : firstLineOf(row.command)
          return (
            <div key={key} className={css.historyItem} data-dsh-history-item={row.callId}>
              <div className={css.historyRow}>
                <button
                  type="button"
                  className={css.historyRowMain}
                  aria-expanded={open}
                  data-dsh-history-row=""
                  onClick={() => { setExpanded(current => (current === key ? undefined : key)) }}
                >
                  <span className={css.historyRowText}>
                    <span className={css.historyNameLine}>
                      <span className={`${css.badge} ${status.className}`} title={status.title}>{status.text}</span>
                      <span className={css.badge}>{row.tool}</span>
                      {row.background && <span className={css.badge}>run_in_background</span>}
                      <span className={css.historyMeta}>
                        <span>{timeText(row.time)}</span>
                        {row.workdir !== undefined && (
                          <span className={css.historyPath} title={row.workdir}>{displayPath(row.workdir, cwd)}</span>
                        )}
                        {row.durationMs !== undefined && <span>{formatDurationMs(row.durationMs)}</span>}
                      </span>
                    </span>
                    {preview !== ''
                      ? <span className={described ? css.historyDesc : css.historyCmd}>{preview}</span>
                      : <span className={css.historyCmd}>{t('commandsHistoryNoCommand')}</span>}
                    {row.commandTruncated === true && <span className={css.hint}>{t('commandsHistoryCommandTruncated')}</span>}
                  </span>
                </button>
                {row.command !== '' && (
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('commandsHistoryRerun')}
                    title={canRun ? t('commandsHistoryRerun') : t('commandsRunUnavailable')}
                    disabled={!canRun}
                    data-dsh-history-rerun=""
                    onClick={() => { rerun(row) }}
                  >
                    ▶
                  </button>
                )}
              </div>
              {open && (
                <div className={css.historyDetail} data-dsh-history-detail="">
                  <div className={css.historyDetailHead}>
                    <span className={css.fieldLabel}>{t('commandsFieldCommand')}</span>
                    {row.command !== '' && (
                      <button
                        type="button"
                        className={css.historyCopy}
                        aria-label={t('copy')}
                        title={t('copy')}
                        onClick={() => { copyText(row.command) }}
                      >
                        ⧉
                      </button>
                    )}
                  </div>
                  <pre className={css.historyPre}>{row.command !== '' ? row.command : t('commandsHistoryNoCommand')}</pre>
                  <div className={css.historyDetailHead}>
                    <span className={css.fieldLabel}>{t('commandsFieldRunDir')}</span>
                  </div>
                  <div className={css.historyMeta}>
                    <span className={css.historyPath} title={row.workdir ?? ''}>
                      {row.workdir !== undefined ? displayPath(row.workdir, cwd) : '—'}
                    </span>
                  </div>
                  <div className={css.historyDetailHead}>
                    <span className={css.fieldLabel}>{t('commandsHistoryEnvLabel')}</span>
                    {row.envTruncated === true && <span className={css.hint}>{t('commandsHistoryEnvTruncated')}</span>}
                  </div>
                  {row.env === undefined ? (
                    <div className={css.hint}>{t('commandsHistoryEnvUnrecorded')}</div>
                  ) : (
                    <div className={css.historyEnvRow}>
                      {row.env.map(item => (
                        <span key={item.key} className={css.varChipReadOnly} title={`${item.key}=${item.value}`}>
                          {item.key}={item.value}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className={css.historyDetailHead}>
                    <span className={css.fieldLabel}>{t('commandsHistoryResultLabel')}</span>
                    {row.resultTruncated === true && <span className={css.hint}>{t('commandsHistoryResultTruncated')}</span>}
                  </div>
                  {row.status === 'running' ? (
                    <div className={css.hint}>{t('commandsHistoryStatusRunning')}</div>
                  ) : (
                    <pre className={css.historyPre}>{row.resultText !== '' ? row.resultText : t('commandsHistoryNoOutput')}</pre>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {rows !== undefined && rows.length > 0 && !canRun && <div className={css.hint}>{t('commandsRunUnavailable')}</div>}
    </div>
  )
}
