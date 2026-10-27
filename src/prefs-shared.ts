/**
 * Shared "Side card" preference vocabulary (types + constants), consumed by
 * BOTH halves: the host registers the schemastery schema over these values
 * (config.ts) and the client reads/writes them through the settings RPC
 * (client/prefs.ts, client/SideCardSection.tsx). Kept free of schemastery so
 * the browser bundle never pulls the schema runtime in.
 */

/** The user-settings namespace holding the side card preferences. */
export const SIDEBAR_PREFS_NS = 'dsh-better-sidebar'

/**
 * The right sidebar's open width as a RATIO of the viewport (0.15–0.7):
 * applied once per expansion (a `rightbarShown` false → true transition) by
 * the client's width sync, and written back (rounded to 0.001) after the user
 * drags the host's width handle. The host's own memory-only default is 45% of
 * the viewport on first open; this preference makes the width survive reloads.
 */
export const RIGHTBAR_RATIO_MIN = 0.15
export const RIGHTBAR_RATIO_MAX = 0.7
export const RIGHTBAR_RATIO_DEFAULT = 0.35

/** Clamp one raw ratio into the declared range (non-finite falls to the default). */
export function clampRightbarRatio(value: number): number {
  if (!Number.isFinite(value)) return RIGHTBAR_RATIO_DEFAULT
  return Math.min(RIGHTBAR_RATIO_MAX, Math.max(RIGHTBAR_RATIO_MIN, value))
}

/** User-facing side card preferences. */
export interface SidebarPrefs {
  /**
   * Whether the sidebar auto-activates the Tasks page when the current
   * conversation spawns a new subagent.
   */
  autoOpenSubagent: boolean
  /**
   * Whether the sidebar auto-activates the Tasks page containing the
   * background-jobs section when a NEW job appears for the current
   * conversation (any new job id, not just the first one).
   */
  autoOpenJobs: boolean
  /**
   * The Tasks page's default presentation: the workflow graph canvas or the
   * classic indentation tree (the in-page toggle still flips it ad hoc).
   */
  tasksViewMode: 'graph' | 'tree'
  /**
   * MOBILE ADAPTATION (narrow viewports, `isNarrowWidth`): while the viewport
   * is narrow, do not auto-activate the Tasks page for background activity —
   * it suppresses BOTH triggers (`autoOpenSubagent` and `autoOpenJobs`) at
   * once, because on a phone the takeover costs the whole screen. The two
   * individual switches keep their own meaning on wide viewports.
   */
  mobileNoAutoOpen: boolean
  /**
   * MOBILE ADAPTATION (narrow viewports): open the Tasks page in the classic
   * TREE by default instead of the workflow graph — a narrow screen cannot
   * show a layered graph legibly, while the tree's indentation still reads.
   * It only picks the DEFAULT: the in-page view toggle still flips this
   * session's page ad hoc, and `tasksViewMode` keeps deciding on wide
   * viewports.
   */
  mobileDefaultTree: boolean
  /**
   * Whether the model-facing `sidebar_open` tool is injected into the
   * model's toolset — one tool that lets the model actively open a local
   * file, a local folder (as a tree rooted there), or an HTTP(S) page in
   * the calling session's sidebar. Off by default: the feature stays
   * dormant until the user explicitly enables it in the side card settings.
   */
  agentOpenTools: boolean
  /**
   * Whether the editor tab runs in merged mode: a path input replaces the
   * plain header and a toggleable file-tree panel (with a global name
   * search) docks at the tab's right edge. On by default; also makes brand
   * new sessions seed an empty editor tab (tree panel open) instead of the
   * explorer tab. The switch lives under the editor card's gear in the
   * Side card settings; off restores the pre-merge editor exactly.
   */
  editorExplorer: boolean
  /**
   * Whether the `code` editor paints its uncommitted changes the way VS Code
   * does (issue #212): the line number takes the tone of its change, a thin
   * colored bar sits at the left of the numbers, and hovering a line shows
   * that line's blame as a plain-text tooltip. On by default — there is ONE
   * switch for the whole feature (no per-part toggles: no author / hash /
   * date / summary switches, no end-of-line widget).
   */
  editorGitGutter: boolean
  /**
   * Whether the text editor paints a VS Code-style minimap at the right edge
   * of the CodeMirror surface: a sampled one-bar-per-line thumbnail of the
   * whole document plus a translucent viewport slider, click/drag/wheel
   * driving `scrollDOM.scrollTop`. On by default; ONE switch for the whole
   * strip (no per-part toggles). Only the CodeMirror surface carries it —
   * rendered markdown/html/jsonl previews never do, and a pane narrower
   * than 420px (the editor chunk's MINIMAP_MIN_EDITOR_WIDTH) hides it
   * entirely.
   */
  editorMinimap: boolean
  /**
   * Whether the file tree paints TortoiseGit-style status badges (a ~9px
   * circular overlay at the file icon's lower-right): the green ✓ of a tracked
   * clean path, the red ! of a modification, and the rest of the overlay
   * vocabulary. One switch for the whole feature; OFF restores the plain tree
   * (the existing name ink and letter badges stay — they are the pre-badge
   * behavior, not part of this switch).
   */
  explorerGitBadges: boolean
  /**
   * VS Code `files.exclude`-style glob patterns (the editor card's gear
   * popup manages the list): matched entries are REMOVED from the file tree
   * and the name search entirely — dot-prefixed rows otherwise render
   * dimmed as usual. Supported shapes: a bare name
   * (`Thumbs.db`) at any depth, a cwd-anchored path (`build/out`), a
   * doublestar head for any depth (doublestar + slash + name), and `*` /
   * `?` wildcards.
   * Excluded entries never block the breadcrumb fold either (the host probe
   * and the listing share the one compiled matcher).
   */
  explorerExclude: string[]
  /**
   * Free-form CSS injected into the page (last in the cascade, so it can
   * override the plugin's styles; use `!important` to override JS-written
   * inline CSS variables). The escape hatch for anything the settings rows
   * do not cover — applied whenever it is non-empty.
   */
  customCss: string
  /**
   * Storage root for the prompt-history records and this plugin's own data
   * (empty = the stock default, `~/.dsh/plugins/DSH-better-sidebar/`); the
   * host migrates the old data when it changes. Kept here so the client
   * settings row and the host schema share one typed name.
   */
  historyStoragePath: string
  /**
   * Whether the HTML previewer drops its sandboxed iframe. Sandbox ON (the
   * default) renders previewed HTML in an opaque-origin iframe that cannot
   * touch the GUI; turning it OFF runs the previewed page with the GUI's
   * own origin — full read/write access to session files and internal
   * APIs. Only for trusted local content; the setting copy warns.
   */
  htmlViewerNoSandbox: boolean
  /**
   * Whether a newly opened HTML preview starts UNSANDBOXED (the per-surface
   * temporary unlock pre-applied). Off by default: previews open sandboxed
   * and the status row offers the one-tap unlock; when on, previews open
   * in the red unsandboxed state and the status row offers a one-tap
   * restore for the current file.
   */
  htmlViewerDefaultUnsafe: boolean
  /**
   * Whether the markdown preview's outline (TOC) is PINNED open: while true
   * the panel stays expanded on every md preview in the project (any file
   * with enough headings), across files, sessions and restarts — the
   * preference is read once per page load and toggled live from the pin
   * button beside the outline button (not a settings-page row). Off by
   * default: the outline stays a click-open popover.
   */
  tocPinned: boolean
  /**
   * Whether a NEWLY CREATED session (an id that appears after this page
   * loaded) auto-expands the host's right sidebar when it comes on screen.
   * Sessions restored at page load never trigger — only ids the page saw
   * appear.
   */
  rightbarOpenOnNewSession: boolean
  /**
   * The right sidebar's open width as a ratio of the viewport — see
   * {@link RIGHTBAR_RATIO_DEFAULT} and friends for the contract.
   */
  rightbarOpenRatio: number
  /**
   * Per-tab enable switches, keyed by tab descriptor id (`'explorer'`,
   * `'my-plugin:db'`). An ABSENT key means enabled — only an explicit
   * `false` disables a tab type (hidden from the + menu, `openTab` refuses,
   * and derived flows like subagent auto-open / agent-terminal tabs stop).
   * Already-open tabs of a disabled type keep rendering (closing one
   * prevents reopening), matching the "existing conversations keep their
   * own layouts" rule.
   */
  tabsEnabled: Record<string, boolean>
  /**
   * Per-viewer enable switches, keyed by file viewer descriptor id
   * (`'image'`, `'my-plugin:csv'`). An ABSENT key means enabled; a disabled
   * viewer is skipped by `matchFileViewer` so files fall through to the
   * next matching viewer (or the download button when none match).
   */
  viewersEnabled: Record<string, boolean>
  /**
   * Plugin-owned settings blobs (v0.12.0+), keyed by descriptor id: each
   * registered tab/viewer that declares `settings.pluginToggles` (or writes
   * through `settings.render`'s `updatePluginSetting`) persists its values
   * here — an open map, so third-party keys need no host PrefsSchema field.
   * Values are JSON-serializable (the row controls produce strings /
   * numbers / booleans; custom panels are responsible for their own).
   *
   * One RESERVED key is not a descriptor id: `__project` (v0.26.0+, see
   * {@link PROJECT_SETTINGS_KEY}) holds the per-workspace blobs,
   * `{ [workspaceRoot]: { openWith: … } }`. It lives under this open map —
   * not a top-level field — because the settings seam's write validation
   * refuses fields the schema does not declare, while this whole subtree is
   * volatile-open: old and new hosts accept the write alike.
   */
  pluginSettings: Record<string, Record<string, unknown>>
}

/**
 * The reserved `pluginSettings` key holding the per-workspace ("project")
 * settings blobs (v0.26.0+): `{ [workspaceRoot]: { openWith: … } }`, keyed
 * by the workspace root's ABSOLUTE path as the host reports it
 * (`api.sessionCwd`). Today the one blob is `openWith` — the file tree's
 * 打开方式 configuration (SSH host, custom editors, path-prefix mappings,
 * pinned ids) — which the editor composes with the GLOBAL
 * `pluginSettings['editor'].openWith` blob (project wins on conflicts, see
 * `mergeOpenWithConfigs`). A workspace with no entry falls back to the
 * global configuration unchanged. The key cannot collide with a descriptor
 * id: registration ids never start with the double underscore.
 */
export const PROJECT_SETTINGS_KEY = '__project'

/** The stock exclude list (VS Code ships a similar files.exclude default). */
export const EXPLORER_EXCLUDE_DEFAULTS: readonly string[] = ['.DS_Store', 'Thumbs.db']

/**
 * The terminal command-history capacity (plugin-owned setting
 * `pluginSettings['terminal-bottom'][TERMINAL_HISTORY_SETTING_KEY]`): how many
 * recent command executions the 「执行命令历史」 popover keeps per session, in
 * a pure in-memory ring buffer (a page reload clears it by design). Declared
 * here so the settings row (the descriptor's `pluginToggles`), the writer
 * clamp and the chunk-side recorder share one typed vocabulary.
 */
export const TERMINAL_HISTORY_MIN = 10
export const TERMINAL_HISTORY_MAX = 1000
export const TERMINAL_HISTORY_DEFAULT = 100
/** The `pluginSettings['terminal-bottom']` blob key holding the capacity. */
export const TERMINAL_HISTORY_SETTING_KEY = 'terminalHistoryLimit'
/** The descriptor id whose settings blob carries {@link TERMINAL_HISTORY_SETTING_KEY}. */
export const TERMINAL_BOTTOM_DESCRIPTOR_ID = 'terminal-bottom'

/** Clamp one raw capacity into the declared range (non-finite falls to the default). */
export function clampTerminalHistoryLimit(value: unknown): number {
  // The settings blob is open (JSON values): parse defensively before comparing.
  const parsed = typeof value === 'number'
    ? value
    : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return TERMINAL_HISTORY_DEFAULT
  return Math.min(TERMINAL_HISTORY_MAX, Math.max(TERMINAL_HISTORY_MIN, Math.round(parsed)))
}

/**
 * Read the terminal command-history capacity from the resolved prefs, with the
 * default as the fallback (an absent blob / key — the stock state — reads as
 * {@link TERMINAL_HISTORY_DEFAULT}).
 */
export function terminalHistoryLimitOf(prefs: SidebarPrefs): number {
  const blob = prefs.pluginSettings[TERMINAL_BOTTOM_DESCRIPTOR_ID]
  return clampTerminalHistoryLimit(blob?.[TERMINAL_HISTORY_SETTING_KEY])
}

/** Fallback prefs used whenever the settings document is unreachable or malformed. */
export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  autoOpenSubagent: true,
  autoOpenJobs: true,
  tasksViewMode: 'graph',
  // Both mobile adaptations are ON by default: a phone is the case they exist
  // for, and each one only ever changes what happens on a NARROW viewport.
  mobileNoAutoOpen: true,
  mobileDefaultTree: true,
  agentOpenTools: false,
  editorExplorer: false,
  editorGitGutter: true,
  // The editor minimap is ON by default, like the git gutter beside it: the
  // overview strip is the feature's whole point.
  editorMinimap: true,
  // The overlay badges are the feature's whole point — ON by default, like
  // the editor gutter they sit beside.
  explorerGitBadges: true,
  explorerExclude: [...EXPLORER_EXCLUDE_DEFAULTS],
  customCss: '',
  historyStoragePath: '',
  htmlViewerNoSandbox: false,
  htmlViewerDefaultUnsafe: false,
  // The md outline starts as a click-open popover; pinning is a deliberate
  // user gesture remembered across sessions.
  tocPinned: false,
  rightbarOpenOnNewSession: true,
  rightbarOpenRatio: RIGHTBAR_RATIO_DEFAULT,
  tabsEnabled: {},
  viewersEnabled: {},
  pluginSettings: {},
}
