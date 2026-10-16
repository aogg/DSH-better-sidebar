/**
 * The round-commits lens data layer: the fuzzy `git add` extraction from the
 * session event log ({@link extractGitAdds}), the add-operand ↔ commit-file
 * path matching ({@link normalizeAddPath} / {@link addPathInCommit}), and the
 * old-host fallback that recovers a commit's touched files from its diff
 * headers ({@link parseDiffFiles}). Pure — no React, no DOM, no git binary.
 */
import { describe, expect, it } from 'vitest'
import { addPathInCommit, extractGitAdds, normalizeAddPath, parseDiffFiles } from '../src/client/changes/round-commits.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One synthetic session event. */
function ev(type: string, seq: number, time: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** One bash tool/call event. */
function bashCall(seq: number, callId: string, command: string, time = seq, workdir?: string): SidebarSessionEvent {
  return ev('tool/call', seq, time, {
    name: 'bash',
    callId,
    arguments: JSON.stringify(workdir === undefined ? { command } : { command, workdir }),
  })
}

/** One tool/result event (0.1.7 first-class tool message). */
function result(seq: number, callId: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      isError,
      content: [{ type: 'text', text: isError ? 'fatal: bad' : 'ok' }],
    },
  })
}

describe('extractGitAdds', () => {
  it('extracts a plain add with its paths', () => {
    const adds = extractGitAdds([bashCall(1, 'b1', 'git add src/a.ts src/b.ts')])
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({ callId: 'b1', paths: ['src/a.ts', 'src/b.ts'], all: false, running: true, isError: false })
    expect(adds[0]!.time).toBe(1)
  })

  it('folds a chained command into one record and skips the non-add links', () => {
    const adds = extractGitAdds([bashCall(1, 'b1', 'git add a.ts && git commit -m "x" ; git status --short || git add b.ts')])
    expect(adds).toHaveLength(1)
    expect(adds[0]!.paths).toEqual(['a.ts', 'b.ts'])
    expect(adds[0]!.all).toBe(false)
  })

  it('marks -A / --all / -u / . as the everything form with no paths', () => {
    for (const command of ['git add -A', 'git add --all', 'git add -u', 'git add .', 'git add ./', 'git add -A.']) {
      const adds = extractGitAdds([bashCall(1, 'b1', command)])
      expect(adds, command).toHaveLength(1)
      expect(adds[0]!.all, command).toBe(true)
      expect(adds[0]!.paths, command).toEqual([])
    }
  })

  it('unquotes quoted operands and keeps their spelling', () => {
    const adds = extractGitAdds([bashCall(1, 'b1', "git add 'my file.txt' \"上 位.txt\"")])
    expect(adds[0]!.paths).toEqual(['my file.txt', '上 位.txt'])
  })

  it('accepts git -C <path> add, quoted or not', () => {
    const plain = extractGitAdds([bashCall(1, 'b1', 'git -C /repo add src/a.ts')])
    expect(plain).toHaveLength(1)
    expect(plain[0]!.paths).toEqual(['src/a.ts'])
    const quoted = extractGitAdds([bashCall(1, 'b2', 'git -C "/repo with space" add a.ts')])
    expect(quoted).toHaveLength(1)
    expect(quoted[0]!.paths).toEqual(['a.ts'])
  })

  it('treats every token after -- as a path, option-like ones included', () => {
    const adds = extractGitAdds([bashCall(1, 'b1', 'git add -- -weird.txt')])
    expect(adds[0]!.paths).toEqual(['-weird.txt'])
  })

  it('extracts nothing from value-taking flags (the call falls out entirely)', () => {
    expect(extractGitAdds([bashCall(1, 'b1', 'git add --pathspec-from-file=paths.txt')])).toHaveLength(0)
  })

  it('matches nothing for non-git or non-add commands', () => {
    for (const command of ['ls -la', 'echo git add', 'npm run build', 'git status', 'git commit -am "x"', 'git rm a.ts']) {
      expect(extractGitAdds([bashCall(1, 'b1', command)]), command).toHaveLength(0)
    }
  })

  it('drops an add with no knowable operands (git add -h)', () => {
    expect(extractGitAdds([bashCall(1, 'b1', 'git add -h')])).toHaveLength(0)
    expect(extractGitAdds([bashCall(1, 'b1', 'git add')])).toHaveLength(0)
  })

  it('ignores non-bash tools and malformed arguments', () => {
    expect(extractGitAdds([
      ev('tool/call', 1, 1, { name: 'write', callId: 'w1', arguments: JSON.stringify({ command: 'git add a.ts' }) }),
      ev('tool/call', 2, 2, { name: 'bash', callId: 'b2', arguments: '{not json' }),
      ev('tool/call', 3, 3, { name: 'bash', callId: 'b3', arguments: JSON.stringify({ command: 42 }) }),
    ])).toHaveLength(0)
  })

  it('settles running/isError from the tool result by callId', () => {
    const adds = extractGitAdds([
      bashCall(1, 'b1', 'git add a.ts'),
      bashCall(2, 'b2', 'git add b.ts'),
      bashCall(3, 'b3', 'git add c.ts'),
      result(4, 'b1'),
      result(5, 'b2', true),
      result(6, 'unrelated'),
    ])
    expect(adds.map(add => add.callId)).toEqual(['b3', 'b2', 'b1']) // newest first
    expect(adds.find(add => add.callId === 'b1')).toMatchObject({ running: false, isError: false })
    expect(adds.find(add => add.callId === 'b2')).toMatchObject({ running: false, isError: true })
    expect(adds.find(add => add.callId === 'b3')).toMatchObject({ running: true, isError: false })
  })

  it('carries the call workdir through', () => {
    const adds = extractGitAdds([bashCall(1, 'b1', 'git add a.ts', 1, '/repo/linked')])
    expect(adds[0]!.workdir).toBe('/repo/linked')
  })
})

describe('normalizeAddPath / addPathInCommit', () => {
  it('strips a base prefix (workdir or session cwd) from absolute operands', () => {
    expect(normalizeAddPath('C:\\repo\\src\\a.ts', ['C:/repo'])).toBe('src/a.ts')
    expect(normalizeAddPath('/repo/linked/src/a.ts', ['/repo/linked', '/repo'])).toBe('src/a.ts')
    // The base match is case-insensitive (Windows drives); the tail keeps its
    // own spelling.
    expect(normalizeAddPath('D:/Proj/SRC/A.ts', ['d:/proj'])).toBe('SRC/A.ts')
  })

  it('leaves relative operands and non-matching absolutes alone (quotes off, separators folded)', () => {
    expect(normalizeAddPath('"src/a.ts"', [])).toBe('src/a.ts')
    expect(normalizeAddPath('src\\a.ts', [])).toBe('src/a.ts')
    expect(normalizeAddPath('/elsewhere/a.ts', ['/repo'])).toBe('/elsewhere/a.ts')
  })

  it('matches equal paths and directory-boundary tails in both directions', () => {
    expect(addPathInCommit('src/a.ts', 'src/a.ts')).toBe(true)
    expect(addPathInCommit('a.ts', 'src/a.ts')).toBe(true)
    expect(addPathInCommit('src/a.ts', 'pkg/src/a.ts')).toBe(true)
    expect(addPathInCommit('a.ts', 'ba.ts')).toBe(false)
    expect(addPathInCommit('src', 'src/other.ts')).toBe(false)
    expect(addPathInCommit('', 'src/a.ts')).toBe(false)
  })
})

describe('parseDiffFiles (old-host fallback)', () => {
  it('recovers statuses from the diff headers', () => {
    const diff = [
      'diff --git a/added.ts b/added.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/deleted.ts b/deleted.ts',
      'deleted file mode 100644',
      'diff --git a/old.ts b/new.ts',
      'similarity index 92%',
      'rename from old.ts',
      'rename to new.ts',
      'diff --git a/touched.ts b/touched.ts',
      '@@ -1 +1 @@',
    ].join('\n')
    expect(parseDiffFiles(diff)).toEqual([
      { path: 'added.ts', status: 'A' },
      { path: 'deleted.ts', status: 'D' },
      { path: 'new.ts', status: 'R' },
      { path: 'touched.ts', status: 'M' },
    ])
  })

  it('answers nothing for a diff without headers', () => {
    expect(parseDiffFiles('')).toEqual([])
    expect(parseDiffFiles('not a diff')).toEqual([])
  })
})
