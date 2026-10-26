/**
 * 「命令」开始页的深度 glob 匹配器（脚本规则 glob 的裁判；下文把双星写作
 * `**` + `/`，块注释里不能出现「双星紧跟斜杠」的连续序列——那会提前闭合注释）。
 *
 * 不引入新依赖：`**` 跨任意段（含零段）、`*` / `?` 只在段内、`[abc]` 字符类
 * 可选支持，其余字符按字面量处理。pattern 与 path 都先统一到 `/` 分隔再匹配，
 * 所以绝对路径（`/a/b/` + `**` + `/*.sh`）与相对路径（`scripts/` + `**` +
 * `/*.sh`）两种写法都能命中；Windows 反斜杠路径在匹配前归一成 `/`。
 *
 * 编译思路（字符串级变换 + 段级正则，两步都锚定整串；注释里不写含星号紧跟
 * 斜杠的正则片段——那会提前闭合注释）：
 * - 首部「双星+斜杠」→ 可选的任意深度目录头（含零段）；
 * - 中部「斜杠+双星+斜杠」→ 左斜杠保留，双星连同右斜杠吞任意目录层；
 * - 尾部 `/**` → `(?:/.*)?`（目录自身与其下所有内容都命中）；
 * - 其余段内 `*`→`[^/]*`、`?`→`[^/]`、`[…]` 原样通过。
 *
 * 纯函数、无 node import：服务端（commands-scan.ts）与客户端共用同一份语义，
 * 两边对「哪条规则命中哪个文件」永远一致。
 */

/** 一次编译出的 matcher（`globToMatcher` 的产物，可对多个 path 复用）。 */
export type GlobMatcher = (path: string) => boolean

/** 统一路径分隔符并剥掉首尾空白；尾随 `/` 去掉（文件匹配不关心目录斜杠）。 */
function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, '/')
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

/** 一个段是否含通配符（`*` / `?` / `[`）。 */
export function globSegmentHasWildcard(segment: string): boolean {
  return /[*?[]/.test(segment)
}

/**
 * 把一段（不含 `/`、不含 `**`）编译成正则片段：`*`→`[^/]*`、`?`→`[^/]`、
 * `[abc]` 原样通过（未闭合的 `[` 按字面量），其余字符转义。
 */
function segmentToRegExp(segment: string): string {
  let out = ''
  let index = 0
  while (index < segment.length) {
    const char = segment[index]!
    if (char === '*') {
      out += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    if (char === '[') {
      const close = segment.indexOf(']', index + 1)
      if (close !== -1) {
        // 字符类原样通过；glob 的否定写法 `[!…]` 译成正则的 `[^…]`
        // （类内内容不再转义）。
        const body = segment.slice(index + 1, close)
        out += body.startsWith('!') ? `[^${body.slice(1)}]` : segment.slice(index, close + 1)
        index = close + 1
        continue
      }
    }
    out += char.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
    index += 1
  }
  return out
}

/**
 * 编译一个 glob pattern 为 matcher。非法形态（空串、全 `**`、连续双斜杠）
 * 返回 undefined——调用方（脚本规则保存校验 / 服务端扫描）把 undefined 当
 * 「永不命中」处理，而不是让一条坏规则吞掉整棵树。
 *
 * 编译按「段」走（先 split 再逐段处理，绝不在 split 之前往 pattern 里注入
 * 含斜杠的正则片段——那会被 split 撕碎）：
 * - 尾段剥 `/**` → 尾正则「可选的任意尾巴」（目录自身与其下所有内容都命中）；
 * - 首段 `**` → 头正则「可选的任意深度目录头」（含零段，相对/绝对都含根）；
 * - 中段 `**` → 「斜杠 + 可选任意目录头」（保留左斜杠、吞任意层，含零层）；
 * - 其余段走 {@link segmentToRegExp}。
 */
export function globToMatcher(pattern: string): GlobMatcher | undefined {
  const normalized = normalizePath(pattern)
  if (normalized === '' || normalized === '**' || normalized === '/**') return undefined
  // ① 尾部 `/**`：`a/**` 命中 `a` 本身与其下所有内容。
  let tail = '$'
  let body = normalized
  if (body.endsWith('/**')) {
    body = body.slice(0, -3)
    tail = '(?:/.*)?$'
    if (body === '' || body === '/') return undefined
  }
  // ② 逐段编译。POSIX 根段（绝对路径的首个空段）落成字面 `/` 开头。
  const segments = body.split('/')
  let head = '^'
  let start = 0
  if (segments[0] === '') {
    head = '^/'
    start = 1
  }
  if (segments[start] === '**') {
    head = '^(?:.*/)?'
    start += 1
  }
  let source = ''
  let needSlash = false
  let lastWasGlobstar = false
  for (let index = start; index < segments.length; index += 1) {
    const segment = segments[index]!
    if (segment === '') return undefined
    if (segment === '**') {
      // 中段双星：吞任意目录层（含零层）；连续双星折叠，避免碎双斜杠。
      if (lastWasGlobstar) continue
      source += '/(?:.*/)?'
      needSlash = false
      lastWasGlobstar = true
      continue
    }
    source += (needSlash ? '/' : '') + segmentToRegExp(segment)
    needSlash = true
    lastWasGlobstar = false
  }
  if (source === '') return undefined
  const regex = new RegExp(`${head}${source}${tail}`)
  // 正则本身不可调用：包一层 test 闭包才是 GlobMatcher（无 g 标志，无状态）。
  return (path: string): boolean => regex.test(path)
}

/**
 * pattern 是否命中 path（`globToMatcher` 的一次性便捷形态；同一 pattern 反复
 * 匹配多个路径时应先取 matcher）。
 */
export function matchGlob(pattern: string, path: string): boolean {
  const matcher = globToMatcher(pattern)
  return matcher !== undefined && matcher(normalizePath(path))
}

/**
 * glob 的静态目录前缀：第一个含通配符的段之前的路径部分（保持原 pattern 的
 * 绝对/相对形态；POSIX 根保留）。服务端扫描用它定扫描根：`/a/b/` + `**` +
 * `/*.sh` → `/a/b`、`scripts/` + `**` + `/*.sh` → `scripts`、`**` + `/*.sh` →
 * ''（前缀为空 = 以 cwd 为根）。pattern 里没有任何通配符段时返回
 * undefined——调用方按字面量文件处理，不做目录扫描。
 */
export function globStaticPrefix(pattern: string): string | undefined {
  const trimmed = pattern.trim()
  if (trimmed === '') return undefined
  const absolute = /^[\\/]/.test(trimmed)
  const segments = trimmed.split(/[\\/]/)
  const prefix: string[] = []
  for (const segment of segments) {
    if (segment === '') continue
    if (globSegmentHasWildcard(segment)) {
      const joined = prefix.join('/')
      if (joined === '') return ''
      return absolute ? `/${joined}` : joined
    }
    prefix.push(segment)
  }
  return undefined
}
