/**
 * The round-commits lens component: the round window filter (an approximate
 * "this round" boundary over the git log), the staged-uncommitted section
 * (adds matched into NO round commit, `add -A` as a note line), the `add`
 * badges where a commit's files carry a round add, the per-commit file-list
 * disclosure (independent of the row-body preview action), and the OLD-HOST
 * fallback — a log answered without `files` recovers them lazily from the
 * commit diff. The api surface is mocked; no git binary, no host.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RoundCommitsLens } from '../src/client/changes/RoundCommitsLens.tsx'
import type { LensControl } from '../src/client/changes/lens-control.ts'
import { api, type GitLogEntry, type GitWorktree } from '../src/client/api.ts'
import type { SidebarDiffRef } from '../src/client/state.ts'
import { extractGitAdds } from '../src/client/changes/round-commits.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'
const NOW = Date.now()

function bashCall(seq: number, callId: string, command: string, time = seq): SidebarSessionEvent {
  return { type: 'tool/call', seq, time, data: { name: 'bash', callId, arguments: JSON.stringify({ command }) } }
}

function logEntry(overrides: Partial<GitLogEntry>): GitLogEntry {
  return {
    hash: 'abc1234',
    hashFull: 'abc1234abc1234abc1234abc1234abc1234abc1234',
    subject: 'a commit',
    author: 'Agent',
    date: new Date(NOW - 30_000).toISOString(),
    refs: '',
    ...overrides,
  }
}

async function renderLens(props: {
  adds: ReturnType<typeof extractGitAdds>
  roundStart?: number
  onPreview?: (ref: SidebarDiffRef) => void
  ref?: Ref<LensControl>
}): Promise<{ container: HTMLElement; previews: SidebarDiffRef[]; root: Root }> {
  const previews: SidebarDiffRef[] = []
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(RoundCommitsLens, {
      ref: props.ref,
      scope: { sessionId: 'session', cwd: MAIN },
      visible: true,
      adds: props.adds,
      roundStart: props.roundStart ?? NOW - 120_000,
      onPreview: (ref) => { previews.push(ref); props.onPreview?.(ref) },
      selectedRef: null,
    }))
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { container, previews, root }
}

function chevronOf(container: HTMLElement, hashFull: string): HTMLButtonElement | undefined {
  return container.querySelector<HTMLButtonElement>(`[data-commit="${hashFull}"] [data-commit-toggle]`) ?? undefined
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: 0 },
  ] as GitWorktree[])
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('RoundCommitsLens', () => {
  it('shows only the commits inside the (approximate) round window', async () => {
    const inRound = logEntry({ hash: 'inround', hashFull: 'inround'.padEnd(40, '0'), subject: 'in-round', date: new Date(NOW - 10_000).toISOString() })
    const beforeRound = logEntry({ hash: 'before', hashFull: 'before'.padEnd(40, '0'), subject: 'before-round', date: new Date(NOW - 600_000).toISOString() })
    const unparseable = logEntry({ hash: 'odd', hashFull: 'odd'.padEnd(40, '0'), subject: 'odd-date', date: 'not a date' })
    vi.spyOn(api, 'gitLog').mockResolvedValue([beforeRound, inRound, unparseable])

    const { container } = await renderLens({ adds: [], roundStart: NOW - 120_000 })
    expect(container.textContent).toContain('in-round')
    expect(container.textContent).not.toContain('before-round')
    // An unparseable date STAYS (dropping evidence over a clock format).
    expect(container.textContent).toContain('odd-date')
  })

  it('lists added-but-uncommitted paths and the add -A note, and omits landed paths', async () => {
    const landed = logEntry({
      hash: 'landed',
      hashFull: 'landed'.padEnd(40, '0'),
      subject: 'has the file',
      files: [{ path: 'src/landed.ts', status: 'A' }],
    })
    vi.spyOn(api, 'gitLog').mockResolvedValue([landed])
    const adds = extractGitAdds([
      bashCall(1, 'b1', 'git add src/landed.ts'),
      bashCall(2, 'b2', 'git add src/staged-only.ts'),
      bashCall(3, 'b3', 'git add -A'),
    ])

    const { container } = await renderLens({ adds })
    const staged = container.querySelector('[data-section="staged"]')
    expect(staged).not.toBeNull()
    // The landed path is verified into a commit; the staged-only one is not.
    expect(staged!.querySelector('[data-staged-file="src/staged-only.ts"]')).not.toBeNull()
    expect(staged!.querySelector('[data-staged-file="src/landed.ts"]')).toBeNull()
    // The everything-form add cannot be enumerated: its command becomes a note.
    expect(staged!.querySelector('[data-add-all-note]')).not.toBeNull()
    expect(staged!.textContent).toContain('git add -A')
  })

  it('marks the files a round add staged with the add badge after expanding', async () => {
    const entry = logEntry({
      hashFull: 'marked'.padEnd(40, '0'),
      subject: 'carries the add',
      files: [
        { path: 'src/from-add.ts', status: 'M' },
        { path: 'src/other.ts', status: 'M' },
      ],
    })
    vi.spyOn(api, 'gitLog').mockResolvedValue([entry])
    const adds = extractGitAdds([bashCall(1, 'b1', 'git add src/from-add.ts')])

    const { container } = await renderLens({ adds })
    expect(container.querySelector('[data-commit-files]')).toBeNull()
    const chevron = chevronOf(container, entry.hashFull)
    expect(chevron).not.toBeUndefined()
    await act(async () => { chevron!.click() })
    await act(async () => { await Promise.resolve() })

    const files = container.querySelector('[data-commit-files]')
    expect(files).not.toBeNull()
    expect(files!.querySelector('[data-commit-file="src/from-add.ts"] [data-add-badge]')).not.toBeNull()
    expect(files!.querySelector('[data-commit-file="src/other.ts"] [data-add-badge]')).toBeNull()
  })

  it('previews on the row body and toggles files on the chevron (two independent actions)', async () => {
    const entry = logEntry({
      hashFull: 'tworows'.padEnd(40, '0'),
      subject: 'both actions',
      files: [{ path: 'src/a.ts', status: 'M' }],
    })
    vi.spyOn(api, 'gitLog').mockResolvedValue([entry])
    const { container, previews } = await renderLens({ adds: [] })

    const body = container.querySelector<HTMLElement>(`[data-commit="${entry.hashFull}"] [role="button"]`)
    expect(body).not.toBeNull()
    await act(async () => { body!.click() })
    expect(previews).toEqual([{
      kind: 'commit',
      hash: entry.hash,
      hashFull: entry.hashFull,
      subject: entry.subject,
    }])

    const chevron = chevronOf(container, entry.hashFull)
    await act(async () => { chevron!.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-commit-files]')).not.toBeNull()
    // Toggling again folds the list back without touching the preview.
    await act(async () => { chevron!.click() })
    expect(container.querySelector('[data-commit-files]')).toBeNull()
    expect(previews).toHaveLength(1)
  })

  it('recovers the touched files lazily from the commit diff when the log answered without them (old host)', async () => {
    const entry = logEntry({ hashFull: 'oldhost'.padEnd(40, '0'), subject: 'old host' })
    vi.spyOn(api, 'gitLog').mockResolvedValue([entry])
    const commitDiff = vi.spyOn(api, 'gitCommitDiff').mockResolvedValue({
      diff: [
        'diff --git a/src/lazy.ts b/src/lazy.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/lazy.ts',
        '+content',
      ].join('\n'),
    })
    const adds = extractGitAdds([bashCall(1, 'b1', 'git add src/lazy.ts')])

    const { container } = await renderLens({ adds })
    // No files known yet: neither a count pill nor an add badge anywhere.
    expect(container.querySelector('[data-file-count]')).toBeNull()

    const chevron = chevronOf(container, entry.hashFull)
    await act(async () => { chevron!.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(commitDiff).toHaveBeenCalledTimes(1)
    const files = container.querySelector('[data-commit-files]')
    expect(files!.querySelector('[data-commit-file="src/lazy.ts"]')).not.toBeNull()
    // The recovered file IS the staged one: the badge marks it.
    expect(files!.querySelector('[data-commit-file="src/lazy.ts"] [data-add-badge]')).not.toBeNull()
  })

  it('keeps the per-commit file list collapsed by default on any viewport width (regression)', async () => {
    const entry = logEntry({
      hashFull: 'anynarrow'.padEnd(40, '0'),
      subject: 'any viewport',
      files: [{ path: 'src/a.ts', status: 'M' }],
    })
    vi.spyOn(api, 'gitLog').mockResolvedValue([entry])

    // Phone width: the touched-file disclosure starts folded, and tapping
    // the chevron still opens it.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    const phone = await renderLens({ adds: [] })
    try {
      expect(phone.container.querySelector('[data-commit-files]')).toBeNull()
      const chevron = chevronOf(phone.container, entry.hashFull)
      await act(async () => { chevron!.click() })
      await act(async () => { await Promise.resolve() })
      expect(phone.container.querySelector('[data-commit-files]')).not.toBeNull()
    } finally {
      act(() => { phone.root.unmount() })
      phone.container.remove()
    }

    // Desktop width: identical default — the collapse default is deliberately
    // viewport-independent.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    const desktop = await renderLens({ adds: [] })
    try {
      expect(desktop.container.querySelector('[data-commit-files]')).toBeNull()
    } finally {
      act(() => { desktop.root.unmount() })
      desktop.container.remove()
    }
  })

  it('discloses every round commit from the fold handle, then folds them all back', async () => {
    const HASH_FIRST = 'handle1'.padEnd(40, '0')
    const HASH_SECOND = 'handle2'.padEnd(40, '0')
    const HASH_BEFORE = 'handle0'.padEnd(40, '0')
    const first = logEntry({
      hashFull: HASH_FIRST,
      subject: 'first commit',
      files: [{ path: 'src/a.ts', status: 'M' }],
    })
    const second = logEntry({
      hashFull: HASH_SECOND,
      subject: 'second commit',
      files: [{ path: 'src/b.ts', status: 'A' }],
    })
    // A pre-round commit must stay out of the handle's reach.
    const before = logEntry({
      hashFull: HASH_BEFORE,
      subject: 'before the round',
      date: new Date(NOW - 600_000).toISOString(),
      files: [{ path: 'src/old.ts', status: 'M' }],
    })
    vi.spyOn(api, 'gitLog').mockResolvedValue([before, first, second])
    const ref = createRef<LensControl>()

    const { container, root } = await renderLens({ adds: [], ref })
    try {
      expect(container.querySelector('[data-commit-files]')).toBeNull()

      // 全部展开: every ROUND commit's file list opens (the pre-round one
      // does not — it is not part of the round window).
      act(() => { ref.current!.expandAll() })
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector(`[data-commit-files="${HASH_FIRST}"]`)).not.toBeNull()
      expect(container.querySelector(`[data-commit-files="${HASH_SECOND}"]`)).not.toBeNull()
      expect(container.querySelector(`[data-commit-files="${HASH_BEFORE}"]`)).toBeNull()

      // 全部收起: back to the all-folded default.
      act(() => { ref.current!.collapseAll() })
      expect(container.querySelector('[data-commit-files]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reports a log failure and a non-repository workspace instead of an empty round', async () => {
    vi.spyOn(api, 'gitLog').mockRejectedValue(new Error('bad object'))
    const failed = await renderLens({ adds: [] })
    expect(failed.container.querySelector('[role="alert"]')?.textContent).toContain('提交历史加载失败')
    act(() => { failed.root.unmount() })
    failed.container.remove()

    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    const noRepo = await renderLens({ adds: [] })
    try {
      expect(noRepo.container.textContent).toContain('不是 git 仓库')
      expect(noRepo.container.querySelector('[role="alert"]')).toBeNull()
    } finally {
      act(() => { noRepo.root.unmount() })
      noRepo.container.remove()
    }
  })
})
