/**
 * 「历史发送」持久仓（src/prompt-history-persist.ts）：纯逻辑（projectKey、
 * 复合键游标、新→旧分页、项目归属前缀匹配、`~` 展开、limit 收窄）与磁盘
 * 行为（注解库原子写往返/损坏归空、旧版注解文件一次性搬入、根变更整体搬迁、
 * JSONL 追加/幂等/水位推进/损坏行跳过/超限压实）。磁盘用例走临时目录，存储
 * 根经构造参数静态注入（不经 prefs）。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cwdIsUnderProject,
  defaultAnnotationsPath,
  defaultStorageRoot,
  expandTildePath,
  historyPageOf,
  historyRecordCursor,
  HISTORY_PROJECT_RECORDS_MAX,
  legacyAnnotationsPath,
  normalizeHistoryLimit,
  projectKeyOf,
  PromptHistoryStore,
} from '../src/prompt-history-persist.ts'
import type { HistorySendRecord } from '../src/prompt-history-extract.ts'

/** 记录夹具（key = `${sessionId}:${seq}`，同 extract 的约定）。 */
function record(sessionId: string, seq: number, time: number, text = `问 ${seq}`): HistorySendRecord {
  return { key: `${sessionId}:${seq}`, sessionId, seq, time, text, textTruncated: false }
}

describe('prompt-history persist（纯逻辑）', () => {
  it('projectKeyOf：确定性、格式 p-+12hex、不同 cwd 不同 key、相对路径规范化后同 key', () => {
    const a = projectKeyOf('/work/alpha')
    expect(a).toMatch(/^p-[0-9a-f]{12}$/)
    expect(projectKeyOf('/work/alpha')).toBe(a)
    expect(projectKeyOf('/work/beta')).not.toBe(a)
    // path.resolve 语义：尾斜杠/相对段不影响 key。
    expect(projectKeyOf('/work/alpha/')).toBe(a)
    expect(projectKeyOf('/work/alpha/sub/..')).toBe(a)
    // 文件名不出现 cwd 原文。
    expect(a).not.toContain('alpha')
  })

  it('historyRecordCursor：time 定长 15 位，字典序即新旧序；time=0 记 0', () => {
    const older = historyRecordCursor(record('s', 1, 1_700_000_000_000))
    const newer = historyRecordCursor(record('s', 2, 1_700_000_005_000))
    expect(older).toBe('001700000000000:s:1')
    expect(newer > older).toBe(true)
    expect(historyRecordCursor(record('s', 3, 0))).toBe('000000000000000:s:3')
    expect(historyRecordCursor(record('s', 4, Number.NaN))).toBe('000000000000000:s:4')
  })

  it('cwdIsUnderProject：相等/子目录（sep 边界）算命中，兄弟目录不算', () => {
    expect(cwdIsUnderProject('/work/alpha', '/work/alpha')).toBe(true)
    expect(cwdIsUnderProject(join('/work/alpha', 'sub'), '/work/alpha')).toBe(true)
    expect(cwdIsUnderProject('/work/alpha-sub', '/work/alpha')).toBe(false)
    expect(cwdIsUnderProject('/work/beta', '/work/alpha')).toBe(false)
    expect(cwdIsUnderProject('/work/alpha/sub', join('/work/alpha', sep))).toBe(true)
  })

  it('expandTildePath：~ 与 ~/x 展开，绝对路径原样', () => {
    expect(expandTildePath('~')).toBe(homedir())
    expect(expandTildePath('~/data')).toBe(join(homedir(), 'data'))
    expect(expandTildePath(' /abs/path ')).toBe('/abs/path')
    expect(expandTildePath('')).toBe('')
  })

  it('normalizeHistoryLimit：正整数钳到上限，其余回默认', () => {
    expect(normalizeHistoryLimit(undefined)).toBe(50)
    expect(normalizeHistoryLimit('80')).toBe(50)
    expect(normalizeHistoryLimit(0)).toBe(50)
    expect(normalizeHistoryLimit(-3)).toBe(50)
    expect(normalizeHistoryLimit(80)).toBe(80)
    expect(normalizeHistoryLimit(10_000)).toBe(200)
  })

  it('historyPageOf：新→旧平铺、游标严格小于过滤、nextCursor=本页最后一条', () => {
    const records = [record('s', 0, 1000), record('s', 1, 2000), record('s', 2, 3000), record('s', 3, 4000)]
    const first = historyPageOf(records, undefined, 2)
    expect(first.records.map(item => item.seq)).toEqual([3, 2])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBe(historyRecordCursor(records[2]!))

    const second = historyPageOf(records, first.nextCursor, 2)
    expect(second.records.map(item => item.seq)).toEqual([1, 0])
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeUndefined()

    // limit 超过总量：一页装下，无游标。
    const whole = historyPageOf(records, undefined, 10)
    expect(whole.records).toHaveLength(4)
    expect(whole.hasMore).toBe(false)
  })
})

describe('prompt-history persist（注解库）', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-ph-persist-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('annotations 缺席回空库；writeAnnotations 原子写且无 tmp 孤儿；读缓存往返一致', async () => {
    const warn = vi.fn()
    const store = new PromptHistoryStore({ root, logger: { warn } })
    expect(await store.annotations()).toEqual({ version: 1, comments: {}, tags: {}, groups: [] })
    const next = { version: 1 as const, comments: { 's:1': [{ id: 'c1', text: '记一笔', time: 1 }] }, tags: {}, groups: [] }
    await store.writeAnnotations(next)
    const target = join(root, 'prompt-history', 'annotations.json')
    expect(existsSync(target)).toBe(true)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(next)
    // 同一实例读缓存；换一个实例从磁盘读回同内容。
    expect(await store.annotations()).toEqual(next)
    expect(await new PromptHistoryStore({ root }).annotations()).toEqual(next)
    // 原子写的临时文件都落在 <root>/tmp 并已 rename 消费掉。
    const tmpFiles = existsSync(join(root, 'tmp')) ? await readdir(join(root, 'tmp')) : []
    expect(tmpFiles).toEqual([])
  })

  it('损坏文件：annotations 归空 + warn（写覆盖后恢复）', async () => {
    const warn = vi.fn()
    const store = new PromptHistoryStore({ root, logger: { warn } })
    await mkdir(join(root, 'prompt-history'), { recursive: true })
    await writeFile(join(root, 'prompt-history', 'annotations.json'), '{not json', 'utf8')
    expect(await store.annotations()).toEqual({ version: 1, comments: {}, tags: {}, groups: [] })
    expect(warn).toHaveBeenCalled()
    await store.writeAnnotations({ version: 1, comments: {}, tags: { 's:1': ['x'] }, groups: [] })
    expect((await store.annotations()).tags['s:1']).toEqual(['x'])
  })

  it('旧版注解文件一次性搬入：默认根 annotations.json 缺席而旧位置存在时 rename 迁移', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ph-legacy-'))
    try {
      process.env.DSH_HOME = home
      const legacy = legacyAnnotationsPath()
      await mkdir(join(legacy, '..'), { recursive: true })
      await writeFile(legacy, JSON.stringify({ version: 1, comments: { 'old:1': [{ id: 'c', text: '旧笔记', time: 5 }] }, tags: {}, groups: [] }), 'utf8')
      // 默认根 = <DSH_HOME>/plugins/DSH-better-sidebar。
      expect(defaultStorageRoot()).toBe(join(home, 'plugins', 'DSH-better-sidebar'))
      const migrated = await new PromptHistoryStore({ root: '' }).annotations()
      expect(migrated.comments['old:1']?.[0]?.text).toBe('旧笔记')
      // 搬迁是 rename：旧位置不再有文件。
      expect(existsSync(legacy)).toBe(false)
      expect(existsSync(defaultAnnotationsPath())).toBe(true)
    } finally {
      delete process.env.DSH_HOME
      await rm(home, { recursive: true, force: true })
    }
  })

  it('旧文件搬不动（目标目录不可建）：降级为读旧文件，写路径仍写新根', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ph-legacy2-'))
    try {
      process.env.DSH_HOME = home
      const legacy = legacyAnnotationsPath()
      await mkdir(join(legacy, '..'), { recursive: true })
      await writeFile(legacy, JSON.stringify({ version: 1, comments: { 'old:2': [{ id: 'c', text: '老库', time: 6 }] }, tags: {}, groups: [] }), 'utf8')
      // 把默认根上的 prompt-history 占成一个文件，mkdir/rename 必败。
      const rootFile = join(home, 'plugins', 'DSH-better-sidebar')
      await mkdir(join(home, 'plugins'), { recursive: true })
      await writeFile(rootFile, 'not a dir', 'utf8')
      const warn = vi.fn()
      const store = new PromptHistoryStore({ root: '', logger: { warn } })
      expect((await store.annotations()).comments['old:2']?.[0]?.text).toBe('老库')
      expect(existsSync(legacy)).toBe(true) // 源仍在（降级读旧文件）
      expect(warn).toHaveBeenCalled()
    } finally {
      delete process.env.DSH_HOME
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('prompt-history persist（发送记录 JSONL）', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-ph-records-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('appendRecords 落 JSONL + meta 水位；同 key 幂等；新实例重载同内容', async () => {
    const store = new PromptHistoryStore({ root })
    const key = projectKeyOf('/work/alpha')
    await store.appendRecords(key, [record('a', 1, 1000), record('a', 2, 2000)], { a: 2 })
    await store.appendRecords(key, [record('a', 2, 2000), record('b', 0, 3000)], { a: 5, b: 0 })
    const entry = await store.loadProject(key)
    expect(entry.records.map(item => [item.sessionId, item.seq])).toEqual([['a', 1], ['a', 2], ['b', 0]])
    expect(entry.watermarks).toEqual({ a: 5, b: 0 })
    const lines = (await readFile(join(root, 'prompt-history', 'records', `${key}.jsonl`), 'utf8')).trim().split('\n')
    // 幂等：key 已存在的第二次写不重复落行。
    expect(lines).toHaveLength(3)
    const meta = JSON.parse(await readFile(join(root, 'prompt-history', 'records', `${key}.meta.json`), 'utf8')) as { sessions: Record<string, number> }
    expect(meta.sessions).toEqual({ a: 5, b: 0 })
    // 新实例（模拟重启）从磁盘载入同内容。
    const reloaded = await new PromptHistoryStore({ root }).loadProject(key)
    expect(reloaded.records.map(item => item.key)).toEqual(entry.records.map(item => item.key))
    expect(reloaded.watermarks).toEqual({ a: 5, b: 0 })
  })

  it('损坏行跳过不抛；乱序记录在索引里保持 time/seq 升序', async () => {
    const key = projectKeyOf('/work/alpha')
    const dir = join(root, 'prompt-history', 'records')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${key}.jsonl`),
      [
        JSON.stringify(record('a', 2, 2000)),
        '{broken json',
        JSON.stringify({ garbage: true }),
        JSON.stringify(record('a', 1, 1000)),
        '',
      ].join('\n'),
      'utf8',
    )
    const entry = await new PromptHistoryStore({ root }).loadProject(key)
    expect(entry.records.map(item => item.seq)).toEqual([1, 2])
  })

  it('种子扫描水位续扫：meta 里的 lastSeq 决定 loadProject 后的续读起点', async () => {
    const store = new PromptHistoryStore({ root })
    const key = projectKeyOf('/work/alpha')
    await store.appendRecords(key, [record('a', 0, 100)], { a: 9 })
    const entry = await store.loadProject(key)
    expect(entry.watermarks.a).toBe(9)
    // 水位只升不降。
    await store.appendRecords(key, [], { a: 3 })
    expect((await store.loadProject(key)).watermarks.a).toBe(9)
  })

  it('超过 HISTORY_PROJECT_RECORDS_MAX：丢最旧并压实（整文件重写）', async () => {
    const store = new PromptHistoryStore({ root })
    const key = projectKeyOf('/work/alpha')
    const flood = Array.from({ length: HISTORY_PROJECT_RECORDS_MAX + 5 }, (_, index) => record('a', index, 1000 + index))
    await store.appendRecords(key, flood)
    const entry = await store.loadProject(key)
    expect(entry.records).toHaveLength(HISTORY_PROJECT_RECORDS_MAX)
    // 最旧的 5 条被丢：最小 seq 从 5 开始。
    expect(entry.records[0]!.seq).toBe(5)
    expect(entry.records.at(-1)!.seq).toBe(HISTORY_PROJECT_RECORDS_MAX + 4)
    // 文件已压实：新实例读回的行数与内存一致，没有历史残留行。
    const reloaded = await new PromptHistoryStore({ root }).loadProject(key)
    expect(reloaded.records).toHaveLength(HISTORY_PROJECT_RECORDS_MAX)
    const lines = (await readFile(join(root, 'prompt-history', 'records', `${key}.jsonl`), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(HISTORY_PROJECT_RECORDS_MAX)
  })

  it('磁盘不可写：appendRecords 只 warn 不抛，内存索引仍然完整', async () => {
    const warn = vi.fn()
    const store = new PromptHistoryStore({ root, logger: { warn } })
    const key = projectKeyOf('/work/alpha')
    // 把 records 路径占成文件，mkdir/appendFile 必败。
    await mkdir(join(root, 'prompt-history'), { recursive: true })
    await writeFile(join(root, 'prompt-history', 'records'), 'not a dir', 'utf8')
    await expect(store.appendRecords(key, [record('a', 1, 1000)])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    expect((await store.loadProject(key)).records.map(item => item.seq)).toEqual([1])
  })

  it('根变更：旧根 prompt-history 整体搬到新根，内存索引作废重载', async () => {
    let current = await mkdtemp(join(tmpdir(), 'dsh-ph-root-a-'))
    try {
      const store = new PromptHistoryStore({ root: () => current })
      const key = projectKeyOf('/work/alpha')
      await store.appendRecords(key, [record('a', 1, 1000)], { a: 1 })
      await store.writeAnnotations({ version: 1, comments: {}, tags: { 'a:1': ['t'] }, groups: [] })
      // 根切到新目录：搬迁 + 索引作废重载。
      const next = await mkdtemp(join(tmpdir(), 'dsh-ph-root-b-'))
      const previous = current
      current = next
      expect((await store.annotations()).tags['a:1']).toEqual(['t'])
      const moved = await store.loadProject(key)
      expect(moved.records.map(item => item.seq)).toEqual([1])
      expect(moved.watermarks).toEqual({ a: 1 })
      // 旧根已搬空（best-effort），新根有全量数据。
      expect(existsSync(join(previous, 'prompt-history'))).toBe(false)
      expect(existsSync(join(next, 'prompt-history', 'records', `${key}.jsonl`))).toBe(true)
      await rm(next, { recursive: true, force: true })
    } finally {
      await rm(current, { recursive: true, force: true }).catch(() => {})
    }
  })
})
