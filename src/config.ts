/**
 * Serializable configuration and defaults for the sidebar host half. Loader
 * schema validation normally fills defaults; {@link resolveSidebarConfig}
 * applies the same defaults for direct callers that bypass the Loader.
 *
 * Schemastery comes from DSH, not from the public `schemastery` package, and
 * that is load-bearing rather than stylistic: only DSH's build WRAPS a
 * `meta.volatile` field in a cosmokit `Volatile` reference when it parses the
 * config. The Loader's volatile-commit path walks those references
 * (`volatileEntries` / `updateVolatile`), so a schema built with the public
 * package produces plain values, leaves the loader nothing to commit, and
 * **silently drops every live preference write** — the write reports success
 * and the effective value never changes.
 * @module dsh-better-sidebar/config
 */

import z from '@deepseek-ai/schemastery'
import {
  EXPLORER_EXCLUDE_DEFAULTS,
  RIGHTBAR_RATIO_MAX,
  RIGHTBAR_RATIO_MIN,
  type SidebarPrefs,
} from './prefs-shared.ts'

export {
  EXPLORER_EXCLUDE_DEFAULTS,
  SIDEBAR_PREFS_DEFAULTS,
  SIDEBAR_PREFS_NS,
  type SidebarPrefs,
} from './prefs-shared.ts'

/** Tunable sidebar host limits (every field optional; defaults fill in). */
export interface SidebarConfig {
  /** Explorer row bound of one level. */
  listLimit?: number
}

/**
 * Schemastery schema for the deployment-provided host limits.
 *
 * The three transfer/read caps this schema used to carry (`readLimit` /
 * `mediaLimit` / `uploadLimit`) are gone: upload, download and the HTML
 * preview route all stream now, so there is nothing left for a byte cap to
 * protect and a large file is simply a large file. What replaced `readLimit`
 * is {@link MAX_EDITABLE_BYTES} — not a transfer cap but the size above which
 * a text file gets a read-only paged preview instead of an editor, because
 * CodeMirror has to hold the whole document in the browser.
 *
 * Old profiles that still write the retired keys are harmless: schemastery
 * tolerates unknown keys (the same property that keeps a legacy
 * `workspaceFence` field in an old profile from being fatal).
 */
const LimitsSchema = z.object({
  listLimit: z.number().step(1).min(1).default(1000),
})

/** Fully defaulted sidebar host settings. */
export interface ResolvedSidebarConfig {
  listLimit: number
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 *
 * @param config - Deployment-provided sidebar host settings.
 * @returns Complete settings consumed by the host half.
 */
export function resolveSidebarConfig(config: SidebarConfig | undefined): ResolvedSidebarConfig {
  return {
    listLimit: config?.listLimit ?? 1000,
  }
}

// ── User-facing "Side card" preferences ─────────────────────────────────────

/**
 * Schemastery schema for the user-facing preferences (validated by the
 * settings service).
 *
 * Asserted as `z<SidebarPrefs>` (the interface lives in `prefs-shared.ts`; the
 * explicit annotation is also what keeps the emitted declaration portable).
 * Unknown keys are TOLERATED by this schema and pass through untouched, which
 * is what keeps a legacy `workspaceFence: true` — or the retired title-bar
 * compatibility keys (`titleBarScheme` / `titleBarPresetId` /
 * `titleBarCompat` / `titleBarStripPx`, removed with the whole strip
 * mechanism) — in an old profile harmless instead of fatal.
 */
export const PrefsSchema: z<SidebarPrefs> = z.object({
  autoOpenSubagent: z.boolean().default(true),
  autoOpenJobs: z.boolean().default(true),
  tasksViewMode: z.union([z.const('graph'), z.const('tree')]).default('graph'),
  mobileNoAutoOpen: z.boolean().default(true),
  mobileDefaultTree: z.boolean().default(true),
  agentOpenTools: z.boolean().default(false),
  editorExplorer: z.boolean().default(false),
  editorGitGutter: z.boolean().default(true),
  // The file tree's TortoiseGit-style overlay badges (green ✓ on clean paths
  // and friends). ON by default — the same "git ink is the point" stance as
  // the editor gutter above.
  explorerGitBadges: z.boolean().default(true),
  explorerExclude: z.array(z.string()).default([...EXPLORER_EXCLUDE_DEFAULTS]),
  customCss: z.string(),
  htmlViewerNoSandbox: z.boolean().default(false),
  htmlViewerDefaultUnsafe: z.boolean().default(false),
  // The right-sidebar width/open behaviour (feature pair: open ratio +
  // new-session auto-open). The ratio range mirrors the client clamp
  // (prefs-shared.ts); the settings service enforces it on write, the client
  // re-clamps on read (a hand-edited document must not poison the layout).
  rightbarOpenOnNewSession: z.boolean().default(true),
  rightbarOpenRatio: z.number().min(RIGHTBAR_RATIO_MIN).max(RIGHTBAR_RATIO_MAX).default(0.35),
  // Per-feature enable switches are OPEN maps (any tab/viewer id, built-in or
  // external): an absent key means enabled, so old documents resolve to {}
  // (everything on) with no migration. Non-boolean values fail validation.
  tabsEnabled: z.dict(z.boolean()).default({}),
  viewersEnabled: z.dict(z.boolean()).default({}),
  // Plugin-owned settings blobs (v0.12.0+) are an OPEN nested map: any
  // descriptor id may carry any JSON-serializable values. This is the
  // "settings seam" opening — without it the seam would drop third-party
  // keys as unknown schema fields. The reserved `__project` key (NOT a
  // descriptor id; nothing can register it) carries the per-workspace blobs
  // (v0.26.0+): `{ [workspaceRoot]: { openWith: … } }`, which the client
  // composes OVER the global `pluginSettings['editor']` configuration. It
  // deliberately lives UNDER this open map instead of a new top-level
  // field: the settings seam's write validation refuses any field the
  // schema does not declare ("not volatile"), so a freshly added top-level
  // field would be rejected by a host still running the previous schema —
  // whereas the whole `pluginSettings` subtree is volatile-open and
  // accepted by old and new hosts alike (client-hmr deploys stay complete).
  pluginSettings: z.dict(z.dict(z.any())).default({}),
  // 「历史发送」持久数据的存储根（host half 只读；空串 = 默认根
  // `<DSH_HOME||~/.dsh>/plugins/DSH-better-sidebar/`）。放进 PrefsSchema.dict
  // 即自动进入 volatilePrefs 的既有机制（该机制遍历 dict 逐字段 .volatile()），
  // 无需额外处理。
  historyStoragePath: z.string().default(''),
})

// ── The Loader row schema ───────────────────────────────────────────────────
//
// DSH 0.1.7 replaced the registrable settings namespace with a forms service
// over the profile's own entries: a form is addressed by the row's Loader
// entry id and read from `entry.fiber.runtime.Config`, i.e. THIS export.
// There is no longer anywhere else for the user preferences to live, so they
// are merged into the row schema beside the deployment limits.
//
// Every preference field is volatile, and BOTH halves of that matter:
//   - the Loader's `equalExceptVolatile` ignores volatile fields, so a
//     preference edit is recognised as volatile-only and takes the live-commit
//     path (`loader/volatile-update`) instead of remounting the plugin, while
//     the ordinary limit fields above keep the remount semantics they had;
//   - DSH's schemastery WRAPS a volatile field in a `Volatile` reference while
//     parsing, which is the thing that path commits into. Marking a field
//     volatile on the public schemastery build sets the same `meta` flag but
//     produces plain values, and the commit then silently has nothing to do —
//     which is why this module imports schemastery from DSH (see the header).
//
// `.volatile()` RETURNS A COPY (`extra()` does), so the marked schemas have to
// be collected — calling it for its side effect leaves every field non-volatile
// and the settings service then reports "no volatile fields" for the row.
const volatilePrefs = Object.fromEntries(
  Object.entries(PrefsSchema.dict ?? {}).map(([key, field]) => [key, field.volatile()]),
)

/**
 * Config schema of this plugin's Loader row: deployment limits plus the live
 * user preferences.
 */
export const Config = z.object({
  ...LimitsSchema.dict,
  ...volatilePrefs,
}) as z<SidebarConfig & SidebarPrefs>
