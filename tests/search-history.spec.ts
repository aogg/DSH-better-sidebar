/**
 * search-history: the search page's localStorage query history (key
 * `dsh-sidebar:search-history:v1`). Pinned here (design doc §4.3 / §8):
 * the dedup key (`query + include + exclude`, arrays in order), newest-first
 * insertion with move-to-front on re-submit, the 20-entry cap dropping the
 * tail, single-row deletion (key AND `at` identity), corrupt-JSON and
 * privacy-mode degradation to the in-memory list, and the `storage`-event
 * notification that drives both same-document and cross-tab refreshes.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SEARCH_HISTORY_KEY,
  SEARCH_HISTORY_MAX,
  historyKeyOf,
  readSearchHistory,
  removeSearchHistory,
  subscribeSearchHistory,
  upsertSearchHistory,
  type SearchHistoryEntry,
} from '../src/client/search-history.ts'

/** A factory with a per-call stamp so every entry has its own `at`. */
let stamp = 0
function entry(query: string, include: string[] = [], exclude: string[] = []): SearchHistoryEntry {
  stamp += 1
  return { query, include, exclude, at: stamp }
}

/** Seed the store directly (bypassing the module's write path). */
function seedStorage(entries: unknown[]): void {
  window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(entries))
}

describe('search-history storage contract', () => {
  beforeEach(() => {
    // A VALID empty list (not clear()): reads must come from storage so the
    // module's in-memory fallback never leaks state between tests.
    window.localStorage.setItem(SEARCH_HISTORY_KEY, '[]')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('uses the design-pinned key family member and a 20-entry cap', () => {
    expect(SEARCH_HISTORY_KEY).toBe('dsh-sidebar:search-history:v1')
    expect(SEARCH_HISTORY_MAX).toBe(20)
  })

  it('corrupt JSON degrades silently to the (empty) in-memory list', () => {
    // Runs BEFORE any write in this file, so the memory fallback is still
    // the fresh module state: nothing throws, nothing is invented.
    window.localStorage.setItem(SEARCH_HISTORY_KEY, '{not json')
    expect(readSearchHistory()).toEqual([])
  })

  it('drops corrupt rows instead of trusting them; a valid row survives', () => {
    seedStorage([
      'a string',
      null,
      { include: [], exclude: [] }, // no query
      { query: '', include: [], exclude: [] }, // empty query
      { query: 42, include: [], exclude: [] }, // non-string query
      { query: 'ok', include: 'src', exclude: [] }, // non-array chips
      { query: 'ok2', include: [1], exclude: [] }, // non-string chip
      { query: 'real', include: ['src'], exclude: ['dist'], at: 7 },
    ])
    expect(readSearchHistory()).toEqual([
      { query: 'real', include: ['src'], exclude: ['dist'], at: 7 },
    ])
    // A missing `at` degrades to 0 rather than dropping a well-shaped row.
    seedStorage([{ query: 'noat', include: [], exclude: [] }])
    expect(readSearchHistory()).toEqual([{ query: 'noat', include: [], exclude: [], at: 0 }])
  })

  it('upsert records newest-first with the submitted three fields', () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, '[]')
    upsertSearchHistory({ query: 'first', include: ['src'], exclude: [] })
    upsertSearchHistory({ query: 'second', include: [], exclude: ['dist'] })
    const history = readSearchHistory()
    expect(history.map(item => item.query)).toEqual(['second', 'first'])
    expect(history[0]).toMatchObject({ query: 'second', include: [], exclude: ['dist'] })
    expect(typeof history[0]!.at).toBe('number')
  })

  it('re-submitting the same shape moves it to the front (dedup by query+include+exclude)', () => {
    const one = entry('answer', ['src'], [])
    const two = entry('other')
    upsertSearchHistory(one)
    upsertSearchHistory(two)
    upsertSearchHistory({ ...one }) // same query + chips, new at
    const history = readSearchHistory()
    expect(history).toHaveLength(2)
    expect(history.map(item => item.query)).toEqual(['answer', 'other'])
    // The moved entry carries a FRESH stamp (a new submit happened).
    expect(history[0]!.at).not.toBe(one.at)
  })

  it('the dedup key is sensitive to chip ORDER, not just content', () => {
    expect(historyKeyOf({ query: 'q', include: ['a', 'b'], exclude: [] }))
      .not.toBe(historyKeyOf({ query: 'q', include: ['b', 'a'], exclude: [] }))
    expect(historyKeyOf({ query: 'q', include: [], exclude: ['x'] }))
      .not.toBe(historyKeyOf({ query: 'q', include: [], exclude: [] }))
    // The `\0` joins keep compound texts unambiguous.
    expect(historyKeyOf({ query: 'a', include: ['b'], exclude: [] }))
      .not.toBe(historyKeyOf({ query: 'a', include: [], exclude: ['b'] }))
  })

  it('gitFrom rides the dedup key; an absent field and \'\' key identically (backward compatible)', () => {
    const plain = { query: 'q', include: [], exclude: [] }
    expect(historyKeyOf(plain)).toBe(historyKeyOf({ ...plain, gitFrom: '' }))
    expect(historyKeyOf(plain)).not.toBe(historyKeyOf({ ...plain, gitFrom: 'HEAD~1' }))
    // Same query + chips, different 起点 → three DISTINCT entries.
    upsertSearchHistory({ query: 'q', include: [], exclude: [], gitFrom: 'HEAD~1' })
    upsertSearchHistory({ query: 'q', include: [], exclude: [], gitFrom: 'v1.2.0' })
    upsertSearchHistory({ query: 'q', include: [], exclude: [] })
    expect(readSearchHistory().map(item => item.gitFrom)).toEqual([undefined, 'v1.2.0', 'HEAD~1'])
    // Re-submitting one shape moves THAT entry to the front only.
    upsertSearchHistory({ query: 'q', include: [], exclude: [], gitFrom: 'HEAD~1' })
    expect(readSearchHistory().map(item => item.gitFrom)).toEqual(['HEAD~1', undefined, 'v1.2.0'])
  })

  it('a stored gitFrom survives the read; a corrupt (non-string) one reads as absent', () => {
    seedStorage([
      { query: 'ok', include: [], exclude: [], gitFrom: 'abc1234', at: 1 },
      { query: 'bad', include: [], exclude: [], gitFrom: 42, at: 2 },
      { query: 'legacy', include: [], exclude: [], at: 3 },
    ])
    expect(readSearchHistory()).toEqual([
      { query: 'ok', include: [], exclude: [], gitFrom: 'abc1234', at: 1 },
      { query: 'bad', include: [], exclude: [], at: 2 },
      { query: 'legacy', include: [], exclude: [], at: 3 },
    ])
  })

  it('upsert with an empty gitFrom stores the field ABSENT (the pre-gitFrom shape)', () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, '[]')
    upsertSearchHistory({ query: 'q', include: [], exclude: [], gitFrom: '' })
    const raw = JSON.parse(window.localStorage.getItem(SEARCH_HISTORY_KEY)!) as Array<Record<string, unknown>>
    expect('gitFrom' in raw[0]!).toBe(false)
  })

  it('caps at 20 entries and drops the tail', () => {
    for (let index = 0; index < 25; index += 1) {
      upsertSearchHistory({ query: `q${index}`, include: [], exclude: [] })
    }
    const history = readSearchHistory()
    expect(history).toHaveLength(SEARCH_HISTORY_MAX)
    expect(history[0]!.query).toBe('q24')
    expect(history.map(item => item.query)).toEqual(
      Array.from({ length: 20 }, (_, index) => `q${24 - index}`),
    )
  })

  it('removeSearchHistory deletes by dedup key AND at-stamp', () => {
    const kept = entry('answer', ['src'], [])
    const twin = { ...kept, at: kept.at + 1000 } // same shape, other stamp
    seedStorage([kept, twin])
    // Removing the TWIN must not take the identically-shaped original.
    removeSearchHistory(twin)
    expect(readSearchHistory()).toEqual([kept])
    removeSearchHistory(kept)
    expect(readSearchHistory()).toEqual([])
  })

  it('localStorage that throws wholesale (privacy mode) degrades to the in-memory list', () => {
    const bomb = (): never => { throw new Error('storage blocked') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(bomb)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(bomb)
    // Reads survive; writes land in memory and come back newest-first (the
    // assertions are RELATIVE to whatever the fallback carried in — the
    // degrade contract does not depend on the module's history).
    const before = readSearchHistory().map(item => item.query)
    const recorded = upsertSearchHistory({ query: 'offline', include: [], exclude: [] })
    expect(recorded).toHaveLength(before.length + 1)
    expect(recorded[0]!.query).toBe('offline')
    expect(readSearchHistory().map(item => item.query)).toEqual(['offline', ...before])
    upsertSearchHistory({ query: 'offline two', include: [], exclude: [] })
    expect(readSearchHistory().map(item => item.query)).toEqual(['offline two', 'offline', ...before])
  })

  it('writes notify subscribers with a synthetic storage event; real events ride the same channel', () => {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, '[]')
    const listener = vi.fn()
    const unsubscribe = subscribeSearchHistory(listener)
    upsertSearchHistory({ query: 'notifying', include: [], exclude: [] })
    expect(listener).toHaveBeenCalledTimes(1)
    // A sibling document's write arrives as a real storage event — the SAME
    // listener kind refreshes the open dropdown.
    window.dispatchEvent(new StorageEvent('storage', { key: SEARCH_HISTORY_KEY }))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    upsertSearchHistory({ query: 'silent', include: [], exclude: [] })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
