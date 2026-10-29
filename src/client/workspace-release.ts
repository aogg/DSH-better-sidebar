/**
 * The 工作区切换释放 + 恢复中 presence module.
 *
 * When the active conversation's workspace root changes (session A of /w1 →
 * session B of /w2), everything the OLD workspace's sidebar pages held must
 * go AT ONCE — not after the 会话切走延时释放's 30s window, and without the
 * sidechat exemption:
 *
 * - the feed hub force-releases the old session's subscriptions on every
 *   channel plus the cross-workspace sidechat keys
 *   ({@linkcode feedReleaseWorkspace}, feed-hub.ts);
 * - every keepMounted tab body of the released workspace stops rendering its
 *   real page and renders the「恢复中」stub instead (the native tab bodies
 *   read {@linkcode useWorkspaceReleaseState} in tab-adapter.tsx) — which
 *   unmounts the editor buffers, folder trees, browser pages, history and
 *   changes views, dropping their React trees, their feed handles and their
 *   per-page caches with them. The tab LIST metadata (the native records and
 *   the localStorage-persisted layouts) is deliberately kept, so switching
 *   back re-opens the same pages;
 * - the workspace-scoped memory caches are evicted: the file-tree level
 *   store's in-memory bucket (the persisted copy survives — instant paint on
 *   the way back), the editor file-op stream's data and the hover blame memo.
 *
 * The same presence store drives the「恢复中」state a released page shows
 * while it comes back, and the one every page shows while the feed socket is
 * RECONNECTING (a drop marks the sessions that had live subscriptions; the
 * next open, or the first frame of that session, clears them — so a reader
 * can tell「断了」from「正在恢复」).
 *
 * State per session: `released` (its workspace was switched away from — its
 * bodies are stubs) → on re-activation `reloading` (restoring: the host's
 * seed snapshots ride the re-announce) → `live` on the first data frame.
 * A socket drop marks live sessions `reconnecting` until the next open or
 * frame. The marks are module-level (one presence per page, exactly like the
 * feed hub it shadows); the controller wiring rides
 * {@linkcode attachWorkspaceRelease}, called once per client activation from
 * the feed-release controller.
 * @module dsh-better-sidebar/workspace-release
 */
import { useSyncExternalStore } from 'react'
import { feedReleaseWorkspace, onFeedHubEvent, type FeedHubEvent } from './feed-hub.ts'
import { fsLevelsRelease } from './fs-levels-store.ts'
import { opsStreamReleaseSession } from './ops-stream.ts'
import { forgetSessionBlame } from './editor-git-gutter.ts'

/** The presence state of one session's sidebar pages. */
export type WorkspaceReleaseState =
  /** Its workspace was switched away from: bodies render the restoring stub. */
  | 'released'
  /** Restoring after a release (re-activated; the re-seed is on its way). */
  | 'reloading'
  /** The feed socket is down: frames paused, reconnects backing off. */
  | 'reconnecting'
  /** Nothing to report: data is live. */
  | 'live'

/** The transient (self-clearing) marks, with the wording each one drives. */
type TransientKind = 'reloading' | 'reconnecting'

/** Sessions whose workspace was released (bodies render stubs). */
const releasedSessions = new Set<string>()
/** Workspace roots released as a whole (bodies whose live cwd matches stub too). */
const releasedRoots = new Set<string>()
/** Sessions with a transient mark, and which wording it drives. */
const transient = new Map<string, TransientKind>()

const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of [...listeners]) listener()
}

/** Whether one mark change actually changes anything (notify only then — a
 *  frame for a session without marks is the common case and must not churn). */
function isTracked(sessionId: string): boolean {
  return releasedSessions.has(sessionId) || transient.has(sessionId)
}

/**
 * Evict the workspace-scoped MEMORY caches of a released workspace. The
 * persisted metadata (the fs-levels bucket on disk, the tab layouts in
 * localStorage) deliberately survives — the release frees memory, it does
 * not throw away the user's places.
 */
function evictWorkspaceCaches(sessionId: string, root: string | undefined): void {
  try {
    if (root !== undefined && root !== '') fsLevelsRelease(root)
  } catch (error) {
    console.error('[dsh-better-sidebar] workspace release: fs-levels eviction failed:', error)
  }
  try {
    opsStreamReleaseSession(sessionId)
  } catch (error) {
    console.error('[dsh-better-sidebar] workspace release: ops stream eviction failed:', error)
  }
  try {
    forgetSessionBlame(sessionId)
  } catch (error) {
    console.error('[dsh-better-sidebar] workspace release: blame memo eviction failed:', error)
  }
}

/**
 * Force-release one session's workspace: the hub's wire-level release (every
 * channel — sidechat included), the release marks (its bodies stub), and the
 * workspace-scoped memory caches.
 * @param sessionId - the session that just lost its active seat to another
 *   workspace.
 * @param root - the OLD session's workspace root (bodies keyed by it stub
 *   too); undefined when the root could not be resolved — the release still
 *   applies to the session's own bodies and subscriptions.
 */
export function releaseWorkspaceNow(sessionId: string, root: string | undefined): void {
  feedReleaseWorkspace(sessionId)
  releasedSessions.add(sessionId)
  if (root !== undefined && root !== '') releasedRoots.add(root)
  evictWorkspaceCaches(sessionId, root)
  notify()
}

/**
 * Note that a session became (or stays) active: its released mark converts
 * to a `reloading` transient (its bodies remount real pages and show the
 * restoring bar while the re-seed lands), and a matching released ROOT mark
 * clears (the workspace is back — every body keyed by that root unstubs).
 * Called once at the switch with the (usually still unknown) root and again
 * when the new session's cwd resolution lands.
 * @param sessionId - the session that became active.
 * @param root - the session's workspace root, when known.
 */
export function noteSessionActivated(sessionId: string, root: string | undefined): void {
  let changed = false
  if (releasedSessions.delete(sessionId)) changed = true
  if (root !== undefined && root !== '' && releasedRoots.delete(root)) changed = true
  if (transient.get(sessionId) !== 'reloading') {
    // An active session's data is on its way back; until a frame (or the
    // socket's next open) confirms it, its pages show the restoring bar.
    transient.set(sessionId, 'reloading')
    changed = true
  }
  if (changed) notify()
}

/**
 * Read one session's presence state. `cwd` refines the released check: a
 * body whose SEAT session is fine but whose live cwd sits in a released
 * workspace (a cross-workspace file tab) is released as well.
 * @param sessionId - the session to read (usually the body's seat).
 * @param cwd - the session's live workspace root, when known.
 */
export function workspaceReleaseStateOf(sessionId: string, cwd: string | undefined): WorkspaceReleaseState {
  if (releasedSessions.has(sessionId)) return 'released'
  if (cwd !== undefined && cwd !== '' && releasedRoots.has(cwd)) return 'released'
  return transient.get(sessionId) ?? 'live'
}

/** Subscribe to presence-mark changes (the React seam + tests). */
export function subscribeWorkspaceRelease(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React seam: one body's presence state (re-renders on every mark change). */
export function useWorkspaceReleaseState(sessionId: string, cwd: string | undefined): WorkspaceReleaseState {
  return useSyncExternalStore(
    subscribeWorkspaceRelease,
    () => workspaceReleaseStateOf(sessionId, cwd),
  )
}

/**
 * Wire the presence marks to the feed hub's lifecycle: a socket close marks
 * every session that had live subscriptions `reconnecting` (its frames
 * stopped — the「断了」state), and the next open (the replay IS the
 * subscription confirmation) or the session's first frame clears the
 * transient marks again. Called once per client activation; the returned
 * disposer un-wires it.
 * @returns the disposer.
 */
export function attachWorkspaceRelease(): () => void {
  const onEvent = (event: FeedHubEvent): void => {
    if (event.type === 'closed') {
      let changed = false
      for (const sessionId of event.sessionIds) {
        if (transient.get(sessionId) !== 'reconnecting') {
          transient.set(sessionId, 'reconnecting')
          changed = true
        }
      }
      if (changed) notify()
      return
    }
    if (event.type === 'open') {
      // The re-open replays every `sub` and the host re-seeds its snapshots:
      // that is the subscription confirmation the restoring bar waits for.
      if (transient.size > 0) {
        transient.clear()
        notify()
      }
      return
    }
    // A data frame for a session is proof its data flows again.
    if (isTracked(event.sessionId) && transient.delete(event.sessionId)) notify()
  }
  return onFeedHubEvent(onEvent)
}

/** Test seam: clear every mark (module singleton hygiene between specs). */
export function workspaceReleaseResetForTests(): void {
  releasedSessions.clear()
  releasedRoots.clear()
  transient.clear()
  notify()
}
