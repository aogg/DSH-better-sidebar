/**
 * The 会话切走延时释放 controller: after the active session changes, wait N
 * seconds and suspend the OLD session's push subscriptions (feed channels
 * session / git / fs-jobs / agent-opens — sidechat never suspends); switching
 * back within the window cancels the timer and touches nothing; switching
 * back AFTER the release re-announces the subscriptions (the host's
 * subscribe-time seed snapshots restore the session/git data) and fires the
 * consumers' re-pull.
 *
 * The hub (feed-hub.ts) owns the per-session registry — this controller only
 * watches the store's active session and drives
 * {@linkcode feedReleaseSession} / {@linkcode feedRestoreSession}.
 *
 * The delay comes from {@linkcode feedReleaseDelaySec}: the project override
 * needs the OLD session's workspace root, so arming resolves it with one
 * `session.cwd` read (a one-shot fetch on a session switch, not a poll; the
 * settings page does the same per switch). A failed read arms with the
 * global value. A stale resolution — the user switched again before the
 * answer landed — is discarded, so a burst of switches never arms a timer
 * for a session that is already back on screen.
 * @module dsh-better-sidebar/feed-release
 */
import { api } from './api.ts'
import { feedReleaseSession, feedRestoreSession } from './feed-hub.ts'
import { feedReleaseDelaySec } from './feed-release-settings.ts'
import type { SidebarStore } from './state.ts'

/**
 * Attach the release controller to the sidebar store (one per activation).
 * @param store - the plugin store (its sessionId snapshot is the active
 *   session; its prefs carry the delay setting).
 * @returns the disposer (detaches the listener and cancels any armed timer).
 */
export function attachFeedRelease(store: SidebarStore): () => void {
  let current: string | undefined = store.getSnapshot().sessionId
  let timer: number | undefined
  /** The session the armed timer will release (its cancel token). */
  let armedFor: string | undefined
  /** Bumped on every switch: a stale cwd answer may not arm a timer. */
  let epoch = 0

  const cancel = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    armedFor = undefined
  }

  /** Arm the release timer for the session that just lost its seat. */
  const arm = (previous: string, atEpoch: number): void => {
    // The cwd read (project override) may outlive the switch: by the time it
    // lands the user may have switched back — the epoch check discards that.
    if (atEpoch !== epoch) return
    void api.sessionCwd({ sessionId: previous })
      .then((result) => {
        if (atEpoch !== epoch) return
        const delaySec = feedReleaseDelaySec(store.getPrefs(), result.cwd)
        if (delaySec <= 0) return
        armedFor = previous
        timer = window.setTimeout(() => {
          timer = undefined
          armedFor = undefined
          feedReleaseSession(previous)
        }, delaySec * 1000)
      })
      .catch(() => {
        // The workspace root is unknown: the global delay stands alone.
        if (atEpoch !== epoch) return
        const delaySec = feedReleaseDelaySec(store.getPrefs(), undefined)
        if (delaySec <= 0) return
        armedFor = previous
        timer = window.setTimeout(() => {
          timer = undefined
          armedFor = undefined
          feedReleaseSession(previous)
        }, delaySec * 1000)
      })
  }

  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot().sessionId
    if (next === current) return
    const previous = current
    current = next
    epoch += 1
    cancel()
    if (previous !== undefined && previous !== next) arm(previous, epoch)
    // The switch-back half: a released session re-subscribes here (the
    // host's seed snapshots restore its data). Nothing suspended is a
    // no-op, so this is cheap on every plain switch.
    if (next !== undefined) feedRestoreSession(next)
  })

  return () => {
    unsubscribe()
    cancel()
  }
}
