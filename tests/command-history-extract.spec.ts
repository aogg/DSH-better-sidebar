/**
 * 「执行历史」纯逻辑：会话事件 → 命令类工具调用执行记录的抽取
 * （src/command-history-extract.ts）。钉住：activityOf 口径的命令类识别
 * （bash/pwsh/exec_command/write_stdin/terminal_* 前缀；*_inspect 后缀不算）、
 * callId 两种日志形态的配对、结果文本两种形态的提取、命令文本键优先序、
 * workdir/description/timeoutMs/background/env 的提取与上限、exitCode 与
 * status 推导、durationMs 的给法、limit 排序（新→旧 + 丢最旧打标）。
 */
import { describe, expect, it } from 'vitest'
import {
  EXEC_COMMAND_MAX_CHARS,
  EXEC_ENV_MAX_ENTRIES,
  EXEC_ENV_VALUE_MAX_CHARS,
  EXEC_HISTORY_DEFAULT_LIMIT,
  EXEC_RESULT_MAX_CHARS,
  extractExecCommandRows,
  type ExecHistorySourceEvent,
} from '../src/command-history-extract.ts'

/** 一条 `tool/call` 夹具（宽松信封；callId 按 seq 确定，测试间互不依赖）。 */
function callEvent(
  seq: number,
  name: string,
  args: unknown,
  over: Partial<ExecHistorySourceEvent> = {},
): ExecHistorySourceEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1_000_000 + seq * 1000,
    data: { name, callId: `c${seq}`, arguments: JSON.stringify(args) },
    ...over,
  }
}

/** 0.1.7 形态的结果：tool-role 信封，`data.callId` + 顶层 content blocks。 */
function resultModern(seq: number, callId: string, text: string): ExecHistorySourceEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_000_000 + seq * 1000,
    data: { callId, message: { content: [{ type: 'text', text }] } },
  }
}

/** 0.1.6 形态的结果：user-role 消息，callId 在 `message.source`，块包在
 *  `tool-result` 包裹块里（历史日志永远保持旧形态）。 */
function resultLegacy(seq: number, callId: string, text: string): ExecHistorySourceEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_000_000 + seq * 1000,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', content: [{ type: 'text', text }] }],
      },
    },
  }
}

describe('command-history extract（事件→执行记录）', () => {
  it('bash 正常执行：两种形态之外还带回 workdir/description/timeout 与 duration', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { command: 'pnpm test', description: '跑测试', workdir: '/repo/pkg', timeoutMs: 5000 }),
      resultModern(2, 'c1', 'all green\n[exit code: 0]'),
    ]
    const { rows, truncated } = extractExecCommandRows(events)
    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.tool).toBe('bash')
    expect(row.command).toBe('pnpm test')
    expect(row.description).toBe('跑测试')
    expect(row.workdir).toBe('/repo/pkg')
    expect(row.timeoutMs).toBe(5000)
    expect(row.background).toBe(false)
    expect(row.status).toBe('ok')
    expect(row.exitCode).toBe(0)
    expect(row.resultText).toBe('all green\n[exit code: 0]')
    expect(row.resultTruncated).toBeUndefined()
    expect(row.commandTruncated).toBeUndefined()
    expect(row.durationMs).toBe(1000)
    expect(row.resultTime).toBe(1_002_000)
    expect(row.env).toBeUndefined()
    expect(row.envTruncated).toBeUndefined()
  })

  it('exit 2 → fail（0.1.6 包裹块形态也能配对）', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { command: 'exit 2' }),
      resultLegacy(2, 'c1', 'boom\n[exit code: 2]'),
    ]
    const { rows } = extractExecCommandRows(events)
    expect(rows[0]!.status).toBe('fail')
    expect(rows[0]!.exitCode).toBe(2)
    expect(rows[0]!.resultText).toBe('boom\n[exit code: 2]')
  })

  it('无配对结果 → running：空结果文本、无 duration、env 缺席', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { command: 'sleep 100' }),
    ]
    const { rows } = extractExecCommandRows(events)
    const row = rows[0]!
    expect(row.status).toBe('running')
    expect(row.resultText).toBe('')
    expect(row.exitCode).toBeUndefined()
    expect(row.durationMs).toBeUndefined()
    expect(row.resultTime).toBeUndefined()
    expect(row.env).toBeUndefined()
  })

  it('pwsh 与 terminal_* 前缀算命令类；write/grep/subagent 与 *_inspect 不算', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'write', { file_path: '/a', content: 'x' }),
      callEvent(2, 'grep', { pattern: 'x' }),
      callEvent(3, 'subagent', { prompt: 'x' }),
      callEvent(4, 'bash_inspect', { command: 'inspect' }),
      callEvent(5, 'pwsh', { command: 'Get-Date' }),
      callEvent(6, 'terminal_bash', { data: 'ls' }),
      resultModern(7, 'c5', 'ok'),
    ]
    const { rows } = extractExecCommandRows(events)
    // 新→旧：terminal_bash(6) 在前、pwsh(5) 在后。
    expect(rows.map(row => [row.tool, row.seq])).toEqual([['terminal_bash', 6], ['pwsh', 5]])
    expect(rows[1]!.status).toBe('ok')
    expect(rows[0]!.status).toBe('running')
  })

  it('后台行 + env 提取：单值超限截断并打 envTruncated', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', {
        command: 'python server.py',
        run_in_background: true,
        env: { MODE: 'dev', LONG: 'v'.repeat(EXEC_ENV_VALUE_MAX_CHARS + 50) },
      }),
    ]
    const { rows } = extractExecCommandRows(events)
    const row = rows[0]!
    expect(row.background).toBe(true)
    expect(row.env).toEqual([
      { key: 'MODE', value: 'dev' },
      { key: 'LONG', value: 'v'.repeat(EXEC_ENV_VALUE_MAX_CHARS) },
    ])
    expect(row.envTruncated).toBe(true)
  })

  it('env 仅对象才收：数组 / 字符串 / 缺失都算「未记录」', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { command: 'a', env: ['A=1'] }),
      callEvent(2, 'bash', { command: 'b', env: 'A=1' }),
      callEvent(3, 'bash', { command: 'c' }),
    ]
    const { rows } = extractExecCommandRows(events)
    for (const row of rows) {
      expect(row.env).toBeUndefined()
      expect(row.envTruncated).toBeUndefined()
    }
  })

  it('env 条数上限：超过 40 条丢尾并打标', () => {
    const big = Object.fromEntries(
      Array.from({ length: EXEC_ENV_MAX_ENTRIES + 10 }, (_, index) => [`K${index}`, 'v']),
    )
    const events: ExecHistorySourceEvent[] = [callEvent(1, 'bash', { command: 'env', env: big })]
    const { rows } = extractExecCommandRows(events)
    const row = rows[0]!
    expect(row.env).toHaveLength(EXEC_ENV_MAX_ENTRIES)
    expect(row.env!.at(-1)!.key).toBe(`K${EXEC_ENV_MAX_ENTRIES - 1}`)
    expect(row.envTruncated).toBe(true)
  })

  it('两种 result 配对形态并存：data.callId / message.source.callId / toolCallId', () => {
    const events: ExecHistorySourceEvent[] = [
      { type: 'tool/call', seq: 1, time: 1000, data: { name: 'bash', callId: 'call-a', arguments: '{"command":"a"}' } },
      { type: 'tool/call', seq: 2, time: 2000, data: { name: 'bash', callId: 'call-b', arguments: '{"command":"b"}' } },
      { type: 'tool/call', seq: 3, time: 3000, data: { name: 'bash', callId: 'call-c', arguments: '{"command":"c"}' } },
      // call-a：0.1.7 message.toolCallId 信封。
      { type: 'tool/result', seq: 4, time: 4000, data: { message: { toolCallId: 'call-a', content: [{ type: 'text', text: 'out-a [exit code: 0]' }] } } },
      // call-b：0.1.6 message.source.callId。
      resultLegacy(5, 'call-b', 'out-b [exit code: 3]'),
      // call-c：顶层 data.toolCallId（宿主老信封）。
      { type: 'tool/result', seq: 6, time: 6000, data: { toolCallId: 'call-c', message: { content: [{ type: 'text', text: 'out-c' }] } } },
    ]
    const { rows } = extractExecCommandRows(events)
    expect(rows.map(row => row.command)).toEqual(['c', 'b', 'a'])
    expect(rows.map(row => row.status)).toEqual(['ok', 'fail', 'ok'])
    expect(rows.find(row => row.callId === 'call-c')!.resultText).toBe('out-c')
  })

  it('参数 JSON 坏串：行照收，命令文本为空', () => {
    const events: ExecHistorySourceEvent[] = [
      { type: 'tool/call', seq: 1, time: 1000, data: { name: 'bash', callId: 'x', arguments: 'not-json{' } },
    ]
    const { rows } = extractExecCommandRows(events)
    const row = rows[0]!
    expect(row.command).toBe('')
    expect(row.commandTruncated).toBeUndefined()
    expect(row.workdir).toBeUndefined()
    expect(row.description).toBeUndefined()
    expect(row.status).toBe('running')
  })

  it('命令文本键优先序：command→cmd→input→data→characters，非字符串键跳过', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { input: 'third', cmd: 'second', command: 'first' }),
      callEvent(2, 'bash', { data: 'fourth', characters: 'fifth', input: 'third' }),
      callEvent(3, 'write_stdin', { command: 42, input: 'real' }),
    ]
    const { rows } = extractExecCommandRows(events)
    expect(rows.map(row => row.command)).toEqual(['real', 'third', 'first'])
  })

  it('截断上限：命令 8000 / 结果 4000；退出码认在完整文本尾部不受展示截断影响', () => {
    const longCommand = 'x'.repeat(EXEC_COMMAND_MAX_CHARS + 1)
    const longResult = `${'y'.repeat(EXEC_RESULT_MAX_CHARS + 1)}\n[exit code: 2]`
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { command: longCommand }),
      resultModern(2, 'c1', longResult),
    ]
    const { rows } = extractExecCommandRows(events)
    const row = rows[0]!
    expect(row.command).toHaveLength(EXEC_COMMAND_MAX_CHARS)
    expect(row.commandTruncated).toBe(true)
    expect(row.resultText).toHaveLength(EXEC_RESULT_MAX_CHARS)
    expect(row.resultTruncated).toBe(true)
    expect(row.exitCode).toBe(2)
    expect(row.status).toBe('fail')
  })

  it('limit：默认 200；超出丢最旧并置 truncated', () => {
    const exact: ExecHistorySourceEvent[] = Array.from({ length: EXEC_HISTORY_DEFAULT_LIMIT }, (_, index) =>
      callEvent(index + 1, 'bash', { command: `cmd-${index + 1}` }))
    const full = extractExecCommandRows(exact)
    expect(full.rows).toHaveLength(EXEC_HISTORY_DEFAULT_LIMIT)
    expect(full.truncated).toBe(false)
    expect(full.rows[0]!.command).toBe(`cmd-${EXEC_HISTORY_DEFAULT_LIMIT}`)
    const many: ExecHistorySourceEvent[] = Array.from({ length: EXEC_HISTORY_DEFAULT_LIMIT + 5 }, (_, index) =>
      callEvent(index + 1, 'bash', { command: `cmd-${index + 1}` }))
    const cut = extractExecCommandRows(many, { limit: 2 })
    expect(cut.rows.map(row => row.command)).toEqual(['cmd-205', 'cmd-204'])
    expect(cut.truncated).toBe(true)
    const overflow = extractExecCommandRows(many)
    expect(overflow.rows).toHaveLength(EXEC_HISTORY_DEFAULT_LIMIT)
    expect(overflow.truncated).toBe(true)
  })

  it('durationMs 只在结果时间大于调用时间时给；无退出码标记的结果算 ok', () => {
    const events: ExecHistorySourceEvent[] = [
      callEvent(1, 'bash', { command: 'a' }),
      { type: 'tool/result', seq: 2, time: 1_001_000, data: { callId: 'c1', message: { content: [{ type: 'text', text: 'plain done' }] } } },
    ]
    const { rows } = extractExecCommandRows(events)
    expect(rows[0]!.durationMs).toBeUndefined()
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.exitCode).toBeUndefined()
  })
})
