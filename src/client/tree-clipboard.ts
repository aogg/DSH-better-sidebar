/**
 * The file tree's 复制/剪切 clipboard — ONE module-level clipboard shared by
 * every tree instance on the page (the explorer's docked panel and the editor
 * tab's tree panel are separate `FileTree` mounts; Windows' clipboard is one
 * clipboard, so is ours). Pure client state: 复制/剪切 touch no wires, only
 * 黏贴 does (the host's fs.transfer job).
 *
 * A clipboard is scoped to ONE workspace (`cwd`): pasting is only offered
 * while the target tree's cwd matches — a cross-project paste would need
 * path remapping the tree does not have (v1 keeps the guard honest by
 * disabling the row instead of guessing).
 *
 * The store is tiny and subscription-based (`useSyncExternalStore`-compatible:
 * getSnapshot returns a stable reference until the next set).
 * @module dsh-better-sidebar/tree-clipboard
 */

/** One clipboard row: the absolute path plus whether it names a directory. */
export interface TreeClipboardEntry {
  path: string
  isDir: boolean
}

/** One clipboard snapshot: the source workspace, the mode, and the rows. */
export interface TreeClipboard {
  cwd: string
  mode: 'copy' | 'cut'
  entries: readonly TreeClipboardEntry[]
}

let current: TreeClipboard | null = null
const listeners = new Set<() => void>()

/** The current clipboard (stable reference between writes; `null` = empty). */
export function getTreeClipboard(): TreeClipboard | null {
  return current
}

/** Replace the clipboard (a cut of the SAME paths keeps its mode switch). */
export function setTreeClipboard(next: TreeClipboard | null): void {
  current = next
  for (const listener of [...listeners]) listener()
}

/** Subscribe to clipboard changes; returns the unsubscribe function. */
export function subscribeTreeClipboard(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
