/**
 * 「命令」开始页配置的纯逻辑词汇表（风格对齐 webview-pages.ts）：
 * 单条命令（{@link CommandConfig}）与脚本规则（{@link ScriptRule}）、持久化
 * blob 的容错解析、全局与工作区两个 scope 的合并（工作区在前、id 冲突工作区
 * 赢——与 mergeWebviewPageRows 同一语义）、upsert / without / newId / isValid。
 *
 * 存储契约（v0.28.x）：
 * - 全局：`pluginSettings['commands']`（{@link COMMANDS_SETTINGS_ID}），命令
 *   列表键 `commands`（{@link COMMANDS_KEY}）、规则列表键 `rules`
 *   （{@link RULES_KEY}）；
 * - 工作区：`pluginSettings['__project'][<cwd>]` 下的 `commands`
 *   （{@link COMMANDS_PROJECT_COMMANDS_KEY}）与 `commandRules`
 *   （{@link COMMANDS_PROJECT_RULES_KEY}）。读写一律走 plugin-settings.ts
 *   的 updatePluginSettings / updateProjectSettings（同一条串行写队列）。
 */
import { PROJECT_SETTINGS_KEY } from './prefs-shared.ts'

/** 一条命令配置（持久化行；parse 容错后的形状）。 */
export interface CommandConfig {
  id: string
  /** 人读名称（保存时已 trim；parse 兜底 ''）。 */
  name: string
  /** 要执行的命令（允许多行——脚本片段）。 */
  command: string
  /** 分组名（空 = 「未分组」）。 */
  group?: string
  /** 运行目录（相对工作区；空 = 工作区根）。 */
  runDir?: string
}

/** 一条脚本规则（glob 深度匹配 → 按目录分组显示多个脚本）。 */
export interface ScriptRule {
  id: string
  /** 人读名称。 */
  name: string
  /**
   * 匹配规则：相对工作区（`scripts/` + `**` + `/*.sh`，双星杠写法见
   * glob-match.ts）或绝对路径（`/a/b/` + `**` + `/*.sh`）。
   * 语法见 glob-match.ts（`**` 跨任意段含零段；`*`/`?` 段内）。
   */
  pattern: string
  /** 分组名（空 = 「未分组」）。 */
  group?: string
  /** true = 在脚本所在目录执行（命令行前置 `cd <dir> &&`）。 */
  runInScriptDir: boolean
}

/** 一条配置的归属 scope。 */
export type CommandsScope = 'global' | 'workspace'

/** 全局 blob 的 descriptor id：`pluginSettings['commands']`。 */
export const COMMANDS_SETTINGS_ID = 'commands'

/** 全局 blob 里命令列表的键。 */
export const COMMANDS_KEY = 'commands'

/** 全局 blob 里脚本规则列表的键。 */
export const RULES_KEY = 'rules'

/** 工作区 blob 里命令列表的键。 */
export const COMMANDS_PROJECT_COMMANDS_KEY = 'commands'

/** 工作区 blob 里脚本规则列表的键。 */
export const COMMANDS_PROJECT_RULES_KEY = 'commandRules'

/** 「命令」配置页的内置类型 id（single 单实例页）。 */
export const COMMANDS_TAB_TYPE = 'commands'

/** 命令执行 tab 的内置类型 id（hidden，createTab 每次铸新 tab）。 */
export const CMD_RUN_TAB_TYPE = 'cmd-run'

/** 执行 tab 的 id 契约前缀：`cmd:<uuid>`（不设 dedupeKey——每次点击都是新 tab）。 */
export function cmdRunTabIdOf(uuid: string): string {
  return `cmd:${uuid}`
}

/** 一条新 id（uuid 优先，无 crypto 环境退化为时间+随机后缀）。 */
export function newCommandsId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** 命令的保存校验：名称非空且命令非空。 */
export function isValidCommand(command: CommandConfig): boolean {
  return command.name.trim() !== '' && command.command.trim() !== ''
}

/** 脚本规则的保存校验：名称非空且 pattern 非空。 */
export function isValidScriptRule(rule: ScriptRule): boolean {
  return rule.name.trim() !== '' && rule.pattern.trim() !== ''
}

/** 单行的结构准入线：id 必须是非空字符串（其余字段缺席兜底，半坏行尽量保住）。 */
function isRowWithId(value: unknown): value is { id: string } & Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
}

/** 可选字符串字段的容错读取（非串 → 缺席）。 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 解析持久化的命令列表（容错）：非数组返回空表；行缺字段兜底空串/缺席。
 */
export function parseCommands(raw: unknown): CommandConfig[] {
  if (!Array.isArray(raw)) return []
  const commands: CommandConfig[] = []
  for (const row of raw) {
    if (!isRowWithId(row)) continue
    const group = optionalString(row.group)
    const runDir = optionalString(row.runDir)
    commands.push({
      id: row.id,
      name: typeof row.name === 'string' ? row.name : '',
      command: typeof row.command === 'string' ? row.command : '',
      ...(group !== undefined ? { group } : {}),
      ...(runDir !== undefined ? { runDir } : {}),
    })
  }
  return commands
}

/**
 * 解析持久化的脚本规则列表（容错）：runInScriptDir 只认严格 true（缺省 false
 * = 在工作区根执行）。
 */
export function parseScriptRules(raw: unknown): ScriptRule[] {
  if (!Array.isArray(raw)) return []
  const rules: ScriptRule[] = []
  for (const row of raw) {
    if (!isRowWithId(row)) continue
    const group = optionalString(row.group)
    rules.push({
      id: row.id,
      name: typeof row.name === 'string' ? row.name : '',
      pattern: typeof row.pattern === 'string' ? row.pattern : '',
      ...(group !== undefined ? { group } : {}),
      runInScriptDir: row.runInScriptDir === true,
    })
  }
  return rules
}

/** 带来源标注的合并行（配置页列表用）：工作区在前、全局在后、id 冲突工作区赢。 */
export interface ScopedRow<T> {
  item: T
  source: CommandsScope
}

/** 合并两个 scope 的同名行表：工作区在前、全局在后、id 冲突工作区赢。 */
function mergeScopedRows<T extends { id: string }>(globalItems: readonly T[], workspaceItems: readonly T[]): ScopedRow<T>[] {
  const workspaceIds = new Set(workspaceItems.map(item => item.id))
  return [
    ...workspaceItems.map(item => ({ item, source: 'workspace' as const })),
    ...globalItems.filter(item => !workspaceIds.has(item.id)).map(item => ({ item, source: 'global' as const })),
  ]
}

/** 合并两份命令列表：工作区在前、全局在后、id 冲突工作区赢。 */
export function mergeCommandRows(globalItems: readonly CommandConfig[], workspaceItems: readonly CommandConfig[]): ScopedRow<CommandConfig>[] {
  return mergeScopedRows(globalItems, workspaceItems)
}

/** 合并两份脚本规则列表：同一语义（工作区在前、冲突工作区赢）。 */
export function mergeScriptRuleRows(globalItems: readonly ScriptRule[], workspaceItems: readonly ScriptRule[]): ScopedRow<ScriptRule>[] {
  return mergeScopedRows(globalItems, workspaceItems)
}

/** 读全局 scope 的命令列表（`pluginSettings['commands'].commands`）。 */
export function readGlobalCommands(pluginSettings: Record<string, unknown> | undefined): CommandConfig[] {
  const blob = pluginSettings?.[COMMANDS_SETTINGS_ID]
  if (blob === null || typeof blob !== 'object') return []
  return parseCommands((blob as Record<string, unknown>)[COMMANDS_KEY])
}

/** 读全局 scope 的脚本规则列表（`pluginSettings['commands'].rules`）。 */
export function readGlobalScriptRules(pluginSettings: Record<string, unknown> | undefined): ScriptRule[] {
  const blob = pluginSettings?.[COMMANDS_SETTINGS_ID]
  if (blob === null || typeof blob !== 'object') return []
  return parseScriptRules((blob as Record<string, unknown>)[RULES_KEY])
}

/** 读工作区 blob（cwd 缺席/空串一律空表——没有工作区就没有项目 scope 可言）。 */
function workspaceBlob(pluginSettings: Record<string, unknown> | undefined, cwd: string | undefined): Record<string, unknown> | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const map = pluginSettings?.[PROJECT_SETTINGS_KEY]
  if (map === null || typeof map !== 'object') return undefined
  const blob = (map as Record<string, unknown>)[cwd]
  return blob !== null && typeof blob === 'object' ? blob as Record<string, unknown> : undefined
}

/** 读工作区 scope 的命令列表（`pluginSettings['__project'][cwd].commands`）。 */
export function readWorkspaceCommands(pluginSettings: Record<string, unknown> | undefined, cwd: string | undefined): CommandConfig[] {
  return parseCommands(workspaceBlob(pluginSettings, cwd)?.[COMMANDS_PROJECT_COMMANDS_KEY])
}

/** 读工作区 scope 的脚本规则列表（`pluginSettings['__project'][cwd].commandRules`）。 */
export function readWorkspaceScriptRules(pluginSettings: Record<string, unknown> | undefined, cwd: string | undefined): ScriptRule[] {
  return parseScriptRules(workspaceBlob(pluginSettings, cwd)?.[COMMANDS_PROJECT_RULES_KEY])
}

/** 按 id 覆盖或追加一条命令（保持列表序）。 */
export function upsertCommand(commands: readonly CommandConfig[], command: CommandConfig): CommandConfig[] {
  const at = commands.findIndex(candidate => candidate.id === command.id)
  if (at === -1) return [...commands, command]
  return commands.map(candidate => candidate.id === command.id ? command : candidate)
}

/** 按 id 移除一条命令。 */
export function withoutCommand(commands: readonly CommandConfig[], id: string): CommandConfig[] {
  return commands.filter(command => command.id !== id)
}

/** 按 id 覆盖或追加一条脚本规则。 */
export function upsertScriptRule(rules: readonly ScriptRule[], rule: ScriptRule): ScriptRule[] {
  const at = rules.findIndex(candidate => candidate.id === rule.id)
  if (at === -1) return [...rules, rule]
  return rules.map(candidate => candidate.id === rule.id ? rule : candidate)
}

/** 按 id 移除一条脚本规则。 */
export function withoutScriptRule(rules: readonly ScriptRule[], id: string): ScriptRule[] {
  return rules.filter(rule => rule.id !== id)
}
