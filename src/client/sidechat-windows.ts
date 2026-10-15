/**
 * The popped-out side conversations: a tiny module-level store of the threads
 * currently open as floating windows.
 *
 * Why module state and not the per-session sidebar store: a floating chat is
 * a PAGE-level surface (it portals to document.body and survives sidebar tab
 * switches and main-conversation switches), while the sidebar store is keyed
 * per main session. The record therefore carries everything the window layer
 * needs to keep the chat alive on its own — the thread id AND the parent
 * session scope captured at pop-out time — so a window keeps working even
 * after the reader switches the main conversation.
 *
 * Multi-open is the point: every entry renders its own FloatingWindow
 * (see SidechatWindows.tsx), so several conversations can be on screen at
 * once, none of them owning the sidebar. `slot` is frozen at open time and
 * only drives the cascade offset a fresh window lands at.
 */

/** One popped-out thread: identity + the scope its view needs. */
export interface SidechatWindowRecord {
  threadId: string
  /** The parent session the thread was opened from (the view's scope). */
  sessionId: string
  cwd: string
  /** Window title: the thread display title at pop-out time. */
  title: string
  /** Open order (0-based); only feeds the cascade offset. */
  slot: number
}

/** The empty snapshot: a stable reference so useSyncExternalStore never loops. */
const EMPTY: readonly SidechatWindowRecord[] = []

class SidechatWindowStore {
  private windows: readonly SidechatWindowRecord[] = EMPTY
  private listeners = new Set<() => void>()

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  getSnapshot = (): readonly SidechatWindowRecord[] => this.windows

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Pop a thread out (no-op when it already floats). */
  open(record: Omit<SidechatWindowRecord, 'slot'>): void {
    if (this.windows.some(window => window.threadId === record.threadId)) return
    this.windows = [...this.windows, { ...record, slot: this.windows.length }]
    this.notify()
  }

  /** Take a thread back (no-op when it is not floating). */
  close(threadId: string): void {
    if (!this.windows.some(window => window.threadId === threadId)) return
    const next = this.windows.filter(window => window.threadId !== threadId)
    this.windows = next.length === 0 ? EMPTY : next
    this.notify()
  }

  /** Whether a thread currently floats (the tab close reads this). */
  has(threadId: string): boolean {
    return this.windows.some(window => window.threadId === threadId)
  }
}

/** The page-level registry of popped-out side conversations. */
export const sidechatWindows = new SidechatWindowStore()

/** Whether a thread currently renders in a floating window. */
export function isSidechatFloating(threadId: string): boolean {
  return sidechatWindows.has(threadId)
}
