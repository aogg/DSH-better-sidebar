/**
 * Changes tab data layer: event-log folding into file operations, the
 * directory tree the Git lens renders its groups through, and a sanity pass
 * over the shared diff/highlight engines (their full behavior suites live in
 * the standalone dsh-file-trace plugin).
 *
 * The parentSession subtree merge (src/changes-subtree.ts + the `changes.ops`
 * route's subtree branch) lives here too: the pure walk/merge helpers, and the
 * route's mode selection over a mounted fake context — the untouched
 * single-log contract for a childless root on a plain cursor, the time-scaled
 * merge across the subtree otherwise. The route cases ride the smoke spec's
 * mounted-API harness pattern (apply() + one POST through the registered
 * /sidebar/api route), narrowed to the faces changes.ops touches.
 */
import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { extractFileOps, groupByFile, knownContentBefore, parseReadContent, parseReadLines } from '../src/client/changes/ops.ts'
import { buildChangeTree, type ChangeNode } from '../src/client/changes/change-tree.ts'
import { collectSubtreeIds, mergeSubtreeEvents } from '../src/changes-subtree.ts'
import type { StoredSessionHeaderLike, SubtreeEventPart } from '../src/changes-subtree.ts'
import { apply } from '../src/index.ts'
import { diffLines, buildDiffSegments, coalesceInline, diffInline } from '../src/client/diff/rows.ts'
import { langOfPath, scanLine } from '../src/client/diff/highlight.ts'
import type { GitStatusEntry } from '../src/client/api.ts'
import type { SidebarSessionEvent, SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** One synthetic session event. */
function ev(type: string, seq: number, time: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** A tool/call event. */
function call(seq: number, name: string, callId: string, args: unknown, time = seq): SidebarSessionEvent {
  return ev('tool/call', seq, time, { name, callId, arguments: JSON.stringify(args) })
}

/** A tool/result event carrying one first-class tool-role message (the 0.1.7
 *  shape: result blocks and `isError` at the message's own top level). */
function result(seq: number, callId: string, text: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError,
      content: [{ type: 'text', text }],
    },
  })
}

/** The retired 0.1.6 shape: a role-'user' message wrapping the result in one
 *  `tool-result` content block. Historical logs still carry it. */
function legacyResult(seq: number, callId: string, text: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', isError, content: [{ type: 'text', text }] }],
    },
  })
}

describe('parseReadContent', () => {
  it('strips the envelope and line-number prefixes but keeps blank lines', () => {
    const raw = [
      '<path>notes.md</path>',
      '<type>file</type>',
      '(Showing lines 1 to 4)',
      '<content>',
      '1: # Title',
      '2: ',
      '3: para one',
      '4: ',
      '</content>',
    ].join('\n')
    expect(parseReadContent(raw)).toBe('# Title\n\npara one')
  })

  it('returns the raw text unchanged when no <content> section is present', () => {
    expect(parseReadContent('plain text')).toBe('plain text')
  })
})

describe('extractFileOps', () => {
  it('seeds running ops from tool/call and settles them from tool/result', () => {
    const ops = extractFileOps([
      call(1, 'write', 'w1', { file_path: 'a.ts', content: 'body' }),
      result(2, 'w1', '<path>a.ts</path>\n<type>file</type>\n<content>\nbody\n</content>'),
    ])
    expect(ops).toHaveLength(1)
    expect(ops[0]!.running).toBe(false)
    expect(ops[0]!.isError).toBe(false)
    expect(ops[0]!.content).toBe('body')
  })

  it('captures the error text of an errored result for every kind', () => {
    const ops = extractFileOps([
      call(1, 'write', 'w', { file_path: 'a', content: 'x' }),
      result(2, 'w', '写入失败：目标只读', true),
      call(3, 'read', 'r', { file_path: 'b' }),
      result(4, 'r', 'cannot read "b": not found', true),
    ])
    expect(ops.every(op => op.isError && op.errorText !== undefined)).toBe(true)
    expect(ops.find(op => op.kind === 'read')?.errorText).toBe('cannot read "b": not found')
  })

  it('keeps a call without result as running, and reads capture their content', () => {
    const ops = extractFileOps([
      call(1, 'read', 'r1', { file_path: 'a.ts' }),
      result(2, 'r1', '<path>a.ts</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>'),
      call(3, 'edit', 'e1', { file_path: 'c.ts', old_string: 'x', new_string: 'y' }),
    ])
    const read = ops.find(op => op.callId === 'r1')
    expect(read?.running).toBe(false)
    expect(read?.read).toContain('1: hello')
    const edit = ops.find(op => op.callId === 'e1')
    expect(edit?.running).toBe(true)
    expect(edit?.edit).toEqual({ oldString: 'x', newString: 'y' })
  })

  it('ignores non-file tools and unrelated results, newest first', () => {
    const ops = extractFileOps([
      call(1, 'pwsh', 'p', { command: 'ls' }),
      result(2, 'unknown-call', 'orphan'),
      call(3, 'read', 'r', { file_path: 'z.ts' }),
    ])
    expect(ops.map(op => op.callId)).toEqual(['r'])
  })

  it('reads the tool/result message dsh-llm actually produces (producer round-trip)', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('r'),
      content: [{ type: 'text', text: 'produced file body' }],
      isError: false,
    })
    const ops = extractFileOps([
      call(1, 'read', 'r', { file_path: 'a.ts' }),
      ev('tool/result', 2, 2, { message: message as unknown as Record<string, unknown> }),
    ])
    expect(ops[0]!.running).toBe(false)
    expect(ops[0]!.read).toBe('produced file body')
  })

  it('reads a LEGACY 0.1.6-era tool-result wrapper (historical logs keep that shape)', () => {
    const ops = extractFileOps([
      // No content in the model's arguments, so the settled result supplies it.
      call(1, 'write', 'w', { file_path: 'a' }),
      legacyResult(2, 'w', 'legacy write detail'),
      call(3, 'read', 'r', { file_path: 'b' }),
      legacyResult(4, 'r', 'cannot read "b": not found', true),
    ])
    expect(ops.find(op => op.kind === 'write')?.content).toBe('legacy write detail')
    expect(ops.find(op => op.kind === 'read')?.errorText).toBe('cannot read "b": not found')
  })

  it('classifies str_replace_editor as an edit and carries its replacement payload', () => {
    // Named-list membership only — the other members keep their own coverage.
    const ops = extractFileOps([
      call(1, 'str_replace_editor', 'sre', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      result(2, 'sre', 'ok'),
    ])
    const op = ops.find(candidate => candidate.callId === 'sre')
    expect(op?.kind).toBe('edit')
    expect(op?.edit).toEqual({ oldString: 'x', newString: 'y' })
    expect(op?.running).toBe(false)
  })

  it('groups by file newest-first and recovers prior write content', () => {
    const ops = extractFileOps([
      call(1, 'write', 'w1', { file_path: 'a.ts', content: 'first' }),
      call(2, 'write', 'w2', { file_path: 'a.ts', content: 'second' }),
      call(3, 'write', 'w3', { file_path: 'b.ts', content: 'x' }),
    ])
    expect([...groupByFile(ops).keys()]).toEqual(['b.ts', 'a.ts'])
    expect(knownContentBefore(ops, 'a.ts', ops.find(op => op.callId === 'w2')!)).toBe('first')
  })
})

describe('parseReadLines', () => {
  it('recovers real line numbers from the read envelope', () => {
    const lines = parseReadLines('<path>a.ts</path>\n<type>file</type>\n<content>\n10: x\n11: y\n\n(Showing lines 10-11 of 20. Use offset=12 to continue.)\n</content>')
    expect(lines).toEqual([{ line: 10, text: 'x' }, { line: 11, text: 'y' }])
  })
})

describe('change tree (the Git lens reads its groups through it)', () => {
  /** One `git status` row from a path and its porcelain code. */
  const entry = (path: string, xy = ' M'): GitStatusEntry => ({ path, xy })

  /** A compact, assertion-friendly projection of one tree. */
  const shape = (nodes: readonly ChangeNode[]): unknown[] => nodes.map(node => node.kind === 'dir'
    ? { dir: node.name, path: node.path, changes: node.changes, children: shape(node.children) }
    : { file: node.name, path: node.path, letter: node.status.letter, tone: node.status.tone })

  it('keeps a single root-level file as one leaf', () => {
    expect(shape(buildChangeTree([entry('readme.md')]))).toEqual([
      { file: 'readme.md', path: 'readme.md', letter: 'M', tone: 'modified' },
    ])
  })

  it('nests a deep path and compresses its single-child chain into one row', () => {
    const tree = buildChangeTree([entry('src/client/changes/a.ts')])
    expect(shape(tree)).toEqual([
      {
        dir: 'src/client/changes',
        path: 'src/client/changes',
        changes: 1,
        children: [{ file: 'a.ts', path: 'src/client/changes/a.ts', letter: 'M', tone: 'modified' }],
      },
    ])
  })

  it('stops compressing where the path branches or a directory holds its own file', () => {
    // Two child directories: 'src' keeps its own row.
    expect(shape(buildChangeTree([entry('src/a/x.ts'), entry('src/b/y.ts')]))).toEqual([
      {
        dir: 'src',
        path: 'src',
        changes: 2,
        children: [
          { dir: 'a', path: 'src/a', changes: 1, children: [{ file: 'x.ts', path: 'src/a/x.ts', letter: 'M', tone: 'modified' }] },
          { dir: 'b', path: 'src/b', changes: 1, children: [{ file: 'y.ts', path: 'src/b/y.ts', letter: 'M', tone: 'modified' }] },
        ],
      },
    ])
    // A file AT this level: 'a' keeps its own row (and its file leads the child).
    expect(shape(buildChangeTree([entry('a/x.ts'), entry('a/b/y.ts')]))).toEqual([
      {
        dir: 'a',
        path: 'a',
        changes: 2,
        children: [
          { dir: 'b', path: 'a/b', changes: 1, children: [{ file: 'y.ts', path: 'a/b/y.ts', letter: 'M', tone: 'modified' }] },
          { file: 'x.ts', path: 'a/x.ts', letter: 'M', tone: 'modified' },
        ],
      },
    ])
  })

  it('orders directories before files, each by name case-insensitively', () => {
    const tree = buildChangeTree([
      entry('Zed.ts'), entry('B.ts'), entry('a.ts'), entry('zdir/f.ts'), entry('Adir/f.ts'),
    ])
    expect(shape(tree).map(node => (node as { dir?: string; file?: string }).dir ?? (node as { file: string }).file))
      .toEqual(['Adir', 'zdir', 'a.ts', 'B.ts', 'Zed.ts'])
  })

  it('mixes root-level files with nested paths and keeps same-named files apart', () => {
    expect(shape(buildChangeTree([
      entry('b/index.ts'), entry('index.ts'), entry('a/index.ts'),
    ]))).toEqual([
      { dir: 'a', path: 'a', changes: 1, children: [{ file: 'index.ts', path: 'a/index.ts', letter: 'M', tone: 'modified' }] },
      { dir: 'b', path: 'b', changes: 1, children: [{ file: 'index.ts', path: 'b/index.ts', letter: 'M', tone: 'modified' }] },
      { file: 'index.ts', path: 'index.ts', letter: 'M', tone: 'modified' },
    ])
  })

  it('carries every file porcelain status and counts the files under each row', () => {
    const tree = buildChangeTree([
      entry('src/a.ts', ' M'), entry('src/new.ts', '??'), entry('src/gone.ts', ' D'), entry('src/kept.ts', '  '),
    ])
    expect(shape(tree)).toEqual([
      {
        dir: 'src',
        path: 'src',
        changes: 3,
        children: [
          { file: 'a.ts', path: 'src/a.ts', letter: 'M', tone: 'modified' },
          { file: 'gone.ts', path: 'src/gone.ts', letter: 'D', tone: 'deleted' },
          { file: 'new.ts', path: 'src/new.ts', letter: 'U', tone: 'untracked' },
        ],
      },
    ])
  })

  it('pins the collation, so the order cannot move with the runtime locale', () => {
    // Mixed case + accents + non-letters: the comparator runs an explicit
    // 'en' base collation and breaks ties by code point. A bare
    // `localeCompare(other)` would follow the machine's ICU default and could
    // reorder the same change list on another machine.
    const names = ['b.ts', 'A.ts', 'ä.ts', 'Z.ts', 'a.ts', 'Ä.ts', '_x.ts', '1.ts']
    const order = (list: readonly string[]): string[] =>
      buildChangeTree(list.map(path => entry(path))).map(node => node.name)
    expect(order(names)).toEqual(['_x.ts', '1.ts', 'A.ts', 'a.ts', 'Ä.ts', 'ä.ts', 'b.ts', 'Z.ts'])
    // …and it is a TOTAL order: reversing the input cannot move a row.
    expect(order([...names].reverse())).toEqual(order(names))

    const dirs = ['Zdir/f.ts', 'adir/f.ts', 'Ädir/f.ts', '_dir/f.ts']
    const dirOrder = (list: readonly string[]): string[] =>
      buildChangeTree(list.map(path => entry(path))).map(node => node.name)
    expect(dirOrder(dirs)).toEqual(['_dir', 'adir', 'Ädir', 'Zdir'])
    expect(dirOrder([...dirs].reverse())).toEqual(dirOrder(dirs))

    // Why the pin is load-bearing: under Swedish collation 'ä' sorts AFTER
    // 'z', so an unpinned comparator would order this very list differently on
    // a machine whose runtime locale happens to be Swedish.
    expect(['z.ts', 'ä.ts'].sort((left, right) => left.localeCompare(right, 'sv', { sensitivity: 'base' })))
      .toEqual(['z.ts', 'ä.ts'])
  })

  it('returns no nodes for an empty or all-clean list', () => {
    expect(buildChangeTree([])).toEqual([])
    expect(buildChangeTree([entry('a.ts', '  '), entry('b.ts', '!!')])).toEqual([])
  })

  it('counts a repeated path once', () => {
    expect(shape(buildChangeTree([entry('a.ts'), entry('a.ts', '??')]))).toEqual([
      { file: 'a.ts', path: 'a.ts', letter: 'M', tone: 'modified' },
    ])
  })
})

describe('ported diff/highlight engines (sanity)', () => {
  it('diffLines pairs a rewrite as mod and folds context into hunks', () => {
    const rows = diffLines('hello world', 'hello dsh')
    expect(rows.map(r => r.kind)).toEqual(['mod', 'mod'])
    const before = Array.from({ length: 6 }, (_, i) => ({ kind: 'context' as const, oldLine: i + 1, newLine: i + 1, text: 'c' + String(i) }))
    const change = [{ kind: 'mod' as const, oldLine: 7, newLine: 7, text: 'X' }]
    const after = Array.from({ length: 8 }, (_, i) => ({ kind: 'context' as const, oldLine: i + 8, newLine: i + 8, text: 'c' + String(i + 8) }))
    const segments = buildDiffSegments([...before, ...change, ...after], 3)
    expect(segments.map(s => s.kind)).toEqual(['fold', 'hunk', 'fold'])
  })

  it('coalesces the ported prefix/suffix inline diff into runs', () => {
    const { old: oldSide } = diffInline('hello world', 'hello dsh')
    expect(coalesceInline(oldSide)).toEqual([
      { text: 'hello ', changed: false },
      { text: 'world', changed: true },
    ])
  })

  it('highlights keywords and threads block-comment state', () => {
    expect(langOfPath('a.cpp')).toBe('cpp')
    const open = scanLine('/* header', 'cpp')
    expect(open.inBlock).toBe(true)
    const mid = scanLine(' * interior note', 'cpp', true)
    expect(mid.tokens).toEqual([{ text: ' * interior note', type: 'comment' }])
    const code = scanLine('int main() { return 42; } // done', 'cpp')
    expect(code.tokens).toContainEqual({ text: 'int', type: 'keyword' })
    expect(code.tokens).toContainEqual({ text: '42', type: 'number' })
    expect(code.tokens).toContainEqual({ text: '// done', type: 'comment' })
  })
})

// ── parentSession subtree merge (src/changes-subtree.ts) ────────────────────

/** A stored session row as the wire carries it, unchecked on purpose — the
 *  walk must defend itself against host-shaped garbage. */
const rawRow = (header: unknown): StoredSessionHeaderLike => ({ header }) as StoredSessionHeaderLike

/** One subtree member as mergeSubtreeEvents consumes it. */
const part = (id: string, isRoot: boolean, events: readonly SidebarSessionEvent[]): SubtreeEventPart =>
  ({ id, isRoot, events })

/** The tool-call id one window event carries, under both wire shapes: a
 *  `tool/call` keeps it at data.callId, a `tool/result` inside its message
 *  envelope (data.message.source.callId). '' when neither is present. */
const windowCallId = (event: SidebarSessionEvent): string => {
  const data = event.data as { callId?: unknown; message?: { source?: { callId?: unknown } } }
  if (typeof data.callId === 'string') return data.callId
  return typeof data.message?.source?.callId === 'string' ? data.message.source.callId : ''
}

describe('collectSubtreeIds (the parentSession subtree walk)', () => {
  it('degrades to the root alone when the header list is missing or empty', () => {
    expect(collectSubtreeIds(undefined, 'root')).toEqual(['root'])
    expect(collectSubtreeIds([], 'root')).toEqual(['root'])
  })

  it('follows parentSession transitively: root → child → grandchild, root first', () => {
    const headers = [
      rawRow({ id: 'grandchild', parentSession: 'child' }),
      rawRow({ id: 'child', parentSession: 'root' }),
      rawRow({ id: 'root' }),
      // Another tree entirely: never reaches the root's subtree.
      rawRow({ id: 'other', parentSession: 'unrelated' }),
    ]
    expect(collectSubtreeIds(headers, 'root')).toEqual(['root', 'child', 'grandchild'])
  })

  it('ignores rows whose id or parentSession is not a usable non-empty string', () => {
    const headers = [
      rawRow({ id: 'root' }),
      rawRow({ id: 42, parentSession: 'root' }), // numeric id: not an edge
      rawRow({ id: 'kid', parentSession: 7 }), // numeric parent: not an edge
      rawRow({ id: 'kid2', parentSession: '' }), // empty parent: not an edge
      rawRow({ parentSession: 'root' }), // no id at all
      rawRow(null), // no header object
      rawRow(undefined),
      {} as StoredSessionHeaderLike, // not even a header field
      // The one usable edge still attaches among the garbage.
      rawRow({ id: 'kid3', parentSession: 'root' }),
    ]
    expect(collectSubtreeIds(headers, 'root')).toEqual(['root', 'kid3'])
  })

  it('survives a pathological parent/child cycle, visiting each node once', () => {
    const headers = [
      rawRow({ id: 'a', parentSession: 'b' }),
      rawRow({ id: 'b', parentSession: 'a' }),
    ]
    expect(collectSubtreeIds(headers, 'a')).toEqual(['a', 'b'])
    // A self-parent row cannot loop either.
    expect(collectSubtreeIds([rawRow({ id: 'a', parentSession: 'a' })], 'a')).toEqual(['a'])
  })
})

describe('mergeSubtreeEvents (the merged subtree window)', () => {
  it('renumbers seq to the event time; a row without a usable time keeps its seq', () => {
    const { events } = mergeSubtreeEvents(
      [part('s', true, [
        call(0, 'write', 'w', { file_path: 'a.ts' }, 5000),
        result(1, 'w', 'ok', false, 6000),
        // Wire garbage: no `time` field at all — the original seq stands in.
        { type: 'tool/call', seq: 7, time: undefined, data: { name: 'read', callId: 'r', arguments: '{}' } } as unknown as SidebarSessionEvent,
      ])],
      undefined,
    )
    // The seq-fallback row (a small local counter) sorts below the epoch-ms
    // rows — a best-effort order, but the row is kept, not dropped.
    expect(events.map(event => event.seq)).toEqual([7, 5000, 6000])
    expect(events.map(event => windowCallId(event))).toEqual(['r', 'w', 'w'])
  })

  it('breaks a same-millisecond tie by original seq: the call sorts before its result', () => {
    // The result is logged AFTER the call (higher original seq); with both
    // rows renumbered to the same millisecond, that original order is the
    // only thing keeping the call ahead of its result.
    const single = mergeSubtreeEvents(
      [part('s', true, [
        result(2, 'w', 'ok', false, 5000),
        call(1, 'write', 'w', { file_path: 'a.ts' }, 5000),
      ])],
      undefined,
    )
    expect(single.events.map(event => [event.type, event.seq])).toEqual([['tool/call', 5000], ['tool/result', 5000]])
    // Same tie, ACROSS parts: the lower original seq (here the child's row)
    // wins regardless of which session listed first.
    const cross = mergeSubtreeEvents([
      part('root', true, [result(5, 'w', 'ok', false, 5000)]),
      part('child', false, [call(0, 'write', 'w', { file_path: 'a.ts' }, 5000)]),
    ], undefined)
    expect(cross.events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('keeps the boundary event: the afterSeq cut is closed (seq >= afterSeq)', () => {
    const events = [
      call(0, 'write', 'w', { file_path: 'a.ts' }, 1000),
      result(1, 'w', 'ok', false, 2000),
    ]
    // A strict `>` would drop the 2000 result forever once the client echoes
    // lastSeq back — the exact loss the closed bound exists to prevent.
    expect(mergeSubtreeEvents([part('s', true, events)], 2000).events.map(event => [event.type, event.seq]))
      .toEqual([['tool/result', 2000]])
    expect(mergeSubtreeEvents([part('s', true, events)], 1000).events.map(event => event.seq))
      .toEqual([1000, 2000])
  })

  it('ships only tool/call and tool/result rows', () => {
    const events: SidebarSessionEvent[] = [
      ev('user/message', 0, 10, { text: 'go' }),
      call(1, 'write', 'w', { file_path: 'a.ts' }, 20),
      ev('assistant/message', 2, 30, {}),
      result(3, 'w', 'ok', false, 40),
      ev('turn/end', 4, 50, {}),
    ]
    expect(mergeSubtreeEvents([part('s', true, events)], undefined).events.map(event => event.seq))
      .toEqual([20, 40])
  })

  it('caps the window at the newest 4000 events', () => {
    const events = Array.from({ length: 4010 }, (_, index) => call(index, 'write', `w${index}`, { file_path: 'a.ts' }, index + 1))
    const merged = mergeSubtreeEvents([part('s', true, events)], undefined)
    expect(merged.events).toHaveLength(4000)
    expect(merged.events[0]!.seq).toBe(11) // times 11..4010 survive the tail cap
    expect(merged.lastSeq).toBe(4010)
  })

  it('answers with merged:true, the newest renumbered seq as lastSeq, or the cursor for an empty window', () => {
    expect(mergeSubtreeEvents([part('s', true, [call(0, 'write', 'w', { file_path: 'a.ts' }, 100)])], 5000))
      .toEqual({ events: [], lastSeq: 5000, merged: true })
    expect(mergeSubtreeEvents([], undefined))
      .toEqual({ events: [], lastSeq: -1, merged: true })
    expect(mergeSubtreeEvents([part('s', true, [result(1, 'w', 'ok', false, 200)])], undefined))
      .toEqual({ events: [expect.objectContaining({ seq: 200 })], lastSeq: 200, merged: true })
  })
})

describe('changes.ops route (subtree merge over the mounted API)', () => {
  /** Explicit epoch-ms constants: the merged window's cursor is event time. */
  const T0 = 1_700_000_000_000
  /** A cursor beyond the route's 1e12 "time scale" mark. */
  const T_BIG = 1_700_000_100_000

  interface MountOptions {
    /** id → live session log (`ctx.sessions.get(id)` finds these). */
    live?: Record<string, readonly SidebarSessionEvent[]>
    /** id → stored log served by the fake `sessionPersistence.open(id, 'read')`. */
    stored?: Record<string, readonly SidebarSessionEvent[]>
    /** ids whose stored handle cannot even be opened (a corrupt log). */
    brokenOpen?: readonly string[]
    /** The fake `persistence.list()`; undefined removes the capability entirely. */
    list?: () => unknown
  }

  /** Mount the plugin against a minimal fake context (the smoke-spec harness,
   *  narrowed to the faces changes.ops touches) and return /sidebar/api. */
  function mountChangesApi(options: MountOptions = {}): SidebarWebRoute {
    const routes: SidebarWebRoute[] = []
    const live = options.live ?? {}
    const persistence = {
      ...(options.list === undefined ? {} : { list: options.list }),
      open: async (id: string, _access: string) => {
        if (options.brokenOpen?.includes(id)) throw new Error(`stored log unreadable: ${id}`)
        const events = options.stored?.[id]
        if (events === undefined) throw new Error(`no stored session: ${id}`)
        return {
          header: { id } as Record<string, unknown>,
          inheritedEventCount: 0,
          read: async () => ({ events }),
          close: async () => {},
        }
      },
    }
    const ctx = {
      webRuntime: { trustedHosts: [] },
      webServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: (_route: SidebarWebUpgradeRoute) => { void _route; return () => {} },
      },
      sessions: {
        get: (id: string) => {
          const log = live[id]
          // The SAME array every call: an in-place seq rewrite by the merge
          // would corrupt the session's own log, and this harness would see it.
          return log === undefined ? undefined : { header: {}, snapshotEvents: () => log }
        },
      },
      tools: { register: () => () => {} },
      // The vendored cordis runs registration effects immediately.
      effect: (fn: () => void | (() => void)) => { fn() },
      // No settings service: the namespace registration never runs.
      inject: () => () => {},
      // The session/agent event feeds: nothing emits in these tests.
      on: () => () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      get: (key: string) => (key === 'sessionPersistence' ? persistence : undefined),
    }
    apply(ctx as never)
    const route = routes.find(entry => entry.path === '/sidebar/api')
    if (route === undefined) throw new Error('the /sidebar/api route was not registered')
    return route
  }

  /** One POST /sidebar/api/changes.ops through the mounted route. */
  async function invokeOps(route: SidebarWebRoute, payload: Record<string, unknown>): Promise<{
    ok: boolean
    value?: { events: SidebarSessionEvent[]; lastSeq: number }
    error?: { code?: string; message?: string }
  }> {
    const body = Buffer.from(JSON.stringify(payload))
    const req = {
      method: 'POST',
      url: '/sidebar/api/changes.ops',
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () { yield body },
    } as never
    const out = { status: 200, body: '' }
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk: unknown) => { out.body += String(chunk ?? '') },
    } as never
    await route.handler(req, res)
    return JSON.parse(out.body) as { ok: boolean; value?: { events: SidebarSessionEvent[]; lastSeq: number }; error?: { code?: string; message?: string } }
  }

  /** The window events are identified by their tool-call id. */
  const callIdOf = windowCallId

  it('answers a childless root with the untouched single-log contract (zero-regression pin)', async () => {
    const log = [
      ev('user/message', 1, T0 - 10, { text: 'go' }),
      call(2, 'write', 'w1', { file_path: 'a.ts', content: 'one' }, T0),
      result(3, 'w1', 'ok', false, T0 + 1),
      call(4, 'read', 'r1', { file_path: 'b.ts' }, T0 + 2),
      result(5, 'r1', 'file body', false, T0 + 3),
    ]
    const route = mountChangesApi({ live: { root: log }, list: () => [{ header: { id: 'root' } }] })
    // Delta from cursor 3: ORIGINAL seqs, strictly greater — the boundary row
    // (seq 3) stays out, and no `merged` key appears on the wire.
    const reply = await invokeOps(route, { sessionId: 'root', afterSeq: 3 })
    expect(reply.ok).toBe(true)
    expect(reply.value).toEqual({ events: [log[3], log[4]], lastSeq: 5 })
    // An exhausted log answers lastSeq = the echoed cursor (the old contract).
    await expect(invokeOps(route, { sessionId: 'root', afterSeq: 5 }))
      .resolves.toEqual({ ok: true, value: { events: [], lastSeq: 5 } })
  })

  it('folds a child session into one time-ordered window (seq renumbered to time)', async () => {
    const rootLog = [
      call(1, 'write', 'root-w', { file_path: 'a.ts', content: 'root' }, T0),
      result(2, 'root-w', 'ok', false, T0 + 1),
    ]
    const childLog = [
      call(0, 'write', 'child-w', { file_path: 'b.ts', content: 'child' }, T0 + 10),
      result(1, 'child-w', 'ok', false, T0 + 11),
    ]
    const route = mountChangesApi({
      live: { root: rootLog },
      stored: { child: childLog },
      list: () => [
        { header: { id: 'root' } },
        { header: { id: 'child', parentSession: 'root', origin: 'subagent' } },
      ],
    })
    const reply = await invokeOps(route, { sessionId: 'root' })
    expect(reply.ok).toBe(true)
    // The child's writes ride the same window, renumbered seq := time, in
    // wall-clock order after the root's own rows.
    expect(reply.value?.events.map(event => [event.seq, callIdOf(event)])).toEqual([
      [T0, 'root-w'], [T0 + 1, 'root-w'], [T0 + 10, 'child-w'], [T0 + 11, 'child-w'],
    ])
    expect(reply.value?.lastSeq).toBe(T0 + 11)
    // The renumber COPIED, never mutated, the live log's own rows.
    expect(rootLog.map(event => event.seq)).toEqual([1, 2])
  })

  it('reaches a grandchild through the transitive parentSession walk', async () => {
    const route = mountChangesApi({
      live: { root: [call(1, 'write', 'root-w', { file_path: 'a.ts' }, T0)] },
      stored: {
        child: [],
        grandchild: [
          call(0, 'write', 'gc-w', { file_path: 'c.ts' }, T0 + 20),
          result(1, 'gc-w', 'ok', false, T0 + 21),
        ],
      },
      list: () => [
        { header: { id: 'root' } },
        { header: { id: 'child', parentSession: 'root' } },
        { header: { id: 'grandchild', parentSession: 'child' } },
      ],
    })
    const reply = await invokeOps(route, { sessionId: 'root' })
    expect(reply.ok).toBe(true)
    expect(reply.value?.events.map(event => callIdOf(event))).toEqual(['root-w', 'gc-w', 'gc-w'])
    expect(reply.value?.lastSeq).toBe(T0 + 21)
  })

  it('skips a child whose stored log cannot be opened, without failing the poll', async () => {
    const route = mountChangesApi({
      live: { root: [call(1, 'write', 'root-w', { file_path: 'a.ts' }, T0)] },
      stored: { good: [call(0, 'write', 'good-w', { file_path: 'b.ts' }, T0 + 10)] },
      brokenOpen: ['bad'],
      list: () => [
        { header: { id: 'root' } },
        { header: { id: 'bad', parentSession: 'root' } },
        { header: { id: 'good', parentSession: 'root' } },
      ],
    })
    const reply = await invokeOps(route, { sessionId: 'root' })
    expect(reply.ok).toBe(true)
    expect(reply.value?.events.map(event => callIdOf(event))).toEqual(['root-w', 'good-w'])
    expect(reply.value?.lastSeq).toBe(T0 + 10)
  })

  it('falls back to the root session alone when persistence.list throws', async () => {
    const rootLog = [
      call(1, 'write', 'root-1', { file_path: 'a.ts' }, T0),
      call(2, 'write', 'root-2', { file_path: 'b.ts' }, T0 + 1),
    ]
    const route = mountChangesApi({
      live: { root: rootLog },
      // A readable child that the fallback must NOT reach.
      stored: { child: [call(0, 'write', 'child-w', { file_path: 'c.ts' }, T0 + 10)] },
      list: () => { throw new Error('header store down') },
    })
    const reply = await invokeOps(route, { sessionId: 'root', afterSeq: 1 })
    expect(reply.ok).toBe(true)
    // The single-log path answers: original seq, strict >, no child rows.
    expect(reply.value).toEqual({ events: [rootLog[1]], lastSeq: 2 })
  })

  it('keeps a single node on the merged time filter once the cursor passes 1e12', async () => {
    const log = [
      ev('user/message', 0, T_BIG - 20, { text: 'go' }),
      call(1, 'write', 'old-w', { file_path: 'old.ts' }, T_BIG - 10),
      call(2, 'write', 'new-w', { file_path: 'new.ts' }, T_BIG + 5),
      result(3, 'new-w', 'ok', false, T_BIG + 6),
    ]
    // No `list` on the persistence at all — the feature-detect keeps the root
    // alone, and the huge cursor flips that single node onto the time scale.
    const route = mountChangesApi({ live: { root: log } })
    const reply = await invokeOps(route, { sessionId: 'root', afterSeq: T_BIG })
    expect(reply.ok).toBe(true)
    // The seq counter (1..3) sits far below the cursor: only the TIME filter
    // can surface these rows, renumbered to their wall-clock times.
    expect(reply.value?.events.map(event => [event.seq, callIdOf(event)])).toEqual([
      [T_BIG + 5, 'new-w'], [T_BIG + 6, 'new-w'],
    ])
    expect(reply.value?.lastSeq).toBe(T_BIG + 6)
  })

  it('answers an unreadable root with an empty window and lastSeq = max(afterSeq, 0)', async () => {
    const route = mountChangesApi({
      // Nothing live; the stored side has the child but no root row to open.
      stored: { child: [call(0, 'write', 'child-w', { file_path: 'b.ts' }, T0 + 10)] },
      list: () => [
        { header: { id: 'root' } },
        { header: { id: 'child', parentSession: 'root' } },
      ],
    })
    const reply = await invokeOps(route, { sessionId: 'root', afterSeq: 7 })
    expect(reply.ok).toBe(true)
    expect(reply.value).toEqual({ events: [], lastSeq: 7 })
  })
})
