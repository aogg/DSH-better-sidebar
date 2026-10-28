/**
 * "Side card" settings section: the user-facing preferences for the sidebar
 * panel, rendered natively in the DSH Settings shell (nav label "Side card").
 *
 * The section is DECLARATIVE — it renders the enable/disable inventory from
 * the sidebar service's registries instead of hardcoding rows:
 *  - 常规: new conversations open the panel by default (a toggle row), the
 *    default panel width as a percent of the window (number input row), and
 *    the open-path interception toggle — the DSH settings-row recipe
 *    (title/desc left + control right, hairline separators).
 *  - 侧边栏内容: one SMALL CARD per REGISTERED tab type (built-ins and
 *    external plugins alike), laid out in a responsive grid that wraps
 *    several cards per row — icon chip + title + type id, clicked to toggle
 *    the switch persisted in `prefs.tabsEnabled[id]`.
 *  - 文件预览: one SMALL CARD per REGISTERED file viewer — icon chip + title
 *    + the extensions it covers, clicked to toggle `prefs.viewersEnabled[id]`.
 *
 * Every group lives in a container card (the DSH PluginCard recipe: l2
 * hairline, 16px radius, layer-3 fill) with a heading and an inventory count
 * badge (the settings catalogHeading recipe); the section opens with a
 * one-line intro (the DSH section heading+intro recipe).
 *
 * A card's on/off state is its VISUAL STATE: enabled = highlighted (brand
 * border + tinted fill + a compact switch knob at the card's far right),
 * disabled = neutral and dimmed. Features that declare
 * `settings.toggles` carry a labeled settings strip at the card's bottom
 * edge that opens a native Modal (wider than the primitive default) with
 * the related settings as title/desc + custom-switch rows and a Done
 * footer; the popup body scrolls internally when a feature declares many
 * rows (e.g. Terminal's six). The toggles themselves are custom
 * switches: a real checkbox (native semantics and focus) driving a styled
 * track/thumb.
 *
 * Writes ride the plugin's own fenced settings route (the host calls the
 * settings seam in-process — the DSH settings RPC domain does not serve
 * third-party namespaces to configuration clients); the shared SidebarStore
 * is refreshed on success so the very next brand-new session seeds from the
 * new values and the sidebar's consumption points (the + menu, derived
 * flows) re-render immediately. Any failure reverts the optimistic UI and
 * shows the wire error inline — a broken settings surface never crashes the
 * shell.
 */
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
  IconSettingsOutlineRegular,
  Input,
  Menu,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarPrefs } from '../prefs-shared.ts'
import { PROJECT_SETTINGS_KEY, RIGHTBAR_RATIO_MAX, RIGHTBAR_RATIO_MIN } from '../prefs-shared.ts'
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'
import {
  FEEDS_SETTINGS_BLOB_ID,
  RELEASE_DELAY_DEFAULT_SEC,
  RELEASE_DELAY_KEY,
  RELEASE_DELAY_MAX_SEC,
} from './feed-release-settings.ts'
import { AddPluginModal, type PluginKind } from './add-plugin-modal.tsx'
import { OpenWithSettings } from './open-with-settings.tsx'
import { baseName } from './paths.ts'
import { t } from './locales.ts'
import type { SidebarStore } from './state.ts'
import type {
  BetterSidebarService,
  FileViewerDescriptor,
  SidebarSettingsRenderProps,
  SidebarSettingToggle,
  TabDescriptor,
} from './service.ts'
import css from './SideCardSection.module.css'

/** Injected business face: the shared store (prefs cache) + the sidebar service (registries). */
export interface SideCardSectionInjected {
  store: SidebarStore
  service: BetterSidebarService
}

/** Full section props: the runtime share plus the injected face. The runtime
 *  half is OPTIONAL: the settings shell's slot always provides it, and the
 *  start-page settings panel (sidebar/start-links.tsx) mounts the same
 *  component standalone with the injected face alone — the section body never
 *  reads the runtime share (only `store` + `service` are destructured). */
export type SideCardSectionProps = Partial<PropsRuntime<'settings.section'>> & SideCardSectionInjected

/** Map one wire failure to the inline message (the conflict gets friendly copy). */
function messageOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'settings-conflict') {
    return `${t('settingsSaveFailed')} ${t('settingsConflict')}`
  }
  return `${t('settingsSaveFailed')} ${error instanceof Error ? error.message : String(error)}`
}

/** Resolve an i18n-friendly string-or-function value. */
function textOf(value: string | (() => string) | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'function' ? value() : value
}

/** Resolve a descriptor icon (ReactNode or size function). */
function iconOf(icon: ReactNode | ((size: number) => ReactNode) | undefined, size: number): ReactNode {
  if (icon === undefined) return null
  return typeof icon === 'function' ? icon(size) : icon
}

/** Tab inventory order: hidden types (editor/diff) last, then + menu order. */
function tabOrder(a: TabDescriptor, b: TabDescriptor): number {
  if (a.hidden !== b.hidden) return a.hidden === true ? 1 : -1
  return (a.order ?? 100) - (b.order ?? 100)
}

/** Viewer inventory order: priority desc (the catch-all `code` comes last). */
function viewerOrder(a: FileViewerDescriptor, b: FileViewerDescriptor): number {
  return (b.priority ?? 0) - (a.priority ?? 0)
}

/** Whether a feature declares any secondary settings (gear button shows). */
function hasSettings(feature: TabDescriptor | FileViewerDescriptor): boolean {
  const settings = feature.settings
  return settings !== undefined && (
    (settings.toggles?.length ?? 0) > 0
    || (settings.pluginToggles?.length ?? 0) > 0
    || settings.render !== undefined
  )
}

/** A feature's display name (viewers fall back to their id). */
function featureNameOf(feature: TabDescriptor | FileViewerDescriptor): string {
  return textOf('title' in feature ? feature.title : undefined) || feature.id
}

/**
 * Merge one plugin-owned setting into a pluginSettings map (pure, v0.12.0+).
 * Sequential merges are additive: each call spreads the map it was GIVEN,
 * so building from the latest optimistic map keeps earlier keys intact
 * (two same-tick writes must not drop each other).
 */
export function mergePluginSetting(
  pluginSettings: Record<string, Record<string, unknown>>,
  descriptorId: string,
  key: string,
  value: unknown,
): Record<string, Record<string, unknown>> {
  return {
    ...pluginSettings,
    [descriptorId]: { ...(pluginSettings[descriptorId] ?? {}), [key]: value },
  }
}

/** The settings page's two scopes: 全局设置 (the one shared document) and
 *  项目设置 (the active workspace's own blobs, keyed by its root path). */
export type SettingsScopeTab = 'global' | 'project'

/** Where the last-visited scope tab persists (per browser, like the tab layouts). */
const SETTINGS_TAB_STORAGE_KEY = 'dsh-sidebar:settings-tab'

/** Read the persisted scope tab (SSR-safe: no localStorage → 全局设置). */
function initialScopeTab(): SettingsScopeTab {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(SETTINGS_TAB_STORAGE_KEY) === 'project')
      ? 'project'
      : 'global'
  } catch {
    return 'global'
  }
}

/** The shared empty blob (stable identity for the store selectors). */
const EMPTY_PROJECT_BLOB: Record<string, unknown> = {}

/**
 * Map one plugin-owned setting into the reserved `__project` workspace map
 * (pure, v0.26.0+): the project-scoped sibling of {@link mergePluginSetting}
 * — sequential merges are additive, so building from the latest optimistic
 * map keeps earlier keys (and other workspaces' blobs) intact.
 */
export function mergeProjectSetting(
  pluginSettings: Record<string, Record<string, unknown>>,
  cwd: string,
  key: string,
  value: unknown,
): Record<string, Record<string, unknown>> {
  const map = pluginSettings[PROJECT_SETTINGS_KEY] ?? {}
  return {
    ...pluginSettings,
    [PROJECT_SETTINGS_KEY]: { ...map, [cwd]: { ...(map[cwd] ?? {}), [key]: value } },
  }
}

/**
 * Render a custom settings panel (`settings.render`) with error containment:
 * a throwing panel shows an inline error line instead of breaking the whole
 * settings page.
 */
function SettingsRender(props: {
  render: (renderProps: SidebarSettingsRenderProps) => ReactNode
  renderProps: SidebarSettingsRenderProps
}) {
  let content: ReactNode
  try {
    content = props.render(props.renderProps)
  } catch (error) {
    content = (
      <div className={css.error} role="alert">
        {t('settingsSaveFailed')} {error instanceof Error ? error.message : String(error)}
      </div>
    )
  }
  return <>{content}</>
}

/**
 * The custom switch: a real checkbox (hidden, native semantics and focus)
 * driving a styled track/thumb. Used by the general toggle rows and the
 * secondary settings popup rows.
 */
function Switch(props: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  const { checked, onChange, label } = props
  return (
    <label className={css.switch}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={checked}
        aria-label={label}
        onChange={event => { onChange(event.currentTarget.checked) }}
      />
      <span className={css.switchTrack} aria-hidden="true">
        <span className={css.switchThumb} />
      </span>
    </label>
  )
}

/**
 * 水平拖动的整数输入框（打开宽度占比行）：拖动 3px 记 1%，键入走普通文本编辑，
 * 提交统一在 blur / Enter / 拖动松手（clamped 整数，提交方负责换算与持久化）。
 * 草稿是本地 state；外部提交（含失败回滚）通过 props.value 的变化重置草稿。
 */
function DragNumberInput(props: {
  value: number
  min: number
  max: number
  label: string
  onCommit: (next: number) => void
}) {
  const { value, min, max, label, onCommit } = props
  const [draft, setDraft] = useState(String(value))
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null)
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)))
  // 外部值变化（含提交失败回滚）→ 草稿回到既存值。
  useEffect(() => { setDraft(String(value)) }, [value])
  const commitDraft = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = clamp(parsed)
    setDraft(String(next))
    onCommit(next)
  }
  return (
    <span
      className={css.dragNumber}
      data-dsh-drag-number=""
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        // jsdom lacks setPointerCapture — the tests dispatch plain pointer events.
        event.currentTarget.setPointerCapture?.(event.pointerId)
        dragRef.current = { startX: event.clientX, startValue: value }
      }}
      onPointerMove={event => {
        const drag = dragRef.current
        if (drag === null) return
        // 3px 记 1%：步进粒度 1%，手感与滚动条微调接近。
        const step = Math.round((event.clientX - drag.startX) / 3)
        setDraft(String(clamp(drag.startValue + step)))
      }}
      onPointerUp={event => {
        if (dragRef.current === null) return
        dragRef.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        commitDraft()
      }}
      onPointerCancel={() => {
        if (dragRef.current === null) return
        dragRef.current = null
        commitDraft()
      }}
    >
      <input
        type="text"
        inputMode="numeric"
        className={css.dragNumberInput}
        value={draft}
        min={min}
        max={max}
        step={1}
        aria-label={label}
        onChange={event => { setDraft(event.currentTarget.value) }}
        onBlur={commitDraft}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      <span className={css.suffix}>%</span>
    </span>
  )
}

/**
 * 单选组（真实 radio，原生语义）：一行两个选项的「打开 / 不打开」。
 */
function RadioPair(props: {
  name: string
  label: string
  onLabel: string
  offLabel: string
  value: boolean
  onChange: (next: boolean) => void
}) {
  const { name, label, onLabel, offLabel, value, onChange } = props
  return (
    <span className={css.radioGroup} role="radiogroup" aria-label={label} data-dsh-radio-pair={name}>
      <label className={css.radioOption}>
        <input
          type="radio"
          name={name}
          value="on"
          checked={value}
          onChange={() => { onChange(true) }}
        />
        <span>{onLabel}</span>
      </label>
      <label className={css.radioOption}>
        <input
          type="radio"
          name={name}
          value="off"
          checked={!value}
          onChange={() => { onChange(false) }}
        />
        <span>{offLabel}</span>
      </label>
    </span>
  )
}

/**
 * The body of a feature's secondary settings popup: one row (title/desc +
 * control) per declared setting. Switches render the custom switch; text and
 * number rows render a free-form / numeric input committed on blur/Enter
 * (clamped to the declared min/max). Extracted so the rows are testable
 * without opening the Modal (the Modal portal renders only while open).
 */
export function FeatureSettingsRows(props: {
  toggles: readonly SidebarSettingToggle[]
  prefs: SidebarPrefs
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  /** Commit one text/number row; returns the canonical value the row should
   *  display (clamped for numbers, the current pref when the input is
   *  invalid). Optional: rows with no handler keep their draft. */
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
  /** Commit one select row: the picked option's value (single) or the array
   *  of picked values (`multi: true`). Optional: rows with no handler are
   *  display-only. */
  onSelectValue?: (toggle: SidebarSettingToggle, next: unknown) => void
  /** Commit one patterns row: the whole string list after an add/remove.
   *  Optional: rows with no handler are display-only. */
  onPatterns?: (toggle: SidebarSettingToggle, next: string[]) => void
  /** Explicit value source (v0.12.0+): when given, rows read their values
   *  from it instead of the `prefs` face — plugin-owned rows read their
   *  own blob, so a plugin key can never collide with (or silently read)
   *  a host pref of the same name. (Named `valueSource`, not `valueOf`:
   *  the latter collides with the inherited Object.prototype.valueOf.) */
  valueSource?: (key: string) => unknown
}) {
  const { toggles, prefs, onToggle, onCommit, onSelectValue, onPatterns, valueSource } = props
  const read = valueSource ?? ((key: string): unknown => (prefs as unknown as Record<string, unknown>)[key])
  return (
    <div className={css.popupRows}>
      {toggles.map(toggle => {
        const title = textOf(toggle.title)
        if (toggle.type === 'patterns') {
          return (
            <PatternsRow
              key={toggle.key}
              toggle={toggle}
              title={title}
              value={read(toggle.key)}
              onPatterns={onPatterns}
            />
          )
        }
        if (toggle.type === 'select') {
          return (
            <SelectRow
              key={toggle.key}
              toggle={toggle}
              title={title}
              value={read(toggle.key)}
              onSelectValue={onSelectValue}
            />
          )
        }
        if ((toggle.type ?? 'switch') === 'switch') {
          return (
            <div key={toggle.key} className={css.popupRow}>
              <span className={css.rowText}>
                <span className={css.title}>{title}</span>
                {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
              </span>
              <Switch
                label={title}
                checked={read(toggle.key) === true}
                onChange={(next) => { onToggle(toggle, next) }}
              />
            </div>
          )
        }
        const value = String(read(toggle.key) ?? '')
        // Keyed by the committed value: a failed commit reverts prefs, the
        // key changes, and the row remounts with the stored value (typing
        // never changes the key, so mid-edit drafts survive re-renders).
        return (
          <TypedRow
            key={`${toggle.key}:${value}`}
            toggle={toggle}
            title={title}
            value={value}
            onCommit={onCommit}
          />
        )
      })}
    </div>
  )
}

/**
 * One text/number row: a controlled input whose draft is local state,
 * committed on blur/Enter through the parent's onCommit. The parent's
 * canonical return is adopted (clamped numbers, stored value for invalid
 * input); a `unit` suffix renders after the input (e.g. 'px').
 */
function TypedRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: string
  onCommit?: (toggle: SidebarSettingToggle, raw: string) => string
}) {
  const { toggle, title, value, onCommit } = props
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const canonical = onCommit?.(toggle, draft) ?? draft
    setDraft(canonical)
  }
  const number = toggle.type === 'number'
  return (
    <div className={css.popupRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      <span className={css.control}>
        <Input
          type={number ? 'number' : 'text'}
          className={number ? css.typedInputNumber : css.typedInput}
          value={draft}
          min={toggle.min}
          max={toggle.max}
          step={1}
          placeholder={toggle.placeholder}
          aria-label={title}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {toggle.unit !== undefined && <span className={css.suffix}>{toggle.unit}</span>}
      </span>
    </div>
  )
}
/**
 * The multi-line custom-CSS input (the user-space escape hatch): a monospace
 * textarea whose draft is local state, committed on blur or Cmd/Ctrl+Enter
 * through the parent's handler. Keyed by the stored value so an external
 * commit remounts it with the canonical text (same pattern as TypedRow).
 */
function CssDraft(props: {
  value: string
  onCommit: (raw: string) => void
  label: string
  placeholder?: string
}) {
  const { value, onCommit, label, placeholder } = props
  const [draft, setDraft] = useState(value)
  return (
    <textarea
      className={css.cssTextArea}
      rows={6}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onChange={event => { setDraft(event.currentTarget.value) }}
      onBlur={() => { onCommit(draft) }}
      onKeyDown={event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.blur()
      }}
    />
  )
}

/**
 * The prompt-history storage-path input (the 常规 group's one text row):
 * a controlled input whose draft is local state, committed on blur/Enter
 * through the parent's applyPref (empty = the stock default path). Keyed by
 * the stored value so an external commit remounts it with the canonical
 * text (same pattern as TypedRow / CssDraft).
 */
function HistoryStoragePathDraft(props: {
  value: string
  onCommit: (raw: string) => void
  label: string
  placeholder?: string
}) {
  const { value, onCommit, label, placeholder } = props
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === value) return
    onCommit(trimmed)
  }
  return (
    <Input
      type="text"
      className={css.typedInput}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      data-dsh-history-storage-path=""
      onChange={event => { setDraft(event.currentTarget.value) }}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

/**
 * The 推送订阅释放延时 input (the 会话切走释放 setting): a controlled number
 * input whose draft is local state, committed on blur/Enter through the
 * parent's onCommit (seconds; 0 = the release is off). Keyed by the stored
 * value so an external commit remounts it with the canonical text (same
 * pattern as TypedRow / HistoryStoragePathDraft).
 */
function ReleaseDelayDraft(props: {
  value: number
  onCommit: (next: number) => void
  label: string
}) {
  const { value, onCommit, label } = props
  const [draft, setDraft] = useState(String(value))
  const commit = (): void => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(RELEASE_DELAY_MAX_SEC, Math.max(0, Math.round(parsed)))
    if (clamped === value) {
      setDraft(String(value))
      return
    }
    onCommit(clamped)
  }
  return (
    <span className={css.control}>
      <Input
        type="number"
        className={css.typedInputNumber}
        value={draft}
        min={0}
        max={RELEASE_DELAY_MAX_SEC}
        step={1}
        placeholder={String(RELEASE_DELAY_DEFAULT_SEC)}
        aria-label={label}
        onChange={event => { setDraft(event.currentTarget.value) }}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      <span className={css.suffix}>{t('feedReleaseDelayUnit')}</span>
    </span>
  )
}

/**
 * The reusable dropdown — the primitives Menu, NOT a native <select>: a
 * closed anchor button (picked option text + chevron) opening one Menu item
 * per option (big-icon cards when any option carries an icon). Single-pick
 * commits the option's value and closes; `multi` toggles membership and
 * commits the picked values as an array (in options order), staying open.
 * Used by the declarative select rows (SelectRow).
 */
function SelectMenu(props: {
  label: string
  value: unknown
  options: readonly {
    value: string | number | boolean
    title: string | (() => string)
    desc?: string | (() => string)
    icon?: ReactNode | ((size: number) => ReactNode)
  }[]
  multi?: boolean
  onSelect: (next: unknown) => void
  placeholder?: string
}) {
  const { label, value, options, multi, onSelect, placeholder } = props
  const [open, setOpen] = useState(false)
  const hasIcons = options.some(option => option.icon !== undefined)
  const picked: readonly unknown[] = multi ? (Array.isArray(value) ? value : []) : [value]
  const selected = options.filter(option => picked.includes(option.value))

  /** Commit one picked option (toggle semantics under multi). */
  const pick = (index: number): void => {
    const option = options[index]
    if (option === undefined) return
    if (!multi) {
      onSelect(option.value)
      setOpen(false)
      return
    }
    const current = Array.isArray(value) ? [...value] : []
    const at = current.indexOf(option.value)
    if (at >= 0) current.splice(at, 1)
    else current.push(option.value)
    // Stable wire order: follow the declared options order, not pick order.
    onSelect(options.filter(o => current.includes(o.value)).map(o => o.value))
  }

  const anchor = (
    <button
      type="button"
      className={css.selectAnchor}
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => { setOpen(now => !now) }}
    >
      {!multi && hasIcons && selected[0] !== undefined && (
        <span className={css.selectAnchorIcon}>{iconOf(selected[0].icon, 16)}</span>
      )}
      <span className={css.selectAnchorText}>
        {selected.length === 0 ? (placeholder ?? '—') : selected.map(option => textOf(option.title)).join(', ')}
      </span>
      <IconChevronDownOutlineRegular size={12} />
    </button>
  )

  return (
    <Menu
      open={open}
      anchor={anchor}
      items={options.map((option, index) => ({
        id: String(index),
        label: hasIcons
          ? (
            <span className={css.selectOption}>
              <span className={css.selectOptionIcon}>{iconOf(option.icon, 24)}</span>
              <span className={css.selectOptionText}>
                <span className={css.title}>{textOf(option.title)}</span>
                {textOf(option.desc) !== '' && <span className={css.desc}>{textOf(option.desc)}</span>}
              </span>
            </span>
          )
          : textOf(option.title),
      }))}
      selectedId={!multi && selected[0] !== undefined ? String(options.indexOf(selected[0])) : undefined}
      selectedIds={multi ? selected.map(option => String(options.indexOf(option))) : undefined}
      onSelect={(id) => { pick(Number(id)) }}
      onClose={() => { setOpen(false) }}
      portal
    />
  )
}

/**
 * One select row: a dropdown over the toggle's declared `options` (the
 * shared SelectMenu). When any option carries an icon, the dropdown renders
 * big-icon option cards (icon + title + desc) and the closed anchor shows
 * the selected option's icon as well; without icons both are a single line
 * of text. Single-pick commits the option's value and closes; `multi`
 * toggles membership, commits the picked values as an array (in options
 * order), and stays open.
 */
function SelectRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: unknown
  onSelectValue?: (toggle: SidebarSettingToggle, next: unknown) => void
}) {
  const { toggle, title, value, onSelectValue } = props
  return (
    <div className={css.popupRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      <span className={css.control}>
        <SelectMenu
          label={title}
          value={value}
          options={toggle.options ?? []}
          multi={toggle.multi === true}
          onSelect={(next) => { onSelectValue?.(toggle, next) }}
        />
      </span>
    </div>
  )
}

/**
 * One patterns row (`type: 'patterns'`): an editable string list — the
 * committed values render as removable chips, and a permanently-present
 * input adds new entries (Enter or the add button; blanks and duplicates
 * are dropped). Every add/remove commits the WHOLE list through the
 * parent's onPatterns — the list is one atomic pref value.
 */
function PatternsRow(props: {
  toggle: SidebarSettingToggle
  title: string
  value: unknown
  onPatterns?: (toggle: SidebarSettingToggle, next: string[]) => void
}) {
  const { toggle, title, value, onPatterns } = props
  const patterns = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : []
  const [draft, setDraft] = useState('')
  const commitAdd = (): void => {
    const next = draft.trim()
    setDraft('')
    if (next === '' || patterns.includes(next)) return
    onPatterns?.(toggle, [...patterns, next])
  }
  return (
    <div className={css.patternsRow}>
      <span className={css.rowText}>
        <span className={css.title}>{title}</span>
        {textOf(toggle.desc) !== '' && <span className={css.desc}>{textOf(toggle.desc)}</span>}
      </span>
      {patterns.length > 0 && (
        <div className={css.patternsChips}>
          {patterns.map((pattern, index) => (
            <span key={`${pattern}:${index}`} className={css.patternsChip}>
              {pattern}
              <button
                type="button"
                className={css.patternsChipRemove}
                aria-label={`${t('explorerExcludeRemove')} ${pattern}`}
                title={t('explorerExcludeRemove')}
                onClick={() => { onPatterns?.(toggle, patterns.filter((_, at) => at !== index)) }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={css.patternsAdd}>
        <Input
          type="text"
          className={css.patternsInput}
          value={draft}
          placeholder={toggle.patternsPlaceholder ?? toggle.placeholder}
          aria-label={title}
          spellCheck={false}
          onChange={event => { setDraft(event.currentTarget.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitAdd()
            }
          }}
        />
        <button type="button" className={css.done} onClick={commitAdd}>
          {t('explorerExcludeAdd')}
        </button>
      </div>
    </div>
  )
}

/**
 * The secondary settings popup body of one feature (tab or viewer):
 * - the host-prefs `toggles` rows, then the plugin-owned `pluginToggles`
 *   rows (their values live in `pluginSettings[feature.id]`, projected onto
 *   the prefs face so the shared row renderer reads them);
 * - `settings.render` (custom panel) AFTER those rows when declared — the
 *   custom panel is an extension of the row list, not a replacement, so a
 *   feature can keep its declarative rows (e.g. the editor's
 *   open-behavior picker) and still ship a custom configuration area.
 */
export function SettingsBody(props: {
  feature: TabDescriptor | FileViewerDescriptor
  prefs: SidebarPrefs
  store: SidebarStore
  service: BetterSidebarService
  onToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onCommit: (toggle: SidebarSettingToggle, raw: string) => string
  onSelectValue: (toggle: SidebarSettingToggle, next: unknown) => void
  onPatterns: (toggle: SidebarSettingToggle, next: string[]) => void
  onPluginToggle: (toggle: SidebarSettingToggle, next: boolean) => void
  onPluginCommit: (toggle: SidebarSettingToggle, raw: string) => string
  onPluginSelectValue: (toggle: SidebarSettingToggle, next: unknown) => void
  onPluginPatterns: (toggle: SidebarSettingToggle, next: string[]) => void
  onPluginWrite: (key: string, value: unknown) => void
  onClose: () => void
}) {
  const { feature, prefs, store, service, onToggle, onCommit, onSelectValue, onPatterns, onPluginToggle, onPluginCommit, onPluginSelectValue, onPluginPatterns, onPluginWrite, onClose } = props
  const render = feature.settings?.render
  const toggles = feature.settings?.toggles ?? []
  const pluginToggles = feature.settings?.pluginToggles ?? []
  if (render === undefined && toggles.length === 0 && pluginToggles.length === 0) return null
  // Plugin rows read their values from the descriptor's OWN blob through
  // an explicit value source — no projection onto the prefs face, so a
  // plugin key can never collide with (or silently read) a host pref of
  // the same name.
  const pluginBlob = prefs.pluginSettings[feature.id] ?? {}
  return (
    <div>
      {(toggles.length > 0 || pluginToggles.length > 0) && (
        <div className={css.popupRows}>
          {toggles.length > 0 && (
            <FeatureSettingsRows
              toggles={toggles}
              prefs={prefs}
              onToggle={onToggle}
              onCommit={onCommit}
              onSelectValue={onSelectValue}
              onPatterns={onPatterns}
            />
          )}
          {pluginToggles.length > 0 && (
            <FeatureSettingsRows
              toggles={pluginToggles}
              prefs={prefs}
              onToggle={onPluginToggle}
              onCommit={onPluginCommit}
              onSelectValue={onPluginSelectValue}
              onPatterns={onPluginPatterns}
              valueSource={(key) => pluginBlob[key]}
            />
          )}
        </div>
      )}
      {render !== undefined && (
        <SettingsRender
          render={render}
          renderProps={{
            store,
            service,
            prefs,
            pluginSettings: prefs.pluginSettings[feature.id] ?? {},
            updatePluginSetting: onPluginWrite,
            close: onClose,
          }}
        />
      )}
    </div>
  )
}

/**
 * Render the Side card preferences section.
 * @param props - composed slot props (runtime share + injected store/service).
 * @returns the section element tree.
 */
export function SideCardSection({ store, service }: SideCardSectionProps) {
  const [prefs, setPrefs] = useState<SidebarPrefs>(() => store.getPrefs())
  const [error, setError] = useState<string | null>(null)
  // Which feature's secondary settings popup is open (null = closed).
  const [settingsFor, setSettingsFor] = useState<TabDescriptor | FileViewerDescriptor | null>(null)
  // Whether the "add plugin" modal (a dashed card at the end of the
  // 侧边栏内容 / 文件预览 grids) is open, and for which extension point
  // (null = closed).
  const [addPluginsOpen, setAddPluginsOpen] = useState<PluginKind | null>(null)
  // The LATEST optimistic prefs, kept in sync with the state. Nested-map
  // merges (tabsEnabled / viewersEnabled / pluginSettings) MUST build from
  // this ref, not from the render-time `prefs`: two same-tick writes (e.g.
  // a settings panel updating several plugin keys at once) would otherwise
  // both spread the stale map and the later patch would drop the earlier
  // key even though the commits are serialized.
  const optimisticRef = useRef(prefs)
  useEffect(() => { optimisticRef.current = prefs }, [prefs])

  // The declarative inventory: the registered tab types and file viewers.
  // Local state + service.subscribe (registry changes are rare — plugin
  // load/unload — so a plain effect is enough; no external-store ceremony).
  const [tabs, setTabs] = useState<TabDescriptor[]>(() => [...service.getTabs()].sort(tabOrder))
  const [viewers, setViewers] = useState<FileViewerDescriptor[]>(() => [...service.getFileViewers()].sort(viewerOrder))
  useEffect(() => service.subscribe(() => {
    setTabs([...service.getTabs()].sort(tabOrder))
    setViewers([...service.getFileViewers()].sort(viewerOrder))
  }), [service])

  // The scope tab (全局设置 / 项目设置), persisted per browser like the tab
  // layouts — the page reopens where the user left it.
  const [scopeTab, setScopeTab] = useState<SettingsScopeTab>(initialScopeTab)
  const selectScopeTab = (tab: SettingsScopeTab): void => {
    setScopeTab(tab)
    try {
      localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tab)
    } catch { /* private mode: the in-memory choice still works */ }
  }

  // The ACTIVE session's live workspace root — the project tab's scope key
  // (`pluginSettings['__project'][cwd]`). The store carries the active
  // session id (the
  // sidebar shell and the native tab adapter keep it set); the HOST is the
  // authority on where the session actually works (it can follow the agent
  // into a linked worktree), the same answer the explorer uses. One fetch
  // per session change, no polling: a settings page does not need live
  // worktree tracking.
  const sessionId = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().sessionId, [store]),
    // Server snapshot: renderToString has no store effects — the same
    // snapshot face answers (a plain object store, safe to read twice).
    useCallback(() => store.getSnapshot().sessionId, [store]),
  )
  const [projectCwd, setProjectCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined) {
      setProjectCwd(undefined)
      return
    }
    let cancelled = false
    api.sessionCwd({ sessionId })
      .then(result => { if (!cancelled) setProjectCwd(result.cwd) })
      .catch(() => { if (!cancelled) setProjectCwd(undefined) })
    return () => { cancelled = true }
  }, [sessionId])

  // The workspace's own blob + its writer: the project tab's open-with panel
  // edits THIS blob; the editor window composes it OVER the global one (the
  // project wins where both configure the same thing).
  const projectMap = prefs.pluginSettings[PROJECT_SETTINGS_KEY]
  const projectBlob: Record<string, unknown> = projectCwd === undefined
    ? EMPTY_PROJECT_BLOB
    : (projectMap?.[projectCwd] as Record<string, unknown> | undefined) ?? EMPTY_PROJECT_BLOB
  const writeProjectBlob = (key: string, value: unknown): void => {
    if (projectCwd === undefined) return
    applyPref({ pluginSettings: mergeProjectSetting(optimisticRef.current.pluginSettings, projectCwd, key, value) })
  }

  // The settings document revision (guards concurrent writes). A ref: commits
  // read the freshest value at execution time, no re-render needed.
  const revisionRef = useRef<number | undefined>(undefined)
  // Whether the user already wrote since mount: the mount read must not
  // clobber a newer optimistic edit (the window is milliseconds, but a slow
  // route must never silently revert a just-made change).
  const dirtyRef = useRef(false)
  // Serialize commits: a queued write must observe the previous write's
  // revision; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  // Sync the persisted document once on mount: the revision and the current
  // values (another tab may have changed them since the store hydrated).
  useEffect(() => {
    let cancelled = false
    void api.settingsGet().then((view) => {
      if (cancelled) return
      revisionRef.current = view.revision
      if (dirtyRef.current) return
      setPrefs(parsePrefs(view.value))
    }).catch(() => { /* the store's defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [])

  /** Persist one patch through the settings route (serialized, revision-guarded). */
  const commit = (patch: Record<string, unknown>): Promise<{ ok: boolean; prefs: SidebarPrefs }> => {
    dirtyRef.current = true
    const run = inFlightRef.current.then(async () => {
      const view = await api.settingsUpdate(
        { ...patch },
        revisionRef.current,
      )
      const next = parsePrefs(view.value)
      revisionRef.current = view.revision
      store.setPrefs(next)
      return next
    })
    // A failed commit must not poison the queue: later writes still run.
    inFlightRef.current = run.then(() => undefined, () => undefined)
    return run.then(
      (next) => ({ ok: true, prefs: next }),
      (caught) => {
        setError(messageOf(caught))
        return { ok: false, prefs }
      },
    )
  }

  /** Settle one commit: success adopts the server values, failure reverts. */
  const applyOutcome = (previous: SidebarPrefs, outcome: { ok: boolean; prefs: SidebarPrefs }): void => {
    setPrefs(outcome.ok ? outcome.prefs : previous)
  }

  /** Optimistically apply one pref patch, then commit (revert on failure). */
  const applyPref = (patch: Record<string, unknown>): void => {
    const previous = optimisticRef.current
    const next = { ...previous, ...patch } as SidebarPrefs
    optimisticRef.current = next
    setPrefs(next)
    setError(null)
    void commit(patch).then(outcome => applyOutcome(previous, outcome))
  }

  /** Flip one per-tab enable switch (merge into the tabsEnabled map). */
  const onToggleTab = (id: string, next: boolean): void => {
    applyPref({ tabsEnabled: { ...optimisticRef.current.tabsEnabled, [id]: next } })
  }

  /** Flip one per-viewer enable switch (merge into the viewersEnabled map). */
  const onToggleViewer = (id: string, next: boolean): void => {
    applyPref({ viewersEnabled: { ...optimisticRef.current.viewersEnabled, [id]: next } })
  }

  /** Flip one declaratively-declared toggle (a SidebarPrefs boolean field). */
  const onToggleSetting = (toggle: SidebarSettingToggle, next: boolean): void => {
    applyPref({ [toggle.key]: next })
  }

  /** Commit one declaratively-declared select row (the option's value, or an
   *  array of values under `multi`). */
  const onSelectSetting = (toggle: SidebarSettingToggle, next: unknown): void => {
    applyPref({ [toggle.key]: next })
  }

  /** Commit one declaratively-declared patterns row (the whole string list). */
  const onPatternsSetting = (toggle: SidebarSettingToggle, next: string[]): void => {
    applyPref({ [toggle.key]: next })
  }

  /**
   * Commit one declaratively-declared text/number row. Numbers are parsed
   * and clamped to the toggle's declared min/max (an unparsable input falls
   * back to the CURRENT stored value, mirroring the width row); text rows
   * persist as-is (empty is meaningful, e.g. the theme-default font).
   * Returns the canonical value the row should display.
   */
  const onCommitSetting = (toggle: SidebarSettingToggle, raw: string): string => {
    if (toggle.type === 'number') {
      const parsed = Number(raw)
      const fallback = String((prefs as unknown as Record<string, unknown>)[toggle.key] ?? '')
      if (!Number.isFinite(parsed)) return fallback
      let clamped = Math.round(parsed)
      if (toggle.min !== undefined) clamped = Math.max(toggle.min, clamped)
      if (toggle.max !== undefined) clamped = Math.min(toggle.max, clamped)
      applyPref({ [toggle.key]: clamped })
      return String(clamped)
    }
    applyPref({ [toggle.key]: raw })
    return raw
  }

  /** Commit the free-form custom CSS (the user-space escape hatch). */
  const commitCustomCss = (raw: string): void => {
    applyPref({ customCss: raw })
  }

  /** Commit the prompt-history storage path (empty = the stock default). */
  const commitHistoryStoragePath = (raw: string): void => {
    applyPref({ historyStoragePath: raw })
  }

  /**
   * The 推送订阅释放延时 (会话切走后释放推送订阅延时, seconds; 0 = off): the
   * GLOBAL value lives in the plugin-owned `pluginSettings['feeds']` blob
   * (no host PrefsSchema field — the blob maps pass the schema untouched),
   * and the PROJECT value in the reserved `__project` blob keyed by the
   * workspace root, resolved by feed-release-settings (project wins). Both
   * rows commit through the same optimistic pipeline as every other row.
   */
  const feedsBlob = prefs.pluginSettings[FEEDS_SETTINGS_BLOB_ID] ?? EMPTY_PROJECT_BLOB
  const releaseDelayGlobal = typeof feedsBlob[RELEASE_DELAY_KEY] === 'number'
    ? (feedsBlob[RELEASE_DELAY_KEY] as number)
    : RELEASE_DELAY_DEFAULT_SEC
  const releaseDelayProject = typeof projectBlob[RELEASE_DELAY_KEY] === 'number'
    ? (projectBlob[RELEASE_DELAY_KEY] as number)
    : RELEASE_DELAY_DEFAULT_SEC
  const commitGlobalReleaseDelay = (next: number): void => {
    applyPluginSetting(FEEDS_SETTINGS_BLOB_ID, RELEASE_DELAY_KEY, next)
  }
  const commitProjectReleaseDelay = (next: number): void => {
    writeProjectBlob(RELEASE_DELAY_KEY, next)
  }

  /** Persist one plugin-owned setting of one descriptor (merged into the pluginSettings blob). */
  const applyPluginSetting = (descriptorId: string, key: string, value: unknown): void => {
    applyPref({ pluginSettings: mergePluginSetting(optimisticRef.current.pluginSettings, descriptorId, key, value) })
  }

  /** Flip one plugin-owned switch row (same row shape, plugin-scoped key). */
  const onPluginToggle = (descriptorId: string, toggle: SidebarSettingToggle, next: boolean): void => {
    applyPluginSetting(descriptorId, toggle.key, next)
  }

  /** Commit one plugin-owned text/number row (clamped like the host rows). */
  const onPluginCommitSetting = (descriptorId: string, toggle: SidebarSettingToggle, raw: string): string => {
    if (toggle.type === 'number') {
      const parsed = Number(raw)
      const blob = prefs.pluginSettings[descriptorId] ?? {}
      const fallback = String(blob[toggle.key] ?? '')
      if (!Number.isFinite(parsed)) return fallback
      let clamped = Math.round(parsed)
      if (toggle.min !== undefined) clamped = Math.max(toggle.min, clamped)
      if (toggle.max !== undefined) clamped = Math.min(toggle.max, clamped)
      applyPluginSetting(descriptorId, toggle.key, clamped)
      return String(clamped)
    }
    applyPluginSetting(descriptorId, toggle.key, raw)
    return raw
  }

  /**
   * One SMALL toggle card for the responsive inventory grid: the card's main
   * area is the switch (click to flips, visual state IS the state), the icon
   * sits in a rounded chip, the check badge pins to the far right, and a
   * feature that declares related settings gets a labeled SETTINGS STRIP
   * across the card's bottom edge (gear icon + text) opening its settings
   * popup — discoverable at rest, not a hover-only ghost corner button.
   */
  const renderCard = (props: {
    title: string
    desc: string
    icon?: ReactNode
    enabled: boolean
    onToggle: (next: boolean) => void
    /** A feature with declared related settings shows the settings strip. */
    onOpenSettings?: () => void
  }) => {
    const hasSettings = props.onOpenSettings !== undefined
    return (
      <div
        className={clsx(css.card, props.enabled && css.cardOn)}
      >
        <button
          type="button"
          className={css.cardMain}
          aria-pressed={props.enabled}
          title={props.desc}
          onClick={() => { props.onToggle(!props.enabled) }}
        >
          <span className={css.cardTop}>
            {props.icon !== null && props.icon !== undefined && (
              <span className={css.cardIconChip}>{props.icon}</span>
            )}
            <span className={css.cardTitle}>{props.title}</span>
            {props.enabled && (
              <span className={css.cardSwitch} aria-hidden="true">
                <span className={css.cardSwitchTrack}>
                  <span className={css.cardSwitchThumb} />
                </span>
              </span>
            )}
          </span>
          <span className={css.cardDesc}>{props.desc}</span>
        </button>
        {hasSettings && (
          <button
            type="button"
            className={css.cardSettings}
            aria-label={`${props.title} ${t('settingsPopup')}`}
            onClick={props.onOpenSettings}
          >
            <IconSettingsOutlineRegular size={12} />
            <span>{t('settingsPopup')}</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('settingsIntro')}</p>

      {/* The scope tabs: 全局设置 (the one shared document — everything that
          existed here before) vs 项目设置 (the active workspace's own blobs,
          keyed by its root path). Both stay editable: the project scope
          composes OVER the global one, it does not replace it. */}
      <div className={css.scopeTabs} role="tablist" aria-label={t('settingsScopeTabsLabel')}>
        <button
          type="button"
          role="tab"
          aria-selected={scopeTab === 'global'}
          className={clsx(css.scopeTab, scopeTab === 'global' && css.scopeTabOn)}
          onClick={() => { selectScopeTab('global') }}
        >
          {t('settingsTabGlobal')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scopeTab === 'project'}
          className={clsx(css.scopeTab, scopeTab === 'project' && css.scopeTabOn)}
          onClick={() => { selectScopeTab('project') }}
        >
          {t('settingsTabProject')}
        </button>
      </div>

      {/* 项目设置: the active workspace's own configuration. Without an
          active session (no workspace to scope to) the tab shows the hint;
          otherwise the open-with group renders — the one setting history
          asked to be per-project (路径映射 /code/www → D:/code/www is a
          per-workspace fact, session-dca2613f). The panel edits the reserved
          `pluginSettings['__project'][cwd]` blob through the same
          optimistic/revision-guarded pipeline as every other row. */}
      {scopeTab === 'project' && (
        projectCwd === undefined ? (
          <div className={css.group}>
            <div className={css.projectEmpty} data-dsh-project-empty="">{t('projectNoWorkspace')}</div>
          </div>
        ) : (
          <div className={css.group} data-dsh-project-scope={projectCwd}>
            <div className={css.groupHeading}>{t('projectOpenWithGroup')}</div>
            <div className={css.projectPath}>
              <span className={css.projectPathName}>{baseName(projectCwd)}</span>
              <span className={css.projectPathFull}>{projectCwd}</span>
            </div>
            <p className={css.projectHint}>{t('projectMergeHint')}</p>
            <OpenWithSettings
              pluginSettings={projectBlob}
              updatePluginSetting={writeProjectBlob}
            />
            {/* The project override of the feed-release delay: wins over the
                global value for THIS workspace (0 here disables the release
                for this project even when the global value is positive). */}
            <div className={css.row} data-dsh-release-delay-project="">
              <span className={css.rowText}>
                <span className={css.title}>{t('feedReleaseDelayProjectTitle')}</span>
                <span className={css.desc}>{t('feedReleaseDelayProjectDesc')}</span>
              </span>
              <ReleaseDelayDraft
                key={releaseDelayProject}
                value={releaseDelayProject}
                label={t('feedReleaseDelayProjectTitle')}
                onCommit={commitProjectReleaseDelay}
              />
            </div>
          </div>
        )
      )}

      {scopeTab === 'global' && (<>
      {/* The managing plugin's own identity: name + version badge, so the
          section is attributable at a glance (the version is the service
          instance's, kept in lockstep with package.json by
          tests/service.spec.ts). */}
      <div className={css.versionBadge}>
        <span className={css.versionBadgeName}>DSH-better-sidebar</span>
        <span className={css.versionBadgeTag}>v{service.version}</span>
      </div>

      {/* 常规: the DSH settings-row recipe — title/desc left, control right. */}
      <div className={css.group}>
        <div className={css.groupHeading}>{t('settingsGeneralTitle')}</div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsRightbarRatioTitle')}</span>
            <span className={css.desc}>{t('settingsRightbarRatioDesc')}</span>
          </span>
          <span className={css.control}>
            <DragNumberInput
              label={t('settingsRightbarRatioTitle')}
              value={Math.round(prefs.rightbarOpenRatio * 100)}
              min={Math.round(RIGHTBAR_RATIO_MIN * 100)}
              max={Math.round(RIGHTBAR_RATIO_MAX * 100)}
              onCommit={percent => { applyPref({ rightbarOpenRatio: Math.round(percent * 10) / 1000 }) }}
            />
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsOpenOnNewSessionTitle')}</span>
            <span className={css.desc}>{t('settingsOpenOnNewSessionDesc')}</span>
          </span>
          <span className={css.control}>
            <RadioPair
              name="dsh-rightbar-open-on-new-session"
              label={t('settingsOpenOnNewSessionTitle')}
              onLabel={t('settingsOpenOnNewSessionOn')}
              offLabel={t('settingsOpenOnNewSessionOff')}
              value={prefs.rightbarOpenOnNewSession}
              onChange={next => { applyPref({ rightbarOpenOnNewSession: next }) }}
            />
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsOpenToolsTitle')}</span>
            <span className={css.desc}>{t('settingsOpenToolsDesc')}</span>
          </span>
          <Switch
            label={t('settingsOpenToolsTitle')}
            checked={prefs.agentOpenTools}
            onChange={(next) => { applyPref({ agentOpenTools: next }) }}
          />
        </div>
        {/* 历史发送存储路径: one text row (empty = the stock default under
            ~/.dsh/plugins/DSH-better-sidebar/). The host migrates the old
            data when the path changes; committed through the same optimistic
            applyPref pipeline as every other row. */}
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('historyStoragePathLabel')}</span>
            <span className={css.desc}>{t('historyStoragePathDesc')}</span>
          </span>
          <span className={css.control}>
            <HistoryStoragePathDraft
              key={prefs.historyStoragePath}
              value={prefs.historyStoragePath}
              label={t('historyStoragePathLabel')}
              placeholder={t('historyStoragePathPlaceholder')}
              onCommit={commitHistoryStoragePath}
            />
          </span>
        </div>
        {/* 工作区切走后释放推送订阅延时（秒）: the GLOBAL feed-release delay
            (pluginSettings['feeds'].workspaceReleaseDelaySec; 0 = the old
            session's push subscriptions stay for the run). The project tab
            carries the per-workspace override. */}
        <div className={css.row} data-dsh-release-delay-global="">
          <span className={css.rowText}>
            <span className={css.title}>{t('feedReleaseDelayTitle')}</span>
            <span className={css.desc}>{t('feedReleaseDelayDesc')}</span>
          </span>
          <ReleaseDelayDraft
            key={releaseDelayGlobal}
            value={releaseDelayGlobal}
            label={t('feedReleaseDelayTitle')}
            onCommit={commitGlobalReleaseDelay}
          />
        </div>
      </div>

      {/* 自定义 CSS: the user-space escape hatch. The retired "位置兼容模式"
          scheme dropdown (auto / web / shell presets / custom) lived on the
          常规 row and its gear popup held this textarea next to a strip-px
          number row; the whole strip mechanism was removed, so the textarea
          is the only thing that row ever really owned and it now has its own
          group. Applied whenever non-empty (last in the cascade). */}
      <div className={css.group}>
        <div className={css.groupHeading}>{t('settingsCustomCssTitle')}</div>
        <CssDraft
          key={prefs.customCss}
          value={prefs.customCss}
          label={t('settingsCustomCssTitle')}
          placeholder={t('settingsCustomCssPlaceholder')}
          onCommit={commitCustomCss}
        />
      </div>

      {/* 手机: the narrow-viewport adaptations. Both switches only ever change
          what happens on a NARROW viewport (the plugin's own 768px bracket),
          so a desktop reader's behaviour is untouched whatever they pick —
          and neither one rewrites the wide-viewport switches above. */}
      <div className={css.group}>
        <div className={css.groupHeading}>{t('settingsMobileTitle')}</div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsMobileNoAutoOpenTitle')}</span>
            <span className={css.desc}>{t('settingsMobileNoAutoOpenDesc')}</span>
          </span>
          <Switch
            label={t('settingsMobileNoAutoOpenTitle')}
            checked={prefs.mobileNoAutoOpen}
            onChange={(next) => { applyPref({ mobileNoAutoOpen: next }) }}
          />
        </div>
        <div className={css.row}>
          <span className={css.rowText}>
            <span className={css.title}>{t('settingsMobileTreeTitle')}</span>
            <span className={css.desc}>{t('settingsMobileTreeDesc')}</span>
          </span>
          <Switch
            label={t('settingsMobileTreeTitle')}
            checked={prefs.mobileDefaultTree}
            onChange={(next) => { applyPref({ mobileDefaultTree: next }) }}
          />
        </div>
      </div>

      {/* 侧边栏内容: one small card per registered tab type in a responsive
          grid; features declaring `settings.toggles` open their settings in
          the popup (gear corner button) instead of nested inline rows. */}
      <div className={css.group}>
        <div className={css.groupHeading}>
          <span>{t('settingsTabsTitle')}</span>
          <span className={css.count}>{tabs.length}</span>
        </div>
        <div className={css.grid}>
          {tabs.map(tab => (
            <Fragment key={tab.id}>
              {renderCard({
                title: textOf(tab.title),
                desc: tab.id,
                icon: iconOf(tab.icon, 16),
                enabled: prefs.tabsEnabled[tab.id] !== false,
                onToggle: (next) => { onToggleTab(tab.id, next) },
                // The settings gear only while the feature is enabled: its
                // related settings are dormant while the feature is off.
                onOpenSettings: prefs.tabsEnabled[tab.id] !== false && hasSettings(tab)
                  ? () => { setSettingsFor(tab) }
                  : undefined,
              })}
            </Fragment>
          ))}
          {/* The "add tab plugin" entry: same card size as the inventory,
              but a dashed border — it opens the TAB-registration plugin
              modal instead of toggling a feature. */}
          <button
            type="button"
            className={clsx(css.card, css.addCard)}
            onClick={() => { setAddPluginsOpen('tab') }}
          >
            <span className={css.cardTop}>
              <span className={css.cardIconChip}>
                <IconPlusOutlineRegular size={16} />
              </span>
              <span className={css.cardTitle}>{t('addPluginsTabCard')}</span>
            </span>
            <span className={css.cardDesc}>{t('addPluginsTabCardDesc')}</span>
          </button>
        </div>
      </div>

      {/* 文件预览: one small card per registered file viewer. */}
      <div className={css.group}>
        <div className={css.groupHeading}>
          <span>{t('settingsViewersTitle')}</span>
          <span className={css.count}>{viewers.length}</span>
        </div>
        <div className={css.grid}>
          {viewers.map(viewer => (
            <Fragment key={viewer.id}>
              {renderCard({
                title: textOf(viewer.title) || viewer.id,
                desc: viewer.exts.length === 0 ? t('settingsViewerCatchAll') : viewer.exts.join(' · '),
                icon: iconOf(viewer.icon, 16),
                enabled: prefs.viewersEnabled[viewer.id] !== false,
                onToggle: (next) => { onToggleViewer(viewer.id, next) },
                onOpenSettings: prefs.viewersEnabled[viewer.id] !== false && hasSettings(viewer)
                  ? () => { setSettingsFor(viewer) }
                  : undefined,
              })}
            </Fragment>
          ))}
          {/* The "add preview plugin" entry: dashed card opening the
              FILE-PREVIEWER registration modal. */}
          <button
            type="button"
            className={clsx(css.card, css.addCard)}
            onClick={() => { setAddPluginsOpen('viewer') }}
          >
            <span className={css.cardTop}>
              <span className={css.cardIconChip}>
                <IconPlusOutlineRegular size={16} />
              </span>
              <span className={css.cardTitle}>{t('addPluginsViewerCard')}</span>
            </span>
            <span className={css.cardDesc}>{t('addPluginsViewerCardDesc')}</span>
          </button>
        </div>
      </div>
      </>)}

      {/* The secondary settings popup: a feature's declared related settings
          as title/desc + switch rows in a wider-than-default Modal with a
          Done footer (Modal chrome is the app's own). Mounted only while a
          feature is open — the Modal primitive runs hooks unconditionally,
          so a closed-but-mounted Modal would break SSR (and the
          renderToString spec) under the test dual-react split.
          Content: the host-prefs `toggles` rows, the plugin-owned
          `pluginToggles` rows (their values live in pluginSettings[id]),
          then the custom `settings.render` panel when declared. */}
      {settingsFor !== null && (
        <Modal
          open
          onClose={() => { setSettingsFor(null) }}
          title={featureNameOf(settingsFor)}
          description={t('settingsPopupDesc', { feature: featureNameOf(settingsFor) })}
          closeLabel={t('close')}
          className={css.popupDialog}
          footer={(
            <button type="button" className={css.done} onClick={() => { setSettingsFor(null) }}>
              {t('settingsDone')}
            </button>
          )}
        >
          <SettingsBody
            feature={settingsFor}
            prefs={prefs}
            onToggle={onToggleSetting}
            onCommit={onCommitSetting}
            onSelectValue={onSelectSetting}
            onPatterns={onPatternsSetting}
            onPluginToggle={(toggle, next) => { onPluginToggle(settingsFor.id, toggle, next) }}
            onPluginCommit={(toggle, raw) => onPluginCommitSetting(settingsFor.id, toggle, raw)}
            onPluginSelectValue={(toggle, next) => { applyPluginSetting(settingsFor.id, toggle.key, next) }}
            onPluginPatterns={(toggle, next) => { applyPluginSetting(settingsFor.id, toggle.key, next) }}
            onPluginWrite={(key, value) => { applyPluginSetting(settingsFor.id, key, value) }}
            onClose={() => { setSettingsFor(null) }}
            store={store}
            service={service}
          />
        </Modal>
      )}

      {/* The "add plugin" modal (opened by the dashed cards above): declares
          the extension point of the clicked kind, opens the GitHub topic,
          and lists the matching recommended plugin catalog with per-entry
          install buttons (the install flow opens a ~/.dsh terminal with
          the command pre-typed; failures render inline here, in settings
          only). Mounted only while open (Modal runs hooks unconditionally
          — same SSR rule as the settings popup above). */}
      {addPluginsOpen !== null && (
        <AddPluginModal
          service={service}
          onClose={() => { setAddPluginsOpen(null) }}
          kind={addPluginsOpen}
        />
      )}

      {error !== null && (
        <div className={css.error} role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
