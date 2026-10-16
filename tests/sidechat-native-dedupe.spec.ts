// @vitest-environment jsdom
/**
 * The native right-Sidebar sidechat open path with the host `multiple`
 * contract (v0.28.3): the type registers as `multiple`, so the host no longer
 * keeps one page per kind — every `service.openTab({ type: 'sidechat' })`
 * would mint a new native page. "Reopen an already-open thread → focus it"
 * therefore moved into the plugin: the service derives the descriptor's
 * `dedupeKey` from the MINTED tab (after `createTab` consumed the parked
 * thread id — mint first, judge second) and hands a matcher to the surface,
 * which scans its own records (a space the service cannot see) and focuses a
 * hit through `activate` instead of calling the controller's `openTab`.
 *
 * The harness is the REAL chain — service → createNativeSurface → controller
 * mock — with the records seeded the way a rendered native body would have
 * seeded them (`records.ensure`), and the REAL parked-reopen seed from
 * SideChatView (module-level state: a leaked park would survive opens here).
 */
import { describe, expect, it, vi } from 'vitest'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { consumeSidechatSeed, parkSidechatReopen, sidechatThreadIdOf } from '../src/client/SideChatView.tsx'

const scope = { sessionId: 's1', cwd: '/work' }

/** The store + service + REAL native surface (controller mocked) under test. */
function setup() {
  const mounted = { current: 's1' }
  const controller = {
    openTab: vi.fn(),
    openResource: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    mounted: { getSnapshot: () => mounted.current, subscribe: () => () => {} },
  }
  const ctx = {
    get: (name: string) => (name === 'sidebarRight' ? controller : undefined),
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({}) } },
  }
  const records = createNativeTabRecords()
  const surface = createNativeSurface(ctx as never, records)
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  const onOpen = vi.fn()
  // The sidechat shape (createTab + thread dedupe), minting through the REAL
  // parked-reopen seed exactly like the built-in descriptor does.
  service.registerTab({
    id: 'sidechat',
    title: 'Side Chat',
    createTab: () => {
      const threadId = consumeSidechatSeed()
      return threadId !== undefined
        ? { tab: { id: `sidechat:${threadId}`, type: 'sidechat', title: 'Side Chat', meta: { threadId } } }
        : { tab: { id: `sidechat:new-${crypto.randomUUID()}`, type: 'sidechat', title: 'New chat', meta: { autoCreate: true } } }
    },
    dedupeKey: (tab) => sidechatThreadIdOf(tab),
    onOpen,
    component: () => null,
  })
  service.setSurface(surface)
  return { mounted, controller, records, surface, store, service, onOpen }
}

/** The options the controller's last openTab call received, or undefined. */
function lastOpenOptions(controller: { openTab: ReturnType<typeof vi.fn> }): Record<string, unknown> | undefined {
  const calls = controller.openTab.mock.calls as Array<[string, Record<string, unknown>]>
  return calls[calls.length - 1]?.[1]
}

describe('service.openTab native path: sidechat reopen dedupe (multiple kinds)', () => {
  it('focuses the already-open thread through activate and never calls openTab', () => {
    const { controller, records, service, onOpen } = setup()
    // The thread's tab is open on the native surface (its body minted the
    // plugin-side record when it rendered).
    records.ensure({ sessionId: 's1', id: 'tab-1', kind: 'sidechat', title: 'Side Chat', params: { meta: { threadId: 't-1' } }, scope })
    parkSidechatReopen('t-1')
    service.openTab({ type: 'sidechat' })

    expect(controller.focus).toHaveBeenCalledTimes(1)
    expect(controller.focus).toHaveBeenCalledWith('tab-1')
    expect(controller.openTab).not.toHaveBeenCalled()
    // Mint-first: the parked id was consumed by THIS open, not left parked.
    expect(consumeSidechatSeed()).toBeUndefined()
    // Lifecycle: the native lane reports ONE onOpen per open — a dedupe focus
    // reports the minted tab, it does not switch to onActivate.
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sidechat:t-1', type: 'sidechat', meta: { threadId: 't-1' } }),
      expect.objectContaining({ sessionId: 's1' }),
    )
  })

  it('opens a fresh unbound thread without a dedupe key (no leak of a focused thread)', () => {
    const { controller, records, service } = setup()
    records.ensure({ sessionId: 's1', id: 'tab-1', kind: 'sidechat', title: 'Side Chat', params: { meta: { threadId: 't-1' } }, scope })
    // Reopen t-1 once (the focus above proves nothing about the NEXT open).
    parkSidechatReopen('t-1')
    service.openTab({ type: 'sidechat' })
    expect(controller.focus).toHaveBeenCalledTimes(1)

    // The next open is a plain + click: it must MINT (the seed was spent on
    // the focused open) and carry no dedupe key — unbound tabs never dedupe.
    service.openTab({ type: 'sidechat' })
    expect(controller.openTab).toHaveBeenCalledTimes(1)
    const options = lastOpenOptions(controller)
    expect(options).toMatchObject({
      revealIfOpened: false,
      params: expect.objectContaining({ meta: { autoCreate: true } }),
    })
    expect(options?.dedupeKey).toBeUndefined()
    expect(controller.focus).toHaveBeenCalledTimes(1)
  })

  it('opens a parked thread that is not open yet, handing the dedupe matcher to the surface', () => {
    const { controller, records, service } = setup()
    parkSidechatReopen('t-2')
    // The matcher is a plugin-internal service → surface contract: the host
    // controller face has no dedupe field (the host's per-kind fallback is
    // gone for `multiple` kinds), the surface consumes the matcher against its
    // OWN records at place time — and again on a queued replay. A direct
    // on-screen open is placed synchronously and its entry is spent, so the
    // dedupe scan is the only observation point that the matcher rode along.
    const findBy = vi.spyOn(records, 'findBy')
    service.openTab({ type: 'sidechat' })

    // Minted — the thread was not open yet: the multi-open face, not a focus.
    expect(controller.openTab).toHaveBeenCalledTimes(1)
    const options = lastOpenOptions(controller)
    expect(options).toMatchObject({
      revealIfOpened: false,
      params: expect.objectContaining({ meta: { threadId: 't-2' } }),
    })
    expect(controller.focus).not.toHaveBeenCalled()
    // The scan ran for the open's seat, and the predicate it carried is the
    // thread matcher behind the kind filter: the same thread hits; a sibling
    // thread, an unbound tab and another kind's tab do not.
    expect(findBy).toHaveBeenCalledTimes(1)
    const [seat, matcher] = findBy.mock.calls[0]!
    expect(seat).toBe('s1')
    expect(matcher({ id: 'x', type: 'sidechat', title: 'Side Chat', meta: { threadId: 't-2' } })).toBe(true)
    expect(matcher({ id: 'y', type: 'sidechat', title: 'Side Chat', meta: { threadId: 't-9' } })).toBe(false)
    expect(matcher({ id: 'z', type: 'sidechat', title: 'New chat', meta: { autoCreate: true } })).toBe(false)
    expect(matcher({ id: 'w', type: 'files', title: 'Files', meta: { threadId: 't-2' } })).toBe(false)
  })

  it('re-runs the dedupe on a queued replay: a record minted meanwhile wins', () => {
    const { controller, mounted, records, surface, service } = setup()
    // The open targets s1 while another session is on screen: the entry is
    // queued (the host cannot place it yet).
    mounted.current = 's2'
    parkSidechatReopen('t-3')
    service.openTab({ type: 'sidechat' })
    expect(controller.openTab).not.toHaveBeenCalled()
    expect(controller.focus).not.toHaveBeenCalled()

    // Before the replay, the thread's tab shows up in s1's records.
    records.ensure({ sessionId: 's1', id: 'tab-3', kind: 'sidechat', title: 'Side Chat', params: { meta: { threadId: 't-3' } }, scope })
    surface.flushPending()

    expect(controller.focus).toHaveBeenCalledTimes(1)
    expect(controller.focus).toHaveBeenCalledWith('tab-3')
    expect(controller.openTab).not.toHaveBeenCalled()
    // The queue is drained: a second flush must not focus again.
    surface.flushPending()
    expect(controller.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves single-page kinds on the host dedupe (no matcher, params re-delivered)', () => {
    const { controller, records, service } = setup()
    service.registerTab({ id: 'subagent', title: 'Tasks', single: true, component: () => null })
    // No matcher handed over: the surface must not scan its records for a
    // single-page kind — the HOST's one-page-per-kind open re-delivers the
    // params to the focused page (the subagent jump rides that).
    const findBy = vi.spyOn(records, 'findBy')
    service.openTab({ type: 'subagent', meta: { childSessionId: 'c-1' } })

    expect(controller.openTab).toHaveBeenCalledTimes(1)
    const options = lastOpenOptions(controller)
    // No matcher on either seam — not into the surface (no scan ran) and not
    // onto the host call, whose face has no dedupe field at all.
    expect(options?.dedupeKey).toBeUndefined()
    expect(findBy).not.toHaveBeenCalled()
    expect(options).toMatchObject({ revealIfOpened: true, params: { meta: { childSessionId: 'c-1' } } })
  })
})
