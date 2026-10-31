/**
 * 「命令」配置页（type: 'commands'，单实例，hero 胶囊的落点；形制抄
 * WebviewPagesSettings）：「全局 + 当前工作区」合并后的命令与脚本规则列表 +
 * 新增/编辑表单 + 变量工具栏 + 变量弹窗，运行铸 cmd-run 执行 tab。
 *
 * 数据面：
 * - 列表 = mergeCommandRows / mergeScriptRuleRows（工作区在前、id 冲突工作区
 *   赢），每行带来源徽章；读取全部来自 store 的 prefs 快照
 *   （useSyncExternalStore），任何一次写回（含别的窗口）都会实时反映。
 * - 写入走 plugin-settings.ts 的同一条串行写队列：全局 blob
 *   `pluginSettings['commands']`（commands/rules 两键），工作区 blob
 *   `pluginSettings['__project'][cwd]` 下 commands / commandRules。改范围 =
 *   两次入队（先删原 scope 再写新 scope，队列保证顺序）。
 * - 脚本扫描走 commands.scanScripts 路由（src/commands-scan.ts 执行体）：规则
 *   列表签名（id+pattern）变化即整批重扫；每条规则的行内刷新只带该规则。
 * - 脚本卡的徽标（变量/交互数）需要脚本内容：fsRead 后用与命令文本同一套
 *   parseVariables / scanInteractionPoints 解析，按 `abs|mtime` 记忆——内容
 *   变了才重读。
 *
 * 运行流程（命令与脚本同一套变量语义）：
 * 1. parseVariables(原文)——命令文本或 .sh 内容；有自定义变量先弹变量弹窗
 *    （按类型渲染控件、记忆上次值、内置变量值只读展示可复制）。
 * 2. substitute(原文, ctx, values)：内置按 ctx 自动解析；命令条目把替换结果
 *   直接拼进命令行；脚本条目替换发生在**内容**上——内容真的变过才把替换后的
 *   副本写进 `<cwd>/.dsh/tmp/dsh-cmd-run-<hash>.sh`（fsWrite）并运行副本
 *   （cd 语义仍指向原脚本目录，相对路径不变）；内容没变/写失败一律退回运行
 *   原文件。
 * 3. mint：parkCmdRun 紧贴 openTab({ type: 'cmd-run' })——一次性 seed 的
 *   hand-off（webview-open.ts 同形）；宿主终端服务缺席时运行按钮禁用并提示。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { globToMatcher } from '../glob-match.ts'
import { scanInteractionPoints, type InteractionPoint } from '../command-interaction.ts'
import {
  BUILTIN_VARIABLES,
  builtinToken,
  customToken,
  parseVariables,
  resolveBuiltin,
  substitute,
  type CustomVarDecl,
  type CustomVarType,
  type ParsedVariables,
  type VariableCategory,
  type VariableContext,
} from '../command-variables.ts'
import {
  CMD_RUN_TAB_TYPE,
  COMMANDS_PROJECT_COMMANDS_KEY,
  COMMANDS_PROJECT_RULES_KEY,
  COMMANDS_SETTINGS_ID,
  isValidCommand,
  isValidScriptRule,
  mergeCommandRows,
  mergeScriptRuleRows,
  newCommandsId,
  parseCommands,
  parseScriptRules,
  upsertCommand,
  upsertScriptRule,
  withoutCommand,
  withoutScriptRule,
  type CommandConfig,
  type CommandsScope,
  type ScriptRule,
} from '../commands-config.ts'
import type { Context } from '../context-types.ts'
import type { SessionScope, ScriptMatchRow } from './api.ts'
import { api } from './api.ts'
import type { SidebarStore } from './state.ts'
import { updatePluginSettings, updateProjectSettings } from './plugin-settings.ts'
import { t } from './locales.ts'
import { openSidebarFile } from './sidebar-file.ts'
import { webTerminals } from './terminal-client.ts'
import {
  buildCommandCommandline,
  buildScriptCommandline,
  joinRunDir,
  loadCmdVarValues,
  parkCmdRun,
  saveCmdVarValues,
  tempScriptRelPath,
} from './commands-open.ts'
import { CommandHistoryView } from './CommandHistoryView.tsx'
import css from './commands.module.css'

/** openTab 服务里本页真正用到的最小面（minimal mock 友好）。 */
interface CommandsOpenService {
  isTabEnabled(id: string): boolean
  openTab(seed: { type: string; title?: string }): void
}

/** 探测 ctx 上的服务（minimal mock / 服务缺席 → undefined，运行动作静默跳过）。 */
function serviceOf(ctx: Context): CommandsOpenService | undefined {
  try {
    const service = ctx.get('betterSidebar') as CommandsOpenService | undefined
    return typeof service?.openTab === 'function' && typeof service?.isTabEnabled === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/** 表单草稿（字段保持用户输入原样，保存时才 trim+校验）。 */
interface CommandDraft {
  name: string
  group: string
  command: string
  runDir: string
  scope: CommandsScope
}

/** 规则表单草稿。 */
interface RuleDraft {
  name: string
  pattern: string
  group: string
  scope: CommandsScope
}

/** 自定义变量小表单草稿（工具栏「自定义变量」按钮展开）。 */
interface CustomVarDraft {
  type: CustomVarType
  key: string
  label: string
  defaultValue: string
  options: string
}

const EMPTY_COMMAND_DRAFT: CommandDraft = { name: '', group: '', command: '', runDir: '', scope: 'global' }
const EMPTY_RULE_DRAFT: RuleDraft = { name: '', pattern: '', group: '', scope: 'global' }
const EMPTY_CUSTOM_DRAFT: CustomVarDraft = { type: 'text', key: '', label: '', defaultValue: '', options: '' }

/** 编辑中的目标：undefined = 列表态。 */
interface Editing {
  kind: 'command' | 'rule'
  id: string | 'new'
}

/** 一次待运行的请求（弹窗态）；finishRun 消费它铸执行 tab。 */
interface RunRequest {
  kind: 'command' | 'script'
  title: string
  sourceKey: string
  /** 待替换原文：命令文本或脚本内容。 */
  raw: string
  parsed: ParsedVariables
  /** 静态交互预扫（随 seed 交给执行 tab 的 chips）。 */
  points: InteractionPoint[]
  /** script 专有：目标与 cd 语义。 */
  script?: { abs: string; dir: string; runInScriptDir: boolean }
  /** command 专有：运行目录。 */
  command?: { runDir?: string }
}

/** 一条规则的扫描态（scans state 的行）。 */
interface RuleScanState {
  matches: ScriptMatchRow[]
  error?: string
  truncated?: boolean
}

/** 一个脚本卡解析出的徽标（unreadable = 内容读不到/超大，不展示徽标）。 */
interface ScriptBadges {
  vars: number
  interactions: number
}

/** 脚本徽标的内容读取上限：超过就当不可读（徽标省略，运行不受影响）。 */
const SCRIPT_BADGE_MAX_BYTES = 256_000

/** 内置变量目录的工具栏分组顺序（分组名即目录的 category，是 token 语法的一部分）。 */
const VARIABLE_CATEGORIES: readonly VariableCategory[] = ['工作区', '会话', '日期时间', '系统', 'git', '随机']

/** 中文 type → 变量弹窗控件与目录一致的四值（自定义小表单的选项）。 */
const CUSTOM_TYPES: readonly { value: CustomVarType; key: 'commandsVarTypeInput' | 'commandsVarTypeTextarea' | 'commandsVarTypeNumber' | 'commandsVarTypeSelect' }[] = [
  { value: 'text', key: 'commandsVarTypeInput' },
  { value: 'textarea', key: 'commandsVarTypeTextarea' },
  { value: 'number', key: 'commandsVarTypeNumber' },
  { value: 'select', key: 'commandsVarTypeSelect' },
]

/**
 * 在多行输入框光标处插入 token（受控值 + 下一帧恢复光标）。el 缺席（SSR/
 * 测试）退化为追加。
 */
function insertAtCursor(el: HTMLTextAreaElement | null, current: string, token: string, set: (value: string) => void): void {
  const start = el?.selectionStart ?? current.length
  const end = el?.selectionEnd ?? start
  set(`${current.slice(0, start)}${token}${current.slice(Math.max(end, start))}`)
  if (el === null) return
  const at = start + token.length
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(at, at)
  })
}

/** 目录的展示路径：cwd 之下显示相对（短），否则原样。 */
function displayPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[\\/]+$/, '')
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized === base) return '.'
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : path
}

export function CommandsPageView(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
}): ReactNode {
  const { ctx, store, scope } = props
  const cwd = scope.cwd
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  )
  const pluginSettings = snapshot.prefs.pluginSettings

  const commandRows = useMemo(() => mergeCommandRows(
    parseCommands((pluginSettings[COMMANDS_SETTINGS_ID] as Record<string, unknown> | undefined)?.commands),
    parseCommands(workspaceBlobOf(pluginSettings, cwd)?.[COMMANDS_PROJECT_COMMANDS_KEY]),
  ), [pluginSettings, cwd])
  const ruleRows = useMemo(() => mergeScriptRuleRows(
    parseScriptRules((pluginSettings[COMMANDS_SETTINGS_ID] as Record<string, unknown> | undefined)?.rules),
    parseScriptRules(workspaceBlobOf(pluginSettings, cwd)?.[COMMANDS_PROJECT_RULES_KEY]),
  ), [pluginSettings, cwd])

  // ── 页内 tab（「命令」/「执行历史」；本地态，不持久化） ────────────────
  const [activeTab, setActiveTab] = useState<'commands' | 'history'>('commands')

  // ── 表单/删除态 ─────────────────────────────────────────────────────
  const [editing, setEditing] = useState<Editing | undefined>(undefined)
  const [commandDraft, setCommandDraft] = useState<CommandDraft>(EMPTY_COMMAND_DRAFT)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE_DRAFT)
  const [customDraft, setCustomDraft] = useState<CustomVarDraft>(EMPTY_CUSTOM_DRAFT)
  const [customFormOpen, setCustomFormOpen] = useState(false)
  const [attempted, setAttempted] = useState(false)
  // 两段式删除确认：armed 的行再点一次才真的删（前缀区分命令行与脚本卡）。
  const [armed, setArmed] = useState<string | undefined>(undefined)

  // ── 运行态（变量弹窗） ──────────────────────────────────────────────
  const [runRequest, setRunRequest] = useState<RunRequest | undefined>(undefined)
  const [runValues, setRunValues] = useState<Record<string, string>>({})
  const [varCtx, setVarCtx] = useState<VariableContext>({})

  // ── 脚本扫描与徽标 ──────────────────────────────────────────────────
  const [scans, setScans] = useState<Record<string, RuleScanState>>({})
  const [scanning, setScanning] = useState(false)
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const badgeCache = useRef(new Map<string, ScriptBadges | null>())
  const [, setBadgesVersion] = useState(0)
  const commandInputRef = useRef<HTMLTextAreaElement | null>(null)

  const canRun = useMemo(() => {
    if (webTerminals(ctx) === undefined) return false
    return serviceOf(ctx)?.isTabEnabled(CMD_RUN_TAB_TYPE) === true
  }, [ctx])

  /** 把一份列表写进指定 scope 的 blob（同一条串行队列，天然防丢写）。 */
  const writeScope = useCallback((target: CommandsScope, updater: (blob: Record<string, unknown>) => Record<string, unknown>): void => {
    if (target === 'workspace') {
      updateProjectSettings(store, cwd, blob => updater(blob))
      return
    }
    updatePluginSettings(store, COMMANDS_SETTINGS_ID, blob => updater(blob))
  }, [store, cwd])

  const writeCommands = useCallback((target: CommandsScope, updater: (rows: CommandConfig[]) => CommandConfig[]): void => {
    writeScope(target, blob => ({
      ...blob,
      [COMMANDS_PROJECT_COMMANDS_KEY]: updater(parseCommands(blob[COMMANDS_PROJECT_COMMANDS_KEY])),
    }))
  }, [writeScope])

  const writeRules = useCallback((target: CommandsScope, updater: (rows: ScriptRule[]) => ScriptRule[]): void => {
    writeScope(target, blob => ({
      ...blob,
      [COMMANDS_PROJECT_RULES_KEY]: updater(parseScriptRules(blob[COMMANDS_PROJECT_RULES_KEY])),
    }))
  }, [writeScope])

  /** 整批（或单条）扫描规则；一条规则的失败在行内带回，不拖累其余。 */
  const scanRules = useCallback(async (rules: readonly ScriptRule[]): Promise<void> => {
    if (rules.length === 0) return
    setScanning(true)
    try {
      const view = await api.commandsScanScripts(scope, rules.map(rule => ({ id: rule.id, pattern: rule.pattern })))
      setScans(current => {
        const next = { ...current }
        for (const scan of view.scans) {
          next[scan.id] = {
            matches: scan.matches,
            ...(scan.error !== undefined ? { error: scan.error } : {}),
            ...(scan.truncated === true ? { truncated: true } : {}),
          }
        }
        return next
      })
    } catch {
      // 服务失败（会话缺席等）：保留旧扫描态，行内空态仍然可用。
    } finally {
      setScanning(false)
    }
  }, [scope])

  // 规则列表签名（id+pattern）变化即整批重扫（首次挂载也走这里）。
  const ruleSignature = ruleRows.map(row => `${row.item.id}:${row.item.pattern}`).join('|')
  const scannedSignature = useRef('')
  useEffect(() => {
    if (ruleSignature === scannedSignature.current) return
    scannedSignature.current = ruleSignature
    if (ruleRows.length === 0) return
    void scanRules(ruleRows.map(row => row.item))
  }, [ruleSignature, ruleRows, scanRules])

  /** 读齐脚本内容并解析徽标（`abs|mtime` 记忆；并发去重靠先占位）。 */
  const ensureBadges = useCallback(async (matches: readonly ScriptMatchRow[]): Promise<void> => {
    let changed = false
    for (const match of matches) {
      const key = `${match.abs}|${match.mtime}`
      if (badgeCache.current.has(key)) continue
      changed = true
      if (match.size > SCRIPT_BADGE_MAX_BYTES) {
        badgeCache.current.set(key, null)
        continue
      }
      badgeCache.current.set(key, null)
      try {
        const result = await api.fsRead(scope, match.abs)
        const text = result.kind === 'text' ? result.content : ''
        const parsed = parseVariables(text)
        badgeCache.current.set(key, {
          vars: parsed.builtins.length + parsed.customs.length,
          interactions: scanInteractionPoints(text).length,
        })
      } catch {
        badgeCache.current.set(key, null)
      }
    }
    if (changed) setBadgesVersion(version => version + 1)
  }, [scope])

  // 展开的规则才读内容做徽标（折叠的规则不产生 fsRead 流量）。
  useEffect(() => {
    const pending = [...expandedRules].flatMap(id => scans[id]?.matches ?? [])
    if (pending.length > 0) void ensureBadges(pending)
  }, [expandedRules, scans, ensureBadges])

  // 弹窗打开后拉 host/git 类内置变量的取值（服务端各有短缓存；缺席留空）。
  useEffect(() => {
    if (runRequest === undefined) return
    let live = true
    api.commandsEnvInfo().then(env => {
      if (live) setVarCtx(current => ({ ...current, host: env }))
    }).catch(() => {})
    api.commandsGitInfo(scope).then(git => {
      if (live) setVarCtx(current => ({ ...current, git }))
    }).catch(() => {})
    return () => { live = false }
  }, [runRequest, scope])

  /** 变量解析的当前上下文（cwd/sessionId 即取即用，host/git 用已拉取的）。 */
  const contextNow = useCallback((): VariableContext => ({
    ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
    sessionId: scope.sessionId,
    ...(varCtx.host !== undefined ? { host: varCtx.host } : {}),
    ...(varCtx.git !== undefined ? { git: varCtx.git } : {}),
  }), [cwd, scope.sessionId, varCtx])

  /** mint 执行 tab：park 紧贴 openTab（一次性 seed；被拒的 open 不留残留）。 */
  const mintRun = useCallback((request: { title: string; commandline: string; sourceKey: string; points: InteractionPoint[] }): void => {
    const service = serviceOf(ctx)
    if (service === undefined || !service.isTabEnabled(CMD_RUN_TAB_TYPE)) return
    parkCmdRun({
      title: request.title,
      commandline: request.commandline,
      sourceKey: request.sourceKey,
      ...(request.points.length > 0 ? { interactionPoints: request.points } : {}),
    })
    service.openTab({ type: CMD_RUN_TAB_TYPE, title: request.title })
  }, [ctx])

  /** 弹窗的「运行」：substitute → 铸 tab（脚本按需落临时副本）。 */
  const finishRun = useCallback(async (request: RunRequest, values: Record<string, string>): Promise<void> => {
    saveCmdVarValues(request.sourceKey, values)
    setRunRequest(undefined)
    const context = contextNow()
    if (request.kind === 'command') {
      const { text } = substitute(request.raw, context, values)
      mintRun({
        title: request.title,
        commandline: buildCommandCommandline(text, cwd, request.command?.runDir),
        sourceKey: request.sourceKey,
        points: request.points,
      })
      return
    }
    const script = request.script
    if (script === undefined) return
    const { text } = substitute(request.raw, context, values)
    // 内容没被替换（无 token）或没有工作区可落副本：直接运行原文件。
    if (cwd === undefined || cwd === '' || text === request.raw) {
      mintRun({
        title: request.title,
        commandline: buildScriptCommandline(script.abs, { runInScriptDir: script.runInScriptDir }),
        sourceKey: request.sourceKey,
        points: request.points,
      })
      return
    }
    // 替换后的副本写进 .dsh/tmp（写失败退回原文件——变量留给脚本自己面对）。
    try {
      const tempRel = tempScriptRelPath(script.abs)
      await api.fsWrite(scope, tempRel, text)
      mintRun({
        title: request.title,
        commandline: buildScriptCommandline(joinRunDir(cwd, tempRel), {
          runInScriptDir: script.runInScriptDir,
          dir: script.dir,
        }),
        sourceKey: request.sourceKey,
        points: request.points,
      })
    } catch {
      mintRun({
        title: request.title,
        commandline: buildScriptCommandline(script.abs, { runInScriptDir: script.runInScriptDir }),
        sourceKey: request.sourceKey,
        points: request.points,
      })
    }
  }, [contextNow, cwd, mintRun, scope])

  /** 运行一条命令：有自定义变量先弹窗，否则直接铸。 */
  const runCommand = useCallback((command: CommandConfig): void => {
    if (!canRun) return
    const parsed = parseVariables(command.command)
    const request: RunRequest = {
      kind: 'command',
      title: command.name,
      sourceKey: `command:${command.id}`,
      raw: command.command,
      parsed,
      points: scanInteractionPoints(command.command),
      command: { runDir: command.runDir },
    }
    if (parsed.customs.length > 0) {
      setRunValues(loadCmdVarValues(request.sourceKey))
      setVarCtx({})
      setRunRequest(request)
      return
    }
    void finishRun(request, {})
  }, [canRun, finishRun])

  /** 运行一个脚本卡：现读内容（徽标缓存只存计数）→ 同一变量语义。 */
  const runScript = useCallback((match: ScriptMatchRow, rule: ScriptRule): void => {
    if (!canRun) return
    const proceed = (text: string | undefined): void => {
      const request: RunRequest = {
        kind: 'script',
        title: match.name,
        sourceKey: `script:${match.abs}`,
        // 内容读不到 / 超大：raw 留空 → finishRun 原样运行原文件。
        raw: text ?? '',
        parsed: text === undefined ? { builtins: [], customs: [], tokens: [] } : parseVariables(text),
        points: text === undefined ? [] : scanInteractionPoints(text),
        script: { abs: match.abs, dir: match.dir, runInScriptDir: rule.runInScriptDir },
      }
      if (request.parsed.customs.length > 0) {
        setRunValues(loadCmdVarValues(request.sourceKey))
        setVarCtx({})
        setRunRequest(request)
        return
      }
      void finishRun(request, {})
    }
    void (match.size > SCRIPT_BADGE_MAX_BYTES
      ? Promise.resolve<string | undefined>(undefined)
      : api.fsRead(scope, match.abs).then(result => result.kind === 'text' ? result.content : undefined).catch(() => undefined))
      .then(proceed)
  }, [canRun, finishRun, scope])

  // ── 表单动作 ────────────────────────────────────────────────────────

  const startNewCommand = (): void => {
    setCommandDraft(EMPTY_COMMAND_DRAFT)
    setCustomFormOpen(false)
    setCustomDraft(EMPTY_CUSTOM_DRAFT)
    setAttempted(false)
    setArmed(undefined)
    setEditing({ kind: 'command', id: 'new' })
  }

  const startNewRule = (): void => {
    setRuleDraft(EMPTY_RULE_DRAFT)
    setAttempted(false)
    setArmed(undefined)
    setEditing({ kind: 'rule', id: 'new' })
  }

  const startEditCommand = (command: CommandConfig, source: CommandsScope): void => {
    setCommandDraft({
      name: command.name,
      group: command.group ?? '',
      command: command.command,
      runDir: command.runDir ?? '',
      scope: source,
    })
    setCustomFormOpen(false)
    setCustomDraft(EMPTY_CUSTOM_DRAFT)
    setAttempted(false)
    setArmed(undefined)
    setEditing({ kind: 'command', id: command.id })
  }

  const startEditRule = (rule: ScriptRule, source: CommandsScope): void => {
    setRuleDraft({
      name: rule.name,
      pattern: rule.pattern,
      group: rule.group ?? '',
      scope: source,
    })
    setAttempted(false)
    setArmed(undefined)
    setEditing({ kind: 'rule', id: rule.id })
  }

  const cancelEdit = (): void => {
    setEditing(undefined)
    setCommandDraft(EMPTY_COMMAND_DRAFT)
    setRuleDraft(EMPTY_RULE_DRAFT)
    setCustomFormOpen(false)
    setAttempted(false)
  }

  const workspaceAvailable = cwd !== undefined && cwd !== ''
  const commandDraftValid = isValidCommand({
    id: 'draft',
    name: commandDraft.name,
    command: commandDraft.command,
  })
  const patternValid = globToMatcher(ruleDraft.pattern.trim()) !== undefined
  const ruleDraftValid = isValidScriptRule({
    id: 'draft',
    name: ruleDraft.name,
    pattern: ruleDraft.pattern,
    runInScriptDir: false,
  }) && patternValid

  const saveCommand = (): void => {
    setAttempted(true)
    if (!commandDraftValid) return
    const previous = editing?.kind === 'command' && editing.id !== 'new'
      ? commandRows.find(row => row.item.id === editing.id)?.source
      : undefined
    const record: CommandConfig = {
      id: editing !== undefined && editing.id !== 'new' ? editing.id : newCommandsId(),
      name: commandDraft.name.trim(),
      command: commandDraft.command,
      ...(commandDraft.group.trim() !== '' ? { group: commandDraft.group.trim() } : {}),
      ...(commandDraft.runDir.trim() !== '' ? { runDir: commandDraft.runDir.trim() } : {}),
    }
    // 工作区落点在 cwd 消失时静默拒收：落回原 scope（无原 scope 则全局）。
    const target: CommandsScope = commandDraft.scope === 'workspace' && !workspaceAvailable
      ? (previous ?? 'global')
      : commandDraft.scope
    if (previous === undefined || previous === target) {
      writeCommands(target, rows => upsertCommand(rows, record))
    } else {
      writeCommands(previous, rows => withoutCommand(rows, record.id))
      writeCommands(target, rows => upsertCommand(rows, record))
    }
    cancelEdit()
  }

  const saveRule = (): void => {
    setAttempted(true)
    if (!ruleDraftValid) return
    const previous = editing?.kind === 'rule' && editing.id !== 'new'
      ? ruleRows.find(row => row.item.id === editing.id)?.source
      : undefined
    const record: ScriptRule = {
      id: editing !== undefined && editing.id !== 'new' ? editing.id : newCommandsId(),
      name: ruleDraft.name.trim(),
      pattern: ruleDraft.pattern.trim(),
      ...(ruleDraft.group.trim() !== '' ? { group: ruleDraft.group.trim() } : {}),
      runInScriptDir: false,
    }
    const target: CommandsScope = ruleDraft.scope === 'workspace' && !workspaceAvailable
      ? (previous ?? 'global')
      : ruleDraft.scope
    if (previous === undefined || previous === target) {
      writeRules(target, rows => upsertScriptRule(rows, record))
    } else {
      writeRules(previous, rows => withoutScriptRule(rows, record.id))
      writeRules(target, rows => upsertScriptRule(rows, record))
    }
    cancelEdit()
  }

  const removeCommand = (row: { item: CommandConfig; source: CommandsScope }): void => {
    const key = `command:${row.item.id}`
    if (armed !== key) {
      setArmed(key)
      return
    }
    setArmed(undefined)
    writeCommands(row.source, rows => withoutCommand(rows, row.item.id))
    if (editing?.kind === 'command' && editing.id === row.item.id) cancelEdit()
  }

  const removeRule = (row: { item: ScriptRule; source: CommandsScope }): void => {
    const key = `rule:${row.item.id}`
    if (armed !== key) {
      setArmed(key)
      return
    }
    setArmed(undefined)
    writeRules(row.source, rows => withoutScriptRule(rows, row.item.id))
    setScans(current => {
      const next = { ...current }
      delete next[row.item.id]
      return next
    })
    if (editing?.kind === 'rule' && editing.id === row.item.id) cancelEdit()
  }

  /** 插入自定义变量 token（小表单校验通过才可用）。 */
  const insertCustomToken = (): void => {
    const key = customDraft.key.trim()
    const label = customDraft.label.trim()
    if (key === '' || label === '') return
    const decl: CustomVarDecl = customDraft.type === 'select'
      ? {
          key,
          type: 'select',
          label,
          ...(customDraft.options.trim() !== ''
            ? { options: customDraft.options.split('|').map(option => option.trim()).filter(option => option !== '') }
            : {}),
        }
      : {
          key,
          type: customDraft.type,
          label,
          ...(customDraft.defaultValue !== '' ? { defaultValue: customDraft.defaultValue } : {}),
        }
    insertAtCursor(commandInputRef.current, commandDraft.command, customToken(decl), value => {
      setCommandDraft(current => ({ ...current, command: value }))
    })
    setCustomFormOpen(false)
    setCustomDraft(EMPTY_CUSTOM_DRAFT)
  }

  /** 弹窗里内置变量 chip 的当前值（点击复制）。 */
  const builtinValueOf = (name: string): string => resolveBuiltin(name, contextNow())

  const copyText = (text: string): void => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }

  /* ── 渲染 ────────────────────────────────────────────────────────── */

  // const 捕获：下面的 JSX 闭包里使用时 TS 的 undefined 收窄仍然成立。
  const activeRequest = runRequest

  if (editing !== undefined) {
    return (
      <div className={css.view} data-dsh-commands-settings="">
        {editing.kind === 'command' ? (
          <form className={css.form} onSubmit={(event) => { event.preventDefault(); saveCommand() }}>
            <div className={css.head}>
              <span className={css.headTitle}>{editing.id === 'new' ? t('commandsNewCommand') : t('commandsEditCommand')}</span>
              <button type="button" className={css.iconButton} aria-label={t('close')} onClick={cancelEdit}>
                <IconCloseOutlineRegular size={14} />
              </button>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldName')}</span>
              <input
                className={css.input}
                value={commandDraft.name}
                placeholder={t('commandsFieldNamePlaceholder')}
                spellCheck={false}
                onChange={(event) => { setCommandDraft({ ...commandDraft, name: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldGroup')}</span>
              <input
                className={css.input}
                value={commandDraft.group}
                placeholder={t('commandsFieldGroupPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setCommandDraft({ ...commandDraft, group: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldCommand')}</span>
              <textarea
                ref={commandInputRef}
                className={`${css.input} ${css.inputTall}`}
                value={commandDraft.command}
                placeholder={t('commandsFieldCommandPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setCommandDraft({ ...commandDraft, command: event.target.value }) }}
              />
            </label>
            {/* 变量工具栏：内置 chips（按 category 分组）+ 自定义变量小表单 +
                当前命令文本实时识别出的变量 chips（只读）。 */}
            <div className={css.varToolbar} data-dsh-cmd-var-toolbar="">
              <div className={css.varToolbarHead}>
                <span className={css.fieldLabel}>{t('commandsDetectedVars')}</span>
              </div>
              {(() => {
                const parsed = parseVariables(commandDraft.command)
                if (parsed.tokens.length === 0) {
                  return <div className={css.varChipRow}><span className={css.hint}>{t('commandsNoVars')}</span></div>
                }
                return (
                  <div className={css.varChipRow}>
                    {parsed.tokens.map((token, index) => (
                      <span key={`${index}:${token.body}`} className={css.varChipReadOnly} title={token.kind}>{token.body}</span>
                    ))}
                  </div>
                )
              })()}
              <div className={css.varGroups}>
                {VARIABLE_CATEGORIES.map(category => (
                  <div key={category} className={css.varGroup}>
                    <span className={css.varGroupLabel}>{category}</span>
                    <div className={css.varChipRow}>
                      {BUILTIN_VARIABLES.filter(variable => variable.category === category).map(variable => (
                        <button
                          key={variable.name}
                          type="button"
                          className={css.varChip}
                          title={variable.describe}
                          onClick={() => {
                            insertAtCursor(commandInputRef.current, commandDraft.command, builtinToken(variable.name), value => {
                              setCommandDraft(current => ({ ...current, command: value }))
                            })
                          }}
                        >
                          {variable.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className={css.varToolbarActions}>
                <button type="button" className={css.ghostButton} onClick={() => { setCustomFormOpen(open => !open) }}>
                  {t('commandsCustomVarAdd')}
                </button>
              </div>
              {customFormOpen && (
                <div className={css.customForm} data-dsh-cmd-custom-form="">
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('commandsVarType')}</span>
                    <select
                      className={css.input}
                      value={customDraft.type}
                      onChange={(event) => { setCustomDraft({ ...customDraft, type: event.target.value as CustomVarType }) }}
                    >
                      {CUSTOM_TYPES.map(option => (
                        <option key={option.value} value={option.value}>{t(option.key)}</option>
                      ))}
                    </select>
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('commandsVarKey')}</span>
                    <input
                      className={css.input}
                      value={customDraft.key}
                      placeholder={t('commandsVarKeyPlaceholder')}
                      spellCheck={false}
                      onChange={(event) => { setCustomDraft({ ...customDraft, key: event.target.value }) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('commandsVarLabel')}</span>
                    <input
                      className={css.input}
                      value={customDraft.label}
                      placeholder={t('commandsVarLabelPlaceholder')}
                      spellCheck={false}
                      onChange={(event) => { setCustomDraft({ ...customDraft, label: event.target.value }) }}
                    />
                  </label>
                  {customDraft.type === 'select' ? (
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('commandsVarOptions')}</span>
                      <input
                        className={css.input}
                        value={customDraft.options}
                        placeholder="dev|prod"
                        spellCheck={false}
                        onChange={(event) => { setCustomDraft({ ...customDraft, options: event.target.value }) }}
                      />
                    </label>
                  ) : (
                    <label className={css.field}>
                      <span className={css.fieldLabel}>{t('commandsVarDefault')}</span>
                      <input
                        className={css.input}
                        value={customDraft.defaultValue}
                        onChange={(event) => { setCustomDraft({ ...customDraft, defaultValue: event.target.value }) }}
                      />
                    </label>
                  )}
                  <div className={css.formActions}>
                    <button
                      type="button"
                      className={css.ghostButton}
                      disabled={customDraft.key.trim() === '' || customDraft.label.trim() === ''}
                      onClick={insertCustomToken}
                    >
                      {t('commandsVarInsert')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldRunDir')}</span>
              <input
                className={css.input}
                value={commandDraft.runDir}
                placeholder={t('commandsFieldRunDirPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setCommandDraft({ ...commandDraft, runDir: event.target.value }) }}
              />
            </label>
            <ScopeField
              label={t('commandsFieldScope')}
              value={commandDraft.scope}
              workspaceAvailable={workspaceAvailable}
              onSelect={(value) => { setCommandDraft({ ...commandDraft, scope: value }) }}
            />
            {attempted && !commandDraftValid && (
              <div className={`${css.hint} ${css.hintInvalid}`} role="alert">{t('commandsCommandInvalidHint')}</div>
            )}
            <div className={css.formActions}>
              <button type="button" className={css.ghostButton} onClick={cancelEdit}>{t('cancel')}</button>
              <button type="submit" className={css.ghostButton} disabled={attempted && !commandDraftValid}>{t('save')}</button>
            </div>
          </form>
        ) : (
          <form className={css.form} onSubmit={(event) => { event.preventDefault(); saveRule() }}>
            <div className={css.head}>
              <span className={css.headTitle}>{editing.id === 'new' ? t('commandsNewRule') : t('commandsEditRule')}</span>
              <button type="button" className={css.iconButton} aria-label={t('close')} onClick={cancelEdit}>
                <IconCloseOutlineRegular size={14} />
              </button>
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldName')}</span>
              <input
                className={css.input}
                value={ruleDraft.name}
                placeholder={t('commandsFieldNamePlaceholder')}
                spellCheck={false}
                onChange={(event) => { setRuleDraft({ ...ruleDraft, name: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldPattern')}</span>
              <input
                className={css.input}
                value={ruleDraft.pattern}
                placeholder={t('commandsFieldPatternPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setRuleDraft({ ...ruleDraft, pattern: event.target.value }) }}
              />
            </label>
            {ruleDraft.pattern.trim() !== '' && !patternValid && (
              <div className={`${css.hint} ${css.hintInvalid}`} role="alert">{t('commandsRuleInvalidHint')}</div>
            )}
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('commandsFieldGroup')}</span>
              <input
                className={css.input}
                value={ruleDraft.group}
                placeholder={t('commandsFieldGroupPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setRuleDraft({ ...ruleDraft, group: event.target.value }) }}
              />
            </label>
            <ScopeField
              label={t('commandsFieldScope')}
              value={ruleDraft.scope}
              workspaceAvailable={workspaceAvailable}
              onSelect={(value) => { setRuleDraft({ ...ruleDraft, scope: value }) }}
            />
            {attempted && !ruleDraftValid && (
              <div className={`${css.hint} ${css.hintInvalid}`} role="alert">{t('commandsRuleInvalidHint')}</div>
            )}
            <div className={css.formActions}>
              <button type="button" className={css.ghostButton} onClick={cancelEdit}>{t('cancel')}</button>
              <button type="submit" className={css.ghostButton} disabled={attempted && !ruleDraftValid}>{t('save')}</button>
            </div>
          </form>
        )}
      </div>
    )
  }

  // 命令按 group 折叠分组（无 group 归「未分组」；组头可收起）。
  const grouped = new Map<string, typeof commandRows>()
  for (const row of commandRows) {
    const key = row.item.group ?? ''
    const bucket = grouped.get(key) ?? []
    bucket.push(row)
    grouped.set(key, bucket)
  }
  const groupKeys = [...grouped.keys()]

  return (
    <div className={css.view} data-dsh-commands-settings="">
      <div className={css.head}>
        <span className={css.headTitle}>{t('commandsPage')}</span>
        <span className={css.headActions}>
          <button type="button" className={css.ghostButton} onClick={startNewCommand}>{t('commandsNewCommand')}</button>
          <button type="button" className={css.ghostButton} onClick={startNewRule}>{t('commandsNewRule')}</button>
          <button
            type="button"
            className={css.ghostButton}
            disabled={scanning || ruleRows.length === 0}
            onClick={() => { void scanRules(ruleRows.map(row => row.item)) }}
          >
            {t('commandsRefreshScripts')}
          </button>
        </span>
      </div>
      {/* 页内双 tab 行（segmented 同形制；本地态，不持久化）：「命令」是既有
          全部内容，「执行历史」是 CommandHistoryView。 */}
      <div className={css.segmented} role="tablist" aria-label={t('commandsPage')} data-dsh-cmd-tabs="">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'commands'}
          className={[css.segButton, activeTab === 'commands' ? css.segButtonActive : ''].filter(Boolean).join(' ')}
          onClick={() => { setActiveTab('commands') }}
        >
          {t('commandsPage')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
          className={[css.segButton, activeTab === 'history' ? css.segButtonActive : ''].filter(Boolean).join(' ')}
          onClick={() => { setActiveTab('history') }}
        >
          {t('commandsHistoryTab')}
        </button>
      </div>
      {activeTab === 'history' ? (
        <CommandHistoryView ctx={ctx} store={store} scope={scope} />
      ) : (
        <>
      {commandRows.length === 0 && ruleRows.length === 0 && (
        <div className={css.empty}>{t('commandsEmpty')}</div>
      )}

      {commandRows.length > 0 && (
        <div className={css.section}>
          <div className={css.sectionTitle}>{t('commandsSectionCommands')}</div>
          {groupKeys.map(groupKey => {
            const rows = grouped.get(groupKey) ?? []
            const collapsed = collapsedGroups.has(groupKey)
            return (
              <div key={groupKey} className={css.group} data-dsh-cmd-group={groupKey}>
                <button
                  type="button"
                  className={css.groupHead}
                  aria-expanded={!collapsed}
                  onClick={() => {
                    setCollapsedGroups(current => {
                      const next = new Set(current)
                      if (next.has(groupKey)) next.delete(groupKey)
                      else next.add(groupKey)
                      return next
                    })
                  }}
                >
                  <span className={css.groupChevron}>{collapsed ? '▸' : '▾'}</span>
                  <span className={css.groupName}>{groupKey === '' ? t('commandsUngrouped') : groupKey}</span>
                  <span className={css.groupCount}>{rows.length}</span>
                </button>
                {!collapsed && rows.map(row => {
                  const parsed = parseVariables(row.item.command)
                  const points = scanInteractionPoints(row.item.command)
                  const deleteArmed = armed === `command:${row.item.id}`
                  return (
                    <div key={row.item.id} className={css.row} data-dsh-cmd-row={row.source}>
                      <button
                        type="button"
                        className={css.rowMain}
                        title={row.item.command}
                        onClick={() => { startEditCommand(row.item, row.source) }}
                      >
                        <span className={css.rowText}>
                          <span className={css.rowNameLine}>
                            <span className={css.rowName}>{row.item.name}</span>
                            <span className={css.badge}>
                              {row.source === 'workspace' ? t('commandsScopeWorkspace') : t('commandsScopeGlobal')}
                            </span>
                            {parsed.builtins.length + parsed.customs.length > 0 && (
                              <span className={css.badge}>{t('commandsBadgeVars', { count: parsed.builtins.length + parsed.customs.length })}</span>
                            )}
                            {points.length > 0 && (
                              <span className={`${css.badge} ${css.badgeWarn}`}>{t('commandsBadgeInteractions', { count: points.length })}</span>
                            )}
                          </span>
                          <span className={css.rowSub}>{firstLineOf(row.item.command)}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('commandsRun')}
                        title={canRun ? t('commandsRun') : t('commandsRunUnavailable')}
                        disabled={!canRun}
                        onClick={() => { runCommand(row.item) }}
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('edit')}
                        title={t('edit')}
                        onClick={() => { startEditCommand(row.item, row.source) }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={`${css.iconButton} ${deleteArmed ? css.iconButtonArmed : ''}`}
                        aria-label={deleteArmed ? t('commandsDeleteConfirm') : t('delete')}
                        title={deleteArmed ? t('commandsDeleteConfirm') : t('delete')}
                        onClick={() => { removeCommand(row) }}
                        onBlur={() => { if (armed === `command:${row.item.id}`) setArmed(undefined) }}
                      >
                        {deleteArmed ? '!' : <IconCloseOutlineRegular size={14} />}
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {ruleRows.length > 0 && (
        <div className={css.section}>
          <div className={css.sectionTitle}>{t('commandsSectionRules')}</div>
          {ruleRows.map(row => {
            const scan = scans[row.item.id]
            const expanded = expandedRules.has(row.item.id)
            const deleteArmed = armed === `rule:${row.item.id}`
            const groups = groupMatchesByDir(scan?.matches ?? [])
            return (
              <div key={row.item.id} className={css.ruleBlock} data-dsh-rule-row={row.source}>
                <div className={css.row}>
                  <button
                    type="button"
                    className={css.rowMain}
                    onClick={() => {
                      setExpandedRules(current => {
                        const next = new Set(current)
                        if (next.has(row.item.id)) next.delete(row.item.id)
                        else next.add(row.item.id)
                        return next
                      })
                    }}
                  >
                    <span className={css.rowText}>
                      <span className={css.rowNameLine}>
                        <span className={css.groupChevron}>{expanded ? '▾' : '▸'}</span>
                        <span className={css.rowName}>{row.item.name}</span>
                        <span className={css.badge}>
                          {row.source === 'workspace' ? t('commandsScopeWorkspace') : t('commandsScopeGlobal')}
                        </span>
                        {scan !== undefined && scan.error === undefined && (
                          <span className={css.badge}>
                            {scan.matches.length === 0 ? t('commandsNoMatches') : t('commandsMatches', { count: scan.matches.length })}
                          </span>
                        )}
                        {scan?.truncated === true && <span className={css.badge}>{t('commandsTruncated')}</span>}
                      </span>
                      <span className={css.rowSub}>{row.item.pattern}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('commandsRefreshScripts')}
                    title={t('commandsRefreshScripts')}
                    disabled={scanning}
                    onClick={() => { void scanRules([row.item]) }}
                  >
                    ⟳
                  </button>
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('edit')}
                    title={t('edit')}
                    onClick={() => { startEditRule(row.item, row.source) }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={`${css.iconButton} ${deleteArmed ? css.iconButtonArmed : ''}`}
                    aria-label={deleteArmed ? t('commandsDeleteConfirm') : t('delete')}
                    title={deleteArmed ? t('commandsDeleteConfirm') : t('delete')}
                    onClick={() => { removeRule(row) }}
                    onBlur={() => { if (armed === `rule:${row.item.id}`) setArmed(undefined) }}
                  >
                    {deleteArmed ? '!' : <IconCloseOutlineRegular size={14} />}
                  </button>
                </div>
                {expanded && (
                  <div className={css.ruleBody}>
                    {scan === undefined && <div className={css.hint}>{t('loading')}</div>}
                    {scan?.error !== undefined && (
                      <div className={`${css.hint} ${css.hintInvalid}`} role="alert">{t('commandsRuleError', { message: scan.error })}</div>
                    )}
                    {scan !== undefined && scan.error === undefined && scan.matches.length === 0 && (
                      <div className={css.hint}>{t('commandsNoMatches')}</div>
                    )}
                    {[...groups.entries()].map(([dir, matches]) => (
                      <div key={dir} className={css.scriptDir}>
                        <div className={css.scriptDirHead} title={dir}>{displayPath(dir, cwd)}</div>
                        {matches.map(match => {
                          const badges = badgeCache.current.get(`${match.abs}|${match.mtime}`) ?? undefined
                          return (
                            <div key={match.abs} className={css.scriptCard} data-dsh-script-card="">
                              <span className={css.rowText}>
                                <span className={css.rowNameLine}>
                                  <span className={css.rowName}>{match.name}</span>
                                  {badges !== undefined && badges.vars > 0 && (
                                    <span className={css.badge}>{t('commandsBadgeVars', { count: badges.vars })}</span>
                                  )}
                                  {badges !== undefined && badges.interactions > 0 && (
                                    <span className={`${css.badge} ${css.badgeWarn}`}>{t('commandsBadgeInteractions', { count: badges.interactions })}</span>
                                  )}
                                </span>
                                <span className={css.rowSub}>{displayPath(match.dir, cwd)}/{match.name}</span>
                              </span>
                              <button
                                type="button"
                                className={css.iconButton}
                                aria-label={t('commandsRun')}
                                title={canRun ? t('commandsRun') : t('commandsRunUnavailable')}
                                disabled={!canRun}
                                onClick={() => { runScript(match, row.item) }}
                              >
                                ▶
                              </button>
                              <button
                                type="button"
                                className={css.iconButton}
                                aria-label={t('commandsEditScript')}
                                title={t('commandsEditScript')}
                                onClick={() => { openSidebarFile(ctx, scope.sessionId, match.abs) }}
                              >
                                ✎
                              </button>
                              <button
                                type="button"
                                className={css.iconButton}
                                aria-label={t('commandsCopyPath')}
                                title={t('commandsCopyPath')}
                                onClick={() => { copyText(match.abs) }}
                              >
                                ⧉
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {!canRun && <div className={css.hint}>{t('commandsRunUnavailable')}</div>}
      {!workspaceAvailable && <div className={css.hint}>{t('commandsScopeWorkspaceUnavailable')}</div>}
        </>
      )}

      {activeRequest !== undefined && (
        <div className={css.modalBackdrop} data-dsh-cmd-modal="">
          <div className={css.modal} role="dialog" aria-modal="true" aria-label={t('commandsModalTitle')}>
            <div className={css.head}>
              <span className={css.headTitle}>{t('commandsModalTitle')}</span>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('close')}
                onClick={() => { setRunRequest(undefined) }}
              >
                <IconCloseOutlineRegular size={14} />
              </button>
            </div>
            {activeRequest.parsed.builtins.length > 0 && (
              <div className={css.field}>
                <span className={css.fieldLabel}>{t('commandsModalBuiltins')}</span>
                <div className={css.varChipRow}>
                  {activeRequest.parsed.builtins.map(name => {
                    const value = builtinValueOf(name)
                    return (
                      <button
                        key={name}
                        type="button"
                        className={css.varChipReadOnly}
                        title={value}
                        onClick={() => { copyText(value) }}
                      >
                        {name}={value === '' ? '—' : value}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {activeRequest.parsed.customs.map(decl => (
              <label key={decl.key} className={css.field}>
                <span className={css.fieldLabel}>{decl.label}</span>
                {decl.type === 'textarea' ? (
                  <textarea
                    className={`${css.input} ${css.inputTall}`}
                    value={runValues[decl.key] ?? decl.defaultValue ?? ''}
                    onChange={(event) => { setRunValues(current => ({ ...current, [decl.key]: event.target.value })) }}
                  />
                ) : decl.type === 'select' ? (
                  <select
                    className={css.input}
                    value={runValues[decl.key] ?? decl.defaultValue ?? decl.options?.[0] ?? ''}
                    onChange={(event) => { setRunValues(current => ({ ...current, [decl.key]: event.target.value })) }}
                  >
                    {(decl.options ?? []).map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={css.input}
                    type={decl.type === 'number' ? 'number' : 'text'}
                    value={runValues[decl.key] ?? decl.defaultValue ?? ''}
                    onChange={(event) => { setRunValues(current => ({ ...current, [decl.key]: event.target.value })) }}
                  />
                )}
              </label>
            ))}
            <div className={css.formActions}>
              <button type="button" className={css.ghostButton} onClick={() => { setRunRequest(undefined) }}>{t('cancel')}</button>
              <button type="button" className={css.ghostButton} onClick={() => { void finishRun(activeRequest, runValues) }}>
                {t('commandsRun')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 工作区 blob（cwd 缺席 → undefined）。 */
function workspaceBlobOf(pluginSettings: Record<string, unknown>, cwd: string | undefined): Record<string, unknown> | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const map = pluginSettings.__project
  if (map === null || typeof map !== 'object') return undefined
  const blob = (map as Record<string, unknown>)[cwd]
  return blob !== null && typeof blob === 'object' ? blob as Record<string, unknown> : undefined
}

/** 命令预览的首行（单行截断由 CSS 负责，这里只取第一行非空行）。 */
function firstLineOf(command: string): string {
  for (const line of command.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 脚本按父目录分组（保持扫描结果的目录序）。 */
function groupMatchesByDir(matches: readonly ScriptMatchRow[]): Map<string, ScriptMatchRow[]> {
  const groups = new Map<string, ScriptMatchRow[]>()
  for (const match of matches) {
    const bucket = groups.get(match.dir) ?? []
    bucket.push(match)
    groups.set(match.dir, bucket)
  }
  return groups
}

/** 表单的范围分段选择（无工作区时工作区项禁用）。 */
function ScopeField(props: {
  label: string
  value: CommandsScope
  workspaceAvailable: boolean
  onSelect: (value: CommandsScope) => void
}): ReactNode {
  const { label, value, workspaceAvailable, onSelect } = props
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <div className={css.segmented} role="radiogroup" aria-label={label}>
        {([
          ['global', t('commandsScopeGlobal'), true],
          ['workspace', t('commandsScopeWorkspace'), workspaceAvailable],
        ] as const).map(([scopeValue, scopeLabel, enabled]) => (
          <button
            key={scopeValue}
            type="button"
            role="radio"
            aria-checked={value === scopeValue}
            disabled={!enabled}
            title={enabled ? undefined : t('commandsScopeWorkspaceUnavailable')}
            className={[
              css.segButton,
              value === scopeValue ? css.segButtonActive : '',
              enabled ? '' : css.segButtonDisabled,
            ].filter(Boolean).join(' ')}
            onClick={() => { if (enabled) onSelect(scopeValue) }}
          >
            {scopeLabel}
          </button>
        ))}
      </div>
    </div>
  )
}
