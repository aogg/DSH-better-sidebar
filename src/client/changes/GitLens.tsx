/**
 * The Git lens of the changes tab: repository truth — the changed files
 * (unstaged / staged) as a directory tree, stage/unstage, commit with a
 * message box, branch and checkout switching, and a VSCode-like history with
 * decorations, author and relative time. Clicking a changed file or a history
 * row previews it in the tab's shared bottom pane (see {@link DiffPane}); rows
 * carry right-click context menus with advanced operations (open in editor,
 * discard, revert, cherry-pick, copy paths/hashes).
 *
 * The change list is a TREE, not a flat list: {@link buildChangeTree} folds
 * each group's paths into directories (single-child chains compressed), so a
 * nested change reads as structure instead of as a wall of rows. Directory
 * rows disclose their subtree (`aria-expanded`); file rows carry the host's
 * own file artwork, the porcelain letter and the trailing stage action, which
 * only shows on hover/focus to keep the row quiet.
 *
 * The git status itself is NOT fetched here: it comes from the plugin's one
 * shared store (`ui/git-status.ts`), which the file tree also subscribes to,
 * so both surfaces color/lists the same answer from a single subscription.
 * This component owns the checkout-derived surfaces a status call cannot
 * answer (worktree inventory, branch choices, history) and every mutation.
 *
 * Two error channels, one each: the commit bar owns its single status line
 * (commit / stage / discard / revert failures), and the lens owns the top
 * banner (refresh, branch switch, history paging). Branch and history
 * failures used to land under the commit box, which read as "your commit
 * failed" for an action the user never ran.
 *
 * Refreshes fold INSTEAD of resetting: the server caches the git reads, so a
 * refresh usually answers "nothing changed" — the merge below then hands
 * back the previous array and React skips the re-render entirely — and a
 * refresh that only added commits PREPENDS them (see
 * {@link mergeLogFirstPage}), keeping the displayed rows (deep pages
 * included) and the paging position coherent. Only a real worktree/scope
 * switch (`clearDerived`) empties the surfaces.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconCodeOutlineRegular, IconCopyOutlineRegular,
  IconPlusOutlineRegular, IconSparkleRegular, IconTrashOutlineRegular, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { GitLineCounts, GitLogEntry, GitStatusEntry, GitStatusResult, GitWorktree, SessionScope } from '../api.ts'
import { api, SidebarApiError } from '../api.ts'
import { builtinFileIcon, builtinFolderIcon } from '../file-icons.tsx'
import { useGitWatch } from '../git-push.ts'
import { baseName, relativeTo } from '../paths.ts'
import { resolveSidebarPath } from '../paths.ts'
import { isZh, relativeTime, t } from '../locales.ts'
import type { SidebarDiffRef, SidebarStore } from '../state.ts'
import {
  ConfirmDialog, IconButton, Notice, SectionHeader, StatusBadge, invalidateGitStatus, statusOfXY,
  useGitStatus, type GitFileStatus, type GitTone, type StatusTone,
} from '../ui/index.ts'
import { buildChangeTree, dirPathsOf, sumLineCounts, type ChangeDir, type ChangeFile, type ChangeNode } from './change-tree.ts'
import type { LensControl } from './lens-control.ts'
import diffCss from '../diff/diff.module.css'
import css from './changes.module.css'

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  return statusOfXY(entry.xy)?.staged === true
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  return statusOfXY(entry.xy)?.unstaged === true
}

/** Whether a row is untracked (`??`): git diff never includes it, so the
 *  preview and the discard action must know. */
function isUntrackedStatus(status: GitFileStatus): boolean {
  return status.tone === 'untracked'
}

/** The porcelain tone → the kit badge tone (a copy reads as a rename). */
const BADGE_TONE: Record<GitTone, StatusTone> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'untracked',
  renamed: 'renamed',
  copied: 'renamed',
  conflict: 'conflict',
}

/** The ref names of one log row's decorations (`HEAD -> main` → `main`), deduped. */
function refNames(refs: string): string[] {
  return [...new Set(
    refs
      .split(',')
      .map(ref => ref.trim())
      .filter(ref => ref !== '')
      .map(ref => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
      .map(ref => (ref.startsWith('tag: ') ? ref.slice(5) : ref)),
  )]
}

/** One thrown value as display text (every error line here normalizes through
 *  this so non-Error rejections never render as '[object Object]'). */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm dialog. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** One open file-row context menu (cursor position for the portaled Menu). */
interface FileMenuState {
  path: string
  staged: boolean
  untracked: boolean
  x: number
  y: number
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 20

/**
 * Fold one fresh FIRST log page into the history already on screen, so a
 * refresh that only added commits prepends them instead of resetting the list
 * (the server's cache makes "nothing changed" the common case, and this makes
 * "a few commits landed" nearly as cheap visually — the rows below the new
 * heads keep their DOM identity).
 *
 * Rules, in order:
 * - An empty fresh page changes nothing (a failed read keeps the old rows; the
 *   lens's `logFailed` flag carries the failure).
 * - A different walk identity (`sameWalk`: same history path filter AND same
 *   selected checkout) or an empty list → replace wholesale: the displayed
 *   rows answer a different question than the fresh page.
 * - Otherwise locate the displayed head inside the fresh page. Everything
 *   before that position is NEW commits landed on top → prepend them and keep
 *   the old rows (deep pages included; they are re-reached by paging).
 * - The overlap must be CONTINUOUS: from the located position on, the fresh
 *   page has to repeat the displayed head element-for-element. A mid-overlap
 *   divergence (rebase / force-push / more new commits than one page) cannot
 *   be expressed as a prepend → replace wholesale and let the caller reset
 *   the paging position.
 * - A "new" entry that is already displayed deeper down would render twice
 *   (drift between merge points) — that too falls back to replace.
 *
 * Zero-change guarantee: when nothing is prepended the CURRENT array
 * reference comes back, so `setState` bails out and a cache-hit refresh
 * re-renders nothing at all.
 */
function mergeLogFirstPage(
  current: readonly GitLogEntry[],
  fresh: readonly GitLogEntry[],
  sameWalk: boolean,
): { entries: readonly GitLogEntry[]; prepended: number; replaced: boolean } {
  const replace = { entries: fresh, prepended: 0, replaced: true }
  if (fresh.length === 0) return { entries: current, prepended: 0, replaced: false }
  if (!sameWalk || current.length === 0) return replace
  const overlap = fresh.findIndex(entry => entry.hashFull === current[0]!.hashFull)
  if (overlap < 0) return replace
  for (let index = 0; overlap + index < fresh.length && index < current.length; index++) {
    if (fresh[overlap + index]!.hashFull !== current[index]!.hashFull) return replace
  }
  const added = fresh.slice(0, overlap)
  if (added.length === 0) return { entries: current, prepended: 0, replaced: false }
  const shown = new Set(current.map(entry => entry.hashFull))
  if (added.some(entry => shown.has(entry.hashFull))) return replace
  return { entries: [...added, ...current], prepended: added.length, replaced: false }
}

/** Whether two branch-name lists carry the same content (same-length check
 *  first, so a changed list short-circuits before the element compare). */
function sameNames(current: readonly string[], next: readonly string[]): boolean {
  return current.length === next.length && current.every((name, index) => name === next[index])
}

/** Whether two inventories answer the same: every row's path, branch, currency
 *  and change count must match. Every invalidation re-list mints a fresh
 *  array — content equality, not array identity, decides whether the
 *  selectors band re-renders. */
function sameWorktrees(current: readonly GitWorktree[], next: readonly GitWorktree[]): boolean {
  return current.length === next.length && current.every((entry, index) => {
    const other = next[index]!
    return entry.path === other.path && entry.branch === other.branch
      && entry.current === other.current && entry.changes === other.changes
  })
}

/** Commit-box growth contract: one line is 18px with 6px of padding above and
 *  below (mirrored by `changes.module.css`), and it scrolls past six lines. */
const COMMIT_BOX_LINE_HEIGHT = 18
const COMMIT_BOX_PADDING_Y = 6
const COMMIT_BOX_MAX_ROWS = 6

/** A stable empty entry list: the tree memo must not rebuild on every render
 *  just because `snapshot?.entries ?? []` minted a new array. */
const NO_ENTRIES: readonly GitStatusEntry[] = []

/**
 * The gitLog `opts` carrying the active history path filter: `undefined` when
 * no filter is set, so the unfiltered call's wire payload (and argv) stay
 * byte-identical to the pre-filter shape. A path — a file's, or a directory's
 * whole subtree — narrows `git log` to the commits touching it; paging still
 * works because the host's `--skip` counts commits of the FILTERED walk (the
 * same paging the tree's old history modal ran with a pathspec).
 */
function logOptsOf(filter: string | null): { path: string } | undefined {
  return filter === null || filter === '' ? undefined : { path: filter }
}

/**
 * A CONTENT key for one status answer. The shared store mints a brand-new
 * entries array for every poll — idle polls with byte-identical content
 * included — so array identity cannot decide whether the tree must be rebuilt.
 * This string can: the same paths, porcelain codes and line counts always
 * produce the same key, and a key change is exactly when the tree, its totals
 * and the row objects need to be recomputed. The counts belong in the key
 * because an edit that only moves lines leaves `xy` alone (#131): without them
 * the memoized rows would keep printing their first reading.
 */
function entriesKey(entries: readonly GitStatusEntry[]): string {
  let key = ''
  for (const entry of entries) {
    const counts = entry.counts
    const lines = counts === undefined
      ? ''
      : 'additions' in counts ? `${counts.additions}/${counts.deletions}` : 'binary'
    key += `${entry.xy}\u0000${entry.path}\u0000${lines}\n`
  }
  return key
}

/** The `+N` / `−M` pair, ink and sign included: shared by a file row and its
 *  group header so the two can never drift apart. A zero side is omitted (the
 *  diff pane's own convention), and both numbers stay on the element as
 *  `data-` attributes for the row's tests. */
function PlusMinus(props: { additions: number; deletions: number; note?: string }): ReactNode {
  return (
    <span className={css.lineCounts} data-lines={props.note ?? 'count'}
      data-added={props.additions} data-deleted={props.deletions}>
      {props.additions > 0 && <span className={diffCss.statAdd}>+{props.additions}</span>}
      {props.deletions > 0 && <span className={diffCss.statDel}>−{props.deletions}</span>}
    </span>
  )
}

/** One row's line counts (#131): the numbers for a text change, the binary
 *  mark when git has none for a blob, and "new file" for an untracked entry —
 *  git never diffs those, so there is no numstat row and `+0 −0` would be an
 *  invented number. An entry with no counts that is NOT untracked (a status
 *  answer whose numstat read failed) shows nothing at all. */
function LineCounts(props: { counts?: GitLineCounts; untracked: boolean }): ReactNode {
  const { counts } = props
  if (counts === undefined) {
    return props.untracked
      ? <span className={css.lineNote} data-lines="new">{t('changesNewFile')}</span>
      : null
  }
  if (!('additions' in counts)) return <span className={css.lineNote} data-lines="binary">{t('diffBinary')}</span>
  return <PlusMinus additions={counts.additions} deletions={counts.deletions} />
}

/** The preview ref for one changed file (one ref per path+side). */
function worktreeRefOf(
  path: string,
  untracked: boolean,
  staged: boolean,
  worktree: string | undefined,
  repoRoot: string | undefined,
): SidebarDiffRef {
  return { kind: 'worktree', path, staged, untracked, worktree, repoRoot }
}

/** One changed file's row: the host's file artwork + porcelain letter + name
 *  + the trailing stage action (revealed on hover/focus).
 *
 *  Memoized, and every prop keeps its identity across a status poll that
 *  changed nothing: the tree is content-keyed (so `node` is the same object),
 *  the callbacks are state-free, and `glyph` is a stable resolver. The icon
 *  resolution inside the row therefore doubles as the re-render probe the
 *  specs use — an idle poll must not resolve a single icon. */
const FileRow = memo(function FileRow(props: {
  row: ChangeFile
  glyph: (path: string) => ReactNode
  staged: boolean
  busy: boolean
  selected: boolean
  onPreview: (node: ChangeFile, staged: boolean) => void
  onContextMenu: (event: MouseEvent, node: ChangeFile, staged: boolean) => void
  onToggleStage: (path: string, staged: boolean) => void
}): ReactNode {
  const { row: node, staged, busy, selected } = props
  const action = staged ? t('unstage') : t('stage')
  return (
    <div className={css.row} data-row={node.path} data-selected={selected ? 'true' : undefined}>
      <button
        type="button"
        className={css.rowMain}
        data-path={node.path}
        title={node.path}
        onClick={() => { props.onPreview(node, staged) }}
        onContextMenu={(event) => { props.onContextMenu(event, node, staged) }}
      >
        <span className={css.rowIcon} aria-hidden="true">{props.glyph(node.path)}</span>
        <StatusBadge tone={BADGE_TONE[node.status.tone]} title={node.path}>{node.status.letter}</StatusBadge>
        <span className={css.rowName}>{node.name}</span>
        {/* The row's own line counts (#131): read straight off the node, so a
            poll that answered different numbers re-renders this row with them. */}
        <LineCounts counts={node.counts} untracked={node.status.tone === 'untracked'} />
      </button>
      <IconButton
        size="sm"
        className={css.rowAction}
        disabled={busy}
        label={action}
        icon={staged ? <IconTrashOutlineRegular size={14} /> : <IconPlusOutlineRegular size={14} />}
        onClick={() => { props.onToggleStage(node.path, staged) }}
      />
    </div>
  )
})

/** One directory row: the disclosure chevron + folder artwork + the label
 *  (a compressed chain reads as one 'a/b/c' line) + how much changed below,
 *  plus the SAME trailing action a file row carries — applied to the whole
 *  subtree (`git add -A -- <dir>` / `git reset -q -- <dir>`, both of which
 *  take a directory pathspec). The action is a sibling of the disclosure
 *  button, so a click can never fold the row; it stops propagation anyway so
 *  the intent survives a future nesting change. Memoized like {@link FileRow}. */
const DirRow = memo(function DirRow(props: {
  row: ChangeDir
  folderGlyph: (path: string, open: boolean) => ReactNode
  staged: boolean
  open: boolean
  busy: boolean
  onToggle: (key: string) => void
  onToggleStage: (path: string, staged: boolean) => void
}): ReactNode {
  const { row: node, staged, open, busy } = props
  const key = `${staged ? 's' : 'u'}:${node.path}`
  const action = staged ? t('unstageAll') : t('stageAll')
  return (
    <div className={css.row} data-row={node.path}>
      <button
        type="button"
        className={css.dirRow}
        data-dir={node.path}
        aria-expanded={open}
        title={node.path}
        onClick={() => { props.onToggle(key) }}
      >
        <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true">
          <IconChevronRightOutlineRegular size={12} />
        </span>
        <span className={css.rowIcon} aria-hidden="true">{props.folderGlyph(node.path, open)}</span>
        <span className={css.dirName}>{node.name}</span>
        <span className={css.countPill} data-count={node.changes}>{node.changes}</span>
      </button>
      <IconButton
        size="sm"
        className={css.rowAction}
        disabled={busy}
        label={action}
        icon={staged ? <IconTrashOutlineRegular size={14} /> : <IconPlusOutlineRegular size={14} />}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggleStage(node.path, staged)
        }}
      />
    </div>
  )
})

export interface GitLensProps {
  scope: SessionScope
  /** @deprecated The sidebar store is no longer read here (the fence guard it
   *  fed is gone); the prop stays for the caller's shape. */
  store: SidebarStore
  onOpenFile: (path: string) => void
  /** Preview one change in the shared bottom pane (worktree or commit ref). */
  onPreview: (ref: SidebarDiffRef) => void
  /** The ref currently previewed (row highlight); null when the pane is closed. */
  selectedRef: SidebarDiffRef | null
  /** Poll the inventory only while the tab is actually visible. */
  visible: boolean
  /** Bumped by the tab header's refresh action (0 = never asked). */
  refreshTick?: number
  /**
   * The active history path filter (the changes tab owns it — meta-persisted,
   * so it outlives this lens's unmount on a lens switch). An absolute path
   * from the tree's 「查看 Git 历史」, or a repo-relative pathspec typed into
   * the filter input; null = the unfiltered branch log.
   */
  pathFilter?: string | null
  /** Set/clear the history path filter (absent → the lens renders no filter
   *  UI and the prop, if any, is taken as read-only). */
  onPathFilterChange?: (next: string | null) => void
  /** The tab's context, for the registered file/folder icon chain (absent →
   *  the host's built-in artwork, exactly like the file tree falls back). */
  ctx?: Context
}

/**
 * The Git lens: the repository's own view, plus the fold handle the tab
 * header's 「全部展开」/「全部收起」 drives — expand clears the collapsed set
 * (every directory row of both groups opens, exactly the born state),
 * collapse fills it with every directory row of BOTH trees, keyed per group
 * (`s:`/`u:`) so the two never fight over one row.
 */
export const GitLens = forwardRef<LensControl, GitLensProps>(function GitLens(props, ref) {
  const { scope, onOpenFile, onPreview, selectedRef, visible, refreshTick = 0, ctx, pathFilter = null, onPathFilterChange } = props
  /** The filter at call time: the refresh chain's callbacks are stable, so
   *  they read the CURRENT filter through this ref instead of closing over
   *  the prop that was live when they were built. */
  const pathFilterRef = useRef(pathFilter)
  pathFilterRef.current = pathFilter

  const service = ctx?.get('betterSidebar')
  /** The file row's artwork: a registered icon wins, else the host's own
   *  (the same chain the file tree runs, so both pages agree). */
  const fileGlyph = useCallback((path: string): ReactNode => (
    service === undefined ? builtinFileIcon(path, 14) : service.fileIcon(path, 14)
  ), [service])
  const folderGlyph = useCallback((path: string, open: boolean): ReactNode => (
    service === undefined ? builtinFolderIcon(open, 14) : service.folderIcon(path, open, 14)
  ), [service])

  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [repoRoot, setRepoRoot] = useState<string | undefined>()
  /** Every repository of the session workspace, kept once discovered: the
   *  status of a SELECTED child reports only itself, so the selector's option
   *  list cannot be re-derived from the current snapshot alone. */
  const [repoChoices, setRepoChoices] = useState<string[]>([])
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  /** The history's live mirror, readable by the async refresh chain without
   *  depending on render-scoped state (the merge and the paging position are
   *  decided OUTSIDE any setState updater, which React may invoke twice). */
  const logEntriesRef = useRef<readonly GitLogEntry[]>([])
  /** Publish one history list: the ref mirrors first, then state. When the
   *  list is the SAME reference React bails the update out — the zero-change
   *  refresh renders nothing. Stable identity: the refresh chain's callbacks
   *  capture it once. */
  const publishLog = useCallback((entries: readonly GitLogEntry[]): void => {
    logEntriesRef.current = entries
    setLogEntries(entries as GitLogEntry[])
  }, [])
  /** The walk identity the displayed history answers to: the history path
   *  filter AND the selected checkout. A refresh may fold its fresh first
   *  page into the displayed rows only when both still match; anything else
   *  (a filter edit, a worktree switch) replaces the list wholesale. */
  const logWalkRef = useRef<{ path: string | null; target: string | undefined }>({ path: null, target: undefined })
  /**
   * The `--skip` position the NEXT history page starts at — the walk position
   * the displayed list ends at, NOT the displayed row count. The two are the
   * same while the list is a plain prefix walk of HEAD, but a prepend of k
   * new commits shifts every walk position by k while adding exactly k rows,
   * so the ref advances by k with the list and paging stays aligned (no
   * repeats, no skipped commits). Rewrites between merge points can make the
   * displayed set diverge from the walk; the load-more dedupe drops any
   * already-displayed entry from the VIEW while the walk position still
   * advances by the fetched page's own length, so a phantom can never append
   * twice.
   */
  const logSkipRef = useRef(0)
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)
  /** The history's own failure state: an empty list must not claim "no commits"
   *  when the log call failed. */
  const [logFailed, setLogFailed] = useState(false)
  /** Commit drafts, one per scope: the Commit button asks only for a message
   *  and a staged row, so a draft typed against another project would submit
   *  verbatim under this one. Keyed rather than cleared on a scope swap, so a
   *  kept-mounted tab shows a conversation its own message when it comes back
   *  (#712). */
  const [commitDrafts, setCommitDrafts] = useState<Record<string, string>>({})
  const draftKey = `${scope.sessionId}\u0000${scope.cwd ?? ''}`
  const commitMsg = commitDrafts[draftKey] ?? ''
  const writeDraft = (text: string): void => {
    setCommitDrafts(prev => ({ ...prev, [draftKey]: text }))
  }
  const [busy, setBusy] = useState(false)
  /** Whether a commit-message suggestion is being generated host-side (the
   *  host streams the diff through the harness LLM — no agent is spawned). */
  const [suggesting, setSuggesting] = useState(false)
  /** The route the next suggestion would use, for the button's tooltip. */
  const [commitModel, setCommitModel] = useState<string | undefined>(undefined)
  /** Whether a COMMIT is in flight (a subset of `busy`, which also covers
   *  staging/checkout): the input reports it with its own busy label. */
  const [committing, setCommitting] = useState(false)
  /** The commit box grows with its text, up to the scroll cap below. */
  const commitBoxRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const box = commitBoxRef.current
    // A layout-less environment (tests) reports 0: leave the CSS height alone.
    if (box === null || box.scrollHeight === 0) return
    const max = COMMIT_BOX_LINE_HEIGHT * COMMIT_BOX_MAX_ROWS + COMMIT_BOX_PADDING_Y * 2
    // Reset first: a scrollHeight measured against the current height can only
    // ever grow, so a deleted line would leave the box too tall.
    box.style.height = 'auto'
    const next = Math.min(box.scrollHeight, max)
    box.style.height = `${next}px`
    box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden'
  }, [commitMsg])
  /** The commit bar's ONE status line (commit / stage / discard / revert). */
  const [actionError, setActionError] = useState<string | null>(null)
  /** The lens-level error banner (refresh / branch switch / history paging). */
  const [viewError, setViewError] = useState<string | null>(null)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /** Collapsed directory rows, keyed per GROUP + path: a directory that has
   *  changes on both sides folds independently in each section (and the two
   *  groups never fight over one key). Default: everything expanded. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** The path-filter input's buffer (the inactive half of the filter UI; a
   *  committed filter replaces the input with its chip). */
  const [filterDraft, setFilterDraft] = useState('')

  /** The selected checkout, readable synchronously by the refresh chain
   *  without making every callback depend on the state it writes. */
  const chosenPathRef = useRef<string | undefined>(undefined)
  /** The automatic preference for a dirty linked checkout runs ONCE per
   *  scope: after it (or after any explicit user choice) a later re-list
   *  must never yank the view off the checkout the user is working in. */
  const autoSelectDone = useRef(false)
  /** The scope and repo the git calls target, readable at call time: a repo
   *  switch refreshes with the NEW root even before React re-renders. */
  const scopeRef = useRef<{ sessionId: string; cwd: string | undefined }>({ sessionId: scope.sessionId, cwd: scope.cwd })
  const repoRootRef = useRef<string | undefined>(undefined)
  /** Bumped whenever the scope resets: a late response of the previous scope
   *  can never publish rows into the new one. */
  const scopeGen = useRef(0)
  /** The refresh chain's queue: a request landing while one runs is replayed
   *  once after it settles — a manual refresh is never silently dropped. */
  const gate = useRef({ inFlight: false, queued: false, queuedSilent: true })

  useEffect(() => { scopeRef.current = { sessionId: scope.sessionId, cwd: scope.cwd } }, [scope.sessionId, scope.cwd])

  /** The session scope every git call of this lens targets right now. */
  const gitScopeNow = useCallback((): SessionScope => {
    const base = scopeRef.current
    return repoRootRef.current === undefined ? { ...base } : { ...base, repoRoot: repoRootRef.current }
  }, [])

  /** Label the generate button with the model the next suggestion would use.
   *  Re-read whenever the panel becomes visible: the pinned route lives in the
   *  side card settings, so a change made there lands on the next visit. */
  const scopeSessionId = scope.sessionId
  const scopeCwd = scope.cwd
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    api.gitCommitModel({ sessionId: scopeSessionId, ...(scopeCwd === undefined ? {} : { cwd: scopeCwd }) })
      .then(view => {
        if (cancelled) return
        setCommitModel(view.route === undefined ? undefined : `${view.route.provider}/${view.route.model}`)
      })
      .catch(() => { if (!cancelled) setCommitModel(undefined) })
    return () => { cancelled = true }
  }, [visible, scopeSessionId, scopeCwd])

  // Keep the session cwd and pass the child selection explicitly: an attached
  // session overrides client cwd, so changing cwd alone still reads the first
  // repository. The status store includes repoRoot in its cache key.
  // The status store keys on `worktree`; the PRIMARY checkout is exactly what
  // an unscoped status call resolves to, so passing its path would mint a
  // second key (and a second 2.5s `git status` poll) for the same answer the
  // file tree already subscribes to. Only a LINKED checkout narrows the key.
  const primaryWorktree = worktrees.find(entry => entry.current)?.path
  const statusWorktree = selectedWorktree !== undefined && selectedWorktree !== primaryWorktree
    ? selectedWorktree
    : undefined
  const status = useGitStatus(
    { sessionId: scope.sessionId, cwd: scope.cwd, repoRoot },
    { worktree: statusWorktree, visible },
  )
  const snapshot: GitStatusResult | null = status.snapshot
  useEffect(() => {
    const repositories = snapshot?.repositories
    if (repositories !== undefined && repositories.length > 1) setRepoChoices(repositories)
  }, [snapshot])

  /** Select one checkout (or none) and remember the choice synchronously. */
  const selectWorktree = (target: string | undefined): void => {
    chosenPathRef.current = target
    setSelectedWorktree(target)
  }

  /** Drop every checkout-derived surface before another one loads. ONLY a
   *  real worktree/scope switch may run this — a plain refresh must keep the
   *  history on screen while it revalidates (the merge below handles the
   *  outcome), so the list never blanks out mid-refresh. The walk identity
   *  and the paging position belong to the OLD checkout and reset with it.
   *  Stable identity (everything below is a setter or a ref) so the refresh
   *  chain's callbacks can list it as a dependency without churning. */
  const clearDerived = useCallback((): void => {
    setBranchNames([])
    publishLog([])
    setLogEnded(false)
    setLogLoadingMore(false)
    setLogFailed(false)
    setActionError(null)
    logWalkRef.current = { path: null, target: undefined }
    logSkipRef.current = 0
  }, [publishLog])

  /** Load the branch choices and the first history page of one checkout.
   *  The history folds INCREMENTALLY: same walk (filter + checkout) and a
   *  continuous overlap → only the new heads are prepended (rows keep their
   *  identity); otherwise the first page replaces the list and paging resets.
   *  A refresh whose answer matches what is displayed touches no state the
   *  list reads — the server cache makes that the steady state. */
  const loadTarget = useCallback(async (target: string | undefined): Promise<void> => {
    const generation = scopeGen.current
    const gitScope = gitScopeNow()
    const [branchResult, logResult] = await Promise.all([
      api.gitBranch(gitScope, target).catch(() => ({ current: '', names: [] as string[] })),
      api.gitLog(gitScope, LOG_BATCH, 0, target, undefined, logOptsOf(pathFilterRef.current)).then(
        entries => ({ entries, failed: false }),
        () => ({ entries: [] as GitLogEntry[], failed: true }),
      ),
    ])
    if (generation !== scopeGen.current) return
    // Content-guarded: an unchanged branch answer must not re-render the
    // selectors band.
    setBranchNames(names => (sameNames(names, branchResult.names) ? names : branchResult.names))
    setLogFailed(logResult.failed)
    if (logResult.failed) {
      // A failed read keeps the displayed history (never blank a working list
      // because one refresh failed); the error shows through `logFailed` when
      // the list is empty. The paging position and walk identity stay as they
      // were — they still describe the rows on screen.
      return
    }
    const filter = pathFilterRef.current
    const walk = logWalkRef.current
    const merged = mergeLogFirstPage(logEntriesRef.current, logResult.entries, walk.path === filter && walk.target === target)
    logWalkRef.current = { path: filter, target }
    if (merged.replaced) logSkipRef.current = logResult.entries.length
    else logSkipRef.current += merged.prepended
    publishLog(merged.entries)
    setLogEnded(logResult.entries.length < LOG_BATCH)
  }, [gitScopeNow, publishLog])

  /** One listing pass: re-read the worktree inventory, apply the first-pass
   *  automatic selection, then load the chosen checkout's derived surfaces.
   *  The shared status store follows the same selection on its own. */
  const runOnce = useCallback(async (silent: boolean, signal?: AbortSignal): Promise<void> => {
    const generation = scopeGen.current
    let listed: GitWorktree[]
    try {
      listed = await api.gitWorktrees(gitScopeNow(), signal)
    } catch (reason) {
      if (signal?.aborted !== true && generation === scopeGen.current) setViewError(errorMessage(reason))
      return
    }
    if (signal?.aborted === true || generation !== scopeGen.current) return
    // Content-guarded: a poll whose inventory answered identically keeps the
    // previous array reference, so the selectors band does not re-render.
    setWorktrees(previous => (sameWorktrees(previous, listed) ? previous : listed))
    const current = listed.find(entry => entry.current)
    const stillListed = chosenPathRef.current !== undefined
      && listed.some(entry => entry.path === chosenPathRef.current)
    let target = stillListed ? chosenPathRef.current : current?.path
    if (!autoSelectDone.current) {
      // DSH and other coding agents commonly create ONE linked checkout while
      // the session remains rooted at the clean primary checkout. Select that
      // checkout automatically only when the choice is unambiguous — and only
      // on this first pass, never again.
      const dirtyLinked = listed.filter(entry => !entry.current && entry.changes > 0)
      if ((current?.changes ?? 0) === 0 && dirtyLinked.length === 1) {
        target = dirtyLinked[0]!.path
        autoSelectDone.current = true
      } else if (current !== undefined) {
        target = current.path
        autoSelectDone.current = true
      }
    }
    const targetChanged = target !== chosenPathRef.current
    if (targetChanged) {
      selectWorktree(target)
      clearDerived()
    }
    // A silent tick only keeps the inventory (and its change counts) fresh.
    if (silent && !targetChanged) return
    await loadTarget(target)
  }, [gitScopeNow, loadTarget, clearDerived])

  /** Run one refresh, replaying a request that arrives mid-flight exactly once. */
  const refresh = useCallback(async (silent = false, signal?: AbortSignal): Promise<void> => {
    const current = gate.current
    if (current.inFlight) {
      current.queued = true
      if (!silent) current.queuedSilent = false
      return
    }
    current.inFlight = true
    let nextSilent = silent
    try {
      for (;;) {
        current.queued = false
        current.queuedSilent = true
        if (signal?.aborted === true) break
        if (!nextSilent) setViewError(null)
        await runOnce(nextSilent, signal)
        if (!current.queued) break
        nextSilent = current.queuedSilent
      }
    } finally {
      current.inFlight = false
    }
  }, [runOnce])

  // Mount / scope change: reset every piece of per-scope state, then load.
  // A tab mounted while hidden loads nothing (its status store has no visible
  // consumer either); the rising-edge catch-up below loads it on screen.
  useEffect(() => {
    scopeGen.current += 1
    gate.current = { inFlight: false, queued: false, queuedSilent: true }
    autoSelectDone.current = false
    chosenPathRef.current = undefined
    repoRootRef.current = undefined
    setWorktrees([])
    setSelectedWorktree(undefined)
    setRepoRoot(undefined)
    setRepoChoices([])
    clearDerived()
    setViewError(null)
    // The three destructive entry points are aimed at a ROW of the previous
    // scope: the menus carry that row's path and `confirmPending` executes a
    // closure over it, while `gitScopeNow()` already reads the NEW scope — so
    // a discard/revert/cherry-pick confirmed here would land in the project
    // that took over the pane (same class as the file tree's cross-session
    // delete).
    setFileMenu(null)
    setHistoryMenu(null)
    setConfirm(null)
    if (visible) void refresh(false)
    // Granular scope fields: the refresh identity is stable, only a real
    // session/cwd change restarts the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])

  // Becoming visible (or visible again): catch the derived surfaces up. The
  // shared status re-fetches on the same edge (its store drops the snapshot
  // when the last consumer goes away), so both halves of the lens agree.
  const wasVisible = useRef(visible)
  useEffect(() => {
    const rising = visible && !wasVisible.current
    wasVisible.current = visible
    if (!rising) return
    void refresh(false)
    // Granular scope fields: only the visibility edge drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // The header's refresh action: re-read the inventory and derived surfaces,
  // and force the SHARED status of this session (the file tree's colors too).
  useEffect(() => {
    if (refreshTick === 0) return
    void refresh(false)
    invalidateGitStatus(scope.sessionId)
    // Only the tick drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick])

  // A path-filter change rewrites the history's source list: reload through
  // the usual refresh chain (loadTarget reads the NEW filter through the
  // ref). The mount/visibility loads already ran with the initial filter, so
  // the first effect pass is skipped — only real edits reload.
  const filterLoadArmed = useRef(false)
  useEffect(() => {
    if (!filterLoadArmed.current) {
      filterLoadArmed.current = true
      return
    }
    void refresh(false)
    // Only the filter drives this effect; `refresh` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathFilter])

  // The inventory's push subscription: the host names the checkout whose git
  // state moved (files or .git metadata), replacing the old 30 s inventory
  // poll. A linked checkout the agent creates mid-session lands as a
  // `.git/worktrees` event on the MAIN checkout's watch — the silent refresh
  // below re-lists it and the watch set grows with the answer. The selected
  // checkout's status arrives through the store's own subscription.
  useGitWatch({
    worktrees: visible ? worktrees.map(entry => entry.path) : [],
    onInvalidate: () => { void refresh(true) },
    // The shared socket re-opened after a drop: every notice the outage
    // swallowed is gone, so this one catch-up runs the FULL refresh.
    onReconnect: () => { void refresh(false) },
  })

  /** Run one mutating git action: lock the bar, refresh the shared status and
   *  the derived surfaces on success, and report the failure in the commit
   *  bar's single status line (never as an unhandled rejection). */
  const runAction = async (
    action: () => Promise<unknown>,
    failure: (reason: unknown) => string = errorMessage,
    onSuccess?: () => void,
  ): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      onSuccess?.()
      invalidateGitStatus(scope.sessionId)
      await refresh(false)
    } catch (reason) {
      setActionError(failure(reason))
    } finally {
      setBusy(false)
    }
  }

  const stageError = (reason: unknown): string => t('changesStageFailed', { message: errorMessage(reason) })

  /** The remote actions prepend their own label: git's message for a missing
   *  upstream or a diverged branch says nothing about which button ran. */
  const pushError = (reason: unknown): string => `${t('pushError')}: ${errorMessage(reason)}`
  const pullError = (reason: unknown): string => `${t('pullError')}: ${errorMessage(reason)}`

  const stageEntry = (path: string, staged: boolean): void => {
    void runAction(
      () => (staged ? api.gitUnstage(gitScopeNow(), path, selectedWorktree) : api.gitStage(gitScopeNow(), path, selectedWorktree)),
      stageError,
    )
  }

  const stageAll = (staged: boolean): void => {
    void runAction(
      () => (staged ? api.gitUnstage(gitScopeNow(), undefined, selectedWorktree) : api.gitStage(gitScopeNow(), undefined, selectedWorktree)),
      stageError,
    )
  }

  const commit = (): void => {
    const message = commitMsg.trim()
    if (message === '' || busy || suggesting) return
    setCommitting(true)
    void runAction(
      () => api.gitCommit(gitScopeNow(), message, selectedWorktree),
      errorMessage,
      () => { writeDraft('') },
    ).finally(() => { setCommitting(false) })
  }

  /** The generate button's label/tooltip: names the model when one resolves,
   *  so the user knows which provider the draft will run on. */
  const generateLabel = commitModel === undefined
    ? t('generateCommitMessage')
    : t('generateCommitMessageWith', { model: commitModel })

  /** Ask the host to draft a commit message from the pending changes, then
   *  fill the message box (still editable; regenerating is allowed). */
  const suggestMessage = async (): Promise<void> => {
    if (busy || suggesting) return
    setSuggesting(true)
    setActionError(null)
    try {
      const { message } = await api.gitSuggestMessage(gitScopeNow(), isZh() ? 'zh' : 'en', selectedWorktree)
      writeDraft(message)
    } catch (reason) {
      if (reason instanceof SidebarApiError && reason.code === 'git-suggest-empty') {
        setActionError(t('suggestCommitEmpty'))
      } else {
        setActionError(`${t('suggestCommitError')}: ${errorMessage(reason)}`)
      }
    } finally {
      setSuggesting(false)
    }
  }

  /** Push the selected checkout's branch. Local commits and the remote ride the
   *  SAME status line as every other git action — the failures share one cause
   *  (no upstream, auth, divergence), so a second error channel would only
   *  split the user's attention. */
  const push = (): void => {
    void runAction(() => api.gitPush(gitScopeNow(), selectedWorktree), pushError)
  }

  /** Pull into the selected checkout (fast-forward only host-side). */
  const pull = (): void => {
    void runAction(() => api.gitPull(gitScopeNow(), selectedWorktree), pullError)
  }

  /** Switching the selected checkout changes which rows are legitimate to act
   *  on: clear the derived surfaces before the asynchronous refresh resolves
   *  so a stale history row can never run over the new checkout's repository. */
  const chooseWorktree = (target: string): void => {
    if (target === chosenPathRef.current) return
    autoSelectDone.current = true
    selectWorktree(target)
    clearDerived()
    void refresh(false)
  }

  /** Switching the selected child repository: both the inventory and the
   *  status key follow the new root, and exactly ONE full refresh runs. The
   *  checkout choice resets to the new repository's current one — an explicit
   *  user choice never triggers the automatic linked-checkout preference. */
  const chooseRepo = (target: string): void => {
    if (target === repoRoot) return
    autoSelectDone.current = true
    chosenPathRef.current = undefined
    repoRootRef.current = target
    setSelectedWorktree(undefined)
    setRepoRoot(target)
    setWorktrees([])
    clearDerived()
    void refresh(false)
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === (snapshot?.branch ?? '') || busy) return
    setBusy(true)
    setViewError(null)
    try {
      await api.gitCheckout(gitScopeNow(), branch, selectedWorktree)
      invalidateGitStatus(scope.sessionId)
      await refresh(false)
    } catch (reason) {
      setViewError(`${t('checkoutError')}: ${errorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Run one destructive operation after the confirm dialog, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm(confirmState)
  }

  const confirmPending = (): void => {
    const pending = confirm
    if (pending === null) return
    setConfirm(null)
    void runAction(pending.onConfirm)
  }

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    const generation = scopeGen.current
    const target = chosenPathRef.current
    setLogLoadingMore(true)
    setViewError(null)
    try {
      // The path filter rides EVERY page (the first as much as this one), and
      // the skip counts commits of the filtered walk host-side (`git log
      // --skip` applies after the pathspec narrows the commit walk), so the
      // "shorter batch = end of log" rule below holds filtered as-is.
      //
      // `logSkipRef` — not the displayed row count — is the paging position:
      // an incremental merge that prepended k new commits shifted the walk by
      // exactly k rows (see the ref's contract above), so this continues
      // right after the last displayed commit. Entries already displayed (a
      // rewrite landing between two merges) are dropped from the view, while
      // the walk position still advances by the fetched page's own length —
      // dedupe can hide a row, never duplicate one, and never advances the
      // walk less than the page consumed.
      const next = await api.gitLog(gitScopeNow(), LOG_BATCH, logSkipRef.current, target, undefined, logOptsOf(pathFilterRef.current))
      // A worktree switch clears the old history; never append a late page
      // from that checkout into the new one.
      if (generation !== scopeGen.current || target !== chosenPathRef.current) return
      const shown = new Set(logEntriesRef.current.map(entry => entry.hashFull))
      const appended = next.filter(entry => !shown.has(entry.hashFull))
      logSkipRef.current += next.length
      if (appended.length > 0) publishLog([...logEntriesRef.current, ...appended])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      if (generation === scopeGen.current && target === chosenPathRef.current) {
        setViewError(`${t('historyLoadError')}: ${errorMessage(reason)}`)
      }
    } finally {
      if (generation === scopeGen.current && target === chosenPathRef.current) setLogLoadingMore(false)
    }
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openHistoryMenu = (event: MouseEvent, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  /** The preview ref for one commit. */
  const commitRefOf = (entry: GitLogEntry): SidebarDiffRef => ({
    kind: 'commit',
    hash: entry.hash,
    hashFull: entry.hashFull,
    subject: entry.subject,
    worktree: selectedWorktree,
    repoRoot,
  })

  /** Whether a worktree row is the one currently previewed. */
  const isPreviewedWorktree = (path: string, staged: boolean): boolean => {
    if (selectedRef === null || selectedRef.kind !== 'worktree') return false
    return selectedRef.path === path && selectedRef.staged === staged
      && (selectedRef.worktree ?? '') === (selectedWorktree ?? '')
  }

  const entries = snapshot?.entries ?? NO_ENTRIES
  // The CONTENT of the answer decides whether the tree must be rebuilt; the
  // array identity only decides whether the (cheap) key is recomputed.
  const contentKey = useMemo(() => entriesKey(entries), [entries])
  // One fold per group, rebuilt only when the change list's CONTENT changes —
  // never on a poll that answered the same files, however fresh its arrays are.
  const { stagedEntries, unstagedEntries, stagedTree, unstagedTree } = useMemo(() => {
    const staged = entries.filter(isStagedEntry)
    const unstaged = entries.filter(isUnstagedEntry)
    return {
      stagedEntries: staged,
      unstagedEntries: unstaged,
      stagedTree: buildChangeTree(staged),
      unstagedTree: buildChangeTree(unstaged),
    }
    // The key stands in for `entries`: same content ⇒ same tree objects ⇒ the
    // memoized rows below keep their props and never re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey])
  // The band totals (#131) sum the very nodes the rows render, so the header
  // can never disagree with the numbers printed under it.
  const unstagedTotal = useMemo(() => sumLineCounts(unstagedTree), [unstagedTree])
  const stagedTotal = useMemo(() => sumLineCounts(stagedTree), [stagedTree])
  const isRepo = snapshot?.isRepo === true
  const branch = snapshot?.branch ?? ''
  const branchOptions = branch === '' ? branchNames : [branch, ...branchNames.filter(name => name !== branch)]
  const clean = isRepo && stagedEntries.length === 0 && unstagedEntries.length === 0

  /** Fold or unfold one directory row (keyed per group, see `collapsed`).
   *  Stable: it is a memoized row's prop. */
  const toggleDir = useCallback((key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // The tab header's 全部展开/全部收起: recreated per render, so the handle
  // always closes over the CURRENT trees (collapse-all collects the real
  // directory rows of both groups — a compressed chain contributes its own
  // row key, never the swallowed intermediates that have no row).
  useImperativeHandle(ref, (): LensControl => ({
    expandAll: (): void => { setCollapsed(new Set()) },
    collapseAll: (): void => {
      const keys = new Set<string>()
      for (const staged of [false, true]) {
        for (const path of dirPathsOf(staged ? stagedTree : unstagedTree)) {
          keys.add(`${staged ? 's' : 'u'}:${path}`)
        }
      }
      setCollapsed(keys)
    },
  }))

  /** The latest-value holder for the actions a memoized row calls: a row's
   *  props must keep their identity across polls, so these callbacks read the
   *  current closures through the ref instead of closing over them. */
  const rowActions = useRef({
    preview: (_node: ChangeFile, _staged: boolean): void => { /* replaced below */ },
    stage: (_path: string, _staged: boolean): void => { /* replaced below */ },
  })
  useEffect(() => {
    rowActions.current = {
      preview: (node, staged) => {
        onPreview(worktreeRefOf(node.path, isUntrackedStatus(node.status), staged, chosenPathRef.current, repoRootRef.current))
      },
      stage: (path, staged) => { stageEntry(path, staged) },
    }
  })

  /** Stable row callbacks (see rowActions). */
  const previewFile = useCallback((node: ChangeFile, staged: boolean): void => {
    rowActions.current.preview(node, staged)
  }, [])
  const stagePath = useCallback((path: string, staged: boolean): void => {
    rowActions.current.stage(path, staged)
  }, [])
  const openRowMenu = useCallback((event: MouseEvent, node: ChangeFile, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ path: node.path, staged, untracked: isUntrackedStatus(node.status), x: event.clientX, y: event.clientY })
  }, [])

  /** One file row of a group's tree (the single file-row renderer). */
  const renderFile = (node: ChangeFile, staged: boolean): ReactNode => (
    <FileRow
      key={`file:${staged ? 's' : 'u'}:${node.path}`}
      row={node}
      glyph={fileGlyph}
      staged={staged}
      busy={busy}
      selected={isPreviewedWorktree(node.path, staged)}
      onPreview={previewFile}
      onContextMenu={openRowMenu}
      onToggleStage={stagePath}
    />
  )

  /** One directory row plus its (default-expanded) subtree. */
  const renderDir = (node: ChangeDir, staged: boolean): ReactNode => {
    const key = `${staged ? 's' : 'u'}:${node.path}`
    const open = !collapsed.has(key)
    return (
      <div key={`dir:${key}`}>
        <DirRow
          row={node}
          folderGlyph={folderGlyph}
          staged={staged}
          open={open}
          busy={busy}
          onToggle={toggleDir}
          onToggleStage={stagePath}
        />
        {open && (
          <div className={css.treeChildren}>
            {node.children.map(child => (child.kind === 'dir' ? renderDir(child, staged) : renderFile(child, staged)))}
          </div>
        )}
      </div>
    )
  }

  /** One group's whole tree. */
  const renderTree = (nodes: readonly ChangeNode[], staged: boolean): ReactNode => (
    <div className={css.tree}>
      {nodes.map(node => (node.kind === 'dir' ? renderDir(node, staged) : renderFile(node, staged)))}
    </div>
  )

  return (
    <div className={css.git} data-git-root>
      {/* The non-scrolling head: the branch / repository / worktree band stays
          on screen while the change list and the history scroll under it
          (#194). */}
      {(repoChoices.length > 1 || worktrees.length > 1 || branch !== '') && (
        <div className={css.selectors} data-git-head>
          {repoChoices.length > 1 && (
            <select
              className={css.select}
              value={repoRoot ?? ''}
              title={repoRoot}
              disabled={busy}
              onChange={(event) => { chooseRepo(event.target.value) }}
            >
              {repoChoices.map(root => <option key={root} value={root}>{baseName(root)}</option>)}
            </select>
          )}
          {worktrees.length > 1 && (
            <select
              className={css.select}
              value={selectedWorktree ?? ''}
              title={selectedWorktree}
              disabled={busy}
              onChange={(event) => { chooseWorktree(event.target.value) }}
            >
              {worktrees.map(entry => (
                <option key={entry.path} value={entry.path}>
                  {entry.branch} · {baseName(entry.path)} ({entry.changes})
                </option>
              ))}
            </select>
          )}
          {branch !== '' && (branchOptions.length > 1
            ? (
              <select
                className={css.select}
                value={branch}
                title={t('branch')}
                disabled={busy}
                onChange={(event) => { void checkout(event.target.value) }}
              >
                {branchOptions.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            )
            : <span className={css.branchLabel} title={`${t('branch')}: ${branch}`}>{branch}</span>)}
        </div>
      )}

      {/* The history path filter — the 「查看 Git 历史」 hand-off's visible
          half. Inactive: one input (Enter commits a repo-relative pathspec);
          active: the chip names the path the log is narrowed to (workspace-
          relative when it sits under the window, absolute otherwise) with a
          clear button that reloads the full branch log. Lives in the
          non-scrolling head like the selectors above, so the filter stays
          readable while the filtered list scrolls under it. */}
      {isRepo && onPathFilterChange !== undefined && (
        <div className={css.pathFilter} data-git-path-filter="">
          {pathFilter === null ? (
            <input
              className={css.pathFilterInput}
              type="text"
              placeholder={t('gitLensPathFilter')}
              aria-label={t('gitLensPathFilter')}
              value={filterDraft}
              onChange={(event) => { setFilterDraft(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  const next = filterDraft.trim()
                  if (next !== '') onPathFilterChange(next)
                }
                if (event.key === 'Escape') setFilterDraft('')
              }}
            />
          ) : (
            <span
              className={css.pathFilterChip}
              title={`${t('gitLensPathFilter')}: ${pathFilter}`}
            >
              <span className={css.pathFilterPath}>{relativeTo(repoRoot ?? selectedWorktree ?? scope.cwd ?? '', pathFilter)}</span>
              <button
                type="button"
                className={css.pathFilterClear}
                aria-label={t('gitLensPathFilterClear')}
                title={t('gitLensPathFilterClear')}
                onClick={() => {
                  setFilterDraft('')
                  onPathFilterChange(null)
                }}
              >
                <IconCloseOutlineRegular size={11} />
              </button>
            </span>
          )}
        </div>
      )}

      {/* The ONE scroll body: the change groups and the history scroll here,
          between the fixed head band and the fixed commit bar (#194). */}
      <div className={css.gitScroll} data-git-scroll>
        {viewError !== null && <Notice kind="error" role="alert">{viewError}</Notice>}

        {snapshot === null && status.loading && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
        {snapshot === null && !status.loading && status.error && <Notice kind="error" tone="page">{t('error')}</Notice>}
        {snapshot !== null && !isRepo && <Notice kind="empty" tone="page">{t('notRepo')}</Notice>}
        {snapshot?.truncated === true && <Notice kind="warn">{t('statusTruncated')}</Notice>}

        {clean && <Notice kind="empty" tone="page">{t('changesClean')}</Notice>}

        {isRepo && !clean && (
          <>
            {/* Each group is its own block so its sticky header is released (and
                replaced) exactly when the group scrolls away. */}
            <div className={css.group} data-group="unstaged">
              <SectionHeader
                className={css.groupHeader}
                label={t('unstaged')}
                action={unstagedEntries.length > 0
                  ? (
                    <IconButton
                      className={css.headerAction}
                      size="sm"
                      disabled={busy}
                      label={t('stageAll')}
                      icon={<IconPlusOutlineRegular size={14} />}
                      onClick={() => { stageAll(false) }}
                    />
                  )
                  : undefined}
              >
                <span className={css.countPill} data-count={unstagedEntries.length}>{unstagedEntries.length}</span>
                {/* The group's line total (#131): the sum of its file rows. */}
                {unstagedTotal.files > 0 && (
                  <PlusMinus additions={unstagedTotal.additions} deletions={unstagedTotal.deletions} note="group" />
                )}
              </SectionHeader>
              {renderTree(unstagedTree, false)}
            </div>
            <div className={css.group} data-group="staged">
              <SectionHeader
                className={css.groupHeader}
                label={t('staged')}
                action={stagedEntries.length > 0
                  ? (
                    <IconButton
                      className={css.headerAction}
                      size="sm"
                      disabled={busy}
                      label={t('unstageAll')}
                      icon={<IconTrashOutlineRegular size={14} />}
                      onClick={() => { stageAll(true) }}
                    />
                  )
                  : undefined}
              >
                <span className={css.countPill} data-count={stagedEntries.length}>{stagedEntries.length}</span>
                {stagedTotal.files > 0 && (
                  <PlusMinus additions={stagedTotal.additions} deletions={stagedTotal.deletions} note="group" />
                )}
              </SectionHeader>
              {renderTree(stagedTree, true)}
            </div>
          </>
        )}

        {isRepo && (
          <>
            <SectionHeader label={t('history')} count={logEntries.length > 0 ? logEntries.length : undefined} />
            {logEntries.length === 0 && logFailed && <Notice kind="error">{t('historyLoadError')}</Notice>}
            {logEntries.length === 0 && !logFailed && logEnded && <Notice kind="empty" tone="page">{t('changesNoHistory')}</Notice>}
            {logEntries.map(entry => (
              <div
                key={entry.hashFull}
                role="button"
                tabIndex={0}
                className={css.logRow}
                data-selected={selectedRef?.kind === 'commit' && selectedRef.hashFull === entry.hashFull ? 'true' : undefined}
                title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
                onClick={() => { onPreview(commitRefOf(entry)) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onPreview(commitRefOf(entry))
                  }
                }}
                onContextMenu={(event) => { openHistoryMenu(event, entry) }}
              >
                <span className={css.logLine1}>
                  <span className={css.logHash}>{entry.hash}</span>
                  <span className={css.logSubject}>{entry.subject}</span>
                </span>
                <span className={css.logLine2}>
                  {refNames(entry.refs).map(ref => (
                    <span key={ref} className={css.logRef}>{ref}</span>
                  ))}
                  <span className={css.logMeta}>{entry.author} · {relativeTime(entry.date)}</span>
                </span>
              </div>
            ))}
            {!logEnded && (
              <button
                type="button"
                className={css.logMore}
                disabled={logLoadingMore || busy}
                onClick={() => { void loadMoreLog() }}
              >
                {logLoadingMore ? t('loading') : t('loadMore')}
              </button>
            )}
          </>
        )}
      </div>

      {/* The commit bar is OUTSIDE the scroll body: it is the tab's persistent
          action surface, so the message being written never scrolls away
          (#194). */}
      {isRepo && (
        <div className={css.commitBar} data-commit-bar>
          <div className={css.commitRow}>
            <span className={css.commitInputWrap}>
              {/* A native textarea (the primitives ship no multiline input):
                  commit messages carry a subject AND a body, and Enter must
                  insert a newline — submitting stays on Ctrl/Cmd+Enter. */}
              <textarea
                ref={commitBoxRef}
                className={css.commitInput}
                // While busy the placeholder steps aside for the sweep label.
                placeholder={busy || suggesting ? '' : t('commitPlaceholder')}
                value={commitMsg}
                disabled={busy || suggesting}
                aria-busy={busy || suggesting}
                aria-label={t('commitPlaceholder')}
                rows={1}
                onChange={(event) => { writeDraft(event.currentTarget.value); setActionError(null) }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') commit()
                  // Ctrl/Cmd+G drafts the message, mirroring the button (the
                  // placeholder advertises it).
                  if ((event.ctrlKey || event.metaKey) && (event.key === 'g' || event.key === 'G')) {
                    event.preventDefault()
                    void suggestMessage()
                  }
                }}
              />
              {/* Only the two per-input operations get a label: other `busy`
                  work (staging, checkout) disables the box silently. */}
              {(suggesting || committing) && (
                <span className={css.commitBusyText} role="status" aria-live="polite">
                  {suggesting ? t('generatingCommitMessage') : t('committingMessage')}
                </span>
              )}
            </span>
            <button
              type="button"
              className={suggesting ? `${css.suggestButton} ${css.suggestBusy}` : css.suggestButton}
              aria-label={generateLabel}
              aria-busy={suggesting}
              title={generateLabel}
              disabled={busy || suggesting || (stagedEntries.length === 0 && unstagedEntries.length === 0)}
              onClick={() => { void suggestMessage() }}
            >
              <IconSparkleRegular size={14} />
            </button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || suggesting || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={commit}
            >
              {t('commit')}
            </Button>
            {/* Shipping the commit without leaving the panel: the two remote
                actions ride the SAME row and the SAME busy lock as commit /
                stage, so their failures land on the bar's one status line
                below instead of opening a second error channel. */}
            <Button variant="ghost" size="sm" disabled={busy || suggesting} onClick={push}>{t('push')}</Button>
            <Button variant="ghost" size="sm" disabled={busy || suggesting} onClick={pull}>{t('pull')}</Button>
          </div>
          {/* The bar's ONE status line stays directly under the message row it
              belongs to (the placement `changes-tab.spec.tsx` pins), so it keeps
              reading as "your commit/stage/push failed" rather than as a tab-level
              banner. */}
          {actionError !== null && <Notice kind="error" tone="inline" role="alert">{actionError}</Notice>}
        </div>
      )}

      {/*
        The one shared file-row context menu, positioned at the right-click
        cursor (portal so the panel's overflow clip cannot crop it).
      */}
      <Menu
        open={fileMenu !== null}
        onClose={() => { setFileMenu(null) }}
        items={[
          // The open action is always offered: the host's workspace fence
          // is gone, so a path under any checkout (linked worktree
          // included) opens like any other.
          ...(fileMenu !== null
            ? [{ id: 'open', label: t('openEditor'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          fileMenu?.staged === true
            ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutlineRegular size={14} /> }
            : { id: 'stage', label: t('stage'), icon: <IconPlusOutlineRegular size={14} /> },
          ...(fileMenu !== null && !fileMenu.untracked
            ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutlineRegular size={14} />, danger: true }]
            : []),
          { type: 'separator', id: 'sep1' },
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> },
        ]}
        onSelect={(id) => {
          const target = fileMenu
          if (target === null) return
          setFileMenu(null)
          if (id === 'open') {
            const resolved = resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, target.path)
            // The host accepts any path now (no containment), so the open
            // guard that mirrored the old fence is gone with it.
            onOpenFile(resolved)
            return
          }
          if (id === 'stage') {
            stageEntry(target.path, target.staged)
            return
          }
          if (id === 'discard') {
            runConfirmed({
              title: t('discardTitle'),
              description: t('discardDesc', { path: target.path }),
              confirmLabel: t('discard'),
              onConfirm: () => api.gitDiscard(gitScopeNow(), target.path, selectedWorktree),
            })
            return
          }
          if (id === 'relative') {
            copy(relativeTo(repoRoot ?? selectedWorktree ?? scope.cwd ?? '', target.path))
            return
          }
          if (id === 'absolute') copy(resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, target.path))
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The shared history-row context menu. */}
      <Menu
        open={historyMenu !== null}
        onClose={() => { setHistoryMenu(null) }}
        items={[
          { id: 'view', label: t('viewCommitDiff') },
          { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutlineRegular size={14} /> },
          { type: 'separator', id: 'sep2' },
          { id: 'revert', label: t('revertCommit'), danger: true },
          { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
        ]}
        onSelect={(id) => {
          const target = historyMenu
          if (target === null) return
          setHistoryMenu(null)
          if (id === 'view') {
            onPreview(commitRefOf(target.entry))
            return
          }
          if (id === 'copyShort') {
            copy(target.entry.hash)
            return
          }
          if (id === 'copyFull') {
            copy(target.entry.hashFull)
            return
          }
          if (id === 'copySubject') {
            copy(target.entry.subject)
            return
          }
          if (id === 'revert') {
            runConfirmed({
              title: t('revertTitle'),
              description: t('revertDesc', { subject: target.entry.subject }),
              confirmLabel: t('revertCommit'),
              onConfirm: () => api.gitRevert(gitScopeNow(), target.entry.hashFull, selectedWorktree),
            })
            return
          }
          if (id === 'cherryPick') {
            runConfirmed({
              title: t('cherryPickTitle'),
              description: t('cherryPickDesc', { subject: target.entry.subject }),
              confirmLabel: t('cherryPickCommit'),
              onConfirm: () => api.gitCherryPick(gitScopeNow(), target.entry.hashFull, selectedWorktree),
            })
          }
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* Destructive actions land here first: Cancel / Confirm. */}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        cancelLabel={t('cancel')}
        danger
        busy={busy}
        onConfirm={confirmPending}
        onClose={() => { setConfirm(null) }}
      />
    </div>
  )
})
