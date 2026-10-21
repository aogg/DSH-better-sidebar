/**
 * Session-turn auto refresh (the WS `turn` frames → EditorHost): a settled
 * reply step — the turn's LAST durable `assistant/message` row, 400ms
 * coalesced by the host — re-reads the open file ONCE through the same load
 * path the header's refresh button uses, and nothing else does.
 *
 * The harness follows tests/editor-auto-refresh.spec.tsx (#855's spec): the
 * real EditorHost over a real store/service, `api.fsRead` mocked and COUNTED
 * (the number IS the "did the preview re-read" evidence), `api.changesOps`
 * mocked so the ops poll stays quiet. The turn channel itself
 * (`subscribeSessionTurns`) is mocked into a captured registry — the tests
 * drive a frame by calling the tab's own callback, so every reload here is
 * provably turn-triggered: no poll, no timer, no mount-time fetch.
 * What the tests pin down:
 * - one frame → exactly one reload (and a parked tab reloads too),
 * - the dirty/edit guards (#855's priority) veto the reload,
 * - the transient `refreshingTabs` mark (the tab spinners' source) is in the
 *   store WHILE the reload's read is in flight and gone once it settles,
 * - folder windows and the path-less files home never subscribe.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useEffect, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService, type EditorToolbarControls, type EditorToolbarState, type FileViewerProps } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, type SidebarStore, type SidebarTab } from '../src/client/state.ts'

setupReactAct()

const fsRead = vi.fn()
const changesOps = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    fsRead: (...args: unknown[]) => fsRead(...args),
    changesOps: (...args: unknown[]) => changesOps(...args),
    mediaUrl: () => '',
    // The folder-window case renders the tree dock: park its git-badge poll
    // and answer its level loads with an empty level (neither matters here —
    // the folder window only has to mount without a turn subscription).
    gitStatus: () => new Promise(() => {}),
    fsTrees: async () => ({ levels: {}, truncated: false }),
  },
}))

/**
 * The turn channel, captured: session → that session's live subscriber
 * callbacks (one per mounted editor tab — the single-connection sharing one
 * level down is turn-push.spec.ts's own subject, mocked away here).
 */
const turnSubs = new Map<string, Set<() => void>>()
const subscribeTurns = vi.fn((sessionId: string, onTurn: () => void): (() => void) => {
  let set = turnSubs.get(sessionId)
  if (set === undefined) turnSubs.set(sessionId, set = new Set())
  set.add(onTurn)
  return () => { set.delete(onTurn) }
})
vi.mock('../src/client/turn-push.ts', () => ({
  subscribeSessionTurns: (sessionId: string, onTurn: () => void): (() => void) => subscribeTurns(sessionId, onTurn),
}))

/** fsRead call count: the "did anything re-read the file" evidence. */
function reads(): number {
  return fsRead.mock.calls.length
}

/** Deliver one coalesced `turn` frame to a session's subscribers. */
function emitTurn(sessionId: string): void {
  act(() => {
    for (const onTurn of [...(turnSubs.get(sessionId) ?? [])]) onTurn()
  })
}

/** Whether the tab's subscription is live (mounted without a disposer run). */
function subscribed(sessionId: string): boolean {
  return (turnSubs.get(sessionId)?.size ?? 0) > 0
}

/**
 * The mock viewer: a viewer-owned draft (the input) plus a hoisted toolbar, so
 * a reload is observable as a REMOUNT (the draft resets to the new content) and
 * a dirty state is observable exactly like the real text editor reports it.
 */
function MockViewer(props: {
  content?: string
  initialMode: 'preview' | 'edit'
  onToolbarState?: (state: EditorToolbarState) => void
  onToolbarControls?: (controls: EditorToolbarControls | null) => void
}) {
  const { content, initialMode, onToolbarState, onToolbarControls } = props
  const [mode, setMode] = useState<'preview' | 'edit'>(initialMode)
  const [draft, setDraft] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    onToolbarState?.({ modes: true, mode, dirty, editable: true, saveState: 'idle' })
  }, [mode, dirty, onToolbarState])
  useEffect(() => {
    onToolbarControls?.({
      setMode: (next) => { setMode(next) },
      save: () => { setDraft(null); setDirty(false) },
    })
    return () => { onToolbarControls?.(null) }
  }, [onToolbarControls])
  return createElement('div', null, [
    createElement('span', { key: 'mode', 'data-testid': 'mode' }, `mode-${mode}`),
    createElement('input', {
      key: 'draft',
      'data-testid': 'draft',
      value: draft ?? content ?? '',
      onChange: (event: { target: { value: string } }) => {
        setDraft(event.target.value)
        setDirty(true)
      },
    }),
  ])
}

interface Harness {
  ctx: Context
  store: SidebarStore
  tabOf: (path: string) => SidebarTab
  tabWithMeta: (path: string, meta: Record<string, unknown>) => SidebarTab
  homeTab: () => SidebarTab
}

/** One sidebar store + service; tabs are minted per file path. */
function harness(sessionId: string, initialMode: 'preview' | 'edit' = 'preview'): Harness {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  service.registerFileViewer({
    id: 'mock-text',
    exts: ['ts'],
    priority: 0,
    fetchStrategy: 'fsRead',
    component: (props: FileViewerProps) => createElement(MockViewer, {
      content: props.content,
      initialMode,
      onToolbarState: props.onToolbarState,
      onToolbarControls: props.onToolbarControls,
    }),
  })
  store.setSession(sessionId)
  const ctx = {
    betterSidebar: service,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/tmp' } } }) } },
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  const mint = (tab: SidebarTab): SidebarTab => {
    ctx.betterSidebar.openTab({ type: 'editor', title: tab.title, path: tab.path, id: tab.id, meta: tab.meta })
    return allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs)
      .find(candidate => candidate.id === tab.id)!
  }
  return {
    ctx,
    store,
    tabOf: (path) => mint({ id: `editor:${path}`, type: 'editor', title: path.split('/').pop()!, path }),
    tabWithMeta: (path, meta) => mint({ id: `editor:${path}`, type: 'editor', title: path.split('/').pop()!, path, meta }),
    homeTab: () => mint({ id: 'editor:home', type: 'editor', title: 'Files' }),
  }
}

/** The EditorHost element for one tab (visible defaults to on screen). */
function editorElement(ctx: Context, store: SidebarStore, sessionId: string, tab: SidebarTab, visible = true): ReturnType<typeof createElement> {
  return createElement(EditorHost, {
    ctx,
    store,
    scope: { sessionId, cwd: '/tmp' },
    tab,
    visible,
    expanded: [],
    revealed: [],
    onToggleDir: () => {},
    onReferenceFile: () => {},
  })
}

function mount(ctx: Context, store: SidebarStore, sessionId: string, tab: SidebarTab, visible = true): ReturnType<typeof renderRoot> {
  return renderRoot(editorElement(ctx, store, sessionId, tab, visible))
}

/** Let the mount's initial fsRead and the ops stream's baseline pull settle. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/** The mounted viewer's draft input (a remount resets it to the fresh content). */
function draftOf(container: HTMLElement): string {
  return container.querySelector<HTMLInputElement>('[data-testid="draft"]')!.value
}

/** Type into the viewer's draft (the user's unsaved edit). */
function type(container: HTMLElement, text: string): void {
  const input = container.querySelector<HTMLInputElement>('[data-testid="draft"]')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

let contentVersion = 0

beforeEach(() => {
  vi.useFakeTimers()
  contentVersion = 0
  turnSubs.clear()
  subscribeTurns.mockClear()
  fsRead.mockReset()
  // Every read answers a NEW body: a re-read is visible in the DOM, and a
  // non-re-read keeps the previous one.
  fsRead.mockImplementation(async () => ({ kind: 'text', content: `body-${++contentVersion}`, size: 1 }))
  changesOps.mockReset()
  changesOps.mockResolvedValue({ events: [], lastSeq: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('editor session-turn auto refresh', () => {
  it('A: a turn frame re-reads and re-renders the open file exactly once', async () => {
    const { ctx, store, tabOf } = harness('turn-a')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-a', tab)
    try {
      await settle()
      expect(reads()).toBe(1)
      expect(draftOf(view.container)).toBe('body-1')

      emitTurn('turn-a')
      await settle()

      // One frame, one reload: the second read re-mounted the viewer with the
      // fresh body, and nothing else fired.
      expect(reads()).toBe(2)
      expect(draftOf(view.container)).toBe('body-2')

      // Advancing the clock proves the absence of any read poller: no timer
      // anywhere re-reads the file — the ONLY entry is the turn frame.
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(reads()).toBe(2)
    } finally {
      view.unmount()
    }
  })

  it('A: a parked (visible: false) editor tab still refreshes on a turn frame', async () => {
    const { ctx, store, tabOf } = harness('turn-a-parked')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-a-parked', tab, false)
    try {
      await settle()
      expect(reads()).toBe(1)

      emitTurn('turn-a-parked')
      await settle()

      expect(reads()).toBe(2)
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
    }
  })

  it('B: a dirty draft is never overwritten by a turn frame (no reload, no mark)', async () => {
    const { ctx, store, tabOf } = harness('turn-b-dirty')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-b-dirty', tab)
    try {
      await settle()
      expect(reads()).toBe(1)
      type(view.container, 'my unsaved draft')
      expect(draftOf(view.container)).toBe('my unsaved draft')

      emitTurn('turn-b-dirty')
      await settle()

      // The user's input survives: no reload, no remount, no fsRead — and no
      // spinner mark either (the veto happens before anything is stamped).
      expect(draftOf(view.container)).toBe('my unsaved draft')
      expect(reads()).toBe(1)
      expect(store.getSnapshot().state!.refreshingTabs).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('B: an open edit session is left alone (its caret must not jump)', async () => {
    const { ctx, store, tabOf } = harness('turn-b-edit', 'edit')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-b-edit', tab)
    try {
      await settle()
      expect(view.container.querySelector('[data-testid="mode"]')!.textContent).toBe('mode-edit')
      expect(reads()).toBe(1)

      emitTurn('turn-b-edit')
      await settle()

      expect(reads()).toBe(1)
      expect(store.getSnapshot().state!.refreshingTabs).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it('C: the refreshing mark is in the store WHILE the reload reads and gone once it settles', async () => {
    const { ctx, store, tabOf } = harness('turn-c-mark')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-c-mark', tab)
    try {
      await settle()
      expect(reads()).toBe(1)

      // The turn-triggered read is held in flight…
      let release: (value: { kind: string; content: string; size: number }) => void = () => {}
      fsRead.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      emitTurn('turn-c-mark')
      await settle()

      // …so the mark rides the store (the tab spinners' source)…
      expect(reads()).toBe(2)
      expect(store.getSnapshot().state!.refreshingTabs).toEqual([tab.id])

      // …and the settled read retires it.
      await act(async () => { release({ kind: 'text', content: 'body-2', size: 1 }) })
      await settle()
      expect(store.getSnapshot().state!.refreshingTabs).toEqual([])
      expect(draftOf(view.container)).toBe('body-2')
    } finally {
      view.unmount()
    }
  })

  it('C: closing a tab MID-refresh does not leave the mark behind', async () => {
    const { ctx, store, tabOf } = harness('turn-c-close')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-c-close', tab)
    try {
      await settle()
      let release: (value: { kind: string; content: string; size: number }) => void = () => {}
      fsRead.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      emitTurn('turn-c-close')
      await settle()
      expect(store.getSnapshot().state!.refreshingTabs).toEqual([tab.id])

      // The tab closes while its reload is still in flight: the unmount
      // cleanup must stamp the mark out of the session's state.
      view.unmount()
      expect(store.getSnapshot().state!.refreshingTabs).toEqual([])
      release({ kind: 'text', content: 'body-2', size: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('D: a folder window and the path-less home never subscribe to turns', async () => {
    const { ctx, store, tabWithMeta, homeTab } = harness('turn-d-nosub')
    const folder = tabWithMeta('/tmp/notes', { dir: true })
    const home = homeTab()
    const folderView = mount(ctx, store, 'turn-d-nosub', folder)
    const homeView = mount(ctx, store, 'turn-d-nosub', home)
    try {
      await settle()

      // Neither mounted a turn subscription — a directory and the files home
      // have no file to re-read, so they never hear a turn.
      expect(subscribeTurns).not.toHaveBeenCalled()
      expect(turnSubs.size).toBe(0)

      // …and a turn frame delivered to the session (from any other tab of
      // it, in production) refreshes nothing here.
      emitTurn('turn-d-nosub')
      await settle()
      expect(fsRead).not.toHaveBeenCalled()
    } finally {
      folderView.unmount()
      homeView.unmount()
    }
  })

  it('D: unmount disposes the subscription and a remount subscribes fresh', async () => {
    const { ctx, store, tabOf } = harness('turn-d-cycle')
    const tab = tabOf('/tmp/a.ts')
    const view = mount(ctx, store, 'turn-d-cycle', tab)
    try {
      await settle()
      expect(subscribed('turn-d-cycle')).toBe(true)

      view.unmount()
      expect(subscribed('turn-d-cycle')).toBe(false)

      const again = mount(ctx, store, 'turn-d-cycle', tab)
      await settle()
      expect(subscribed('turn-d-cycle')).toBe(true)

      emitTurn('turn-d-cycle')
      await settle()
      expect(reads()).toBe(2)
      again.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
