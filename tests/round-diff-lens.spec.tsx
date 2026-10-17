/**
 * The round-diff lens component: ONE `git diff <rev>` against the baseline
 * {@link pickRoundDiffBase} picked from the log, the M/A/D/R summary band
 * parsed from that SAME patch (no second git read), the inline DiffFiles
 * rendering (no bottom pane), and the empty / not-a-repository / failed
 * states. Also pins the DOM contract the lens sheet's group-scroll CSS hooks
 * onto (expandable file header button → next-sibling body div), so a
 * DiffFiles DOM drift fails here instead of silently unmounting the rules.
 * The api surface is mocked; no git binary, no host.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RoundDiffLens } from '../src/client/changes/RoundDiffLens.tsx'
import { EMPTY_TREE_HASH } from '../src/client/changes/round-diff.ts'
import { api, type GitLogEntry, type GitWorktree } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'
const NOW = Date.now()

/** One pre-round commit (the baseline the lens must aim the diff at). */
function logEntry(overrides: Partial<GitLogEntry>): GitLogEntry {
  return {
    hash: 'abc1234',
    hashFull: 'abc1234abc1234abc1234abc1234abc1234abc1234',
    subject: 'a commit',
    author: 'Agent',
    date: new Date(NOW - 600_000).toISOString(),
    refs: '',
    ...overrides,
  }
}

/** A two-file patch: one modified source file (open by default) and one new
 *  doc (stays folded — DOC_PATH), so both DiffFiles default states appear. */
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/docs/guide.md b/docs/guide.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/guide.md',
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n')

async function renderLens(props: { roundStart?: number } = {}): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(RoundDiffLens, {
      scope: { sessionId: 'session', cwd: MAIN },
      visible: true,
      roundStart: props.roundStart ?? NOW - 120_000,
    }))
  })
  // The load chain is log → diff (two awaits): flush a few microtask turns.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
  return { container, root }
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

describe('RoundDiffLens', () => {
  it('fetches ONE range diff against the pre-round baseline and lays out the M/A/R band plus the patches', async () => {
    const baseline = logEntry({})
    const inRound = logEntry({ hashFull: 'round0round0round0round0round0round0round0round0', date: new Date(NOW - 10_000).toISOString() })
    const log = vi.spyOn(api, 'gitLog').mockResolvedValue([inRound, baseline])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens({ roundStart: NOW - 120_000 })
    try {
      // The baseline pick asked the log for the touched-files window (50).
      const filesCall = log.mock.calls.find(call => call[5]?.files === true)
      expect(filesCall).toBeDefined()
      expect(filesCall![1]).toBe(50)
      // Exactly ONE diff call, aimed at the NEWEST pre-round commit — not
      // the in-round HEAD.
      expect(diffRange).toHaveBeenCalledTimes(1)
      expect(diffRange.mock.calls[0]![1]).toBe(baseline.hashFull)

      // The summary band: one M/A/D/R badge row per parsed patch file.
      const modified = container.querySelector('[data-round-file="src/a.ts"]')
      expect(modified).not.toBeNull()
      expect(modified!.querySelector('[data-tone="modified"]')!.textContent).toBe('M')
      const added = container.querySelector('[data-round-file="docs/guide.md"]')
      expect(added!.querySelector('[data-tone="added"]')!.textContent).toBe('A')
      expect(container.querySelector('[data-section="files"]')!.textContent).toContain(t('changesRoundDiffSection'))

      // The patches render INLINE through DiffFiles (no bottom pane here):
      // the expanded source file's rows are in this lens's own DOM.
      expect(container.textContent).toContain('new')

      // The CSS hook's DOM contract: inside this lens, every expandable file
      // header is a button[aria-expanded] whose body — when rendered — is
      // its NEXT-SIBLING div (the changes sheet caps that sibling and sticks
      // the button). A DiffFiles DOM drift must fail here, not the styling.
      for (const header of container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')) {
        const sibling = header.nextElementSibling
        expect(sibling === null || sibling.tagName === 'DIV', header.textContent ?? '').toBe(true)
      }
      // The modified source file opened by default (its body exists); the
      // new doc stayed folded (header only).
      const headers = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      expect(headers.length).toBe(2)
      const expanded = headers.filter(header => header.getAttribute('aria-expanded') === 'true')
      expect(expanded).toHaveLength(1)
      expect(expanded[0]!.textContent).toContain('src/a.ts')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('aims at the empty tree when every commit sits inside the round', async () => {
    const inRound = logEntry({ date: new Date(NOW - 10_000).toISOString() })
    vi.spyOn(api, 'gitLog').mockResolvedValue([inRound])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens({ roundStart: NOW - 120_000 })
    try {
      expect(diffRange).toHaveBeenCalledTimes(1)
      expect(diffRange.mock.calls[0]![1]).toBe(EMPTY_TREE_HASH)
      expect(container.querySelector('[data-round-file="src/a.ts"]')).not.toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('answers the empty state without a diff fetch for a repository without commits', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      expect(diffRange).not.toHaveBeenCalled()
      expect(container.textContent).toContain(t('changesRoundDiffEmpty'))
      expect(container.querySelector('[data-round-file]')).toBeNull()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reads an empty patch as the round empty state', async () => {
    vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: '' })

    const { container, root } = await renderLens()
    try {
      expect(container.textContent).toContain(t('changesRoundDiffEmpty'))
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('reads a workspace without a repository as notRepo, not as a failure', async () => {
    vi.spyOn(api, 'gitWorktrees').mockResolvedValue([])
    const log = vi.spyOn(api, 'gitLog').mockResolvedValue([logEntry({})])
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      expect(container.textContent).toContain(t('notRepo'))
      expect(diffRange).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('surfaces a failed log as the lens error notice', async () => {
    vi.spyOn(api, 'gitLog').mockRejectedValue(new Error('git died'))
    const diffRange = vi.spyOn(api, 'gitDiffRange').mockResolvedValue({ diff: PATCH })

    const { container, root } = await renderLens()
    try {
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(container.textContent).toContain(t('changesRoundDiffLoadError'))
      expect(diffRange).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
