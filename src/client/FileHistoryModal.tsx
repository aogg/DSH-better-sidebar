/**
 * The「查看 Git 历史」modal behind the file tree's row context menu: the
 * commit history of ONE path (a file, or a directory — git reads a directory
 * pathspec as "anything under it", so a folder row lists the history of its
 * whole subtree).
 *
 * Why a modal and not a tab: the gesture is "inspect this row's past", which
 * is a question about the row, not a new work surface — the answer should sit
 * over the tree and close with one Escape, the same way the delete
 * confirmation does. The changes tab's history (GitLens) stays the broad
 * surface; this is the pointed one.
 *
 * Paged like GitLens: one batch at a time (`LOG_BATCH`), a batch SHORTER than
 * the batch size marks the end of the log — never a separate "total" query,
 * which would cost a second git process per open for a number nobody asked
 * for. Files additionally pass `--follow`, so a file renamed mid-history
 * keeps one continuous line instead of stopping at the rename; directories
 * never follow (git refuses the combination outright).
 *
 * Expanding a row fetches THAT commit's patch FOR THIS PATH ONLY
 * (`git show <hash> -- <path>`) and renders it through the shared
 * {@link DiffFiles} — the same renderer the changes tab and the diff tab use,
 * so the ink never forks. The patch is cached per commit while the modal is
 * open: collapse + re-expand must not re-run git for an answer already on
 * screen.
 *
 * Every failure lands INSIDE the modal (an inline Notice under the list, a
 * per-row one under an expanded row): the tree stays the owner of any global
 * error strip, and a history read failing must not look like a tree fault.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconCopyOutlineRegular, Modal, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type GitLogEntry, type SessionScope } from './api.ts'
import { relativeTo } from './paths.ts'
import { relativeTime, t } from './locales.ts'
import { DiffFiles } from './diff/DiffFiles.tsx'
import { Notice } from './ui/index.ts'
import css from './sidebar.module.css'

/** Rows per page — the tree's own batch size (the GitLens convention: a
 *  shorter batch is the end of the log, "加载更多" disappears). */
const LOG_BATCH = 30

/** How long the row's "copied" label stays after a successful write (the
 *  FileTree's own constant; kept local so the modal stays standalone). */
const COPIED_MS = 1200

/**
 * The ref names of one log row's decorations (`HEAD -> main` → `main`),
 * deduped — a mirror of GitLens's local helper of the same shape. Deliberately
 * duplicated rather than exported: it is eight pure lines, and a shared module
 * for one split+trim would couple two pages over nothing.
 */
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

/** One expanded row's patch state: loading, the text, or the failure. */
interface DiffState {
  status: 'loading' | 'ok' | 'failed'
  text?: string
}

export function FileHistoryModal(props: {
  /** The session the git command runs under (cwd included — the title's
   *  relative path is cut against it). */
  scope: SessionScope
  /** The absolute path whose history this modal lists. */
  path: string
  /** Directory rows list the subtree's history and never `--follow`. */
  isDir: boolean
  onClose(): void
}): ReactNode {
  const { scope, path, isDir, onClose } = props
  /** The loaded pages, the paging cursor, and the two load states. */
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [ended, setEnded] = useState(false)
  /** The rows whose patch is expanded, and each one's patch state (cached for
   *  the life of the modal — re-expanding replays the fetched text). */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [diffs, setDiffs] = useState<ReadonlyMap<string, DiffState>>(() => new Map())
  /** The row whose hash was just copied ("copied" label replaces its button). */
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  /** Retires async settles after unmount (a closed modal owns no state). */
  const generationRef = useRef(0)
  useEffect(() => () => { generationRef.current += 1 }, [])

  // First page on open. The modal mounts fresh per open (the tree renders it
  // only while a history target is set), so this effect IS the load; the
  // generation guard keeps a late response from landing after the close.
  useEffect(() => {
    const generation = generationRef.current
    setLoading(true)
    setFailed(false)
    api.gitLog(scope, LOG_BATCH, 0, undefined, undefined, { path, follow: !isDir })
      .then((rows) => {
        if (generation !== generationRef.current) return
        setEntries(rows)
        // A short batch is the whole history — the pager has nothing to offer.
        setEnded(rows.length < LOG_BATCH)
      })
      .catch(() => {
        if (generation !== generationRef.current) return
        setFailed(true)
      })
      .finally(() => {
        if (generation !== generationRef.current) return
        setLoading(false)
      })
  }, [scope, path, isDir])

  /** Fetch one commit's patch for THIS path (memoized in `diffs`). */
  const fetchDiff = (hashFull: string): void => {
    const generation = generationRef.current
    setDiffs((prev) => {
      if (prev.get(hashFull)?.status === 'loading') return prev
      const next = new Map(prev)
      next.set(hashFull, { status: 'loading' })
      return next
    })
    api.gitCommitDiff(scope, hashFull, undefined, undefined, path)
      .then((result) => {
        if (generation !== generationRef.current) return
        setDiffs(prev => new Map(prev).set(hashFull, { status: 'ok', text: result.diff }))
      })
      .catch(() => {
        if (generation !== generationRef.current) return
        setDiffs(prev => new Map(prev).set(hashFull, { status: 'failed' }))
      })
  }

  /** Expand/collapse one row; a fresh expansion starts its patch fetch. The
   *  fetch fires OUTSIDE the state updater — an updater must stay pure (React
   *  may replay it, which would double-run the request), and this decision
   *  reads THIS render's state, which an event handler always sees fresh. */
  const toggleRow = (hashFull: string): void => {
    const willExpand = !expanded.has(hashFull)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(hashFull)) next.delete(hashFull)
      else next.add(hashFull)
      return next
    })
    if (willExpand && diffs.get(hashFull) === undefined) fetchDiff(hashFull)
  }

  /** Copy the FULL hash (the short one is display; a copy is for `git`). */
  const copyHash = (hashFull: string): void => {
    void writeClipboard(hashFull).then((ok) => {
      if (!ok) return
      setCopiedHash(hashFull)
      window.setTimeout(() => {
        setCopiedHash(current => current === hashFull ? null : current)
      }, COPIED_MS)
    })
  }

  const loadMore = (): void => {
    if (loadingMore || ended) return
    const generation = generationRef.current
    setLoadingMore(true)
    api.gitLog(scope, LOG_BATCH, entries.length, undefined, undefined, { path, follow: !isDir })
      .then((rows) => {
        if (generation !== generationRef.current) return
        setEntries(prev => [...prev, ...rows])
        if (rows.length < LOG_BATCH) setEnded(true)
      })
      .catch(() => {
        // A failed PAGE keeps the rows already on screen (GitLens's rule);
        // the pager simply stays available for another try.
        if (generation !== generationRef.current) return
        setEnded(false)
      })
      .finally(() => {
        if (generation !== generationRef.current) return
        setLoadingMore(false)
      })
  }

  /** Row activate on Enter/Space mirrors the click (GitLens's contract). */
  const rowKeyDown = (event: KeyboardEvent<HTMLDivElement>, hashFull: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleRow(hashFull)
    }
  }

  /** Title path: workspace-relative when the row sits under cwd (the usual
   *  case), absolute otherwise — the modal must name the row it came from. */
  const titlePath = useMemo(() => relativeTo(scope.cwd ?? '', path), [scope.cwd, path])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('gitHistoryTitle', { path: titlePath })}
      closeLabel={t('close')}
      // A wide, height-capped dialog: a history list wants stable height (the
      // pager never jumps the frame) and a diff wants width. The content
      // column scrolls (the header rides along — one scrollbar for the whole
      // modal is the reading model a history wants).
      className={css.fileHistoryDialog}
      contentClassName={css.fileHistoryContent}
    >
      {loading && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
      {!loading && failed && entries.length === 0 && (
        <Notice kind="error">{t('gitHistoryLoadError')}</Notice>
      )}
      {!loading && !failed && entries.length === 0 && (
        // The empty read: an untracked file, a never-committed path, or a
        // directory whose subtree git has no commit for — all the same answer.
        <Notice kind="empty" tone="page">{t('gitHistoryEmpty')}</Notice>
      )}
      {!loading && failed && entries.length > 0 && (
        // The FIRST page may have succeeded before a later one failed — keep
        // the list readable, say what happened above the pager.
        <Notice kind="error" tone="inline">{t('gitHistoryLoadError')}</Notice>
      )}
      <div className={css.fileHistoryList} data-dsh-file-history="">
        {entries.map(entry => (
          <div key={entry.hashFull} className={css.fileHistoryItem}>
            <div
              role="button"
              tabIndex={0}
              className={css.fileHistoryRow}
              data-expanded={expanded.has(entry.hashFull) ? 'true' : undefined}
              title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
              onClick={() => { toggleRow(entry.hashFull) }}
              onKeyDown={(event) => { rowKeyDown(event, entry.hashFull) }}
            >
              <span className={css.fileHistoryRowLine1}>
                <span className={css.fileHistoryRowHash}>{entry.hash}</span>
                <span className={css.fileHistoryRowSubject}>{entry.subject}</span>
                {copiedHash === entry.hashFull
                  ? <span className={css.fileHistoryRowCopied}>{t('copied')}</span>
                  : (
                    <button
                      type="button"
                      className={css.fileHistoryRowCopy}
                      aria-label={t('copyFullHash')}
                      title={t('copyFullHash')}
                      onClick={(event) => {
                        // The row's toggle owns plain clicks; the button must
                        // not double as one.
                        event.stopPropagation()
                        copyHash(entry.hashFull)
                      }}
                    >
                      <IconCopyOutlineRegular size={13} />
                    </button>
                  )}
              </span>
              <span className={css.fileHistoryRowLine2}>
                {refNames(entry.refs).map(ref => (
                  <span key={ref} className={css.fileHistoryRowRef}>{ref}</span>
                ))}
                <span className={css.fileHistoryRowMeta}>{entry.author} · {relativeTime(entry.date)}</span>
              </span>
            </div>
            {expanded.has(entry.hashFull) && (
              <div className={css.fileHistoryDiff}>
                {diffs.get(entry.hashFull) === undefined || diffs.get(entry.hashFull)?.status === 'loading'
                  ? <Notice kind="loading" tone="well">{t('loading')}</Notice>
                  : diffs.get(entry.hashFull)?.status === 'failed'
                    ? <Notice kind="error">{t('gitHistoryDiffError')}</Notice>
                    // A clean empty patch: the commit matched the log through
                    // a path spelling git's diff side does not list (a rename
                    // operand, say) — say so instead of rendering a blank box.
                    : (diffs.get(entry.hashFull)?.text ?? '').trim() === ''
                      ? <Notice kind="hint">{t('gitHistoryDiffEmpty')}</Notice>
                      : <DiffFiles diff={diffs.get(entry.hashFull)?.text ?? ''} />}
              </div>
            )}
          </div>
        ))}
      </div>
      {!ended && entries.length > 0 && (
        <button
          type="button"
          className={css.fileHistoryMore}
          disabled={loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? t('loading') : t('loadMore')}
        </button>
      )}
    </Modal>
  )
}
