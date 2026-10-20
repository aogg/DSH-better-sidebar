/**
 * 「历史发送」持久仓（host half）：可配置存储根 + 注解库 + 发送记录 JSONL。
 *
 * 布局（根 = prefs `historyStoragePath`（支持 `~` 展开）或默认
 * `<DSH_HOME||~/.dsh>/plugins/DSH-better-sidebar/`）：
 * - `<根>/prompt-history/annotations.json` —— 注解库（评论/标签/关联组，
 *   形状与旧版 `plugins/dsh-better-sidebar/prompt-history.json` 完全一致）；
 * - `<根>/prompt-history/records/<projectKey>.jsonl` —— 发送记录，
 *   append-only，一行一条 HistorySendRecord；
 * - `<根>/prompt-history/records/<projectKey>.meta.json` —— 项目水位
 *   `{ cwd, sessions: { [sessionId]: lastSeq } }`，种子扫描用它续读；
 * - `<根>/tmp/` —— 本插件原子写的临时文件目录（写入后即 rename 到位）。
 *
 * projectKey 是项目 cwd 的规范化（path.resolve）+ sha1 短哈希（`p-` + 12
 * hex），文件名不出现 cwd 原文（路径里的反斜杠/中文/非法字符都不进文件名）。
 *
 * 降级边界：prefs 读不到 / 磁盘不可写 / JSONL 单行损坏都不抛错——前者回落
 * 默认根，后两者记 warn 后按空/跳过处理；原子写失败由调用方决定是否升级成
 * wire 错误（注解写失败抛 history-error，记录写失败只丢实时性不丢内存态）。
 *
 * 根变更：每次操作前重查根（路径变更即时生效），解析结果与上次不同时把旧根
 * 的 `prompt-history/` 目录 best-effort 搬到新根（mkdir -p + 逐文件 rename，
 * 失败逐文件 warn 不抛），内存索引作废重载。旧版小写目录下的注解文件在首次
 * 访问时一次性搬入新根（rename，跨设备 fallback copy+rm；搬不动就降级为
 * 读旧文件，写路径始终写新根）。
 * @module dsh-better-sidebar/prompt-history-persist
 */
import { appendFile, copyFile, mkdir, rmdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { HistorySendRecord } from './prompt-history-extract.ts'
import { emptyAnnotations, normalizeAnnotations, type HistoryAnnotations } from './prompt-history-store.ts'

/** 单项目内存记录数上限；超出丢最旧并在下次写时整文件重写（压实）。 */
export const HISTORY_PROJECT_RECORDS_MAX = 5000

/** 分页默认条数（history.list 不传 limit 时）。 */
export const HISTORY_PAGE_DEFAULT = 50

/** 分页条数硬上限。 */
export const HISTORY_PAGE_MAX = 200

/** projectKey 前缀与哈希长度（`p-` + 12 hex）。 */
const PROJECT_KEY_PREFIX = 'p-'
const PROJECT_KEY_HASH_CHARS = 12

/**
 * 项目 key：项目 cwd 规范化（path.resolve）后的 sha1 短哈希。纯函数、无 I/O，
 * 与磁盘文件名一一对应（同一 cwd 永远同一 key）。
 */
export function projectKeyOf(cwd: string): string {
  const normalized = resolve(cwd)
  return PROJECT_KEY_PREFIX + createHash('sha1').update(normalized).digest('hex').slice(0, PROJECT_KEY_HASH_CHARS)
}

/**
 * 一条记录的分页复合键：`${time 定长 15 位}:${sessionId}:${seq}`。time 定长
 * 保证字典序与时间序一致（epoch ms 现为 13 位，15 位留足余量）；“更旧”
 * 即该键严格小于游标（纯字符串比较）。time 缺失/非法按 0 记（排最旧）。
 */
export function historyRecordCursor(record: HistorySendRecord): string {
  const time = typeof record.time === 'number' && Number.isFinite(record.time) && record.time > 0
    ? Math.floor(record.time)
    : 0
  return `${String(time).padStart(15, '0')}:${record.sessionId}:${record.seq}`
}

/** cwd 是否属于项目：等于项目根，或在项目根之下（path.sep 边界的前缀匹配，
 *  排除 `/repo-x` 误配 `/repo` 这类兄弟目录）。纯函数。 */
export function cwdIsUnderProject(cwd: string, root: string): boolean {
  const child = resolve(cwd)
  const parent = resolve(root)
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** `~` 展开（`~`、`~/x`、`~\x`）；其余原样返回。非路径语义的空串返回空串。 */
export function expandTildePath(value: string): string {
  const raw = value.trim()
  if (raw === '~' || raw === '~/' || raw === '~\\') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/** 环境里的 DSH 主目录（DSH_HOME 优先，~/.dsh 兜底；同 search-debug 的旧顺序）。 */
function dshHomeOf(env: { DSH_HOME?: string | undefined }): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
}

/** 默认存储根：`<DSH_HOME||~/.dsh>/plugins/DSH-better-sidebar/`。 */
export function defaultStorageRoot(env: { DSH_HOME?: string | undefined } = process.env): string {
  return join(dshHomeOf(env), 'plugins', 'DSH-better-sidebar')
}

/** 默认根下的注解库落点（historyStorePath 的新语义）。 */
export function defaultAnnotationsPath(env: { DSH_HOME?: string | undefined } = process.env): string {
  return join(defaultStorageRoot(env), 'prompt-history', 'annotations.json')
}

/**
 * 旧版注解库落点（一次性迁移源）：旧版小写目录
 * `<DSH_HOME||~/.dsh>/plugins/dsh-better-sidebar/prompt-history.json`。
 */
export function legacyAnnotationsPath(env: { DSH_HOME?: string | undefined } = process.env): string {
  return join(dshHomeOf(env), 'plugins', 'dsh-better-sidebar', 'prompt-history.json')
}

// ── 纯分页 ───────────────────────────────────────────────────────────────────

/** 一页发送记录（wire 形状）：新→旧平铺 + 续读游标。 */
export interface HistoryPage {
  records: HistorySendRecord[]
  /** 本页最后一条的复合键（仅 hasMore 时存在；客户端原样回传）。 */
  nextCursor?: string
  hasMore: boolean
}

/** payload.limit 的收窄：正整数钳到 [1, max]，否则默认值。 */
export function normalizeHistoryLimit(
  value: unknown,
  fallback: number = HISTORY_PAGE_DEFAULT,
  max: number = HISTORY_PAGE_MAX,
): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback
}

/**
 * 从升序记录集合出「新→旧」一页（纯函数，无 I/O，可独立单测）：复合键降序，
 * 游标之后（严格小于）的记录里取前 limit 条；有剩余则携带 nextCursor。
 */
export function historyPageOf(
  records: readonly HistorySendRecord[],
  cursor: string | undefined,
  limit: number,
): HistoryPage {
  const keyed = records
    .map(record => ({ record, key: historyRecordCursor(record) }))
    .filter(entry => cursor === undefined || entry.key < cursor)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
  const page = keyed.slice(0, Math.max(0, limit))
  const hasMore = keyed.length > page.length
  return {
    records: page.map(entry => entry.record),
    ...(hasMore && page.length > 0 ? { nextCursor: page[page.length - 1]!.key } : {}),
    hasMore,
  }
}

// ── 磁盘形状 ────────────────────────────────────────────────────────────────

/** 项目水位文件（`records/<projectKey>.meta.json`）的磁盘形状。 */
interface ProjectMetaFile {
  cwd?: unknown
  root?: unknown
  sessions?: unknown
}

/** 单项目内存索引：记录（time/seq 升序、key 去重）+ 会话水位 + 扫描状态。 */
export interface ProjectHistoryIndex {
  records: HistorySendRecord[]
  byKey: Set<string>
  /** 种子扫描进行中（路由用它回答 seeding，绝不阻塞首屏）。 */
  seeding: boolean
  /** 磁盘 JSONL 已载入内存。 */
  loaded: boolean
  /** 各会话已扫描到的事件 seq 水位（增量续扫的起点）。 */
  watermarks: Record<string, number>
  /** 项目 cwd（首次扫描时记录，仅诊断用）。 */
  cwd?: string
  /** 记录数超限：下次写时整文件重写（压实），而不是继续追加。 */
  compact: boolean
}

/** 记录行的收窄：形状不符的行丢弃（损坏行跳过不抛）。 */
function normalizeRecord(raw: unknown): HistorySendRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const candidate = raw as { key?: unknown; sessionId?: unknown; seq?: unknown; time?: unknown; text?: unknown; textTruncated?: unknown }
  if (typeof candidate.key !== 'string' || candidate.key === '') return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined
  if (typeof candidate.seq !== 'number' || !Number.isSafeInteger(candidate.seq) || candidate.seq < 0) return undefined
  if (typeof candidate.text !== 'string') return undefined
  return {
    key: candidate.key,
    sessionId: candidate.sessionId,
    seq: candidate.seq,
    time: typeof candidate.time === 'number' && Number.isFinite(candidate.time) ? candidate.time : 0,
    text: candidate.text,
    textTruncated: candidate.textTruncated === true,
  }
}

/** 水位文件的收窄：垃圾字段丢弃，合法字段逐个保留。 */
function normalizeMeta(raw: unknown): { cwd?: string; sessions: Record<string, number> } {
  if (raw === null || typeof raw !== 'object') return { sessions: {} }
  const candidate = raw as ProjectMetaFile
  const sessions: Record<string, number> = {}
  if (candidate.sessions !== null && typeof candidate.sessions === 'object' && !Array.isArray(candidate.sessions)) {
    for (const [id, seq] of Object.entries(candidate.sessions as Record<string, unknown>)) {
      if (typeof id !== 'string' || id === '') continue
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue
      sessions[id] = seq
    }
  }
  return {
    ...(typeof candidate.cwd === 'string' && candidate.cwd !== '' ? { cwd: candidate.cwd } : {}),
    sessions,
  }
}

/** 有序插入（time/seq 升序；键重复由调用方 byKey 挡住）。 */
function insertSorted(index: ProjectHistoryIndex, record: HistorySendRecord): void {
  const { records } = index
  let position = records.length
  while (position > 0) {
    const previous = records[position - 1]!
    if (previous.time < record.time || (previous.time === record.time && previous.seq < record.seq)) break
    position--
  }
  records.splice(position, 0, record)
  index.byKey.add(record.key)
}

type Warn = (message: string, error?: unknown) => void

/** 文件是否存在（不存在/不可达都算否——调用方各自处理降级）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 搬一个文件：rename 优先；跨设备（EXDEV）等失败 fallback copy + rm；再失败
 * 记 warn 并返回 false（调用方降级，绝不抛）。
 */
async function moveFile(from: string, to: string, warn: Warn): Promise<boolean> {
  try {
    await rename(from, to)
    return true
  } catch {
    try {
      await copyFile(from, to)
      await rm(from).catch(() => {})
      return true
    } catch (error) {
      warn(`dsh-better-sidebar: cannot move ${from} -> ${to}; keeping the source in place`, error)
      return false
    }
  }
}

/**
 * 把 `from` 目录整体搬到 `to`（best-effort）：mkdir -p 后逐文件 rename，单个
 * 文件失败只 warn 并留在原地（绝不 rm 掉没搬走的文件），目录残留留待用户处理。
 */
async function moveDir(from: string, to: string, warn: Warn): Promise<void> {
  let entries
  try {
    entries = await readdir(from, { withFileTypes: true })
  } catch {
    return // 源目录不存在：无事可做（首次使用/旧版无数据都是这个形态）
  }
  await mkdir(to, { recursive: true })
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await moveDir(source, target, warn)
      // 子目录搬空才删得掉（rmdir 只删空目录：还留着失败文件的目录保持原样，
      // 内容绝不静默销毁）。
      await rmdir(source).catch(() => {})
    } else {
      await moveFile(source, target, warn)
    }
  }
  await rmdir(from).catch(() => {})
}

/**
 * 原子写：临时文件落 `<存储根>/tmp/`（本插件约定的临时文件根；与目标同卷，
 * rename 原子到位），写完 rename；rename 失败清掉孤儿临时文件后上抛，由调用
 * 方决定降级方式。
 */
async function writeAtomic(path: string, data: string, tmpDir: string): Promise<void> {
  await mkdir(tmpDir, { recursive: true })
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(tmpDir, `.prompt-history-${randomUUID()}.tmp`)
  await writeFile(tmp, data, 'utf8')
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp).catch(() => {})
    throw error
  }
}

/** 存储仓选项：根供给者（每次操作前调用，返回 '' 用默认根）+ warn 收集。 */
export interface PromptHistoryStoreOptions {
  /** 存储根：静态值或供给者（读 prefs；空串/缺席 → 默认根）。 */
  root?: string | (() => string | Promise<string>)
  logger?: { warn?(message: string, error?: unknown): void }
}

/**
 * 「历史发送」持久仓：注解库（JSON，读缓存 + 原子写）与发送记录（JSONL +
 * 水位，append-only + 超限压实）共用一个可配置存储根。所有 I/O 都不抛：
 * 磁盘失败记 warn 后按空库/空索引继续（路由层只对注解写失败升级为 wire 错）。
 */
export class PromptHistoryStore {
  private readonly rootSource: string | (() => string | Promise<string>)
  private readonly warn: Warn
  /** 已解析的当前根（undefined = 尚未解析）。变更触发迁移与缓存作废。 */
  private resolvedRoot: string | undefined
  /** 根解析串行链：并发首个操作只跑一次迁移。 */
  private rootChain: Promise<unknown> = Promise.resolve()
  /** 注解库读缓存（按根失效）。 */
  private annotationsCache: { root: string; store: HistoryAnnotations } | undefined
  /** 旧文件迁移检查过的根（每根一次性）。 */
  private readonly legacyChecked = new Set<string>()
  /** 旧文件搬不动时的降级读路径（读路径仍优先新根）。 */
  private legacyFallback: string | undefined
  /** 项目内存索引与载入中的 promise（按项目去重并发载入）。 */
  private readonly projects = new Map<string, ProjectHistoryIndex>()
  private readonly loading = new Map<string, Promise<ProjectHistoryIndex>>()
  /** 每项目的写串行链（append 与压实重写不交错）。 */
  private readonly writeChains = new Map<string, Promise<unknown>>()

  constructor(options: PromptHistoryStoreOptions = {}) {
    this.rootSource = options.root ?? ''
    this.warn = (message, error) => {
      options.logger?.warn?.(message)
      if (error !== undefined) options.logger?.warn?.(error)
    }
  }

  /** 解析当前根：每次操作前调用；根变更时搬迁目录并作废内存索引。 */
  async root(): Promise<string> {
    const result = this.rootChain.then(() => this.resolveRoot())
    this.rootChain = result.catch(() => undefined)
    return result
  }

  private async resolveRoot(): Promise<string> {
    const raw = typeof this.rootSource === 'function' ? await this.rootSource() : this.rootSource
    const root = typeof raw === 'string' && raw.trim() !== '' ? expandTildePath(raw) : defaultStorageRoot()
    if (this.resolvedRoot === root) return root
    const previous = this.resolvedRoot
    this.resolvedRoot = root
    try {
      await this.migrateRoot(previous, root)
    } catch (error) {
      // 迁移是 best-effort：失败降级继续（warn 已在 moveDir/moveFile 里记）。
      this.warn('dsh-better-sidebar: prompt-history storage root migration failed; continuing in place', error)
    }
    if (previous !== undefined) {
      // 真正的根变更：内存索引作废重载（下次 loadProject 从新根读盘）。首次
      // 解析（previous === undefined）不清——kick 刚标记的 seeding 状态就在
      // 这张表里，清了它首屏的 seeding:true 就会丢。
      this.projects.clear()
      this.loading.clear()
      this.annotationsCache = undefined
    }
    return root
  }

  /** 根变更迁移：旧根目录搬迁 + 旧版注解文件一次性搬入。 */
  private async migrateRoot(previous: string | undefined, root: string): Promise<void> {
    await mkdir(root, { recursive: true }).catch(() => {})
    if (previous !== undefined && previous !== root) {
      this.warn(`dsh-better-sidebar: prompt-history storage root changed; moving data ${previous} -> ${root}`)
      await moveDir(join(previous, 'prompt-history'), join(root, 'prompt-history'), this.warn)
    }
    if (this.legacyChecked.has(root)) return
    this.legacyChecked.add(root)
    const target = join(root, 'prompt-history', 'annotations.json')
    if (await pathExists(target)) return
    const legacy = legacyAnnotationsPath()
    if (legacy === target || !(await pathExists(legacy))) return
    this.warn(`dsh-better-sidebar: importing legacy prompt-history annotations from ${legacy}`)
    // 目标父目录先建好（rename 不建中间目录）；建不动时 moveFile 自会降级。
    await mkdir(join(target, '..'), { recursive: true }).catch(() => {})
    // 搬不动就降级为读旧文件（读路径的 legacyFallback），写路径仍写新根。
    this.legacyFallback = (await moveFile(legacy, target, this.warn)) ? undefined : legacy
  }

  // ── 注解库 ────────────────────────────────────────────────────────────────

  /** 注解库：缺席→空库；损坏→空库 + warn；旧文件搬不动时降级读旧文件。 */
  async annotations(): Promise<HistoryAnnotations> {
    const root = await this.root()
    if (this.annotationsCache?.root === root) return this.annotationsCache.store
    const primary = join(root, 'prompt-history', 'annotations.json')
    let text: string | undefined
    try {
      text = await readFile(primary, 'utf8')
    } catch {
      text = undefined
    }
    if (text === undefined && this.legacyFallback !== undefined && this.legacyFallback !== primary) {
      try {
        text = await readFile(this.legacyFallback, 'utf8')
      } catch {
        text = undefined
      }
    }
    if (text === undefined) {
      const store = emptyAnnotations()
      this.annotationsCache = { root, store }
      return store
    }
    try {
      const store = normalizeAnnotations(JSON.parse(text))
      this.annotationsCache = { root, store }
      return store
    } catch (error) {
      this.warn('dsh-better-sidebar: prompt-history annotations.json is not valid JSON; starting from an empty annotation store', error)
      const store = emptyAnnotations()
      this.annotationsCache = { root, store }
      return store
    }
  }

  /** 原子写注解库（tmp + rename），并刷新读缓存。失败上抛（路由升级为 wire 错）。 */
  async writeAnnotations(store: HistoryAnnotations): Promise<void> {
    const root = await this.root()
    await writeAtomic(
      join(root, 'prompt-history', 'annotations.json'),
      `${JSON.stringify(store, null, 2)}\n`,
      join(root, 'tmp'),
    )
    this.annotationsCache = { root, store }
  }

  // ── 发送记录 ──────────────────────────────────────────────────────────────

  /** 内存索引的同步窥视（不触发磁盘载入；路由/推送用它读即时状态）。 */
  peekProject(projectKey: string): ProjectHistoryIndex | undefined {
    return this.projects.get(projectKey)
  }

  /** 标记项目扫描状态（不存在则建空索引；路由的首屏立即用它回答 seeding）。 */
  markSeeding(projectKey: string, seeding: boolean): void {
    let entry = this.projects.get(projectKey)
    if (entry === undefined) {
      entry = { records: [], byKey: new Set(), seeding, loaded: false, watermarks: {}, compact: false }
      this.projects.set(projectKey, entry)
      return
    }
    entry.seeding = seeding
  }

  /**
   * 载入项目索引（内存命中直接返回；否则读盘：JSONL 逐行收窄、损坏行跳过，
   * meta 水位归并）。并发调用共享同一次载入。
   */
  async loadProject(projectKey: string): Promise<ProjectHistoryIndex> {
    const cached = this.projects.get(projectKey)
    if (cached?.loaded === true) return cached
    const inFlight = this.loading.get(projectKey)
    if (inFlight !== undefined) return inFlight
    const task = this.loadProjectNow(projectKey).finally(() => { this.loading.delete(projectKey) })
    this.loading.set(projectKey, task)
    return task
  }

  private async loadProjectNow(projectKey: string): Promise<ProjectHistoryIndex> {
    const root = await this.root()
    const recordsDir = join(root, 'prompt-history', 'records')
    const entry: ProjectHistoryIndex = this.projects.get(projectKey) ?? {
      records: [], byKey: new Set(), seeding: false, loaded: false, watermarks: {}, compact: false,
    }
    try {
      const meta = normalizeMeta(JSON.parse(await readFile(join(recordsDir, `${projectKey}.meta.json`), 'utf8')))
      if (meta.cwd !== undefined) entry.cwd = meta.cwd
      for (const [id, seq] of Object.entries(meta.sessions)) {
        if ((entry.watermarks[id] ?? -1) < seq) entry.watermarks[id] = seq
      }
    } catch {
      // 水位文件缺席/损坏：空水位（下次扫描从头开始，key 幂等保证不重复记账）。
    }
    try {
      const text = await readFile(join(recordsDir, `${projectKey}.jsonl`), 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const record = normalizeRecord(JSON.parse(trimmed))
          if (record !== undefined && !entry.byKey.has(record.key)) insertSorted(entry, record)
        } catch {
          // 单行损坏：跳过不抛（半损坏的文件不该丢掉另一半记录）。
        }
      }
    } catch {
      // JSONL 缺席：首次使用，空索引就是正确答案。
    }
    entry.loaded = true
    this.projects.set(projectKey, entry)
    return entry
  }

  /**
   * 追加记录（幂等）：key 已存在的跳过（种子扫描与实时事件竞态安全），水位随
   * 扫描推进；内存先收账，磁盘 best-effort（失败 warn 不抛，内存态仍然完整）。
   * 记录数超限时丢最旧并在本次写时整文件重写（压实）。
   */
  async appendRecords(
    projectKey: string,
    records: readonly HistorySendRecord[],
    watermarks?: Record<string, number>,
  ): Promise<void> {
    const queued = this.enqueueWrite(projectKey, async () => {
      const entry = await this.loadProject(projectKey)
      const fresh: HistorySendRecord[] = []
      for (const candidate of records) {
        const record = normalizeRecord(candidate)
        if (record === undefined || entry.byKey.has(record.key)) continue
        insertSorted(entry, record)
        fresh.push(record)
      }
      let advanced = false
      for (const [id, seq] of Object.entries(watermarks ?? {})) {
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue
        if ((entry.watermarks[id] ?? -1) < seq) {
          entry.watermarks[id] = seq
          advanced = true
        }
      }
      if (fresh.length === 0 && !advanced) return
      if (entry.records.length > HISTORY_PROJECT_RECORDS_MAX) {
        const excess = entry.records.splice(0, entry.records.length - HISTORY_PROJECT_RECORDS_MAX)
        for (const record of excess) entry.byKey.delete(record.key)
        entry.compact = true
      }
      const root = await this.root()
      const recordsDir = join(root, 'prompt-history', 'records')
      const jsonlPath = join(recordsDir, `${projectKey}.jsonl`)
      try {
        await mkdir(recordsDir, { recursive: true })
        if (entry.compact) {
          await writeAtomic(
            jsonlPath,
            `${entry.records.map(record => JSON.stringify(record)).join('\n')}\n`,
            join(root, 'tmp'),
          )
          entry.compact = false
        } else if (fresh.length > 0) {
          await appendFile(jsonlPath, `${fresh.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
        }
        await writeAtomic(
          join(recordsDir, `${projectKey}.meta.json`),
          `${JSON.stringify({ cwd: entry.cwd, sessions: entry.watermarks }, null, 2)}\n`,
          join(root, 'tmp'),
        )
      } catch (error) {
        // 磁盘写失败只丢持久性，内存索引仍然完整（下次操作再试）。
        this.warn(`dsh-better-sidebar: cannot persist prompt-history records for project ${projectKey}`, error)
      }
    })
    await queued
  }

  /** 内存索引上出「新→旧」一页（纯计算；未载入/为空返回空页）。 */
  listPage(projectKey: string, cursor?: string, limit?: number): HistoryPage {
    const entry = this.projects.get(projectKey)
    if (entry === undefined || entry.records.length === 0) return { records: [], hasMore: false }
    return historyPageOf(entry.records, cursor, normalizeHistoryLimit(limit))
  }

  /** 每项目写串行链：append 与压实重写不交错；前一个失败不阻断后一个。 */
  private enqueueWrite(projectKey: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(projectKey) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.writeChains.set(projectKey, next.catch(() => undefined))
    return next
  }
}
