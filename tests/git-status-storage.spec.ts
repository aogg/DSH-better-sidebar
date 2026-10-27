/**
 * The git-status snapshot cache (`src/client/ui/git-status-storage.ts`):
 * the persistence layer behind the store's "colors are already on when the
 * page opens" promise. Under test:
 *
 *  - ROUNDTRIP: a written snapshot reads back as the same GitStatusResult —
 *    including the three counts variants (no counts / numeric / binary)
 *    that the compact entry encoding must never collapse into each other.
 *  - TOLERANCE: every malformed document — torn JSON, a foreign schema
 *    version, a bad entry tuple, a missing timestamp — reads as "no
 *    cache", never throws.
 *  - SKIP: a non-repo snapshot carries nothing worth pre-coloring and is
 *    not written at all.
 *  - LRU: the key prefix holds at most 8 documents; the oldest-WRITTEN
 *    ones go first (a slot the user stopped visiting ages away).
 *  - DEGRADE: storage unavailable → reads are empty, writes are silent.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../src/client/api.ts'
import { GIT_STATUS_STORE_LIMIT, gitStatusStorageKey, readGitStatusSnapshot, sweepGitStatusStore, writeGitStatusSnapshot } from '../src/client/ui/git-status-storage.ts'

const SNAPSHOT: GitStatusResult = {
  isRepo: true,
  root: '/tmp',
  branch: 'main',
  entries: [
    { path: 'plain.ts', xy: ' M' },
    { path: 'counted.ts', xy: 'M ', counts: { additions: 3, deletions: 1 } },
    { path: 'binary.png', xy: 'M ', counts: { binary: true } },
  ],
  truncated: true,
  ignored: ['node_modules/', 'logo.gen.png'],
  ignoredTruncated: true,
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('gitStatusStorageKey', () => {
  it('derives one stable key per slot identity', () => {
    const first = gitStatusStorageKey('s1', '/tmp', undefined)
    expect(first).toBe(gitStatusStorageKey('s1', '/tmp', undefined))
    expect(first.startsWith('dsh-sidebar:v1:git-status:s1:')).toBe(true)
    // Distinct cwd or worktree → distinct key; sessionId stays readable.
    expect(gitStatusStorageKey('s1', '/other', undefined)).not.toBe(first)
    expect(gitStatusStorageKey('s1', '/tmp', '/linked')).not.toBe(first)
    expect(gitStatusStorageKey('s2', '/tmp', undefined)).not.toBe(first)
  })
})

describe('snapshot roundtrip', () => {
  it('reads back what was written, counts variants intact', () => {
    const key = gitStatusStorageKey('s1', '/tmp', undefined)
    writeGitStatusSnapshot(key, SNAPSHOT)
    expect(readGitStatusSnapshot(key)).toEqual(SNAPSHOT)
  })

  it('skips non-repo snapshots entirely (nothing to pre-color)', () => {
    const key = gitStatusStorageKey('s1', '/tmp', undefined)
    writeGitStatusSnapshot(key, { isRepo: false, entries: [], repositories: [] })
    expect(localStorage.getItem(key)).toBeNull()
    expect(readGitStatusSnapshot(key)).toBeNull()
  })
})

describe('tolerant reads', () => {
  it('answers null for a missing, torn or foreign document', () => {
    const key = gitStatusStorageKey('s1', '/tmp', undefined)
    expect(readGitStatusSnapshot(key)).toBeNull() // never written
    localStorage.setItem(key, '{torn')
    expect(readGitStatusSnapshot(key)).toBeNull()
    localStorage.setItem(key, JSON.stringify({ v: 99, at: 1, root: '/tmp', entries: [] }))
    expect(readGitStatusSnapshot(key)).toBeNull() // wrong schema version
    localStorage.setItem(key, JSON.stringify({ at: 1, root: '/tmp', entries: [] }))
    expect(readGitStatusSnapshot(key)).toBeNull() // no version at all
  })

  it('answers null for a document with a bad entry tuple or timestamp', () => {
    const key = gitStatusStorageKey('s1', '/tmp', undefined)
    localStorage.setItem(key, JSON.stringify({ v: 1, at: 1, root: '/tmp', entries: [['only-path']] }))
    expect(readGitStatusSnapshot(key)).toBeNull()
    localStorage.setItem(key, JSON.stringify({ v: 1, at: 1, root: '/tmp', entries: [['p.ts', ' M', 'x', 'y']] }))
    expect(readGitStatusSnapshot(key)).toBeNull() // counts must be numbers or '-','-'
    localStorage.setItem(key, JSON.stringify({ v: 1, root: '/tmp', entries: [] }))
    expect(readGitStatusSnapshot(key)).toBeNull() // no write timestamp
    localStorage.setItem(key, JSON.stringify({ v: 1, at: 0, root: '/tmp', entries: [] }))
    expect(readGitStatusSnapshot(key)).toBeNull() // a zero timestamp is not one
  })
})

describe('the LRU sweep', () => {
  it('keeps the freshest documents and drops the stalest overflow', () => {
    const keys: string[] = []
    for (let index = 0; index < GIT_STATUS_STORE_LIMIT + 2; index += 1) {
      const key = gitStatusStorageKey(`s${String(index)}`, '/tmp', undefined)
      keys.push(key)
      writeGitStatusSnapshot(key, SNAPSHOT)
      vi.advanceTimersByTime(1) // distinct write timestamps
    }
    // The two oldest slots are gone, the rest survive.
    expect(readGitStatusSnapshot(keys[0])).toBeNull()
    expect(readGitStatusSnapshot(keys[1])).toBeNull()
    for (let index = 2; index < keys.length; index += 1) {
      expect(readGitStatusSnapshot(keys[index])).not.toBeNull()
    }
  })

  it('sweeps torn rows first (their write time reads as 0)', () => {
    const good = gitStatusStorageKey('good', '/tmp', undefined)
    writeGitStatusSnapshot(good, SNAPSHOT)
    vi.advanceTimersByTime(1)
    const torn = gitStatusStorageKey('torn', '/tmp', undefined)
    localStorage.setItem(torn, '{torn')
    vi.advanceTimersByTime(1)
    for (let index = 0; index < GIT_STATUS_STORE_LIMIT; index += 1) {
      writeGitStatusSnapshot(gitStatusStorageKey(`extra${String(index)}`, '/tmp', undefined), SNAPSHOT)
      vi.advanceTimersByTime(1)
    }
    expect(readGitStatusSnapshot(torn)).toBeNull()
    expect(readGitStatusSnapshot(good)).not.toBeNull()
  })

  it('a manual sweep under the limit moves nothing', () => {
    writeGitStatusSnapshot(gitStatusStorageKey('s1', '/tmp', undefined), SNAPSHOT)
    sweepGitStatusStore(GIT_STATUS_STORE_LIMIT)
    expect(readGitStatusSnapshot(gitStatusStorageKey('s1', '/tmp', undefined))).not.toBeNull()
  })
})

describe('storage unavailable', () => {
  it('reads are empty and writes are silent without localStorage', () => {
    vi.stubGlobal('localStorage', undefined)
    const key = gitStatusStorageKey('s1', '/tmp', undefined)
    expect(() => writeGitStatusSnapshot(key, SNAPSHOT)).not.toThrow()
    expect(readGitStatusSnapshot(key)).toBeNull()
  })
})
