/**
 * 「历史发送」服务路由（src/prompt-history-routes.ts）：history.list 的会话
 * 枚举（list 能力 / 降级当前会话 / 服务缺席 503）、分页窗口读（整份日志从不
 * 整段驻留、活会话快照优先、逐会话跳过坏日志）、注解库的磁盘往返（缺席空库、
 * 损坏归空 + warn、tmp+rename 原子写无孤儿文件、op 校验）。
 * 持久层用假句柄模拟（seq 与数组下标对齐），磁盘落点经 DSH_HOME 指向临时目录。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPromptHistoryApi, historyStorePath } from '../src/prompt-history-routes.ts'
import { emptyAnnotations } from '../src/prompt-history-store.ts'
import { SidebarError } from '../src/wire.ts'
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

/** 最小 ctx：sessionPersistence + 空会话表 + warn 收集。 */
function makeCtx(persistence: unknown): Context {
  return {
    get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
    sessions: { get: () => undefined },
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

describe('prompt-history routes（注解库磁盘往返）', () => {
  it('文件缺席：annotationsGet 回空库（首次使用不是错误）', async () => {
    const api = buildPromptHistoryApi(makeCtx(fakePersistence().persistence))
    expect(await api['history.annotationsGet']({})).toEqual(emptyAnnotations())
  })

  it('annotationsUpdate 落盘且无 tmp 孤儿；annotationsGet 从磁盘读回（往返一致）', async () => {
    const api = buildPromptHistoryApi(makeCtx(fakePersistence().persistence))
    const store = await api['history.annotationsUpdate']({ op: 'commentAdd', key: 's:1', text: '记一笔' })
    expect(store.comments['s:1']).toHaveLength(1)
    const files = await readdir(join(home, 'plugins', 'dsh-better-sidebar'))
    expect(files).toEqual(['prompt-history.json'])
    const roundTrip = await api['history.annotationsGet']({})
    expect(roundTrip.comments['s:1']).toEqual(store.comments['s:1'])
    const onDisk = JSON.parse(await readFile(historyStorePath(), 'utf8')) as { comments: Record<string, unknown> }
    expect(onDisk.comments['s:1']).toEqual(store.comments['s:1'])
  })

  it('损坏文件：annotationsGet 归空并记 warn；写覆盖后恢复', async () => {
    const target = historyStorePath()
    await mkdirParent(target)
    await writeFile(target, '{not json', 'utf8')
    const ctx = makeCtx(fakePersistence().persistence)
    const api = buildPromptHistoryApi(ctx)
    expect(await api['history.annotationsGet']({})).toEqual(emptyAnnotations())
    expect(ctx.logger.warn).toHaveBeenCalled()
    const recovered = await api['history.annotationsUpdate']({ op: 'tagAdd', key: 's:1', tag: 'x' })
    expect(recovered.tags['s:1']).toEqual(['x'])
  })

  it('op 校验：未知 op / 缺必填字段 → bad-request 的 SidebarError', async () => {
    const api = buildPromptHistoryApi(makeCtx(fakePersistence().persistence))
    await expect(api['history.annotationsUpdate']({ op: 'explode' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(api['history.annotationsUpdate']({ op: 'commentAdd', key: 's:1' })).rejects.toBeInstanceOf(SidebarError)
    await expect(api['history.annotationsUpdate']({ op: 'groupRename', id: 'g1' })).rejects.toMatchObject({ code: 'bad-request' })
  })
})

async function mkdirParent(target: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(target), { recursive: true })
}

describe('prompt-history routes（history.list 会话枚举与降级）', () => {
  it('list 能力：多会话扫描、无发送的会话不出组、cwd 随组携带', async () => {
    const { persistence } = fakePersistence({
      headers: [
        { header: { id: 's1', cwd: '/work/alpha' } },
        { header: { id: 's2', cwd: '/work/beta' } },
        { header: { id: 's3' } },
      ],
      events: {
        s1: [userMessage(0, '一问'), filler(1), userMessage(2, '二问')],
        s2: [filler(0), filler(1)],
        s3: [userMessage(0, '三问')],
      },
    })
    const api = buildPromptHistoryApi(makeCtx(persistence))
    const result = await api['history.list']({ sessionId: 'ignored' })
    expect(result.available).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.sessions.map(session => [session.id, session.cwd, session.records.length])).toEqual([
      ['s1', '/work/alpha', 2],
      ['s3', undefined, 1],
    ])
  })

  it('无 list 能力：降级当前会话（degraded: true）；连 sessionId 也没有则空列表，不抛错', async () => {
    const { persistence } = fakePersistence({ events: { cur: [userMessage(0, '当前会话的一问')] } })
    const api = buildPromptHistoryApi(makeCtx(persistence))
    const degraded = await api['history.list']({ sessionId: 'cur' })
    expect(degraded.degraded).toBe(true)
    expect(degraded.sessions.map(session => session.id)).toEqual(['cur'])
    const empty = await api['history.list']({})
    expect(empty).toEqual({ available: true, sessions: [], degraded: true })
  })

  it('list 抛错：降级当前会话 + warn（枚举失败不冒泡）', async () => {
    const { persistence } = fakePersistence({ listError: new Error('boom'), events: { cur: [userMessage(0, '问')] } })
    const ctx = makeCtx(persistence)
    const api = buildPromptHistoryApi(ctx)
    const result = await api['history.list']({ sessionId: 'cur' })
    expect(result.degraded).toBe(true)
    expect(result.sessions).toHaveLength(1)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('persistence 服务整个缺席：503 history-error（页签内联降级的源头）', async () => {
    const api = buildPromptHistoryApi(makeCtx(undefined))
    await expect(api['history.list']({})).rejects.toMatchObject({ code: 'history-error', status: 503 })
  })

  it('单个会话读失败：跳过并 warn，其余会话照常返回', async () => {
    const { persistence } = fakePersistence({
      headers: [{ header: { id: 'bad' } }, { header: { id: 'good' } }],
      events: { good: [userMessage(0, 'ok')] },
      openErrorFor: { bad: new Error('corrupt log') },
    })
    const ctx = makeCtx(persistence)
    const api = buildPromptHistoryApi(ctx)
    const result = await api['history.list']({})
    expect(result.sessions.map(session => session.id)).toEqual(['good'])
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('活会话快照优先：sessions.get 命中时不开持久句柄', async () => {
    const { persistence, reads } = fakePersistence({ events: { live: [userMessage(0, '持久的一问')] } })
    const ctx = {
      get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
      sessions: { get: (id: string) => (id === 'live' ? { snapshotEvents: () => [userMessage(0, '活的一问'), userMessage(1, '活的二问')] } : undefined) },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const api = buildPromptHistoryApi(ctx)
    const result = await api['history.list']({ sessionId: 'live' })
    expect(result.sessions[0]!.records.map(record => record.text)).toEqual(['活的二问', '活的一问'])
    expect(reads).toHaveLength(0)
  })
})

describe('prompt-history routes（分页窗口读）', () => {
  it('大日志分窗读：句柄按窗口推进且最终关闭，只留最近 limit 条', async () => {
    // 2500 条事件（1500 问 + 1000 填充）：窗口 1000 → 至少 3 次读。
    const events = Array.from({ length: 2500 }, (_, index) => (index % 5 === 0 ? userMessage(index, `问 ${index}`) : filler(index)))
    const { persistence, reads, closed } = fakePersistence({ headers: [{ header: { id: 'big' } }], events: { big: events } })
    const api = buildPromptHistoryApi(makeCtx(persistence))
    const result = await api['history.list']({ limit: 10 })
    expect(reads.length).toBeGreaterThanOrEqual(3)
    expect(reads[0]).toMatchObject({ id: 'big', offset: 0 })
    expect(closed).toEqual(['big'])
    const session = result.sessions[0]!
    expect(session.records).toHaveLength(10)
    expect(session.truncated).toBe(true)
    // 最近的 10 条 user/message（seq 倒序交付）。
    const userSeqs = events.filter(event => event.type === 'user/message').map(event => event.seq)
    expect(session.records.map(record => record.seq)).toEqual(userSeqs.slice(-10).reverse())
  })

  it('种子会话：inheritedEventCount 切掉继承前缀，子会话不重复记账父会话的消息', async () => {
    const { persistence } = fakePersistence({
      headers: [{ header: { id: 'child' } }],
      events: { child: [userMessage(0, '父的一问'), userMessage(1, '自己的追问')] },
      inherited: { child: 1 },
    })
    const api = buildPromptHistoryApi(makeCtx(persistence))
    const result = await api['history.list']({ sessionId: 'child' })
    expect(result.sessions[0]!.records.map(record => record.text)).toEqual(['自己的追问'])
  })
})
