/**
 * The 推送订阅释放 (feed release) setting: how long after the active session
 * changes the OLD session's push subscriptions stay alive before the release
 * timer suspends them.
 *
 * Storage follows the plugin's own plugin-owned settings pattern (no host
 * PrefsSchema field is available to the client half): the GLOBAL value lives
 * in the reserved `pluginSettings['feeds']` blob under
 * `workspaceReleaseDelaySec`, and the PROJECT override in the reserved
 * `pluginSettings['__project'][cwd]` blob under the same key — both written
 * through the same settings routes every other client-owned row uses
 * (plugin-settings.ts / SideCardSection). The blob maps pass through the
 * host schema untouched (volatile-open dicts), so old and new hosts accept
 * them alike.
 *
 * Semantics: seconds; the default is 30; `0` disables the release entirely
 * (subscriptions stay for the run). The project value WINS where both are
 * configured (the same merge rule every project-scoped blob follows); `0` on
 * the winning level disables. Anything malformed falls back one level down.
 * @module dsh-better-sidebar/feed-release-settings
 */
import { PROJECT_SETTINGS_KEY } from '../prefs-shared.ts'
import type { SidebarPrefs } from '../prefs-shared.ts'

/** The pluginSettings blob id the global feed settings live under. */
export const FEEDS_SETTINGS_BLOB_ID = 'feeds'
/** The blob key holding the release delay. */
export const RELEASE_DELAY_KEY = 'workspaceReleaseDelaySec'
/** The default delay in seconds (30s after the switch, the old subscriptions release). */
export const RELEASE_DELAY_DEFAULT_SEC = 30
/** The accepted range: 0 (disabled) through an hour. */
export const RELEASE_DELAY_MAX_SEC = 3600

/**
 * Coerce one raw blob value into a usable delay (a finite number, or a
 * numeric string the settings page may have round-tripped), clamped to the
 * accepted range. Anything else is unusable.
 */
function coerceDelaySec(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined
  const clamped = Math.min(RELEASE_DELAY_MAX_SEC, Math.max(0, Math.round(parsed)))
  return Number.isFinite(clamped) ? clamped : undefined
}

/** One blob's delay, or undefined when the blob does not configure one. */
function blobDelaySec(blob: Record<string, unknown> | undefined): number | undefined {
  if (blob === undefined) return undefined
  return coerceDelaySec(blob[RELEASE_DELAY_KEY])
}

/**
 * Resolve the release delay for one workspace: the project override wins
 * where it is configured, the global blob is the fallback, the default
 * (30s) the last one. 0 at the WINNING level disables the release.
 * @param prefs - the current prefs snapshot (its pluginSettings maps).
 * @param cwd - the workspace root of the session being armed; undefined
 *   (no workspace known yet) reads the global value alone.
 */
export function feedReleaseDelaySec(prefs: SidebarPrefs, cwd: string | undefined): number {
  const feedsBlob = prefs.pluginSettings[FEEDS_SETTINGS_BLOB_ID]
  const global = blobDelaySec(feedsBlob) ?? RELEASE_DELAY_DEFAULT_SEC
  if (cwd === undefined || cwd === '') return global
  const projectMap = prefs.pluginSettings[PROJECT_SETTINGS_KEY]
  const projectBlob = projectMap?.[cwd] as Record<string, unknown> | undefined
  return blobDelaySec(projectBlob) ?? global
}
