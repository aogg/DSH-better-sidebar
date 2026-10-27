/**
 * In-memory command-history recording for the plugin's xterm surfaces (the
 * bottom workbench terminal, the 命令 run tab): every command the shell
 * executes gets one record — the input text, its captured output (ANSI
 * stripped, head/tail truncated) and its execution status.
 *
 * Pure client side, deliberately: the records live in a per-session ring
 * buffer in this module's memory (`terminalHistoryLogOf`), there is NO backend
 * route, no persistence and no polling — a page reload clears the history by
 * design. Every terminal tab of one session feeds the SAME log, so the
 * 「执行命令历史」 popover shows them all.
 *
 * Boundary detection, best available first:
 * - OSC 133 shell integration (`xterm.parser.registerOscHandler(133, …)`):
 *   A = prompt start, C = command execution start, `D;exit` = command done
 *   with the precise exit code. When the shell emits these, status is exact.
 * - Otherwise a heuristic: after a commit, ~400 ms of output silence ends the
 *   command as 完成(未知退出码) — the code NEVER invents a precise exit code it
 *   did not see.
 * - `\x03` (Ctrl+C) while a command is active records 已中断.
 *
 * Known limitation (accepted, documented): the host holds the frame stream
 * while a view is unmounted (a tab switch stops the frame delivery until the
 * next `acknowledge`), so a command that runs entirely while its tab is
 * switched away captures only the snapshot tail on remount — and its heuristic
 * end fires ~400 ms after the stream resumes.
 */
import { TERMINAL_HISTORY_DEFAULT } from '../prefs-shared.ts'
import { stripAnsiSequences } from './terminal-paste.ts'

/** Execution status of one recorded command. */
export type TerminalCommandStatus = 'running' | 'success' | 'failed' | 'interrupted' | 'done'

/** One recorded command execution. Output is ANSI-free and bounded. */
export interface TerminalCommandRecord {
  readonly id: number
  readonly command: string
  /** `running` until an end is observed (see the module header). */
  status: TerminalCommandStatus
  /** The exit code when one was SEEN (OSC 133 `D;exit`); `undefined` = unknown. */
  exitCode: number | undefined
  readonly startedAt: number
  endedAt: number | undefined
  /** ANSI-free, head/tail-truncated output (empty when nothing was captured). */
  output: string
}

/**
 * Bound the displayed output: the first and last {@link OUTPUT_KEEP} characters
 * with an ellipsis line between (the middle of a long log is exactly what the
 * reader scrolls the live terminal for, not what the history needs).
 */
export const OUTPUT_KEEP = 4000

/** The ellipsis line spliced between the kept head and tail. */
const OUTPUT_ELLIPSIS = '\n[…]\n'

/**
 * Bound the RAW accumulation while a command runs (before the final
 * head/tail display truncation). Front-trimming may cut an escape sequence at
 * the boundary; the display value is stripped again on read, so the worst case
 * is a stray fragment in one record's output.
 */
const RAW_CAP = 64_000

/**
 * Truncate an ANSI-free output string to head+tail around an ellipsis.
 */
export function truncateCommandOutput(text: string, keep: number = OUTPUT_KEEP): string {
  if (text.length <= keep * 2 + OUTPUT_ELLIPSIS.length) return text
  return `${text.slice(0, keep)}${OUTPUT_ELLIPSIS}${text.slice(-keep)}`
}

/** One OSC 133 payload, parsed. */
export type Osc133 =
  | { readonly kind: 'prompt' }
  | { readonly kind: 'exec' }
  | { readonly kind: 'done'; readonly exitCode: number | undefined }

/**
 * Parse an OSC 133 payload (the part after `133;`): `A` = prompt start,
 * `C` = command execution start, `D` / `D;<exit>` = command done. Extra
 * option segments (`A;cwd=…`, …) are ignored; anything else reads as unknown
 * and is dropped by the caller.
 */
export function parseOsc133(payload: string): Osc133 | undefined {
  const first = payload.indexOf(';')
  const kind = (first === -1 ? payload : payload.slice(0, first)).trim()
  if (kind === 'A' || kind === 'B') return { kind: 'prompt' }
  if (kind === 'C') return { kind: 'exec' }
  if (kind === 'D') {
    const rest = first === -1 ? '' : payload.slice(first + 1).trim()
    // `D;4096;other=…`-shaped payloads: the FIRST segment is the exit code.
    const codePart = rest.split(';')[0] ?? ''
    if (codePart === '') return { kind: 'done', exitCode: undefined }
    const code = Number.parseInt(codePart, 10)
    return Number.isNaN(code)
      ? { kind: 'done', exitCode: undefined }
      : { kind: 'done', exitCode: code }
  }
  return undefined
}

/**
 * Derive the committed command from the screen: the cursor line minus the
 * recorded prompt baseline covers tab completion and ↑-history recall (the
 * full line is on screen); the accumulated keystrokes are the fallback for a
 * baseline that went stale (prompt redrawn, multiline paste).
 */
export function deriveCommittedCommand(baseline: string | undefined, cursorLine: string, keystrokes: string): string {
  const line = cursorLine.replace(/\s+$/u, '')
  if (baseline !== undefined && baseline !== '' && line.startsWith(baseline)) {
    const derived = line.slice(baseline.length).trim()
    if (derived !== '') return derived
  }
  return keystrokes.trim()
}

/**
 * Structural defense for the ring's capacity: finite and at least 1. The
 * settings-level clamp (10–1000) is NOT this class's business — it lives in
 * `clampTerminalHistoryLimit` (the settings row and `terminalHistoryLimitOf`);
 * the ring itself must honor whatever capacity its caller states, or the
 * small-capacity semantics become untestable.
 */
function sanitizeRingCapacity(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : TERMINAL_HISTORY_DEFAULT
}

/** The per-session ring buffer of command records (newest LAST internally). */
export class TerminalHistoryLog {
  private records: TerminalCommandRecord[] = []
  private nextId = 1
  private revision = 0
  private readonly listeners = new Set<() => void>()
  private capacity: number

  constructor(capacity: number = TERMINAL_HISTORY_DEFAULT) {
    this.capacity = sanitizeRingCapacity(capacity)
  }

  /** The monotonic change counter (the popover's `useSyncExternalStore` snapshot). */
  getRevision(): number {
    return this.revision
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Records, newest first (a copy — the popover must not observe mutations). */
  list(): readonly TerminalCommandRecord[] {
    return [...this.records].reverse()
  }

  /** Apply a new capacity immediately (the settings row can shrink it live). */
  setCapacity(capacity: number): void {
    const sanitized = sanitizeRingCapacity(capacity)
    if (sanitized === this.capacity) return
    this.capacity = sanitized
    this.trim()
  }

  /** Begin one record (running); drops the oldest beyond the capacity. */
  start(command: string, now: number): TerminalCommandRecord {
    const record: TerminalCommandRecord = {
      id: this.nextId,
      command,
      status: 'running',
      exitCode: undefined,
      startedAt: now,
      endedAt: undefined,
      output: '',
    }
    this.nextId += 1
    this.records.push(record)
    this.trim()
    this.notify()
    return record
  }

  /** Append one raw output chunk to a running record (ANSI stripped on read). */
  appendOutput(id: number, chunk: string): void {
    if (chunk === '') return
    const record = this.records.find(candidate => candidate.id === id)
    if (record === undefined || record.status !== 'running') return
    const raw = ((record as TerminalCommandRecord & { raw?: string }).raw ?? '') + chunk
    ;(record as TerminalCommandRecord & { raw?: string }).raw = raw.length > RAW_CAP ? raw.slice(raw.length - RAW_CAP) : raw
    this.notify()
  }

  /**
   * Settle a record. `exitCode === undefined` records 完成(未知退出码)-style
   * statuses — the caller must not pass a guessed code.
   */
  finish(id: number, status: Exclude<TerminalCommandStatus, 'running'>, exitCode: number | undefined, now: number): void {
    const record = this.records.find(candidate => candidate.id === id)
    if (record === undefined || record.status !== 'running') return
    const raw = (record as TerminalCommandRecord & { raw?: string }).raw ?? ''
    delete (record as TerminalCommandRecord & { raw?: string }).raw
    record.output = truncateCommandOutput(stripAnsiSequences(raw))
    record.status = status
    record.exitCode = exitCode
    record.endedAt = now
    this.notify()
  }

  /** Drop records beyond the capacity (oldest first). */
  private trim(): void {
    if (this.records.length <= this.capacity) return
    this.records = this.records.slice(this.records.length - this.capacity)
  }

  private notify(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }
}

/** The per-session logs (one ring buffer per session, shared by all its tabs). */
const logs = new Map<string, TerminalHistoryLog>()

/** The log of one session (created on first use; dies with the page). */
export function terminalHistoryLogOf(sessionId: string): TerminalHistoryLog {
  const existing = logs.get(sessionId)
  if (existing !== undefined) return existing
  const created = new TerminalHistoryLog()
  logs.set(sessionId, created)
  return created
}

/** Drop one session's log (the tests' cleanup; the page never needs it). */
export function disposeTerminalHistoryLog(sessionId: string): void {
  logs.delete(sessionId)
}

/** Where the recorder reads the cursor row's text from (the xterm buffer). */
export type CursorLineReader = () => string

/** How the recorder resolves the current capacity (the live settings value). */
export type CapacityReader = () => number

export interface TerminalCommandRecorderOptions {
  readonly sessionId: string
  readonly readCursorLine: CursorLineReader
  readonly readCapacity?: CapacityReader
  /** Injectable clock (the tests); `Date.now` in the app. */
  readonly now?: () => number
}

/** The heuristic quiet period after a commit (the task's ~400 ms silence). */
const QUIET_MS = 400

/** Keystroke accumulation cap (a paste of novel length must not grow unbounded). */
const KEYSTROKES_CAP = 4000

/**
 * One emulator's recording brain: the input side (keystroke tracking, prompt
 * baseline, commit derivation) plus the output side (frame capture, boundary
 * detection). Created per emulator mount; the RECORDS it produces live in the
 * session log and survive the unmount.
 *
 * The mint's automatic `cd '…'` (TerminalView writes it through the MODEL,
 * not through `onData`) never reaches {@link handleInput}, so it is
 * deliberately NOT recorded: it is the plugin's own navigation bookkeeping,
 * not a command the user ran (and its output — the fresh prompt — is what the
 * baseline capture is FOR).
 */
export class TerminalCommandRecorder {
  private readonly log: TerminalHistoryLog
  private readonly options: TerminalCommandRecorderOptions
  private keystrokes = ''
  private baseline: string | undefined
  /** Set when the prompt is about to be (re)printed; captured on the next frame. */
  private pendingBaseline = false
  private activeId: number | undefined
  private quietTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether the shell announced OSC 133 at least once (heuristic then off). */
  private shellIntegration = false

  constructor(options: TerminalCommandRecorderOptions) {
    this.options = options
    this.log = terminalHistoryLogOf(options.sessionId)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * Feed one `onData` chunk BEFORE it reaches the model. Tracks printable
   * input, backspace (\\x7f), ^U (\\x15 clear line), ^W (\\x17 clear word),
   * ^C (\\x03 interrupt) and \\r (commit). Escape sequences (arrow keys,
   * function keys — `onData` reports them as ESC runs) are stripped out, so an
   * ↑-history recall simply does not corrupt the keystroke fallback; the
   * cursor-line derivation covers the recalled text.
   */
  handleInput(data: string): void {
    if (data === '') return
    // ^C anywhere in the chunk interrupts the active command (and clears the
    // pending line, as a shell does at a fresh prompt).
    if (data.includes('\x03')) {
      this.interrupt()
      return
    }
    const plain = stripAnsiSequences(data)
    for (const ch of plain) {
      if (ch === '\r') {
        this.commit()
        continue
      }
      if (ch === '\x7f') {
        // Backspace: drop the last CODE POINT (surrogate-pair safe).
        this.keystrokes = [...this.keystrokes].slice(0, -1).join('')
        continue
      }
      if (ch === '\x15') {
        this.keystrokes = ''
        continue
      }
      if (ch === '\x17') {
        // ^W: strip trailing whitespace, then the word before the cursor.
        const trimmed = this.keystrokes.replace(/\s+$/u, '')
        this.keystrokes = trimmed.replace(/\S*$/u, '')
        continue
      }
      if (ch < ' ') continue // other control bytes never reach a prompt line
      this.keystrokes = (this.keystrokes + ch).slice(-KEYSTROKES_CAP)
    }
  }

  /**
   * Feed one render frame (snapshot replay or output append). Drives output
   * capture and the baseline capture points.
   */
  handleFrame(frame: { readonly type: string; readonly data?: string; readonly screen?: string }): void {
    if (frame.type === 'snapshot') {
      // A snapshot replays the whole screen: while a command is active it is
      // the best continuation available after a remount (the frames that
      // played while the tab was switched away are gone — see the header).
      if (this.activeId !== undefined && frame.screen !== undefined) {
        this.log.appendOutput(this.activeId, `\n${frame.screen}`)
      }
    } else if (frame.type === 'output' && frame.data !== undefined) {
      if (this.activeId !== undefined) {
        this.log.appendOutput(this.activeId, frame.data)
        // The heuristic arm: any output postpones the quiet end.
        if (!this.shellIntegration) this.armQuietTimer()
      }
    }
    // Baseline capture: the first frame after mount (initial prompt), or the
    // frame after a command ended (the fresh prompt printed past it).
    if (this.activeId === undefined && (this.baseline === undefined || this.pendingBaseline)) {
      this.captureBaseline()
    }
  }

  /**
   * Feed one OSC 133 payload (registered through
   * `xterm.parser.registerOscHandler(133, …)`; the handler returns `false` so
   * xterm's own shell-integration state still updates).
   */
  handleOsc133(payload: string): void {
    const event = parseOsc133(payload)
    if (event === undefined) return
    this.shellIntegration = true
    this.clearQuietTimer()
    if (event.kind === 'prompt') {
      // The prompt starts printing: capture the baseline off the NEXT frame.
      this.pendingBaseline = true
      return
    }
    if (event.kind === 'exec') {
      // Execution start (commands written straight through the model — the
      // cd injection, CmdRun's quick input — never see `onData`): derive the
      // command from the screen once, at the moment the shell confirms one.
      if (this.activeId !== undefined) return
      const cursorLine = this.options.readCursorLine()
      const derived = deriveCommittedCommand(this.baseline, cursorLine, this.keystrokes)
      this.keystrokes = ''
      // The shell has ANNOUNCED an execution, so an empty derivation must not
      // drop the record: when both derivations come up empty (the model-write
      // path leaves the keystrokes empty while a redrawn prompt went stale)
      // the cursor line itself is the best name available. The plain `\r`
      // commit path keeps refusing empty — a bare Enter is not a command.
      const command = derived !== '' ? derived : cursorLine.trim()
      if (command === '') return
      this.activeId = this.start(command).id
      return
    }
    // done: the precise exit code (or none — recorded as unknown, never guessed).
    if (this.activeId !== undefined) {
      const status = event.exitCode === undefined ? 'done' : event.exitCode === 0 ? 'success' : 'failed'
      this.finishActive(status, event.exitCode)
    }
    this.pendingBaseline = true
  }

  /** Drop the timers on unmount. The session log and its records survive. */
  dispose(): void {
    this.clearQuietTimer()
  }

  /** Commit (Enter): derive the command and open the running record. */
  private commit(): void {
    const command = deriveCommittedCommand(this.baseline, this.options.readCursorLine(), this.keystrokes)
    this.keystrokes = ''
    if (command === '') return
    if (this.activeId !== undefined) {
      // A commit raced the previous command's end (fast `cmd1; cmd2` style):
      // settle the predecessor as unknown-done before opening the successor.
      this.finishActive('done', undefined)
    }
    this.activeId = this.start(command).id
    if (!this.shellIntegration) this.armQuietTimer()
  }

  /** ^C: the active command is 已中断; at a prompt the pending line clears. */
  private interrupt(): void {
    this.keystrokes = ''
    if (this.activeId === undefined) return
    this.finishActive('interrupted', undefined)
    this.pendingBaseline = true
  }

  private start(command: string): TerminalCommandRecord {
    const capacity = this.options.readCapacity?.() ?? TERMINAL_HISTORY_DEFAULT
    this.log.setCapacity(capacity)
    return this.log.start(command, this.now())
  }

  private finishActive(status: Exclude<TerminalCommandStatus, 'running'>, exitCode: number | undefined): void {
    const id = this.activeId
    this.activeId = undefined
    this.clearQuietTimer()
    if (id !== undefined) this.log.finish(id, status, exitCode, this.now())
  }

  private captureBaseline(): void {
    this.pendingBaseline = false
    this.baseline = this.options.readCursorLine().replace(/\s+$/u, '')
  }

  /** The heuristic end: QUIET_MS without output after a commit. */
  private armQuietTimer(): void {
    this.clearQuietTimer()
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined
      if (this.activeId === undefined || this.shellIntegration) return
      this.finishActive('done', undefined)
      this.pendingBaseline = true
    }, QUIET_MS)
  }

  private clearQuietTimer(): void {
    if (this.quietTimer === undefined) return
    clearTimeout(this.quietTimer)
    this.quietTimer = undefined
  }
}
