/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory; a stale response is dropped by generation guard + abort),
 * directories sort first, hidden entries render dimmed. The expansion set
 * lives in the per-session state (owned by the caller); the caller also owns
 * the refresh affordance — a `refreshTick` bump wipes the level cache so the
 * visible set reloads. Chains of dirs holding exactly one real dir child each
 * fold into one breadcrumb row (`a/b/c`, VSCode "compact folders"); clicking
 * the row toggles the whole chain. Every breadcrumb SEGMENT is also its own
 * interaction unit: hovering highlights and underlines just that segment
 * (tooltip = the segment's full path), clicking a middle segment reveals that
 * directory in the tree (ancestors expand, it is selected, the fold breaks at
 * it so the row shows `a/b` with `b/c` below), and right-clicking a segment
 * opens the folder menu for that segment's path. The last segment keeps the
 * row's own click/menu behavior.
 *
 * Selection (VS Code semantics, no modifier = the old click semantics
 * untouched): Ctrl/Cmd+click toggles a row and sets the anchor, Shift+click
 * selects the visible range from the anchor (in the tree's own row order —
 * `sort` included), Escape / a blank click clears,
 * right-clicking outside the selection collapses it onto the row. A non-empty
 * selection shows the batch bar above the root row (copy paths / delete /
 * clear); the batch delete confirms once and removes sequentially.
 *
 * Git ink: rows read the shared `useGitStatus` store (the changes page reads
 * the same snapshot) — a changed file's name takes its tone and a letter
 * badge, a directory with a change below it is tinted without a letter, and a
 * non-repo silently renders plain. On top of that ink, rows can carry
 * TortoiseGit-style status badges: a ~9px circular overlay pinned to the
 * file icon's lower-right (green ✓ for a tracked clean path, the colored
 * `!`/`✕`/`+`/`⇄`/`?` vocabulary otherwise; directories show their subtree's
 * WORST tone). The badges are one setting (`explorerGitBadges`, default on);
 * off, they vanish entirely and the tree renders exactly as before. Every
 * mark reaches its memoized row as a PRIMITIVE string (`gitMark` /
 * `gitDirMark`) — the same rule that keeps the store's per-poll objects out
 * of the row props.
 *
 * Row actions: hovering a row reveals an @-reference button on the far right
 * (appends `@<relative path>` to the composer draft), and right-click opens a
 * context menu: file rows offer the caller's open escapes (new tab / to the
 * side, only when the callbacks exist), the host's "open in app" section and
 * a download action (the host serves raw bytes, binary-safe); directory rows
 * offer "upload here", "new folder" and "new file" (an inline editor at the
 * top of that level; the two creators are mutually exclusive); every row can
 * copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write), and every
 * row offers「添加到搜索中」— a submenu reporting this row to the caller
 * (when it provides `onAddToSearch`): the row lands as a prefilled chip on a
 * NEW search tab (the content search's own page; fill ≠ run). Every row but
 * the workspace root also gets
 * 「查看 Git 历史」— the changes tab's git lens, handed the row's path as its
 * history filter (a directory pathspec covers its whole subtree).
 *
 * Directory rows offer 「打开终端」: a fresh bottom-terminal instance (its
 * own tab and PTY — never the running shell) that `cd`s into the row once
 * the shell is writable (when the caller provides `onOpenTerminalAt`).
 *
 * Clipboard (Windows file-manager semantics): 复制 / 剪切 take the WHOLE
 * current selection (right-clicking outside it first collapses the selection
 * onto the row) into the page-wide clipboard (tree-clipboard.ts — one
 * clipboard shared by every tree instance); cut rows render dimmed. 黏贴
 * lands in the right-clicked directory (a file row pastes into its parent,
 * the root row into the workspace root) and is disabled while the clipboard
 * is empty or from another workspace. Before any bytes move, the target
 * level is listed once: same-named entries open the Windows-style dialog —
 * 替换 (overwrite) / 跳过 (keep them, paste the rest) / 取消. The paste
 * itself is an async HOST job (`fs.transfer`) with a top-right progress
 * card (transfer-client.ts + TransferToast.tsx); a cut-paste clears the
 * clipboard once the job is ACCEPTED, and every moved row retargets the
 * open tabs through `onPathMoved` (the caller wires retargetPathTabs).
 *
 * Rows are memoized components (FileRow / DirRow) fed by stable callbacks and
 * per-row booleans, so a copy flash, a drag target or a selection change only
 * re-renders the rows it touches — not the whole tree.
 *
 * Uploads start here (drag-drop or the context menu picker) but run in the
 * caller: every request is reported through `onUploadRequest(dir, items)`
 * (VSCode semantics — a drop on a file row targets its parent directory),
 * and `busy` gates new drags while one upload is in flight.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Button, IconArchiveOutlineRegular, IconChevronRightOutlineRegular, IconClockOutlineRegular, IconCloseFillRegular, IconCloseOutlineRegular, IconCodeOutlineRegular, IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconEditOutlineRegular, IconFolderOpenRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular,
  Menu, Modal, type MenuEntry, type MenuItem, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SiCursor, SiZedindustries } from 'react-icons/si'
import { VscFolderOpened, VscLinkExternal, VscPin, VscPinned, VscTerminal } from 'react-icons/vsc'
import { api, archiveBuild, archiveDownloadUrl, archiveStatus, downloadUrl, SidebarApiError, type FsEntry, type FsLevel } from './api.ts'
import { compactChain, compactLoadTargets } from './file-tree-compact.ts'
import { DEFAULT_FILE_TREE_SORT, sortEntries, type FileTreeSort } from './file-tree-sort.ts'
import { FS_TREES_MAX_PATHS } from '../fs-batch.ts'
import { builtinFileIcon, builtinFolderIcon } from './file-icons.tsx'
import { IconContentSearchOutline16, IconCutOutline16, IconPasteOutline16, IconUploadOutline16, IconVscode16 } from './icons.tsx'
import { isLikelyImeKey } from './ime-guard.ts'
import { useSubmenuFlip } from './menu-flip.ts'
import type { OpenInApp, OpenInAppEntry } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import type { BetterSidebarService } from './service.ts'
import { getTreeClipboard, setTreeClipboard, subscribeTreeClipboard, type TreeClipboardEntry } from './tree-clipboard.ts'
import { startTransfer } from './transfer-client.ts'
import {
  Chip, ConfirmDialog, IconButton, Notice, StatusBadge, useGitStatus,
  type GitTone, type StatusTone,
} from './ui/index.ts'
import { uploadItemsFromDrop, uploadItemsFromFiles, type UploadItem } from './upload.ts'
import { useDirectoryWatch } from './use-dir-watch.ts'
import { useFsJobsWatch } from './fs-jobs-push.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
  /** The host capped this level's listing (a huge directory). */
  truncated?: boolean
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** The containing directory of an absolute row path (never the root edge here). */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? path : path.slice(0, at)
}

/** A direct child path of one tree level (row paths may use either separator;
 *  node:fs accepts the mixed form on Windows, where this runs). */
export function joinChild(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, '')}/${name}`
}

/** Client-side collision guard for the inline new-file editor: the typed name
 *  must not already be taken in the level being edited. The SERVER refuses a
 *  taken destination too — this is the same rule answered from the rows the
 *  user is looking at, so the refusal arrives before a round trip (and on a
 *  level whose listing is stale the server still has the last word).
 *  Case-insensitive: the primary platforms (Windows/macOS) resolve names
 *  that way, and on case-sensitive ones a refusal is merely conservative. */
export function nameTaken(entries: readonly { name: string }[] | undefined, name: string): boolean {
  if (entries === undefined) return false
  const want = name.toLowerCase()
  return entries.some((entry) => entry.name.toLowerCase() === want)
}

/** Only OS file drags belong to the upload surface; in-app drags (tab reorder,
 *  split zones) must pass through untouched to the pane's tab-drop handling
 *  (mirror of Sidebar.tsx's panel-host shield gate). */
function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** One changed row's tooltip word (the badge's status vocabulary). */
function gitToneLabel(tone: GitTone): string {
  switch (tone) {
    case 'added': return t('gitStatusAdded')
    case 'deleted': return t('gitStatusDeleted')
    case 'untracked': return t('gitStatusUntracked')
    case 'renamed': return t('gitStatusRenamed')
    case 'conflict': return t('gitStatusConflict')
    // A copy is an added path from the tree's point of view, and the
    // `gitStatus*` vocabulary has no separate word for it.
    case 'copied': return t('gitStatusAdded')
    case 'modified': return t('gitStatusModified')
  }
}

/** The badge tone for one git tone (the kit has no separate 'copied' ink). */
function badgeToneOf(tone: GitTone): StatusTone {
  return tone === 'copied' ? 'added' : tone
}

/**
 * The TortoiseGit-style badge vocabulary a row can carry: a git tone, or one
 * of two specials — `'clean'` (tracked AND unchanged — the signature green ✓)
 * and `'ignored'` (git-ignored: outside the repository's management, the gray
 * ⊘ that keeps `node_modules` from wearing the clean mark .gitignore excluded
 * it from). A primitive string on purpose: it crosses into the memoized rows
 * as a prop, and `React.memo` compares primitives by value, so a status poll
 * that changed nothing re-renders no row at all.
 */
type GitMark = 'clean' | 'ignored' | GitTone

/**
 * The badge's GLYPH, one character per mark (the TortoiseGit overlay words:
 * the green checkmark of a clean tracked path, the red bang of an edit, the
 * blue plus of an addition…). Characters, not SVG: at 9px one stroke reads
 * and a path cannot.
 */
function gitMarkGlyph(mark: GitMark): string {
  switch (mark) {
    case 'clean': return '✓'
    case 'ignored': return '⊘'
    case 'conflict': return '!'
    case 'modified': return '!'
    case 'deleted': return '✕'
    case 'added': return '+'
    case 'renamed': return '⇄'
    case 'copied': return '+'
    case 'untracked': return '?'
  }
}

/**
 * The badge's tooltip word: the changed vocabulary the letter badges already
 * speak (`gitToneLabel`), plus the two new words the overlay adds — "clean"
 * and "ignored".
 */
function gitMarkLabel(mark: GitMark): string {
  if (mark === 'clean') return t('gitStatusClean')
  if (mark === 'ignored') return t('gitStatusIgnored')
  return gitToneLabel(mark)
}

/**
 * The drop overlay's hero art: an arrow rising out of a notched tray
 * (upload zone — the same glyph family as the toolbar's upload icon) and a
 * tilted pair of photo cards (chat zone). Hand-drawn, but every ink is a
 * theme token: the SVG paints `currentColor` and the classes below pick the
 * accent / tint / cut-out inks.
 */
const UploadDropIllustration = () => (
  <svg width="64" height="56" viewBox="0 0 64 56" fill="none" aria-hidden="true">
    <g className={css.uploadDropArtPrimary}>
      <path d="M32 28V11" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M23 20l9-9 9 9" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <path
      className={css.uploadDropArtAccent}
      d="M10 40a4 4 0 0 1 4-4h7l3.2 4.6a5 5 0 0 0 4.1 2.2h7.4a5 5 0 0 0 4.1-2.2L43 36h7a4 4 0 0 1 4 4v2a10 10 0 0 1-10 10H20A10 10 0 0 1 10 42v-2z"
      fill="currentColor"
    />
  </svg>
)

/** The chat zone's art: two tilted photo cards, each with its own
 *  sun-over-mountains motif (the back card carries detail too, so it never
 *  reads as a bare blob). Same token-only rule as the tray above. */
const ChatDropIllustration = () => (
  <svg width="96" height="76" viewBox="0 0 96 76" fill="none" aria-hidden="true">
    <g transform="rotate(-12 24 34)">
      <rect className={css.uploadDropArtAccent} x="6" y="16" width="36" height="36" rx="10" fill="currentColor" />
      <g className={css.uploadDropArtCut}>
        <circle cx="16" cy="27" r="3.5" fill="currentColor" />
        <path d="M11 44l8-9 6 6 4-4 8 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
    <g transform="rotate(8 61 35)">
      <rect className={css.uploadDropArtPrimary} x="40" y="12" width="42" height="46" rx="10" fill="currentColor" />
      <g className={css.uploadDropArtCut}>
        <circle cx="55" cy="27" r="5" fill="currentColor" />
        <path d="M46 50l10-13 7 8 6-6 9 11" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
  </svg>
)

/** The modifier subset row activation needs (clicks and Enter/Space share it). */
interface ActivateModifiers {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * The event shape opening the context menu needs. Structural on purpose: the
 * menu opener is shared by the row `div`s AND the breadcrumb segment `span`s,
 * whose synthetic events carry different `currentTarget` types — only the
 * cursor position and propagation are read.
 */
interface ContextMenuTrigger {
  preventDefault(): void
  stopPropagation(): void
  clientX: number
  clientY: number
}

/**
 * The stable per-row callback bundle. `FileRow` / `DirRow` are memoized, so
 * every handler here must keep its identity for the life of the tree; each
 * one reads the live props/state through the refs the tree maintains.
 */
interface RowActions {
  /**
   * Activate one row. `path` is the row's IDENTITY (the fold chain's head, so
   * selection stays keyed to the rendered row); `chain` — directories only —
   * names the links a plain click toggles, so a folded `a/b/c` row opens and
   * closes as one row instead of only ever toggling its head.
   */
  activate(event: ActivateModifiers, path: string, isDir: boolean, chain?: readonly FsEntry[]): void
  contextMenu(event: ContextMenuTrigger, path: string, isDir: boolean): void
  /**
   * Reveal one MIDDLE segment of a folded breadcrumb row (VSCode's
   * compact-folders click): expand the chain up to and including the segment,
   * select that directory, and break the fold at it — the row then renders
   * `a/b` with the remaining links (`b/c`) as their own row below. `chain` is
   * the chain slice the row renders and `index` the clicked link inside it.
   */
  revealSegment(event: ActivateModifiers, chain: readonly FsEntry[], index: number): void
  reference(path: string, isDir: boolean): void
  dragOver(event: DragEvent<HTMLDivElement>, dir: string): void
  drop(event: DragEvent<HTMLDivElement>, path: string, isDir: boolean): void
}

/** One open-in-app entry's leading glyph: the host's icon route / data URL,
 *  or a generic mark when the host has no icon for it. */
function AppGlyph(props: { entry: OpenInAppEntry }): ReactNode {
  const { icon } = props.entry
  if (icon === null || icon === '') return <IconCodeOutlineRegular size={14} />
  return <img className={css.explorerAppIcon} src={icon} alt="" width={14} height={14} />
}

/** One file row's props. Everything is a primitive or a stable reference so
 *  memo() actually bails out. */
interface FileRowProps {
  entry: FsEntry
  depth: number
  /** Registry revision: a fresh value re-resolves the row's icon. */
  iconsVersion: number
  service: BetterSidebarService | undefined
  selected: boolean
  revealed: boolean
  /**
   * The one-shot reveal-flash class for THIS reveal round (undefined = no
   * flash): FileTree alternates the class on every fresh reveal so the CSS
   * animation restarts (a same-name replay would not run again). A primitive
   * like the other row props, so memo() still bails out.
   */
  flash: string | undefined
  /** A drag hovers this row's PARENT directory (upload target). */
  dropTarget: boolean
  copied: boolean
  /** The row is on the clipboard as a CUT (dimmed until pasted or replaced). */
  cut: boolean
  /**
   * The row's git state as PRIMITIVES, never the store's status object: the
   * shared store rebuilds its per-path objects on every poll, so passing the
   * object would re-render every changed row every 2.5s (`React.memo` compares
   * by reference) — exactly the "frequent refresh" the file list was reported
   * for. Two strings make the poll invisible to the rows.
   */
  gitTone: GitTone | undefined
  gitLetter: string | undefined
  /**
   * The TortoiseGit-style overlay mark (`'clean'` or the tone), or undefined
   * for "paint nothing" (badges off, non-repo, loading, truncated status, or
   * a path outside the repository root). A primitive like the pair above —
   * the same memo-by-value reasoning.
   */
  gitMark: GitMark | undefined
  actions: RowActions
}

const FileRow = memo(function FileRow(props: FileRowProps): ReactNode {
  const { entry, depth, iconsVersion, service, selected, revealed, flash, dropTarget, copied, cut, gitTone, gitLetter, gitMark, actions } = props
  // Referenced so a registry change re-renders the row with its new icon.
  void iconsVersion
  const icon = service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx(
        css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken,
        selected && css.explorerRowSelected,
        dropTarget && css.explorerRowDropTarget,
        revealed && css.explorerRowRevealed,
        cut && css.explorerRowCut,
        flash,
      )}
      data-dsh-revealed={revealed ? 'true' : undefined}
      data-dsh-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      style={{ paddingLeft: depth * 22 + 6 }}
      title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
      onClick={(event) => { actions.activate(event, entry.path, false) }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.activate(event, entry.path, false)
        }
      }}
      onDragOver={(event) => { actions.dragOver(event, parentOf(entry.path)) }}
      onDrop={(event) => { actions.drop(event, entry.path, false) }}
      onContextMenu={(event) => { actions.contextMenu(event, entry.path, false) }}
    >
      {/* The glyph rides in a positioning wrapper so the overlay badge can
          pin to its lower-right without touching the row's flex layout (the
          wrapper is exactly the icon's box — see `.explorerIcon`). */}
      <span className={css.explorerIcon}>
        {icon}
        {gitMark !== undefined && (
          <span className={css.explorerGitMark} data-mark={gitMark} title={gitMarkLabel(gitMark)}>
            {gitMarkGlyph(gitMark)}
          </span>
        )}
      </span>
      <span className={clsx(css.explorerName, gitTone !== undefined && css.explorerGitName)} data-git-tone={gitTone}>
        {entry.name}
      </span>
      {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
      {gitTone !== undefined && gitLetter !== undefined && (
        <StatusBadge tone={badgeToneOf(gitTone)} title={gitToneLabel(gitTone)}>{gitLetter}</StatusBadge>
      )}
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(entry.path, false)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

/** One directory row's props (same stability rules as {@link FileRowProps}). */
interface DirRowProps {
  entry: FsEntry
  /**
   * The fold chain this row renders: `[entry]` for an ordinary directory, or
   * the singleton-dir breadcrumb (`a` → `a/b` → `a/b/c`) VSCode calls
   * "compact folders" — or a PREFIX of one after a breadcrumb-segment reveal
   * broke the fold (the tree passes the chain slice this row now shows). The
   * array identity is stable while the level cache stands (see the chain
   * cache in the tree body), so memo() still bails out.
   */
  chain: readonly FsEntry[]
  depth: number
  expanded: boolean
  iconsVersion: number
  service: BetterSidebarService | undefined
  selected: boolean
  revealed: boolean
  dropTarget: boolean
  /** A change exists at or below this directory (tinted, never lettered). */
  gitChanged: boolean
  /**
   * The TortoiseGit-style overlay mark for this directory: its SUBTREE's
   * worst tone, or `'clean'` under the same rules as {@link FileRowProps}.
   * `gitMark`'s primitive (a string) so the memo survives idle polls.
   */
  gitDirMark: GitMark | undefined
  copied: boolean
  /** The row is on the clipboard as a CUT (dimmed until pasted or replaced). */
  cut: boolean
  actions: RowActions
}

const DirRow = memo(function DirRow(props: DirRowProps): ReactNode {
  const { entry, chain, depth, expanded, iconsVersion, service, selected, revealed, dropTarget, gitChanged, gitDirMark, copied, cut, actions } = props
  void iconsVersion
  // The row's ACTIONS target the chain's deepest RENDERED link: that is the
  // directory the user sees expanded (`a/b/c`, or `a/b` after a segment
  // reveal broke the fold), so dropping into it, renaming it or opening a
  // menu on it must address that link, not the fold head `a`.
  const target = chain[chain.length - 1]!
  const icon = service !== undefined ? service.folderIcon(target.path, expanded, 14) : builtinFolderIcon(expanded, 14)
  /**
   * The breadcrumb label. A multi-link chain renders EVERY segment as its own
   * interactive unit (VSCode's compact folders): hovering a segment highlights
   * and underlines just that segment (the row's hover fill keeps painting the
   * whole line), each segment's native tooltip names its full path, clicking a
   * middle segment reveals that directory in the tree (expand ancestors +
   * select + the fold breaks there), clicking the LAST segment is the row's
   * own toggle, and right-clicking any segment opens the folder menu for that
   * segment's path. All of it stops propagation — the row's own handlers (the
   * whole-chain toggle and the tail's menu) must not fire from a segment.
   */
  const breadcrumb = chain.length > 1
    ? chain.map((link, index) => (
      <Fragment key={link.path}>
        {index > 0 ? '/' : null}
        <span
          className={css.explorerSegment}
          title={link.path}
          onClick={(event) => {
            event.stopPropagation()
            // The last segment IS the row's tail: it keeps the row's own
            // behavior (toggle the chain it renders). Modifier clicks stay
            // row-shaped too — multi-select operates on rows, not segments.
            if (index === chain.length - 1 || event.ctrlKey || event.metaKey || event.shiftKey) {
              actions.activate(event, entry.path, true, chain)
              return
            }
            actions.revealSegment(event, chain, index)
          }}
          onContextMenu={(event) => {
            // The folder menu for THIS segment's path (the tail segment
            // reproduces the row's own menu exactly).
            event.preventDefault()
            event.stopPropagation()
            actions.contextMenu(event, link.path, link.isDir)
          }}
        >
          {link.name}
        </span>
      </Fragment>
    ))
    : entry.name
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx(
        css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden,
        selected && css.explorerRowSelected,
        dropTarget && css.explorerRowDropTarget,
        revealed && css.explorerRowRevealed,
        cut && css.explorerRowCut,
      )}
      data-dsh-revealed={revealed ? 'true' : undefined}
      data-dsh-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      style={{ paddingLeft: depth * 22 + 6 }}
      // A folded row renders the whole chain (`a/b/c`) and a plain click
      // toggles every link at once, so the breadcrumb opens and closes as one.
      // EVERY directory row carries its full path here — a single-segment row
      // is truncated by the label's ellipsis exactly like the breadcrumb, and
      // the body never scrolls horizontally, so the tooltip is the only way to
      // read a deep path (the same affordance `FileRow` gives a file). Each
      // SEGMENT span carries its own title on top: the path of the link the
      // pointer is actually over.
      title={target.path}
      onClick={(event) => { actions.activate(event, entry.path, true, chain) }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.activate(event, entry.path, true, chain)
        }
      }}
      onDragOver={(event) => { actions.dragOver(event, target.path) }}
      onDrop={(event) => { actions.drop(event, target.path, true) }}
      onContextMenu={(event) => { actions.contextMenu(event, target.path, true) }}
    >
      {/* Same positioning wrapper + overlay badge as a file row — the folder
          glyph carries its subtree's worst tone. */}
      <span className={css.explorerIcon}>
        {icon}
        {gitDirMark !== undefined && (
          <span className={css.explorerGitMark} data-mark={gitDirMark} title={gitMarkLabel(gitDirMark)}>
            {gitMarkGlyph(gitDirMark)}
          </span>
        )}
      </span>
      <span className={clsx(css.explorerName, gitChanged && css.explorerDirChanged)}>
        {breadcrumb}
      </span>
      {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(target.path, true)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

/**
 * The workspace ROOT row (the session's own folder). Memoized like the other
 * rows: it has no name/selection churn, so a parent re-render (menu state, copy
 * flash, apps) must not re-resolve its glyph either.
 */
interface RootRowProps {
  path: string
  iconsVersion: number
  service: BetterSidebarService | undefined
  /** A drag hovers the workspace root (drop target). */
  dropTarget: boolean
  /** A change exists at or below the root (tinted). */
  gitChanged: boolean
  /** The root's overlay mark — the whole workspace subtree's worst tone (or
   *  its green ✓). Same primitive rule as every row's mark. */
  gitDirMark: GitMark | undefined
  copied: boolean
  actions: RowActions
}

const RootRow = memo(function RootRow(props: RootRowProps): ReactNode {
  const { path, iconsVersion, service, dropTarget, gitChanged, gitDirMark, copied, actions } = props
  void iconsVersion
  const icon = service !== undefined ? service.folderIcon(path, true, 14) : builtinFolderIcon(true, 14)
  return (
    <div
      className={clsx(css.explorerRow, dropTarget && css.explorerRowDropTarget)}
      style={{ paddingLeft: 6 }}
      // The root row prints only the workspace folder's BASENAME, so it needs
      // the full path on hover like every other row.
      title={path}
      onDragOver={(event) => { actions.dragOver(event, path) }}
      onDrop={(event) => { actions.drop(event, path, true) }}
      onContextMenu={(event) => { actions.contextMenu(event, path, true) }}
    >
      {/* The root's glyph, wrapped and badged exactly like a directory row. */}
      <span className={css.explorerIcon}>
        {icon}
        {gitDirMark !== undefined && (
          <span className={css.explorerGitMark} data-mark={gitDirMark} title={gitMarkLabel(gitDirMark)}>
            {gitMarkGlyph(gitDirMark)}
          </span>
        )}
      </span>
      <span className={clsx(css.explorerName, gitChanged && css.explorerDirChanged)}>{baseName(path)}</span>
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(path, true)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

/**
 * The `(session, cwd)` pair a filesystem request runs under. `cwd` is
 * undefined until the session snapshot resolves — no request may be issued
 * then, which is why that case is `undefined` rather than a half-filled scope.
 */
type FsScope = { sessionId: string; cwd: string }

/** The scope a set of props belongs to (undefined while `cwd` is unresolved). */
function scopeOf(live: { sessionId: string; cwd: string | undefined }): FsScope | undefined {
  return live.cwd === undefined ? undefined : { sessionId: live.sessionId, cwd: live.cwd }
}

/**
 * Whether a scope captured when an action was ARMED is still the one on
 * screen.
 *
 * The workbench REUSES this component across a session swap, so anything the
 * user aimed at in project A (a confirmation, a selection, a drop target) can
 * still be in state while project B is on screen. Clearing that state is the
 * swap effect's job — but an effect is PASSIVE, and a click landing between
 * the swap's commit and that effect reads the stale state while
 * `propsRef.current` already holds the new scope. The request would then carry
 * project B's scope with project A's absolute path, and the host applies it
 * verbatim (containment was removed on purpose): a cross-project delete.
 * Every mutation therefore re-checks the scope it was armed under, AT THE CALL
 * SITE, instead of trusting the effect to have run.
 * @param armed - The scope captured when the action was armed.
 * @param live - The scope the component is rendering for now.
 * @returns True only when both are present and identical.
 */
function sameScope(armed: FsScope | undefined, live: FsScope | undefined): boolean {
  return armed !== undefined && live !== undefined
    && armed.sessionId === live.sessionId && armed.cwd === live.cwd
}

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  /** Files highlighted by a "Show in folder" reveal (absolute paths). */
  revealed: string[]
  /**
   * Dismiss the reveal highlight of the row the reader clicked (the paths to
   * drop from the set). A folded row reports whichever chain links carry the
   * mark. Absent → a click keeps the highlight (older callers unchanged).
   */
  onRevealDismiss?: (paths: readonly string[]) => void
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /**
   * Context-menu 「打开终端」(directory rows; absent → no entry): the caller
   * mints a NEW bottom-terminal instance aimed at the directory — never the
   * running shell cd'd over. It answers `false` (or rejects) when nothing
   * opened (no host terminal service, the page disabled), and the failure
   * lands in the same strip as the host-backed rows instead of only reaching
   * the console (#412 was silence in this exact spot).
   */
  onOpenTerminalAt?: (path: string) => void | boolean | Promise<void | boolean>
  /**
   * Context-menu 「查看 Git 历史」 (every row but the workspace root; absent →
   * no entry): the caller opens the changes tab's git lens with this row's
   * path as its history filter (a file's log, or a directory's whole
   * subtree). It answers `false` (or rejects) when nothing opened, and the
   * failure lands in the same strip as the host-backed rows (#412).
   */
  onOpenGitHistory?: (path: string) => void | boolean | Promise<void | boolean>
  /**
   * The host's open-in-app handle (EditorHost builds it and injects it).
   * Absent, or reporting the host cannot hand paths to the desktop, hides the
   * HOST half of the "打开方式" section (the plugin's own targets stay).
   */
  openInApp?: OpenInApp
  /**
   * The PLUGIN's own "open with" menu: resolved external targets (already
   * SSH-filtered and in menu order). Absent → no plugin half. Coexists with
   * {@link openInApp} — the section lists both.
   */
  openWithTargets?: OpenWithTarget[]
  /** Ids of targets pinned to the menu's top level (subset of the ids). */
  openWithPinned?: string[]
  /** Whether the workspace is remote (appends the SSH hint to target labels). */
  openWithSsh?: boolean
  /** Open one plugin target externally (reveal or URL — the caller decides).
   *  It answers `false` (or rejects) when the hand-off did not happen, and the
   *  strip then reports it exactly like the host-backed rows. */
  onOpenWith?: (targetId: string, path: string) => void | boolean | Promise<void | boolean>
  /** Toggle one plugin target's pinned state (the submenu row's pushpin). */
  onToggleOpenWithPin?: (targetId: string) => void
  /** Insert `@<relative path>` into the composer draft (file vs directory). */
  onReferenceFile: (path: string, isDir: boolean) => void
  /**
   * Context-menu 「添加到搜索中」: this tree only REPORTS the right-clicked
   * row's ABSOLUTE path plus which list the user picked (`include` /
   * `exclude`); the caller (EditorHost, via TreePanel) parks it as a one-shot
   * search-page seed and opens a NEW search tab with the chip prefilled.
   * Absent → the whole submenu is not offered (the same contract as the open
   * escapes).
   */
  onAddToSearch?: (path: string, target: 'include' | 'exclude') => void
  /** The explorerExclude pref patterns: the HOST filters the listing with
   *  them (excluded rows never arrive), so changing the list wipes the level
   *  cache and reloads — the rows themselves need no client-side filter. */
  exclude?: readonly string[]
  /** A rename landed (old row path → new path): the caller retargets open tabs. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** A delete landed: the caller closes tabs at or under the removed path. */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /**
   * A cut-paste moved one row (`from` → `to`): the caller retargets the open
   * tabs exactly like a rename (a directory takes its subtree with it).
   * Copy-pastes announce nothing — the source stays.
   */
  onPathMoved?: (from: string, to: string, isDir: boolean) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** Upload into `dir` (absolute, inside the workspace); runs in the caller. */
  onUploadRequest: (dir: string, items: UploadItem[]) => void
  /** True while an upload is in flight (drops are ignored). */
  busy: boolean
  /**
   * Park the tree out of the layout WITHOUT unmounting it: the search results
   * panel takes the surface while the level cache (and the live watcher) stays
   * warm, so clearing the query is free.
   */
  hidden?: boolean
  /**
   * Whether the owning tab is on screen. Defaults to true; a parked tab
   * passes false so the shared git-status store stops polling for rows
   * nobody can see (the workbench keeps every tab body mounted).
   */
  visible?: boolean
  /**
   * Keep the plugin's own open-with targets in the "打开方式" submenu even when
   * the host reports local applications for the path. Default (false): the
   * host's own list wins, and the plugin's fixed targets (file manager /
   * VS Code / Cursor / Zed / custom editors) show only when the host cannot
   * offer any — so the menu is not two near-identical lists. The caller reads
   * the `openWithPluginTargets` plugin setting and passes it down.
   */
  openWithShowPluginTargets?: boolean
  /**
   * Whether rows paint TortoiseGit-style status badges (the editor card's
   * `explorerGitBadges` toggle, read reactively by the caller). Default true;
   * false renders exactly the pre-badge tree — the computed marks short-
   * circuit to undefined, so not one row re-renders for the flag until it
   * flips.
   */
  gitBadges?: boolean
  /**
   * The explorer's row order (the header control's choice). Absent → the
   * server's own order, which {@link DEFAULT_FILE_TREE_SORT} reproduces, so an
   * older caller renders exactly what it rendered before the control existed.
   */
  sort?: FileTreeSort
  /**
   * The sidebar registry service: when present, externally registered file
   * icons (`registerFileIcon`) outrank the host's file-type artwork on file rows.
   * Absent → the built-ins alone (the host always passes it today).
   */
  service?: BetterSidebarService
}) {
  // `onToggle` / `onOpenFile` are read through `propsRef` (the stable row
  // callbacks must not change identity when the caller re-renders).
  // `onReferenceFile` is read through `propsRef` like the other row callbacks.
  const {
    sessionId, cwd, expanded, revealed, onOpenFileNewTab, onOpenFileSide, onOpenTerminalAt, onOpenGitHistory,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    openWithShowPluginTargets, exclude, onAddToSearch,
    onPathRenamed, onPathDeleted, refreshTick, onUploadRequest, busy, hidden, visible, service,
  } = props
  const sort = props.sort ?? DEFAULT_FILE_TREE_SORT
  const gitBadges = props.gitBadges !== false
  /** The live props for the stable callbacks below (identity churns per render). */
  const propsRef = useRef(props)
  propsRef.current = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  /**
   * Registry revision for the file-icon feature: bumps on ANY registry
   * change (register/dispose of tabs, viewers, or icons — one listener
   * set) so rows re-resolve their icons. Handed to the memoized rows as a
   * prop precisely so the bump reaches them.
   */
  const [iconsVersion, setIconsVersion] = useState(0)
  useEffect(
    () => service?.subscribe(() => { setIconsVersion(version => version + 1) }),
    [service],
  )
  /** One directory's leading glyph for the surfaces WITHOUT a memoized row
   *  (the inline rename and new-folder editors). */
  const dirRowIcon = (path: string, open: boolean): ReactNode =>
    service !== undefined ? service.folderIcon(path, open, 14) : builtinFolderIcon(open, 14)
  const dataRef = useRef(data)
  /** Bumped whenever the cache is wiped: a response from an older generation is dropped. */
  const generationRef = useRef(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /**
   * Bumped on every FRESH reveal (see the effect by the reveal scroll): the
   * counter's parity picks between two interchangeable flash classes, so a
   * replay changes the row's animation-name and the CSS animation restarts.
   * 0 = this tree instance has not seen a reveal yet (no flash).
   */
  const [flashSeq, setFlashSeq] = useState(0)
  /**
   * Where a folded breadcrumb row's fold is BROKEN by a segment reveal
   * (VSCode's compact folders): the path of the chain link a breadcrumb
   * segment click revealed, so the row renders `a/b` and the remaining links
   * (`b/c`) drop to their own row below. Derived state would be wrong here —
   * a pre-fold expansion of the head alone must NOT split the row (the whole
   * chain stays one row, see the fold spec), so the break exists only where a
   * segment click put it. Cleared when its row collapses (the fold re-forms)
   * and on a session/cwd swap; a structure change that loses the path leaves
   * it inert (no chain contains it, so nothing splits).
   */
  const [foldBreak, setFoldBreakState] = useState<string | null>(null)
  /** The break's mirror for the stable callbacks (identity never churns). */
  const foldBreakRef = useRef<string | null>(null)
  const setFoldBreak = useCallback((path: string | null): void => {
    foldBreakRef.current = path
    setFoldBreakState(path)
  }, [])
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  // The plugin submenu can tower past the viewport; publish its flip geometry
  // for layout.css while the row menu is open.
  useSubmenuFlip(rowMenu)
  /** The open-in-app rows for the open menu (null entries = listing failed). */
  const [apps, setApps] = useState<{ path: string; entries: readonly OpenInAppEntry[] | null } | null>(null)
  /** The row being renamed inline: its path plus the edit buffer. */
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  /** The inline new-folder editor: the directory it inserts into plus the buffer. */
  const [newFolder, setNewFolder] = useState<{ dir: string; value: string } | null>(null)
  /** The inline new-file editor: the directory it inserts into plus the buffer. */
  const [newFile, setNewFile] = useState<{ dir: string; value: string } | null>(null)
  /**
   * The delete awaiting the confirmation modal's yes (single row), plus the
   * scope it was ARMED under — see {@link sameScope}: the confirmation can
   * outlive the project it was opened in, and the scope captured here is what
   * keeps the request from landing in the next one.
   */
  const [confirmDelete, setConfirmDelete] =
    useState<{ path: string; isDir: boolean; name: string; scope: FsScope } | null>(null)
  /** The batch delete awaiting the confirmation modal's yes (plus its armed scope). */
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState<FsScope | null>(null)
  /** True while the batch delete walks its paths (locks the dialog). */
  const [deletingSelected, setDeletingSelected] = useState(false)
  /** The last mutation failure (dismissable strip above the tree). */
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * The page-wide clipboard mirror (tree-clipboard.ts): 复制/剪切 write it,
   * 黏贴 reads it, and the cut rows dim off the mirror. useSyncExternalStore
   * would re-render on EVERY external write; a plain subscription keeps the
   * re-render local to the trees that show a clipboard at all (same
   * shape as the shared git-status store's usage below).
   */
  const [clipboard, setClipboard] = useState<{ cwd: string; mode: 'copy' | 'cut'; entries: readonly TreeClipboardEntry[] } | null>(() => getTreeClipboard())
  useEffect(() => subscribeTreeClipboard(() => { setClipboard(getTreeClipboard()) }), [])
  /**
   * The Windows-style paste-conflict dialog: the batch (already filtered of
   * self-contains), the target directory, and the target level's same-named
   * entries. Open only when the pre-paste listing found conflicts — a clean
   * paste starts the transfer straight away.
   */
  const [pasteDialog, setPasteDialog] = useState<{
    scope: FsScope
    mode: 'copy' | 'cut'
    entries: readonly TreeClipboardEntry[]
    targetDir: string
    conflicts: readonly string[]
  } | null>(null)
  /** A failed re-list that kept the previous rows on screen (hint line). */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The multi-selection (absolute paths) and its Shift anchor. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  /** Whether a dragged-over state exists at all (drives the portaled drop zone). */
  const [dropOver, setDropOver] = useState(false)
  /** The directory a drag is hovering right now (null = body, drop to root). */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * Enter/leave depth under the tree body. dragenter/dragleave fire per
   * element along the drag path (and bubble), so a counter — DSH InputBar's
   * own pattern — is the flicker-free signal; relatedTarget is unreliable
   * across engines for drag events.
   */
  const dropDepth = useRef(0)
  /** Explorer body element; its viewport rect anchors the portaled drop zone. */
  const bodyRef = useRef<HTMLDivElement>(null)
  /** The body's viewport rect captured at drag entry (null = not measured). */
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  /** Context-menu "upload here" target directory. */
  const pendingUploadDir = useRef<string | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Reset all drag state (drop landed, the drag left, or a new drag begins). */
  const resetDrop = useCallback((): void => {
    dropDepth.current = 0
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }, [])

  /**
   * Drop handlers: always swallow the event (a dropped file must never open
   * in the browser), then report the target directory to the caller. A drop
   * ends the drag without further leave events, so the depth resets here.
   * The payload collection is async (dropped folders are traversed through
   * their entry handles — captured synchronously inside uploadItemsFromDrop
   * while the dataTransfer is still live), so the request rides a then.
   */
  const reportDrop = useCallback((dir: string, transfer: DataTransfer | undefined): void => {
    if (propsRef.current.busy) return
    // The traversal below is async, so the target directory is resolved
    // against the scope that STARTED the drop, and the delivery is dropped
    // outright if a session swap landed in between: `onUploadRequest` is read
    // off the LATEST props, so without this the files would be uploaded into
    // the next project's tree, at a directory path from this one.
    const armed = scopeOf(propsRef.current)
    void uploadItemsFromDrop(transfer).then((items) => {
      if (items.length === 0 || !sameScope(armed, scopeOf(propsRef.current))) return
      propsRef.current.onUploadRequest(dir, items)
    })
  }, [])
  const handleBodyDrop = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    const root = propsRef.current.cwd
    if (root !== undefined) reportDrop(root, event.dataTransfer)
  }, [reportDrop, resetDrop])
  const handleDirDrop = useCallback((event: DragEvent<HTMLDivElement>, dir: string): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    reportDrop(dir, event.dataTransfer)
  }, [reportDrop, resetDrop])
  const handleBodyDragEnter = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dropDepth.current += 1
    if (propsRef.current.busy) return
    // First entry: anchor the portaled drop zone to the body's rect.
    if (dropDepth.current === 1) {
      const rect = bodyRef.current?.getBoundingClientRect()
      setDropRect(rect === undefined ? null : { top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    setDropOver(true)
  }, [])
  const handleBodyDragLeave = useCallback((): void => {
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current > 0) return
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }, [])
  const handleBodyDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = propsRef.current.busy ? 'none' : 'copy'
    if (propsRef.current.busy) return
    // Rows stop propagation, so this only fires over non-row regions: the
    // drag targets the workspace root. dragover fires continuously, making
    // it the authoritative (flicker-free) place to clear the row target.
    setDropTarget(null)
  }, [])
  const handleRowDragOver = useCallback((event: DragEvent<HTMLDivElement>, dir: string): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = propsRef.current.busy ? 'none' : 'copy'
    if (propsRef.current.busy) return
    setDropTarget(dir)
  }, [])
  /** A row drop: a directory targets itself, a file its parent (VSCode semantics). */
  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>, path: string, isDir: boolean): void => {
    handleDirDrop(event, isDir ? path : parentOf(path))
  }, [handleDirDrop])

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  /**
   * Which in-flight request owns each `{}` placeholder in the level cache.
   *
   * The placeholder is the tree's "Loading…" state for a level, and only the
   * call that wrote it may settle it. Without this bookkeeping a DROPPED answer
   * (the generation guard in `loadLevels`) left the placeholder behind forever:
   * every later load treats a cached level as loaded — the empty `{}` marker
   * included — so the level was never re-requested and that subtree sat on its
   * loading row for the rest of the mount. Reproduced locally 2026-10-12 (the
   * drop path fires on a refresh tick, an exclude change and unmount), and the
   * shape matches the same day's CI failure: the listing answers arrived,
   * `names=[]`, and no row rendered even 5s later.
   */
  const pendingRef = useRef(new Map<string, number>())

  /**
   * Drop the `{}` placeholders `generation` still owns, so the levels they cover
   * become retryable again. Levels that already carry a listing (or an error)
   * are left alone — a dropped answer must not blank rows that are on screen.
   * @returns the paths actually released (empty when nothing was left pending).
   */
  const releasePlaceholders = useCallback((generation: number, paths: readonly string[]): string[] => {
    const released: string[] = []
    let next: Record<string, LevelData> | null = null
    for (const path of paths) {
      if (pendingRef.current.get(path) !== generation) continue
      pendingRef.current.delete(path)
      const level = dataRef.current[path]
      if (level === undefined || level.entries !== undefined || level.error !== undefined) continue
      next = { ...(next ?? dataRef.current) }
      delete next[path]
      released.push(path)
    }
    if (next === null) return released
    dataRef.current = next
    setData(next)
    return released
  }, [])

  /**
   * The exclude list by VALUE. The caller owns the array identity (the prefs
   * store hands out one stable reference per document), but the level cache,
   * the request payload and the reload effect all key on the CONTENT: a
   * value-equal list that churned identity would otherwise re-list the whole
   * tree on every render. Declared here because `loadLevels` below reads it.
   */
  const excludeKey = (exclude ?? []).join('\0')

  /**
   * List a SET of directories into the cache with ONE `fs.trees` request.
   *
   * The visible set (the workspace root plus every expanded directory) is
   * always loaded this way, so mounting the tree, a refresh tick and expanding
   * a directory each cost exactly one POST — not one per level (the N+1 the
   * file list was reported for). Levels already loaded (including the empty
   * placeholder of an in-flight fetch) are left alone, so an expand only asks
   * for what is genuinely missing — but only a LISTING settles a level: a
   * cached failure is asked for again, so one bad read does not stick for the
   * rest of the mount. A stale response — the cache was wiped by a refresh
   * tick — is dropped instead of overwriting fresher data.
   *
   * A level the host failed to read comes back with its own `error` and is
   * stored on that level alone (the other levels render normally). When the
   * WHOLE request fails, the levels that already had a listing keep it (plus a
   * hint) and only the levels with nothing to show carry the message.
   *
   * `force` re-lists levels even when they are cached — the refresh tick's
   * path — while leaving their current rows untouched until the answer lands.
   */
  const loadLevels = useCallback((paths: readonly string[], options?: { force?: boolean }) => {
    const force = options?.force === true
    const wanted = force
      ? [...new Set(paths)]
      : paths.filter((path) => {
          // Only a LISTING settles a level: both failure branches below store
          // their error in this same cache, so treating every entry as
          // "already loaded" made one failed read (a host restart, a transient
          // fs error) stick for the rest of the mount — the automatic load
          // path re-ran for the expanded set and skipped the level, and the
          // only ways out were a refresh tick or a remount. An error entry
          // stays retryable; the empty `{}` placeholder of an in-flight load
          // is still a hit (a re-render must not duplicate the open request).
          const cached = dataRef.current[path]
          return cached === undefined || cached.error !== undefined
        })
    if (wanted.length === 0) return
    const generation = generationRef.current
    // A FORCED re-list (a refresh tick) keeps the listing on screen until the
    // fresh one arrives: no blank frame, and a failed refresh degrades to the
    // previous listing plus a hint instead of an empty tree.
    if (!force) for (const path of wanted) { pendingRef.current.set(path, generation); storeLevel(path, {}) }
    // The host rows ONE `fs.trees` request at FS_TREES_MAX_PATHS and refuses a
    // larger one OUTRIGHT (`too many paths`), which used to blank the WHOLE
    // tree for a session whose persisted expansion set reached the cap. Split
    // the visible set into cap-sized batches and keep the per-level error
    // identity the batch route is built around: a batch that fails marks only
    // the levels it carried.
    const batches: string[][] = []
    for (let index = 0; index < wanted.length; index += FS_TREES_MAX_PATHS) {
      batches.push(wanted.slice(index, index + FS_TREES_MAX_PATHS))
    }
    // The route takes no signal: the GENERATION counter is the staleness guard
    // (a refresh tick or an unmount bumps it, so a late answer is dropped).
    // `retried` bounds the self-heal below to one extra request per call.
    let retried = false
    type BatchOutcome =
      | { batch: string[]; ok: true; levels: FsLevel[] }
      | { batch: string[]; ok: false; message: string }
    void Promise.all(batches.map(async (batch): Promise<BatchOutcome> => {
      try {
        return { batch, ok: true, levels: (await api.fsTrees({ sessionId, cwd }, batch, excludeKey === '' ? undefined : excludeKey.split('\0'))).levels }
      } catch (error: unknown) {
        return { batch, ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })).then((settled) => {
      if (generation !== generationRef.current) {
        // The DATA is stale and is dropped — but the `{}` placeholders this call
        // wrote are not stale at all: publishing them away is what keeps a
        // dropped answer from freezing the level on "Loading…" forever (see
        // pendingRef). Release what this call still owns and ask once more, so
        // the drop self-heals instead of waiting for another refresh tick.
        const released = releasePlaceholders(generation, wanted)
        if (released.length > 0 && !retried) {
          retried = true
          loadLevels(released)
        }
        return
      }
      for (const path of wanted) pendingRef.current.delete(path)
      setLoadError(null)
      let failure = ''
      let keptListing = false
      for (const outcome of settled) {
        if (outcome.ok) {
          for (const level of outcome.levels) {
            storeLevel(level.path, {
              entries: level.entries,
              truncated: level.truncated,
              ...(level.error !== undefined ? { error: level.error } : {}),
            })
          }
          continue
        }
        if (failure === '') failure = outcome.message
        for (const path of outcome.batch) {
          const level = dataRef.current[path]
          if (level?.entries !== undefined) {
            keptListing = true
            continue
          }
          storeLevel(path, { error: outcome.message })
        }
      }
      // Levels that had a listing keep it; the hint explains why they are not
      // fresher. With nothing to keep, the per-level rows already say it.
      if (failure !== '') setLoadError(keptListing ? failure : null)
    })
  }, [sessionId, cwd, excludeKey, storeLevel, releasePlaceholders])

  /**
   * Re-list one directory in place (a watch notice, or the parent of a landed
   * mutation).
   *
   * The re-list is FORCED but not preceded by dropping the level: a watch
   * notice usually lands while the directory is on screen with its rows, and
   * deleting the cached level first replaced every row with a "Loading…"
   * placeholder — the whole folder blinked and rebuilt on each disk change
   * (a build, a formatter, the model's own `bash`). The fresh listing simply
   * overwrites the old one when it arrives; a failed re-list keeps the rows it
   * has and adds the hint line.
   */
  const retryDir = useCallback((dir: string) => {
    loadLevels([dir], { force: true })
  }, [loadLevels])

  /**
   * Settle the tree after one rename/delete landed at `prefix`: drop every
   * cached level at or under the old path, collapse the now-stale expanded
   * directories below it, and reload the immediate parent so the new shape
   * shows without a full refresh tick.
   */
  const pruneTree = useCallback((prefix: string): void => {
    const parent = parentOf(prefix)
    const under = (key: string): boolean => key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)
    for (const key of Object.keys(dataRef.current)) {
      if (under(key)) delete dataRef.current[key]
    }
    if (parent !== prefix) delete dataRef.current[parent]
    setData({ ...dataRef.current })
    for (const dir of propsRef.current.expanded) {
      if (under(dir)) propsRef.current.onToggle(dir)
    }
    if (parent !== prefix) retryDir(parent)
  }, [retryDir])

  /** Client-side twin of the server's name rule (the server re-validates). */
  const validName = (name: string): boolean =>
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')

  /** Commit the inline rename: trim, no-op guard, then fs.rename + settle. */
  const commitRename = (path: string, raw: string): void => {
    setRenaming(null)
    const name = raw.trim()
    if (cwd === undefined || name === baseName(path) || !validName(name)) {
      if (name !== baseName(path) && !validName(name)) setActionError(t('renameInvalid'))
      return
    }
    api.fsRename({ sessionId, cwd }, path, name)
      .then((result) => {
        setActionError(null)
        pruneTree(path)
        onPathRenamed?.(path, result.path)
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  // The caller's refresh tick invalidates every in-flight response (a slow
  // answer for the old generation can never land on top of the fresh listing)
  // and flags the next load as FORCED: the visible levels are re-listed in one
  // batch, but their current rows stay on screen until the answer arrives.
  // Declared BEFORE the load effect so that effect sees the flag.
  const lastTick = useRef(refreshTick)
  const forceNextLoad = useRef(false)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    generationRef.current += 1
    forceNextLoad.current = true
  }, [refreshTick])

  // The exclude patterns are applied HOST-side, so a changed list makes every
  // cached level stale (the old rows include entries the list now removes, and
  // miss entries it no longer hides): wipe the cache and let the load effect
  // below re-list the visible set in one batch. Declared BEFORE it so the wipe
  // lands first; the first pass only records the list.
  const lastExclude = useRef(excludeKey)
  useEffect(() => {
    if (lastExclude.current === excludeKey) return
    lastExclude.current = excludeKey
    generationRef.current += 1
    dataRef.current = {}
    setData({})
  }, [excludeKey])

  useEffect(() => {
    // Load the visible set in ONE batch request; already-loaded levels (kept
    // in the cache) are not refetched, so this asks only for what is new — a
    // refresh tick re-lists root + every expanded directory in one POST.
    const root = cwd
    if (root === undefined) return
    const force = forceNextLoad.current
    forceNextLoad.current = false
    loadLevels([root, ...expanded], { force })
  }, [cwd, expanded, refreshTick, loadLevels])

  useEffect(() => {
    // A fold chain runs through COLLAPSED singleton directories, so their
    // levels are loaded ahead of any expansion (without them the breadcrumb
    // label would grow one segment at a time as the user clicks). Each arrival
    // can reveal the next link, hence the rescan on every cache update;
    // loadLevels skips what is already loaded, so this settles. The roots are
    // read LIVE through `propsRef`, keeping this effect's dependencies at
    // [cwd, data, loadLevels]: the level cache is the real trigger (an arrival
    // reveals the next link), and an expansion is always accompanied by the
    // visible-set effect above loading (or having loaded) that level. The walk
    // itself stops at the render cap, so a chain the row stopped folding at
    // MAX_COMPACT_DEPTH never keeps pulling deeper levels.
    if (cwd === undefined) return
    loadLevels(compactLoadTargets(dataRef.current, [cwd, ...propsRef.current.expanded]))
  }, [cwd, data, loadLevels])

  // A torn-down tree must not write the answer of an in-flight batch into a
  // dead component: bumping the generation makes every late response stale.
  useEffect(() => () => { generationRef.current += 1 }, [])

  // Live refresh: the host watches the folders this tree has expanded and
  // names the one that changed, so exactly that level is dropped and
  // re-listed instead of the whole tree. Without it a folder listed once when
  // it was opened stayed stale for the rest of the session.
  useDirectoryWatch({
    sessionId,
    root: cwd,
    dirs: expanded,
    onStale: retryDir,
  })

  // Bring a "Show in folder" reveal into view: the ancestors expand above
  // (revealPaths), but the row may not be scrolled into sight — a reveal on
  // a long tree should surface the highlighted file. Re-runs when the tree
  // data or reveal set changes (the row appears after its level loads).
  // Scrolls ONLY this tree's body: scrollIntoView would scroll every
  // scrollable ancestor, and the clipping panel host
  // ([data-dsh-panel-host]) is still programmatically scrollable — a deep
  // reveal shifted the whole panel, tab bar included, out of the viewport.
  useEffect(() => {
    if (revealed.length === 0 || propsRef.current.hidden === true) return
    const body = bodyRef.current
    if (body === null) return
    const row = body.querySelector<HTMLElement>('[data-dsh-revealed]')
    if (row === null) return
    const bodyTop = body.getBoundingClientRect().top
    const rowRect = row.getBoundingClientRect()
    const target = body.scrollTop + (rowRect.top + rowRect.height / 2) - (bodyTop + body.clientHeight / 2)
    const max = Math.max(body.scrollHeight - body.clientHeight, 0)
    body.scrollTo({ top: Math.min(Math.max(target, 0), max), behavior: 'smooth' })
  }, [revealed, data])

  // The reveal FLASH: `revealPaths` allocates a new `revealed` array on every
  // call — even for a set that already contains the file — so each reveal
  // round bumps the counter and the revealed row's flash class alternates
  // (changing animation-name restarts the animation; replaying the same class
  // would not). The tree dock unmounts while closed, so the panel-open
  // gesture replays through this mount bump alone; a reveal into an OPEN
  // tree ("show in folder"-style callers) replays through the identity
  // change. Same hidden guard as the scroll above: nothing flashes while the
  // search panel has parked the tree.
  useEffect(() => {
    if (revealed.length === 0 || propsRef.current.hidden === true) return
    setFlashSeq(seq => seq + 1)
  }, [revealed])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  // ── Multi-selection ────────────────────────────────────────────────────
  /** The selection's mirror for the stable callbacks (state itself re-renders). */
  const selectedRef = useRef(selected)
  /** Path → whether the row is a directory (the delete callback needs it). */
  const kindRef = useRef(new Map<string, boolean>())
  /** The visible rows in depth-first order: the Shift range's coordinate space. */
  const visibleRowsRef = useRef<{ path: string; isDir: boolean }[]>([])
  /** The expanded set for the stable callbacks. */
  const expandedSetRef = useRef<Set<string>>(new Set())

  const setSelection = useCallback((next: Set<string>): void => {
    selectedRef.current = next
    setSelected(next)
  }, [])

  /** Ctrl/Cmd+click: toggle one row and move the Shift anchor onto it. */
  const toggleSelect = useCallback((path: string, isDir: boolean): void => {
    const next = new Set(selectedRef.current)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      kindRef.current.set(path, isDir)
    }
    anchorRef.current = path
    setSelection(next)
  }, [setSelection])

  /** Shift+click: select the visible range between the anchor and the row. */
  const selectRange = useCallback((path: string, isDir: boolean): void => {
    const rows = visibleRowsRef.current
    const anchor = anchorRef.current
    const from = anchor === null ? -1 : rows.findIndex(row => row.path === anchor)
    const to = rows.findIndex(row => row.path === path)
    // No usable anchor (or a row that scrolled out of the tree): behave like
    // a plain Ctrl click, which also re-seats the anchor.
    if (from === -1 || to === -1) {
      toggleSelect(path, isDir)
      return
    }
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    const next = new Set(selectedRef.current)
    for (let index = low; index <= high; index += 1) {
      const row = rows[index]!
      next.add(row.path)
      kindRef.current.set(row.path, row.isDir)
    }
    // The anchor stays put: a second Shift+click re-ranges from the same start.
    setSelection(next)
  }, [setSelection, toggleSelect])

  const clearSelection = useCallback((): void => {
    if (selectedRef.current.size === 0) return
    anchorRef.current = null
    setSelection(new Set())
  }, [setSelection])

  /**
   * Bumped by the swap effect below, and the boundary it marks is shared: the
   * two asynchronous paths this component starts — the batch-delete walk and
   * the archive build — capture their OWN scope, so the requests they issue
   * stay correct across a swap, while everything they SETTLE (pruneTree, the
   * error strip, the selection, the busy flags, the archive job) is state of
   * the project on screen, which may no longer be the one they started in.
   * Work whose generation is stale goes quiet instead.
   */
  const scopeGenRef = useRef(0)

  /**
   * A session/cwd swap REUSES this component: the workbench keeps one mounted
   * instance per tab id, and tab ids restart per session. Every path-shaped
   * piece of state here therefore outlives the project it was picked in — and
   * the selection is the dangerous one, because "delete selected" sends THIS
   * session's scope with the PREVIOUS session's absolute paths, which the host
   * applies verbatim (containment was removed on purpose): it deleted another
   * project's files. The rest is the same leak in harmless clothing — a menu,
   * an inline editor, an armed confirmation aimed at a row that is no longer
   * on screen.
   */
  useEffect(() => {
    // The guarded clear spares a swap with nothing selected a re-render of the
    // whole tree. It returns early when the selection is already empty, so the
    // anchor is dropped here as well: deselecting the last row leaves an empty
    // selection still holding one.
    clearSelection()
    anchorRef.current = null
    kindRef.current.clear()
    setRowMenu(null)
    setApps(null)
    setCopiedPath(null)
    setRenaming(null)
    setNewFolder(null)
    // The ref is synced during render, so it still holds the previous session's
    // editor until the next one — long enough for a blur in this tick to mkdir
    // that dir under the new scope.
    newFolderRef.current = null
    // A breadcrumb break points at the previous project's paths.
    setFoldBreak(null)
    setConfirmDelete(null)
    setConfirmDeleteSelected(null)
    // A batch walk of the PREVIOUS session may still be in flight: its flag
    // must not lock the new session's bar, and the bump below retires the
    // state it would otherwise settle here.
    setDeletingSelected(false)
    scopeGenRef.current += 1
    setActionError(null)
    setLoadError(null)
    pendingUploadDir.current = undefined
    resetDrop()
  }, [sessionId, cwd, resetDrop, clearSelection, setFoldBreak])

  const copySelectedPaths = useCallback((): void => {
    void writeClipboard([...selectedRef.current].join('\n'))
  }, [])

  // ── 复制 / 剪切 / 黏贴（Windows file-manager semantics）────────────────
  // The clipboard itself lives in tree-clipboard.ts (one page-wide instance);
  // cut rows dim off the `clipboard` mirror above; the paste lands through the
  // host's async fs.transfer job (progress in the top-right card).

  /** Whether `candidate` is `dir` itself or anywhere inside it (lexical). */
  const isInsideOrSelf = (dir: string, candidate: string): boolean =>
    candidate === dir || candidate.startsWith(`${dir}/`) || candidate.startsWith(`${dir}\\`)

  /** Store the WHOLE current selection into the clipboard (复制 or 剪切). */
  const clipSelection = useCallback((mode: 'copy' | 'cut'): void => {
    const live = propsRef.current
    if (live.cwd === undefined) return
    const paths = [...selectedRef.current]
    if (paths.length === 0) return
    setTreeClipboard({
      cwd: live.cwd,
      mode,
      entries: paths.map(path => ({ path, isDir: kindRef.current.get(path) ?? false })),
    })
  }, [])

  /** Fire the async host job for one paste batch and settle the tree after. */
  const runPaste = useCallback((
    scope: FsScope,
    mode: 'copy' | 'cut',
    entries: readonly TreeClipboardEntry[],
    targetDir: string,
    conflict: 'replace' | 'skip',
  ): void => {
    void startTransfer(
      scope,
      // The wire mode is copy/move; the clipboard's 剪切 IS a move.
      mode === 'cut' ? 'move' : 'copy',
      entries.map(entry => entry.path),
      targetDir,
      conflict,
      (outcome) => {
        // 'error' = nothing dependable happened; the card shows the message.
        if (outcome.state === 'error') return
        const live = propsRef.current
        if (!sameScope(scope, scopeOf(live))) return
        retryDir(targetDir)
        if (mode !== 'cut' || outcome.state !== 'done') return
        // A completed move retargets the open tabs (rename semantics: a
        // directory takes its subtree) and drops the stale source rows.
        for (const entry of entries) {
          pruneTree(entry.path)
          live.onPathMoved?.(entry.path, joinChild(targetDir, baseName(entry.path)), entry.isDir)
        }
      },
    ).then(() => {
      setActionError(null)
    }).catch((error: unknown) => {
      // The job never started (bad shape, or an OLD host without the route —
      // e.g. DSH not restarted since the feature landed). The wire message is
      // the truth the strip shows.
      setActionError(error instanceof Error ? error.message : String(error))
    })
  }, [retryDir, pruneTree])

  /**
   * 黏贴 into `target`'s directory (a directory row pastes into itself, a
   * file row into its parent, the workspace root row into the root). Drops
   * rows the paste would fold into themselves, lists the target level ONCE
   * for the conflict check, and either starts the job straight away (nothing
   * collides) or opens the Windows-style 替换/跳过 dialog.
   */
  const beginPaste = useCallback((target: { path: string; isDir: boolean }): void => {
    const live = propsRef.current
    const clip = getTreeClipboard()
    if (clip === null || live.cwd === undefined || clip.cwd !== live.cwd) return
    const armed = scopeOf(live)
    if (armed === undefined) return
    const targetDir = target.isDir ? target.path : parentOf(target.path)
    const entries = clip.entries.filter(entry => !isInsideOrSelf(entry.path, targetDir))
    if (entries.length === 0) {
      setActionError(t('clipPasteBlocked'))
      return
    }
    // A clean paste skips nothing (nothing collides); the same call serves
    // the dialog's 跳过 pick (the HOST skips the conflicting top-level items).
    const run = (conflict: 'replace' | 'skip'): void => {
      runPaste(armed, clip.mode, entries, targetDir, conflict)
      // 剪切黏贴 empties the clipboard once the job is ACCEPTED (Windows
      // clears the cut marks as soon as the paste begins).
      if (clip.mode === 'cut') setTreeClipboard(null)
    }
    void api.fsTrees(armed, [targetDir]).then((result) => {
      const level = result.levels[0]
      // An unreadable target level: let the host job surface the real error.
      if (level === undefined || level.error !== undefined) {
        run('skip')
        return
      }
      const names = new Set(level.entries.map(entry => entry.name))
      const conflicts = entries
        .filter(entry => names.has(baseName(entry.path)))
        .map(entry => baseName(entry.path))
      if (conflicts.length === 0) {
        run('skip')
        return
      }
      setPasteDialog({ scope: armed, mode: clip.mode, entries, targetDir, conflicts })
    }).catch(() => {
      // The listing itself failed (workspace gone): same delegation.
      run('skip')
    })
  }, [runPaste])

  /**
   * Run the confirmed single-row delete: fs.remove + settle + close tabs.
   *
   * The confirmation carries the scope it was armed under, and the request is
   * refused when that is no longer the scope on screen. Relying on the swap
   * effect alone is not enough: a click that lands before React flushes that
   * passive effect sends the NEW session's scope with the OLD project's
   * absolute path, which the host applies verbatim — it deleted another
   * project's file.
   * @param target - The row awaiting deletion, plus its armed scope.
   */
  const performDelete = (target: { path: string; isDir: boolean; scope: FsScope }): void => {
    if (!sameScope(target.scope, scopeOf(propsRef.current))) return
    const generation = scopeGenRef.current
    api.fsRemove(target.scope, target.path)
      .then(() => {
        // A swap mid-flight retires the settle: it is state of the project on
        // screen, which is no longer the one this request ran in.
        if (generation !== scopeGenRef.current) return
        setActionError(null)
        pruneTree(target.path)
        onPathDeleted?.(target.path, target.isDir)
        anchorRef.current = null
        setSelection(new Set())
      })
      .catch((error: unknown) => {
        if (generation !== scopeGenRef.current) return
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  // ── Stable row actions ─────────────────────────────────────────────────
  const handleActivate = useCallback((event: ActivateModifiers, path: string, isDir: boolean, chain?: readonly FsEntry[]): void => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelect(path, isDir)
      return
    }
    if (event.shiftKey) {
      selectRange(path, isDir)
      return
    }
    // Plain click: the original semantics, plus dropping any selection.
    clearSelection()
    // Clicking a highlighted row dismisses its reveal — the mark is a
    // transient "here it is" locator (a "show in folder", a conversation
    // folder link), and the plain click on the found row is the reader
    // closing it. Only the clicked ROW's paths leave the set: a folded row
    // renders one line for its whole chain, so whichever link carries the
    // mark goes; a plain row its single path. Modifier clicks are selection
    // gestures and returned above, so they never clear a highlight.
    const rowPaths = chain !== undefined && chain.length > 0 ? chain.map(link => link.path) : [path]
    const marked = propsRef.current.revealed
    const dismissed = marked.filter(item => rowPaths.includes(item))
    if (dismissed.length > 0) propsRef.current.onRevealDismiss?.(dismissed)
    if (!isDir) {
      propsRef.current.onOpenFile(path)
      return
    }
    // A folded row toggles the WHOLE chain: expanding every link is what makes
    // the tail's children render, and collapsing every link is the only way to
    // close a chain an earlier expansion (before the fold formed) left open.
    const links = chain !== undefined && chain.length > 0 ? chain.map(link => link.path) : [path]
    const open = links.some(link => expandedSetRef.current.has(link))
    if (open) {
      // Collapsing the row re-forms its fold: a breadcrumb-segment break dies
      // with the row it split (the chain renders whole again once closed).
      const broken = foldBreakRef.current
      if (broken !== null && links.includes(broken)) setFoldBreak(null)
    }
    for (const link of links) {
      if (expandedSetRef.current.has(link) === open) propsRef.current.onToggle(link)
    }
  }, [clearSelection, selectRange, toggleSelect, setFoldBreak])

  /**
   * A breadcrumb segment click on a folded row (VSCode's compact folders):
   * reveal the clicked directory IN the tree — expand the chain up to and
   * including it, select it, and break the fold at it, so the row now shows
   * `a/b` with the remaining links as their own row below. The ancestors ride
   * the caller's `onToggle` (flips, so only collapsed links are touched); the
   * selection is the tree's own; the break is the tree's `foldBreak` state.
   * Modifier clicks never get here (the row diverts them to its own
   * activate), so this is the plain-click path only.
   */
  const handleRevealSegment = useCallback((_event: ActivateModifiers, chain: readonly FsEntry[], index: number): void => {
    const link = chain[index]
    if (link === undefined) return
    for (let at = 0; at <= index; at += 1) {
      const path = chain[at]!.path
      if (!expandedSetRef.current.has(path)) propsRef.current.onToggle(path)
    }
    anchorRef.current = link.path
    kindRef.current.set(link.path, link.isDir)
    setSelection(new Set([link.path]))
    // A break AT the head would be a no-op split (the head row IS the fold's
    // top — nothing renders above it), so only deeper links actually break.
    if (index > 0) setFoldBreak(link.path)
  }, [setFoldBreak, setSelection])

  const handleContextMenu = useCallback((event: ContextMenuTrigger, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    // VSCode semantics: right-clicking outside the selection collapses it
    // onto the row; right-clicking INSIDE it keeps the whole batch.
    if (!selectedRef.current.has(path)) {
      anchorRef.current = path
      kindRef.current.set(path, isDir)
      setSelection(new Set([path]))
    }
    // NOTE: the previous menu's app answer is deliberately KEPT — the render
    // only trusts it for the matching path, and dropping it here would cost an
    // extra render (and, on a reopen, a disabled "Loading…" frame).
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }, [setSelection])

  const handleReference = useCallback((path: string, isDir: boolean): void => {
    propsRef.current.onReferenceFile(path, isDir)
  }, [])

  const actions = useMemo<RowActions>(() => ({
    activate: handleActivate,
    contextMenu: handleContextMenu,
    revealSegment: handleRevealSegment,
    reference: handleReference,
    dragOver: handleRowDragOver,
    drop: handleDrop,
  }), [handleActivate, handleContextMenu, handleRevealSegment, handleReference, handleRowDragOver, handleDrop])

  // ── New folder ─────────────────────────────────────────────────────────
  const newFolderRef = useRef(newFolder)
  newFolderRef.current = newFolder

  /** Open the inline editor at the TOP of `dir`'s level (expanding it first). */
  const startNewFolder = (dir: string): void => {
    const live = propsRef.current
    if (live.cwd !== undefined && dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
    setNewFile(null)
    setNewFolder({ dir, value: '' })
  }

  /**
   * Commit the inline new-folder name: Enter, blur, or the editor's own
   * cancel path. The ref guard makes the commit idempotent — a blur that
   * lands after Enter must not fire a second mkdir.
   */
  const commitNewFolder = (dir: string, raw: string): void => {
    if (newFolderRef.current === null) return
    newFolderRef.current = null
    setNewFolder(null)
    const name = raw.trim()
    const live = propsRef.current
    if (live.cwd === undefined) return
    if (!validName(name)) {
      setActionError(t('newFolderInvalid'))
      return
    }
    api.fsMkdir({ sessionId: live.sessionId, cwd: live.cwd }, dir, name)
      .then(() => {
        setActionError(null)
        if (dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
        retryDir(dir)
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  const cancelNewFolder = (): void => {
    newFolderRef.current = null
    setNewFolder(null)
  }

  // ── New file ───────────────────────────────────────────────────────────
  const newFileRef = useRef(newFile)
  newFileRef.current = newFile

  /** Open the inline editor at the TOP of `dir`'s level (expanding it first). */
  const startNewFile = (dir: string): void => {
    const live = propsRef.current
    if (live.cwd !== undefined && dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
    setNewFolder(null)
    setNewFile({ dir, value: '' })
  }

  /**
   * Commit the inline new-file name: Enter, blur, or the editor's own cancel
   * path. The ref guard makes the commit idempotent — a blur that lands after
   * Enter must not fire a second create. Creates an EMPTY file through
   * `fs.createFile` (the server refuses a taken destination without truncating
   * it); a name the level already lists is refused here first, so the two
   * obvious mistakes never cost a round trip.
   */
  const commitNewFile = (dir: string, raw: string): void => {
    if (newFileRef.current === null) return
    newFileRef.current = null
    setNewFile(null)
    const name = raw.trim()
    const live = propsRef.current
    if (live.cwd === undefined) return
    if (!validName(name)) {
      setActionError(t('newFileInvalid'))
      return
    }
    if (nameTaken(dataRef.current[dir]?.entries, name)) {
      setActionError(t('newFileExists'))
      return
    }
    api.fsCreateFile({ sessionId: live.sessionId, cwd: live.cwd }, dir, name)
      .then(() => {
        setActionError(null)
        if (dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
        retryDir(dir)
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  const cancelNewFile = (): void => {
    newFileRef.current = null
    setNewFile(null)
  }

  // ── Batch delete ───────────────────────────────────────────────────────
  /**
   * Delete every selected row, ONE AT A TIME (the host refuses nothing here,
   * but a partial batch must be debuggable). The first failure stops the walk
   * and lands in the error strip; already-removed rows settle as they go.
   */
  const performBatchDelete = (armed: FsScope): void => {
    const live = propsRef.current
    if (live.cwd === undefined || deletingSelected) return
    // The selection was built in the scope the confirmation was armed under,
    // and the first fs.remove below is issued straight from the click handler —
    // so this call-site check, not the passive swap effect, is what keeps the
    // batch from pairing this session's scope with the previous session's
    // paths (see {@link sameScope}).
    if (!sameScope(armed, scopeOf(live))) {
      setConfirmDeleteSelected(null)
      return
    }
    const paths = [...selectedRef.current]
    setConfirmDeleteSelected(null)
    if (paths.length === 0) return
    const generation = scopeGenRef.current
    setDeletingSelected(true)
    void (async () => {
      const removed: string[] = []
      for (const path of paths) {
        try {
          await api.fsRemove(armed, path)
        } catch (error: unknown) {
          if (generation !== scopeGenRef.current) return
          setActionError(error instanceof Error ? error.message : String(error))
          // Keep the rows that were NOT removed selected, so a retry is one click.
          const next = new Set(selectedRef.current)
          for (const done of removed) next.delete(done)
          setSelection(next)
          setDeletingSelected(false)
          return
        }
        // Stale walk: the swap already released the busy flag.
        if (generation !== scopeGenRef.current) return
        setActionError(null)
        pruneTree(path)
        live.onPathDeleted?.(path, kindRef.current.get(path) ?? false)
        removed.push(path)
      }
      if (generation !== scopeGenRef.current) return
      setDeletingSelected(false)
      clearSelection()
    })()
  }

  // ── Open in app ────────────────────────────────────────────────────────
  /** Report one failed hand-off (open / reveal / app listing) in the strip. */
  const reportOpenFailure = useCallback((path: string): void => {
    setActionError(t('openInAppFailed', { path }))
  }, [])

  /**
   * Whether the host can hand paths to a native desktop — probed ONCE per
   * handle, on mount. The adapter starts in its `null` (unprobed) state, and
   * only the probe publishes the answer, so the menu reads this state instead
   * of the tri-state getter: reading `available()` alone left the whole
   * section permanently invisible (nothing ever probed).
   */
  const [appReady, setAppReady] = useState(() => openInApp?.available() === true)

  useEffect(() => {
    if (openInApp === undefined) {
      setAppReady(false)
      return
    }
    // An answer the handle already carries is authoritative; only the
    // unprobed (`null`) state needs the probe.
    const known = openInApp.available()
    if (known !== null) {
      setAppReady(known)
      return
    }
    let cancelled = false
    void openInApp.probe().then((ok) => {
      if (!cancelled) setAppReady(ok)
    }).catch(() => {
      if (!cancelled) setAppReady(false)
    })
    return () => { cancelled = true }
  }, [openInApp])

  /**
   * The host's application list, CACHED per path (the successful answers only;
   * a failed listing is retried on the next open). The list is a property of
   * the machine + the path, so reopening the same row's menu is instant: no
   * request, no disabled "Loading…" frame. A newly installed application shows
   * up on the next tree mount — the alternative (re-probing per open) is the
   * churn the menu was reported for.
   */
  const appsCacheRef = useRef(new Map<string, readonly OpenInAppEntry[]>())
  useEffect(() => {
    if (rowMenu === null || openInApp === undefined || !appReady) return
    const { path, isDir } = rowMenu
    const key = `${isDir ? 'd' : 'f'}\u0000${path}`
    const cached = appsCacheRef.current.get(key)
    if (cached !== undefined) {
      // Already answered for this path: publish it without a null frame (the
      // submenu never flashes its disabled "Loading…" row on a reopen).
      setApps({ path, entries: cached })
      return
    }
    let cancelled = false
    const listing = isDir ? openInApp.directoryApps() : openInApp.fileApps(path)
    void listing.then((entries) => {
      if (cancelled) return
      if (entries !== null) appsCacheRef.current.set(key, entries)
      setApps({ path, entries })
      if (entries === null) reportOpenFailure(path)
    }).catch(() => {
      if (cancelled) return
      setApps({ path, entries: null })
      reportOpenFailure(path)
    })
    return () => { cancelled = true }
  }, [rowMenu, openInApp, appReady, reportOpenFailure])

  const openWithApp = useCallback((path: string, application?: string): void => {
    const handle = propsRef.current.openInApp
    if (handle === undefined) return
    const call = application === undefined ? handle.open(path) : handle.open(path, application)
    void call.then((ok) => { if (!ok) reportOpenFailure(path) }).catch(() => { reportOpenFailure(path) })
  }, [reportOpenFailure])

  const revealPath = useCallback((path: string): void => {
    const handle = propsRef.current.openInApp
    if (handle === undefined) return
    void handle.reveal(path).then((ok) => { if (!ok) reportOpenFailure(path) }).catch(() => { reportOpenFailure(path) })
  }, [reportOpenFailure])

  /** The menu label of one plugin open target: a locale key for the built-ins,
   *  the user's own name for custom editors, plus the SSH hint in remote mode. */
  const openWithLabelOf = (target: OpenWithTarget): string => {
    const name = target.nameKey !== undefined ? t(target.nameKey) : target.name
    return openWithSsh === true && !target.localOnly ? `${name}${t('openWithSshSuffix')}` : name
  }

  /**
   * The plugin's own open-with targets as SUBMENU rows: one row per target with
   * its brand mark, the SSH hint in remote mode, and the pin hot zone (main's
   * interaction). The built-in `explorer` target is dropped while the host is
   * ready — the host's own reveal row replaces it, and two identical "File
   * Manager" rows would be noise; without the host the target stays, so reveal
   * is never lost.
   *
   * Visibility (the user's "有本机检测到的关联应用时就不显示固定的 openwith
   * 项目"): when the host reports applications for THIS path, the plugin rows
   * only appear if the caller turned `openWithShowPluginTargets` on (the
   * `openWithPluginTargets` setting). An unavailable host, or an empty/failed
   * listing, keeps them — that is what makes a remote (SSH) session usable.
   */
  const pluginTargetRows = (hostHasApps: boolean): MenuItem[] => {
    if (openWithTargets === undefined || onOpenWith === undefined) return []
    if (hostHasApps && openWithShowPluginTargets !== true) return []
    const targets = appReady ? openWithTargets.filter(target => target.id !== 'explorer') : openWithTargets
    const pinnedIds = openWithPinned ?? []
    /** Brand marks for the built-ins (monochrome silhouettes, currentColor);
     *  reveal gets the folder glyph, custom editors a generic code mark.
     *  The compact menu's icon slot is 14px, so every mark renders at 14. */
    const itemIcon = (target: OpenWithTarget): ReactNode => {
      if (target.kind === 'reveal') return <VscFolderOpened size={14} />
      if (target.id === 'vscode') return <IconVscode16 size={14} />
      if (target.id === 'cursor') return <SiCursor size={14} />
      if (target.id === 'zed') return <SiZedindustries size={14} />
      return <IconCodeOutlineRegular size={14} />
    }
    return targets.map<MenuItem>(target => {
      const pinnedNow = pinnedIds.includes(target.id)
      return {
        id: `open-with:${target.id}`,
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{openWithLabelOf(target)}</span>
            {/* The pushpin: a PLAIN span, deliberately not a control. The
                Menu renders the row itself as `<button role="menuitem">`, so a
                nested button/imitation-button would be invalid markup — and
                anything with `tabIndex` inside it is unreachable by keyboard
                anyway (the row button swallows focus). It is therefore an
                honest MOUSE hot zone: hovering the row reveals it, clicking it
                pins/unpins without selecting the row (stopPropagation), and it
                keeps a `title` so the affordance is still nameable on hover.
                Keyboard/AT users have a real, reachable path to the same list:
                the plugin settings panel's pinned-targets editor
                (OpenWithSettings). Do not re-add role/tabIndex here without
                also making the row itself non-interactive. */}
            <span
              className={clsx(css.openWithPin, pinnedNow && css.openWithPinActive)}
              title={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleOpenWithPin?.(target.id)
              }}
            >
              {pinnedNow ? <VscPinned size={12} /> : <VscPin size={12} />}
            </span>
          </span>
        ),
        icon: itemIcon(target),
      }
    })
  }

  /** The host's application list for one path (undefined while it is unknown). */
  const hostEntries = (target: { path: string; isDir: boolean }): readonly OpenInAppEntry[] | null | undefined =>
    apps !== null && apps.path === target.path ? apps.entries : undefined

  /**
   * The submenu behind the "打开方式" row — this menu's ONE place for "open with
   * something else": the host's detected applications (the default handler is
   * hoisted to level 1 for files), then, per the visibility rule above, the
   * plugin's own fixed targets. A pending listing shows one disabled line; an
   * empty/failed listing the disabled `openInAppEmpty` line.
   *
   * Title: the frozen shape asked for a `t('openInApp')` label, but that key no
   * longer exists in the dictionaries (it was removed together with the
   * standalone section it used to head), and `openWithMenu` is the one
   * available synonym ("在应用中打开" / "Open with") — of the two near-duplicate
   * labels the task allowed keeping one, so this is it.
   */
  const openWithSubmenu = (target: { path: string; isDir: boolean }): MenuItem => {
    const entries = hostEntries(target)
    const hostHasApps = entries !== undefined && entries !== null && entries.length > 0
    const rows: MenuItem[] = []
    if (appReady) {
      if (entries === undefined) rows.push({ id: 'open-in-app-loading', label: t('loading'), disabled: true })
      else if (entries === null || entries.length === 0) {
        rows.push({ id: 'open-in-app-empty', label: t('openInAppEmpty'), disabled: true })
      } else {
        for (const entry of entries) {
          // The default handler is the level-1 row for files; directories have
          // no default concept, so every catalogue app stays here.
          if (!target.isDir && entry.isDefault) continue
          rows.push({ id: `open-in-app:${entry.id}`, label: entry.name, icon: <AppGlyph entry={entry} /> })
        }
      }
    }
    // The primitive submenu takes MenuItem rows only (no separators), so the
    // host and plugin groups are told apart by their icons.
    rows.push(...pluginTargetRows(hostHasApps))
    return {
      id: 'open-with-menu',
      // The primitives Menu renders no chevron for submenu parents — the
      // trailing arrow is supplied inside the label (full-width flex row,
      // right-aligned), matching how the submenu rows right-align the pin.
      label: (
        <span className={css.openWithLabel}>
          <span className={css.openWithName}>{t('openWithMenu')}</span>
          <IconChevronRightOutlineRegular size={14} className={css.openWithChevron} aria-hidden />
        </span>
      ),
      icon: <VscLinkExternal size={14} />,
      submenu: rows,
    }
  }

  /**
   * The level-1 "default open" row for a file: the host's default handler, one
   * click away without opening a submenu. Absent while the listing is unknown,
   * when the host has no default, or for directories (no default concept).
   */
  const defaultAppRow = (target: { path: string; isDir: boolean }): MenuEntry | null => {
    if (!appReady || target.isDir) return null
    const entries = hostEntries(target)
    const fallback = entries?.find(entry => entry.isDefault)
    if (fallback === undefined) return null
    return { id: 'open-in-app:default', label: t('openInAppDefault'), icon: <AppGlyph entry={fallback} /> }
  }

  /** The "打开方式" group of the ONE row menu: the host default, the submenu and
   *  (host permitting) reveal. Empty when neither half can offer anything. */
  const openWithSection = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const fallback = defaultAppRow(target)
    const entries = hostEntries(target)
    const hostHasApps = entries !== undefined && entries !== null && entries.length > 0
    const submenu = appReady || pluginTargetRows(hostHasApps).length > 0 ? openWithSubmenu(target) : null
    if (fallback === null && submenu === null) return []
    const rows: MenuEntry[] = []
    if (fallback !== null) rows.push(fallback)
    if (submenu !== null) rows.push(submenu)
    if (appReady) {
      rows.push(
        { id: 'open-in-app-sep', type: 'separator' },
        { id: 'reveal-in-file-manager', label: t('revealInFileManager'), icon: <IconFolderOpenRegular size={14} /> },
      )
    }
    return rows
  }

  /**
   * The selection's ZIP row: two or more selected rows archive together, and a
   * LONE directory archives its own subtree. A lone FILE is skipped — it would
   * only duplicate the plain download row.
   */
  const zipEntries = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const count = selected.size
    if (count >= 2) {
      return [{
        id: 'archive-selection',
        label: t('zipDownloadCount', { count }),
        icon: <IconArchiveOutlineRegular size={14} />,
      }]
    }
    if (count === 1 && target.isDir) {
      return [{ id: 'archive-selection', label: t('zipDownload'), icon: <IconArchiveOutlineRegular size={14} /> }]
    }
    return []
  }

  /**
   * The「添加到搜索中」submenu: report the right-clicked row to the caller,
   * which redirects it to the「搜索」tab (the content search's own page) as a
   * prefilled include/exclude chip — a NEW tab each time, and NO search runs
   * (fill ≠ run, the same contract as the history dropdown). The tree only
   * reports the row (absolute path + which list); the chip shape is derived
   * by the caller (EditorHost's addToSearch). The parent row copies the
   * open-with submenu's label contract verbatim: the primitives Menu draws
   * no chevron for submenu parents, so the trailing arrow rides inside the
   * label (full-width flex row, right aligned). Rows: files AND directories
   * alike (a directory names a subtree scope, a file names itself); the
   * breadcrumb/compact rows and the workspace root reuse the same builder,
   * which is expected.
   */
  const addToSearchSubmenu = (): MenuItem => ({
    id: 'add-to-search',
    label: (
      <span className={css.openWithLabel}>
        <span className={css.openWithName}>{t('addToSearch')}</span>
        <IconChevronRightOutlineRegular size={14} className={css.openWithChevron} aria-hidden />
      </span>
    ),
    icon: <IconContentSearchOutline16 size={14} />,
    submenu: [
      { id: 'add-to-search:include', label: t('addToSearchInclude'), icon: <IconPlusOutlineRegular size={14} /> },
      { id: 'add-to-search:exclude', label: t('addToSearchExclude'), icon: <IconCloseOutlineRegular size={14} /> },
    ],
  })

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  /**
   * Zip the selection through the host's ASYNC archive route:
   *
   *   archiveBuild(scope, paths, stem) → { id, name }
   *   → the id rides the shared `fs-jobs` push socket (fs-jobs-push.ts):
   *     the host pushes the build's SETTLE (a child process reports nothing
   *     per entry, so `building` has no intermediate frame) while the strip
   *     shows a plain "packing" line; one one-shot `archiveStatus` fetch at
   *     the start and after every socket re-open catches what landed before
   *     the subscription did — no timer ever polls
   *   → state 'ready' → a plain `<a download>` on the route URL, which the
   *     browser streams to disk (see saveArchive for why it is not a blob)
   *   → any failure (tool missing / build / status fetch) → `zipFailed` in
   *     the strip.
   *
   * `archiveBusyRef` keeps a repeated pick from starting a second job — the
   * visible packing line is the feedback.
   */
  const [archiveBusy, setArchiveBusy] = useState(false)
  const archiveBusyRef = useRef(false)
  /** The job being followed (state so the subscription starts/stops with it). */
  const [archiveJobId, setArchiveJobId] = useState<string | null>(null)
  const archiveJobRef = useRef<{ id: string; name: string } | null>(null)
  /** Whether the CURRENT job's `ready` status was already handed to the
   *  download. The download route CONSUMES the task, so a second hand-off
   *  would either fetch a deleted id (404 → a bogus `zipFailed` strip next to
   *  a file that did land) or click the anchor twice. */
  const archiveHandedOffRef = useRef(false)

  /** End the job: drop the progress line and release the guard. */
  const settleArchive = useCallback((): void => {
    archiveBusyRef.current = false
    archiveJobRef.current = null
    archiveHandedOffRef.current = false
    setArchiveJobId(null)
    setArchiveBusy(false)
  }, [])

  // A session/cwd swap abandons the archive job with it — the progress strip
  // belongs to the project that started the zip, and a leftover `archiveJobId`
  // would keep the subscription running in the new one, whose failures land as
  // `zipFailed` there. A build still starting up is retired by the swap effect
  // above (scopeGenRef), so it cannot pump its job back in after this.
  useEffect(() => {
    settleArchive()
  }, [sessionId, cwd, settleArchive])

  const failArchive = useCallback((message: string): void => {
    setActionError(t('zipFailed', { message }))
    settleArchive()
  }, [settleArchive])

  /**
   * Save the finished archive through a plain anchor on the route URL.
   *
   * Deliberately NOT `fetch → blob → objectURL` any more, which is what the
   * flow used to do: a Blob holds the whole archive in the TAB's memory, so a
   * multi-gigabyte selection would kill the page — the very thing the host
   * side was just changed to stop doing. A plain anchor hands the URL to the
   * browser's download machinery, which streams it to disk.
   *
   * The cost, stated plainly: the route's JSON error envelope can no longer be
   * inspected, so a failure at this point saves a JSON body under the archive's
   * name. Everything that realistically fails — no tool installed, an
   * unreadable selection, a tool that exited non-zero — settles the task as
   * `error` and is caught by the push frames and the one-shot status reads
   * BEFORE this runs, so what is left is an already-consumed or expired task
   * between the settle and the click.
   */
  const saveArchive = useCallback((id: string, name: string): void => {
    setActionError(null)
    const anchor = document.createElement('a')
    anchor.href = archiveDownloadUrl({ sessionId, cwd }, id)
    anchor.download = name
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    settleArchive()
  }, [cwd, sessionId, settleArchive])

  /** The settle handlers, read through a ref so the callbacks stay
   *  identity-stable (a churned task restarts the loop every render). */
  const archiveHandlersRef = useRef({ fail: failArchive, save: saveArchive })
  archiveHandlersRef.current = { fail: failArchive, save: saveArchive }

  /**
   * Route one archive status answer — a `fs-jobs` push frame or a one-shot
   * `archiveStatus` fetch — to the strip. Only the two terminal states act:
   * `error` paints `zipFailed`, `ready` hands the bytes to the download
   * ONCE and ends the subscription BEFORE the download starts (the GET
   * consumes the task, so a second hand-off would either fetch a deleted id
   * — 404, a bogus `zipFailed` beside a file that did land — or click the
   * anchor twice).
   */
  const handleArchiveStatus = useCallback((
    jobId: string,
    status: { state: 'building' | 'ready' | 'error'; bytes: number; error?: string },
  ): void => {
    if (status.state === 'error') {
      archiveHandlersRef.current.fail(status.error ?? `HTTP ${status.state}`)
      return
    }
    if (status.state !== 'ready') return
    if (archiveHandedOffRef.current) return
    const job = archiveJobRef.current
    if (job === null || job.id !== jobId) return
    archiveHandedOffRef.current = true
    setArchiveJobId(null)
    archiveHandlersRef.current.save(job.id, job.name)
  }, [])

  /**
   * One one-shot `archiveStatus` fetch: the initial read when a job starts
   * (a build that settled before the subscription frame could land) and the
   * catch-up after the push socket re-opened (the outage swallowed frames).
   * A late answer for a job the tree no longer holds — a session swap
   * retired it — is dropped on the id check.
   */
  const pullArchiveOnce = useCallback((): void => {
    const job = archiveJobRef.current
    if (job === null) return
    void archiveStatus({ sessionId, cwd }, job.id)
      .then((status) => {
        if (archiveJobRef.current?.id !== job.id) return
        handleArchiveStatus(job.id, status)
      })
      .catch((error: unknown) => {
        if (archiveJobRef.current?.id !== job.id) return
        archiveHandlersRef.current.fail(error instanceof Error ? error.message : String(error))
      })
  }, [cwd, sessionId, handleArchiveStatus])

  // The push half: while a job runs, its id rides the session's shared
  // `fs-jobs` socket (watch set = the union of every subscriber's job ids);
  // every frame is the job's status, and the terminal one clears the id
  // above, which unsubscribes. A re-opened socket missed frames, so the
  // reconnect catches up with one fetch.
  useFsJobsWatch({
    sessionId,
    jobs: archiveJobId === null ? [] : [archiveJobId],
    onFrame: (frame) => {
      const job = archiveJobRef.current
      if (job === null || frame.kind !== 'archive' || frame.id !== job.id) return
      handleArchiveStatus(frame.id, frame)
    },
    onReconnect: pullArchiveOnce,
  })

  // The initial one-shot read (the old poll loop's first tick, kept): it
  // covers a build that settled before the subscription frame landed.
  useEffect(() => {
    if (archiveJobId === null) return
    pullArchiveOnce()
  }, [archiveJobId, pullArchiveOnce])

  const downloadArchive = (paths: readonly string[]): void => {
    if (archiveBusyRef.current) return
    // The client names a STEM, not a file name: the host picks the extension
    // from the tool it actually has (a host with only `tar` produces a real
    // .tar.gz), and returns the final name with the build id.
    const stem = paths.length === 1 ? baseName(paths[0]!) : 'archive'
    const generation = scopeGenRef.current
    archiveBusyRef.current = true
    archiveHandedOffRef.current = false
    setArchiveBusy(true)
    void archiveBuild({ sessionId, cwd }, paths, stem)
      .then(({ id, name }) => {
        if (generation !== scopeGenRef.current) return
        setActionError(null)
        archiveJobRef.current = { id, name }
        setArchiveJobId(id)
      })
      .catch((error: unknown) => {
        if (generation !== scopeGenRef.current) return
        // `unavailable` is its own sentence: "this machine has neither zip nor
        // tar" is something the user can act on, and the host's English wire
        // message is not the place to say it.
        if (error instanceof SidebarApiError && error.code === 'unavailable') {
          failArchive(t('archiveToolMissing'))
          return
        }
        failArchive(error instanceof Error ? error.message : String(error))
      })
  }

  const root = cwd

  // Membership is tested per rendered row (deep trees run this thousands of
  // times per render): includes() made every row O(expanded), the whole tree
  // O(rows × expanded). One Set per render keeps it O(1) per row.
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const revealedSet = useMemo(() => new Set(revealed), [revealed])
  expandedSetRef.current = expandedSet
  /** This reveal round's flash class (parity-picked, see `flashSeq`). */
  const flashClass = flashSeq === 0
    ? undefined
    : flashSeq % 2 === 1 ? css.explorerRowFlashA : css.explorerRowFlashB

  /** The tree's shared git status (the changes page reads the same snapshot);
   *  a parked tab unsubscribes from the poll. */
  const gitStatus = useGitStatus({ sessionId, cwd }, { visible: visible !== false })

  /**
   * Whether a path may wear the green ✓ ("tracked and unchanged"). The
   * dangerous one of the two marks: a WRONG clean check would tell the user
   * "nothing to worry about" over a changed file, so it only answers from a
   * COMPLETE status answer — a repo, a known root, and NEITHER list
   * truncated (a truncated `git status` dropped rows; a truncated ignore
   * list leaves unknown-ignored paths unpainted — the paths the partial
   * answers did report look clean for exactly the reason the mark must not
   * trust them: the truth may sit in the dropped tail). Paths outside the
   * root (a linked container's row, a drive-relative oddity) stay unmarked
   * too — git has no answer for them, and "no answer" must not paint as
   * "clean".
   */
  const gitCleanMarkOf = (absolutePath: string): 'clean' | undefined => {
    const snapshot = gitStatus.snapshot
    const repoRoot = snapshot?.root
    if (snapshot === null || snapshot.isRepo !== true || repoRoot === undefined) return undefined
    if (snapshot.truncated === true || snapshot.ignoredTruncated === true) return undefined
    if (absolutePath !== repoRoot
      && !absolutePath.startsWith(`${repoRoot}/`)
      && !absolutePath.startsWith(`${repoRoot}\\`)) return undefined
    return 'clean'
  }

  /**
   * A FILE row's badge mark: the status store's tone when the path is
   * changed, the gray ⊘ when git ignores it (outside the repository's
   * management — a change badge is impossible here and the green ✓ would be
   * the lie this mark exists to prevent), else the green ✓ under the rules
   * above, else nothing. Primitive in, primitive out — the memoized row
   * compares it by value.
   */
  const gitMarkOf = (absolutePath: string): GitMark | undefined => {
    if (!gitBadges) return undefined
    const status = gitStatus.statusOf(absolutePath)
    if (status !== undefined) return status.tone
    if (gitStatus.isIgnored(absolutePath)) return 'ignored'
    return gitCleanMarkOf(absolutePath)
  }

  /**
   * A DIRECTORY (or root) row's badge mark: the subtree's WORST tone from the
   * store's directory index (`dirToneOf`), the same gray ⊘ when git ignores
   * the directory itself, else the green ✓, else nothing.
   */
  const gitDirMarkOf = (absoluteDir: string): GitMark | undefined => {
    if (!gitBadges) return undefined
    const tone = gitStatus.dirToneOf(absoluteDir)
    if (tone !== undefined) return tone
    if (gitStatus.isIgnored(absoluteDir)) return 'ignored'
    return gitCleanMarkOf(absoluteDir)
  }

  /**
   * Fold chains (VSCode "compact folders"): resolved ONCE per level-cache
   * revision and REUSED while it stands. {@link DirRow} is memoized on prop
   * identity, so handing it a freshly built array on every render would
   * re-render every directory row for a selection, a hover or a copy flash —
   * exactly what the row memoization exists to prevent.
   */
  const chainFor = useMemo(() => {
    const cache = new Map<string, readonly FsEntry[]>()
    return (entry: FsEntry): readonly FsEntry[] => {
      const cached = cache.get(entry.path)
      if (cached !== undefined) return cached
      const chain: readonly FsEntry[] = entry.compact === true ? compactChain(entry, path => data[path]) : [entry]
      cache.set(entry.path, chain)
      return chain
    }
  }, [data])

  /**
   * The chain a row RENDERS: the fold chain, sliced at the breadcrumb break
   * when one lands inside it (`a/b/c` with a break at `b` renders as `a/b`).
   * The slice is cached per (path, break index) alongside `chainFor`, so the
   * memoized `DirRow` still sees a stable array identity across renders.
   */
  const resolveChain = useMemo(() => {
    const slices = new Map<string, readonly FsEntry[]>()
    return (entry: FsEntry): { full: readonly FsEntry[]; rendered: readonly FsEntry[]; broken: boolean } => {
      const full = chainFor(entry)
      const at = foldBreak === null ? -1 : full.findIndex(link => link.path === foldBreak)
      if (at <= 0) return { full, rendered: full, broken: false }
      const key = `${entry.path}\u0000${at}`
      let rendered = slices.get(key)
      if (rendered === undefined) {
        rendered = full.slice(0, at + 1)
        slices.set(key, rendered)
      }
      return { full, rendered, broken: true }
    }
  }, [chainFor, foldBreak])

  /**
   * One level's rows in the caller's chosen order, resolved ONCE per
   * level-cache revision and reused by both walkers below: `renderLevel` draws
   * them and {@link visibleRows} ranges over them, so re-sorting per render
   * would both repeat the comparison and hand the memoized rows a fresh array.
   * `sortEntries` copies (the level cache keeps the host's own order and is
   * never reordered in place).
   */
  const entriesFor = useMemo(() => {
    const cache = new Map<string, readonly FsEntry[]>()
    return (dir: string): readonly FsEntry[] => {
      const cached = cache.get(dir)
      if (cached !== undefined) return cached
      const sorted = sortEntries(data[dir]?.entries ?? [], sort)
      cache.set(dir, sorted)
      return sorted
    }
  }, [data, sort])

  // The Shift range walks the rows the user can actually see: the level's
  // rows in the SAME order `renderLevel` draws them (the sort choice), then
  // depth-first, expanded state decides. Recomputed with the level cache,
  // never rendered.
  /**
   * The CUT rows (clipboard mode `cut`): one Set consulted per row render —
   * a primitive `cut` boolean reaches the memoized rows, so flipping the
   * clipboard re-renders exactly the rows it dims (the per-row-boolean rule).
   */
  const cutPaths = useMemo(
    () => new Set(clipboard?.mode === 'cut' ? clipboard.entries.map(entry => entry.path) : []),
    [clipboard],
  )

  const visibleRows = useMemo(() => {
    const rows: { path: string; isDir: boolean }[] = []
    const walk = (dir: string): void => {
      const level = data[dir]
      if (level?.entries === undefined) return
      for (const entry of entriesFor(dir)) {
        // A folded row IS one row: its identity is the chain head (the level
        // entry the walk is on), and it descends into the RENDERED chain's
        // tail — the full chain's tail normally, or the break link when a
        // breadcrumb segment reveal split the row — the same shape
        // `renderLevel` draws, so a Shift range covers what the user sees.
        rows.push({ path: entry.path, isDir: entry.isDir })
        if (!entry.isDir) continue
        const { rendered } = resolveChain(entry)
        if (rendered.some(link => expandedSet.has(link.path))) walk(rendered[rendered.length - 1]!.path)
      }
    }
    if (root !== undefined) walk(root)
    return rows
  }, [data, entriesFor, expandedSet, resolveChain, root])
  visibleRowsRef.current = visibleRows

  /**
   * Focus + select an inline editor once, on mount. The callback identity
   * must stay STABLE (useCallback []): an inline arrow re-runs on every
   * render (detach null → attach el), and focus()/select() mid-keystroke
   * would reselect the whole buffer while typing. A plain <input>, not the
   * primitives Input — that one forwards no ref, and focus+select is the
   * entire point here.
   */
  const renameInputRef = useCallback((el: HTMLInputElement | null): void => {
    if (el !== null) {
      el.focus()
      el.select()
    }
  }, [])

  /** The inline rename editor replacing one row (dirs and files alike):
   *  same indent/icon/height for a seamless swap, Enter/blur commits,
   *  Escape cancels. Composition keys must not commit the name; this handler
   *  is a NON-intercepting early return (no stopPropagation), so it asks the
   *  conservative isLikelyImeKey — the document capture guard only swallows
   *  keys inside a live composition window by design (bare legacy 229
   *  keydowns pass it, #833), which is right for the guard and not enough
   *  here. */
  const renderRenameRow = (entry: FsEntry, depth: number): ReactNode => (
    <div
      key={entry.path}
      className={clsx(css.explorerRow, css.explorerRenaming)}
      style={{ paddingLeft: depth * 22 + 6 }}
    >
      {entry.isDir
        ? dirRowIcon(entry.path, expandedSet.has(entry.path))
        : service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)}
      <input
        ref={renameInputRef}
        className={css.explorerRenameInput}
        value={renaming?.value ?? ''}
        aria-label={t('rename')}
        spellCheck={false}
        onChange={(event) => {
          setRenaming(prev => prev === null ? prev : { ...prev, value: event.target.value })
        }}
        onKeyDown={(event) => {
          if (isLikelyImeKey(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            // A folded row renders at the chain HEAD while its menu addressed
            // the TAIL: commit the path the editor was opened for.
            commitRename(renaming?.path ?? entry.path, renaming?.value ?? '')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setRenaming(null)
          }
        }}
        onBlur={() => { commitRename(renaming?.path ?? entry.path, renaming?.value ?? '') }}
      />
    </div>
  )

  /** The inline new-folder editor at the top of one level: the same
   *  interaction contract as the rename editor (Enter commits, Escape
   *  cancels, blur commits, conservatively IME-guarded). */
  const renderNewFolderRow = (dir: string, depth: number): ReactNode => (
    <div className={clsx(css.explorerRow, css.explorerRenaming)} style={{ paddingLeft: depth * 22 + 6 }}>
      {dirRowIcon(dir, true)}
      <input
        ref={renameInputRef}
        className={css.explorerRenameInput}
        value={newFolder?.value ?? ''}
        placeholder={t('newFolderPlaceholder')}
        aria-label={t('newFolder')}
        spellCheck={false}
        onChange={(event) => {
          setNewFolder(prev => prev === null ? prev : { ...prev, value: event.target.value })
        }}
        onKeyDown={(event) => {
          if (isLikelyImeKey(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commitNewFolder(dir, newFolder?.value ?? '')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelNewFolder()
          }
        }}
        onBlur={() => { commitNewFolder(dir, newFolder?.value ?? '') }}
      />
    </div>
  )

  /**
   * The inline new-file editor at the top of one level: the same interaction
   * contract as the new-folder editor (Enter commits, Escape cancels, blur
   * commits, conservatively IME-guarded). The glyph follows the typed name, so
   * the extension's icon updates while typing (an empty buffer probes with a
   * neutral carrier name).
   */
  const renderNewFileRow = (dir: string, depth: number): ReactNode => {
    const typed = newFile?.value.trim() ?? ''
    const probe = joinChild(dir, typed === '' ? 'untitled' : typed)
    return (
      <div className={clsx(css.explorerRow, css.explorerRenaming)} style={{ paddingLeft: depth * 22 + 6 }}>
        {service !== undefined ? service.fileIcon(probe, 14) : builtinFileIcon(probe, 14)}
        <input
          ref={renameInputRef}
          className={css.explorerRenameInput}
          value={newFile?.value ?? ''}
          placeholder={t('newFilePlaceholder')}
          aria-label={t('newFile')}
          spellCheck={false}
          onChange={(event) => {
            setNewFile(prev => prev === null ? prev : { ...prev, value: event.target.value })
          }}
          onKeyDown={(event) => {
            if (isLikelyImeKey(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              commitNewFile(dir, newFile?.value ?? '')
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelNewFile()
            }
          }}
          onBlur={() => { commitNewFile(dir, newFile?.value ?? '') }}
        />
      </div>
    )
  }

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    // Only ONE inline creator is open at a time (each start closes the other),
    // so the two are tested in a fixed order rather than merged.
    const head = newFolder?.dir === dir
      ? renderNewFolderRow(dir, depth)
      : newFile?.dir === dir ? renderNewFileRow(dir, depth) : null
    // Both the not-yet-requested level (`undefined`) and the in-flight marker
    // `loadLevels` stores (`{}` — no entries, no error yet) draw the loading
    // row. Without the second half the marker fell into `entries ?? []` and
    // rendered an EMPTY level (zero rows), so expanding a fresh folder flashed
    // "loading row → nothing under the folder (looks collapsed again) →
    // entries" for the whole request — and a fresh mount showed a blank body
    // under the root row. A settled level always carries `entries` (an
    // unreadable one carries `error` too), so this never misfires.
    if (level === undefined || (level.entries === undefined && level.error === undefined)) {
      return (
        <>
          {head}
          <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
        </>
      )
    }
    if (level.error !== undefined) {
      // A level the host could not read: the raw message on the level that
      // failed, never on its siblings (the batch reports errors per level).
      return (
        <>
          {head}
          <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
            {level.error}
          </div>
        </>
      )
    }
    // The ORDER is the caller's choice (the header's sort control).
    const entries = entriesFor(dir)
    return (
      <>
        {head}
        {entries.map((entry) => {
          // Fold chains (VSCode "compact folders"): a chain of dirs holding
          // exactly one real dir child each renders as ONE `a/b/c` row; the
          // chain pauses at whatever the level cache has loaded. Resolved for
          // directories only, and through the per-revision cache so DirRow's
          // memoization survives an unrelated re-render. A breadcrumb
          // segment reveal slices the chain at the break (`a/b/c` → `a/b` +
          // a `b/c` row below).
          const resolved = entry.isDir ? resolveChain(entry) : undefined
          // The row being renamed renders as its editor (no button semantics:
          // an editor is not a click target — and a nested interactive inside
          // role="button" would be invalid anyway). A folded row's menu
          // addressed its TAIL, so any chain link puts the whole row here.
          if (renaming !== null && (renaming.path === entry.path || resolved?.full.some(link => link.path === renaming.path) === true)) {
            return renderRenameRow(entry, depth)
          }
          if (resolved !== undefined) {
            const chain = resolved.rendered
            const tail = chain[chain.length - 1]!
            const isOpen = chain.some(link => expandedSet.has(link.path))
            return (
              <div key={entry.path}>
                <DirRow
                  entry={entry}
                  chain={chain}
                  depth={depth}
                  expanded={isOpen}
                  iconsVersion={iconsVersion}
                  service={service}
                  // Selected when the row's HEAD or its rendered TAIL is in
                  // the selection: the row's menu (and a breadcrumb segment
                  // click) address the tail, and the highlight must follow
                  // the path the interaction actually named.
                  selected={selected.has(entry.path) || selected.has(tail.path)}
                  // Reveal-anchor: a reveal names a specific directory, which
                  // may be a MID-chain link — mark the row that renders it.
                  revealed={chain.some(link => revealedSet.has(link.path))}
                  dropTarget={dropTarget === tail.path}
                  gitChanged={gitStatus.dirHasChanges(entry.path)}
                  gitDirMark={gitDirMarkOf(entry.path)}
                  copied={copiedPath === entry.path}
                  cut={cutPaths.has(entry.path) || cutPaths.has(tail.path)}
                  actions={actions}
                />
                {isOpen && renderLevel(tail.path, depth + 1)}
              </div>
            )
          }
          const git = gitStatus.statusOf(entry.path)
          return (
            <FileRow
              key={entry.path}
              entry={entry}
              depth={depth}
              iconsVersion={iconsVersion}
              service={service}
              selected={selected.has(entry.path)}
              revealed={revealedSet.has(entry.path)}
              flash={revealedSet.has(entry.path) ? flashClass : undefined}
              dropTarget={dropTarget === parentOf(entry.path)}
              gitTone={git?.tone}
              gitLetter={git?.letter}
              gitMark={gitMarkOf(entry.path)}
              copied={copiedPath === entry.path}
              cut={cutPaths.has(entry.path)}
              actions={actions}
            />
          )
        })}
        {/* The host capped this directory's listing: say so instead of
            silently showing a partial tree. */}
        {level.truncated === true && <Notice kind="hint">{t('filesTruncated')}</Notice>}
      </>
    )
  }

  return (
    <div
      ref={bodyRef}
      className={clsx(css.explorerBody, hidden === true && css.explorerHiddenPane)}
      hidden={hidden}
      onDragEnter={handleBodyDragEnter}
      onDragOver={handleBodyDragOver}
      onDragLeave={handleBodyDragLeave}
      onDrop={handleBodyDrop}
      onClick={(event) => {
        // A click on the body itself (below the last row) drops the selection.
        if (event.target === event.currentTarget) clearSelection()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearSelection()
      }}
    >
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          {/* The last mutation failure (rename/delete/mkdir/open-in-app):
              dismissable, raw server text — the same show-the-truth policy the
              fence notice uses. Any later action or a fresh attempt clears it. */}
          {actionError !== null && (
            <div className={css.explorerActionError} role="alert">
              <span className={css.explorerActionErrorText}>{actionError}</span>
              <IconButton
                size="sm"
                label={t('dismiss')}
                icon={<IconCloseFillRegular size={14} />}
                onClick={() => { setActionError(null) }}
              />
            </div>
          )}
          {/* The archive is built host-side, in one pass, while the STATUS
              poll drives `done/total`: the line sits right under the error
              strip (the two CAN coexist — a stale error stays readable while a
              new attempt is in flight). `role="status"` makes it a polite live
              region, so progress is announced without stealing focus. */}
          {/* A refresh whose batch request failed: the rows above are the
              PREVIOUS listing, so the hint explains why nothing changed. */}
          {loadError !== null && (
            <Notice kind="warn" tone="inline">{loadError}</Notice>
          )}
          {archiveBusy && (
            <Notice kind="loading" tone="inline" role="status">{t('loading')}</Notice>
          )}
          <RootRow
            path={root}
            iconsVersion={iconsVersion}
            service={service}
            dropTarget={dropTarget === root}
            gitChanged={gitStatus.dirHasChanges(root)}
            gitDirMark={gitDirMarkOf(root)}
            copied={copiedPath === root}
            actions={actions}
          />
          {renderLevel(root, 1)}
          {/* The selection bar closes the scroll container (sticky bottom): it
              sits BELOW every row, never over them, and its appearance never
              shifts the tree the way a top bar did. */}
          {selected.size > 0 && (
            <div className={css.explorerSelectionBar} role="toolbar" aria-label={t('filesSelected', { count: selected.size })}>
              <span className={css.explorerSelectionText}>{t('filesSelected', { count: selected.size })}</span>
              <span className={css.explorerSelectionActions}>
                <Chip onClick={copySelectedPaths}>{t('copyPaths')}</Chip>
                <Chip onClick={() => {
                  const armed = scopeOf(propsRef.current)
                  if (armed !== undefined) setConfirmDeleteSelected(armed)
                }}>{t('deleteSelected')}</Chip>
                <Chip onClick={clearSelection}>{t('clearSelection')}</Chip>
              </span>
            </div>
          )}
        </>
      )}
      {dropOver && dropRect !== null && createPortal(
        /*
         * The sidebar's drop surface, portaled to document.body at z-1001+ —
         * above DSH's own whole-page drop mask (z-1000, see InputBar's
         * document-level intake) so the two never compete. A LIGHT mask dims
         * the viewport: the dimmed conversation column still takes drops into
         * the chat natively (this layer is pointer-inert), while the dashed
         * frame marks the tree as the workspace-upload zone. Deliberate
         * exception to the "panel stays below the DSH float stack" rule:
         * transient, and the drop always lands on the element beneath. The
         * hint pill docks at the TOP edge of the zone — right under the
         * search row, the first thing the eye meets — keeping the rows
         * aimable.
         */
        <>
          <div className={css.uploadDropMask} />
          <div
            className={css.uploadDropZone}
            style={{
              top: dropRect.top + 2,
              left: dropRect.left + 2,
              width: dropRect.width - 4,
              height: dropRect.height - 4,
            }}
          >
            <div className={css.uploadDropHero}>
              <UploadDropIllustration />
              <div className={css.uploadDropZonePill}>
                <IconUploadOutline16 size={14} />
                <span className={css.uploadDropZoneText}>
                  {dropTarget !== null ? t('uploadTo', { dir: dropTarget }) : t('uploadDropHint')}
                </span>
              </div>
            </div>
          </div>
          {/* The left zone's invitation, centered in the space beside the
              tree; skipped when that space is too narrow to hold it. */}
          {dropRect.left >= 200 && (
            <div className={css.uploadDropChatHint} style={{ width: dropRect.left }}>
              <div className={css.uploadDropChatCard}>
                <ChatDropIllustration />
                <span>{t('uploadDropChat')}</span>
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          const dir = pendingUploadDir.current ?? root
          pendingUploadDir.current = undefined
          if (dir !== undefined && !busy) onUploadRequest(dir, uploadItemsFromFiles(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // 1-3: the "打开方式" group heads the menu — the host's default
          // handler, the one submenu holding every application (host + the
          // plugin's own, per the visibility rule) and the host's reveal.
          ...(rowMenu === null ? [] : openWithSection(rowMenu)),
          // 4: the explicit open escapes (files only).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpenRegular size={14} /> }]
            : []),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutlineRegular size={14} /> }]
            : []),
          // Directory actions: upload into, and create inside (the workspace
          // root row included).
          ...(rowMenu?.isDir === true
            ? [{ id: 'upload-here', label: t('uploadHere'), icon: <IconUploadOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === true
            ? [{ id: 'new-folder', label: t('newFolder'), icon: <IconPlusOutlineRegular size={14} /> }]
            : []),
          ...(rowMenu?.isDir === true
            ? [{ id: 'new-file', label: t('newFile'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          // 4.1:「打开终端」— a fresh bottom-terminal instance rooted at this
          // directory (the dir action group's last row; files open terminals
          // only through their directory).
          ...(rowMenu?.isDir === true && onOpenTerminalAt !== undefined
            ? [{ id: 'open-terminal', label: t('openTerminal'), icon: <VscTerminal size={14} /> }]
            : []),
          // 5: ZIP of the current selection (≥2 rows, or one lone directory).
          ...(rowMenu === null ? [] : zipEntries(rowMenu)),
          // 5.5:「添加到搜索中」— report this row to the caller's search-page
          // redirect (every row kind; the caller decides whether the submenu
          // is offered at all).
          ...(rowMenu !== null && onAddToSearch !== undefined ? [addToSearchSubmenu()] : []),
          // 5.6: the Windows clipboard trio. 复制/剪切 take the WHOLE current
          // selection (a right-click outside it already collapsed onto the
          // row) — never on the workspace root row, the root itself is not a
          // clipboard row. 黏贴 targets the row's directory (a file row → its
          // parent, the root → the workspace) and is DISABLED while the
          // clipboard is empty or from another workspace (same-tree only in
          // v1 — a cross-project paste would need path remapping).
          ...(rowMenu !== null && rowMenu.path !== cwd
            ? [
                { id: 'clip-copy', label: t('clipCopy'), icon: <IconCopyOutlineRegular size={14} /> },
                { id: 'clip-cut', label: t('clipCut'), icon: <IconCutOutline16 size={14} /> },
              ]
            : []),
          {
            id: 'clip-paste',
            label: t('clipPaste'),
            icon: <IconPasteOutline16 size={14} />,
            disabled: clipboard === null || clipboard.cwd !== cwd,
          },
          { id: 'clip-sep', type: 'separator' } as MenuEntry,
          // 6: copy, then the mutations (never on the workspace root row).
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> },
          // 6.5:「查看 Git 历史」— one path's commit log in the changes tab's
          // git lens, filtered to this path (a directory lists its whole
          // subtree). Files AND directories; never the workspace root, whose
          // history is the branch log the lens shows unfiltered anyway. Own
          // separator: a read-only island between the copy pair and the
          // destructive mutations.
          ...(rowMenu !== null && rowMenu.path !== cwd && onOpenGitHistory !== undefined
            ? [
                { id: 'git-history-sep', type: 'separator' } as MenuEntry,
                { id: 'git-history', label: t('gitHistory'), icon: <IconClockOutlineRegular size={14} /> },
              ]
            : []),
          ...(rowMenu !== null && rowMenu.path !== cwd
            ? [
                { id: 'mutate-sep', type: 'separator' } as MenuEntry,
                { id: 'rename', label: t('rename'), icon: <IconEditOutlineRegular size={14} /> },
                { id: 'delete', label: t('delete'), icon: <IconTrashOutlineRegular size={14} />, danger: true },
              ]
            : []),
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id === 'open-in-app:default') {
            openWithApp(target.path)
            return
          }
          if (id.startsWith('open-in-app:')) {
            openWithApp(target.path, id.slice('open-in-app:'.length))
            return
          }
          // The plugin's own targets share one id space (pinned rows and
          // submenu children alike), so the caller gets the target id + path.
          if (id.startsWith('open-with:')) {
            // The caller owns the launch and answers whether it was accepted;
            // a refusal (or a rejection) means nothing opened, so the failure
            // lands in the same strip as the host-backed rows instead of only
            // reaching the console (#412 was silence in this exact spot).
            const pending = onOpenWith?.(id.slice('open-with:'.length), target.path)
            void Promise.resolve(pending).then(
              (accepted) => { if (accepted === false) reportOpenFailure(target.path) },
              () => { reportOpenFailure(target.path) },
            )
            return
          }
          if (id === 'reveal-in-file-manager') {
            revealPath(target.path)
            return
          }
          if (id === 'archive-selection') {
            downloadArchive([...selected])
            return
          }
          // The clipboard trio: 复制/剪切 store the (collapsed) selection,
          // 黏贴 runs the pre-flight and — on conflicts — opens the dialog.
          if (id === 'clip-copy') {
            clipSelection('copy')
            return
          }
          if (id === 'clip-cut') {
            clipSelection('cut')
            return
          }
          if (id === 'clip-paste') {
            beginPaste(target)
            return
          }
          // 「添加到搜索中」submenu: hand the row + the picked list to the
          // caller (the id suffix IS the list; the caller parks the search
          // seed and opens a new「搜索」tab).
          if (id.startsWith('add-to-search:')) {
            onAddToSearch?.(target.path, id === 'add-to-search:include' ? 'include' : 'exclude')
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'upload-here') {
            pendingUploadDir.current = target.path
            fileInputRef.current?.click()
            return
          }
          if (id === 'new-folder') {
            startNewFolder(target.path)
            return
          }
          if (id === 'new-file') {
            startNewFile(target.path)
            return
          }
          if (id === 'open-terminal') {
            // The caller mints the terminal (a NEW bottom-terminal instance
            // aimed at the directory — never the running shell cd'd over); a
            // refusal or a rejection means nothing opened, so the failure
            // lands in the same strip as the host-backed rows instead of only
            // reaching the console (#412 was silence in this exact spot).
            const pending = onOpenTerminalAt?.(target.path)
            void Promise.resolve(pending).then(
              (opened) => { if (opened === false) reportOpenFailure(target.path) },
              () => { reportOpenFailure(target.path) },
            )
            return
          }
          // 「查看 Git 历史」: hand the row's path to the caller — it opens
          // the changes tab's git lens with the filter set (the menu closes
          // here, the history view outlives it). A refusal or a rejection
          // reports through the same strip as the host-backed rows.
          if (id === 'git-history') {
            const pending = onOpenGitHistory?.(target.path)
            void Promise.resolve(pending).then(
              (opened) => { if (opened === false) reportOpenFailure(target.path) },
              () => { reportOpenFailure(target.path) },
            )
            return
          }
          if (id === 'rename') {
            setRenaming({ path: target.path, value: baseName(target.path) })
            return
          }
          if (id === 'delete') {
            const armed = scopeOf(propsRef.current)
            if (armed === undefined) return
            setConfirmDelete({ path: target.path, isDir: target.isDir, name: baseName(target.path), scope: armed })
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The single-row delete confirmation: destructive and permanent (no host
          trash), so it always lands here first — the shared kit dialog, the
          same shape the git lens uses for discard/revert/cherry-pick. */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete === null ? '' : t('deleteTitle', { name: confirmDelete.name })}
        description={confirmDelete === null ? '' : t(confirmDelete.isDir ? 'deleteDescDir' : 'deleteDescFile')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        danger
        onConfirm={() => {
          const pending = confirmDelete
          if (pending === null) return
          setConfirmDelete(null)
          performDelete(pending)
        }}
        onClose={() => { setConfirmDelete(null) }}
      />

      {/* The batch delete: one confirmation for the whole selection, then one
          sequential fs.remove per row (the first failure stops the walk). */}
      <ConfirmDialog
        open={confirmDeleteSelected !== null}
        title={t('deleteSelectedTitle', { count: selected.size })}
        description={t('deleteSelectedDesc')}
        confirmLabel={t('deleteSelected')}
        cancelLabel={t('cancel')}
        danger
        busy={deletingSelected}
        onConfirm={() => {
          const armed = confirmDeleteSelected
          if (armed === null) return
          performBatchDelete(armed)
        }}
        onClose={() => { setConfirmDeleteSelected(null) }}
      />

      {/* The Windows-style paste-conflict dialog: fired BEFORE the transfer
          when the target level already holds same-named entries. 替换 runs
          the job with `replace` (files overwrite, directories MERGE —
          Explorer semantics), 跳过 keeps the conflicts and pastes the rest
          (the HOST skips per top-level item), 取消 closes without moving a
          byte. Modal/Button are the primitives (same chrome as the Side card
          popups); the conflicting names show as chips, truncated with an
          "and N more" line. */}
      {pasteDialog !== null && (
        <Modal
          open
          onClose={() => { setPasteDialog(null) }}
          title={t('clipConflictTitle')}
          description={t('clipConflictDesc')}
          closeLabel={t('clipCancel')}
          footer={(
            <>
              <Button variant="outline" onClick={() => { setPasteDialog(null) }}>
                {t('clipCancel')}
              </Button>
              <Button variant="outline" onClick={() => {
                const pending = pasteDialog
                setPasteDialog(null)
                runPaste(pending.scope, pending.mode, pending.entries, pending.targetDir, 'skip')
              }}>
                {t('clipSkip')}
              </Button>
              <Button variant="primary" onClick={() => {
                const pending = pasteDialog
                setPasteDialog(null)
                runPaste(pending.scope, pending.mode, pending.entries, pending.targetDir, 'replace')
              }}>
                {t('clipReplace')}
              </Button>
            </>
          )}
        >
          <div className={css.pasteConflictChips} data-dsh-paste-conflicts="">
            {pasteDialog.conflicts.slice(0, 8).map(name => (
              <span key={name} className={css.pasteConflictChip}>{name}</span>
            ))}
            {pasteDialog.conflicts.length > 8 && (
              <span className={css.pasteConflictMore}>
                {t('clipConflictMore', { count: pasteDialog.conflicts.length - 8 })}
              </span>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
