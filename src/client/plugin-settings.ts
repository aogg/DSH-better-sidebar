/**
 * Pending-writes queue for the file tree's open-with config: pin toggles and
 * (outside the settings popup) config edits land in the sidebar prefs as
 * `pluginSettings['editor']`. Writes are serialized through one promise chain
 * so a quick burst of pin clicks can never read a stale pluginSettings map
 * and drop an earlier toggle; each write pushes the whole open map patch
 * through the revision-free settings route and adopts the returned document.
 *
 * (The settings popup has its own serialized commit — SideCardSection's —
 * so its rows and this helper rarely race; the shared route's last-write-wins
 * semantics cover the uncommon overlap.)
 */
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'
import { PROJECT_SETTINGS_KEY } from '../prefs-shared.ts'
import type { SidebarStore } from './state.ts'

let queue: Promise<void> = Promise.resolve()

/**
 * Merge one plugin-owned settings blob of one descriptor and persist it.
 * @param store - the sidebar store (its prefs are replaced by the write result).
 * @param descriptorId - the descriptor whose blob is patched ('editor' here).
 * @param updater - pure patch function; receives a shallow copy of the blob.
 */
export function updatePluginSettings(
  store: SidebarStore,
  descriptorId: string,
  updater: (blob: Record<string, unknown>) => Record<string, unknown>,
): void {
  queue = queue.then(async () => {
    const prefs = store.getPrefs()
    const blob = prefs.pluginSettings[descriptorId] ?? {}
    const next = updater({ ...blob })
    const view = await api.settingsUpdate({
      pluginSettings: { ...prefs.pluginSettings, [descriptorId]: next },
    })
    store.setPrefs(parsePrefs(view.value))
  }).catch((error: unknown) => {
    // The pin stays visually unchanged (no optimistic flip) and the menu
    // keeps working — the write failure is logged, not surfaced.
    console.error('open-with settings write failed', error)
  })
}

/**
 * Merge one WORKSPACE settings blob and persist it — the project-scoped
 * sibling of {@link updatePluginSettings}: same queue, same last-write-wins
 * route, but the patch lands under the reserved `pluginSettings['__project']`
 * map, keyed by the workspace root, instead of a descriptor id. `cwd` is that
 * root's absolute path (the same string `api.sessionCwd` reports); an
 * empty/undefined cwd is refused silently — there is no project to scope to,
 * and the menu degrades to the global blob. The reserved key lives inside
 * the volatile-open `pluginSettings` subtree, so hosts running the previous
 * schema accept the write too (the seam refuses any NEW top-level field).
 */
export function updateProjectSettings(
  store: SidebarStore,
  cwd: string | undefined,
  updater: (blob: Record<string, unknown>) => Record<string, unknown>,
): void {
  if (cwd === undefined || cwd === '') return
  queue = queue.then(async () => {
    const prefs = store.getPrefs()
    const map = prefs.pluginSettings[PROJECT_SETTINGS_KEY] ?? {}
    const blob = map[cwd] ?? {}
    const next = updater({ ...blob })
    const view = await api.settingsUpdate({
      pluginSettings: { ...prefs.pluginSettings, [PROJECT_SETTINGS_KEY]: { ...map, [cwd]: next } },
    })
    store.setPrefs(parsePrefs(view.value))
  }).catch((error: unknown) => {
    console.error('project settings write failed', error)
  })
}
