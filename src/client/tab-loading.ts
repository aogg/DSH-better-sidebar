/**
 * Tab-loading registry: which tabs are currently loading their content. The
 * reporter is whoever owns the load — the editor host while a file read is in
 * flight (its `load` state machine), the changes tab until its first event
 * pull settles — and the reader is the tab strip: a chip whose tab is here
 * swaps its leading icon for a spinner (the favicon→spinner slot a browser
 * tab uses). Pages that load their own first data can join later the same
 * way; the mechanism is deliberately page-agnostic.
 *
 * Module-level and keyed by `sessionId::tabId`: a tab id is unique only WITHIN
 * one session — the native right column counts its own `tab1`…, and the bottom
 * workbench reuses `editor:<path>` for the same file in every session (the
 * same lesson editor-dirty.ts records). Keyed by the bare tab id, session B's
 * load reports would show on session A's same-numbered tab and A's settle
 * would clear B's spinner mid-load.
 * An entry is written only while a tab IS loading and deleted the moment the
 * load settles (whatever the outcome) or its reporter unmounts (tab closed,
 * session switched), so a spinner can never outlive its load.
 */
import { useCallback, useSyncExternalStore } from 'react'

/** One registered load: the id it was recorded under. */
interface LoadingEntry {
  tabId: string
}

const loadingTabs = new Map<string, LoadingEntry>()
const listeners = new Set<() => void>()
/** Monotonic change counter: a stable `useSyncExternalStore` companion. */
let revision = 0

/** The map key of one tab: ids only identify a tab inside their session. */
function keyOf(sessionId: string, tabId: string): string {
  return `${sessionId}::${tabId}`
}

/** Notify every subscriber (the tab chips subscribed per entry). */
function notify(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

/**
 * Publish one tab's loading state: `true` registers the load, `false` clears
 * it (the load settled — ready, error, binary, whatever the outcome).
 */
export function setTabLoading(tabId: string, loading: boolean, sessionId: string): void {
  const key = keyOf(sessionId, tabId)
  if (!loading) {
    if (loadingTabs.delete(key)) notify()
    return
  }
  if (loadingTabs.has(key)) return
  loadingTabs.set(key, { tabId })
  notify()
}

/**
 * Drop a tab's entry (its reporter unmounted, or the tests cleaning up).
 * Idempotent.
 * @param sessionId - the owning session; omitted drops the id in EVERY session
 *  (the shape tests use for cleanup — a caller that knows its session should
 *  always name it, or it would clear a same-numbered tab elsewhere).
 */
export function clearTabLoading(tabId: string, sessionId?: string): void {
  if (sessionId !== undefined) {
    if (loadingTabs.delete(keyOf(sessionId, tabId))) notify()
    return
  }
  let removed = false
  for (const [key, entry] of loadingTabs) {
    if (entry.tabId !== tabId) continue
    loadingTabs.delete(key)
    removed = true
  }
  if (removed) notify()
}

/**
 * Whether one tab is loading its content.
 * @param sessionId - the owning session; `undefined` reads as "not loading" —
 *  a strip that cannot name its session (the native right rail renders its
 *  own chrome) must never show a spinner keyed to somebody else's seat.
 */
export function tabLoadingOf(sessionId: string | undefined, tabId: string): boolean {
  if (sessionId === undefined) return false
  return loadingTabs.has(keyOf(sessionId, tabId))
}

/** How many tabs are loading across every session (the tests' cross-check). */
export function tabLoadingCount(): number {
  return loadingTabs.size
}

/** The change counter (see {@link useTabLoading} for why it is not the hook's
 *  snapshot). */
export function tabLoadingRevision(): number {
  return revision
}

/** Subscribe to loading-set changes; returns the disposer. */
export function subscribeTabLoading(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Whether `tabId` of `sessionId` is loading — the tab chip's spinner flag.
 *
 * The snapshot is the tab's OWN boolean, not the store's revision: every
 * registration settles through a revision bump, and a revision snapshot would
 * re-render EVERY subscribed chip on any tab's load starting anywhere in the
 * sidebar. The boolean changes only for the tab whose flag flipped, so
 * React's `useSyncExternalStore` bails out for every other chip — a load in
 * one pane costs the other panes' strips nothing. `sessionId === undefined`
 * pins the flag to `false` (see {@link tabLoadingOf}).
 */
export function useTabLoading(sessionId: string | undefined, tabId: string): boolean {
  return useSyncExternalStore(
    useCallback((callback: () => void) => subscribeTabLoading(callback), []),
    useCallback(() => tabLoadingOf(sessionId, tabId), [sessionId, tabId]),
  )
}
