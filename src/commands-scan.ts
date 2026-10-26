/**
 * 「命令」开始页的服务端脚本扫描（`commands.scanScripts` 路由的执行体）。
 *
 * 每条规则：pattern 相对 → 以 cwd 为基；绝对 → 取 glob 静态前缀
 * （glob-match.ts 的 globStaticPrefix：第一个含通配符的段之前）作扫描根，根
 * 必须是真实存在的目录，否则该规则带回 error（其余规则照常）。遍历沿用
 * fs.search 的排除约定（search-engines.ts 的 SKIP_DIR_NAMES：node_modules、
 * .git 等；符号链接目录不下钻——环安全），深度/访问量/结果数三重上限防失控，
 * 超限置 truncated。匹配用与客户端同一份 glob-match 语义。
 *
 * fs 面可注入（{@link ScanFsFace}）：单测不用真实目录也能驱动；默认实现走
 * node:fs/promises。纯 node、无 React——只被 src/index.ts 引用。
 */
import { readdir as nodeReaddir, stat as nodeStat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { SKIP_DIR_NAMES } from './search-engines.ts'
import { globSegmentHasWildcard, globStaticPrefix, globToMatcher } from './glob-match.ts'

/** 注入面（单测替身的最小形状；默认实现是 node:fs/promises）。 */
export interface ScanFsFace {
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; mtimeMs: number; size: number } | undefined>
  readdir(path: string): Promise<readonly { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]>
}

/** 默认 fs 面：node:fs/promises 的形状适配（probe 失败读成 undefined）。 */
export const nodeScanFs: ScanFsFace = {
  async stat(path) {
    return await nodeStat(path).catch(() => undefined)
  },
  async readdir(path) {
    return await nodeReaddir(path, { withFileTypes: true }).catch(() => [])
  },
}

/** 一个命中的脚本（配置页脚本卡与命令行拼装的字段）。 */
export interface ScriptMatch {
  /** 绝对路径（运行/编辑/复制路径都用它）。 */
  abs: string
  /** 相对扫描根的 '/' 路径（展示 + 按父目录分组）。 */
  rel: string
  /** 脚本父目录（绝对；runInScriptDir 的 `cd` 目标）。 */
  dir: string
  /** 文件名。 */
  name: string
  /** 修改时间（徽标缓存键的一部分：内容变了才重读解析）。 */
  mtime: number
  /** 字节数。 */
  size: number
}

/** 一条规则的扫描结果（失败/超限都以行内字段带回，整批永不失败）。 */
export interface RuleScan {
  id: string
  matches: ScriptMatch[]
  /** 规则级失败（pattern 非法 / 扫描根不存在 / 遍历异常）。 */
  error?: string
  /** 命中数或访问预算触顶（结果可能不全）。 */
  truncated?: boolean
}

/** 每规则的结果上限（超出置 truncated）。 */
export const SCRIPT_SCAN_MAX_MATCHES = 500

/** 每规则的访问条目上限（失控树——home 目录根——不拖垮宿主）。 */
export const SCRIPT_SCAN_MAX_VISITED = 20_000

/** 每规则的最大下钻深度。 */
export const SCRIPT_SCAN_MAX_DEPTH = 24

/** 排除目录名（大小写不敏感；fs.search 同一张表）。 */
const SKIP_DIRS = new Set(SKIP_DIR_NAMES.map(name => name.toLowerCase()))

/** pattern 是否按绝对路径写（POSIX 根 / Windows 盘符 / UNC；node 在 POSIX 上不认盘符）。 */
export function scanPatternIsAbsolute(pattern: string): boolean {
  return isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern) || /^\\\\/.test(pattern)
}

/**
 * 一条规则的完整扫描。见模块头：错误行内带回，永不抛。
 * @param cwd - 会话工作区（相对 pattern 的基）。
 * @param rule - 规则行（id + pattern）。
 * @param fs - 注入面（默认 node）。
 */
export async function scanScriptRule(cwd: string, rule: { id: string; pattern: string }, fs: ScanFsFace = nodeScanFs): Promise<RuleScan> {
  const pattern = rule.pattern.trim()
  const matcher = globToMatcher(pattern)
  if (matcher === undefined) {
    return { id: rule.id, matches: [], error: 'invalid pattern' }
  }
  const prefix = globStaticPrefix(pattern)
  // 无通配符段：按字面量文件处理（stat 命中即单条结果，不扫目录）。
  if (prefix === undefined) {
    const abs = scanPatternIsAbsolute(pattern) ? pattern : join(cwd, pattern)
    const info = await fs.stat(abs)
    if (info === undefined || !info.isFile()) {
      return { id: rule.id, matches: [], error: `file not found: ${abs}` }
    }
    return {
      id: rule.id,
      matches: [{
        abs,
        rel: pattern.replace(/\\/g, '/'),
        dir: dirname(abs),
        name: basename(abs),
        mtime: info.mtimeMs,
        size: info.size,
      }],
    }
  }
  // 扫描根：相对前缀落 cwd 下；绝对前缀原样。前缀目录必须真实存在。
  const root = prefix === '' ? cwd : (scanPatternIsAbsolute(pattern) ? prefix : join(cwd, prefix))
  const rootInfo = await fs.stat(root)
  if (rootInfo === undefined) {
    return { id: rule.id, matches: [], error: `scan root not found: ${root}` }
  }
  if (!rootInfo.isDirectory()) {
    return { id: rule.id, matches: [], error: `scan root is not a directory: ${root}` }
  }
  // 相对 pattern 的命中判定路径带前缀（`scripts/**/*.sh` 的根是
  // `cwd/scripts`，rel 缺 `scripts/` 头——判定路径按 pattern 的口径补回）。
  const prefixHead = prefix === '' ? '' : `${prefix.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const matches: ScriptMatch[] = []
  let visited = 0
  let truncated = false
  const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
    if (truncated) return
    if (depth > SCRIPT_SCAN_MAX_DEPTH) {
      truncated = true
      return
    }
    const entries = [...await fs.readdir(dir)].sort((a, b) => {
      const la = a.name.toLowerCase()
      const lb = b.name.toLowerCase()
      return la === b.name ? (a.name < b.name ? -1 : 1) : la < lb ? -1 : 1
    })
    for (const entry of entries) {
      visited += 1
      if (visited > SCRIPT_SCAN_MAX_VISITED) {
        truncated = true
        return
      }
      // 依赖/构建/VCS 森林：不匹配也不下钻（fs.search 同一张表）。
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const abs = join(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(abs, rel, depth + 1)
        if (truncated) return
        continue
      }
      if (!entry.isDirectory() && matcher(`${prefixHead}${rel}`)) {
        const info = await fs.stat(abs)
        if (info === undefined || !info.isFile()) continue
        matches.push({
          abs,
          rel,
          dir: dirname(abs),
          name: entry.name,
          mtime: info.mtimeMs,
          size: info.size,
        })
        if (matches.length >= SCRIPT_SCAN_MAX_MATCHES) {
          truncated = true
          return
        }
      }
    }
  }
  try {
    await walk(root, '', 0)
  } catch (error) {
    return { id: rule.id, matches, error: error instanceof Error ? error.message : String(error), ...(truncated ? { truncated: true } : {}) }
  }
  return { id: rule.id, matches, ...(truncated ? { truncated: true } : {}) }
}

/**
 * 整批扫描：每条规则独立执行，一条失败不拖垮其余（matches/error 都按规则行
 * 内带回，顺序与入参一致）。
 */
export async function scanScriptsByRules(
  cwd: string,
  rules: readonly { id: string; pattern: string }[],
  fs: ScanFsFace = nodeScanFs,
): Promise<RuleScan[]> {
  return await Promise.all(rules.map(rule => scanScriptRule(cwd, rule, fs)))
}

/** 通配符探测的再导出（路由层校验用，避免直接依赖 glob-match 的内部拼写）。 */
export { globSegmentHasWildcard }
