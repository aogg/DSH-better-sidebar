/**
 * 「历史发送」服务路由（src/prompt-history-routes.ts，新 wire 契约）：
 * history.list 的项目过滤（服务端只回当前项目的记录）、复合键分页（新→旧，
 * cursor/limit）、种子扫描懒触发（首屏立即返回 + seeding:true，扫描完成后
 * 记录出现）、降级路径（无 list 能力只扫当前会话；项目根解析不出退化为当前
 * 会话的瞬时抽取；persistence 整个缺席 503），以及注解库的磁盘往返（新根
 * `prompt-history/annotations.json`、旧文件一次性搬入、损坏归空 + warn、
 * 原子写无孤儿、op 校验）。末段直测 prompt-history-live 的实时记录与水位
 * 续扫，以及扫描期的 ws 出站契约：每次 append 的新账经 onRecords 推出（客
 * 户端免轮询的根）、扫描开始/结束各发一次 onSeed（失败路径也收尾）、byKey
 * 挡下的重复账不再出站（fresh-only，杜绝重复上屏）。持久层用假句柄模拟
 * （seq 与数组下标对齐），磁盘落点经 DSH_HOME 指向临时目录。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPromptHistoryApi, historyStorePath } from '../src/prompt-history-routes.ts'
import { projectKeyOf, PromptHistoryStore } from '../src/prompt-history-persist.ts'
import { createPromptHistoryLive } from '../src/prompt-history-live.ts'
import { emptyAnnotations } from '../src/prompt-history-store.ts'
import { SidebarError } from '../src/wire.ts'
import type { HistorySendRecord } from '../src/prompt-history-extract.ts'
import type { Context } from '../src/context-types.ts'

/** 事件夹具（seq 与数组下标对齐，假句柄按 seq 切窗）。 */
function userMessage(seq: number, text: string): { type: string; seq: number; time: number; data: Record<string, unknown> } {
  return { type: 'user/message', seq, time: 1_700_000_000_000 + seq, data: { content: [{ type: 'text', text }] } }
}
function filler(seq: number): { type: string; seq: number; time: number; data: Record<string, unknown> } {
  return { type: 'assistant/message', seq, time: 1_700_000_000_000 + seq, data: {} }
}

/** 假持久层：按 header 行 + 每会话完整事件数组模拟 open/read/list。 */
function fakePersistence(options: {
  headers?: readonly { header: Record<string, unknown> }[]
  events?: Record<string, readonly { type: string; seq: number; time: number; data: Record<string, unknown> }[]>
  inherited?: Record<string, number | undefined>
  listError?: Error
  openErrorFor?: Record<string, Error>
} = {}) {
  const reads: { id: string; offset: number; length: number | undefined }[] = []
  const closed: string[] = []
  const persistence = {
    ...(options.headers !== undefined || options.listError !== undefined
      ? {
        list: options.listError !== undefined
          ? vi.fn(async () => { throw options.listError })
          : vi.fn(async () => options.headers ?? []),
      }
      : {}),
    open: vi.fn(async (id: string, _access: 'read') => {
      const failure = options.openErrorFor?.[id]
      if (failure !== undefined) throw failure
      const events = options.events?.[id] ?? []
      return {
        header: {},
        inheritedEventCount: options.inherited?.[id],
        read: vi.fn(async (offset: number = 0, length?: number) => {
          reads.push({ id, offset, length })
          return { events: events.slice(offset, length === undefined ? undefined : offset + length) }
        }),
        close: vi.fn(async () => { closed.push(id) }),
      }
    }),
  }
  return { persistence, reads, closed }
}

/** 最小 ctx：sessionPersistence + 可选活会话表 + warn 收集。 */
function makeCtx(
  persistence: unknown,
  liveSessions: Record<string, { header?: { cwd?: string }; snapshotEvents?: () => readonly unknown[] }> = {},
): Context {
  return {
    get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
    sessions: {
      get: (id: string) => {
        const live = liveSessions[id]
        if (live === undefined) return undefined
        return {
          header: live.header ?? {},
          ...(live.snapshotEvents !== undefined ? { snapshotEvents: live.snapshotEvents } : {}),
        }
      },
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-prompt-history-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

/** 新根下的注解库文件。 */
function annotationsFile(): string {
  return join(home, 'plugins', 'DSH-better-sidebar', 'prompt-history', 'annotations.json')
}

describe('prompt-history routes（注解库磁盘往返，新根）', () => {
  it('文件缺席：annotationsGet 回空库（首次使用不是错误）', async () => {
    const ctx = makeCtx(fakePersistence().persistence)
    const api = buildPromptHistoryApi(ctx, {
      store: new PromptHistoryStore({ root: '' }),
      live: createPromptHistoryLive(ctx, new PromptHistoryStore({ root: '' })),
    })
    expect(await api['history.annotationsGet']({})).toEqual(emptyAnnotations())
  })

  it('annotationsUpdate 落盘到 <根>/prompt-history/annotations.json 且无 tmp 孤儿；读回往返一致', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar')
    const store = new PromptHistoryStore({ root })
    const ctx = makeCtx(fakePersistence().persistence)
    const api = buildPromptHistoryApi(ctx, { store, live: createPromptHistoryLive(ctx, store) })
    const updated = await api['history.annotationsUpdate']({ op: 'commentAdd', key: 's:1', text: '记一笔' })
    expect(updated.comments['s:1']).toHaveLength(1)
    expect(existsSync(annotationsFile())).toBe(true)
    const tmpDir = join(root, 'tmp')
    expect(existsSync(tmpDir) ? await readdir(tmpDir) : []).toEqual([])
    const roundTrip = await api['history.annotationsGet']({})
    expect(roundTrip.comments['s:1']).toEqual(updated.comments['s:1'])
    const onDisk = JSON.parse(await readFile(annotationsFile(), 'utf8')) as { comments: Record<string, unknown> }
    expect(onDisk.comments['s:1']).toEqual(updated.comments['s:1'])
    // historyStorePath 导出语义 = 默认根（与上面落点一致）。
    expect(historyStorePath()).toBe(annotationsFile())
  })

  it('旧版小写目录的 prompt-history.json 存在时一次性搬入新根', async () => {
    const legacy = join(home, 'plugins', 'dsh-better-sidebar', 'prompt-history.json')
    await mkdir(join(legacy, '..'), { recursive: true })
    await writeFile(legacy, JSON.stringify({ version: 1, comments: { 'old:1': [{ id: 'c', text: '旧笔记', time: 3 }] }, tags: {}, groups: [] }), 'utf8')
    const ctx = makeCtx(fakePersistence().persistence)
    const api = buildPromptHistoryApi(ctx)
    const store = await api['history.annotationsGet']({})
    expect(store.comments['old:1']?.[0]?.text).toBe('旧笔记')
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(annotationsFile())).toBe(true)
  })

  it('损坏文件：annotationsGet 归空并记 warn；写覆盖后恢复', async () => {
    await mkdir(join(annotationsFile(), '..'), { recursive: true })
    await writeFile(annotationsFile(), '{not json', 'utf8')
    const ctx = makeCtx(fakePersistence().persistence)
    const api = buildPromptHistoryApi(ctx)
    expect(await api['history.annotationsGet']({})).toEqual(emptyAnnotations())
    expect(ctx.logger.warn).toHaveBeenCalled()
    const recovered = await api['history.annotationsUpdate']({ op: 'tagAdd', key: 's:1', tag: 'x' })
    expect(recovered.tags['s:1']).toEqual(['x'])
  })

  it('op 校验：未知 op / 缺必填字段 → bad-request 的 SidebarError', async () => {
    const ctx = makeCtx(fakePersistence().persistence)
    const api = buildPromptHistoryApi(ctx)
    await expect(api['history.annotationsUpdate']({ op: 'explode' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(api['history.annotationsUpdate']({ op: 'commentAdd', key: 's:1' })).rejects.toBeInstanceOf(SidebarError)
    await expect(api['history.annotationsUpdate']({ op: 'groupRename', id: 'g1' })).rejects.toMatchObject({ code: 'bad-request' })
  })
})

describe('prompt-history routes（history.list：项目过滤 / 分页 / 种子扫描）', () => {
  /** 当前会话 cur（活会话，cwd=/work/alpha）+ 持久层 3 会话。持久日志与活
   *  快照同一份（dsh 的 durable log 本就随事件落盘）。 */
  function projectFixture() {
    const { persistence } = fakePersistence({
      headers: [
        { header: { id: 's1', cwd: '/work/alpha' } },
        { header: { id: 's2', cwd: '/work/alpha/sub' } },
        { header: { id: 's3', cwd: '/work/beta' } },
      ],
      events: {
        s1: [userMessage(0, 's1 一问'), filler(1), userMessage(2, 's1 二问')],
        s2: [userMessage(0, 's2 子目录一问')],
        s3: [userMessage(0, 's3 别的项目')],
        cur: [userMessage(0, 'cur 当前的一问'), userMessage(1, 'cur 追问')],
      },
    })
    const ctx = makeCtx(persistence, {
      cur: { header: { cwd: '/work/alpha' }, snapshotEvents: () => [userMessage(0, 'cur 当前的一问'), userMessage(1, 'cur 追问')] },
    })
    return { ctx }
  }

  it('项目过滤在服务端做完：只回当前项目的记录，新→旧平铺；首屏 seeding:true，扫完出记录', async () => {
    const { ctx } = projectFixture()
    const api = buildPromptHistoryApi(ctx)
    const first = await api['history.list']({ sessionId: 'cur' })
    expect(first.available).toBe(true)
    expect(first.project).toEqual({ cwd: '/work/alpha' })
    expect(first.seeding).toBe(true)
    expect(first.hasMore).toBe(false)
    expect(first.degraded).toBeUndefined() // 扫描未完成，降级态未知

    // 扫描在后台完成：seeding 翻 false，记录只含当前项目（s3 不出现）。
    // 复合键序：time 定长字典序，同 time 的记录按 sessionId 字典序倒序。
    let second!: Awaited<ReturnType<typeof api['history.list']>>
    await vi.waitFor(async () => {
      second = await api['history.list']({ sessionId: 'cur' })
      expect(second.seeding).toBe(false)
    })
    expect(second.degraded).toBe(false)
    expect(second.records.map(record => record.text)).toEqual([
      's1 二问', 'cur 追问', 's2 子目录一问', 's1 一问', 'cur 当前的一问',
    ])
    expect(second.records.every(record => record.sessionId !== 's3')).toBe(true)
  })

  it('分页：limit 截页、nextCursor 续读、hasMore 收口', async () => {
    const { ctx } = projectFixture()
    const api = buildPromptHistoryApi(ctx)
    await vi.waitFor(async () => {
      const settled = await api['history.list']({ sessionId: 'cur' })
      expect(settled.seeding).toBe(false)
    })
    const first = await api['history.list']({ sessionId: 'cur', limit: 2 })
    expect(first.records.map(record => record.text)).toEqual(['s1 二问', 'cur 追问'])
    expect(first.hasMore).toBe(true)
    expect(typeof first.nextCursor).toBe('string')
    const second = await api['history.list']({ sessionId: 'cur', cursor: first.nextCursor, limit: 2 })
    expect(second.records.map(record => record.text)).toEqual(['s2 子目录一问', 's1 一问'])
    expect(second.hasMore).toBe(true)
    const third = await api['history.list']({ sessionId: 'cur', cursor: second.nextCursor, limit: 2 })
    expect(third.records.map(record => record.text)).toEqual(['cur 当前的一问'])
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeUndefined()
  })

  it('无 list 能力：只扫当前会话（degraded: true），记录仍来自持久仓', async () => {
    const { persistence } = fakePersistence({ events: { cur: [userMessage(0, '当前会话的一问')] } })
    const ctx = makeCtx(persistence, { cur: { header: { cwd: '/work/alpha' } } })
    const api = buildPromptHistoryApi(ctx)
    let result!: Awaited<ReturnType<typeof api['history.list']>>
    await vi.waitFor(async () => {
      result = await api['history.list']({ sessionId: 'cur' })
      expect(result.seeding).toBe(false)
    })
    expect(result.degraded).toBe(true)
    expect(result.project).toEqual({ cwd: '/work/alpha' })
    expect(result.records.map(record => record.text)).toEqual(['当前会话的一问'])
  })

  it('list 抛错：降级只扫当前会话 + warn（枚举失败不冒泡）', async () => {
    const { persistence } = fakePersistence({ listError: new Error('boom'), events: { cur: [userMessage(0, '问')] } })
    const ctx = makeCtx(persistence, { cur: { header: { cwd: '/work/alpha' } } })
    const api = buildPromptHistoryApi(ctx)
    let result!: Awaited<ReturnType<typeof api['history.list']>>
    await vi.waitFor(async () => {
      result = await api['history.list']({ sessionId: 'cur' })
      expect(result.seeding).toBe(false)
    })
    expect(result.degraded).toBe(true)
    expect(result.records.map(record => record.text)).toEqual(['问'])
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('persistence 服务整个缺席且项目根解析不出：503 history-error（页签内联降级的源头）', async () => {
    const api = buildPromptHistoryApi(makeCtx(undefined))
    await expect(api['history.list']({ sessionId: 'ghost' })).rejects.toMatchObject({ code: 'history-error', status: 503 })
  })

  it('项目根解析不出：退化为当前会话的瞬时抽取（degraded，不落盘），活快照优先不开持久句柄', async () => {
    const { persistence, reads } = fakePersistence({ events: { headless: [userMessage(0, '持久的一问')] } })
    const ctx = makeCtx(persistence, {
      headless: { snapshotEvents: () => [userMessage(0, '活的一问'), userMessage(1, '活的二问')] },
    })
    const api = buildPromptHistoryApi(ctx)
    const result = await api['history.list']({ sessionId: 'headless' })
    expect(result.project).toBeUndefined()
    expect(result.degraded).toBe(true)
    expect(result.seeding).toBe(false)
    expect(result.records.map(record => record.text)).toEqual(['活的二问', '活的一问'])
    // 活快照赢下记录读取；唯一的持久读是项目根解析的 header 探针（不带窗长
    // 的整读），记录读取没有走分窗路径（那会带 HISTORY_READ_WINDOW 的窗长）。
    expect(reads.every(read => read.length === undefined)).toBe(true)
  })
})

describe('prompt-history routes（history.list scope=session：会话内过滤 + 独立分页 + limit 透传）', () => {
  /** 一条内存记录（直接入仓，绕开扫描等待；时间决定新→旧序）。 */
  function rec(sessionId: string, seq: number, time: number, text: string): HistorySendRecord {
    return { key: `${sessionId}:${seq}`, sessionId, seq, time, text, textTruncated: false }
  }

  /** 仓库夹具：'cur'/'s1' 活会话定位项目根（客户端的现实用法里，sessionId
   *  就是当前活会话——项目根由它解析，过滤也在同一字段上做）；records 直接
   *  appendRecords 入仓。持久层 events 留空 + 这两个头，后台种子扫描不会添
   *  乱（幂等也无账可扫），断言对内存索引完全确定。 */
  async function scopeFixture(seed: readonly HistorySendRecord[]) {
    const { persistence } = fakePersistence({
      headers: [
        { header: { id: 'cur', cwd: '/work/alpha' } },
        { header: { id: 's1', cwd: '/work/alpha' } },
      ],
      events: {},
    })
    const ctx = makeCtx(persistence, {
      cur: { header: { cwd: '/work/alpha' } },
      s1: { header: { cwd: '/work/alpha' } },
    })
    const store = new PromptHistoryStore({ root: join(home, 'scope-store') })
    if (seed.length > 0) await store.appendRecords(projectKeyOf('/work/alpha'), seed)
    return { ctx, store, api: buildPromptHistoryApi(ctx, { store }) }
  }

  const SEED = [
    ...Array.from({ length: 25 }, (_, index) => rec('s1', index, 1_700_000_000_000 + index, `s1 第 ${index} 问`)),
    ...Array.from({ length: 5 }, (_, index) => rec('s2', index, 1_700_001_000_000 + index, `s2 第 ${index} 问`)),
    rec('cur', 0, 1_700_002_000_000, 'cur 当前的一问'),
  ]

  it('scope=session 只回该会话的记录；分页在该会话内独立收口（cursor/hasMore 不串别的会话）', async () => {
    const { api } = await scopeFixture(SEED)
    const first = await api['history.list']({ sessionId: 's1', scope: 'session', limit: 2 })
    expect(first.records.map(record => record.sessionId)).toEqual(['s1', 's1'])
    expect(first.records.map(record => record.text)).toEqual(['s1 第 24 问', 's1 第 23 问'])
    expect(first.hasMore).toBe(true)
    const second = await api['history.list']({ sessionId: 's1', scope: 'session', cursor: first.nextCursor, limit: 2 })
    expect(second.records.map(record => record.text)).toEqual(['s1 第 22 问', 's1 第 21 问'])
    expect(second.hasMore).toBe(true)
    // 一路翻到底：只在 s1 的 25 条里收口，s2/cur 的记录绝不出现。
    let page = second
    let guard = 0
    while (page.hasMore && guard < 20) {
      page = await api['history.list']({ sessionId: 's1', scope: 'session', cursor: page.nextCursor, limit: 2 })
      guard += 1
    }
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
    expect(page.records.at(-1)?.text).toBe('s1 第 0 问')
    const all = await api['history.list']({ sessionId: 's1', scope: 'session', limit: 200 })
    expect(all.records).toHaveLength(25)
    expect(all.records.every(record => record.sessionId === 's1')).toBe(true)
  })

  it('limit 由客户端显式透传（会话 tab 20 / 当前默认 50 不变），服务端默认值不动', async () => {
    const { api } = await scopeFixture(SEED)
    // 会话 tab 的每页 20：25 条里截 20，hasMore 收口。
    const sessionTab = await api['history.list']({ sessionId: 's1', scope: 'session', limit: 20 })
    expect(sessionTab.records).toHaveLength(20)
    expect(sessionTab.hasMore).toBe(true)
    // 不带 limit：默认 50（HISTORY_PAGE_DEFAULT 不动）——s1 只有 25 条，全回。
    const fallback = await api['history.list']({ sessionId: 's1', scope: 'session' })
    expect(fallback.records).toHaveLength(25)
    expect(fallback.hasMore).toBe(false)
    // project 作用域同样吃显式 limit：8+ 仓里 limit 3 就回 3 条。
    const projectTab = await api['history.list']({ sessionId: 'cur', scope: 'project', limit: 3 })
    expect(projectTab.records).toHaveLength(3)
    expect(projectTab.hasMore).toBe(true)
    // 超上限 200 钳到 200（既有 normalizeHistoryLimit 契约不变）。
    const clamped = await api['history.list']({ sessionId: 's1', scope: 'session', limit: 10_000 })
    expect(clamped.records).toHaveLength(25)
  })

  it('wire 向后兼容：不带 scope = project 全量跨会话平铺（老客户端行为不变）', async () => {
    const { api } = await scopeFixture(SEED)
    const legacy = await api['history.list']({ sessionId: 'cur' })
    expect(legacy.records).toHaveLength(SEED.length)
    expect(new Set(legacy.records.map(record => record.sessionId))).toEqual(new Set(['s1', 's2', 'cur']))
    // 显式 scope:'project' 与缺省完全同参。
    const explicit = await api['history.list']({ sessionId: 'cur', scope: 'project' })
    expect(explicit.records.map(record => record.key)).toEqual(legacy.records.map(record => record.key))
  })

  it('scope=session 但 sessionId 缺席：空页（不是错误，也不回退成 project 全量）', async () => {
    const { api } = await scopeFixture(SEED)
    const empty = await api['history.list']({ scope: 'session', limit: 50 })
    expect(empty.records).toEqual([])
    expect(empty.hasMore).toBe(false)
  })

  it('降级路径（项目根解析不出）下 scope=session 一样只回当前会话的瞬时抽取', async () => {
    const { persistence } = fakePersistence({ events: { headless: [userMessage(0, '持久的一问')] } })
    const ctx = makeCtx(persistence, {
      headless: { snapshotEvents: () => [userMessage(0, '活的一问'), userMessage(1, '活的二问')] },
    })
    const api = buildPromptHistoryApi(ctx)
    const result = await api['history.list']({ sessionId: 'headless', scope: 'session', limit: 50 })
    expect(result.degraded).toBe(true)
    expect(result.records.map(record => record.text)).toEqual(['活的二问', '活的一问'])
  })
})

describe('prompt-history live（实时记录与水位续扫）', () => {
  /** 带事件源的 ctx（测试直接驱动 ctx.on 的 session/event）。 */
  function eventCtx(options: {
    persistence?: unknown
    liveSessions?: Record<string, { header?: { cwd?: string }; snapshotEvents?: () => readonly unknown[] }>
  }): { ctx: Context; emit: (session: unknown, event: unknown) => void } {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const base = makeCtx(options.persistence, options.liveSessions)
    const ctx = {
      ...base,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        let set = listeners.get(event)
        if (set === undefined) listeners.set(event, set = new Set())
        set.add(listener)
        return () => { set.delete(listener) }
      },
    } as unknown as Context
    return {
      ctx,
      emit: (session, event) => {
        for (const listener of [...(listeners.get('session/event') ?? [])]) listener(session, event)
      },
    }
  }

  it('user/message 事件实时入仓并通知 sink；注入消息被过滤；ctx.on 缺席静默跳过', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar', 'live-a')
    const { ctx, emit } = eventCtx({ liveSessions: { cur: { header: { cwd: '/work/alpha' } } } })
    const store = new PromptHistoryStore({ root })
    const live = createPromptHistoryLive(ctx, store, { logger: ctx.logger })
    const seen: { sessionId: string; texts: string[] }[] = []
    live.onRecords((sessionId, records) => { seen.push({ sessionId, texts: records.map(record => record.text) }) })

    emit({ id: 'cur' }, userMessage(7, '实时一问'))
    emit({ id: 'cur' }, {
      type: 'user/message', seq: 8, time: 1_700_000_000_008,
      data: { content: [{ type: 'text', text: '边界注入' }], source: { kind: 'plugin' } },
    })
    emit({ id: 'cur' }, filler(9))
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect(seen[0]).toEqual({ sessionId: 'cur', texts: ['实时一问'] })
    const entry = await store.loadProject(projectKeyOf('/work/alpha'))
    expect(entry.records.map(record => record.text)).toEqual(['实时一问'])
    expect(entry.watermarks.cur).toBe(7)
    live.dispose()
  })

  it('水位续扫：meta 里的 lastSeq 之后的窗口才进记录（重启空窗不重复记账）', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar', 'live-b')
    const { persistence } = fakePersistence({
      events: { s1: [userMessage(0, '旧一问'), userMessage(1, '旧二问'), filler(2), userMessage(3, '新一问'), userMessage(4, '新二问')] },
    })
    const ctx = makeCtx(persistence)
    const writer = new PromptHistoryStore({ root })
    const key = projectKeyOf('/work/alpha')
    // 预置水位（模拟上一次运行的落盘）：s1 已扫到 seq 1，旧一问/旧二问不再进记录。
    await writer.appendRecords(key, [], { s1: 1 })
    // 新的仓实例 = dsh 重启后的内存态（水位只在磁盘 meta 里）。
    const store = new PromptHistoryStore({ root })
    const live = createPromptHistoryLive(ctx, store, { logger: ctx.logger })
    // 无 list 能力的假持久层：扫描范围降级为当前会话（这里显式指 s1）。
    live.kick(key, '/work/alpha', 's1')
    await vi.waitFor(() => { expect(live.isSeeding(key)).toBe(false) })
    const entry = await store.loadProject(key)
    expect(entry.records.map(record => record.text)).toEqual(['新一问', '新二问'])
    expect(entry.watermarks.s1).toBe(4)
    live.dispose()
  })

  it('种子扫描按 header.cwd 过滤项目，且同项目并发 kick 只扫一次', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar', 'live-c')
    const { persistence } = fakePersistence({
      headers: [
        { header: { id: 's1', cwd: '/work/alpha' } },
        { header: { id: 's2', cwd: '/work/beta' } },
      ],
      events: {
        s1: [userMessage(0, '项目一问')],
        s2: [userMessage(0, '别的项目')],
      },
    })
    const ctx = makeCtx(persistence)
    const store = new PromptHistoryStore({ root })
    const live = createPromptHistoryLive(ctx, store, { logger: ctx.logger })
    const key = projectKeyOf('/work/alpha')
    live.kick(key, '/work/alpha')
    live.kick(key, '/work/alpha') // 并发防重入
    await vi.waitFor(() => { expect(live.isSeeding(key)).toBe(false) })
    const entry = await store.loadProject(key)
    expect(entry.records.map(record => record.text)).toEqual(['项目一问'])
    expect(persistence.open).toHaveBeenCalledTimes(1)
    live.dispose()
  })
})

describe('prompt-history live（扫描期 ws 推送与 seeding 状态帧）', () => {
  it('扫描期每次 append 的新账都经 onRecords 推出（客户端免轮询的根）', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar', 'seed-push')
    const { persistence } = fakePersistence({
      headers: [{ header: { id: 's1', cwd: '/work/alpha' } }],
      events: { s1: [userMessage(0, '扫出一问'), filler(1), userMessage(2, '扫出二问')] },
    })
    const ctx = makeCtx(persistence)
    const store = new PromptHistoryStore({ root })
    const live = createPromptHistoryLive(ctx, store, { logger: ctx.logger })
    const pushed: { sessionId: string; texts: string[] }[] = []
    live.onRecords((sessionId, records) => { pushed.push({ sessionId, texts: records.map(record => record.text) }) })
    live.kick(projectKeyOf('/work/alpha'), '/work/alpha', 's1')
    await vi.waitFor(() => { expect(pushed.map(batch => batch.texts).flat()).toEqual(['扫出一问', '扫出二问']) })
    expect(pushed.every(batch => batch.sessionId === 's1')).toBe(true)
    live.dispose()
  })

  it('扫描开始/结束各发一次 onSeed（项目根同 history.list 的 project.cwd）；失败路径也收尾', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar', 'seed-state')
    const { persistence } = fakePersistence({
      headers: [{ header: { id: 's1', cwd: '/work/alpha' } }],
      events: { s1: [userMessage(0, '一问')] },
    })
    const ctx = makeCtx(persistence)
    const store = new PromptHistoryStore({ root })
    const live = createPromptHistoryLive(ctx, store, { logger: ctx.logger })
    const states: { cwd: string; seeding: boolean }[] = []
    live.onSeed((cwd, seeding) => { states.push({ cwd, seeding }) })
    const key = projectKeyOf('/work/alpha')
    live.kick(key, '/work/alpha', 's1')
    await vi.waitFor(() => { expect(live.isSeeding(key)).toBe(false) })
    expect(states).toEqual([
      { cwd: '/work/alpha', seeding: true },
      { cwd: '/work/alpha', seeding: false },
    ])
    // open 失败的会话逐会话跳过，但收尾帧照样发（失败路径也必须熄客户端的提示条）。
    const failing = fakePersistence({
      headers: [{ header: { id: 'bad', cwd: '/work/alpha' } }],
      openErrorFor: { bad: new Error('boom') },
    })
    const ctx2 = makeCtx(failing.persistence)
    const live2 = createPromptHistoryLive(ctx2, new PromptHistoryStore({ root }), { logger: ctx2.logger })
    const states2: boolean[] = []
    live2.onSeed((_cwd, seeding) => { states2.push(seeding) })
    live2.kick(key, '/work/alpha', 'bad')
    await vi.waitFor(() => { expect(live2.isSeeding(key)).toBe(false) })
    expect(states2).toEqual([true, false])
    live.dispose()
    live2.dispose()
  })

  it('扫描已记账的消息再走实时事件：byKey 挡下后 ws 不再推（fresh-only，杜绝重复出站）', async () => {
    const root = join(home, 'plugins', 'DSH-better-sidebar', 'seed-fresh-only')
    const { persistence } = fakePersistence({
      headers: [{ header: { id: 's1', cwd: '/work/alpha' } }],
      events: { s1: [userMessage(0, '已在账的一问')] },
    })
    const ctx = makeCtx(persistence, { s1: { header: { cwd: '/work/alpha' } } })
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    const eventCtxValue = {
      ...ctx,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        let set = listeners.get(event)
        if (set === undefined) listeners.set(event, set = new Set())
        set.add(listener)
        return () => { set.delete(listener) }
      },
    } as unknown as Context
    const store = new PromptHistoryStore({ root })
    const live = createPromptHistoryLive(eventCtxValue, store, { logger: ctx.logger })
    const pushed: string[] = []
    live.onRecords((_sessionId, records) => { pushed.push(...records.map(record => record.text)) })
    // 先扫描记账。
    live.kick(projectKeyOf('/work/alpha'), '/work/alpha', 's1')
    await vi.waitFor(() => { expect(live.isSeeding(projectKeyOf('/work/alpha'))).toBe(false) })
    pushed.length = 0
    // 同一条消息再从实时事件到达（seq 相同 → key 相同）：存储幂等挡下后，ws 也必须沉默。
    for (const listener of [...(listeners.get('session/event') ?? [])]) {
      listener({ id: 's1' }, userMessage(0, '已在账的一问'))
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(pushed).toEqual([])
    expect((await store.loadProject(projectKeyOf('/work/alpha'))).records).toHaveLength(1)
    live.dispose()
  })
})
