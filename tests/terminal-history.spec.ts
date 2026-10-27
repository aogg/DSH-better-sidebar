/**
 * Command-history recording (R1): the pure helpers (OSC 133 parsing, output
 * truncation, commit derivation), the per-session ring buffer, and the
 * recorder's input/output state machine (keystrokes, prompt baseline, OSC 133
 * precise boundaries vs the 400 ms quiet heuristic, ^C interruption, capacity
 * re-read). The clock is faked for the heuristic timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalCommandRecorder, TerminalHistoryLog, deriveCommittedCommand,
  parseOsc133, terminalHistoryLogOf, truncateCommandOutput,
} from '../src/client/terminal-history.ts'
import { SIDEBAR_PREFS_DEFAULTS, clampTerminalHistoryLimit, terminalHistoryLimitOf } from '../src/prefs-shared.ts'

describe('parseOsc133', () => {
  it('maps the shell-integration markers', () => {
    expect(parseOsc133('A')).toEqual({ kind: 'prompt' })
    expect(parseOsc133('B')).toEqual({ kind: 'prompt' })
    expect(parseOsc133('C')).toEqual({ kind: 'exec' })
    expect(parseOsc133('D')).toEqual({ kind: 'done', exitCode: undefined })
  })

  it('reads the exit code from D and ignores extra option segments', () => {
    expect(parseOsc133('D;0')).toEqual({ kind: 'done', exitCode: 0 })
    expect(parseOsc133('D;1')).toEqual({ kind: 'done', exitCode: 1 })
    expect(parseOsc133('D;127;cwd=/tmp')).toEqual({ kind: 'done', exitCode: 127 })
    expect(parseOsc133('A;cwd=/w')).toEqual({ kind: 'prompt' })
  })

  it('answers undefined for anything else (and a non-numeric D payload)', () => {
    expect(parseOsc133('133')).toBeUndefined()
    expect(parseOsc133('X')).toBeUndefined()
    expect(parseOsc133('D;oops')).toEqual({ kind: 'done', exitCode: undefined })
  })
})

describe('truncateCommandOutput', () => {
  it('keeps short outputs verbatim', () => {
    expect(truncateCommandOutput('hello')).toBe('hello')
  })

  it('keeps head and tail around an ellipsis for long outputs', () => {
    const long = `${'a'.repeat(9000)}${'b'.repeat(9000)}`
    const truncated = truncateCommandOutput(long, 4000)
    expect(truncated.startsWith('a'.repeat(4000))).toBe(true)
    expect(truncated.endsWith('b'.repeat(4000))).toBe(true)
    expect(truncated).toContain('[…]')
    expect(truncated.length).toBeLessThan(8100)
  })
})

describe('deriveCommittedCommand', () => {
  it('strips the prompt baseline off the cursor line (tab completion, ↑ recall)', () => {
    expect(deriveCommittedCommand('$ ', '$ git st', 'x')).toBe('git st')
    expect(deriveCommittedCommand('user@host:/w$ ', 'user@host:/w$ ls --col', '')).toBe('ls --col')
  })

  it('falls back to the keystrokes when the baseline went stale', () => {
    expect(deriveCommittedCommand('$ ', '# different prompt', 'echo hi')).toBe('echo hi')
  })

  it('trims and answers empty for a bare Enter', () => {
    expect(deriveCommittedCommand('$ ', '$   ', '')).toBe('')
    expect(deriveCommittedCommand(undefined, '', '')).toBe('')
  })
})

describe('TerminalHistoryLog', () => {
  it('lists newest first and settles statuses with the exit code only when seen', () => {
    const log = new TerminalHistoryLog()
    const first = log.start('one', 100)
    const second = log.start('two', 200)
    expect(log.list().map(record => record.command)).toEqual(['two', 'one'])
    log.appendOutput(first.id, 'out')
    log.finish(first.id, 'failed', 3, 300)
    log.finish(second.id, 'done', undefined, 350)
    const [latest, older] = log.list()
    expect(older).toMatchObject({ command: 'one', status: 'failed', exitCode: 3, output: 'out', endedAt: 300 })
    expect(latest).toMatchObject({ command: 'two', status: 'done', exitCode: undefined })
  })

  it('trims to the capacity, dropping the oldest, and re-clamps on setCapacity', () => {
    const log = new TerminalHistoryLog(3)
    for (const command of ['a', 'b', 'c', 'd']) log.start(command, 1)
    expect(log.list().map(record => record.command)).toEqual(['d', 'c', 'b'])
    log.setCapacity(2)
    expect(log.list().map(record => record.command)).toEqual(['d', 'c'])
  })

  it('strips ANSI from captured output when the record settles', () => {
    const log = new TerminalHistoryLog()
    const record = log.start('ls', 1)
    log.appendOutput(record.id, '\x1b[32mgreen\x1b[0m plain')
    log.finish(record.id, 'success', 0, 2)
    expect(log.list()[0]?.output).toBe('green plain')
  })

  it('notifies subscribers through a monotonic revision', () => {
    const log = new TerminalHistoryLog()
    const seen: number[] = []
    const dispose = log.subscribe(() => { seen.push(log.getRevision()) })
    log.start('x', 1)
    log.start('y', 2)
    dispose()
    log.start('z', 3)
    expect(seen).toEqual([1, 2])
  })
})

describe('TerminalCommandRecorder (input side)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A recorder over a mutable fake cursor line, with its session log. */
  function makeRecorder(options?: { capacity?: number }) {
    const sessionId = `s-${Math.random().toString(36).slice(2)}`
    let cursorLine = ''
    // A local const keeps the `number` narrowing inside the closure (a
    // readonly `options.capacity` member read does not survive into it).
    const capacity = options?.capacity
    const recorder = new TerminalCommandRecorder({
      sessionId,
      readCursorLine: () => cursorLine,
      ...(capacity !== undefined ? { readCapacity: () => capacity } : {}),
      now: () => Date.now(),
    })
    return {
      recorder,
      sessionId,
      log: terminalHistoryLogOf(sessionId),
      setCursorLine: (line: string) => { cursorLine = line },
    }
  }

  it('captures the baseline off the first frame and derives the command from the line', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleFrame({ type: 'output', data: 'prompt\r\n' })
    harness.setCursorLine('$ ls --col')
    harness.recorder.handleInput('ls\r') // keystrokes alone would be just `ls`
    const [record] = harness.log.list()
    expect(record).toMatchObject({ command: 'ls --col', status: 'running' })
  })

  it('falls back to the keystrokes when the cursor line has no baseline', () => {
    const harness = makeRecorder()
    harness.setCursorLine('')
    harness.recorder.handleFrame({ type: 'output', data: 'x' })
    harness.recorder.handleInput('echo hi\r')
    expect(harness.log.list()[0]).toMatchObject({ command: 'echo hi' })
  })

  it('handles backspace, ^U, ^W and ignores ESC runs (arrow keys)', () => {
    const harness = makeRecorder()
    harness.recorder.handleFrame({ type: 'output', data: 'x' })
    harness.recorder.handleInput('abc')
    harness.recorder.handleInput('\x7f') // drop `c`
    harness.recorder.handleInput('\x17') // ^W drops `ab`
    harness.recorder.handleInput('git status ')
    harness.recorder.handleInput('\x1b[A') // ↑ recall (an ESC run)
    harness.recorder.handleInput('\x15') // ^U clears the pending line
    harness.recorder.handleInput('npm t')
    harness.recorder.handleInput('\r')
    expect(harness.log.list()[0]).toMatchObject({ command: 'npm t' })
  })

  it('does not start a record for a bare Enter on an empty prompt', () => {
    const harness = makeRecorder()
    harness.recorder.handleFrame({ type: 'output', data: 'x' })
    harness.recorder.handleInput('\r')
    expect(harness.log.list()).toEqual([])
  })

  it('heuristic: ~400 ms of output silence ends the command as 未知退出码', () => {
    const harness = makeRecorder()
    harness.recorder.handleFrame({ type: 'output', data: 'x' })
    harness.recorder.handleInput('sleep\r')
    harness.recorder.handleFrame({ type: 'output', data: 'working…' })
    vi.advanceTimersByTime(200)
    harness.recorder.handleFrame({ type: 'output', data: 'more' }) // re-arms
    vi.advanceTimersByTime(399)
    expect(harness.log.list()[0]?.status).toBe('running')
    vi.advanceTimersByTime(1)
    const record = harness.log.list()[0]
    expect(record).toMatchObject({ command: 'sleep', status: 'done', exitCode: undefined })
    expect(record?.output).toContain('working…more')
    // The fresh prompt after the end re-captures the baseline on the next frame.
    harness.setCursorLine('$ ')
    harness.recorder.handleFrame({ type: 'output', data: '\r\n$ ' })
    harness.recorder.handleInput('next\r')
    expect(harness.log.list()[0]).toMatchObject({ command: 'next' })
  })

  it('^C interrupts the running command and clears the pending line', () => {
    const harness = makeRecorder()
    harness.recorder.handleFrame({ type: 'output', data: 'x' })
    harness.recorder.handleInput('tail -f /dev/null\r')
    harness.recorder.handleInput('partial')
    harness.recorder.handleInput('\x03')
    expect(harness.log.list()[0]).toMatchObject({ command: 'tail -f /dev/null', status: 'interrupted', exitCode: undefined })
    // The partial line was dropped: the next commit records only its own text.
    harness.recorder.handleInput('ls\r')
    expect(harness.log.list()[0]).toMatchObject({ command: 'ls' })
  })

  it('a commit while the predecessor is unsettled closes it as unknown-done', () => {
    const harness = makeRecorder()
    harness.recorder.handleFrame({ type: 'output', data: 'x' })
    harness.recorder.handleInput('a\r')
    harness.recorder.handleInput('b\r')
    expect(harness.log.list().map(record => [record.command, record.status]))
      .toEqual([['b', 'running'], ['a', 'done']])
  })

  it('applies the live capacity (read per record start) to the ring', () => {
    const harness = makeRecorder({ capacity: 2 })
    for (const command of ['one\r', 'two\r', 'three\r']) {
      harness.recorder.handleInput(command)
      // Settle each instantly so the records are independent.
      vi.advanceTimersByTime(400)
    }
    expect(harness.log.list().map(record => record.command)).toEqual(['three', 'two'])
  })
})

describe('TerminalCommandRecorder (OSC 133 shell integration)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function makeRecorder() {
    const sessionId = `osc-${Math.random().toString(36).slice(2)}`
    let cursorLine = ''
    const recorder = new TerminalCommandRecorder({
      sessionId,
      readCursorLine: () => cursorLine,
      now: () => Date.now(),
    })
    return { recorder, sessionId, log: terminalHistoryLogOf(sessionId), setCursorLine: (line: string) => { cursorLine = line } }
  }

  it('D carries the precise exit code: 0 = success, non-zero = failed', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleOsc133('A')
    harness.recorder.handleFrame({ type: 'output', data: '$ ' })
    harness.recorder.handleOsc133('C')
    harness.recorder.handleFrame({ type: 'output', data: 'output' })
    harness.recorder.handleOsc133('D;0')
    expect(harness.log.list()[0]).toMatchObject({ status: 'success', exitCode: 0 })

    harness.setCursorLine('$ ')
    harness.recorder.handleOsc133('A')
    harness.recorder.handleOsc133('C')
    harness.recorder.handleOsc133('D;3')
    expect(harness.log.list()[0]).toMatchObject({ status: 'failed', exitCode: 3 })
  })

  it('D without a code records 完成(未知退出码), never a guessed code', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleOsc133('C')
    harness.recorder.handleOsc133('D')
    expect(harness.log.list()[0]).toMatchObject({ status: 'done', exitCode: undefined })
  })

  it('C records commands written straight through the model (no onData)', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleFrame({ type: 'output', data: '$ ' })
    // The mint's `cd` / CmdRun quick-input path: model.write, no onData.
    harness.setCursorLine("cd '/work'")
    harness.recorder.handleOsc133('C')
    expect(harness.log.list()[0]).toMatchObject({ command: "cd '/work'", status: 'running' })
    // The heuristic timer never arms once shell integration spoke.
    vi.advanceTimersByTime(2000)
    expect(harness.log.list()[0]?.status).toBe('running')
  })

  it('a C while a record is already running does not double-start', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleFrame({ type: 'output', data: '$ ' })
    harness.recorder.handleInput('make\r')
    harness.recorder.handleOsc133('C')
    expect(harness.log.list()).toHaveLength(1)
  })

  it('the heuristic timer stays silent after any 133 event', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleInput('x\r')
    harness.recorder.handleOsc133('A')
    vi.advanceTimersByTime(1000)
    expect(harness.log.list()[0]?.status).toBe('running')
  })

  it('a snapshot frame during an active command feeds the captured output', () => {
    const harness = makeRecorder()
    harness.setCursorLine('$ ')
    harness.recorder.handleInput('long\r')
    harness.recorder.handleFrame({ type: 'snapshot', screen: 'restored screen tail' })
    harness.recorder.handleOsc133('D;0')
    expect(harness.log.list()[0]?.output).toContain('restored screen tail')
  })
})

describe('terminal history settings (prefs-shared)', () => {
  it('clamps the capacity into 10–1000 with 100 as the fallback', () => {
    expect(clampTerminalHistoryLimit(undefined)).toBe(100)
    expect(clampTerminalHistoryLimit('not a number')).toBe(100)
    expect(clampTerminalHistoryLimit(0)).toBe(10)
    expect(clampTerminalHistoryLimit(-5)).toBe(10)
    expect(clampTerminalHistoryLimit(1001)).toBe(1000)
    expect(clampTerminalHistoryLimit(250)).toBe(250)
    expect(clampTerminalHistoryLimit('42')).toBe(42)
    // 7.6 rounds to 8, and the declared range still wins: the answer is the
    // floor 10, never an out-of-range value.
    expect(clampTerminalHistoryLimit(7.6)).toBe(10)
  })

  it('reads the capacity from the terminal-bottom settings blob with the default as fallback', () => {
    expect(terminalHistoryLimitOf(SIDEBAR_PREFS_DEFAULTS)).toBe(100)
    expect(terminalHistoryLimitOf({
      ...SIDEBAR_PREFS_DEFAULTS,
      pluginSettings: { 'terminal-bottom': { terminalHistoryLimit: 555 } },
    })).toBe(555)
    // A corrupt value falls back to the default, never crashes the recorder.
    expect(terminalHistoryLimitOf({
      ...SIDEBAR_PREFS_DEFAULTS,
      pluginSettings: { 'terminal-bottom': { terminalHistoryLimit: 'bogus' } },
    })).toBe(100)
  })
})
