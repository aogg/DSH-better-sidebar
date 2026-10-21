/**
 * Conversation FOLDER links land on the plugin's 「文件」page: the host pushes
 * the `sidebar/ws/agent-opens` request (`{ kind: 'folder', target }`) and the
 * feed must
 *   1. open the path-less editor seed — `service.openTab`'s native branch
 *      turns it into the `files`-kind page open (single instance: the host
 *      keeps ONE page per kind and re-focuses it on a repeat open), and
 *   2. reveal the folder in the store's session state (`revealPaths`):
 *      ancestors expand, the FOLDER ITSELF expands (the link asked the
 *      folder open — its children load under the row), the folder row is
 *      highlighted and the tree's reveal-scroll centers it.
 *
 * The previous behavior opened a folder WINDOW (an editor tab with
 * `meta.dir: true` rooted at the folder); that capability stays for manual
 * callers, the push simply no longer routes there. The file and URL branches
 * are pinned unchanged, and the `agentOpenTools` gate still silences every
 * push. Out-of-tree folders activate the page but skip the reveal (the same
 * `pathWithinCwd` guard the editor tree's reveal uses — no phantom rows).
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import {
  createBetterSidebarService,
  type BetterSidebarService,
  type SidebarSurface,
} from '../src/client/service.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'

/** The fake socket records its instances so a test can push frames into the
 *  feed the shell subscribed to. */
const sockets: FakeWebSocket[] = []
class FakeWebSocket {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(readonly url: string) { sockets.push(this) }
}

/** The agent-opens socket the shell opened for this mount. */
function agentOpensSocket(): FakeWebSocket {
  const socket = sockets.find(candidate => candidate.url.includes('agent-opens'))
  if (socket === undefined) throw new Error(`no agent-opens socket in ${JSON.stringify(sockets.map(s => s.url))}`)
  return socket
}

function makeSessionFeed(initial: SidebarSessionList) {
  const snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** One recorded native-surface open. */
interface NativeOpen {
  sessionId: string
  kind: string
  params: unknown
  revealIfOpened: boolean
}

interface NativeResourceOpen {
  sessionId: string
  address: string
  revealIfOpened: boolean
}

/** `ctx.sidebarRight`, replaced by a stand-in that records the browser-tab
 *  opens (the URL branch) and reports the seat the shell binds state to. */
function makeColumnSpy(mounted: string | undefined) {
  const browserOpens: Array<{ kind: string; options: unknown }> = []
  return {
    browserOpens,
    face: {
      isExpanded: () => false,
      toggleExpanded: () => {},
      active: () => undefined,
      openTab: (kind: string, options?: unknown) => { browserOpens.push({ kind, options }) },
      mounted: {
        getSnapshot: () => mounted,
        subscribe: () => () => {},
      },
    },
  }
}

interface MountedSidebar {
  store: SidebarStore
  service: BetterSidebarService
  surface: { opens: NativeOpen[]; resources: NativeResourceOpen[] }
  column: ReturnType<typeof makeColumnSpy>
  sessionId: string
  container: HTMLDivElement
  unmount: () => void
}

let sessionSeq = 0
const mounted: MountedSidebar[] = []

function mountSidebar(prefs: Record<string, unknown> = {}): MountedSidebar {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const sessionId = `folder-link-${++sessionSeq}`
  const initial: SidebarSessionList = {
    byId: {
      [sessionId]: { id: sessionId, cwd: '/tmp', displayTitle: 'Root' },
    },
  }
  const feed = makeSessionFeed(initial)
  const store = createSidebarStore()
  store.setPrefs({ ...store.getPrefs(), agentOpenTools: true, ...prefs })
  store.setSession(sessionId)
  const service = createBetterSidebarService(store)
  const opens: NativeOpen[] = []
  const resources: NativeResourceOpen[] = []
  const surface = {
    opens,
    resources,
    surface: {
      openTab: (input: { sessionId: string; kind: string; params: unknown; revealIfOpened: boolean }) => {
        opens.push({ ...input })
      },
      openResource: (input: { sessionId: string; address: string; revealIfOpened: boolean }) => {
        resources.push({ sessionId: input.sessionId, address: input.address, revealIfOpened: input.revealIfOpened })
      },
      fileAddress: (sessionId: string, cwd: string | undefined, path: string) => `addr://${sessionId}${cwd ?? ''}${path}`,
      close: () => undefined,
      update: () => false,
      activate: () => false,
      has: () => false,
    } satisfies SidebarSurface,
  }
  service.setSurface(surface.surface)
  // The path-less editor seed resolves through the `editor` descriptor: its
  // presence (and lack of a createTab factory) is what routes the open to the
  // files page kind.
  service.registerTab({ id: 'editor', title: 'Files', component: () => null })
  const column = makeColumnSpy(sessionId)
  const localeSnapshot = { active: 'en' }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: feed },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar'
      ? service
      : name === 'sidebarRight' ? column.face : undefined,
  } as unknown as Context
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx, store })) })
  const result = {
    store,
    service,
    surface,
    column,
    sessionId,
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
  mounted.push(result)
  return result
}

/** Push one agent-open frame into the feed the shell subscribed to. */
function push(socket: FakeWebSocket, request: Record<string, unknown>): void {
  act(() => { socket.onmessage?.({ data: JSON.stringify(request) }) })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sockets.length = 0
})

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

describe('agent-opens folder link → the files page + reveal', () => {
  it('activates the files page and reveals the folder row (opened, not just pointed at)', () => {
    const sidebar = mountSidebar()
    const socket = agentOpensSocket()
    // The feed subscribed for THIS session.
    expect(socket.url).toContain(`sessionId=${encodeURIComponent(sidebar.sessionId)}`)

    push(socket, { kind: 'folder', target: '/tmp/src/sub', title: 'sub' })

    // The page open: the path-less editor seed → the native `files` kind,
    // revealed (the click is the reader's own gesture — no park, no dot).
    expect(sidebar.surface.opens).toEqual([{
      sessionId: sidebar.sessionId,
      kind: 'files',
      params: {},
      revealIfOpened: true,
    }])
    // The reveal: the folder row is marked, its PARENT chain expanded AND
    // the folder itself (its children load below the highlight).
    const state = sidebar.store.getSnapshot().state!
    expect(state.revealed).toEqual(['/tmp/src/sub'])
    expect(state.expanded).toContain('/tmp/src')
    expect(state.expanded).toContain('/tmp/src/sub')
  })

  it('re-points the SAME single-instance page on a second folder link', () => {
    const sidebar = mountSidebar()
    const socket = agentOpensSocket()
    push(socket, { kind: 'folder', target: '/tmp/src', title: 'src' })
    push(socket, { kind: 'folder', target: '/tmp/docs', title: 'docs' })
    // Two pushes, one page: the host's one-page-per-kind open focuses the
    // existing page instead of minting a folder window per link.
    expect(sidebar.surface.opens).toHaveLength(2)
    expect(sidebar.surface.opens.every(open => open.kind === 'files' && open.revealIfOpened === true)).toBe(true)
    // The reveal REPLACES the set: only the newest locator is lit.
    expect(sidebar.store.getSnapshot().state!.revealed).toEqual(['/tmp/docs'])
  })

  it('an out-of-tree folder still opens the page but reveals nothing', () => {
    const sidebar = mountSidebar()
    const socket = agentOpensSocket()
    push(socket, { kind: 'folder', target: '/elsewhere/deep', title: 'deep' })
    expect(sidebar.surface.opens).toEqual([{
      sessionId: sidebar.sessionId,
      kind: 'files',
      params: {},
      revealIfOpened: true,
    }])
    const state = sidebar.store.getSnapshot().state!
    // No phantom ancestors outside the workspace root.
    expect(state.revealed).toEqual([])
    expect(state.expanded).toEqual([])
  })

  it('the agentOpenTools gate still silences folder pushes', () => {
    const sidebar = mountSidebar({ agentOpenTools: false })
    const socket = agentOpensSocket()
    push(socket, { kind: 'folder', target: '/tmp/src', title: 'src' })
    expect(sidebar.surface.opens).toEqual([])
    const state = sidebar.store.getSnapshot().state!
    expect(state.revealed).toEqual([])
    expect(state.expanded).toEqual([])
  })
})

describe('agent-opens file and url branches are untouched', () => {
  it('a file push still opens the resource in the editor lane', () => {
    const sidebar = mountSidebar()
    const socket = agentOpensSocket()
    push(socket, { kind: 'file', target: '/tmp/a.ts', title: 'a.ts' })
    expect(sidebar.surface.opens).toEqual([])
    expect(sidebar.surface.resources).toEqual([
      expect.objectContaining({
        sessionId: sidebar.sessionId,
        address: expect.stringContaining('/tmp/a.ts'),
        revealIfOpened: true,
      }),
    ])
  })

  it('a url push still lands in the host browser tab type', () => {
    const sidebar = mountSidebar()
    const socket = agentOpensSocket()
    push(socket, { kind: 'url', target: 'https://example.com/x' })
    expect(sidebar.column.browserOpens).toEqual([
      { kind: 'browser', options: { params: { url: 'https://example.com/x' } } },
    ])
  })
})
