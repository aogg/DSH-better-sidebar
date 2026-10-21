/**
 * A DIRECTORY that reached the editor's file-viewer lane must divert to the
 * 「文件」page + reveal (activateFilesPage) instead of rendering the read
 * error — and the dead tab closes.
 *
 * The lane this pins: a conversation-body markdown link. The host opens the
 * target as a `dsh-resource://file/…` FILE address (the address grammar has
 * no folder kind), the plugin's editor type claims it, and the minted tab's
 * fs read fails with `"…" is a directory`. The failing read IS the directory
 * probe (the route stats before reading), so the divert costs no extra
 * roundtrip: activate the single-instance files page (the same landing the
 * agent-opens folder push uses, shared through sidebar-folder.ts), reveal the
 * folder row, and close the tab — no error row ever renders.
 *
 * Everything else stays pinned: a real file loads untouched, a non-directory
 * read failure still renders its error row, a directory tab the plugin opened
 * deliberately (`meta.dir`, the manual folder window) never loads a viewer at
 * all, and out-of-tree folders activate the page but reveal nothing (the same
 * `pathWithinCwd` guard the agent-opens lane uses).
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { isDirectoryReadError } from '../src/client/sidebar-folder.ts'
import {
  createBetterSidebarService,
  type BetterSidebarService,
  type SidebarSurface,
} from '../src/client/service.ts'
import { createSidebarStore, type SidebarStore, type SidebarTab } from '../src/client/state.ts'
import css from '../src/client/sidebar.module.css'

setupReactAct()

const fsRead = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsRead: (...args: unknown[]) => fsRead(...args),
    // The folder-window case renders the tree dock, whose git badges poll:
    // park the poll (never settles) — it is irrelevant to what this pins.
    gitStatus: () => new Promise(() => {}),
  },
  mediaUrl: () => '',
}))

const SESSION = 'folder-divert-session'
const CWD = '/tmp'

/** One recorded native-surface files-page open. */
interface NativeOpen {
  sessionId: string
  kind: string
  params: unknown
  revealIfOpened: boolean
}

interface Harness {
  store: SidebarStore
  service: BetterSidebarService
  opens: NativeOpen[]
  closes: Array<{ sessionId: string; tabId: string }>
  ctx: Context
}

/** The service + recording native surface the divert lands through. */
function setup(): Harness {
  const store = createSidebarStore()
  store.setSession(SESSION)
  const service = createBetterSidebarService(store)
  // The editor descriptor must exist: the divert's page open is the
  // path-less editor seed, which resolves through it to the files kind.
  service.registerTab({ id: 'editor', title: 'Files', component: () => null })
  // Two fsRead viewers, mirroring the built-ins that matter here: a `.ts`
  // matcher and the extension-less catch-all (a directory address carries no
  // extension — it is the catch-all the `code` viewer plays in production).
  service.registerFileViewer({
    id: 'mock-text',
    exts: ['ts'],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: () => createElement('div', null, 'mock-text'),
  })
  service.registerFileViewer({
    id: 'mock-code',
    exts: [],
    priority: -100,
    fetchStrategy: 'fsRead',
    component: () => createElement('div', null, 'mock-code'),
  })
  const opens: NativeOpen[] = []
  const closes: Array<{ sessionId: string; tabId: string }> = []
  const surface = {
    openTab: (input: { sessionId: string; kind: string; params: unknown; revealIfOpened: boolean }) => {
      opens.push({ ...input })
    },
    openResource: (input: { sessionId: string; address: string; revealIfOpened: boolean }) => {},
    fileAddress: (sessionId: string, cwd: string | undefined, path: string) => `addr://${sessionId}${cwd ?? ''}${path}`,
    close: (sessionId: string, tabId: string) => {
      closes.push({ sessionId, tabId })
      return { type: 'editor', title: 'sub' }
    },
    update: () => false,
    activate: () => false,
    has: () => false,
  } satisfies SidebarSurface
  service.setSurface(surface)
  const sessionsSnapshot = { byId: { [SESSION]: { id: SESSION, cwd: CWD, displayTitle: 'Root' } }, current: SESSION }
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  return { store, service, opens, closes, ctx }
}

/** Mount one editor tab in the recorded session's scope. */
function mount(harness: Harness, tab: SidebarTab): ReturnType<typeof renderRoot> {
  return renderRoot(createElement(EditorHost, {
    ctx: harness.ctx,
    store: harness.store,
    scope: { sessionId: SESSION, cwd: CWD },
    tab,
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  }))
}

/** The tab the folder link's resource open mints (absolute address spelling). */
function folderTab(path: string): SidebarTab {
  return { id: 'tab1', type: 'editor', title: 'sub', path }
}

/** The route's directory answer, message shape included. */
function directoryError(path: string): Error {
  return Object.assign(new Error(`"${path}" is a directory`), { code: 'fs-error' })
}

beforeEach(() => {
  fsRead.mockReset()
})

describe('a directory in the file-viewer lane diverts to the files page', () => {
  it('activates the files page, reveals the folder and closes the dead tab (in-tree absolute)', async () => {
    const harness = setup()
    fsRead.mockRejectedValue(directoryError('/tmp/src/sub'))
    const { container, unmount } = mount(harness, folderTab('/tmp/src/sub'))
    try {
      await act(async () => { await Promise.resolve() })
      // The landing: the path-less editor seed → the native `files` page,
      // revealed — the same open the agent-opens folder push records.
      expect(harness.opens).toEqual([{
        sessionId: SESSION,
        kind: 'files',
        params: {},
        revealIfOpened: true,
      }])
      // The dead tab goes away.
      expect(harness.closes).toEqual([{ sessionId: SESSION, tabId: 'tab1' }])
      // The reveal: the folder row marked, its PARENT chain expanded, the
      // folder itself never expanded.
      const state = harness.store.getSnapshot().state!
      expect(state.revealed).toEqual(['/tmp/src/sub'])
      expect(state.expanded).toContain('/tmp/src')
      expect(state.expanded).not.toContain('/tmp/src/sub')
      // No error row ever rendered.
      expect(container.querySelector(`.${css.editorError}`)).toBeNull()
    } finally {
      unmount()
    }
  })

  it('resolves a workspace-relative address path against the session cwd', async () => {
    const harness = setup()
    // A session-scoped address names in-tree folders by their RELATIVE path.
    fsRead.mockRejectedValue(directoryError('/tmp/src/sub'))
    const { container, unmount } = mount(harness, folderTab('src/sub'))
    try {
      await act(async () => { await Promise.resolve() })
      expect(harness.opens).toEqual([expect.objectContaining({ kind: 'files' })])
      expect(harness.closes).toEqual([{ sessionId: SESSION, tabId: 'tab1' }])
      const state = harness.store.getSnapshot().state!
      expect(state.revealed).toEqual(['/tmp/src/sub'])
      expect(container.querySelector(`.${css.editorError}`)).toBeNull()
    } finally {
      unmount()
    }
  })

  it('an out-of-tree directory still opens the page and closes the tab, but reveals nothing', async () => {
    const harness = setup()
    fsRead.mockRejectedValue(directoryError('/elsewhere/deep'))
    const { container, unmount } = mount(harness, folderTab('/elsewhere/deep'))
    try {
      await act(async () => { await Promise.resolve() })
      expect(harness.opens).toEqual([{
        sessionId: SESSION,
        kind: 'files',
        params: {},
        revealIfOpened: true,
      }])
      expect(harness.closes).toEqual([{ sessionId: SESSION, tabId: 'tab1' }])
      // No phantom ancestors outside the workspace root.
      const state = harness.store.getSnapshot().state!
      expect(state.revealed).toEqual([])
      expect(state.expanded).toEqual([])
      expect(container.querySelector(`.${css.editorError}`)).toBeNull()
    } finally {
      unmount()
    }
  })
})

describe('the divert stays out of every other read outcome', () => {
  it('a real file loads as before (no page open, no close)', async () => {
    const harness = setup()
    fsRead.mockResolvedValue({ kind: 'text', content: 'hello', size: 5, mtimeMs: 1 })
    const { container, unmount } = mount(harness, folderTab('/tmp/a.ts'))
    try {
      await act(async () => { await Promise.resolve() })
      expect(fsRead).toHaveBeenCalledTimes(1)
      expect(harness.opens).toEqual([])
      expect(harness.closes).toEqual([])
      expect(container.querySelector(`.${css.editorError}`)).toBeNull()
      expect(container.textContent).toContain('mock-text')
    } finally {
      unmount()
    }
  })

  it('a non-directory read failure still renders its error row (no divert)', async () => {
    const harness = setup()
    fsRead.mockRejectedValue(Object.assign(new Error('cannot read "/tmp/a.ts": ENOENT'), { code: 'fs-error' }))
    const { container, unmount } = mount(harness, folderTab('/tmp/a.ts'))
    try {
      await act(async () => { await Promise.resolve() })
      expect(harness.opens).toEqual([])
      expect(harness.closes).toEqual([])
      const errorRow = container.querySelector(`.${css.editorError}`)
      expect(errorRow).not.toBeNull()
      expect(errorRow!.textContent).toContain('ENOENT')
    } finally {
      unmount()
    }
  })

  it('the manual folder window (meta.dir) never loads a viewer, so it never diverts', async () => {
    const harness = setup()
    const { container, unmount } = mount(harness, { id: 'tab1', type: 'editor', title: 'sub', path: '/tmp/src/sub', meta: { dir: true } })
    try {
      await act(async () => { await Promise.resolve() })
      expect(fsRead).not.toHaveBeenCalled()
      expect(harness.opens).toEqual([])
      expect(harness.closes).toEqual([])
      expect(container.querySelector(`.${css.editorError}`)).toBeNull()
    } finally {
      unmount()
    }
  })
})

describe('isDirectoryReadError', () => {
  it('accepts the route\'s directory answer (bare Error or the fs-error envelope)', () => {
    expect(isDirectoryReadError(new Error('"/tmp/x" is a directory'))).toBe(true)
    expect(isDirectoryReadError(directoryError('/tmp/x'))).toBe(true)
  })

  it('refuses every other failure shape', () => {
    // No leading quote: a sentence that merely ends the same way.
    expect(isDirectoryReadError(new Error('something is a directory'))).toBe(false)
    // A foreign wire code.
    expect(isDirectoryReadError(Object.assign(new Error('"/tmp/x" is a directory'), { code: 'http' }))).toBe(false)
    // Ordinary read failures and non-Error rejections.
    expect(isDirectoryReadError(new Error('cannot read "/tmp/a.ts": ENOENT'))).toBe(false)
    expect(isDirectoryReadError('"/tmp/x" is a directory')).toBe(false)
    expect(isDirectoryReadError(undefined)).toBe(false)
  })
})
