/**
 * 「命令」配置模型纯逻辑（src/commands-config.ts）。钉住：blob 容错解析
 * （非数组/坏行兜底、runInScriptDir 只认严格 true）、全局+工作区合并（工作区
 * 在前、id 冲突工作区赢）、两个 scope 的读取（`pluginSettings['commands']` 与
 * `pluginSettings['__project'][cwd]` 下 commands/commandRules）、upsert /
 * without / isValid / 新 id 形态。
 */
import { describe, expect, it } from 'vitest'
import {
  COMMANDS_PROJECT_COMMANDS_KEY,
  COMMANDS_PROJECT_RULES_KEY,
  COMMANDS_SETTINGS_ID,
  cmdRunTabIdOf,
  isValidCommand,
  isValidScriptRule,
  mergeCommandRows,
  mergeScriptRuleRows,
  newCommandsId,
  parseCommands,
  parseScriptRules,
  readGlobalCommands,
  readGlobalScriptRules,
  readWorkspaceCommands,
  readWorkspaceScriptRules,
  upsertCommand,
  upsertScriptRule,
  withoutCommand,
  withoutScriptRule,
  type CommandConfig,
  type ScriptRule,
} from '../src/commands-config.ts'
import { PROJECT_SETTINGS_KEY } from '../src/prefs-shared.ts'

function command(patch: Partial<CommandConfig>): CommandConfig {
  return { id: 'c1', name: 'Build', command: 'pnpm build', ...patch }
}

function rule(patch: Partial<ScriptRule>): ScriptRule {
  return { id: 'r1', name: 'Shell scripts', pattern: 'scripts/**/*.sh', runInScriptDir: false, ...patch }
}

describe('parseCommands / parseScriptRules（容错解析）', () => {
  it('非数组一律空表', () => {
    expect(parseCommands(undefined)).toEqual([])
    expect(parseCommands(null)).toEqual([])
    expect(parseCommands('nope')).toEqual([])
    expect(parseScriptRules({ id: 'r1' })).toEqual([])
  })

  it('坏行丢弃；缺字段行兜底（name/command 兜空串、group/runDir 缺席、runInScriptDir 只认严格 true）', () => {
    expect(parseCommands([null, 'nope', { no: 'id' }, { id: 'c1' }])).toEqual([
      { id: 'c1', name: '', command: '' },
    ])
    expect(parseCommands([
      { id: 'c2', name: 'B', command: 'echo hi', group: 'g', runDir: 'sub' },
      { id: 'c3', group: 42, runDir: '' },
    ])).toEqual([
      { id: 'c2', name: 'B', command: 'echo hi', group: 'g', runDir: 'sub' },
      { id: 'c3', name: '', command: '' },
    ])
    expect(parseScriptRules([null, { id: 'r1' }, { id: 'r2', runInScriptDir: 'yes' }, { id: 'r3', runInScriptDir: true }])).toEqual([
      { id: 'r1', name: '', pattern: '', runInScriptDir: false },
      { id: 'r2', name: '', pattern: '', runInScriptDir: false },
      { id: 'r3', name: '', pattern: '', runInScriptDir: true },
    ])
  })
})

describe('mergeCommandRows / mergeScriptRuleRows（工作区赢）', () => {
  it('工作区在前、全局在后、id 冲突工作区赢（带来源标注）', () => {
    const merged = mergeCommandRows(
      [command({ id: 'c1', name: 'G-Build' }), command({ id: 'c2', name: 'G-Only' })],
      [command({ id: 'c1', name: 'W-Build' }), command({ id: 'c3', name: 'W-Only' })],
    )
    expect(merged.map(row => `${row.item.id}:${row.item.name}:${row.source}`)).toEqual([
      'c1:W-Build:workspace',
      'c3:W-Only:workspace',
      'c2:G-Only:global',
    ])
  })

  it('规则合并同一语义', () => {
    const merged = mergeScriptRuleRows([rule({ id: 'r1', pattern: 'global/**' })], [rule({ id: 'r1', pattern: 'workspace/**' })])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.source).toBe('workspace')
    expect(merged[0]?.item.pattern).toBe('workspace/**')
  })
})

describe('两个 scope 的读取', () => {
  const pluginSettings = {
    [COMMANDS_SETTINGS_ID]: {
      commands: [command({ id: 'g1' })],
      rules: [rule({ id: 'gr1' })],
    },
    [PROJECT_SETTINGS_KEY]: {
      '/ws': {
        [COMMANDS_PROJECT_COMMANDS_KEY]: [command({ id: 'w1' })],
        [COMMANDS_PROJECT_RULES_KEY]: [rule({ id: 'wr1' })],
      },
    },
  }

  it('全局读 pluginSettings["commands"]，工作区读 pluginSettings["__project"][cwd]', () => {
    expect(readGlobalCommands(pluginSettings).map(row => row.id)).toEqual(['g1'])
    expect(readGlobalScriptRules(pluginSettings).map(row => row.id)).toEqual(['gr1'])
    expect(readWorkspaceCommands(pluginSettings, '/ws').map(row => row.id)).toEqual(['w1'])
    expect(readWorkspaceScriptRules(pluginSettings, '/ws').map(row => row.id)).toEqual(['wr1'])
    // cwd 缺席 / blob 形状脏：一律空表。
    expect(readWorkspaceCommands(pluginSettings, undefined)).toEqual([])
    expect(readWorkspaceCommands(pluginSettings, '')).toEqual([])
    expect(readWorkspaceCommands(undefined, '/ws')).toEqual([])
    expect(readGlobalCommands({ [COMMANDS_SETTINGS_ID]: 'nope' })).toEqual([])
  })
})

describe('upsert / without / isValid / id', () => {
  it('upsert 覆盖既有 id（保序）或追加到尾部', () => {
    const rows = [command({ id: 'a' }), command({ id: 'b' })]
    expect(upsertCommand(rows, command({ id: 'a', name: 'A2' })).map(row => row.id)).toEqual(['a', 'b'])
    expect(upsertCommand(rows, command({ id: 'a', name: 'A2' }))[0]?.name).toBe('A2')
    expect(upsertCommand(rows, command({ id: 'c', name: 'C' })).map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(upsertScriptRule([rule({ id: 'r1' })], rule({ id: 'r1', pattern: 'new/**' }))[0]?.pattern).toBe('new/**')
    expect(upsertScriptRule([], rule({})).map(row => row.id)).toEqual(['r1'])
  })

  it('without 按 id 移除', () => {
    const rows = [command({ id: 'a' }), command({ id: 'b' })]
    expect(withoutCommand(rows, 'a').map(row => row.id)).toEqual(['b'])
    expect(withoutCommand(rows, 'zz')).toHaveLength(2)
    expect(withoutScriptRule([rule({ id: 'r1' }), rule({ id: 'r2' })], 'r1').map(row => row.id)).toEqual(['r2'])
  })

  it('isValid：名称非空且命令/pattern 非空（trim 判定）', () => {
    expect(isValidCommand(command({}))).toBe(true)
    expect(isValidCommand(command({ name: '  ' }))).toBe(false)
    expect(isValidCommand(command({ command: ' ' }))).toBe(false)
    expect(isValidScriptRule(rule({}))).toBe(true)
    expect(isValidScriptRule(rule({ name: '' }))).toBe(false)
    expect(isValidScriptRule(rule({ pattern: '  ' }))).toBe(false)
  })

  it('新 id 唯一；cmd-run 的 tab id 前缀 cmd:', () => {
    const first = newCommandsId()
    const second = newCommandsId()
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThan(0)
    expect(cmdRunTabIdOf('abc')).toBe('cmd:abc')
  })
})
