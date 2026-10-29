/**
 * 工作区切换释放 + 恢复中 (src/client/workspace-release.ts, with the feed
 * hub's `feedReleaseWorkspace` half). The rules under test:
 *  - the hub's workspace release suspends the session's subscriptions on
 *    EVERY channel — sidechat included (the 会话切走 exemption is a
 *    session-switch rule) — plus the cross-workspace sidechat keys, whose
 *    set the NEXT restore pulse restores;
 *  - a re-entrant join of a suspended cross key restores it at once and
 *    removes it from the set (no double restore later);
 *  - the presence marks: a socket drop marks the sessions that had live
 *    entries `reconnecting`; the session's first frame clears it; the
 *    socket's re-open (the replay = subscription confirmation) clears the
 *    rest;
 *  - `releaseWorkspaceNow` marks the session AND its whole root released
 *    (a body keyed by the same root stubs too), evicts the workspace memory
 *    caches, and re-activation converts the mark to `reloading` until a
 *    frame (or the next open) confirms data again;
 *  - the tab body renders the「恢复中」stub instead of the real page while
 *    released, the restoring bar while reloading — and the real page again
 *    once the mark clears. The chip swaps its glyph for the ring likewise.
 *
 * The hub state lives at MODULE level: every test closes every subscription
 * it opened (`track` + afterEach) and resets the marks.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** The workspace cache seams, spied: the release must call all three. */
const fsLevelsRelease = vi.fn()
const opsStreamReleaseSession = vi.fn()
const forgetSessionBlame = vi.fn()

vi.mock('../src/client/fs-levels-store.ts', () => ({
  fsLevelsRelease: (...args: unknown[]) => fsLevelsRelease(...(args as [])),
}))
vi.mock('../src/client/ops-stream.ts', () => ({
  opsStreamReleaseSession: (...args: unknown[]) => opsStreamReleaseSession(...(args as [])),
}))
vi.mock('../src/client/editor-git-gutter.ts', () => ({
  forgetSessionBlame: (...args: unknown[]) => forgetSessionBlame(...(args as [])),
}))

import {
  feedEntryCountForTests,
  feedHubResetForTests,
  feedReleaseWorkspace,
  feedRestoreSession,
  feedSubscribe,
  type FeedSubscription,
} from '../src/client/feed-hub.ts'
import {
  attachWorkspaceRelease,
  noteSessionActivated,
  releaseWorkspaceNow,
  workspaceReleaseResetForTests,
  workspaceReleaseStateOf,
} from '../src/client/workspace-release.ts'
import {
  NativeTabBody,
  NativeTabTitle,
  createNativeTabRecords,
  type NativeTabInfo,
} from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'

/** The smallest WebSocket the hub talks to: `send` records the frames. */
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
  frame(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }) }
  drop(): void { this.readyState = 3; this.onclose?.() }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>)
  }
}

/** Every subscription a test opened, undone after the test whatever happens. */
const disposers: FeedSubscription[] = []
function track(subscription: FeedSubscription): FeedSubscription {
  disposers.push(subscription)
  return subscription
}

function socketAt(index: number): FakeSocket {
  const socket = FakeSocket.instances[index]
  if (socket === undefined) throw new Error(`no socket at ${index}`)
  return socket
}

beforeEach(() => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.useFakeTimers()
  feedHubResetForTests()
  workspaceReleaseResetForTests()
  fsLevelsRelease.mockClear()
  opsStreamReleaseSession.mockClear()
  forgetSessionBlame.mockClear()
})

afterEach(() => {
  for (const disposer of disposers.splice(0)) disposer.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('feedReleaseWorkspace (the hub half)', () => {
  it('suspends EVERY channel of the session — sidechat keys included — and the restore pulse re-enables them', () => {
    const sessionData = vi.fn()
    const sidechatData = vi.fn()
    const onReconnect = vi.fn()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: sessionData }))
    track(feedSubscribe({ channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] }, onData: () => {} }))
    // The cross-workspace sidechat key (no session dimension — the thread
    // and global-threads subscriptions look like this).
    track(feedSubscribe({ channel: 'sidechat', args: { threadId: 't1' }, onData: sidechatData, onReconnect }))
    socketAt(0).open()
    feedReleaseWorkspace('s1')
    const frames = socketAt(0).frames()
    const unsubs = frames.filter(frame => frame.op === 'unsub')
    expect(unsubs).toEqual([
      { op: 'unsub', channel: 'session', sessionId: 's1' },
      { op: 'unsub', channel: 'git', sessionId: 's1', args: { worktrees: ['/r'] } },
      { op: 'unsub', channel: 'sidechat', args: { threadId: 't1' } },
    ])
    // Released entries hear no frames at all.
    socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'turn', sessionId: 's1' } })
    socketAt(0).frame({ channel: 'sidechat', data: { threadId: 't1' } })
    expect(sessionData).not.toHaveBeenCalled()
    expect(sidechatData).not.toHaveBeenCalled()
    // The registry keeps everything (restore has something to restore).
    expect(feedEntryCountForTests()).toBe(3)
    // The NEXT restore pulse (any session becoming active again) restores
    // the whole cross set — s1's own session-scoped keys wait for s1's own
    // activation — and fires the cross key's catch-up.
    feedRestoreSession('s9')
    const subs = socketAt(0).frames().filter(frame => frame.op === 'sub')
    expect(subs).toHaveLength(4) // the three initial subs + the restored cross key
    expect(subs.at(-1)).toEqual({ op: 'sub', channel: 'sidechat', args: { threadId: 't1' } })
    expect(onReconnect).toHaveBeenCalledTimes(1)
    // The sidechat key hears frames again; s1's own keys stay suspended.
    socketAt(0).frame({ channel: 'sidechat', data: { threadId: 't1' } })
    expect(sidechatData).toHaveBeenCalledTimes(1)
    socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'turn', sessionId: 's1' } })
    expect(sessionData).not.toHaveBeenCalled()
  })

  it('a re-entrant join of a suspended cross key restores it and removes it from the set', () => {
    track(feedSubscribe({ channel: 'sidechat', args: { threads: true }, onData: () => {} }))
    socketAt(0).open()
    feedReleaseWorkspace('s1')
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'unsub', channel: 'sidechat', args: { threads: true } })
    // The view remounts inside the release window: its join IS its restore.
    track(feedSubscribe({ channel: 'sidechat', args: { threads: true }, onData: () => {} }))
    expect(socketAt(0).frames().at(-1)).toEqual({ op: 'sub', channel: 'sidechat', args: { threads: true } })
    // The next restore pulse must NOT re-announce it (it left the set).
    const before = socketAt(0).sent.length
    feedRestoreSession('s9')
    expect(socketAt(0).sent.length).toBe(before)
  })
})

describe('the presence marks (workspace-release)', () => {
  it('a socket drop marks the sessions with live entries reconnecting; a frame clears one, the re-open clears the rest', async () => {
    const disposeWiring = attachWorkspaceRelease()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    track(feedSubscribe({ channel: 'git', sessionId: 's2', args: { worktrees: ['/r'] }, onData: () => {} }))
    socketAt(0).open()
    expect(workspaceReleaseStateOf('s1', undefined)).toBe('live')
    socketAt(0).drop()
    expect(workspaceReleaseStateOf('s1', undefined)).toBe('reconnecting')
    expect(workspaceReleaseStateOf('s2', undefined)).toBe('reconnecting')
    // A session without live entries is not marked (nothing of its is broken
    // by the drop — it has no subscription to lose frames from).
    expect(workspaceReleaseStateOf('s3', undefined)).toBe('live')
    // The session's first data frame is proof its data flows again.
    await vi.advanceTimersByTimeAsync(20_000)
    socketAt(1).open()
    // …but the RE-OPEN is itself the confirmation: the replay re-seeds, so
    // every transient mark clears with it.
    expect(workspaceReleaseStateOf('s1', undefined)).toBe('live')
    expect(workspaceReleaseStateOf('s2', undefined)).toBe('live')
    disposeWiring()
  })

  it('releaseWorkspaceNow marks the session and its whole root; re-activation converts to reloading until a frame', () => {
    releaseWorkspaceNow('s1', '/w1')
    expect(workspaceReleaseStateOf('s1', '/w1')).toBe('released')
    // A body whose live cwd sits in the released workspace stubs too (a
    // cross-workspace file tab, another session of that workspace).
    expect(workspaceReleaseStateOf('s9', '/w1')).toBe('released')
    expect(workspaceReleaseStateOf('s9', '/w2')).toBe('live')
    // The release also reached the hub (every channel of s1 — none live
    // here, so a no-op) and evicted the workspace memory caches.
    expect(fsLevelsRelease).toHaveBeenCalledWith('/w1')
    expect(opsStreamReleaseSession).toHaveBeenCalledWith('s1')
    expect(forgetSessionBlame).toHaveBeenCalledWith('s1')
    // Switching back: released → reloading (the bar shows until data lands).
    noteSessionActivated('s1', '/w1')
    expect(workspaceReleaseStateOf('s1', '/w1')).toBe('reloading')
    // The root mark cleared with the activation: the workspace is back.
    expect(workspaceReleaseStateOf('s9', '/w1')).toBe('live')
    // Without a frame (or a re-open) the mark stays: the bar is honest about
    // the seed still being on its way.
    expect(workspaceReleaseStateOf('s1', '/w1')).toBe('reloading')
  })

  it('a data frame for a session clears its reloading mark', () => {
    const disposeWiring = attachWorkspaceRelease()
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    socketAt(0).open()
    noteSessionActivated('s1', undefined)
    expect(workspaceReleaseStateOf('s1', undefined)).toBe('reloading')
    // The frame arrives through the hub (routeData emits the event) — proof
    // the session's data flows again.
    socketAt(0).frame({ channel: 'session', sessionId: 's1', data: { kind: 'phase', sessionId: 's1' } })
    expect(workspaceReleaseStateOf('s1', undefined)).toBe('live')
    disposeWiring()
  })
})

/** One native tab record, as the host hands it to a body/title registration. */
function nativeInfo(kind: string): NativeTabInfo {
  return {
    tab: {
      id: 't1',
      kind,
      title: 'Page',
      contentId: 'sidebar://page',
      visible: true,
      navigation: { address: 'sidebar://page', params: undefined, revision: 0 },
      signal: new AbortController().signal,
    },
  }
}

function createService(store: SidebarStore): BetterSidebarService {
  const service = createBetterSidebarService(store)
  service.registerTab({
    id: 'tester',
    title: () => 'Page',
    icon: (size: number) => createElement('i', { 'data-type-icon': size }),
    component: () => createElement('div', { 'data-testid': 'real-page' }),
  })
  return service
}

const mounted: Array<{ host: HTMLDivElement; root: Root }> = []

/** Render one body and hand back its host (info re-read per draw). */
function renderBody(options: {
  store: SidebarStore
  service: BetterSidebarService
}): { host: HTMLDivElement; redraw: () => void } {
  const { store, service } = options
  const records = createNativeTabRecords()
  records.attachStore(store)
  const info = nativeInfo('tester')
  const ctx = {
    sessions: { list: { subscribe: () => (): void => {}, getSnapshot: () => ({ byId: {} }) } },
  } as never
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const draw = (): void => {
    act(() => {
      root.render(createElement(NativeTabBody, {
        ctx,
        store,
        service,
        records,
        descriptorId: 'tester',
        sessionId: 's1',
        useTabInfo: () => info,
      }))
    })
  }
  draw()
  mounted.push({ host, root })
  return { host, redraw: draw }
}

/** Render one chip and hand back its host. */
function renderChip(options: {
  store: SidebarStore
  service: BetterSidebarService
}): { host: HTMLDivElement; redraw: () => void } {
  const { store, service } = options
  const records = createNativeTabRecords()
  records.attachStore(store)
  const info = nativeInfo('tester')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const draw = (): void => {
    act(() => {
      root.render(createElement(NativeTabTitle, {
        records,
        service,
        descriptorId: 'tester',
        sessionId: 's1',
        useTabInfo: () => info,
      } as never))
    })
  }
  draw()
  mounted.push({ host, root })
  return { host, redraw: draw }
}

function makeStore(): SidebarStore {
  const store = createSidebarStore()
  store.setSession('s1')
  return store
}

describe('the tab surfaces (stub, bar, chip ring)', () => {
  it('a released body renders the restoring stub instead of the real page; activation brings the page back with the bar', () => {
    const disposeWiring = attachWorkspaceRelease()
    const store = makeStore()
    const service = createService(store)
    const { host, redraw } = renderBody({ store, service })
    expect(host.querySelector('[data-testid="real-page"]')).not.toBeNull()
    releaseWorkspaceNow('s1', undefined)
    redraw()
    // The real component is GONE (that is the release); the stub shows the
    // reloading copy.
    expect(host.querySelector('[data-testid="real-page"]')).toBeNull()
    expect(host.textContent).toContain(t('restoreReloading'))
    // Switching back: the page remounts (fresh, re-subscribed) and the bar
    // overlays it while the seed is on its way.
    noteSessionActivated('s1', undefined)
    redraw()
    expect(host.querySelector('[data-testid="real-page"]')).not.toBeNull()
    expect(host.textContent).toContain(t('restoreReloading'))
    // The socket's re-open replay confirms the subscription → bar gone.
    socketAt(0).open()
    redraw()
    expect(host.querySelector('[data-testid="real-page"]')).not.toBeNull()
    expect(host.textContent).not.toContain(t('restoreReloading'))
    disposeWiring()
  })

  it('the chip swaps its glyph for the restoring ring while the session is marked', () => {
    const disposeWiring = attachWorkspaceRelease()
    const store = makeStore()
    const service = createService(store)
    const { host, redraw } = renderChip({ store, service })
    expect(host.querySelector(`[aria-label="${t('restoreBadge')}"]`)).toBeNull()
    releaseWorkspaceNow('s1', undefined)
    redraw()
    expect(host.querySelector(`[aria-label="${t('restoreBadge')}"]`)).not.toBeNull()
    // The confirmation (a socket open whose replay re-seeds) clears the
    // transient mark — the chip is back to its glyph.
    track(feedSubscribe({ channel: 'session', sessionId: 's1', onData: () => {} }))
    noteSessionActivated('s1', undefined)
    socketAt(0).open()
    redraw()
    expect(host.querySelector(`[aria-label="${t('restoreBadge')}"]`)).toBeNull()
    disposeWiring()
  })
})

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!
    act(() => { entry.root.unmount() })
    entry.host.remove()
  }
})
