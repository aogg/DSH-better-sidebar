/**
 * The files window's tree surface: a global file-name search box on top
 * (300ms debounce; an in-flight search is aborted by the next keystroke),
 * with a permanent content-search entry row under it — expanding reveals a
 * keyword input (Enter runs, no debounce) plus include/exclude chip lists,
 * and the two searches share ONE results region (whichever query is live
 * owns it; starting one clears the other; clearing both restores the tree)
 * — all over the shared controlled FileTree. The results panel and the tree
 * are BOTH mounted: the query only parks one of them (`hidden`), so clearing
 * the search is free — the tree keeps its level cache and the live directory
 * watcher (the old conditional render dropped both and refetched the whole
 * visible set on every query change). Owns its refresh tick: the icon next to
 * the search input clears the tree cache, and the sort menu beside it owns the
 * tree's row order (passed down; the default is the host's own order).
 * EditorHost docks it as the tab's right panel (wrapped in a drag-resize
 * handle) and provides the file context-menu open escapes.
 *
 * Uploads (header pickers, the tree's drag-drop and "upload here" menu)
 * all funnel through here: one session at a time, shown in a full-window
 * progress overlay with cancel, followed by a tree refresh and a one-line
 * hint under the search row (success fades, failures and cancels stay).
 * OS file drags are shielded at the panel host (see Sidebar.tsx), so a
 * drop over the file window uploads here and never reaches DSH's chat
 * intake.
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type InputHTMLAttributes, type SetStateAction } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import type { BetterSidebarService } from './service.ts'
import { ancestorDirs } from './state.ts'
import { FileTree } from './FileTree.tsx'
import { DEFAULT_FILE_TREE_SORT, type FileTreeSort } from './file-tree-sort.ts'
import { IconContentSearchOutline16, IconUploadOutline16 } from './icons.tsx'
import type { OpenInApp } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import { isWithinWorkspace, resolveSidebarPath } from './paths.ts'
import { IconButton } from './ui/index.ts'
import { UploadOverlay } from './UploadOverlay.tsx'
import {
  summarizeResults, uploadHintText, uploadItemsFromFiles, uploadToDir,
  UPLOAD_HINT_MS, type UploadItem,
} from './upload.ts'
import css from './sidebar.module.css'

/** One in-flight upload session (the overlay's progress source). */
interface UploadSession {
  dir: string
  done: number
  total: number
  /** Relative path of the file being uploaded ('' when none is in flight). */
  current: string
  controller: AbortController
}

export function TreePanel(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** File context-menu "open in a new tab" (passed through to FileTree). */
  onOpenFileNewTab?: (path: string) => void
  /** File context-menu "open to the side" (passed through to FileTree). */
  onOpenFileSide?: (path: string) => void
  /** The host's open-in-app handle (passed through to FileTree; absent →
   *  the HOST half of the "打开方式" section is hidden). */
  openInApp?: OpenInApp
  /** The plugin's own open-with targets (passed through to FileTree; coexists
   *  with `openInApp`; absent → no plugin half). */
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
  /** Open one plugin target (passed through to FileTree; `false`/rejection →
   *  the tree reports the failure in its strip). */
  onOpenWith?: (targetId: string, path: string) => void | boolean | Promise<void | boolean>
  onToggleOpenWithPin?: (targetId: string) => void
  /** Show the plugin's own open-with targets even when the host lists local
   *  applications for the path (the `openWithPluginTargets` setting; passed
   *  through to FileTree). */
  openWithShowPluginTargets?: boolean
  onReferenceFile: (path: string, isDir: boolean) => void
  /** The explorerExclude pref patterns: the host filters the tree listing AND
   *  the name search with them (passed through to FileTree, and carried on the
   *  search request so both surfaces agree). */
  exclude?: readonly string[]
  /** A tree rename landed (passed through to FileTree for tab retargeting). */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** A tree delete landed (passed through to FileTree for tab closing). */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /** Whether the owning tab is on screen: a parked tab stops the tree's git
   *  polling (the shared status store pauses when nothing visible wants it). */
  visible?: boolean
  /** Full-window presentation: the panel fills its host instead of docking
   *  at a fixed width. */
  full?: boolean
  /** The sidebar registry service (file-icon registrations; passed through to FileTree). */
  service?: BetterSidebarService
}) {
  const {
    sessionId, cwd, expanded, revealed, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    openWithShowPluginTargets, exclude,
    onReferenceFile, onPathRenamed, onPathDeleted, visible, full, service,
  } = props
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ matches: string[]; dirs: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  /**
   * The explorer's row order (the header's sort control). Starts at the
   * default — name order, folders first — which is the order the host already
   * returns, so the tree looks exactly as it did before the control existed.
   */
  const [sort, setSort] = useState<FileTreeSort>(DEFAULT_FILE_TREE_SORT)
  const [sortOpen, setSortOpen] = useState(false)

  // The tree caches loaded directories per refresh tick, so content changed
  // outside DSH (another editor, a sync tool) stays stale until the manual
  // refresh click. Re-focusing the window bumps the tick automatically, and
  // integrations can force a refresh by dispatching a bubbling
  // `dsh-sidebar:refresh-files` event on `window`.
  useEffect(() => {
    const bump = (): void => { setRefreshTick(tick => tick + 1) }
    window.addEventListener('focus', bump)
    window.addEventListener('dsh-sidebar:refresh-files', bump)
    return () => {
      window.removeEventListener('focus', bump)
      window.removeEventListener('dsh-sidebar:refresh-files', bump)
    }
  }, [])
  /** One-line upload status under the search row ('' hides the hint). */
  const [uploadStatus, setUploadStatus] = useState('')
  /** Whether the status line is a failure/cancel (error color, stays visible). */
  const [uploadFailed, setUploadFailed] = useState(false)
  /** The in-flight upload session (null → no overlay, buttons enabled). */
  const [upload, setUpload] = useState<UploadSession | null>(null)
  /** True between the cancel click and the session settling (button disabled). */
  const [cancelling, setCancelling] = useState(false)
  /** Set by cancelUpload; the settle path shows 'upload cancelled' instead of
   *  summarizing the partial results. */
  const cancelledRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  /** Start one upload session into `dir` (absolute, inside the workspace). */
  const startUpload = (dir: string, items: UploadItem[]): void => {
    if (items.length === 0 || cwd === undefined || upload !== null) return
    cancelledRef.current = false
    const controller = new AbortController()
    setUploadFailed(false)
    setUploadStatus(uploadHintText(0, items.length, '', dir, t))
    setUpload({ dir, done: 0, total: items.length, current: '', controller })
    void uploadToDir({ sessionId, cwd }, dir, items, (done, total, current) => {
      if (current !== '') setUploadStatus(uploadHintText(done, total, current, dir, t))
      setUpload(session => session === null ? session : { ...session, done, total, current })
    }, controller.signal).then((results) => {
      setUpload(null)
      setCancelling(false)
      // Reload the tree whatever the outcome: files may have landed before a
      // cancel, and failures leave whatever did succeed visible.
      setRefreshTick(tick => tick + 1)
      if (cancelledRef.current) {
        setUploadStatus(t('uploadCancelled'))
        setUploadFailed(true)
        return
      }
      const status = summarizeResults(results, t)
      setUploadStatus(status)
      setUploadFailed(results.some(result => !result.ok))
      // Success messages are transient; failures stay until the next action.
      if (results.every(result => result.ok)) {
        window.setTimeout(() => {
          setUploadStatus(current => current === status ? '' : current)
        }, UPLOAD_HINT_MS)
      }
    })
  }

  /** Cancel the in-flight upload (aborts the request; the host drops its temp). */
  const cancelUpload = (): void => {
    if (upload === null || cancelling) return
    cancelledRef.current = true
    setCancelling(true)
    upload.controller.abort()
  }

  const folderInputProps = { webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>

  // ── 文本内容搜索 (content search) ────────────────────────────────────
  /** Whether the content-search section is expanded (collapsed by default). */
  const [contentOpen, setContentOpen] = useState(false)
  /** The committed content query (Enter commits; '' = no content search). */
  const [contentQuery, setContentQuery] = useState('')
  /** The content query input draft (uncommitted until Enter). */
  const [contentDraft, setContentDraft] = useState('')
  /** Include/exclude entries as chips, plus their input drafts. */
  const [contentInclude, setContentInclude] = useState<string[]>([])
  const [contentExclude, setContentExclude] = useState<string[]>([])
  const [includeDraft, setIncludeDraft] = useState('')
  const [excludeDraft, setExcludeDraft] = useState('')
  const [contentResults, setContentResults] = useState<{ matches: string[]; truncated: boolean } | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)

  const needle = query.trim()
  // The two searches are MUTUALLY EXCLUSIVE surfaces over one results region:
  // a live name query parks the content search and vice versa; both empty =
  // the file tree. The name half wins when both carry text (transient — each
  // side clears the other the moment it starts).
  const contentNeedle = contentQuery.trim()
  const searching = needle !== '' || contentNeedle !== ''
  const nameActive = needle !== ''
  const contentActive = contentNeedle !== ''
  // The search effect below must re-run on a CHANGED list, never on a churned
  // array identity: the prefs store hands out one stable reference per
  // document, but keying on the value is what makes that a guarantee rather
  // than an assumption (a re-run resets the 300ms debounce, so a per-render
  // identity would keep the search from ever settling).
  const excludeKey = (exclude ?? []).join('\0')
  useEffect(() => {
    if (needle === '') {
      setResults(null)
      setError(null)
      return
    }
    const controller = new AbortController()
    const patterns = excludeKey === '' ? undefined : excludeKey.split('\0')
    const timer = window.setTimeout(() => {
      api.fsSearch({ sessionId, cwd }, needle, patterns, controller.signal).then((found) => {
        setResults(found)
        setError(null)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setResults(null)
        setError(failure instanceof Error ? failure.message : String(failure))
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [sessionId, cwd, needle, excludeKey])

  /**
   * Commit the content query (Enter on the keyword input): clears the name
   * query so exactly one results list shows, mirroring how typing a name
   * query clears the content one.
   */
  const runContentSearch = (): void => {
    const next = contentDraft.trim()
    if (next === '') return
    setQuery('')
    setContentQuery(next)
  }

  /** Expand/collapse the section; collapsing clears the query so the section
   *  "closes back to the file tree" (the chip lists survive — they are the
   *  user's scope settings, visible on reopen). */
  const toggleContentOpen = (): void => {
    if (contentOpen) {
      setContentQuery('')
      setContentDraft('')
    }
    setContentOpen(!contentOpen)
  }

  /** Add one include/exclude chip from its draft (Enter): trimmed, deduped,
   *  empty drafts just clear. */
  const addContentEntry = (
    draft: string,
    setDraft: Dispatch<SetStateAction<string>>,
    list: readonly string[],
    setList: Dispatch<SetStateAction<string[]>>,
  ): void => {
    const value = draft.trim()
    setDraft('')
    if (value === '' || list.includes(value)) return
    setList([...list, value])
  }

  const contentIncludeKey = contentInclude.join('\0')
  const contentExcludeKey = contentExclude.join('\0')
  useEffect(() => {
    if (contentNeedle === '') {
      setContentResults(null)
      setContentError(null)
      return
    }
    // Immediate (no debounce): the query is an explicit Enter commit, not a
    // keystroke stream. An in-flight run is aborted by the next commit, a
    // chip change, or a clear — the same controller contract as the name
    // search above.
    const controller = new AbortController()
    const patterns = excludeKey === '' ? undefined : excludeKey.split('\0')
    api.fsContentSearch({ sessionId, cwd }, contentNeedle, contentInclude, contentExclude, patterns, controller.signal)
      .then((found) => {
        setContentResults(found)
        setContentError(null)
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return
        setContentResults(null)
        setContentError(failure instanceof Error ? failure.message : String(failure))
      })
    return () => {
      controller.abort()
    }
    // The chip lists ride their joined keys (stable identity per content),
    // the same trick the name search uses for the exclude pref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd, contentNeedle, contentIncludeKey, contentExcludeKey, excludeKey])

  const busy = upload !== null
  /** Directory hits (the host reports them separately): a click navigates the
   *  tree for those rows instead of opening them as files. */
  const dirHits = useMemo(() => new Set(results?.dirs), [results])

  /**
   * Jump to a DIRECTORY hit in the tree. Results include directories (they
   * show where matches live) and `fs.read` refuses one, so opening such a row
   * as a file surfaced a bare `"…" is a directory` error. Expand the folder
   * and its ancestors instead — `onToggle` FLIPS a row, so only collapsed
   * paths are touched — and clear the query so the tree, not the parked
   * results panel, is what the user sees next.
   */
  // A directory hit OUTSIDE the cwd (a pasted absolute path from the
  // direct-open branch) has no tree rows to expand: the tree is cwd-rooted,
  // and `ancestorDirs` would synthesize cwd-length prefixes of a foreign
  // path that toggle nothing and persist as junk `expanded` entries. Such a
  // row only clears the query.
  const openSearchDir = (rel: string): void => {
    const target = resolveSidebarPath(cwd, rel)
    if (cwd !== undefined && isWithinWorkspace(cwd, target)) {
      for (const path of [...ancestorDirs(cwd, [target]), target]) {
        if (!expanded.includes(path)) onToggle(path)
      }
    }
    setQuery('')
  }

  return (
    <div className={clsx(css.editorTreePanel, full === true && css.editorTreePanelFull)}>
      <div className={css.editorTreeSearch}>
        <input
          className={css.editorSearchInput}
          value={query}
          placeholder={t('editorSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value
            setQuery(next)
            // Typing a name query retires the content search (the reverse
            // direction lives in runContentSearch): one results surface.
            if (next.trim() !== '' && contentQuery !== '') {
              setContentQuery('')
              setContentDraft('')
            }
          }}
        />
        <IconButton
          label={t('refresh')}
          icon={<IconRefreshOutlineRegular size={14} />}
          onClick={() => { setRefreshTick(tick => tick + 1) }}
        />
        {/* Row order: the two keys are one choice (check mark), the
            folders-first switch is independent — the same two-group menu the
            host's own menus use. Picking a row closes the menu like every
            other menu in the plugin. */}
        <Menu
          open={sortOpen}
          onClose={() => { setSortOpen(false) }}
          onSelect={(id) => {
            setSort((current) => {
              if (id === 'sort-name') return { ...current, key: 'name' }
              if (id === 'sort-type') return { ...current, key: 'type' }
              return { ...current, dirsFirst: !current.dirsFirst }
            })
            setSortOpen(false)
          }}
          items={[
            { id: 'sort-name', label: t('sortByName'), icon: <IconChevronsUpDownOutlineRegular size={14} /> },
            { id: 'sort-type', label: t('sortByType'), icon: <IconChevronsUpDownOutlineRegular size={14} /> },
            { type: 'separator', id: 'sort-sep' },
            { id: 'sort-folders-first', label: t('sortFoldersFirst') },
          ]}
          selectedIds={[
            sort.key === 'name' ? 'sort-name' : 'sort-type',
            ...(sort.dirsFirst ? ['sort-folders-first'] : []),
          ]}
          align="end"
          compact
          anchor={(
            <IconButton
              label={t('sort')}
              icon={<IconChevronsUpDownOutlineRegular size={14} />}
              onClick={() => { setSortOpen(open => !open) }}
            />
          )}
        />
        <IconButton
          label={t('uploadFiles')}
          icon={<IconUploadOutline16 size={14} />}
          disabled={busy}
          onClick={() => { fileInputRef.current?.click() }}
        />
        <IconButton
          label={t('uploadFolder')}
          icon={<IconFolderOpenRegular size={14} />}
          disabled={busy}
          onClick={() => { folderInputRef.current?.click() }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(event) => {
            if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          {...folderInputProps}
          style={{ display: 'none' }}
          onChange={(event) => {
            if (cwd !== undefined) startUpload(cwd, uploadItemsFromFiles(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      {/* Content search entry: a permanent row under the name search box,
          collapsed by default. Expanding reveals the keyword input (Enter
          runs) plus the include/exclude chip lists; collapsing clears the
          query so the tree shows through again. */}
      <button
        type="button"
        className={css.contentSearchToggle}
        aria-expanded={contentOpen}
        data-dsh-content-search-toggle={contentOpen ? 'open' : 'closed'}
        onClick={toggleContentOpen}
      >
        <IconContentSearchOutline16 size={14} />
        <span className={css.contentSearchToggleLabel}>{t('contentSearchToggle')}</span>
        <IconChevronDownOutlineRegular size={14} className={clsx(css.contentSearchCaret, contentOpen && css.contentSearchCaretOpen)} />
      </button>
      {contentOpen && (
        <div className={css.contentSearchPanel} data-dsh-content-search-panel="true">
          <input
            className={css.contentSearchInput}
            value={contentDraft}
            placeholder={t('contentSearchQueryPlaceholder')}
            spellCheck={false}
            onChange={(event) => { setContentDraft(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runContentSearch()
              }
            }}
          />
          <div className={css.contentSearchGroup}>
            <input
              className={css.contentSearchInput}
              value={includeDraft}
              placeholder={t('contentSearchIncludePlaceholder')}
              spellCheck={false}
              onChange={(event) => { setIncludeDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addContentEntry(includeDraft, setIncludeDraft, contentInclude, setContentInclude)
                }
              }}
            />
            {contentInclude.length > 0 && (
              <div className={css.contentChipRow}>
                {contentInclude.map((entry) => (
                  <span key={entry} className={css.contentChip}>
                    {entry}
                    <button
                      type="button"
                      className={css.contentChipRemove}
                      aria-label={t('contentSearchRemove')}
                      title={t('contentSearchRemove')}
                      onClick={() => { setContentInclude(contentInclude.filter(item => item !== entry)) }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className={css.contentSearchGroup}>
            <input
              className={css.contentSearchInput}
              value={excludeDraft}
              placeholder={t('contentSearchExcludePlaceholder')}
              spellCheck={false}
              onChange={(event) => { setExcludeDraft(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addContentEntry(excludeDraft, setExcludeDraft, contentExclude, setContentExclude)
                }
              }}
            />
            {contentExclude.length > 0 && (
              <div className={css.contentChipRow}>
                {contentExclude.map((entry) => (
                  <span key={entry} className={css.contentChip}>
                    {entry}
                    <button
                      type="button"
                      className={css.contentChipRemove}
                      aria-label={t('contentSearchRemove')}
                      title={t('contentSearchRemove')}
                      onClick={() => { setContentExclude(contentExclude.filter(item => item !== entry)) }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {uploadStatus !== '' && (
        <div className={clsx(css.editorSearchHint, uploadFailed && css.editorError)} title={uploadStatus}>{uploadStatus}</div>
      )}
      {/* Search results: parked (not unmounted) while no query is live, and
          ONE of the two searches owns the region — the name search when its
          box carries text, else the content search. Its contents render only
          for a live query — a parked panel must not put state text (the
          loading line) into the panel's DOM. */}
      <div
        className={clsx(css.explorerBody, !searching && css.explorerHiddenPane)}
        hidden={!searching}
      >
        {nameActive && (
          <>
            {error !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{error}</div>}
            {error === null && results === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
            {error === null && results !== null && results.matches.length === 0 && (
              <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
            )}
            {error === null && results !== null && results.matches.map((rel) => {
              const isDirHit = dirHits.has(rel)
              return (
                <button
                  key={rel}
                  type="button"
                  className={clsx(css.editorSearchResult, isDirHit && css.editorSearchResultDir)}
                  title={rel}
                  data-dsh-search-dir={isDirHit ? 'true' : undefined}
                  onClick={() => {
                    if (isDirHit) openSearchDir(rel)
                    else onOpenFile(resolveSidebarPath(cwd, rel))
                  }}
                >
                  {isDirHit && <IconFolderOpenRegular size={14} />}
                  <span className={css.editorSearchResultLabel}>{rel}</span>
                </button>
              )
            })}
            {error === null && results?.truncated === true && (
              <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
            )}
          </>
        )}
        {contentActive && (
          <>
            {contentError !== null && <div className={clsx(css.editorSearchHint, css.editorError)}>{contentError}</div>}
            {contentError === null && contentResults === null && <div className={css.editorSearchHint}>{t('loading')}</div>}
            {contentError === null && contentResults !== null && contentResults.matches.length === 0 && (
              <div className={css.editorSearchHint}>{t('editorSearchNoResults')}</div>
            )}
            {/* Content hits are FILES only (a directory has no content to
                search), so every row opens like a name-search file row. */}
            {contentError === null && contentResults !== null && contentResults.matches.map((rel) => (
              <button
                key={rel}
                type="button"
                className={css.editorSearchResult}
                title={rel}
                onClick={() => onOpenFile(resolveSidebarPath(cwd, rel))}
              >
                <span className={css.editorSearchResultLabel}>{rel}</span>
              </button>
            ))}
            {contentError === null && contentResults?.truncated === true && (
              <div className={css.editorSearchHint}>{t('editorSearchTruncated')}</div>
            )}
          </>
        )}
      </div>
      {/* The tree stays MOUNTED while searching: its level cache and the
          directory watcher survive a query, so clearing the box is free. */}
      <FileTree
        sessionId={sessionId}
        cwd={cwd}
        expanded={expanded}
        revealed={revealed}
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        onOpenFileNewTab={onOpenFileNewTab}
        onOpenFileSide={onOpenFileSide}
        openInApp={openInApp}
        openWithTargets={openWithTargets}
        openWithPinned={openWithPinned}
        openWithSsh={openWithSsh}
        onOpenWith={onOpenWith}
        onToggleOpenWithPin={onToggleOpenWithPin}
        openWithShowPluginTargets={openWithShowPluginTargets}
        exclude={exclude}
        onReferenceFile={onReferenceFile}
        onPathRenamed={onPathRenamed}
        onPathDeleted={onPathDeleted}
        refreshTick={refreshTick}
        onUploadRequest={startUpload}
        busy={busy}
        hidden={searching}
        visible={visible !== false}
        sort={sort}
        service={service}
      />
      {upload !== null && (
        <UploadOverlay
          dir={upload.dir}
          done={upload.done}
          total={upload.total}
          current={upload.current}
          onCancel={cancelUpload}
          cancelling={cancelling}
        />
      )}
    </div>
  )
}
