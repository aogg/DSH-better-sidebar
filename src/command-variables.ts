/**
 * 「命令」开始页的变量系统（核心纯逻辑，无 DOM / 无 api / 无 node import）。
 *
 * 语法：`[[--dsh-- <body> --dsh--]]`（容忍首尾空白）。body 两种：
 * 1. 内置变量名（{@link BUILTIN_VARIABLES} 的规范中文名或英文别名）→ 运行时
 *    自动解析（{@link resolveBuiltin}）；
 * 2. 自定义变量声明 `<type>:<key>:<label>[:<extra>]`，type ∈
 *    `输入|多行|数字|选择`（英文别名 text/textarea/number/select）。
 *    extra：输入/数字/多行=默认值；选择=`选项1|选项2|…`（第一项为默认）。
 *    type 不认识 → 按输入处理；格式不合法（key/label 缺席）→ 原样保留不替换。
 *
 * 命令输入框与 .sh 脚本内容共用同一套解析（{@link parseVariables}），所以
 * 「命令文本识别出的变量」与「脚本识别出的变量」永远一致。
 */

/** 变量 token 的定界符（两侧各出现一次，语法锚）。 */
const TOKEN_OPEN = '[[--dsh--'
const TOKEN_CLOSE = '--dsh--]]'

/** 全局 token 匹配：容忍 body 首尾空白；body 内不允许再出现闭合锚。 */
const TOKEN_RE = /\[\[--dsh--\s*([\s\S]*?)\s*--dsh--\]\]/g

/** 内置变量的分组（变量工具栏按此分组展示）。 */
export type VariableCategory = '工作区' | '会话' | '日期时间' | '系统' | 'git' | '随机'

/** 一个内置变量目录条目。 */
export interface BuiltinVariable {
  /** 中文规范名（token body 即此名；也是工具栏 chips 的展示文案）。 */
  name: string
  /** 英文别名（解析时与规范名等价；大小写不敏感）。 */
  aliases: readonly string[]
  category: VariableCategory
  /** 一句话说明（chips 的 title）。 */
  describe: string
}

/**
 * 内置变量目录。运行时解析见 {@link resolveBuiltin}；日期时间类本地生成，
 * host/git 类取自 {@link VariableContext}，缺席解析为空串。
 */
export const BUILTIN_VARIABLES: readonly BuiltinVariable[] = [
  { name: '工作区目录', aliases: ['cwd', 'workspace', 'workspaceDir'], category: '工作区', describe: '会话工作区的绝对路径' },
  { name: '工作区名称', aliases: ['workspaceName'], category: '工作区', describe: '工作区目录的最后一段名称' },
  { name: 'dsh临时目录', aliases: ['dshTmpDir'], category: '工作区', describe: '<工作区目录>/.dsh/tmp（不存在时命令侧自行 mkdir -p）' },
  { name: '会话ID', aliases: ['sessionId'], category: '会话', describe: '当前会话的 id' },
  { name: '当前日期', aliases: ['date'], category: '日期时间', describe: 'YYYY-MM-DD（本地时区）' },
  { name: '当前时间', aliases: ['time'], category: '日期时间', describe: 'HH:mm:ss（本地时区）' },
  { name: '日期时间', aliases: ['datetime'], category: '日期时间', describe: 'YYYY-MM-DD HH:mm:ss（本地时区）' },
  { name: '时间戳(秒)', aliases: ['timestamp', 'timestampSec'], category: '日期时间', describe: 'Unix 秒级时间戳' },
  { name: '时间戳(毫秒)', aliases: ['timestampMs'], category: '日期时间', describe: 'Unix 毫秒级时间戳' },
  { name: '年', aliases: ['year'], category: '日期时间', describe: '四位年份' },
  { name: '月', aliases: ['month'], category: '日期时间', describe: '两位月份（01–12）' },
  { name: '日', aliases: ['day'], category: '日期时间', describe: '两位日期（01–31）' },
  { name: '时', aliases: ['hour'], category: '日期时间', describe: '两位小时（00–23）' },
  { name: '分', aliases: ['minute'], category: '日期时间', describe: '两位分钟（00–59）' },
  { name: '星期', aliases: ['weekday'], category: '日期时间', describe: '中文星期（星期日…星期六）' },
  { name: '用户名', aliases: ['username', 'user'], category: '系统', describe: '操作系统当前用户名' },
  { name: '主机名', aliases: ['hostname', 'host'], category: '系统', describe: '操作系统主机名' },
  { name: '主目录', aliases: ['homedir', 'home'], category: '系统', describe: '当前用户主目录' },
  { name: '系统临时目录', aliases: ['tmpdir', 'tmpDir', 'tempDir'], category: '系统', describe: '操作系统临时目录' },
  { name: '随机数(6位数字)', aliases: ['random', 'randomNumber'], category: '随机', describe: '每次解析重新生成的 6 位数字' },
  { name: '随机字符串(8位)', aliases: ['randomString'], category: '随机', describe: '每次解析重新生成的 8 位字母数字' },
  { name: 'git分支', aliases: ['gitBranch', 'branch'], category: 'git', describe: '工作区当前 git 分支' },
  { name: 'git提交(短sha)', aliases: ['gitSha', 'commit'], category: 'git', describe: '工作区当前 HEAD 短提交哈希' },
]

/** 规范名 → 目录条目（resolveBuiltin 的查表）。 */
const BUILTIN_BY_NAME = new Map<string, BuiltinVariable>()
for (const variable of BUILTIN_VARIABLES) {
  BUILTIN_BY_NAME.set(variable.name.toLowerCase(), variable)
  for (const alias of variable.aliases) BUILTIN_BY_NAME.set(alias.toLowerCase(), variable)
}

/** 自定义变量的控件类型（弹窗按此渲染对应控件）。 */
export type CustomVarType = 'text' | 'textarea' | 'number' | 'select'

/** 一个自定义变量声明（token 里解析出的形状）。 */
export interface CustomVarDecl {
  key: string
  type: CustomVarType
  label: string
  /** 输入/多行/数字的默认值；选择类型没有此项（默认值是 options[0]）。 */
  defaultValue?: string
  /** 选择类型的选项（第一项为默认）。 */
  options?: readonly string[]
}

/** 内置变量的解析上下文（缺席字段解析为空串）。 */
export interface VariableContext {
  cwd?: string
  sessionId?: string
  host?: { username?: string; hostname?: string; homedir?: string; tmpdir?: string }
  git?: { branch?: string; sha?: string }
}

/** 一个 token 的解析结果（parseVariables 的 tokens 行）。 */
export interface VariableToken {
  /** 原样全文（含定界符）——substitute 原位替换用。 */
  raw: string
  /** 去除首尾空白后的 body。 */
  body: string
  kind: 'builtin' | 'custom' | 'invalid'
  /** kind='builtin'：解析出的内置目录条目；未知名仍是 'invalid'。 */
  builtin?: BuiltinVariable
  /** kind='custom'：解析出的声明；kind='invalid' 时缺席。 */
  custom?: CustomVarDecl
}

export interface ParsedVariables {
  /** 内置变量名（规范中文形态，去重保序）。 */
  builtins: string[]
  /** 自定义变量声明（按 key 去重保序）。 */
  customs: CustomVarDecl[]
  /** 全部 token（含 invalid——substitute 原样保留它们）。 */
  tokens: VariableToken[]
}

/** 中文 type → 控件类型。 */
const TYPE_BY_CN: Record<string, CustomVarType> = { 输入: 'text', 多行: 'textarea', 数字: 'number', 选择: 'select' }

/** 英文别名 → 控件类型（小写比较）。 */
const TYPE_BY_EN: Record<string, CustomVarType> = { text: 'text', input: 'text', textarea: 'textarea', number: 'number', select: 'select' }

/** 控件类型 → 中文规范名（customToken 构造回中文形态的 token）。 */
const CN_BY_TYPE: Record<CustomVarType, string> = { text: '输入', textarea: '多行', number: '数字', select: '选择' }

/**
 * 解析一个自定义变量声明的 body（已 split 出 type 段之外的部分）。
 * 返回 undefined = 格式不合法（key/label 缺席），调用方按 invalid 保留原样。
 */
function parseCustomDecl(typePart: string, rest: string[]): CustomVarDecl | undefined {
  const key = (rest[0] ?? '').trim()
  const label = (rest[1] ?? '').trim()
  if (key === '' || label === '') return undefined
  // type 不认识 → 按输入处理（计划约定）；type 段本身大小写混排只对英文别名宽松。
  const type = TYPE_BY_CN[typePart] ?? TYPE_BY_EN[typePart.trim().toLowerCase()] ?? 'text'
  const extra = rest.slice(2).join(':')
  if (type === 'select') {
    const options = extra.split('|').map(option => option.trim()).filter(option => option !== '')
    if (options.length === 0) return { key, type, label }
    return { key, type, label, options }
  }
  return extra === '' ? { key, type, label } : { key, type, label, defaultValue: extra }
}

/**
 * 解析文本里的全部变量 token（命令输入框与 .sh 脚本内容共用）。
 * 同一文本里同名内置变量/同 key 自定义变量去重保序；invalid token 只进
 * tokens（原样保留），不进 builtins/customs。
 */
export function parseVariables(text: string): ParsedVariables {
  const builtins: string[] = []
  const customs: CustomVarDecl[] = []
  const customKeys = new Set<string>()
  const tokens: VariableToken[] = []
  TOKEN_RE.lastIndex = 0
  for (let match = TOKEN_RE.exec(text); match !== null; match = TOKEN_RE.exec(text)) {
    const raw = match[0]
    const body = match[1]?.trim() ?? ''
    const colonAt = body.indexOf(':')
    if (colonAt === -1) {
      const builtin = BUILTIN_BY_NAME.get(body.toLowerCase())
      if (builtin !== undefined) {
        if (!builtins.includes(builtin.name)) builtins.push(builtin.name)
        tokens.push({ raw, body, kind: 'builtin', builtin })
      } else {
        tokens.push({ raw, body, kind: 'invalid' })
      }
      continue
    }
    const decl = parseCustomDecl(body.slice(0, colonAt), body.slice(colonAt + 1).split(':'))
    if (decl === undefined) {
      tokens.push({ raw, body, kind: 'invalid' })
      continue
    }
    if (!customKeys.has(decl.key)) {
      customKeys.add(decl.key)
      customs.push(decl)
    }
    tokens.push({ raw, body, kind: 'custom', custom: decl })
  }
  return { builtins, customs, tokens }
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时区的 YYYY-MM-DD。 */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** 本地时区的 HH:mm:ss。 */
function localTime(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/** 工作区目录的最后一段（跨平台分隔符都认）。 */
export function workspaceNameOf(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/** `<cwd>/.dsh/tmp`（cwd 缺席 → 空串）。 */
export function dshTmpDirOf(cwd: string | undefined): string {
  return cwd === undefined || cwd === '' ? '' : `${cwd.replace(/[\\/]+$/, '')}/.dsh/tmp`
}

/** 6 位数字随机串（每次解析重新生成）。 */
function randomDigits(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** 8 位字母数字随机串。 */
function randomString(): string {
  let out = ''
  for (let index = 0; index < 8; index += 1) {
    out += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)]
  }
  return out
}

/**
 * 解析一个内置变量名（规范中文名或英文别名，大小写不敏感）。
 * 未知名 → undefined（substitute 记入 unresolved）。
 */
export function resolveBuiltinName(name: string): BuiltinVariable | undefined {
  return BUILTIN_BY_NAME.get(name.trim().toLowerCase())
}

/**
 * 运行时解析一个内置变量。日期时间类本地生成；host/git 类取 ctx（缺席 →
 * 空串）；随机类每次生新值；未知名 → 空串。
 */
export function resolveBuiltin(name: string, ctx: VariableContext): string {
  const variable = resolveBuiltinName(name)
  if (variable === undefined) return ''
  const now = new Date()
  switch (variable.name) {
    case '工作区目录': return ctx.cwd ?? ''
    case '工作区名称': return workspaceNameOf(ctx.cwd)
    case 'dsh临时目录': return dshTmpDirOf(ctx.cwd)
    case '会话ID': return ctx.sessionId ?? ''
    case '当前日期': return localDate(now)
    case '当前时间': return localTime(now)
    case '日期时间': return `${localDate(now)} ${localTime(now)}`
    case '时间戳(秒)': return String(Math.floor(now.getTime() / 1000))
    case '时间戳(毫秒)': return String(now.getTime())
    case '年': return String(now.getFullYear())
    case '月': return pad2(now.getMonth() + 1)
    case '日': return pad2(now.getDate())
    case '时': return pad2(now.getHours())
    case '分': return pad2(now.getMinutes())
    case '星期': return WEEKDAYS[now.getDay()] ?? ''
    case '用户名': return ctx.host?.username ?? ''
    case '主机名': return ctx.host?.hostname ?? ''
    case '主目录': return ctx.host?.homedir ?? ''
    case '系统临时目录': return ctx.host?.tmpdir ?? ''
    case '随机数(6位数字)': return randomDigits()
    case '随机字符串(8位)': return randomString()
    case 'git分支': return ctx.git?.branch ?? ''
    case 'git提交(短sha)': return ctx.git?.sha ?? ''
    default: return ''
  }
}

export interface SubstituteResult {
  /** 替换后的文本（invalid token 原样保留）。 */
  text: string
  /** 解析为空串的变量（未知名 / 自定义无值无默认）。内置记规范名，自定义记 key。 */
  unresolved: string[]
}

/**
 * 替换文本里的全部变量：内置按 ctx 自动解析；自定义取 `values[key]`（弹窗
 * 收集 / 上次值记忆），缺席回落声明默认值（选择类型回落第一项），仍无则留
 * 空串并计入 unresolved。invalid token 原样保留。
 */
export function substitute(text: string, ctx: VariableContext, values: Record<string, string> = {}): SubstituteResult {
  const unresolved: string[] = []
  const out = text.replace(TOKEN_RE, (_raw, bodyRaw: string) => {
    const body = bodyRaw.trim()
    const colonAt = body.indexOf(':')
    if (colonAt === -1) {
      const variable = resolveBuiltinName(body)
      if (variable === undefined) return _raw
      const value = resolveBuiltin(variable.name, ctx)
      if (value === '') unresolved.push(variable.name)
      return value
    }
    const decl = parseCustomDecl(body.slice(0, colonAt), body.slice(colonAt + 1).split(':'))
    if (decl === undefined) return _raw
    const given = values[decl.key]
    const value = given !== undefined && given !== ''
      ? given
      : decl.defaultValue ?? (decl.type === 'select' ? decl.options?.[0] : undefined) ?? ''
    if (value === '') unresolved.push(decl.key)
    return value
  })
  return { text: out, unresolved }
}

/** POSIX 单引号包裹（内部 `'`→`'\''`）：脚本路径拼接命令行用。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 构造一个内置变量 token 文本（工具栏 chip 插入用）。 */
export function builtinToken(name: string): string {
  return `${TOKEN_OPEN} ${name} ${TOKEN_CLOSE}`
}

/** 构造一个自定义变量声明 token 文本（小表单插入用；中文规范形态）。 */
export function customToken(decl: Omit<CustomVarDecl, 'type'> & { type: CustomVarType }): string {
  const parts = [CN_BY_TYPE[decl.type], decl.key, decl.label]
  if (decl.type === 'select') {
    if (decl.options !== undefined && decl.options.length > 0) parts.push(decl.options.join('|'))
  } else if (decl.defaultValue !== undefined && decl.defaultValue !== '') {
    parts.push(decl.defaultValue)
  }
  return `${TOKEN_OPEN} ${parts.join(':')} ${TOKEN_CLOSE}`
}
