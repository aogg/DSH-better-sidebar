/**
 * The per-file folding of the shared diff renderer (DiffFiles) and its two
 * commit surfaces: desktop keeps the source-open defaults, while a phone
 * viewport (the repo's own narrow breakpoint, innerWidth < 768) hands the
 * renderer `allCollapsedByDefault` so a commit patch opens as an all-folded
 * file list — one tap per header. Worktree diffs and the fold-independent
 * defaults are pinned here too. The git api is mocked: no host, no binary.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffFiles } from '../src/client/diff/DiffFiles.tsx'
import { DiffPane } from '../src/client/changes/DiffPane.tsx'
import { DiffTab } from '../src/client/DiffTab.tsx'
import { api, type SessionScope } from '../src/client/api.ts'
import type { Context } from '../src/context-types.ts'
import type { SidebarDiffRef } from '../src/client/state.ts'

import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old-a',
  '+new-a',
  'diff --git a/tests/b.spec.ts b/tests/b.spec.ts',
  '--- a/tests/b.spec.ts',
  '+++ b/tests/b.spec.ts',
  '@@ -1 +1 @@',
  '-old-b',
  '+new-b',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old-doc',
  '+new-doc',
].join('\n')

const SCOPE: SessionScope = { sessionId: 's1', cwd: '/p' }
const COMMIT_REF: SidebarDiffRef = { kind: 'commit', hash: 'abc1234', hashFull: 'a'.repeat(40), subject: 'subject' }

/** Point the viewport probe (window.innerWidth, read at mount) at a width. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
}

/** Flush the async git loader (useGitDiffTarget) through its act rounds. */
async function flushLoader(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve() })
}

function headersOf(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('DiffFiles file folding', () => {
  it('expands source by default while tests and docs stay collapsed', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root: Root = createRoot(container)
    try {
      act(() => { root.render(createElement(DiffFiles, { diff })) })
      const headers = headersOf(container)
      expect(headers).toHaveLength(3)
      expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false'])
      expect(container.textContent).toContain('new-a')
      expect(container.textContent).not.toContain('new-b')
      expect(container.textContent).not.toContain('new-doc')

      act(() => { headers[1]!.click() })
      expect(headers[1]!.getAttribute('aria-expanded')).toBe('true')
      expect(container.textContent).toContain('new-b')

      act(() => { headers[0]!.click() })
      expect(headers[0]!.getAttribute('aria-expanded')).toBe('false')
      expect(container.textContent).not.toContain('new-a')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})

describe('DiffFiles allCollapsedByDefault', () => {
  it('starts every file folded and rebuilds the defaults when the flag flips', () => {
    const rendered = renderRoot(createElement(DiffFiles, { diff, allCollapsedByDefault: true }))
    const { container, rerender } = rendered
    const headers = headersOf(container)
    expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false'])
    expect(container.textContent).not.toContain('new-a')

    // One tap opens exactly that file — and a second re-folds it.
    act(() => { headers[0]!.click() })
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('new-a')
    act(() => { headers[0]!.click() })
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('new-a')

    // With BOTH the document and the flag unchanged, a manual expansion
    // survives a re-render (the existing reset contract).
    act(() => { headers[0]!.click() })
    rerender(createElement(DiffFiles, { diff, allCollapsedByDefault: true }))
    expect(headersOf(container)[0]!.getAttribute('aria-expanded')).toBe('true')

    // Crossing the breakpoint (flag true → false → true) rebuilds the
    // default set each time.
    rerender(createElement(DiffFiles, { diff, allCollapsedByDefault: false }))
    expect(headersOf(container).map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false'])
    rerender(createElement(DiffFiles, { diff, allCollapsedByDefault: true }))
    expect(headersOf(container).map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false'])
    rendered.unmount()
  })
})

describe('commit patch on a phone viewport (the two call sites)', () => {
  it('DiffTab folds a commit patch at a narrow width; one tap opens, another re-folds', async () => {
    setViewportWidth(390)
    vi.spyOn(api, 'gitCommitDiff').mockResolvedValue({ diff })
    const rendered = renderRoot(createElement(DiffTab, { sessionId: SCOPE.sessionId, cwd: SCOPE.cwd, diff: COMMIT_REF }))
    const { container } = rendered
    await flushLoader()

    const headers = headersOf(container)
    expect(headers).toHaveLength(3)
    expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false'])
    expect(container.textContent).toContain('src/a.ts')
    expect(container.textContent).not.toContain('new-a')

    act(() => { headers[0]!.click() })
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('new-a')
    act(() => { headers[0]!.click() })
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('new-a')
    rendered.unmount()
  })

  it('DiffTab keeps the source-open desktop defaults for a commit at a wide width', async () => {
    setViewportWidth(1280)
    vi.spyOn(api, 'gitCommitDiff').mockResolvedValue({ diff })
    const rendered = renderRoot(createElement(DiffTab, { sessionId: SCOPE.sessionId, cwd: SCOPE.cwd, diff: COMMIT_REF }))
    await flushLoader()

    expect(headersOf(rendered.container).map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false'])
    expect(rendered.container.textContent).toContain('new-a')
    expect(rendered.container.textContent).not.toContain('new-b')
    expect(rendered.container.textContent).not.toContain('new-doc')
    rendered.unmount()
  })

  it('DiffPane folds a commit patch at a narrow width', async () => {
    setViewportWidth(390)
    vi.spyOn(api, 'gitCommitDiff').mockResolvedValue({ diff })
    const rendered = renderRoot(createElement(DiffPane, {
      target: { kind: 'git', ref: COMMIT_REF },
      ctx: {} as Context,
      scope: SCOPE,
      height: 300,
      onHeightCommit: () => {},
      onClose: () => {},
      onExpand: () => {},
    }))
    await flushLoader()

    expect(headersOf(rendered.container).map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false'])
    expect(rendered.container.textContent).not.toContain('new-a')
    rendered.unmount()
  })

  it('DiffPane leaves a worktree change untouched at a narrow width', async () => {
    setViewportWidth(390)
    vi.spyOn(api, 'gitDiff').mockResolvedValue({ diff })
    const rendered = renderRoot(createElement(DiffPane, {
      target: { kind: 'git', ref: { kind: 'worktree', path: 'src/a.ts', staged: false } },
      ctx: {} as Context,
      scope: SCOPE,
      height: 300,
      onHeightCommit: () => {},
      onClose: () => {},
      onExpand: () => {},
    }))
    await flushLoader()

    expect(headersOf(rendered.container).map(header => header.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false'])
    expect(rendered.container.textContent).toContain('new-a')
    rendered.unmount()
  })
})
