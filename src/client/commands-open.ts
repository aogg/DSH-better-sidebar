/**
 * 「命令」开始页的运行侧客户端逻辑：cmd-run 执行 tab 的一次性 seed（park/
 * consume——createTab descriptor 收不到 openTab 的 seed meta，必须 park，形状
 * 抄 webview-open.ts / search-seed.ts）、命令行拼装（脚本路径 / 命令 + 运行
 * 目录）、contentId 契约、变量弹窗的「上次值」localStorage 记忆。
 *
 * 纯客户端、无 React：CommandsPageView（铸造方）与 CmdRunView（消费方）都只
 * 消费这里导出的类型与函数。
 */
import { shellQuote } from '../command-variables.ts'
import type { InteractionPoint } from '../command-interaction.ts'

/** openTab 服务里本模块真正用到的最小面（fake 友好）。 */
export interface CmdRunOpenService {
  isTabEnabled(id: string): boolean
  openTab(seed: { type: string; title?: string }): void
  closeTab(tabId: string, scope?: { sessionId: string }): void
}

/** park 进一次性 seed 的内容：标题 + 已替换变量的完整命令行 + 来源键。 */
export interface CmdRunSeed {
  title: string
  commandline: string
  /** 变量弹窗「上次值」记忆的键（`command:<id>` / `script:<abs>`；超长已哈希）。 */
  sourceKey?: string
  /** .sh 源的静态交互预扫（随 seed 带给执行 tab 的 chips；命令条目运行时重扫）。 */
  interactionPoints?: InteractionPoint[]
}

let parkedSeed: CmdRunSeed | undefined

/** park 一次执行请求，供下一次 cmd-run 的 createTab 消费（调完立刻 openTab）。 */
export function parkCmdRun(seed: CmdRunSeed): void {
  parkedSeed = seed
}

/** 取走（并清空）parked seed；undefined = 无 seed（拒绝铸 tab）。 */
export function consumeCmdRun(): CmdRunSeed | undefined {
  const seed = parkedSeed
  parkedSeed = undefined
  return seed
}

/** 执行 tab 的 id 前缀：`cmd:<uuid>`（不设 dedupeKey——每次点击都是新 tab）。 */
export function cmdRunTabId(uuid: string): string {
  return `cmd:${uuid}`
}

/** contentId 的命名空间（宿主按 (sessionId, contentId) 记恢复绑定）。 */
const CMD_RUN_NS = 'dsh-better-sidebar:cmd-run'

/** tab.meta 里标识一次 cmd-run tab 实例的字段。 */
export const CMD_RUN_INSTANCE_FIELD = 'cmdRunInstance'

/** tab.meta 里的 content-identity 世代（「重新运行」bump 它换新进程）。 */
export const CMD_RUN_RUN_FIELD = 'cmdRunRun'

/** tab.meta 里「命令行已注入」标记（持久——reload 重挂同一进程不重发命令行）。 */
export const CMD_RUN_INJECTED_FIELD = 'cmdRunInjected'

/** tab.meta 里携带的完整命令行。 */
export const CMD_RUN_COMMANDLINE_FIELD = 'commandline'

/** tab.meta 里携带的 tab 标题（脚本名 / 命令名）。 */
export const CMD_RUN_TITLE_FIELD = 'title'

/** tab.meta 里携带的来源键（徽标与记忆键；可缺席）。 */
export const CMD_RUN_SOURCE_KEY_FIELD = 'sourceKey'

/** tab.meta 里携带的静态交互预扫（.sh 源；可缺席）。 */
export const CMD_RUN_INTERACTION_FIELD = 'interactionPoints'

/** 执行 tab 的 contentId：实例进命名空间（多 tab 不共进程），世代后缀同 terminal。 */
export function cmdRunContentId(instance: string, run: number): string {
  const base = instance === '' ? CMD_RUN_NS : `${CMD_RUN_NS}:${instance}`
  return run === 0 ? base : `${base}#${run}`
}

/** tab.meta 的容错读取。 */
function metaOf(tab: { meta?: unknown }): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** tab 的实例 id（缺席/脏 meta → ''）。 */
export function cmdRunInstanceOf(tab: { meta?: unknown }): string {
  const value = metaOf(tab)[CMD_RUN_INSTANCE_FIELD]
  return typeof value === 'string' ? value : ''
}

/** tab 的世代（缺席/脏 meta → 0）。 */
export function cmdRunRunOf(tab: { meta?: unknown }): number {
  const value = metaOf(tab)[CMD_RUN_RUN_FIELD]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** tab 是否已注入过命令行（持久标记）。 */
export function cmdRunInjectedOf(tab: { meta?: unknown }): boolean {
  return metaOf(tab)[CMD_RUN_INJECTED_FIELD] === true
}

/** tab 携带的命令行（缺席 → undefined——无命令行不注入）。 */
export function cmdRunCommandlineOf(tab: { meta?: unknown }): string | undefined {
  const value = metaOf(tab)[CMD_RUN_COMMANDLINE_FIELD]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** tab 携带的静态交互预扫（缺席 → undefined）。 */
export function cmdRunInteractionOf(tab: { meta?: unknown }): InteractionPoint[] | undefined {
  const value = metaOf(tab)[CMD_RUN_INTERACTION_FIELD]
  return Array.isArray(value) ? value as InteractionPoint[] : undefined
}

/**
 * 「重新运行」的 meta patch：关旧 contentId 由调用方先做；这里 bump 世代 +
 * 重置注入标记（命令行原样沿用——不重新弹变量窗，行为可预期）。
 */
export function nextCmdRunMeta(tab: { meta?: unknown }): Record<string, unknown> {
  const meta = metaOf(tab)
  return {
    ...meta,
    [CMD_RUN_RUN_FIELD]: cmdRunRunOf(tab) + 1,
    [CMD_RUN_INJECTED_FIELD]: false,
  }
}

/**
 * End the tab's host terminal (the descriptor's `onClose`): closing the TAB is
 * the only thing that ends the process (a view survives DOM unmount).
 * Core-bundle-safe: no xterm here — the identity comes from the tab's meta
 * alone, through the same structural probe every webTerminals consumer uses.
 */
export function closeCmdRunTerminal(ctx: import('../context-types.ts').Context, tab: { meta?: unknown }, sessionId: string): void {
  if (sessionId === '') return
  const face = ctx.get('webTerminals') as unknown as Partial<{ view: unknown; close: unknown; recover: unknown }> | undefined | null
  if (face === undefined || face === null) return
  if (typeof face.view !== 'function' || typeof face.close !== 'function' || typeof face.recover !== 'function') return
  const id = cmdRunContentId(cmdRunInstanceOf(tab), cmdRunRunOf(tab))
  ;(face as { close(sessionId: string, key: string, contentId: string): void }).close(sessionId, id, id)
}

/**
 * 拼接脚本执行命令行：`bash 'abs'`；runInScriptDir 前置 `cd 'dir' && `。
 * `options.dir` 显式指定 cd 目标——替换变量后的临时脚本副本仍要在**原脚本**
 * 目录里执行（相对路径的语义才不变），就靠它把 cd 与脚本路径解耦。
 */
export function buildScriptCommandline(absPath: string, options: { runInScriptDir?: boolean; dir?: string } = {}): string {
  const commandline = `bash ${shellQuote(absPath)}`
  if (options.runInScriptDir !== true) return commandline
  let dir = options.dir
  if (dir === undefined) {
    const cut = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
    dir = cut === -1 ? '.' : absPath.slice(0, cut)
  }
  return `cd ${shellQuote(dir)} && ${commandline}`
}

/** 跨平台 join：绝对 runDir 原样；否则拼到 cwd 下（统一 `/`，双斜杠折叠）。 */
export function joinRunDir(cwd: string, runDir: string): string {
  const trimmed = runDir.trim()
  if (trimmed === '') return cwd
  if (/^([A-Za-z]:)?[\\/]/.test(trimmed)) return trimmed.replace(/\\/g, '/')
  const base = cwd.replace(/[\\/]+$/, '')
  return `${base}/${trimmed.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

/** 拼接命令条目的命令行：runDir 非空前置 `cd 'join(cwd,runDir)' && `。 */
export function buildCommandCommandline(command: string, cwd: string | undefined, runDir: string | undefined): string {
  const dir = runDir !== undefined && runDir.trim() !== '' && cwd !== undefined && cwd !== ''
    ? joinRunDir(cwd, runDir)
    : undefined
  return dir === undefined ? command : `cd ${shellQuote(dir)} && ${command}`
}

/* ── 变量弹窗的「上次值」记忆（localStorage，按 sourceKey） ───────────── */

const CMD_VAR_PREFIX = 'dsh-better-sidebar:cmdvar:'

/** FNV-1a 短哈希（36 进制 + 长度后缀）：超长键/临时文件名的稳定缩写。 */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `h${(hash >>> 0).toString(36)}${input.length.toString(36)}`
}

/** sourceKey 超长（脚本绝对路径）哈希化——localStorage 键保持短而稳定。 */
function hashKey(sourceKey: string): string {
  return shortHash(sourceKey)
}

/** localStorage 的实际键（超长 sourceKey 自动哈希）。 */
export function cmdVarStorageKey(sourceKey: string): string {
  const key = sourceKey.length > 64 ? hashKey(sourceKey) : sourceKey
  return `${CMD_VAR_PREFIX}${key}`
}

/**
 * `.dsh/tmp/dsh-cmd-run-<hash>.sh`：替换变量后的脚本临时副本的**相对**落点
 * （fsWrite 按会话 cwd 解析相对路径；执行时用 {@link joinRunDir} 拼回绝对）。
 */
export function tempScriptRelPath(absPath: string): string {
  return `.dsh/tmp/dsh-cmd-run-${shortHash(absPath)}.sh`
}

/** 读一次「上次值」（脏 JSON / 非对象 → 空表）。 */
export function loadCmdVarValues(sourceKey: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(cmdVarStorageKey(sourceKey))
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 记一次「上次值」（配额满 / 隐私模式写失败静默——记忆是尽力而为的便利）。 */
export function saveCmdVarValues(sourceKey: string, values: Record<string, string>): void {
  try {
    localStorage.setItem(cmdVarStorageKey(sourceKey), JSON.stringify(values))
  } catch {
    // localStorage 不可用：不阻塞运行。
  }
}
