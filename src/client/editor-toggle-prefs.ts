/**
 * The editor's two gutter context-menu toggles — 「自动换行」 (CodeMirror
 * `lineWrapping`) and 「使用Git追溯注解」 (the per-line blame annotation
 * column) — persisted as keys of the editor descriptor's own settings blob
 * (`pluginSettings['editor']`), the SAME volatile-open blob that already
 * carries the merged-mode editor's `openWith` configuration.
 *
 * Why the blob and not two new top-level `SidebarPrefs` fields: the settings
 * seam's write validation refuses any top-level field the RUNNING host's
 * schema does not declare, while the whole `pluginSettings` subtree is
 * deliberately volatile-open — old and new hosts accept writes to it alike
 * (see config.ts, the `pluginSettings` field comment). These toggles ship
 * with a client-lib deploy (no host restart), so the open map is the one
 * storage location whose writes cannot be rejected by the deployed host.
 *
 * Defaults preserve today's behavior exactly: `lineWrap` is absent = ON
 * (the editor has always wrapped), `blameAnnotations` is absent = OFF (the
 * column only appears when the user asks for it).
 */
import type { SidebarPrefs } from '../prefs-shared.ts'

/** The descriptor id whose settings blob carries the editor view toggles. */
export const EDITOR_SETTINGS_BLOB_ID = 'editor'

/** The blob key holding the word-wrap switch (`true`/absent = wrapped). */
export const EDITOR_BLOB_LINE_WRAP = 'lineWrap'
/** The blob key holding the git-blame annotation column switch (`true` = shown). */
export const EDITOR_BLOB_BLAME_ANNOTATIONS = 'blameAnnotations'

/**
 * The word-wrap switch's resolved value (an absent key — the stock state —
 * reads as `true`: the editor has always wrapped, and the toggle only ever
 * records an explicit user change away from that).
 */
export function editorLineWrapOf(prefs: SidebarPrefs): boolean {
  return prefs.pluginSettings[EDITOR_SETTINGS_BLOB_ID]?.[EDITOR_BLOB_LINE_WRAP] !== false
}

/**
 * The git-blame annotation column's resolved value (absent = `false`: the
 * column is opt-in, exactly like PhpStorm's Annotate view).
 */
export function editorBlameAnnotationsOf(prefs: SidebarPrefs): boolean {
  return prefs.pluginSettings[EDITOR_SETTINGS_BLOB_ID]?.[EDITOR_BLOB_BLAME_ANNOTATIONS] === true
}
