/**
 * 「命令」开始页的交互识别（两个层面，纯逻辑）：
 *
 * 1. 静态预扫（{@link scanInteractionPoints}）：对命令文本 / .sh 脚本内容逐行
 *    找交互点——`read`（`read -p` / `read -sp` / 裸 `read`）、`select` 循环、
 *    交互命令前缀表（sudo / ssh / docker -it / git rebase -i …）。注释行跳过；
 *    字符串内误报从简（不 parse shell 语法，宁可多提示不漏提示）。
 * 2. 运行时启发（{@link detectWaitInput}）：对终端屏幕尾部文本做提示符匹配
 *    （`(y/n)`、`password:`、以冒号/问号结尾的行、中文提示词）。调用方（UI）
 *    再叠加「进程 running 且 ≥1.5s 无新输出」条件才亮「等待输入」徽标。
 *
 * 正则集中导出（{@link READ_RE} 等）便于单测逐分支覆盖。
 */

/** 一个静态交互点（配置页徽标与执行 tab chips 的行）。 */
export interface InteractionPoint {
  /** 1-based 行号。 */
  line: number
  /** 该行 trim 后的内容（chips 展示）。 */
  snippet: string
  kind: 'read' | 'select' | 'command'
  /** 一句话说明（chips 的 title）。 */
  hint: string
}

/**
 * `read` 命令：命令位（行首或 `;` / `&` / `|` / `(` / `&&` / `||` 之后）的
 * read 词 + 空白（含无参数的裸 `read`）。`spread` / `already` 等词不命中。
 */
export const READ_RE = /(?:^|[;&|(]\s*|&&\s*|\|\|\s*|\b(?:while|do|then|elif)\s+)read(?:\s|$)/

/** `select` 循环头：`select 变量 in …`。 */
export const SELECT_RE = /^\s*select\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b/

/** 静态预扫的前缀表命令：出现即提示「可能交互」。 */
export const INTERACTIVE_COMMANDS: readonly string[] = [
  'sudo', 'su', 'ssh', 'scp', 'sftp', 'passwd',
  'mysql', 'psql', 'redis-cli', 'ftp', 'telnet', 'aptitude',
]

/** docker 需要 -it 才交互：`docker exec|run` 的行里出现 `-it` / `-ti` / `-i -t`。 */
export const DOCKER_INTERACTIVE_RE = /(?:^|\s)docker\s+(?:exec|run)\b[^\n]*\s-(?:it|ti|-interactive(?:\s*=\S+)?|-tty)\b/

/** docker attach 恒交互。 */
export const DOCKER_ATTACH_RE = /(?:^|\s)docker\s+attach\b/

/** git 交互子命令：`git rebase -i|--interactive`、`git am`（信件提示）、`git add -i|-p`。 */
export const GIT_INTERACTIVE_RE = /(?:^|\s)git\s+(?:rebase\s+-[^\n]*?\bi\b|rebase\s+--interactive|am\b|add\s+-[^\n]*?i\b)/

/** 带交互 flag 的解释器：`bash -i` / `zsh -i` / `python -i`（含 python3；行尾的裸 `-i` 也算）。 */
export const SHELL_INTERACTIVE_RE = /(?:^|\s)(?:bash|zsh|sh|python3?|node)\s+(?:-[a-zA-Z]*i[a-zA-Z]*(?:\s+|$))+/

/** npm/yarn/pnpm login 类登录命令。 */
export const LOGIN_RE = /(?:^|\s)(?:npm|pnpm|yarn)\s+login\b/

/** 每条静态命令线索的说明文案键（zh 由 UI 层的 t() 补齐）。 */
const HINT_READ = 'read 会暂停等待一行输入'
const HINT_SELECT = 'select 菜单会循环等待选择'
const HINT_COMMAND = '该命令可能需要交互确认'

/**
 * 静态预扫一段命令文本 / 脚本内容里的交互点。
 * 注释行（trim 后以 `#` 开头）跳过；`read` / `select` 每行独立判定；前缀表
 * 命令一行最多记一条（同一行同时命中多个表项不重复记）。
 */
export function scanInteractionPoints(scriptText: string): InteractionPoint[] {
  const points: InteractionPoint[] = []
  const lines = scriptText.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (READ_RE.test(line)) {
      points.push({ line: index + 1, snippet: trimmed, kind: 'read', hint: HINT_READ })
      continue
    }
    if (SELECT_RE.test(line)) {
      points.push({ line: index + 1, snippet: trimmed, kind: 'select', hint: HINT_SELECT })
      continue
    }
    if (isInteractiveCommandLine(line)) {
      points.push({ line: index + 1, snippet: trimmed, kind: 'command', hint: HINT_COMMAND })
    }
  }
  return points
}

/** 一行命令是否命中交互命令前缀表（docker/git/解释器有更细的条件）。 */
export function isInteractiveCommandLine(line: string): boolean {
  if (DOCKER_INTERACTIVE_RE.test(line) || DOCKER_ATTACH_RE.test(line)) return true
  if (GIT_INTERACTIVE_RE.test(line)) return true
  if (LOGIN_RE.test(line)) return true
  if (SHELL_INTERACTIVE_RE.test(line)) return true
  // 裸前缀表：取第一个非 VAR=value 赋值的词，命中表即提示。
  const words = line.trim().split(/\s+/)
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    return INTERACTIVE_COMMANDS.includes(word)
  }
  return false
}

/* ── 运行时启发（终端屏幕尾部） ──────────────────────────────────── */

/** y/n 确认提示：`(y/n)`、`[Y/n]`、`[y/N]`、`(yes/no)`。 */
export const WAIT_YN_RE = /\((?:y\/n|yes\/no)\)|\[(?:Y\/n|y\/N)\]/i

/** 密码提示：`password:` / `密码[:：]`。 */
export const WAIT_PASSWORD_RE = /password\s*[:：]|密码\s*[:：]?/i

/** 通用冒号/问号结尾行：提示符通常长这样（配合「无新输出」才亮徽标）。 */
export const WAIT_PROMPT_END_RE = /[:：?？]\s*$/

/** 中文提示词：请输入 / 请选择 / 确认 / 继续 / 覆盖 / 选择。 */
export const WAIT_CHINESE_RE = /请输入|请选择|是否确认|是否继续|是否覆盖|请确认/

/**
 * 运行时启发：终端屏幕尾部文本是否像在等用户输入。
 * 只做文本判断——调用方必须再叠加「进程 running 且 ≥1.5s 无新输出」，否则
 * 任何带冒号的 banner 都会常亮徽标。
 */
export function detectWaitInput(screenTail: string): boolean {
  if (screenTail === '') return false
  if (WAIT_YN_RE.test(screenTail)) return true
  if (WAIT_PASSWORD_RE.test(screenTail)) return true
  if (WAIT_CHINESE_RE.test(screenTail)) return true
  // 以冒号/问号结尾的行：只看最后一段非空行（banner 中段的冒号不算）。
  const lines = screenTail.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trimEnd()
    if (line.trim() === '') continue
    return WAIT_PROMPT_END_RE.test(line)
  }
  return false
}
