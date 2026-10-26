/**
 * 「命令」变量系统纯逻辑（src/command-variables.ts）。钉住：token 语法
 * （`[[--dsh-- ... --dsh--]]` 容忍首尾空白）、内置目录（中文名 + 英文别名，
 * 大小写不敏感）、自定义声明（type 中文/英文别名、extra 默认值/选项、非法
 * 原样保留）、parseVariables 去重保序、substitute（含 unresolved、invalid
 * 保留）、shellQuote、token 构造器往返。
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_VARIABLES,
  builtinToken,
  customToken,
  dshTmpDirOf,
  parseVariables,
  resolveBuiltin,
  resolveBuiltinName,
  shellQuote,
  substitute,
  workspaceNameOf,
} from '../src/command-variables.ts'

const OPEN = '[[--dsh--'
const CLOSE = '--dsh--]]'

describe('parseVariables（识别）', () => {
  it('内置变量：规范中文名与英文别名等价，大小写不敏感，去重保序', () => {
    const parsed = parseVariables(`a ${OPEN} 工作区目录 ${CLOSE} b ${OPEN}cwd${CLOSE} ${OPEN} CWD ${CLOSE}`)
    expect(parsed.builtins).toEqual(['工作区目录'])
    expect(parsed.customs).toEqual([])
    expect(parsed.tokens).toHaveLength(3)
    expect(parsed.tokens.every(token => token.kind === 'builtin')).toBe(true)
  })

  it('自定义声明：中文 type + 英文别名 + extra 默认值/选项（选择第一项为默认）', () => {
    const parsed = parseVariables([
      `${OPEN}选择:env:目标环境:dev|prod${CLOSE}`,
      `${OPEN}输入:name:名字:robot${CLOSE}`,
      `${OPEN}number:count:数量${CLOSE}`,
      `${OPEN}textarea:notes:备注:hello${CLOSE}`,
      `${OPEN}text:env:环境${CLOSE}`,
    ].join(' '))
    expect(parsed.customs).toEqual([
      { key: 'env', type: 'select', label: '目标环境', options: ['dev', 'prod'] },
      { key: 'name', type: 'text', label: '名字', defaultValue: 'robot' },
      { key: 'count', type: 'number', label: '数量' },
      { key: 'notes', type: 'textarea', label: '备注', defaultValue: 'hello' },
    ])
    // 同 key 去重保序：第二个 env 声明不新增（第一个 select 赢）。
    expect(parsed.customs).toHaveLength(4)
    expect(parsed.builtins).toEqual([])
  })

  it('非法 body 原样保留（未知名、key/label 缺席），不进 builtins/customs', () => {
    const text = `${OPEN}不存在的变量${CLOSE} ${OPEN}输入:nokey${CLOSE} ${OPEN}输入::无label${CLOSE}`
    const parsed = parseVariables(text)
    expect(parsed.builtins).toEqual([])
    expect(parsed.customs).toEqual([])
    expect(parsed.tokens).toHaveLength(3)
    expect(parsed.tokens.every(token => token.kind === 'invalid')).toBe(true)
  })

  it('type 不认识按输入处理；空白容忍；无 token 时全空', () => {
    const parsed = parseVariables(`${OPEN} float:num:数字 ${CLOSE}`)
    expect(parsed.customs).toEqual([{ key: 'num', type: 'text', label: '数字' }])
    expect(parseVariables('plain text')).toEqual({ builtins: [], customs: [], tokens: [] })
  })

  it('内置目录覆盖计划要求的全部变量（类别齐全）', () => {
    const names = BUILTIN_VARIABLES.map(variable => variable.name)
    for (const name of ['工作区目录', '工作区名称', '会话ID', '当前日期', '当前时间', '日期时间', '时间戳(秒)', '时间戳(毫秒)', '年', '月', '日', '时', '分', '星期', '用户名', '主机名', '主目录', '系统临时目录', 'dsh临时目录', '随机数(6位数字)', '随机字符串(8位)', 'git分支', 'git提交(短sha)']) {
      expect(names, name).toContain(name)
    }
  })
})

describe('resolveBuiltin（运行时解析）', () => {
  const ctx = {
    cwd: '/ws/demo',
    sessionId: 's1',
    host: { username: 'aogg', hostname: 'box', homedir: '/home/aogg', tmpdir: '/tmp' },
    git: { branch: 'main', sha: 'f1bdb9b' },
  }

  it('ctx 类：cwd/session/host/git 直取；缺席空串', () => {
    expect(resolveBuiltin('工作区目录', ctx)).toBe('/ws/demo')
    expect(resolveBuiltin('workspaceName', ctx)).toBe('demo')
    expect(resolveBuiltin('会话ID', ctx)).toBe('s1')
    expect(resolveBuiltin('用户名', ctx)).toBe('aogg')
    expect(resolveBuiltin('主机名', ctx)).toBe('box')
    expect(resolveBuiltin('主目录', ctx)).toBe('/home/aogg')
    expect(resolveBuiltin('tmpDir', ctx)).toBe('/tmp')
    expect(resolveBuiltin('git分支', ctx)).toBe('main')
    expect(resolveBuiltin('branch', ctx)).toBe('main')
    expect(resolveBuiltin('git提交(短sha)', ctx)).toBe('f1bdb9b')
    expect(resolveBuiltin('git分支', {})).toBe('')
    expect(resolveBuiltin('用户名', {})).toBe('')
  })

  it('日期时间类本地生成（格式钉住）', () => {
    expect(resolveBuiltin('当前日期', ctx)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(resolveBuiltin('当前时间', ctx)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(resolveBuiltin('日期时间', ctx)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(resolveBuiltin('年', ctx)).toMatch(/^\d{4}$/)
    for (const name of ['月', '日', '时', '分']) expect(resolveBuiltin(name, ctx)).toMatch(/^\d{2}$/)
    expect(resolveBuiltin('星期', ctx)).toMatch(/^星期/)
    expect(Number(resolveBuiltin('时间戳(秒)', ctx))).toBeGreaterThan(1_700_000_000)
    expect(Number(resolveBuiltin('时间戳(毫秒)', ctx))).toBeGreaterThan(1_700_000_000_000)
  })

  it('随机类每次生新值；未知名空串', () => {
    expect(resolveBuiltin('随机数(6位数字)', ctx)).toMatch(/^\d{6}$/)
    expect(resolveBuiltin('随机字符串(8位)', ctx)).toMatch(/^[A-Za-z0-9]{8}$/)
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(() => resolveBuiltin('随机数(6位数字)', ctx)))
    expect(seen.size).toBeGreaterThan(1)
    expect(resolveBuiltin('不存在的变量', ctx)).toBe('')
  })

  it('工作区派生：workspaceNameOf / dshTmpDirOf（跨平台分隔符）', () => {
    expect(workspaceNameOf('/ws/demo/')).toBe('demo')
    expect(workspaceNameOf('C:\\ws\\demo')).toBe('demo')
    expect(workspaceNameOf(undefined)).toBe('')
    expect(dshTmpDirOf('/ws/demo')).toBe('/ws/demo/.dsh/tmp')
    expect(dshTmpDirOf(undefined)).toBe('')
    expect(resolveBuiltin('dsh临时目录', { cwd: '/ws' })).toBe('/ws/.dsh/tmp')
  })

  it('resolveBuiltinName：别名查表与未知名', () => {
    expect(resolveBuiltinName('CWD')?.name).toBe('工作区目录')
    expect(resolveBuiltinName(' 工作区目录 ')?.name).toBe('工作区目录')
    expect(resolveBuiltinName('nope')).toBeUndefined()
  })
})

describe('substitute（替换）', () => {
  const ctx = { cwd: '/ws', host: { username: 'u1' } }

  it('内置+自定义一起替换；自定义值缺席回落默认值（选择回落第一项）', () => {
    const text = `run ${OPEN} 工作区目录 ${CLOSE} --env ${OPEN}选择:env:环境:dev|prod${CLOSE} --user ${OPEN}输入:who:谁${CLOSE}`
    expect(substitute(text, ctx, { who: 'aogg' }).text).toBe('run /ws --env dev --user aogg')
    expect(substitute(text, ctx, { env: 'prod', who: 'x' }).text).toBe('run /ws --env prod --user x')
  })

  it('无值自定义 → 留空串并计入 unresolved（记 key）；invalid 原样保留', () => {
    const invalid = `${OPEN}不存在的变量${CLOSE}`
    const text = `${OPEN}输入:p:必填${CLOSE} ${invalid}`
    const result = substitute(text, ctx, {})
    // p 无值无默认 → 空串 + unresolved；invalid 原样留在结果里。
    expect(result.text).toBe(` ${invalid}`)
    expect(result.unresolved).toEqual(['p'])
    const roundtrip = substitute(invalid, ctx, {})
    expect(roundtrip.text).toBe(invalid)
    expect(roundtrip.unresolved).toEqual([])
  })

  it('values 里的空串视为缺席（回落默认值）', () => {
    const text = `${OPEN}输入:tag:标签:v1${CLOSE}`
    expect(substitute(text, ctx, { tag: '' }).text).toBe('v1')
    expect(substitute(text, ctx, { tag: 'v2' }).text).toBe('v2')
  })
})

describe('shellQuote / token 构造器', () => {
  it('单引号包裹，内部单引号按 POSIX 转义', () => {
    expect(shellQuote('/a b/deploy.sh')).toBe("'/a b/deploy.sh'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('')).toBe("''")
  })

  it('builtinToken / customToken 构造的文本可被 parseVariables 还原', () => {
    const text = `${builtinToken('工作区目录')} ${customToken({ key: 'env', type: 'select', label: '环境', options: ['dev', 'prod'] })} ${customToken({ key: 'n', type: 'number', label: '数量', defaultValue: '3' })}`
    const parsed = parseVariables(text)
    expect(parsed.builtins).toEqual(['工作区目录'])
    expect(parsed.customs).toEqual([
      { key: 'env', type: 'select', label: '环境', options: ['dev', 'prod'] },
      { key: 'n', type: 'number', label: '数量', defaultValue: '3' },
    ])
  })
})
