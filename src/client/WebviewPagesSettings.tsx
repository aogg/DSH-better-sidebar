/**
 * 「webview网页」配置页（type: 'webview'，单实例，开始页胶囊的落点）：
 * 「全局 + 当前工作区」合并后的所有网页配置条目列表 + 新增/编辑表单。
 *
 * 数据面：
 * - 列表 = mergeWebviewPageRows（工作区在前、全局在后、id 冲突工作区赢），
 *   每行带来源徽章（全局 / 工作区）；读取全部来自 store 的 prefs 快照
 *   （useSyncExternalStore），任何一次写回（含别的窗口）都会实时反映。
 * - 写入走 plugin-settings.ts 的同一条串行写队列：全局 blob 是
 *   `pluginSettings['webview'].pages`，工作区 blob 是
 *   `pluginSettings['__project'][cwd].webviewPages`。改范围（编辑表单里换
 *   scope）= 两次入队：先从原 scope 删除、再写入新 scope——队列保证这两步
 *   按调用序落地，不会出现两处都在或都不在的中间态。
 * - 已开的网页 tab 由正文组件自己跟随现行配置（WebviewPageView 按 pageId
 *   解析），本页只管配置本体，不直接改 tab。
 *
 * 交互：点行进入编辑（同表单）；删除两段式确认（先点变确认态，再点执行，
 * 与后台任务终止按钮同一手法，不引入弹窗）；工作区 scope 在当前会话没有
 * cwd 时禁用并提示。
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import type { SidebarStore } from './state.ts'
import { updatePluginSettings, updateProjectSettings } from './plugin-settings.ts'
import { t } from './locales.ts'
import { openWebviewPage, type WebviewOpenService } from './webview-open.ts'
import {
  isWebviewUrl,
  mergeWebviewPageRows,
  newWebviewPageId,
  parseWebviewPages,
  upsertWebviewPage,
  WEBVIEW_PAGES_KEY,
  WEBVIEW_PROJECT_PAGES_KEY,
  WEBVIEW_SETTINGS_ID,
  withoutWebviewPage,
  type WebviewOpenMode,
  type WebviewPage,
  type WebviewScope,
} from './webview-pages.ts'
import css from './webview.module.css'

/** 表单草稿（URL/name 保持用户输入原样，保存时才 trim+校验）。 */
interface WebviewDraft {
  name: string
  url: string
  openMode: WebviewOpenMode
  pinned: boolean
  scope: WebviewScope
}

const EMPTY_DRAFT: WebviewDraft = { name: '', url: '', openMode: 'tab', pinned: false, scope: 'global' }

/** 探测 ctx 上的服务（minimal mock / 服务缺席 → undefined，打开动作静默跳过）。 */
function serviceOf(ctx: Context): WebviewOpenService | undefined {
  try {
    const service = ctx.get('betterSidebar') as WebviewOpenService | undefined
    return typeof service?.openTab === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

export function WebviewPagesSettings(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
}) {
  const { ctx, store, scope } = props
  const cwd = scope.cwd
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  )
  const pluginSettings = snapshot.prefs.pluginSettings
  const globalPages = useMemo(() => parseWebviewPages(
    (pluginSettings[WEBVIEW_SETTINGS_ID] as Record<string, unknown> | undefined)?.[WEBVIEW_PAGES_KEY],
  ), [pluginSettings])
  const workspacePages = useMemo(() => {
    if (cwd === undefined || cwd === '') return []
    const blob = (pluginSettings['__project'] as Record<string, unknown> | undefined)?.[cwd]
    return parseWebviewPages((blob as Record<string, unknown> | undefined)?.[WEBVIEW_PROJECT_PAGES_KEY])
  }, [pluginSettings, cwd])
  const rows = useMemo(() => mergeWebviewPageRows(globalPages, workspacePages), [globalPages, workspacePages])

  // undefined = 列表态；'new' = 新增；其余 = 编辑该 id。
  const [editing, setEditing] = useState<string | 'new' | undefined>(undefined)
  const [draft, setDraft] = useState<WebviewDraft>(EMPTY_DRAFT)
  const [attempted, setAttempted] = useState(false)
  // 两段式删除确认：armed 的行再点一次才真的删（点行编辑会解除武装）。
  const [armedId, setArmedId] = useState<string | undefined>(undefined)

  /** 把一份网页列表写进指定 scope 的 blob（同一条串行队列，天然防丢写）。 */
  const writeScope = (target: WebviewScope, updater: (pages: WebviewPage[]) => WebviewPage[]): void => {
    if (target === 'workspace') {
      updateProjectSettings(store, cwd, blob => ({
        ...blob,
        [WEBVIEW_PROJECT_PAGES_KEY]: updater(parseWebviewPages(blob[WEBVIEW_PROJECT_PAGES_KEY])),
      }))
      return
    }
    updatePluginSettings(store, WEBVIEW_SETTINGS_ID, blob => ({
      ...blob,
      [WEBVIEW_PAGES_KEY]: updater(parseWebviewPages(blob[WEBVIEW_PAGES_KEY])),
    }))
  }

  const startNew = (): void => {
    setDraft(EMPTY_DRAFT)
    setAttempted(false)
    setArmedId(undefined)
    setEditing('new')
  }

  const startEdit = (page: WebviewPage, source: WebviewScope): void => {
    setDraft({ name: page.name, url: page.url, openMode: page.openMode, pinned: page.pinned, scope: source })
    setAttempted(false)
    setArmedId(undefined)
    setEditing(page.id)
  }

  const cancelEdit = (): void => {
    setEditing(undefined)
    setDraft(EMPTY_DRAFT)
    setAttempted(false)
  }

  const draftValid = draft.name.trim() !== '' && isWebviewUrl(draft.url.trim())

  const save = (): void => {
    setAttempted(true)
    if (!draftValid) return
    const page: WebviewPage = {
      id: editing !== undefined && editing !== 'new' ? editing : newWebviewPageId(),
      name: draft.name.trim(),
      url: draft.url.trim(),
      openMode: draft.openMode,
      pinned: draft.pinned,
    }
    const previous = editing === 'new' ? undefined : rows.find(row => row.page.id === editing)?.source
    // 工作区落点在 cwd 消失（会话切走）时会话写被 updateProjectSettings 静默
    // 拒收——这种「以为存了其实没存」必须避免：落回原 scope（无原 scope 则全局）。
    const target: WebviewScope = draft.scope === 'workspace' && !workspaceAvailable
      ? (previous ?? 'global')
      : draft.scope
    if (previous === undefined || previous === target) {
      writeScope(target, pages => upsertWebviewPage(pages, page))
    } else {
      // 改范围 = 从原 scope 删除并写入新 scope。两次写共队列，顺序即调用序。
      writeScope(previous, pages => withoutWebviewPage(pages, page.id))
      writeScope(target, pages => upsertWebviewPage(pages, page))
    }
    cancelEdit()
  }

  const remove = (id: string, source: WebviewScope): void => {
    if (armedId !== id) {
      setArmedId(id)
      return
    }
    setArmedId(undefined)
    writeScope(source, pages => withoutWebviewPage(pages, id))
    if (editing === id) cancelEdit()
  }

  const open = (page: WebviewPage): void => {
    const service = serviceOf(ctx)
    if (service === undefined) return
    openWebviewPage(service, page)
  }

  const workspaceAvailable = cwd !== undefined && cwd !== ''

  return (
    <div className={css.view} data-dsh-webview-settings="">
      {editing === undefined ? (
        <>
          <div className={css.head}>
            <span className={css.headTitle}>{t('webviewPages')}</span>
            <button type="button" className={css.ghostButton} onClick={startNew}>{t('webviewAdd')}</button>
          </div>
          {rows.length === 0 && (
            <div className={css.empty}>{t('webviewEmpty')}</div>
          )}
          <div className={css.list}>
            {rows.map(row => (
              <div key={row.page.id} className={css.row} data-dsh-webview-row={row.source}>
                {/* 点行进编辑；行内的打开/删除是独立按钮，天然不冒泡成行点击。 */}
                <button
                  type="button"
                  className={css.rowMain}
                  onClick={() => { startEdit(row.page, row.source) }}
                >
                  <span className={css.rowText}>
                    <span className={css.rowNameLine}>
                      <span className={css.rowName}>{row.page.name}</span>
                      <span className={css.badge}>
                        {row.source === 'workspace' ? t('webviewScopeWorkspace') : t('webviewScopeGlobal')}
                      </span>
                      {row.page.pinned && <span className={`${css.badge} ${css.badgePin}`}>{t('webviewPinned')}</span>}
                    </span>
                    <span className={css.rowUrl}>{row.page.url}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('webviewOpen')}
                  title={t('webviewOpen')}
                  onClick={() => { open(row.page) }}
                >
                  →
                </button>
                <button
                  type="button"
                  className={`${css.iconButton} ${armedId === row.page.id ? css.iconButtonArmed : ''}`}
                  aria-label={armedId === row.page.id ? t('webviewDeleteConfirm') : t('delete')}
                  title={armedId === row.page.id ? t('webviewDeleteConfirm') : t('delete')}
                  onClick={() => { remove(row.page.id, row.source) }}
                  onBlur={() => { if (armedId === row.page.id) setArmedId(undefined) }}
                >
                  {armedId === row.page.id ? '!' : <IconCloseOutlineRegular size={14} />}
                </button>
              </div>
            ))}
          </div>
          {!workspaceAvailable && <div className={css.hint}>{t('webviewScopeWorkspaceUnavailable')}</div>}
        </>
      ) : (
        <form className={css.form} onSubmit={(event) => { event.preventDefault(); save() }}>
          <div className={css.head}>
            <span className={css.headTitle}>{editing === 'new' ? t('webviewAdd') : t('webviewEdit')}</span>
            <button type="button" className={css.ghostButton} aria-label={t('close')} onClick={cancelEdit}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('webviewName')}</span>
            <input
              className={css.input}
              value={draft.name}
              placeholder={t('webviewNamePlaceholder')}
              spellCheck={false}
              onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('webviewUrl')}</span>
            <input
              className={css.input}
              value={draft.url}
              placeholder={t('webviewUrlPlaceholder')}
              spellCheck={false}
              inputMode="url"
              onChange={(event) => { setDraft({ ...draft, url: event.target.value }) }}
            />
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('webviewOpenMode')}</span>
            <div className={css.segmented} role="radiogroup" aria-label={t('webviewOpenMode')}>
              {([
                ['tab', t('webviewOpenModeTab')],
                ['window', t('webviewOpenModeWindow')],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={draft.openMode === value}
                  className={`${css.segButton} ${draft.openMode === value ? css.segButtonActive : ''}`}
                  onClick={() => { setDraft({ ...draft, openMode: value }) }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className={css.checkRow}>
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(event) => { setDraft({ ...draft, pinned: event.currentTarget.checked }) }}
            />
            <span className={css.checkText}>
              <span className={css.checkTitle}>{t('webviewPinned')}</span>
              <span className={css.checkDesc}>{t('webviewPinnedDesc')}</span>
            </span>
          </label>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('webviewScope')}</span>
            <div className={css.segmented} role="radiogroup" aria-label={t('webviewScope')}>
              {([
                ['global', t('webviewScopeGlobal'), true],
                ['workspace', t('webviewScopeWorkspace'), workspaceAvailable],
              ] as const).map(([value, label, enabled]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={draft.scope === value}
                  disabled={!enabled}
                  title={enabled ? undefined : t('webviewScopeWorkspaceUnavailable')}
                  className={[
                    css.segButton,
                    draft.scope === value ? css.segButtonActive : '',
                    enabled ? '' : css.segButtonDisabled,
                  ].filter(Boolean).join(' ')}
                  onClick={() => { if (enabled) setDraft({ ...draft, scope: value }) }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {attempted && !draftValid && (
            <div className={`${css.hint} ${css.hintInvalid}`} role="alert">{t('webviewInvalidHint')}</div>
          )}
          <div className={css.formActions}>
            <button type="button" className={css.ghostButton} onClick={cancelEdit}>{t('cancel')}</button>
            <button type="submit" className={css.ghostButton} disabled={attempted && !draftValid}>{t('save')}</button>
          </div>
        </form>
      )}
    </div>
  )
}
