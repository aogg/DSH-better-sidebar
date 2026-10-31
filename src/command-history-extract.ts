/**
 * 「执行历史」纯逻辑：会话事件日志 → 命令类工具调用的执行记录。
 *
 * 与 src/prompt-history-extract.ts 同一形制（框架自由，宿主路由与测试环境
 * 都能直接导入）：输入宿主事件信封 {type,seq,time,data}，只认
 * `tool/call` 且 {@link activityOf} 归类为 `commands` 的调用（bash/pwsh/
 * exec_command/write_stdin 与 terminal_* 前缀——识别规则直接复用
 * process-activity.ts，勿另写一份），按 callId 与 `tool/result` 配对
 * （resultCallId 认 0.1.6/0.1.7 两种历史日志形态）。
 *
 * 每行尽量带回：命令文本（args 里第一个存在的字符串键，按 command→cmd→
 * input→data→characters 的次序）、workdir、description、timeoutMs、
 * background、env（仅当调用参数里带 env 对象才有——宿主日志不逐条记录
 * env，没有就是「未记录」）、结果文本（toolResultText 认两种 result 形态）、
 * exitCode（结果文本尾部的 `[exit code: N]` 标记）、status 与 duration。
 *
 * 无命令文本的行照收（rerun 时 UI 禁用）——历史只忠实记录发生过什么，
 * 绝不因参数不可读而丢行。任何一处坏参数（JSON 坏串、字段类型不符）都
 * 只降级该字段，绝不抛错。
 */
import { activityOf, resultCallId } from './process-activity.ts'
import { toolResultText } from './sidechat-core.ts'

/** 一条命令执行记录（wire 形状，服务端折叠函数直接回给客户端）。 */
export interface ExecCommandRow {
  /** 配对用的调用 id（`tool/call` 的 callId；无结果的行也可为空串兜底）。 */
  callId: string
  /** 工具名（bash/pwsh/exec_command/write_stdin/terminal_*）。 */
  tool: string
  /** 源 `tool/call` 事件在会话日志里的 seq。 */
  seq: number
  /** 调用事件的信封时间（epoch ms；缺时间时为 0）。 */
  time: number
  /** 命令文本（args 里第一个存在的字符串键；无 → 空串，UI 禁用再次运行）。 */
  command: string
  /** 命令文本因超过 {@link EXEC_COMMAND_MAX_CHARS} 被截断。 */
  commandTruncated?: boolean
  /** 调用参数的 description（有则 UI 优先展示）。 */
  description?: string
  /** 执行时所在目录（调用参数里带了才有）。 */
  workdir?: string
  /** args.run_in_background === true。 */
  background: boolean
  /** 调用参数里的有限数字 timeout。 */
  timeoutMs?: number
  /** 调用参数里带的 env（仅当 args.env 是对象才有；宿主日志不逐条记录）。 */
  env?: { key: string; value: string }[]
  /** env 因条数或单值超限被截断。 */
  envTruncated?: boolean
  /** running=无配对结果；ok=exitCode 0 或未知；fail=exitCode>0。 */
  status: 'running' | 'ok' | 'fail'
  /** 结果文本尾部的退出码（无配对结果或无标记时缺席）。 */
  exitCode?: number
  /** 结果文本（无配对结果为空串；超长截断打标）。 */
  resultText: string
  /** 结果文本因超过 {@link EXEC_RESULT_MAX_CHARS} 被截断。 */
  resultTruncated?: boolean
  /** result.time - call.time（两边都存在且为正才给）。 */
  durationMs?: number
  /** 结果事件的信封时间（缺席 = 尚无结果）。 */
  resultTime?: number
}

/** 命令文本上限（字符）；超出截断并打 commandTruncated 标记。 */
export const EXEC_COMMAND_MAX_CHARS = 8000
/** 结果文本上限（字符）；超出截断并打 resultTruncated 标记。 */
export const EXEC_RESULT_MAX_CHARS = 4000
/** env 收纳上限（条数），超出丢尾并打 envTruncated 标记。 */
export const EXEC_ENV_MAX_ENTRIES = 40
/** env 单条 value 上限（字符），超出截断并打 envTruncated 标记。 */
export const EXEC_ENV_VALUE_MAX_CHARS = 200
/** 默认返回条数上限；超出丢最旧并置 truncated。 */
export const EXEC_HISTORY_DEFAULT_LIMIT = 200

/** 一个事件的本模块最小结构面（接受宿主 SessionEvent 与宽松夹具）。 */
export interface ExecHistorySourceEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** 命令文本的键优先序（照 process-activity.ts liveToolDetail 的「第一个存在的键」习惯）。 */
const COMMAND_KEYS = ['command', 'cmd', 'input', 'data', 'characters'] as const

/** 结果文本尾部的退出码标记（宿主 harness 的 bash/pwsh 输出契约）。 */
const EXIT_CODE_PATTERN = /\[exit code: (\d+)\]\s*$/

/** 安全 parse 一段 JSON 参数字符串；坏串/非对象 → undefined。 */
function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 截到上限并回答是否发生了截断。 */
function clampText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** 从调用参数提取命令文本（第一个存在的字符串键；上限截断）。 */
function commandOf(args: Record<string, unknown> | undefined): { command: string; commandTruncated?: boolean } {
  if (args === undefined) return { command: '' }
  for (const key of COMMAND_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const clamped = clampText(value, EXEC_COMMAND_MAX_CHARS)
    return clamped.truncated ? { command: clamped.text, commandTruncated: true } : { command: clamped.text }
  }
  return { command: '' }
}

/** 从调用参数提取 env（仅当 args.env 是对象；条数与单值双重上限）。 */
function envOf(args: Record<string, unknown> | undefined): { env?: { key: string; value: string }[]; envTruncated?: boolean } {
  if (args === undefined) return {}
  const raw = args.env
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return {}
  const env: { key: string; value: string }[] = []
  let truncated = entries.length > EXEC_ENV_MAX_ENTRIES
  for (const [key, value] of entries) {
    if (env.length >= EXEC_ENV_MAX_ENTRIES) break
    if (typeof value !== 'string') continue
    const clamped = clampText(value, EXEC_ENV_VALUE_MAX_CHARS)
    env.push({ key, value: clamped.text })
    if (clamped.truncated) truncated = true
  }
  if (env.length === 0) return truncated ? { env: [], envTruncated: true } : {}
  return truncated ? { env, envTruncated: true } : { env }
}

/**
 * 从一个会话的事件日志抽取命令类工具调用的执行记录。
 * @param events - 会话事件日志（宿主信封或宽松夹具，时间升序）。
 * @param options.limit - 最多返回最近多少条（默认 {@link EXEC_HISTORY_DEFAULT_LIMIT}）；超出时丢弃最旧的并置 truncated。
 * @returns 记录列表（时间新→旧）+ 是否因 limit 丢弃过记录。
 */
export function extractExecCommandRows(
  events: readonly ExecHistorySourceEvent[],
  options: { limit?: number } = {},
): { rows: ExecCommandRow[]; truncated: boolean } {
  const limit = typeof options.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit > 0
    ? options.limit
    : EXEC_HISTORY_DEFAULT_LIMIT
  // callId → 结果事件的收件箱：日志保证 result 晚于 call，先扫一遍把所有
  // 结果按 callId 归位，主循环里 O(1) 配对（一个 callId 取一次，重复结果
  // 以最新一条为准）。
  const results = new Map<string, ExecHistorySourceEvent>()
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'tool/result') continue
    const callId = resultCallId(event.data)
    if (callId === undefined) continue
    results.set(callId, event)
  }
  const rows: ExecCommandRow[] = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'tool/call') continue
    if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) continue
    const data = event.data
    const tool = typeof data.name === 'string' ? data.name : ''
    if (tool === '' || activityOf(tool) !== 'commands') continue
    const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : `anon-${event.seq}`
    const args = parseArgs(data.arguments)
    const command = commandOf(args)
    const env = envOf(args)
    const description = typeof args?.description === 'string' && args.description !== '' ? args.description : undefined
    const workdir = typeof args?.workdir === 'string' && args.workdir !== '' ? args.workdir : undefined
    const timeoutMs = typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined
    const background = args?.run_in_background === true
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
    const result = results.get(callId)
    const resultTime = result !== undefined && typeof result.time === 'number' && Number.isFinite(result.time)
      ? result.time
      : undefined
    const resultText = result === undefined ? '' : toolResultText(result.data)
    // 退出码认在**完整**结果文本的尾部，再为展示截断——截断只裁显示，
    // 不许把长输出的失败命令错报成 ok。
    const exitMatch = resultText.match(EXIT_CODE_PATTERN)
    const exitCode = exitMatch === null ? undefined : Number.parseInt(exitMatch[1]!, 10)
    const clampedResult = clampText(resultText, EXEC_RESULT_MAX_CHARS)
    const durationMs = resultTime !== undefined && time > 0 && resultTime > time ? resultTime - time : undefined
    rows.push({
      callId,
      tool,
      seq: event.seq,
      time,
      command: command.command,
      ...(command.commandTruncated === true ? { commandTruncated: true } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(workdir !== undefined ? { workdir } : {}),
      background,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.env !== undefined ? { env: env.env } : {}),
      ...(env.envTruncated === true ? { envTruncated: true } : {}),
      status: result === undefined ? 'running' : (exitCode !== undefined && exitCode > 0 ? 'fail' : 'ok'),
      ...(exitCode !== undefined ? { exitCode } : {}),
      resultText: clampedResult.text,
      ...(clampedResult.truncated ? { resultTruncated: true } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(resultTime !== undefined ? { resultTime } : {}),
    })
  }
  // 新→旧：日志是升序收集的，倒序即新→旧；超出 limit 丢最旧（数组尾部）。
  rows.reverse()
  if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true }
  return { rows, truncated: false }
}
