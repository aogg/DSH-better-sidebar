/**
 * The round-diff lens of the changes tab: the round's changes laid out as
 * INLINE patches — ONE `git diff <rev>` (the new `git.diff-range` route)
 * against the newest commit that predates the round, staged and unstaged
 * together, A/M/D/R all inside the same patch — instead of the tab's bottom
 * preview pane. The patch renders through the shared {@link DiffFiles}
 * (per-file collapsible headers + DiffRows), and a compact summary band (one
 * directory TREE over the patch's files — {@link buildRoundDiffTree}, the
 * session lens's shape, directories default-expanded with the fold tracked
 * as the COLLAPSED set) tops the patches. Each summary row carries a
 * 「查看原文件」 action: a file row opens the file in the sidebar (the tab's
 * `onOpenFile`, resolved against the round's worktree root — the patch names
 * repo-relative paths), a directory row lands on the plugin's 「文件」 page
 * with the folder revealed ({@link activateFilesPage}, the conversation
 * folder-link landing). Each file section's body scrolls INSIDE its group
 * (the `.rounddiffList` cap in changes.module.css, hooked onto DiffFiles'
 * own `button[aria-expanded]` + next-sibling body) while the header sticks,
 * so one huge file cannot push the rest of the round away.
 *
 * "This round" is EXACTLY the round-commits lens' boundary: the event
 * window's earliest event time with a one-minute slack; the baseline comes
 * from {@link pickRoundDiffBase} — the newest pre-round commit, the empty
 * tree when every commit landed inside the round, and the empty state for a
 * repository without commits.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronRightOutlineRegular, IconCodeOutlineRegular, IconFolderOpenRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { GitLogEntry, GitWorktree, SessionScope } from '../api.ts'
import { api } from '../api.ts'
import { useGitWatch } from '../git-push.ts'
import { resolveSidebarPath } from '../paths.ts'
import { t } from '../locales.ts'
import type { SidebarStore } from '../state.ts'
import { IconButton, Notice, SectionHeader, StatusBadge } from '../ui/index.ts'
import { builtinFileIcon, builtinFolderIcon } from '../file-icons.tsx'
import { activateFilesPage } from '../sidebar-folder.ts'
import { commitFileTone, parseDiffFiles, type CommitFile } from './round-commits.ts'
import { EMPTY_TREE_HASH, pickRoundDiffBase } from './round-diff.ts'
import { buildRoundDiffTree, dirPathsOf, type RoundDiffDir, type RoundDiffFile } from './round-diff-tree.ts'
import type { LensControl } from './lens-control.ts'
import { DiffFiles, type DiffFoldCommand } from '../diff/DiffFiles.tsx'
import css from './changes.module.css'

/** How many log commits the baseline scan sees: the recent window, not
 *  eternity (the same fetch shape the commits lens uses). */
const ROUND_LOG_COUNT = 50

/** Slack around the approximate round boundary (see the module doc). */
const ROUND_DIFF_SLACK_MS = 60_000

export interface RoundDiffLensProps {
  scope: SessionScope
  /** The tab's context — the folder landing's 「文件」 page activation. */
  ctx: Context
  /** The plugin store — the reveal-highlight set's home (the folder landing). */
  store: SidebarStore
  /** Open one file in the sidebar (the tab's editor open; the path it
   *  receives is already resolved to its worktree-absolute form). */
  onOpenFile: (path: string) => void
  /** Only fetch while the tab is actually on screen. The lens MOUNTS only
   *  while `lens === 'rounddiff'` (the tab renders it conditionally), so
   *  `visible` alone is the whole gate — the commits lens' arrangement. */
  visible: boolean
  /** Bumped by the tab header's refresh action (0 = never asked). */
  refreshTick?: number
  /** The event window's earliest event time — the (approximate) round start. */
  roundStart: number
}

/**
 * The round-diff lens: the summary tree, the inline patches, and the fold
 * handle the tab header's 「全部展开」/「全部收起」 drive (summary directories
 * AND the per-file patch folds — one command reaches both).
 */
export const RoundDiffLens = forwardRef<LensControl, RoundDiffLensProps>(function RoundDiffLens(
  { scope, ctx, store, onOpenFile, visible, refreshTick = 0, roundStart },
  ref,
) {
  // Granular scope fields: the scope object's identity churns, only its
  // sessionId / cwd fields gate the fetch target.
  const scopeSessionId = scope.sessionId
  const scopeCwd = scope.cwd
  /** The one-shot patch (null until the first pass) and its parsed file rows
   *  — the summary tree's leaves, parsed from the SAME text. */
  const [diff, setDiff] = useState<string | null>(null)
  const [files, setFiles] = useState<readonly CommitFile[]>([])
  /** False until the first fetch settled: distinguishes "loading" from "empty". */
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [isRepo, setIsRepo] = useState(true)
  /** The inventory's checkout paths — the push subscription's watch set
   *  (content-guarded: an identical answer keeps the array identity). */
  const [watchRoots, setWatchRoots] = useState<string[]>([])
  /** The root the patch's repo-relative paths resolve against: the round's
   *  worktree (the inventory's current checkout, else its first entry). */
  const [worktreeRoot, setWorktreeRoot] = useState<string | undefined>(undefined)
  /** The summary directories the user FOLDED (default: none — the tree starts
   *  fully expanded). An absence-set rather than an open-set on purpose, the
   *  session lens's own convention: a directory that first appears in a
   *  later poll tick is not in it, so new work arrives expanded. */
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set())
  /** The latest open-all/close-all instruction for the patch headers (the
   *  monotonic `seq` is what makes repeated commands replayable). */
  const [foldCommand, setFoldCommand] = useState<DiffFoldCommand | undefined>(undefined)
  /** Bumped on scope change: a late answer of the previous scope never lands. */
  const generation = useRef(0)

  const gitScope = useCallback((): SessionScope =>
    ({ sessionId: scopeSessionId, ...(scopeCwd === undefined ? {} : { cwd: scopeCwd }) }), [scopeSessionId, scopeCwd])

  /** One fetch pass: the repo probe and the named log settle INDEPENDENTLY
   *  (a non-repo cwd reads as "not a repository", not as a load failure),
   *  then the ONE range-diff ride follows the picked baseline. Every failure
   *  surfaces as the lens's error state (a Notice), never a silent drop. */
  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    const gen = generation.current
    // Every staleness checkpoint re-reads THROUGH the closure: a plain
    // property guard flow-narrows after its first check (tsc TS2367 on the
    // post-await re-check), while an aborted fetch is NOT guaranteed to
    // reject — the transport may deliver the answer anyway, so each
    // checkpoint must read the live flag.
    const stale = (): boolean => gen !== generation.current || signal.aborted
    const [listed, logSettled] = await Promise.all([
      api.gitWorktrees(gitScope(), signal).catch(() => [] as GitWorktree[]),
      api.gitLog(gitScope(), ROUND_LOG_COUNT, 0, undefined, signal, { files: true }).then(
        view => ({ ok: true as const, view }),
        () => ({ ok: false as const, view: [] as GitLogEntry[] }),
      ),
    ])
    if (stale()) return
    // The watch set follows the inventory answer: the host names the
    // session repository's checkouts, the lens re-pulls when one moves.
    const roots = listed.map(entry => entry.path)
    setWatchRoots(previous => previous.join('\u0000') === roots.join('\u0000') ? previous : roots)
    setIsRepo(listed.length > 0)
    // The inventory's current checkout is the root the patch's repo-relative
    // paths open against (GitLens's resolution order, minus the manual
    // checkout pick this lens does not offer).
    setWorktreeRoot(listed.length > 0 ? listed.find(entry => entry.current)?.path ?? listed[0]?.path : undefined)
    if (listed.length === 0 || !logSettled.ok) {
      setFailed(!logSettled.ok)
      setLoaded(true)
      return
    }
    const base = pickRoundDiffBase(logSettled.view, roundStart, ROUND_DIFF_SLACK_MS)
    // A repository without commits has nothing a worktree diff could answer
    // with (tracked files do not exist yet): the empty state, no fetch.
    if (base.kind === 'no-commits') {
      setFailed(false)
      setDiff('')
      setFiles([])
      setLoaded(true)
      return
    }
    const diffSettled = await api
      .gitDiffRange(gitScope(), base.kind === 'commit' ? base.hashFull : EMPTY_TREE_HASH, undefined, signal)
      .then(
        view => ({ ok: true as const, view }),
        () => ({ ok: false as const }),
      )
    if (stale()) return
    setFailed(!diffSettled.ok)
    if (diffSettled.ok) {
      setDiff(diffSettled.view.diff)
      setFiles(parseDiffFiles(diffSettled.view.diff))
    }
    setLoaded(true)
  }, [gitScope, roundStart])

  // Scope change: drop every derived surface before the new answers arrive
  // (the watch set too — the old scope's checkouts must not steer notices).
  useEffect(() => {
    generation.current += 1
    setDiff(null)
    setFiles([])
    setLoaded(false)
    setFailed(false)
    setWorktreeRoot(undefined)
    setCollapsedDirs(new Set())
    setFoldCommand(undefined)
    setWatchRoots([])
  }, [scopeSessionId, scopeCwd])

  // Load on mount, on every visibility rise, and whenever the scope changed
  // (the reset above cleared the surfaces; this fetches the new ones).
  useEffect(() => {
    if (!visible) return
    void load(new AbortController().signal)
  }, [visible, load])

  // The lens's push subscription: the host names the checkout whose git
  // state moved (the patch follows the moving worktree — an edit or commit
  // the agent made in a terminal included); one one-shot reload per notice,
  // and one catch-up per reconnect. No timer drives any fetch here.
  useGitWatch({
    sessionId: scopeSessionId,
    worktrees: visible ? watchRoots : [],
    onInvalidate: () => { void load(new AbortController().signal) },
    onReconnect: () => { void load(new AbortController().signal) },
  })

  // The header's refresh action.
  useEffect(() => {
    if (refreshTick === 0) return
    void load(new AbortController().signal)
    // Only the tick drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick])

  // A MOVING round boundary (the tab's event window grows) shifts the
  // baseline: exactly one reload per change (the first observation rides the
  // mount load).
  const roundStartRef = useRef(roundStart)
  useEffect(() => {
    if (roundStartRef.current === roundStart) return
    roundStartRef.current = roundStart
    void load(new AbortController().signal)
  }, [roundStart, load])

  /** The summary tree over the parsed patch files (one fold per patch). */
  const tree = useMemo(() => buildRoundDiffTree(files), [files])

  /** Resolve a patch-relative path against the round's worktree root (an
   *  absolute path passes through untouched), or the session cwd before the
   *  inventory answered — the open actions are best-effort, never gated on
   *  the listing having landed. */
  const resolveAgainstRoot = useCallback((path: string): string =>
    resolveSidebarPath(worktreeRoot ?? scopeCwd, path), [worktreeRoot, scopeCwd])

  /** Open one summary file in the sidebar (the tab's editor open). */
  const openFile = useCallback((path: string): void => {
    onOpenFile(resolveAgainstRoot(path))
  }, [onOpenFile, resolveAgainstRoot])

  /** Land one summary directory on the 「文件」 page with the folder revealed
   *  (the conversation folder-link landing, reused verbatim). */
  const openDir = useCallback((path: string): void => {
    activateFilesPage(ctx, store, scopeSessionId, resolveAgainstRoot(path))
  }, [ctx, store, scopeSessionId, resolveAgainstRoot])

  const toggleDir = useCallback((dirPath: string): void => {
    setCollapsedDirs((current) => {
      const next = new Set(current)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }, [])

  /** Issue one open-all/close-all instruction to BOTH fold axes: the summary
   *  directories directly, the patch headers through the command's seq (the
   *  header state lives inside DiffFiles). */
  const foldPatches = useCallback((mode: DiffFoldCommand['mode']): void => {
    setFoldCommand(previous => ({ mode, seq: (previous?.seq ?? 0) + 1 }))
  }, [])

  // The tab header's 全部展开/全部收起: recreated per render, so the handle
  // always closes over the CURRENT tree (collapse-all needs its directory
  // rows) and the current command counter.
  useImperativeHandle(ref, (): LensControl => ({
    expandAll: (): void => {
      setCollapsedDirs(new Set())
      foldPatches('expand')
    },
    collapseAll: (): void => {
      setCollapsedDirs(new Set(dirPathsOf(tree)))
      foldPatches('collapse')
    },
  }))

  /** One file leaf: the status badge + the file's own name (the full path
   *  rides the title) + the trailing 「查看原文件」 action. */
  const renderFile = (node: RoundDiffFile): ReactNode => (
    <div key={node.path} className={css.commitFile} data-round-file={node.path}>
      <StatusBadge tone={commitFileTone(node.status)} title={node.path}>{node.status}</StatusBadge>
      <span className={css.rowIcon} aria-hidden="true">{builtinFileIcon(node.path, 14)}</span>
      <span className={css.commitFilePath} title={node.path}>{node.name}</span>
      <IconButton
        size="sm"
        className={css.rowAction}
        icon={<IconCodeOutlineRegular size={14} />}
        label={t('changesViewOriginalFile')}
        title={node.path}
        onClick={(event) => {
          event.stopPropagation()
          openFile(node.path)
        }}
      />
    </div>
  )

  /** One directory row plus its (default-expanded) subtree: the session
   *  lens's row shape, plus the same trailing action — a directory lands on
   *  the 「文件」 page with the folder revealed. */
  const renderDir = (node: RoundDiffDir): ReactNode => {
    const open = !collapsedDirs.has(node.path)
    return (
      <div key={`dir:${node.path}`}>
        <div className={css.row}>
          <button
            type="button"
            className={css.dirRow}
            data-round-dir={node.path}
            aria-expanded={open}
            title={node.path}
            onClick={() => { toggleDir(node.path) }}
          >
            <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true">
              <IconChevronRightOutlineRegular size={12} />
            </span>
            <span className={css.rowIcon} aria-hidden="true">{builtinFolderIcon(open, 14)}</span>
            <span className={css.dirName}>{node.name}</span>
            <span className={css.countPill} data-count={node.files}>{node.files}</span>
          </button>
          <IconButton
            size="sm"
            className={css.rowAction}
            icon={<IconFolderOpenRegular size={14} />}
            label={t('changesViewOriginalFile')}
            title={node.path}
            onClick={(event) => {
              event.stopPropagation()
              openDir(node.path)
            }}
          />
        </div>
        {open && (
          <div className={css.treeChildren}>
            {node.children.map(child => (child.kind === 'dir' ? renderDir(child) : renderFile(child)))}
          </div>
        )}
      </div>
    )
  }

  const empty = loaded && !failed && isRepo && files.length === 0

  return (
    <div className={css.rounddiff} data-round-diff-root>
      <div className={css.rounddiffList}>
        {!loaded && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
        {loaded && !isRepo && <Notice kind="empty" tone="page">{t('notRepo')}</Notice>}
        {loaded && isRepo && failed && <Notice kind="error" role="alert">{t('changesRoundDiffLoadError')}</Notice>}
        {empty && <Notice kind="empty" tone="page">{t('changesRoundDiffEmpty')}</Notice>}
        {loaded && isRepo && !failed && files.length > 0 && (
          <>
            <div data-section="files">
              <SectionHeader label={t('changesRoundDiffSection')} count={files.length} />
              {tree.map(node => (node.kind === 'dir' ? renderDir(node) : renderFile(node)))}
            </div>
            {diff !== null && (
              <DiffFiles diff={diff} onOpenFile={openFile} foldCommand={foldCommand} />
            )}
          </>
        )}
      </div>
    </div>
  )
})
