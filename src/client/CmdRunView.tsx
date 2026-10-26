/**
 * 「命令」执行 tab 的正文（type: 'cmd-run'，hidden createTab 每次铸新 tab）。
 *
 * 本模块是 LAZY CHUNK 的载荷（挂在 terminal chunk，src/client/chunks/terminal.tsx
 * 一并导出）：xterm 数百 KB，绝不能从 core bundle 触达。宿主终端接线与
 * TerminalBottomView（TerminalView.tsx）同一套 frame 协议：
 *
 * - `view(sessionId, key, contentId)` 的 contentId = `dsh-better-sidebar:cmd-run:
 *   <instance>#<run>`（commands-open.ts）；「重新运行」先 close 旧 contentId，
 *   再 bump meta 的世代（nextCmdRunMeta）——新 identity 铸新进程。
 * - 命令行注入是「写一次即弃」：首次 writable 时 write(commandline + '\r')，
 *   然后把 meta 的 `cmdRunInjected` 置 true（持久——reload 重挂到同一进程的
 *   已运行终端不重发命令行）；「重新运行」重置该标记。
 * - 静态交互点 chips（.sh 源随 seed 带来）+ 状态徽标（HostTerminalInfo.state）
 *   + 底部快捷输入行（发送 / y / n）。运行中且 ≥1.5s 无新输出且屏幕尾部命中
 *   detectWaitInput 时亮「等待输入」徽标并 focus 输入框；有新输出即清除。
 *
 * 关 tab 即关进程：descriptor 的 onClose 走 closeCmdRunTerminal（本模块导出），
 * 与 terminal-bottom 的 closeBottomTerminal 同一形态。
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import type { SidebarTab } from './state.ts'
import { t } from './locales.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import {
  CMD_RUN_INJECTED_FIELD,
  CMD_RUN_TITLE_FIELD,
  cmdRunCommandlineOf,
  cmdRunContentId,
  cmdRunInjectedOf,
  cmdRunInstanceOf,
  cmdRunInteractionOf,
  cmdRunRunOf,
  nextCmdRunMeta,
} from './commands-open.ts'
import { detectWaitInput } from '../command-interaction.ts'
import { webTerminals, type HostTerminalEnvironment, type HostTerminalView, type HostTerminalViewState } from './terminal-client.ts'
import terminalCss from './terminal.module.css'
import css from './commands.module.css'

/** The props the cmd-run view consumes from its tab descriptor. */
export interface CmdRunProps {
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}

export function CmdRunView({ ctx, scope, tab, visible }: CmdRunProps): ReactNode {
  const sessionId = scope.sessionId
  const service = useMemo(() => webTerminals(ctx), [ctx])
  const instance = cmdRunInstanceOf(tab)
  const run = cmdRunRunOf(tab)
  const contentId = cmdRunContentId(instance, run)
  const commandline = cmdRunCommandlineOf(tab) ?? ''
  const title = typeof (tab.meta as Record<string, unknown> | null)?.[CMD_RUN_TITLE_FIELD] === 'string'
    ? (tab.meta as Record<string, unknown>)[CMD_RUN_TITLE_FIELD] as string
    : tab.title
  const interactionPoints = cmdRunInteractionOf(tab)
  const model = useMemo(
    () => service?.view(sessionId, contentId, contentId),
    [service, sessionId, contentId],
  )
  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => model?.state.subscribe(callback) ?? (() => {}), [model]),
    useCallback(() => model?.state.getSnapshot(), [model]),
  )
  const scheme = useSyncExternalStore(subscribeColorScheme, isDarkScheme)
  const [copied, setCopied] = useState(false)

  // DOM 生命周期 only——detach 不关进程；关进程只发生在关 tab（onClose）与
  // 「重新运行」的显式 close。
  useEffect(() => {
    if (model === undefined) return
    return model.mount()
  }, [model])

  const patchMeta = useCallback((meta: Record<string, unknown>) => {
    try {
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta }, sessionId)
    } catch {
      // minimal mock / 服务缺席：不阻塞注入（下次挂载再试）。
    }
  }, [ctx, tab.id, sessionId])

  // 命令行注入：首次 writable 且 meta 尚未标记已注入。标记持久（写回 meta），
  // reload 重挂同一进程不重发；「重新运行」重置标记后走同一通路。
  useEffect(() => {
    if (model === undefined || commandline === '' || state?.writable !== true) return
    if (cmdRunInjectedOf(tab)) return
    model.write(`${commandline}\r`)
    patchMeta({ ...(tab.meta as Record<string, unknown>), [CMD_RUN_INJECTED_FIELD]: true })
  }, [model, commandline, state?.writable, tab, patchMeta])

  /** 重新运行：关旧进程 → bump 世代 + 重置注入标记（命令行沿用 meta，不重弹窗）。 */
  const rerun = useCallback(() => {
    // close 是「保存关闭意图后立即释放」的同步调用（WebTerminalsFace 的契约
    // ——进程清理活得比 DOM 卸载久），失败由宿主侧自理，这里无需 catch。
    service?.close(sessionId, contentId, contentId)
    try {
      ctx.get('betterSidebar')?.updateTab(tab.id, { meta: nextCmdRunMeta(tab) }, sessionId)
    } catch {
      // 服务缺席时无 tab 可更新——旧进程已关，界面随状态显示退出。
    }
  }, [service, sessionId, contentId, ctx, tab])

  /** 停止：Ctrl+C（`\x03`）——交互脚本与前台进程都认。 */
  const stop = useCallback(() => {
    model?.write('\x03')
  }, [model])

  /** 关闭 tab：走 service.closeTab，descriptor 的 onClose 关宿主终端进程。 */
  const closeTab = useCallback(() => {
    try {
      ctx.get('betterSidebar')?.closeTab(tab.id, { sessionId })
    } catch {
      // minimal mock：无 tab 面可关，静默。
    }
  }, [ctx, tab.id, sessionId])

  const copyCommandline = useCallback(() => {
    void navigator.clipboard?.writeText(commandline).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    }).catch(() => {})
  }, [commandline])

  if (service === undefined) {
    return (
      <section className={css.cmdRunRoot} data-dsh-cmd-run="" data-cmd-run-state="unavailable">
        <p className={css.cmdRunNotice} role="alert">{t('terminalUnavailable')}</p>
      </section>
    )
  }
  if (model === undefined || state === undefined) return null

  const info = state.info
  const running = info?.state === 'running' && state.phase === 'connected'

  return (
    <section className={css.cmdRunRoot} data-dsh-cmd-run="" data-cmd-run-state={info?.state ?? state.phase}>
      <div className={css.cmdRunHead}>
        <span className={css.cmdRunTitle}>{title}</span>
        <span className={`${css.badge} ${running ? css.badgeLive : ''}`} data-cmd-run-badge="state">
          {stateBadgeOf(info?.state, info?.exitCode)}
        </span>
        <span className={css.cmdRunHeadActions}>
          <button type="button" className={css.ghostButton} onClick={rerun}>{t('cmdRunRerun')}</button>
          {running && <button type="button" className={css.ghostButton} onClick={stop}>{t('cmdRunStop')}</button>}
          <button type="button" className={css.ghostButton} onClick={closeTab}>{t('close')}</button>
        </span>
      </div>
      <div className={css.cmdRunCommandline}>
        <code className={css.cmdRunCommandlineText}>{commandline}</code>
        <button type="button" className={css.iconButton} aria-label={copied ? t('copied') : t('copy')} title={copied ? t('copied') : t('copy')} onClick={copyCommandline}>
          {copied ? '✓' : '⧉'}
        </button>
      </div>
      {interactionPoints !== undefined && interactionPoints.length > 0 && (
        <div className={css.cmdRunChips} data-cmd-run-chips="">
          {interactionPoints.slice(0, 6).map(point => (
            <span key={point.line} className={css.badge} title={point.hint}>
              {t('cmdRunInteractionChip', { line: point.line })} {point.snippet.slice(0, 60)}
            </span>
          ))}
        </div>
      )}
      {state.info !== undefined && (
        <CmdRunScreen model={model} state={state} visible={visible} scheme={scheme} label={title} />
      )}
      <CmdRunQuickInput model={model} running={running} label={title} />
      {state.error !== undefined && state.issue === undefined && (
        <p className={css.cmdRunNotice} role="alert">{t('terminalError')}: {state.error}</p>
      )}
    </section>
  )
}

/** 状态徽标文案：运行中 / 已退出(exitCode) / 失败；其余相位不显示。 */
function stateBadgeOf(state: 'running' | 'exited' | 'failed' | undefined, exitCode: number | null | undefined): string | null {
  if (state === 'running') return t('jobStatusRunning')
  if (state === 'exited') return t('cmdRunExited', { code: exitCode === null || exitCode === undefined ? '?' : String(exitCode) })
  if (state === 'failed') return t('jobStatusFailed')
  return null
}

interface CmdRunScreenProps {
  model: HostTerminalView
  state: HostTerminalViewState
  visible: boolean
  scheme: boolean
  label: string
}

/** xterm 屏幕（frame→xterm→acknowledge、fit），并维护「屏幕尾部」文本给等待输入启发。 */
function CmdRunScreen({ model, state, visible, scheme, label }: CmdRunScreenProps): ReactNode {
  const element = useRef<HTMLDivElement | null>(null)
  const emulator = useRef<Terminal | undefined>(undefined)
  const fit = useRef<FitAddon | undefined>(undefined)
  const lastRevision = useRef(0)
  // 屏幕尾部：snapshot 换整屏，output 追加；运行时启发只看这 ~2000 字符。
  const screenTail = useRef('')
  const lastOutputAt = useRef(Date.now())
  const [waiting, setWaiting] = useState(false)
  const current = useRef({ state, visible })
  current.current = { state, visible }

  useLayoutEffect(() => {
    const node = element.current
    if (node === null) return
    const xterm = new Terminal({
      fontFamily: getComputedStyle(node).fontFamily,
      fontSize: 13,
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      scrollback: current.current.state.environment?.scrollback ?? 0,
    })
    const addon = new FitAddon()
    xterm.loadAddon(addon)
    xterm.open(node)
    xterm.textarea?.setAttribute('aria-label', label)
    emulator.current = xterm
    fit.current = addon
    lastRevision.current = 0
    const input = xterm.onData((data) => { model.write(data) })
    const measure = (): void => {
      const live = current.current
      if (!live.visible || !live.state.writable || node.clientWidth === 0 || node.clientHeight === 0) return
      fitScreen(xterm, addon, live.state.environment, model)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => {
      observer?.disconnect()
      input.dispose()
      xterm.dispose()
      emulator.current = undefined
      fit.current = undefined
    }
  }, [model, label])

  useLayoutEffect(() => {
    const node = element.current
    const xterm = emulator.current
    if (node === null || xterm === undefined) return
    const style = getComputedStyle(node)
    xterm.options.theme = {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.color,
      cursorAccent: style.backgroundColor,
      selectionBackground: style.color,
      selectionForeground: style.backgroundColor,
    }
  }, [scheme, model, state.phase])

  // frame 协议：snapshot 整屏重放、output 追加，然后 ACK 放行下一帧。
  useLayoutEffect(() => {
    const xterm = emulator.current
    const render = state.render
    if (xterm === undefined || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    if (render.frame.type === 'snapshot') {
      xterm.reset()
      xterm.resize(render.frame.info.cols, render.frame.info.rows)
      screenTail.current = render.frame.screen.slice(-2000)
    } else {
      screenTail.current = `${screenTail.current}${render.frame.data}`.slice(-2000)
    }
    lastOutputAt.current = Date.now()
    setWaiting(false)
    xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => {
      model.acknowledge(render.revision)
    })
  }, [state.render, model])

  const { writable, environment, info } = state
  useLayoutEffect(() => {
    const xterm = emulator.current
    if (xterm === undefined) return
    xterm.options.disableStdin = !writable
    if (visible && writable) fitScreen(xterm, fit.current, environment, model)
    else if (info !== undefined && !writable) xterm.resize(info.cols, info.rows)
  }, [visible, writable, environment, info, model])

  // 「等待输入」启发：running 且 ≥1.5s 无新输出且屏幕尾部命中提示符正则。
  // 轮询 1s（帧回调里已即时清旗，轮询只负责点亮）。
  useEffect(() => {
    const timer = setInterval(() => {
      const live = current.current
      const still = live.state.info?.state === 'running'
      const quiet = Date.now() - lastOutputAt.current >= 1500
      const hit = still && quiet && detectWaitInput(screenTail.current)
      setWaiting(hit)
    }, 1000)
    return () => { clearInterval(timer) }
  }, [])

  // 等待输入点亮时把焦点交给 xterm（键入直接进进程）。
  useEffect(() => {
    if (waiting && visible && writable) emulator.current?.focus()
  }, [waiting, visible, writable])

  return (
    <div className={css.cmdRunScreenHost} data-cmd-run-screen="">
      {waiting && (
        <div className={css.cmdRunWaiting} role="status" data-cmd-run-waiting="">{t('cmdRunWaitingInput')}</div>
      )}
      <div className={terminalCss.screen} ref={element} />
    </div>
  )
}

/** 底部快捷输入行：文本输入 + 发送 + y / n（直接 write 行 + \r）。 */
function CmdRunQuickInput({ model, running, label }: { model: HostTerminalView; running: boolean; label: string }): ReactNode {
  const [line, setLine] = useState('')
  const send = useCallback(() => {
    if (line === '') return
    model.write(`${line}\r`)
    setLine('')
  }, [line, model])
  const quick = useCallback((text: string) => {
    model.write(`${text}\r`)
  }, [model])
  return (
    <div className={css.cmdRunInputRow} data-cmd-run-input="">
      <input
        className={css.input}
        value={line}
        aria-label={t('cmdRunInputAria')}
        placeholder={running ? t('cmdRunInputPlaceholder') : t('cmdRunInputEnded')}
        spellCheck={false}
        onChange={(event) => { setLine(event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            send()
          }
        }}
      />
      <button type="button" className={css.ghostButton} disabled={!running} onClick={send}>{t('sideChatSend')}</button>
      <button type="button" className={css.ghostButton} disabled={!running} aria-label={`${label} y`} onClick={() => { quick('y') }}>y</button>
      <button type="button" className={css.ghostButton} disabled={!running} aria-label={`${label} n`} onClick={() => { quick('n') }}>n</button>
    </div>
  )
}

/** Fit the emulator to its box and publish the size, clamped to the host's limits. */
function fitScreen(
  xterm: Terminal,
  addon: FitAddon | undefined,
  environment: HostTerminalEnvironment | undefined,
  model: HostTerminalView,
): void {
  const dimensions = addon?.proposeDimensions()
  if (dimensions === undefined || environment === undefined) return
  const cols = Math.min(dimensions.cols, environment.maxCols)
  const rows = Math.min(dimensions.rows, environment.maxRows)
  if (cols < 2 || rows < 1) return
  xterm.resize(cols, rows)
  model.resize(cols, rows)
}
