/**
 * Conversation FOLDER links land on the plugin's 「文件」page — shared by the
 * two lanes that can carry a directory open:
 *
 * - the agent-opens push (`sidebar/ws/agent-opens`, `{ kind: 'folder' }`) —
 *   the model's own `sidebar_open` action (use-host-feeds.ts);
 * - the RESOURCE lane — a markdown link the reader clicks in the
 *   conversation body. The host opens it as a `dsh-resource://file/…` FILE
 *   address (the address grammar has no folder kind), the plugin's editor
 *   type claims it, and the tab it mints can only fail its read
 *   (`"…" is a directory`). EditorHost diverts that failure here.
 *
 * Both lanes share one landing: activate the single-instance files page and
 * reveal the folder row in its tree (highlight + reveal-scroll). Nothing
 * here opens a folder WINDOW — the editor tab with `meta.dir: true` stays a
 * manual capability (EditorHost's own folder windows).
 */
import type { Context } from '../context-types.ts'
import { resolveSidebarPath } from './paths.ts'
import { pathWithinCwd, revealPaths, type SidebarStore } from './state.ts'

/**
 * Activate the plugin's 「文件」page for a conversation FOLDER link, then
 * reveal the folder in its tree: the ancestors between the session cwd and
 * the folder expand (the lazy tree can render the row), the FOLDER ITSELF
 * expands too (the reader asked the folder OPEN — its children load under the
 * row), and the folder lands in the store's `revealed` set, so the page
 * highlights the row and its reveal-scroll centers it — the same locator a
 * "Show in folder" paints, aimed at a directory and opened up.
 *
 * The page is the PATH-LESS editor seed: `service.openTab`'s editor branch
 * turns it into the native `files`-kind page open, which the host keeps ONE
 * of per pane and re-focuses on a repeat open (single-instance semantics —
 * no folder window is minted, none piles up). The click IS the reader's
 * gesture — unlike the background auto-opens the Tasks takeover gate guards
 * (see use-host-feeds.ts) — so the activation always reveals, exactly like
 * the topology jump-back that "always leaves the column as the host
 * expanded it".
 *
 * The reveal anchors at the session cwd and lands for in-tree folders only
 * (`pathWithinCwd`, the same guard the editor tree's reveal uses): an
 * out-of-tree target would expand phantom rows the tree cannot render. The
 * page still activates — the reader asked for the folder, the tree just has
 * no row to point at.
 *
 * The SESSION cwd is read here, not in the callers: a resource-lane tab's
 * scope carries no `cwd` at all (a conversation-body markdown link mints an
 * editor tab whose scope holds only the session id), so a caller-side
 * `resolveSidebarPath(scope.cwd, …)` would pass the relative spelling
 * through unsaved and the guard would refuse a path the tree could have
 * rendered. Resolving against `ctx.sessions`' cwd covers every lane that
 * lands here; absolute paths pass through `resolveSidebarPath` untouched.
 *
 * @param ctx - the client context (`ctx.betterSidebar` + `ctx.sessions`).
 * @param store - the plugin store (the reveal set lives in the session state).
 * @param sessionId - the session the open belongs to (the reveal's session).
 * @param folder - the folder path the link named (absolute, or
 *   workspace-relative resolved against the session cwd).
 */
export function activateFilesPage(ctx: Context, store: SidebarStore, sessionId: string, folder: string): void {
  ctx.get('betterSidebar')?.openTab({ type: 'editor' }, { sessionId })
  const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  const target = resolveSidebarPath(cwd, folder)
  if (!pathWithinCwd(cwd, target)) return
  // `expandTarget`: the folder-link semantic — the folder row OPENS (its
  // children load below the highlight), unlike the file reveals that leave
  // the target's own expansion alone.
  store.reduce(state => revealPaths(state, cwd, [target], { expandTarget: true }))
}

/**
 * Whether one viewer-load failure is the fs read route's "this is a
 * directory, not a file" answer.
 *
 * The route has no dedicated wire code for it — `"${path}" is a directory`
 * rides the generic `fs-error` envelope code — so the message SHAPE is the
 * discriminator, kept here so both the shape and its one consumer live next
 * to the folder landing they divert to. The leading quote separates it from
 * any third-party sentence that merely ends the same way, and an explicit
 * foreign `code` (a caller-shaped error) is refused outright; the plugin's
 * own route always answers `fs-error`, which passes.
 * @param error - the rejection the editor host's fs read caught.
 * @returns true when the failed read named a directory.
 */
export function isDirectoryReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (code !== undefined && code !== 'fs-error') return false
  return error.message.startsWith('"') && error.message.endsWith('is a directory')
}
