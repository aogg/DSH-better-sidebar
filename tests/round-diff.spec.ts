/**
 * The round-diff lens data layer: the baseline pick that aims the ONE-SHOT
 * `git diff <rev>` ({@link pickRoundDiffBase}) — the newest commit that
 * predates the (approximate) round boundary, the empty tree when every
 * commit landed inside the round, and the no-commits empty state. Pure — no
 * React, no DOM, no git binary.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_TREE_HASH, pickRoundDiffBase } from '../src/client/changes/round-diff.ts'

/** One log row with only the fields the picker reads (newest-first order). */
function entry(hashFull: string, isoDate: string): { date: string; hashFull: string } {
  return { date: isoDate, hashFull }
}

/** The minute of boundary slack the lens passes. */
const SLACK = 60_000

describe('pickRoundDiffBase', () => {
  it('picks the NEWEST commit that predates the round window', () => {
    // Newest first, as the host's git log answers: HEAD sits inside the
    // round, the commit before it predates it — diff against THAT one, so
    // the patch carries exactly the round's changes.
    const before = entry('b'.padEnd(40, '0'), '2026-03-01T10:00:00Z')
    const older = entry('c'.padEnd(40, '0'), '2026-02-20T08:00:00Z')
    const inRound = entry('a'.padEnd(40, '0'), '2026-03-01T12:00:00Z')
    const base = pickRoundDiffBase([inRound, before, older], Date.parse('2026-03-01T11:30:00Z'), SLACK)
    expect(base).toEqual({ kind: 'commit', hashFull: 'b'.padEnd(40, '0') })
  })

  it('honors the slack: a commit AT the boundary stays inside the round', () => {
    // roundStart - slack exactly: `time < boundary` is strict, so a commit
    // stamped on the boundary itself is still "in the round" and the next
    // older one becomes the baseline.
    const roundStart = Date.parse('2026-03-01T11:30:00Z')
    const atBoundary = entry('b'.padEnd(40, '0'), new Date(roundStart - SLACK).toISOString())
    const before = entry('c'.padEnd(40, '0'), '2026-02-20T08:00:00Z')
    expect(pickRoundDiffBase([atBoundary, before], roundStart, SLACK))
      .toEqual({ kind: 'commit', hashFull: 'c'.padEnd(40, '0') })
  })

  it('falls back to the empty tree when every commit sits inside the round', () => {
    // The round started at the repository's birth: diffing against the
    // virtual empty tree reads every tracked file as new.
    const first = entry('a'.padEnd(40, '0'), '2026-03-01T12:00:00Z')
    const second = entry('b'.padEnd(40, '0'), '2026-03-01T12:05:00Z')
    expect(pickRoundDiffBase([second, first], Date.parse('2026-03-01T11:30:00Z'), SLACK))
      .toEqual({ kind: 'empty-tree' })
    expect(EMPTY_TREE_HASH).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
  })

  it('answers no-commits for a repository without commits (the empty state)', () => {
    expect(pickRoundDiffBase([], Date.now(), SLACK)).toEqual({ kind: 'no-commits' })
  })

  it('keeps an unparseable date in the round but still scans past it', () => {
    // A commit whose clock format cannot be parsed never PROVES it predates
    // the round, so it is skipped as a baseline candidate — while the older,
    // parseable commit still wins (the scan keeps going; evidence never
    // drops over one stray format).
    const odd = entry('a'.padEnd(40, '0'), 'not a date')
    const inRound = entry('b'.padEnd(40, '0'), '2026-03-01T12:00:00Z')
    const before = entry('c'.padEnd(40, '0'), '2026-02-20T08:00:00Z')
    expect(pickRoundDiffBase([inRound, odd, before], Date.parse('2026-03-01T11:30:00Z'), SLACK))
      .toEqual({ kind: 'commit', hashFull: 'c'.padEnd(40, '0') })

    // All dates unparseable: still "has commits", so the empty tree — never
    // the no-commits empty state.
    expect(pickRoundDiffBase([odd], Date.parse('2026-03-01T11:30:00Z'), SLACK))
      .toEqual({ kind: 'empty-tree' })
  })
})
