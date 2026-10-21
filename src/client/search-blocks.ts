/**
 * The search page's result grouping: a file's flat hit list → merged CONTEXT
 * BLOCKS (the PhpStorm Find-in-Files reading order).
 *
 * One hit's context window is `[line − 2, line + 2]` (the host's
 * `CONTEXT_LINES = 2`, mirrored by `before`/`after`). Two blocks whose
 * windows OVERLAP OR TOUCH are merged into one block: with hits in ascending
 * line order, the next hit joins the current block when
 * `next.line − blockEnd ≤ 3` (its window starts at `next.line − 2`, so a gap
 * of at most one untouched line still merges — the exact rule the design doc
 * pins; a gap of 2+ untouched lines starts a new block).
 *
 * Pure and dependency-free on purpose (see docs/plans/2026-10-21
 * -find-in-files-page.md §4.4): `tests/search-blocks.spec.ts` pins the merge
 * boundaries, the same-line multi-hit spans and the file-edge context
 * shortening.
 */
import type { ContentLineHit } from '../content-search-types.ts'

/** One rendered line inside a block: its 1-based line number, the verbatim
 *  line text, and every hit span on it (`column`/`length`, 0-based JS string
 *  indices — the client slices `text` directly). */
export interface SearchBlockLine {
  line: number
  text: string
  hits: { column: number; length: number }[]
}

/** One merged context block: the line rows to render plus the bookkeeping
 *  the view needs — `firstHitLine` is the line「查看」/ Enter jump to (the
 *  block's FIRST hit, not its first row). */
export interface SearchBlock {
  startLine: number
  endLine: number
  firstHitLine: number
  lines: SearchBlockLine[]
}

/**
 * Merge a file's hits (ascending, same-line multi-hits included — the host
 * guarantees the order; sorted again defensively) into context blocks.
 */
export function buildSearchBlocks(hits: readonly ContentLineHit[]): SearchBlock[] {
  const sorted = [...hits].sort((a, b) => a.line - b.line)
  const blocks: SearchBlock[] = []
  /** Per-block line rows keyed by line number, kept in insertion order. */
  let rows: Map<number, SearchBlockLine> = new Map()
  let startLine = 0
  let endLine = 0
  let firstHitLine = 0

  const flush = (): void => {
    if (rows.size === 0) return
    blocks.push({
      startLine,
      endLine,
      firstHitLine,
      lines: [...rows.values()].sort((a, b) => a.line - b.line),
    })
    rows = new Map()
  }

  for (const hit of sorted) {
    // A hit whose window starts within one line of the current block's end
    // joins it; anything further starts a fresh block (and flushes the old).
    if (rows.size > 0 && hit.line - endLine > 3) flush()
    if (rows.size === 0) {
      startLine = hit.line - 2
      endLine = hit.line + 2
      firstHitLine = hit.line
    } else {
      if (hit.line - 2 < startLine) startLine = hit.line - 2
      if (hit.line + 2 > endLine) endLine = hit.line + 2
    }
    // The hit's own row carries the span; its context rows are plain. The
    // `before`/`after` arrays are the file's verbatim neighboring lines, so
    // their line numbers follow from the hit line and the array lengths
    // (shorter arrays at the file's edges — the formula stays honest).
    addHit(rows, hit.line, hit.text, hit.column, hit.length)
    hit.before.forEach((text, index) => {
      addLine(rows, hit.line - (hit.before.length - index), text)
    })
    hit.after.forEach((text, index) => {
      addLine(rows, hit.line + 1 + index, text)
    })
  }
  flush()
  return blocks
}

/** Add (or extend) one line row; the hit span lands with the row's text. */
function addHit(
  rows: Map<number, SearchBlockLine>,
  line: number,
  text: string,
  column: number,
  length: number,
): void {
  const row = rowOf(rows, line, text)
  row.hits.push({ column, length })
}

/** Add (or keep) one plain context row. */
function addLine(rows: Map<number, SearchBlockLine>, line: number, text: string): void {
  rowOf(rows, line, text)
}

/** The row for `line`, minted (with the host's verbatim text) when absent.
 *  A line that is both context and hit keeps the hit entry's text — the two
 *  always agree (same file buffer), so either source is the truth. */
function rowOf(rows: Map<number, SearchBlockLine>, line: number, text: string): SearchBlockLine {
  const existing = rows.get(line)
  if (existing !== undefined) return existing
  const row: SearchBlockLine = { line, text, hits: [] }
  rows.set(line, row)
  return row
}

/**
 * Split one line's text into plain/highlight segments for rendering: the
 * spans arrive sorted-by-line from the host but are ordered here (and empty
 * or out-of-range spans dropped) so the view can map them straight to
 * `<mark>` children.
 */
export function segmentsOfLine(
  text: string,
  hits: readonly { column: number; length: number }[],
): { text: string; hit: boolean }[] {
  const spans = hits
    .map(hit => ({ start: hit.column, end: hit.column + hit.length }))
    .filter(span => span.start >= 0 && span.end <= text.length && span.end > span.start)
    .sort((a, b) => a.start - b.start)
  const segments: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue // overlapping span: the first wins
    if (span.start > cursor) segments.push({ text: text.slice(cursor, span.start), hit: false })
    segments.push({ text: text.slice(span.start, span.end), hit: true })
    cursor = span.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments
}
