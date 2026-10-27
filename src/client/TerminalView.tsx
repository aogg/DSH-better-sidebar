/**
 * The bottom workbench's terminal: an xterm.js emulator driven by the HOST's
 * session-scoped terminal service (`ctx.webTerminals`, see
 * ./terminal-client.ts). The plugin owns no PTY — the host keeps process
 * lifetime, screen recovery and reconnection, and this view is only the
 * emulator plus the command plumbing.
 *
 * This module is the LAZY CHUNK's payload (`src/client/chunks/terminal.tsx`):
 * xterm is hundreds of KB, so it must never be reachable from the core
 * bundle. `tsdown.config.ts` builds `lib/client-terminal.js`, and
 * `tests/chunk-artifact.spec.ts` pins that xterm is inside the chunk and NOT
 * inside `lib/client.js`. Never import this file from a core-bundle module —
 * reach it through `lazyChunkComponent('terminal', …)` instead.
 *
 * The host's terminal model is frame-based, not a stream:
 *
 * - `view.state.render` holds the NEXT frame awaiting
 *   {@link HostTerminalView.acknowledge}; a `snapshot` frame carries the whole
 *   serialized screen and must be REPLAYED (reset + resize + write), an
 *   `output` frame is appended. The emulator's write callback is what releases
 *   the following frame, so an unacknowledged frame stops output for good.
 * - `mount()` attaches the DOM lifetime and returns a DETACH callback: a
 *   remount (tab switch, panel collapse, session switch) re-attaches to the
 *   same live process. Unmounting must NOT close the terminal — the host's
 *   contract is "a view survives DOM unmount; its process only ends on
 *   explicit close", and it is what makes a reload restore the same shell. The
 *   descriptor's `onClose` is the one place that does close it.
 * - The process identity is restored through the host's persisted
 *   `(sessionId, contentId) -> terminalId` binding, so the content identity
 *   must be STABLE across mounts ({@link bottomTerminalContentId}). "New
 *   terminal" deliberately mints a new one, because the old binding points at
 *   a process that is gone (host restart, terminal closed elsewhere) and
 *   reusing it would wedge the tab on `missingTerminal` forever.
 * - `write` / `resize` go through the model (which serializes them and refuses
 *   them while the view is not writable), never straight to the remote —
 *   otherwise two windows' keystrokes would interleave.
 *
 * Colors come from theme tokens: the stylesheet paints the screen from
 * `--dsw-*` / `--ds-*` and the concrete values are read back through
 * `getComputedStyle` — GUARDED (bindSurfaceTheme): while the values do not
 * paint yet the emulator stays unthemed and a `<head>` style watcher applies
 * the theme the moment styles land, instead of freezing on a transparent
 * (white-flashing) surface. This module carries no color literal
 * (`tests/theme.spec.ts`).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { VscHistory } from 'react-icons/vsc'
import '@xterm/xterm/css/xterm.css'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import { t } from './locales.ts'
import { isDarkScheme, subscribeColorScheme } from './theme.ts'
import {
  CWD_FIELD, bottomTerminalContentId, nextTerminalMeta, terminalCwdOf, terminalInstanceOf, terminalRunOf, webTerminals,
  type HostTerminalEnvironment, type HostTerminalView, type HostTerminalViewState,
} from './terminal-client.ts'
import { attachPasteTakeover, bindSurfaceTheme } from './terminal-surface.ts'
import { TerminalCommandRecorder } from './terminal-history.ts'
import { terminalHistoryLimitOf, SIDEBAR_PREFS_DEFAULTS } from '../prefs-shared.ts'
import { TerminalHistoryPopover } from './TerminalHistoryPopover.tsx'
import type { SidebarStore, SidebarTab } from './state.ts'
import css from './terminal.module.css'

/** The props the bottom terminal view consumes from its tab descriptor. */
export interface TerminalBottomProps {
  ctx: Context
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
  /**
   * The shared store: the only reader of the history-capacity setting
   * (`pluginSettings['terminal-bottom'][TERMINAL_HISTORY_SETTING_KEY]`).
   * Optional for composition shapes that predate the prop — the capacity then
   * falls back to the default.
   */
  store?: SidebarStore
}

/**
 * Render the bottom workbench's terminal tab.
 * @param props - the client context, the tab's session scope and visibility.
 * @returns the terminal screen plus its status/degradation panels.
 */
export function TerminalBottomView({ ctx, scope, tab, visible, store }: TerminalBottomProps): ReactNode {
  const sessionId = scope.sessionId
  // The service is probed structurally, never injected: a deployment without
  // it keeps the tray row disabled and renders the explanation below.
  const service = useMemo(() => webTerminals(ctx), [ctx])
  const run = terminalRunOf(tab)
  const instance = terminalInstanceOf(tab)
  // One identity value serves as BOTH the host occurrence key and the content
  // identity (`view(sessionId, key, contentId)`), and the instance keeps two
  // bottom terminals in one session from sharing it (#774 follow-up).
  const contentId = bottomTerminalContentId(run, instance)
  // `view()` allocates the terminal eagerly and memoizes one model per
  // (session, key) on the host side, so this memo must be the ONLY creation
  // path: a repeat `view()` for the same key is free, a new key is a new PTY.
  const model = useMemo(
    () => service?.view(sessionId, contentId, contentId),
    [service, sessionId, contentId],
  )
  const state = useSyncExternalStore(
    useMemo(() => (callback: () => void) => model?.state.subscribe(callback) ?? (() => {}), [model]),
    useCallback(() => model?.state.getSnapshot(), [model]),
  )
  const scheme = useSyncExternalStore(subscribeColorScheme, isDarkScheme)
  // 「执行命令历史」浮层的锚点按钮（AnchoredPopover 的几何锚）。
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null)

  // The DOM lifetime only — the detach leaves the shell running. The app's
  // own teardown for the process is the descriptor's `onClose`.
  useEffect(() => {
    if (model === undefined) return
    return model.mount()
  }, [model])

  /**
   * 「新建终端」：bump meta 的世代即铸新壳。同拍去重：连点/点按+快捷键落在同
   * 一个 tick 时，两次点击都从同一个 tab prop 计算 nextTerminalMeta——写出
   * 同一份 meta 之外，updateTab 是整体替换 meta，后写会把先铸 mint 的后续
   * effect 已写入的字段清掉。锁在下一个微任务释放：之后的真点击照常再铸。
   */
  const mintLock = useRef<string | undefined>(undefined)
  const newTerminal = useCallback(() => {
    if (mintLock.current !== undefined) return
    mintLock.current = tab.id
    // Writing the generation is what mints the replacement: the memo above
    // rebuilds against a fresh content identity, so the host allocates a new
    // terminal instead of adopting a binding whose process is gone.
    ctx.get('betterSidebar')?.updateTab(tab.id, { meta: nextTerminalMeta(tab) }, sessionId)
    queueMicrotask(() => { if (mintLock.current === tab.id) mintLock.current = undefined })
  }, [ctx, tab, sessionId])

  // 「打开终端」's start directory: the mint parked it in the tab's meta (see
  // CWD_FIELD in terminal-client.ts — the host's view() takes no cwd), and
  // THIS is where it is spent: the moment the fresh shell is writable, one
  // `cd` line is typed into it and the field is dropped again, so a reload —
  // which reattaches the SAME process, already sitting in the directory —
  // never re-runs the command. A view that never gains control (the user
  // switching away, the service degrading) simply leaves the request parked.
  const startCwd = terminalCwdOf(tab)
  useEffect(() => {
    if (model === undefined || startCwd === undefined || state?.writable !== true) return
    // A single-quoted POSIX cd (a quote inside the path becomes '\''), \r is
    // the Enter keystroke. Deliberately no Windows variant: the plugin has no
    // platform probe of its own (desktop-env.ts carries only the transport
    // base), and guessing cmd's `cd /d` vs PowerShell's `Set-Location` would
    // be wrong on exactly one of them — a shell that starts in the workspace
    // root is recoverable, one that failed to parse its first command is not.
    // （这次 model.write 直写不经 onData，命令历史不记录它——见 recorder。）
    model.write(`cd '${startCwd.replace(/'/g, `'\\''`)}'\r`)
    const rest = tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
      ? { ...(tab.meta as Record<string, unknown>) }
      : {}
    delete rest[CWD_FIELD]
    ctx.get('betterSidebar')?.updateTab(tab.id, { meta: rest }, sessionId)
  }, [model, startCwd, state?.writable, ctx, tab, sessionId])

  // The capacity reader rides the store: the recorder re-reads it per record,
  // so a settings change applies to the NEXT command without a remount.
  const readHistoryCapacity = useCallback(
    () => terminalHistoryLimitOf(store?.getPrefs() ?? SIDEBAR_PREFS_DEFAULTS),
    [store],
  )

  if (service === undefined) {
    return (
      <section className={css.root} data-dsh-bottom-terminal data-terminal-state="unavailable">
        <p className={css.notice} role="alert">{t('terminalUnavailable')}</p>
      </section>
    )
  }
  if (model === undefined || state === undefined) {
    // NOT `return null`: a bare null empties the whole workbench pane (the
    // reported "terminal vanishes into a white blank") — an occupant with a
    // status line is always rendered while the model/state pair is resolving.
    return (
      <section className={css.root} data-dsh-bottom-terminal data-terminal-state="loading">
        <div className={css.status} role="status">
          <span>{t('loading')}</span>
        </div>
      </section>
    )
  }

  const missing = state.issue === 'missingTerminal'
  const ended = state.info?.state === 'exited' || state.phase === 'closed'
  // The missing/ended panels carry their own message, so the pending-phase
  // status line is only for a terminal that is still worth waiting on —
  // without this gate a closed terminal would say "exited" twice.
  const status = missing || ended ? undefined : statusOf(state)

  return (
    <section className={css.root} data-dsh-bottom-terminal data-terminal-state={state.phase}>
      {status !== undefined && (
        <div className={css.status} role="status">
          <span>{status}</span>
          {reconnectable(state) && (
            <button
              type="button"
              className={css.action}
              onClick={() => {
                // The host's own rule: a view with a terminal but no live
                // attachment reconnects (a fresh snapshot follows); a view
                // that never got one re-runs environment/terminal lookup.
                if (state.info === undefined) void model.refresh()
                else model.connect()
              }}
            >
              {t('terminalRetry')}
            </button>
          )}
        </div>
      )}
      {(missing || ended) && (
        <div className={css.noticeBlock}>
          <p className={missing ? css.notice : css.status} role={missing ? 'alert' : 'status'}>
            {missing ? t('terminalGone') : t('exited')}
          </p>
          <button type="button" className={css.action} onClick={newTerminal}>{t('terminalNew')}</button>
        </div>
      )}
      {state.info !== undefined && !missing && (
        <div className={css.screenHost}>
          <TerminalScreen
            model={model}
            state={state}
            visible={visible}
            scheme={scheme}
            label={t('terminal')}
            sessionId={sessionId}
            readHistoryCapacity={readHistoryCapacity}
          />
          <button
            type="button"
            className={css.historyButton}
            aria-label={t('terminalHistory')}
            aria-haspopup="dialog"
            aria-expanded={historyAnchor !== null}
            title={t('terminalHistory')}
            onClick={(event) => {
              setHistoryAnchor(current => (current === event.currentTarget ? null : event.currentTarget))
            }}
          >
            <VscHistory size={14} />
            <span>{t('terminalHistory')}</span>
          </button>
          {historyAnchor !== null && (
            <TerminalHistoryPopover
              anchor={historyAnchor}
              sessionId={sessionId}
              onClose={() => { setHistoryAnchor(null) }}
            />
          )}
        </div>
      )}
      {state.error !== undefined && state.issue === undefined && (
        <p className={css.error} role="alert">{t('terminalError')}: {state.error}</p>
      )}
    </section>
  )
}

/** The one-line status for a view whose screen is not worth showing yet. */
function statusOf(state: HostTerminalViewState): string | undefined {
  switch (state.phase) {
    case 'idle':
    case 'loading':
    case 'creating':
    case 'connecting':
      return t('loading')
    case 'disconnected':
      return t('disconnected')
    case 'failed':
      return t('terminalConnectFailed')
    default:
      return undefined
  }
}

/**
 * Whether the retry affordance applies: the two phases that describe a
 * terminal that exists but is not currently attached (an ended or missing
 * terminal gets the "new terminal" action instead).
 */
function reconnectable(state: HostTerminalViewState): boolean {
  return state.phase === 'failed' || state.phase === 'disconnected'
}

interface TerminalScreenProps {
  model: HostTerminalView
  state: HostTerminalViewState
  visible: boolean
  scheme: boolean
  label: string
  /** The session owning the command-history log (shared across tabs). */
  sessionId: string
  /** The live 「执行命令历史」 capacity (re-read per record start). */
  readHistoryCapacity: () => number
}

/**
 * The emulator cell, mounted once the host reported a terminal and bound to
 * the MODEL: a status change re-renders around it, only a new terminal
 * (a "new terminal" mint, or the tab remounting) opens a new emulator.
 *
 * Besides the frame protocol this cell feeds three sideways consumers:
 * the paste takeover (`attachPasteTakeover`), the command-history recorder
 * (`TerminalCommandRecorder` — OSC 133 shell integration first, heuristic
 * otherwise) and the guarded theme bridge (`bindSurfaceTheme`).
 */
function TerminalScreen({ model, state, visible, scheme, label, sessionId, readHistoryCapacity }: TerminalScreenProps): ReactNode {
  const element = useRef<HTMLDivElement | null>(null)
  const emulator = useRef<Terminal | undefined>(undefined)
  const fit = useRef<FitAddon | undefined>(undefined)
  const lastRevision = useRef(0)
  const recorder = useRef<TerminalCommandRecorder | undefined>(undefined)
  // Read inside the xterm effects without re-creating the emulator on every
  // snapshot: the emulator is bound to the MODEL, the live flags are read
  // through this ref (the host's own terminal body does exactly this).
  const current = useRef({ state, visible })
  current.current = { state, visible }

  useLayoutEffect(() => {
    const node = element.current
    if (node === null) return
    const xterm = new Terminal({
      // The screen element is painted from theme tokens; xterm needs the
      // concrete stack, so read it back instead of hardcoding one.
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
    // R2: own the paste events (ANSI strip + literal marker strip + newline
    // normalization + bracketed-paste wrapping while DECSET 2004 is on).
    const paste = attachPasteTakeover(node, xterm, (data) => { model.write(data) })
    // R1: command-history recording. The recorder reads the cursor row off
    // the xterm buffer for the prompt baseline and the commit derivation.
    const commandRecorder = new TerminalCommandRecorder({
      sessionId,
      readCapacity: readHistoryCapacity,
      readCursorLine: () => {
        const buffer = xterm.buffer?.active
        const line = buffer?.getLine(buffer.baseY + buffer.cursorY)
        return line?.translateToString(true) ?? ''
      },
    })
    recorder.current = commandRecorder
    // OSC 133 shell integration: precise boundaries + exit codes when the
    // shell emits them. `false` = xterm's own handling continues unchanged.
    const osc133 = xterm.parser?.registerOscHandler?.(133, (data) => {
      commandRecorder.handleOsc133(data)
      return false
    })
    const input = xterm.onData((data) => {
      commandRecorder.handleInput(data)
      model.write(data)
    })
    const measure = (): void => {
      const live = current.current
      if (!live.visible || !live.state.writable || node.clientWidth === 0 || node.clientHeight === 0) return
      fitScreen(xterm, addon, live.state.environment, model)
    }
    // jsdom has no ResizeObserver; the explicit fit effect below still applies.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => {
      observer?.disconnect()
      input.dispose()
      osc133?.dispose()
      paste.dispose()
      commandRecorder.dispose()
      recorder.current = undefined
      xterm.dispose()
      emulator.current = undefined
      fit.current = undefined
    }
  }, [model, label, sessionId, readHistoryCapacity])

  // The theme bridge, guarded: apply the concrete colors now, and while they
  // do not paint yet watch <head> styles and apply the moment they land (see
  // bindSurfaceTheme — the boot-window white-flash defense). A scheme flip
  // re-runs this effect through the `scheme` dependency.
  useLayoutEffect(() => {
    const node = element.current
    const xterm = emulator.current
    if (node === null || xterm === undefined) return
    return bindSurfaceTheme(node, xterm)
  }, [scheme, model, state.phase])

  // The frame protocol: replay a snapshot, append output, then ACK — the host
  // holds the next frame until this write's callback runs.
  useLayoutEffect(() => {
    const xterm = emulator.current
    const render = state.render
    if (xterm === undefined || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    // The recorder sees every frame BEFORE the emulator renders it (output
    // capture + baseline points; a no-op while no command is active).
    recorder.current?.handleFrame(render.frame)
    if (render.frame.type === 'snapshot') {
      xterm.reset()
      xterm.resize(render.frame.info.cols, render.frame.info.rows)
    }
    xterm.write(render.frame.type === 'snapshot' ? render.frame.screen : render.frame.data, () => {
      model.acknowledge(render.revision)
    })
  }, [state.render, model])

  // Size and input control both follow the view state: fitting a view that
  // does not hold control would fight the window that does. Read the fields
  // out first so the effect's dependency list is exactly what it uses.
  const { writable, environment, info } = state
  useLayoutEffect(() => {
    const xterm = emulator.current
    if (xterm === undefined) return
    xterm.options.disableStdin = !writable
    if (visible && writable) fitScreen(xterm, fit.current, environment, model)
    else if (info !== undefined && !writable) xterm.resize(info.cols, info.rows)
  }, [visible, writable, environment, info, model])

  useEffect(() => {
    if (visible && writable) emulator.current?.focus()
  }, [visible, writable])

  // `data-testid` gives the tests a stable handle on the paste-takeover
  // surface (css-module class names are not stable selector material).
  return <div className={css.screen} ref={element} data-testid="terminal-screen" />
}

/**
 * Fit the emulator to its box and publish the size, clamped to the host's
 * per-terminal limits (a size the host refuses would leave the shell's own
 * idea of the window wrong).
 */
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
