/**
 * The file tree's Storage cache (src/client/fs-levels-store.ts). The rules
 * under test:
 *  - SHAPE: `dsh-sidebar:fslevels:v1:<cwd>` → `{"version":1,"levels":{[dir]:
 *    {"listing":rows,"truncated"?,"ts"}}}`; an `ssh://` cwd is its own key
 *    segment.
 *  - READ: synchronous from the mirror; a fresh run loads the persisted
 *    bucket from storage (and drops a corrupt / wrong-version one).
 *  - WRITE: puts land in the mirror at once and flush to storage within the
 *    1s throttle (batched); a level whose JSON exceeds 64KB is not cached.
 *  - CAPS: 100 levels per bucket (LRU by ts), 20 buckets per store (the
 *    stalest bucket dies, storage copy included).
 *  - INVALIDATION: one cwd's whole bucket dies (mirror + storage).
 *  - DEGRADE: a throwing/unavailable localStorage never breaks the store.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fsLevelsFlushForTests,
  fsLevelsGet,
  fsLevelsInvalidate,
  fsLevelsPut,
  fsLevelsResetForTests,
} from '../src/client/fs-levels-store.ts'
import type { FsEntry } from '../src/client/api.ts'

/** A minimal directory listing row (the store never inspects the shape). */
function row(name: string): FsEntry {
  return { name, path: name, isDir: false, hidden: false, isSymlink: false, broken: false }
}

const KEY = (cwd: string): string => `dsh-sidebar:fslevels:v1:${cwd}`

function storedRaw(cwd: string): string | null {
  return localStorage.getItem(KEY(cwd))
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  fsLevelsResetForTests()
})

afterEach(() => {
  fsLevelsResetForTests()
  vi.useRealTimers()
  localStorage.clear()
})

describe('fs-levels-store (shape and read)', () => {
  it('answers a put synchronously and persists the documented shape within the throttle', () => {
    fsLevelsPut('/w', '/w/a', [row('x.txt')])
    // Synchronous read (before any flush): the instant-paint contract.
    expect(fsLevelsGet('/w', '/w/a')).toEqual({ listing: [row('x.txt')] })
    // Nothing in storage yet (the ≤1s throttle has not fired).
    expect(storedRaw('/w')).toBeNull()
    vi.advanceTimersByTime(1000)
    const raw = storedRaw('/w')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { version: number; levels: Record<string, { listing: unknown[]; ts: number }> }
    expect(parsed.version).toBe(1)
    expect(parsed.levels['/w/a']).toMatchObject({ listing: [row('x.txt')] })
    expect(typeof parsed.levels['/w/a']!.ts).toBe('number')
  })

  it('keeps an ssh:// cwd as its own bucket, isolated from the plain path', () => {
    fsLevelsPut('ssh://host/data/w', '/w/a', [row('remote')])
    fsLevelsPut('/w', '/w/a', [row('local')])
    expect(fsLevelsGet('ssh://host/data/w', '/w/a')?.listing).toEqual([row('remote')])
    expect(fsLevelsGet('/w', '/w/a')?.listing).toEqual([row('local')])
  })

  it('loads a persisted bucket from storage on first touch (a fresh run)', () => {
    localStorage.setItem(KEY('/w'), JSON.stringify({
      version: 1,
      levels: { '/w/b': { listing: [row('kept')], truncated: true, ts: 5 } },
    }))
    // No put ever ran this run: the read still answers from storage.
    expect(fsLevelsGet('/w', '/w/b')).toEqual({ listing: [row('kept')], truncated: true })
  })

  it('drops a corrupt or wrong-version bucket instead of merging it', () => {
    localStorage.setItem(KEY('/w'), '{not json')
    expect(fsLevelsGet('/w', '/w/a')).toBeUndefined()
    localStorage.setItem(KEY('/w'), JSON.stringify({ version: 99, levels: { '/w/a': { listing: [], ts: 1 } } }))
    expect(fsLevelsGet('/w', '/w/a')).toBeUndefined()
  })

  it('refuses non-listing puts (error placeholders never cache)', () => {
    // A non-array "listing" is refused outright.
    fsLevelsPut('/w', '/w/a', undefined as unknown as FsEntry[])
    vi.advanceTimersByTime(1000)
    expect(storedRaw('/w')).toBeNull()
  })
})

describe('fs-levels-store (budgets)', () => {
  it('skips a level whose JSON exceeds 64KB', () => {
    const big = row(`x${'y'.repeat(64 * 1024)}`)
    fsLevelsPut('/w', '/w/big', [big])
    fsLevelsPut('/w', '/w/small', [row('ok')])
    expect(fsLevelsGet('/w', '/w/big')).toBeUndefined()
    expect(fsLevelsGet('/w', '/w/small')).toBeDefined()
    vi.advanceTimersByTime(1000)
    const parsed = JSON.parse(storedRaw('/w')!) as { levels: Record<string, unknown> }
    expect(Object.keys(parsed.levels)).toEqual(['/w/small'])
  })

  it('keeps at most 100 levels per bucket, evicting the smallest ts first', () => {
    for (let index = 0; index < 105; index += 1) {
      fsLevelsPut('/w', `/w/d${index}`, [row(`r${index}`)])
    }
    expect(fsLevelsGet('/w', '/w/d0')).toBeUndefined()
    expect(fsLevelsGet('/w', '/w/d4')).toBeUndefined()
    expect(fsLevelsGet('/w', '/w/d5')).toBeDefined()
    expect(fsLevelsGet('/w', '/w/d104')).toBeDefined()
    vi.advanceTimersByTime(1000)
    const parsed = JSON.parse(storedRaw('/w')!) as { levels: Record<string, unknown> }
    expect(Object.keys(parsed.levels)).toHaveLength(100)
  })

  it('keeps at most 20 buckets, evicting the stalest by its newest level', () => {
    // Ten buckets stamped in the past…
    for (let bucket = 0; bucket < 25; bucket += 1) {
      fsLevelsPut(`/w${bucket}`, `/w${bucket}/a`, [row('r')])
    }
    expect(Object.keys(localStorage).filter(key => key.startsWith('dsh-sidebar:fslevels:v1:')).length).toBeLessThanOrEqual(25)
    vi.advanceTimersByTime(1000)
    const buckets = Object.keys(localStorage).filter(key => key.startsWith('dsh-sidebar:fslevels:v1:'))
    expect(buckets).toHaveLength(20)
    // The OLDEST buckets died: /w0..w4 are gone, /w24 is still there.
    expect(buckets.some(key => key.endsWith('/w0'))).toBe(false)
    expect(buckets.some(key => key.endsWith('/w4'))).toBe(false)
    expect(buckets.some(key => key.endsWith('/w24'))).toBe(true)
    expect(fsLevelsGet('/w0', '/w0/a')).toBeUndefined()
    expect(fsLevelsGet('/w24', '/w24/a')).toBeDefined()
  })
})

describe('fs-levels-store (invalidate and degrade)', () => {
  it('invalidates one whole cwd bucket (mirror and storage)', () => {
    fsLevelsPut('/w', '/w/a', [row('x')])
    fsLevelsPut('/w', '/w/b', [row('y')])
    fsLevelsPut('/other', '/other/a', [row('z')])
    vi.advanceTimersByTime(1000)
    expect(storedRaw('/w')).not.toBeNull()
    fsLevelsInvalidate('/w')
    expect(fsLevelsGet('/w', '/w/a')).toBeUndefined()
    expect(fsLevelsGet('/other', '/other/a')).toBeDefined()
    expect(storedRaw('/w')).toBeNull()
  })

  it('keeps working when localStorage throws on every touch', () => {
    const failing = {
      getItem: (): string => { throw new Error('blocked') },
      setItem: (): void => { throw new Error('quota') },
      removeItem: (): void => { throw new Error('blocked') },
      clear: (): void => {},
    }
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: failing, configurable: true, writable: true })
    try {
      expect(() => fsLevelsPut('/w', '/w/a', [row('x')])).not.toThrow()
      // The mirror still serves the instant paint.
      expect(fsLevelsGet('/w', '/w/a')).toEqual({ listing: [row('x')] })
      expect(() => {
        vi.advanceTimersByTime(1000)
        fsLevelsInvalidate('/w')
      }).not.toThrow()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true, writable: true })
    }
  })

  it('flushes pending writes immediately when asked (the page-hide path)', () => {
    fsLevelsPut('/w', '/w/a', [row('x')])
    fsLevelsFlushForTests()
    expect(storedRaw('/w')).not.toBeNull()
  })
})
