/**
 * The 会话切走延时释放 controller: after the active session changes, wait N
 * seconds and suspend the OLD session's push subscriptions (feed channels
 * session / git / fs-jobs / agent-opens — sidechat never suspends); switching
 * back within the window cancels the timer and touches nothing; switching
 * back AFTER the release re-announces the subscriptions (the host's
 * subscribe-time seed snapshots restore the session/git data) and fires the
 * consumers' re-pull.
 *
 * 工作区切换立即释放 is the override: when the switch crosses a WORKSPACE
 * boundary (the old and the new session resolve to different roots, each via
 * one `session.cwd` read — a local path or an `ssh://` root compares as the
 * plain string it is), the 30s window is skipped entirely and the old
 * workspace releases at once (see workspace-release.ts): the hub's
 * {@linkcode feedReleaseWorkspace} suspends the old session's subscriptions
 * on EVERY channel — sidechat included — the keepMounted bodies of that
 * workspace stub down to the「恢复中」placeholder, and the workspace-scoped
 * memory caches go. The tab list metadata (localStorage) is untouched, so
 * switching back re-opens the same pages. Either root resolving to nothing
 * (a failed read, an unknown session) conservatively keeps the delay flow —
 * the workspace rule never fires on incomplete evidence.
 *
 * The two decisions share ONE cwd resolution per switch (the old session's
 * root feeds both the workspace comparison and the project-scoped delay
 * override), and both resolutions are epoch-guarded: a stale answer — the
 * user switched again before they landed — is discarded, so a burst of
 * switches never releases or arms a timer for a session that is already back
 * on screen. Resolved roots are cached per session, so the common switch
 * needs at most one fresh read.
 *
 * The delay comes from {@linkcode feedReleaseDelaySec}: the project override
 * needs the OLD session's workspace root (the same read above). A failed read
 * arms with the global value. @module dsh-better-sidebar/feed-release
 */
import { api } from './api.ts'
import { feedReleaseSession, feedRestoreSession } from './feed-hub.ts'
import { feedReleaseDelaySec } from './feed-release-settings.ts'
import { attachWorkspaceRelease, noteSessionActivated, releaseWorkspaceNow } from './workspace-release.ts'
import type { SidebarStore } from './state.ts'

/**
 * Normalize a root for comparison: trailing slashes fold (a `/w/` listing and
 * a `/w` cwd are the same workspace; the POSIX root `/` is left alone).
 */
function normalizeRoot(root: string): string {
  if (root === '/' || root === '') return root
  return root.replace(/\/+$/, '')
}

/** How many session roots the cache keeps (FIFO; sessions churn, roots repeat). */
const ROOT_CACHE_MAX = 64

/**
 * Attach the release controller to the sidebar store (one per activation).
 * @param store - the plugin store (its sessionId snapshot is the active
 *   session; its prefs carry the delay setting).
 * @returns the disposer (detaches the listener, cancels any armed timer and
 *   un-wires the workspace presence wiring).
 */
export function attachFeedRelease(store: SidebarStore): () => void {
  let current: string | undefined = store.getSnapshot().sessionId
  let timer: number | undefined
  /** Bumped on every switch: a stale cwd answer may not arm a timer. */
  let epoch = 0
  /** Session roots resolved on earlier switches (the workspace comparison's memory). */
  const rootCache = new Map<string, string>()
  /** The workspace presence wiring (the 恢复中 marks) lives and dies with this controller. */
  const disposeWorkspace = attachWorkspaceRelease()

  const cancel = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
  }

  /** Arm the release timer for the session that just lost its seat. Its cwd
   * is already known here (the shared resolution below); `undefined` — the
   * read failed — arms with the global delay alone, as before. */
  const arm = (previous: string, atEpoch: number, root: string | undefined): void => {
    if (atEpoch !== epoch) return
    const delaySec = feedReleaseDelaySec(store.getPrefs(), root)
    if (delaySec <= 0) return
    timer = window.setTimeout(() => {
      timer = undefined
      feedReleaseSession(previous)
    }, delaySec * 1000)
  }

  /** Resolve the OLD and the NEW session's roots in ONE parallel round (the
   * cache skips repeats), guarding both answers with the switch's epoch so a
   * late landing is discarded. */
  const resolveRoots = async (previous: string, next: string | undefined, atEpoch: number): Promise<{ prev: string | undefined; next: string | undefined }> => {
    const readRoot = async (sessionId: string): Promise<string | undefined> => {
      const cached = rootCache.get(sessionId)
      if (cached !== undefined) return cached
      try {
        const result = await api.sessionCwd({ sessionId })
        if (atEpoch !== epoch) return undefined
        if (typeof result.cwd === 'string' && result.cwd !== '') {
          rootCache.set(sessionId, result.cwd)
          if (rootCache.size > ROOT_CACHE_MAX) {
            const stale = rootCache.keys().next().value
            if (stale !== undefined) rootCache.delete(stale)
          }
          return result.cwd
        }
        return undefined
      } catch {
        // Unknown root: the workspace rule stays silent, the delay flow
        // falls back to the global value — never an HTTP retry loop.
        return undefined
      }
    }
    const [prev, nextRoot] = await Promise.all([
      readRoot(previous),
      next === undefined ? Promise.resolve(undefined) : readRoot(next),
    ])
    return { prev: atEpoch === epoch ? prev : undefined, next: atEpoch === epoch ? nextRoot : undefined }
  }

  /** The switch decision: a real workspace boundary releases at once; a
   * same-workspace switch (or an unresolved root) arms the delay timer. */
  const decide = (previous: string, next: string | undefined, atEpoch: number): void => {
    void resolveRoots(previous, next, atEpoch).then(({ prev, next: nextRoot }) => {
      if (atEpoch !== epoch) return
      if (next !== undefined && nextRoot !== undefined) noteSessionActivated(next, nextRoot)
      if (prev !== undefined && nextRoot !== undefined && normalizeRoot(prev) !== normalizeRoot(nextRoot)) {
        cancel()
        releaseWorkspaceNow(previous, prev)
        return
      }
      arm(previous, atEpoch, prev)
    })
  }

  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot().sessionId
    if (next === current) return
    const previous = current
    current = next
    epoch += 1
    cancel()
    if (previous !== undefined && previous !== next) decide(previous, next, epoch)
    // The switch-back half: a released session re-subscribes here (the
    // host's seed snapshots restore its data). Nothing suspended is a
    // no-op, so this is cheap on every plain switch. The presence mark
    // turns「已释放」into「恢复中」until the first frame confirms data.
    if (next !== undefined) {
      feedRestoreSession(next)
      noteSessionActivated(next, rootCache.get(next))
    }
  })

  return () => {
    disposeWorkspace()
    unsubscribe()
    cancel()
  }
}
