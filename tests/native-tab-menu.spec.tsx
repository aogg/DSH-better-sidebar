/**
 * The copy-path rows this plugin appends to the HOST's native right-Sidebar
 * tab context menu (src/client/native/tab-menu.tsx).
 *
 * Right-clicking a native tab chip opens the host's own menu, and everything
 * registered on the `sidebar.right.tab.menu.item` slot renders after the
 * host's close row. These cases pin the component contract at the slot's
 * render boundary:
 *   1. only a parseable `dsh-resource://file/…` address with a non-empty
 *      path renders rows — a page tab (`sidebar://…`), the workspace-root
 *      address (empty path) and an unparseable address add NOTHING;
 *   2. the two rows mirror the plugin's own TabBar menu: the zh labels
 *      (「复制相对地址」/「复制绝对地址」), the relative row projecting the
 *      address path onto the session's workspace root and the absolute row
 *      copying it verbatim, both through `writeClipboard` and both dismissing
 *      the menu exactly once;
 *   3. the projection follows the ADDRESS's session, not the seat session —
 *      a tab can show another session's file (the native surface's
 *      `sessionIdOf` rule), so a session-scoped address of session B opened
 *      on a seat in session A must resolve B's cwd: `useSessionRoot` watches
 *      B's id (pinned through the push socket's `watch` frame) and the
 *      relative row clips to B's root, while the seat root would leave the
 *      path untouched;
 *   4. the legacy `absolute` scope (no session at all) still renders both
 *      rows and copies its decoded path.
 *
 * The stubs are the shapes the sibling specs already use: the clipboard wire
 * at `navigator.clipboard.writeText` (what the primitives' `writeClipboard`
 * prefers) and the locale at `navigator.language` = 'zh-CN' (the TabBar
 * menu spec's stubZh/stubClipboard dance), plus the minimal client ctx —
 * a stable `ctx.sessions.list` snapshot for `useSessionRoot`'s
 * `useSyncExternalStore` and a module-mocked `api.sessionCwd` kept ONLY to
 * assert the hook never polls HTTP (the answer rides a ws frame).
 * Addresses are built with the real grammar builders
 * (`sessionFileAddress` / `absoluteFileAddress`), so the encoded round trip
 * (the `%20` space) is exercised, not hand-spelled.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { renderRoot, setupReactAct } from './test-utils.ts'
setupReactAct()

// useSessionRoot must never ask the host route over HTTP; the mock keeps the
// module importable and its call log readable for the zero-HTTP assertion.
vi.mock('../src/client/api.ts', () => ({
  api: {
    sessionCwd: vi.fn(async (scope: { sessionId: string }) => {
      const cwd = scope.sessionId === 's2' ? '/worktree-b' : '/work-a'
      return { sessionId: scope.sessionId, cwd, root: cwd, parent: null }
    }),
  },
}))

import { api } from '../src/client/api.ts'
import { NativeTabMenuItems } from '../src/client/native/tab-menu.tsx'
import { absoluteFileAddress, sessionFileAddress } from '../src/client/resource-address.ts'
import { createSidebarStore } from '../src/client/state.ts'

/** The smallest WebSocket the connector opens: driven, never networking. */
class FakeSocket {
  static instances: FakeSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readonly url: string
  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(frame: string): void { this.sent.push(frame) }
  close(): void { this.closed = true; this.readyState = 3 }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  drop(): void { this.readyState = 3; this.onclose?.() }
  /** One host frame. */
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  /** The frames the connector sent, as parsed objects. */
  frames(): { op: string; sessionIds: string[] }[] {
    return this.sent.map(frame => JSON.parse(frame) as { op: string; sessionIds: string[] })
  }
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  // The module mock is file-scoped: cleared so a test's zero-HTTP assertion
  // never sees an earlier test's calls.
  vi.mocked(api.sessionCwd).mockClear()
})

/** Point the browser-language fallback at Chinese so the row labels assert. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

/**
 * Stub the clipboard wire writeClipboard actually uses: the primitives'
 * clipboard.js prefers `navigator.clipboard.writeText` and only falls back
 * to a `document.execCommand('copy')` textarea when the host omits it, so
 * pinning writeText pins the copy in jsdom. Call AFTER stubZh(): the zh stub
 * replaces `globalThis.navigator` wholesale, and the spy has to land on that
 * replacement object.
 */
function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return { writeText }
}

/**
 * The minimal client ctx the rows read: only the sessions list feed
 * `useSessionRoot` consults. The snapshot is ONE stable object —
 * `useSyncExternalStore` re-reads it on every render, and a fresh object per
 * call is an infinite-loop warn.
 */
function createCtx(): unknown {
  const snapshot = {
    byId: {
      s1: { id: 's1', cwd: '/work-a' },
      s2: { id: 's2', cwd: '/worktree-b' },
    },
  }
  return { sessions: { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } } }
}

/** Mount the rows for one tab contentId (the seat session defaults to s1). */
function mountMenu(contentId: string, seatSessionId = 's1'): {
  rows: () => HTMLElement[]
  dismiss: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  const dismiss = vi.fn()
  const view = renderRoot(createElement(NativeTabMenuItems, {
    ctx: createCtx() as never,
    store: createSidebarStore(),
    sessionId: seatSessionId,
    tab: { id: 'tab-1', kind: 'editor', title: 'main.ts', contentId },
    dismiss,
  }))
  return {
    rows: () => [...view.container.querySelectorAll<HTMLElement>('button[role="menuitem"]')],
    dismiss,
    unmount: view.unmount,
  }
}

/** Flush pending microtasks (a frame's setState) inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  })
}

/** Dispatch a native click (the rows are plain buttons, no portal involved). */
function click(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('NativeTabMenuItems (the host tab-menu copy rows)', () => {
  it('renders the two zh rows for a session file tab', () => {
    stubZh()
    const { rows, unmount } = mountMenu(sessionFileAddress('s1', 'src/main.ts'))
    try {
      const items = rows()
      expect(items).toHaveLength(2)
      expect(items.map(item => item.textContent)).toEqual(['复制相对地址', '复制绝对地址'])
    } finally {
      unmount()
    }
  })

  it('the relative row copies the path projected onto the session cwd and dismisses once', async () => {
    stubZh()
    const { writeText } = stubClipboard()
    // Absolute-in-session spelling: the leading `/` survives the address
    // (a session address may name a file outside the workspace), so the
    // relative row has real projection work to do — a relative-spelled
    // address would pass through relativeTo untouched and pin nothing.
    // The space rides encoded in the address and must decode back.
    const { rows, dismiss, unmount } = mountMenu(sessionFileAddress('s1', '/work-a/src/my notes.md'))
    try {
      await settle()
      click(rows()[0]!)
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('src/my notes.md')
      expect(dismiss).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  it('the absolute row copies the address path verbatim', async () => {
    stubZh()
    const { writeText } = stubClipboard()
    const { rows, dismiss, unmount } = mountMenu(sessionFileAddress('s1', '/work-a/src/my notes.md'))
    try {
      await settle()
      click(rows()[1]!)
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('/work-a/src/my notes.md')
      expect(dismiss).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  it('a session address of ANOTHER session projects against that session\'s cwd', async () => {
    stubZh()
    const { writeText } = stubClipboard()
    // The seat is s1 (/work-a); the tab shows s2's file (/worktree-b). The
    // component must hand the ADDRESS's session to useSessionRoot — the seat
    // root would not contain the path, and relativeTo would return it
    // unchanged, failing the clipboard assertion below.
    const { rows, unmount } = mountMenu(sessionFileAddress('s2', '/worktree-b/src/main.ts'), 's1')
    try {
      // The mechanism half: the push socket watches the ADDRESS's session —
      // and never the seat's — and the answer rides a frame (zero HTTP).
      const socket = FakeSocket.instances[0]
      if (socket === undefined) throw new Error('no socket opened')
      socket.open()
      expect(socket.frames()).toEqual([{ op: 'watch', sessionIds: ['s2'] }])
      act(() => {
        socket.frame({ kind: 'cwd', sessionId: 's2', cwd: '/worktree-b', root: 'worktree-b', parent: null })
      })
      expect(vi.mocked(api.sessionCwd)).not.toHaveBeenCalled()
      // The outcome half: clipped to /worktree-b.
      await settle()
      click(rows()[0]!)
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('src/main.ts')
    } finally {
      unmount()
    }
  })

  it('a page tab, the workspace-root address and an unparseable address render no rows', () => {
    stubZh()
    const { writeText } = stubClipboard()
    for (const contentId of [
      'sidebar://editor',
      sessionFileAddress('s1', ''),
      'dsh-resource://file/garbage/x',
    ]) {
      const { rows, dismiss, unmount } = mountMenu(contentId)
      try {
        expect(rows(), contentId).toHaveLength(0)
        expect(dismiss).not.toHaveBeenCalled()
      } finally {
        unmount()
      }
    }
    expect(writeText).not.toHaveBeenCalled()
  })

  it('the legacy absolute scope still renders both rows and copies its path verbatim', async () => {
    stubZh()
    const { writeText } = stubClipboard()
    // `fileAddressFor` no longer mints this scope, but legacy and third-party
    // addresses still spell it — the rows must keep working there, resolved
    // against the seat session (the address carries none).
    const { rows, unmount } = mountMenu(absoluteFileAddress('/opt/data/notes.md'), 's1')
    try {
      await settle()
      expect(rows()).toHaveLength(2)
      click(rows()[1]!)
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('/opt/data/notes.md')
    } finally {
      unmount()
    }
  })
})
