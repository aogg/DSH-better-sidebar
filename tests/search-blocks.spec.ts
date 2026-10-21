/**
 * search-blocks: the search page's hit → context-block merge (pure module).
 *
 * Pinned here (design doc §8 / §4.4):
 * - one hit's window is `[line − 2, line + 2]`; a NEXT hit joins the open
 *   block when its window overlaps or touches it (`next.line − blockEnd ≤ 3`,
 *   i.e. a gap of at most ONE untouched line still merges) and starts a fresh
 *   block at a gap of two or more;
 * - same-line multi-hits stay ONE block and land as several highlight spans
 *   on the same row;
 * - `firstHitLine` is the block's FIRST hit line (the「查看」/ Enter jump
 *   target), not the block's first row;
 * - file-edge context simply yields fewer rows (a shorter `before`/`after`
 *   array never invents line numbers);
 * - `segmentsOfLine` slices the verbatim line into plain/highlight segments
 *   for rendering (sorted spans, out-of-range and overlapping spans dropped).
 */
import { describe, expect, it } from 'vitest'
import { buildSearchBlocks, segmentsOfLine } from '../src/client/search-blocks.ts'
import type { ContentLineHit } from '../src/content-search-types.ts'

/** A hit factory: full line text plus the host's context arrays. */
function hitOf(
  line: number,
  column = 0,
  length = 6,
  text = 'answer',
  before: string[] = [],
  after: string[] = [],
): ContentLineHit {
  return { line, column, length, text, before, after }
}

describe('buildSearchBlocks merge boundaries', () => {
  it('one hit renders its whole window: hit row highlighted, context rows plain, all numbered', () => {
    const blocks = buildSearchBlocks([
      hitOf(10, 3, 6, 'the answer is', ['pre one', 'pre two'], ['post one', 'post two']),
    ])
    expect(blocks).toHaveLength(1)
    const block = blocks[0]!
    expect(block.firstHitLine).toBe(10)
    expect(block.startLine).toBe(8)
    expect(block.endLine).toBe(12)
    expect(block.lines.map(row => row.line)).toEqual([8, 9, 10, 11, 12])
    expect(block.lines.map(row => row.text)).toEqual([
      'pre one', 'pre two', 'the answer is', 'post one', 'post two',
    ])
    // Only the hit row carries a span; the context rows are plain.
    expect(block.lines.map(row => row.hits)).toEqual([
      [], [], [{ column: 3, length: 6 }], [], [],
    ])
  })

  it('adjacent hits (gap 0 and 1 untouched line) merge into one block', () => {
    // Windows [8..12] and [9..13] overlap outright; [8..12] and [12..16]
    // touch — `next.line − blockEnd = 2 ≤ 3`.
    const blocks = buildSearchBlocks([hitOf(10), hitOf(11), hitOf(14)])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.startLine).toBe(8)
    expect(blocks[0]!.endLine).toBe(16)
    expect(blocks[0]!.firstHitLine).toBe(10)
  })

  it('a hit whose window merely TOUCHES the block (gap of one line) still merges', () => {
    // Block after hit 10 is [8..12]; hit 15's window starts at 13 — one
    // untouched line (13 is `blockEnd + 1`): 15 − 12 = 3 ≤ 3 → merged.
    const blocks = buildSearchBlocks([
      hitOf(10, 0, 6, 'answer', [], ['a', 'b']), // after supplies rows 11, 12
      hitOf(15, 0, 6, 'answer', ['c', 'd'], ['e', 'f']), // before supplies 13, 14
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.lines.map(row => row.line)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })

  it('a gap of two or more untouched lines starts a NEW block', () => {
    // 16 − 12 = 4 > 3: the second hit's window begins at 14, two past 12.
    const blocks = buildSearchBlocks([hitOf(10), hitOf(16)])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ startLine: 8, endLine: 12, firstHitLine: 10 })
    expect(blocks[1]).toMatchObject({ startLine: 14, endLine: 18, firstHitLine: 16 })
    expect(blocks[1]!.lines.map(row => row.line)).toEqual([14, 15, 16, 17, 18])
  })

  it('two hits on ONE line stay one block with two spans on the same row', () => {
    const blocks = buildSearchBlocks([
      hitOf(5, 0, 6, 'answer answer'),
      hitOf(5, 7, 6, 'answer answer'),
    ])
    expect(blocks).toHaveLength(1)
    const rows = blocks[0]!.lines
    expect(rows.filter(row => row.hits.length > 0)).toHaveLength(1)
    expect(rows.find(row => row.line === 5)!.hits).toEqual([
      { column: 0, length: 6 },
      { column: 7, length: 6 },
    ])
  })

  it('firstHitLine is the FIRST hit of the block, not its first row', () => {
    const blocks = buildSearchBlocks([
      hitOf(10, 0, 6, 'answer', ['above']),
      hitOf(11, 0, 6, 'answer'),
    ])
    expect(blocks[0]!.firstHitLine).toBe(10)
    expect(blocks[0]!.lines[0]!.line).toBe(8 + 0) // context row exists…
    expect(blocks[0]!.lines[0]!.hits).toEqual([]) // …but carries no span
  })

  it('file-edge context shortens: missing neighbors never invent line numbers', () => {
    // Line 1 has nothing above; the block still OPENS at line − 2 but the
    // rendered rows start at the hit itself.
    const top = buildSearchBlocks([hitOf(1, 0, 6, 'answer', [], ['n2', 'n3'])])
    expect(top).toHaveLength(1)
    expect(top[0]!.lines.map(row => row.line)).toEqual([1, 2, 3])
    // A last-line hit with no `after` rows renders no phantom tail either.
    const bottom = buildSearchBlocks([hitOf(4, 0, 6, 'answer', ['n2', 'n3'], [])])
    expect(bottom[0]!.lines.map(row => row.line)).toEqual([2, 3, 4])
  })

  it('sorts defensively: out-of-order input still yields ascending blocks and rows', () => {
    const blocks = buildSearchBlocks([hitOf(16), hitOf(3), hitOf(10)])
    expect(blocks.map(block => block.firstHitLine)).toEqual([3, 10, 16])
    for (const block of blocks) {
      const lines = block.lines.map(row => row.line)
      expect([...lines].sort((a, b) => a - b)).toEqual(lines)
    }
  })
})

describe('segmentsOfLine', () => {
  it('slices one span into plain/hit/plain segments', () => {
    expect(segmentsOfLine('const answer = 42', [{ column: 6, length: 6 }])).toEqual([
      { text: 'const ', hit: false },
      { text: 'answer', hit: true },
      { text: ' = 42', hit: false },
    ])
  })

  it('renders several spans on one line in order, with the gaps between them', () => {
    expect(segmentsOfLine('answer answer', [{ column: 0, length: 6 }, { column: 7, length: 6 }])).toEqual([
      { text: 'answer', hit: true },
      { text: ' ', hit: false },
      { text: 'answer', hit: true },
    ])
  })

  it('drops out-of-range and overlapping spans (the first span wins an overlap)', () => {
    // Span past the end and a negative column are noise, not crashes.
    expect(segmentsOfLine('answer', [{ column: 0, length: 99 }, { column: -1, length: 2 }])).toEqual([
      { text: 'answer', hit: true },
    ])
    // 0..4 covers 2..6 entirely: the later span is swallowed.
    expect(segmentsOfLine('answer', [{ column: 0, length: 4 }, { column: 2, length: 4 }])).toEqual([
      { text: 'answ', hit: true },
      { text: 'er', hit: false },
    ])
  })

  it('a full-line span renders as one hit segment; an empty line renders nothing', () => {
    expect(segmentsOfLine('answer', [{ column: 0, length: 6 }])).toEqual([{ text: 'answer', hit: true }])
    expect(segmentsOfLine('', [{ column: 0, length: 0 }])).toEqual([])
  })
})
