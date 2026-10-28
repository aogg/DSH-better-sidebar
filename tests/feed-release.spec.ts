/**
 * The 会话切走延时释放 controller (src/client/feed-release.ts). The rules
 * under test (fake timers):
 *  - a session switch arms the timer with the configured delay (default
 *    30s); when it elapses, the OLD session's subscriptions release;
 *  - switching back INSIDE the window cancels the timer and releases
 *    nothing;
 *  - switching back AFTER the release restores the session (re-subscribe +
 *    re-pull);
 *  - `0` disables the release entirely (a configured 0 or the global 0);
 *  - the delay is read per switch, so a settings change re-arms with the
 *    new value;
 *  - a stale `session.cwd` answer (the user switched again while the read
 *    was in flight) must not arm a timer for the session that came back.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The hub calls the controller drives (spied: the release/restore side). */
const feedReleaseSession = vi.fn()
const feedRestoreSession = vi.fn()

vi.mock('../src/client/feed-hub.ts', () => ({
  feedReleaseSession: (...args: unknown[]) => feedReleaseSession(...(args as [])),
  feedRestoreSession: (...args: unknown[]) => feedRestoreSession(...(args as [])),
}))

/** The cwd answers: per-session, overridable per test. */
const cwdAnswers = new Map<string, string>()
let cwdFailure = false

vi.mock('../src/client/api.ts', () => ({
  api: {
    sessionCwd: async (scope: { sessionId: string }): Promise<{ cwd: string }> => {
      if (cwdFailure) throw new Error('cwd read failed')
      const cwd = cwdAnswers.get(scope.sessionId)
      if (cwd === undefined) throw new Error('no cwd answer for ' + scope.sessionId)
      return { cwd }
    },
  },
}))

import { attachFeedRelease } from '../src/client/feed-release.ts'
import { FEEDS_SETTINGS_BLOB_ID, RELEASE_DELAY_KEY } from '../src/client/feed-release-settings.ts'
import { PROJECT_SETTINGS_KEY } from '../src/prefs-shared.ts'
import { createSidebarStore } from '../src/client/state.ts'

/** Write the global delay blob into the store's prefs. */
function setGlobalDelay(store: ReturnType<typeof createSidebarStore>, delaySec: number): void {
  const prefs = store.getPrefs()
  store.setPrefs({
    ...prefs,
    pluginSettings: {
      ...prefs.pluginSettings,
      [FEEDS_SETTINGS_BLOB_ID]: { ...(prefs.pluginSettings[FEEDS_SETTINGS_BLOB_ID] ?? {}), [RELEASE_DELAY_KEY]: delaySec },
    },
  })
}

/** Write one project's override blob into the store's prefs. */
function setProjectDelay(store: ReturnType<typeof createSidebarStore>, cwd: string, delaySec: number): void {
  const prefs = store.getPrefs()
  const map = prefs.pluginSettings[PROJECT_SETTINGS_KEY] ?? {}
  store.setPrefs({
    ...prefs,
    pluginSettings: {
      ...prefs.pluginSettings,
      [PROJECT_SETTINGS_KEY]: { ...map, [cwd]: { ...(map[cwd] ?? {}), [RELEASE_DELAY_KEY]: delaySec } },
    },
  })
}

beforeEach(() => {
  feedReleaseSession.mockClear()
  feedRestoreSession.mockClear()
  cwdAnswers.clear()
  cwdFailure = false
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attachFeedRelease (the delay timer)', () => {
  it('releases the old session when the default 30s window elapses', async () => {
    const store = createSidebarStore()
    cwdAnswers.set('a', '/w')
    const dispose = attachFeedRelease(store)
    store.setSession('a')
    store.setSession('b')
    // The cwd read (project override) lands before the timer arms.
    await vi.advanceTimersByTimeAsync(0)
    expect(feedReleaseSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(feedReleaseSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(feedReleaseSession).toHaveBeenCalledWith('a')
    // Switching back re-restores (the re-subscribe + re-pull path).
    store.setSession('a')
    expect(feedRestoreSession).toHaveBeenCalledWith('a')
    dispose()
  })

  it('a switch back INSIDE the window cancels the timer and releases nothing', async () => {
    const store = createSidebarStore()
    cwdAnswers.set('a', '/w')
    cwdAnswers.set('b', '/w')
    const dispose = attachFeedRelease(store)
    store.setSession('a')
    store.setSession('b')
    await vi.advanceTimersByTimeAsync(0)
    store.setSession('a')
    await vi.advanceTimersByTimeAsync(60_000)
    // The armed release for 'a' was cancelled. ('b' itself becomes the old
    // session the moment the user bounced back to 'a', so ITS own window —
    // armed by the same rule — legitimately elapses; the cancelled one is
    // 'a', and it never fires.)
    expect(feedReleaseSession).not.toHaveBeenCalledWith('a')
    dispose()
  })

  it('a configured 0 disables the release', async () => {
    const store = createSidebarStore()
    cwdAnswers.set('a', '/w')
    setGlobalDelay(store, 0)
    const dispose = attachFeedRelease(store)
    store.setSession('a')
    store.setSession('b')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(feedReleaseSession).not.toHaveBeenCalled()
    dispose()
  })

  it('the project override wins over the global value', async () => {
    const store = createSidebarStore()
    cwdAnswers.set('a', '/w')
    setGlobalDelay(store, 30)
    setProjectDelay(store, '/w', 5)
    const dispose = attachFeedRelease(store)
    store.setSession('a')
    store.setSession('b')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(feedReleaseSession).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(feedReleaseSession).toHaveBeenCalledWith('a')
    dispose()
  })

  it('a failed cwd read arms with the global delay', async () => {
    const store = createSidebarStore()
    cwdFailure = true
    const dispose = attachFeedRelease(store)
    store.setSession('a')
    store.setSession('b')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(feedReleaseSession).toHaveBeenCalledWith('a')
    dispose()
  })

  it('a stale cwd answer never arms a timer for the session that came back', async () => {
    const store = createSidebarStore()
    cwdAnswers.set('a', '/w')
    // A slow answer: it lands only after the user already switched back.
    let releaseCwd!: () => void
    const original = cwdAnswers.get('a')
    void original
    const gate = new Promise<void>((resolve) => { releaseCwd = resolve })
    const api = await import('../src/client/api.ts')
    const spy = vi.spyOn(api.api, 'sessionCwd').mockImplementationOnce(async () => {
      await gate
      // The full SessionCwd answer shape (the controller reads `cwd` alone,
      // but the route always carries the session/root/parent fields).
      return { sessionId: 'a', cwd: '/w', root: '/w', parent: null }
    })
    const dispose = attachFeedRelease(store)
    store.setSession('a')
    store.setSession('b')
    store.setSession('a')
    releaseCwd()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    // The stale answer for 'a' is discarded: its release never fires. (The
    // bounce b→a legitimately arms 'b' — the plain "old session" rule.)
    expect(feedReleaseSession).not.toHaveBeenCalledWith('a')
    spy.mockRestore()
    dispose()
  })
})
