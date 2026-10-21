/**
 * Global side-thread unread tests, two halves:
 *
 * 1. the pure projection (src/sidechat-core.ts globalSideThreadRows): the
 *    WHOLE session list scanned for side threads (no parentId filter), the
 *    parent's title + workspace basename carried onto the row, archived /
 *    excluded ids dropped, parentless rows kept, newest activity first with
 *    undated rows last.
 *
 * 2. the read-watermark store (src/client/sidechat-unread.ts): mark → read
 *    → persisted payload across a "reload" (a fresh module instance over the
 *    same storage), backward/duplicate stamps ignored with notify-on-change
 *    only, corrupt payloads silent, and the injected-storage path (a stubbed
 *    globalThis.localStorage, the tests/state.spec.ts pattern) alongside the
 *    real jsdom storage this file runs under.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSessionSummary } from '../src/context-types.ts'
import { globalSideThreadRows } from '../src/sidechat-core.ts'
import type * as Unread from '../src/client/sidechat-unread.ts'

const STORAGE_KEY = 'dsh-sidebar:sidechat-read:v1'

function summary(over: Partial<SidebarSessionSummary>): SidebarSessionSummary {
  return { id: 's1', displayTitle: 'x', ...over }
}

/** A fresh module instance = a fresh page load: the store hydrates from
 *  whatever storage currently holds (the module-level singleton is the
 *  production shape, so "reload" is a re-import, not a reset API). */
async function freshStore(): Promise<typeof Unread> {
  vi.resetModules()
  return import('../src/client/sidechat-unread.ts')
}

describe('globalSideThreadRows', () => {
  it('scans the WHOLE list for side threads and carries parent title + workspace basename', () => {
    const byId: Record<string, SidebarSessionSummary> = {
      mainA: summary({ id: 'mainA', displayTitle: 'Main A', cwd: '/code/www/my/github/DSH-better-sidebar' }),
      mainB: summary({ id: 'mainB', displayTitle: 'Main B', cwd: 'D:\\code\\www\\other-workspace' }),
      threadA: summary({ id: 'threadA', origin: 'subagent', parentId: 'mainA', displayTitle: 'Side: q1', updatedAt: 300 }),
      threadB: summary({ id: 'threadB', origin: 'subagent', parentId: 'mainB', displayTitle: 'Side: q2', running: true }),
      // Same session, NOT a side thread (no label prefix): stays out.
      plain: summary({ id: 'plain', origin: 'subagent', parentId: 'mainA', displayTitle: 'Read files' }),
      // The side label on a non-subagent row: stays out too.
      misc: summary({ id: 'misc', parentId: 'mainA', displayTitle: 'Side: misc' }),
    }
    expect(globalSideThreadRows(byId)).toEqual([
      { id: 'threadA', title: 'Side: q1', running: false, parentId: 'mainA', parentTitle: 'Main A', workspaceName: 'DSH-better-sidebar', lastActivityAt: 300 },
      { id: 'threadB', title: 'Side: q2', running: true, parentId: 'mainB', parentTitle: 'Main B', workspaceName: 'other-workspace', lastActivityAt: 0 },
    ])
  })

  it('sorts by last activity descending and keeps undated rows last in list order', () => {
    const byId: Record<string, SidebarSessionSummary> = {
      p: summary({ id: 'p', displayTitle: 'P' }),
      old: summary({ id: 'old', origin: 'subagent', parentId: 'p', displayTitle: 'Side: old', updatedAt: 100 }),
      new: summary({ id: 'new', origin: 'subagent', parentId: 'p', displayTitle: 'Side: new', updatedAt: 900 }),
      undated1: summary({ id: 'undated1', origin: 'subagent', parentId: 'p', displayTitle: 'Side: u1' }),
      undated2: summary({ id: 'undated2', origin: 'subagent', parentId: 'p', displayTitle: 'Side: u2' }),
      // 0 is the catalog-fallback "no date", not the epoch.
      zero: summary({ id: 'zero', origin: 'subagent', parentId: 'p', displayTitle: 'Side: z', updatedAt: 0 }),
    }
    expect(globalSideThreadRows(byId).map(row => row.id)).toEqual(['new', 'old', 'undated1', 'undated2', 'zero'])
  })

  it('drops archived and excluded ids', () => {
    const byId: Record<string, SidebarSessionSummary> = {
      p: summary({ id: 'p', displayTitle: 'P' }),
      a: summary({ id: 'a', origin: 'subagent', parentId: 'p', displayTitle: 'Side: a', updatedAt: 3 }),
      b: summary({ id: 'b', origin: 'subagent', parentId: 'p', displayTitle: 'Side: b', updatedAt: 2 }),
      c: summary({ id: 'c', origin: 'subagent', parentId: 'p', displayTitle: 'Side: c', updatedAt: 1 }),
    }
    const rows = globalSideThreadRows(byId, { archivedIds: ['a'], excludeIds: ['b', 'missing'] })
    expect(rows.map(row => row.id)).toEqual(['c'])
  })

  it('keeps a row whose parent session is missing, with parent fields undefined', () => {
    const byId: Record<string, SidebarSessionSummary> = {
      orphan: summary({ id: 'orphan', origin: 'subagent', parentId: 'ghost', displayTitle: 'Side: orphan', updatedAt: 5 }),
    }
    expect(globalSideThreadRows(byId)).toEqual([
      { id: 'orphan', title: 'Side: orphan', running: false, parentId: 'ghost', lastActivityAt: 5 },
    ])
  })

  it('drops the workspace clause for a cwd with no usable last segment', () => {
    const byId: Record<string, SidebarSessionSummary> = {
      p: summary({ id: 'p', displayTitle: 'P' }),
      trailing: summary({ id: 'trailing', cwd: '/tmp/ws/', origin: 'subagent', parentId: 'p', displayTitle: 'Side: t' }),
      bare: summary({ id: 'bare', cwd: '', origin: 'subagent', parentId: 'p', displayTitle: 'Side: b' }),
    }
    const rows = globalSideThreadRows(byId)
    expect(rows.map(row => row.id)).toEqual(['trailing', 'bare'])
    expect(rows.every(row => row.workspaceName === undefined)).toBe(true)
  })
})

describe('sidechat read store (real localStorage)', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })

  it('marks read, lands the payload in storage, and a fresh store reads it back (reload)', async () => {
    const page1 = await freshStore()
    page1.markSidechatThreadRead('t1', 1_234)
    expect(page1.sidechatReadAt('t1')).toBe(1_234)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ t1: 1_234 })
    // "Reload": a brand-new module over the SAME storage.
    const page2 = await freshStore()
    expect(page2.sidechatReadAt('t1')).toBe(1_234)
  })

  it('reads never-marked threads as 0 and stamps the default at the next millisecond', async () => {
    const store = await freshStore()
    expect(store.sidechatReadAt('never-opened')).toBe(0)
    const before = Date.now()
    store.markSidechatThreadRead('t2')
    expect(store.sidechatReadAt('t2')).toBeGreaterThanOrEqual(before + 1)
  })

  it('ignores backward and duplicate stamps and notifies subscribers only on real changes', async () => {
    const store = await freshStore()
    let calls = 0
    const unsubscribe = store.sidechatReadStore.subscribe(() => { calls += 1 })
    store.markSidechatThreadRead('t3', 500)
    expect(calls).toBe(1)
    store.markSidechatThreadRead('t3', 500)  // duplicate stamp
    store.markSidechatThreadRead('t3', 400)  // backward stamp
    expect(calls).toBe(1)
    expect(store.sidechatReadAt('t3')).toBe(500)
    store.markSidechatThreadRead('t3', 600)
    expect(calls).toBe(2)
    unsubscribe()
  })

  it('reads corrupt / non-object payloads as "no marks" without throwing', async () => {
    const raws = ['{"t9": broken', '[1, 2]', '"text"', 'null', '{"t9":"not-a-number"}', '{"t9":0}']
    for (const raw of raws) {
      localStorage.setItem(STORAGE_KEY, raw)
      const store = await freshStore()
      expect(store.sidechatReadAt('t9')).toBe(0)
    }
    // And the store still works after a corrupt payload.
    const store = await freshStore()
    store.markSidechatThreadRead('t10', 7)
    expect(store.sidechatReadAt('t10')).toBe(7)
  })
})

describe('sidechat read store (injected storage)', () => {
  const globals = globalThis as { localStorage?: Storage }
  let original: Storage | undefined

  beforeEach(() => {
    original = globals.localStorage
  })

  afterEach(() => {
    if (original !== undefined) globals.localStorage = original
  })

  /** The tests/state.spec.ts injection pattern: a Map-backed stub swapped in
   *  over the global, so the write path is observable without a real store. */
  function injectStorage(): Map<string, string> {
    const backing = new Map<string, string>()
    globals.localStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
      removeItem: (key: string) => { backing.delete(key) },
      clear: () => { backing.clear() },
      key: () => null,
      length: 0,
    } as unknown as Storage
    return backing
  }

  it('marks and persists through the injected storage', async () => {
    const backing = injectStorage()
    const store = await freshStore()
    store.markSidechatThreadRead('t5', 42)
    expect(store.sidechatReadAt('t5')).toBe(42)
    expect(JSON.parse(backing.get(STORAGE_KEY)!)).toEqual({ t5: 42 })
  })

  it('keeps in-memory marks when the write refuses (privacy mode)', async () => {
    const backing = new Map<string, string>()
    globals.localStorage = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: () => { throw new Error('quota exceeded') },
      removeItem: (key: string) => { backing.delete(key) },
      clear: () => { backing.clear() },
      key: () => null,
      length: 0,
    } as unknown as Storage
    const store = await freshStore()
    expect(() => store.markSidechatThreadRead('t6', 99)).not.toThrow()
    // The mark holds for this page even though nothing landed in storage.
    expect(store.sidechatReadAt('t6')).toBe(99)
    expect(backing.has(STORAGE_KEY)).toBe(false)
  })

  it('survives a storage whose getItem throws', async () => {
    globals.localStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage
    const store = await freshStore()
    expect(store.sidechatReadAt('x')).toBe(0)
    expect(() => store.markSidechatThreadRead('x', 1)).not.toThrow()
    expect(store.sidechatReadAt('x')).toBe(1)
  })
})
