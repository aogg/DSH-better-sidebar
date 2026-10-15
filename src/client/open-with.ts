/**
 * The file tree's "open with" vocabulary: which external editors / file
 * managers the context menu can hand a row's path to, how the per-user
 * configuration (custom editors, SSH host, path-prefix mappings, pinned ids)
 * is parsed out of the persisted blob, and how the external URL is built
 * (local `file` URLs and VSCode-family SSH-remote URLs, with the workspace
 * path prefix-mapped to the target machine's namespace first).
 *
 * Pure by design (no React / no `api`), so the whole surface is unit-testable
 * without a DOM or a host route. The menu and the settings panel only consume
 * the exported types and functions.
 */
import type { CopyKey } from './locales.ts'

/** One user-configured editor (persisted in the global `pluginSettings['editor'].openWith` blob or a workspace's `projectSettings[cwd].openWith` blob). */
export interface CustomEditor {
  id: string
  /** Human label shown in the menu (e.g. "Windsurf"). */
  name: string
  /** URL template with a `{path}` placeholder (e.g. `cursor://file/{path}`). */
  urlTemplate: string
  /** Whether the editor speaks the VSCode URL dialect — the only editors
   *  with an SSH-remote form (`<scheme>://vscode-remote/ssh-remote+<host>/…`). */
  isVscodeFamily: boolean
}

/** The per-user "open with" configuration (one key of the editor blob). */
export interface OpenWithConfig {
  /** SSH host (user@host or an ~/.ssh/config alias); '' = local workspace. */
  sshHost: string
  /** User-defined editors, appended after the built-ins. */
  customEditors: CustomEditor[]
  /** Ids of open-with targets pinned to the menu's top level
   *  ('explorer' | 'vscode' | 'cursor' | 'zed' | 'custom:<id>'). */
  pinned: string[]
  /** Workspace-path prefix → target-machine prefix, applied before the
   *  `{path}` substitution of URL targets (e.g. `/code/www` → `D:/code/www`
   *  so a DSH host running in a Linux container hands the Windows VS Code a
   *  path it can resolve). */
  pathMappings: PathMapping[]
}

/** One path-prefix mapping row (persisted with the rest of the blob). */
export interface PathMapping {
  id: string
  /** The workspace-side prefix, e.g. `/code/www` (the DSH host's view). */
  from: string
  /** The target-machine prefix, e.g. `D:/code/www` (inserted verbatim). */
  to: string
}

/** One menu-visible open target (built-in or custom, SSH-filtered). */
export interface OpenWithTarget {
  /** Stable id (`explorer` / `vscode` / `cursor` / `zed` / `custom:<id>`). */
  id: string
  /** Locale key of a built-in label (custom editors carry `name` instead). */
  nameKey?: CopyKey
  /** User-defined label (custom editors only; '' for built-ins). */
  name: string
  /** 'reveal' = show in the OS file manager; 'url' = open a URL. */
  kind: 'reveal' | 'url'
  /** URL template with `{path}`; undefined for reveal targets. */
  urlTemplate?: string
  /** Whether the editor talks the VSCode URL dialect. */
  isVscodeFamily: boolean
  /** Hidden in SSH mode (a host-local opener cannot reach a remote path). */
  localOnly: boolean
}

/** The default open-with configuration (fresh documents). */
export const OPEN_WITH_DEFAULTS: OpenWithConfig = {
  sshHost: '',
  customEditors: [],
  pinned: [],
  pathMappings: [],
}

/** The built-in open targets, in menu order. */
export const OPEN_WITH_BUILTINS: readonly OpenWithTarget[] = [
  {
    id: 'explorer',
    nameKey: 'openWithExplorer',
    name: '',
    kind: 'reveal',
    isVscodeFamily: false,
    localOnly: true,
  },
  {
    id: 'vscode',
    nameKey: 'openWithVscode',
    name: '',
    kind: 'url',
    urlTemplate: 'vscode://file/{path}',
    isVscodeFamily: true,
    localOnly: false,
  },
  {
    id: 'cursor',
    nameKey: 'openWithCursor',
    name: '',
    kind: 'url',
    urlTemplate: 'cursor://file/{path}',
    isVscodeFamily: true,
    localOnly: false,
  },
  {
    id: 'zed',
    nameKey: 'openWithZed',
    name: '',
    kind: 'url',
    urlTemplate: 'zed://file/{path}',
    isVscodeFamily: false,
    localOnly: true,
  },
]

/** Whether a persisted value makes a structurally valid custom-editor row.
 *  Name/template may be empty — the settings panel edits rows in place and
 *  an in-progress row must survive the round-trip; the MENU hides rows that
 *  fail the stricter {@link isValidCustomEditor} check. */
function isCustomEditor(value: unknown): value is CustomEditor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.name === 'string'
    && typeof record.urlTemplate === 'string'
    && typeof record.isVscodeFamily === 'boolean'
}

/** Whether a persisted value makes a structurally valid mapping row. Both
 *  prefixes may be EMPTY — the settings panel edits rows in place and an
 *  in-progress row must survive the round-trip (blank rows never match
 *  anything, see {@link applyPathMappings}). */
function isPathMapping(value: unknown): value is PathMapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.from === 'string'
    && typeof record.to === 'string'
}

/**
 * Parse the persisted `openWith` blob (tolerant): malformed fields fall back
 * to the defaults, malformed custom-editor / path-mapping rows are dropped,
 * and pinned ids are kept verbatim (unknown ids are pruned when the targets
 * are resolved — the menu is the only consumer of the resolved list).
 */
export function parseOpenWithConfig(raw: unknown): OpenWithConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...OPEN_WITH_DEFAULTS }
  const record = raw as Record<string, unknown>
  const sshHost = typeof record.sshHost === 'string' ? record.sshHost : ''
  const customEditors = Array.isArray(record.customEditors)
    ? record.customEditors.filter(isCustomEditor)
    : []
  const pinned = Array.isArray(record.pinned)
    ? record.pinned.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  const pathMappings = Array.isArray(record.pathMappings)
    ? record.pathMappings.filter(isPathMapping)
    : []
  return { sshHost, customEditors, pinned, pathMappings }
}

/** Whether a custom editor id belongs to this config (id prefix match). */
function customIdOf(id: string): string {
  return `custom:${id}`
}

/**
 * The menu-visible open targets, in order (built-ins then custom editors).
 * In SSH mode the local-only URL openers (Zed, custom editors without the
 * VSCode dialect) are dropped — they cannot reach a remote path. The
 * `explorer` target is NOT dropped: it reveals a path in the file manager of
 * the machine that owns the workspace, which is exactly where the host half
 * runs, and it is the only reveal left when the DSH host's own open-in-app
 * capability is unavailable (older host, no desktop session). A headless
 * remote cannot raise a file manager anyway — that is the same silent
 * no-op the other external launches already have. Unknown pinned ids are
 * pruned here too.
 */
export function resolveOpenWithTargets(config: OpenWithConfig): OpenWithTarget[] {
  const ssh = config.sshHost.trim() !== ''
  const targets: OpenWithTarget[] = [
    ...OPEN_WITH_BUILTINS,
    ...config.customEditors
      .filter(isValidCustomEditor)
      .map((editor): OpenWithTarget => ({
        id: customIdOf(editor.id),
        name: editor.name,
        kind: 'url',
        urlTemplate: editor.urlTemplate,
        isVscodeFamily: editor.isVscodeFamily,
        localOnly: !editor.isVscodeFamily,
      })),
  ]
  return targets.filter(target => !(ssh && target.localOnly && target.kind !== 'reveal'))
}

/** The SSH hint appended to a target's label in remote mode. */
export function openWithSshActive(config: OpenWithConfig): boolean {
  return config.sshHost.trim() !== ''
}

/**
 * Apply the path-prefix mappings to one workspace path. Only rows with BOTH
 * prefixes non-blank participate (blank rows are settings-panel
 * work-in-progress). Matching normalizes the path and every `from` to
 * forward slashes ({@link normalizeUrlPath}) and trims trailing slashes off
 * `from`, then requires a PATH-SEGMENT boundary: `/code/www` hits
 * `/code/www` itself and `/code/www/a.ts`, never `/code/wwwx/a.ts`. The
 * longest `from` wins (equal lengths keep the first row in configuration
 * order); the `to` prefix replaces the match VERBATIM — no separator
 * fixups, no re-encoding — once, at the head of the path only. Unmatched
 * paths come back unchanged.
 */
export function applyPathMappings(path: string, mappings: readonly PathMapping[]): string {
  const normalizedPath = normalizeUrlPath(path)
  let best: { from: string; to: string } | undefined
  for (const mapping of mappings) {
    if (mapping.from.trim() === '' || mapping.to.trim() === '') continue
    const from = normalizeUrlPath(mapping.from).replace(/\/+$/, '')
    const hit = normalizedPath === from || normalizedPath.startsWith(`${from}/`)
    if (hit && (best === undefined || from.length > best.from.length)) best = { from, to: mapping.to }
  }
  if (best === undefined) return path
  return `${best.to}${normalizedPath.slice(best.from.length)}`
}

/**
 * The URL to open for one resolved target, or undefined when the target has
 * no URL form (reveal) or the template is malformed. The path is inserted
 * RAW into the template (browsers percent-encode as needed; VSCode-family
 * URL parsers consume the absolute path with its leading slash, e.g.
 * `vscode://file//home/u/f.ts` or `vscode://file/C:/Users/u/f.ts`).
 *
 * The configured path-prefix mappings apply to URL targets of the LOCAL
 * workspace only: `reveal` resolves on the machine that owns the workspace
 * (the host's file manager needs no translation), and in SSH mode the path
 * lives in the remote machine's namespace — mapping it would corrupt it.
 */
export function openWithUrl(target: OpenWithTarget, path: string, config: OpenWithConfig): string | undefined {
  if (target.kind !== 'url' || target.urlTemplate === undefined) return undefined
  const ssh = openWithSshActive(config)
  const mapped = ssh ? path : applyPathMappings(path, config.pathMappings)
  // A mapping hit is already fully forward-slashed except for the verbatim
  // `to` prefix (a Windows drive letter must survive) — only an unmatched
  // path still needs backslash normalization.
  const normalized = mapped === path ? normalizeUrlPath(path) : mapped
  if (ssh && target.isVscodeFamily) {
    const scheme = schemeOf(target.urlTemplate)
    if (scheme === undefined) return undefined
    // `ssh-remote+<host>` owns NO slash of its own: the path keeps its
    // leading slash, so `/home/u/f.ts` lands as `…+host/home/u/f.ts`.
    return `${scheme}://vscode-remote/ssh-remote+${config.sshHost.trim()}${normalized}`
  }
  if (!target.urlTemplate.includes('{path}') || !hasUrlScheme(target.urlTemplate)) return undefined
  return target.urlTemplate.replace('{path}', normalized)
}

/** Whether a template starts with a `scheme://` prefix (the only shape the
 *  host's external opener accepts and the settings panel suggests). */
function hasUrlScheme(template: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(template)
}

/** The scheme of a URL template (the part before the first ':'), or undefined. */
function schemeOf(template: string): string | undefined {
  const at = template.indexOf(':')
  if (at <= 0) return undefined
  const scheme = template.slice(0, at)
  return /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? scheme : undefined
}

/** Normalize a filesystem path for embedding in a URL (backslashes → '/'). */
export function normalizeUrlPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** A fresh custom-editor id (uuid when available, time-based fallback). */
export function newCustomEditorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/**
 * Compose the GLOBAL and PROJECT open-with configurations into the one
 * effective config the menu and the URL builder consume. Both scopes are
 * user-editable (the settings page's 全局设置 / 项目设置 tabs), so neither
 * replaces the other — they merge field by field, the PROJECT side winning
 * wherever both sides express the same thing:
 *
 *  - `sshHost`: the project's host when set, else the global one (one
 *    workspace = one machine namespace; a blank project field means "use the
 *    global answer", not "local").
 *  - `customEditors`: the project's rows first, then the global rows whose
 *    id the project does not already define (an id collision keeps the
 *    project's row — same id, project's name/template win).
 *  - `pinned`: the project's pins first, then the global pins not already
 *    present (menu order follows the merged list; dedupe keeps one entry).
 *  - `pathMappings`: project rows FIRST, global rows after — the mapper
 *    picks the longest `from` (equal lengths keep the FIRST row), so a
 *    project row overrides a same-prefix global row while every other global
 *    mapping still applies.
 */
export function mergeOpenWithConfigs(globalConfig: OpenWithConfig, project: OpenWithConfig): OpenWithConfig {
  const sshHost = project.sshHost.trim() !== '' ? project.sshHost : globalConfig.sshHost
  const projectIdSet = new Set(project.customEditors.map(editor => editor.id))
  const customEditors = [
    ...project.customEditors,
    ...globalConfig.customEditors.filter(editor => !projectIdSet.has(editor.id)),
  ]
  const pinnedSet = new Set(project.pinned)
  const pinned = [...project.pinned, ...globalConfig.pinned.filter(id => !pinnedSet.has(id))]
  const pathMappings = [...project.pathMappings, ...globalConfig.pathMappings]
  return { sshHost, customEditors, pinned, pathMappings }
}

/**
 * Which blob a pin toggle on one target id must write: the PROJECT config
 * when the project owns the target — it defines that custom editor, or it
 * already carries the pin (an existing project pin must be unpinnable) — and
 * the GLOBAL config otherwise (built-ins and global-only custom editors).
 * Writing to the owning blob keeps the two scopes independently round-trippable:
 * a pin toggle never silently promotes a project setting to global or vice versa.
 */
export function openWithPinScope(globalConfig: OpenWithConfig, project: OpenWithConfig, targetId: string): 'global' | 'project' {
  const customId = targetId.startsWith('custom:') ? targetId.slice('custom:'.length) : undefined
  if (customId !== undefined && project.customEditors.some(editor => editor.id === customId)) return 'project'
  if (project.pinned.includes(targetId)) return 'project'
  return 'global'
}

/** Validate one custom-editor row before the settings panel accepts it. */
export function isValidCustomEditor(row: { name: string; urlTemplate: string }): boolean {
  return row.name.trim() !== ''
    && row.urlTemplate.includes('{path}')
    && /^[a-z][a-z0-9+.-]*:\/\//i.test(row.urlTemplate.trim())
}
