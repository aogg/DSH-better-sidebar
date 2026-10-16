/**
 * The round-commits lens of the changes tab: the session's OWN commit trail —
 * the `git add` commands the agent actually ran (folded from the event log by
 * {@link extractGitAdds}) cross-checked against the repository's `git log`.
 * From top to bottom: the staged-but-uncommitted files (added by a round add,
 * matched into NO round commit — the "verify" half, visualized with `add`
 * badges), then the round's commits newest-first, each with a collapsed
 * touched-file list a chevron discloses (files that a round add staged carry
 * the `add` badge). Clicking a commit previews its diff in the tab's shared
 * bottom pane; expanding its files is a separate, independent action.
 *
 * "This round" is an APPROXIMATION by design: the boundary is the event
 * window's earliest event time (the window is capped at 4 000 events), with a
 * one-minute slack, and commits whose date cannot be parsed stay (never drop).
 * The git log is fetched with the host's `files` option; a host OLDER than
 * that option ignores the flag, and a commit whose `files` are missing gets
 * them lazily recovered from its own commit diff the first time the user
 * expands it (see {@link parseDiffFiles}) — every host version works.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitWorktree, SessionScope } from '../api.ts'
import { api } from '../api.ts'
import { usePolling } from '../use-polling.ts'
import { relativeTime, t } from '../locales.ts'
import type { SidebarDiffRef } from '../state.ts'
import { Notice, SectionHeader, StatusBadge, type StatusTone } from '../ui/index.ts'
import { addPathInCommit, normalizeAddPath, parseDiffFiles, type CommitFile, type GitAddRecord } from './round-commits.ts'
import css from './changes.module.css'

/** How many commits one fetch asks for: the recent window, not eternity. */
const ROUND_LOG_COUNT = 50

/** The lens's own cadence (the git log answers "did it land yet"). */
const ROUND_POLL_MS = 10_000

/** Slack around the approximate round boundary (see the module doc). */
const ROUND_WINDOW_SLACK_MS = 60_000

/** The name-status letter → the kit badge tone. */
const FILE_TONE: Record<string, StatusTone> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
}

/** A stable no-match set: a memoized row's props must keep their identity. */
const NO_MATCH: ReadonlySet<string> = new Set<string>()

function toneOf(status: string): StatusTone {
  return FILE_TONE[status] ?? 'neutral'
}

export interface RoundCommitsLensProps {
  scope: SessionScope
  /** Only fetch while the tab is actually on screen. */
  visible: boolean
  /** Bumped by the tab header's refresh action (0 = never asked). */
  refreshTick?: number
  /** The folded `git add` records of the current event window (the tab owns
   *  the event poll; identity is stable between folds). */
  adds: readonly GitAddRecord[]
  /** The event window's earliest event time — the (approximate) round start. */
  roundStart: number
  /** Preview one commit in the shared bottom pane. */
  onPreview: (ref: SidebarDiffRef) => void
  /** The commit currently previewed (row highlight); null when closed. */
  selectedRef: SidebarDiffRef | null
}

/** One row of the staged-uncommitted section: a path no round commit contains. */
interface StagedRow { path: string }

export function RoundCommitsLens({ scope, visible, refreshTick = 0, adds, roundStart, onPreview, selectedRef }: RoundCommitsLensProps) {
  const scopeSessionId = scope.sessionId
  const scopeCwd = scope.cwd
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  /** False until the first fetch settled: distinguishes "loading" from "empty". */
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [isRepo, setIsRepo] = useState(true)
  /** The commits whose touched-file lists are disclosed (empty = all folded). */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  /** The recovered file lists for commits the host answered WITHOUT `files`
   *  (old host): keyed by full hash, filled lazily on first expand. */
  const [lazyFiles, setLazyFiles] = useState<ReadonlyMap<string, readonly CommitFile[]>>(new Map())
  const lazyPending = useRef(new Set<string>())
  /** Bumped on scope change: a late answer of the previous scope never lands. */
  const generation = useRef(0)

  const gitScope = useCallback((): SessionScope =>
    ({ sessionId: scopeSessionId, ...(scopeCwd === undefined ? {} : { cwd: scopeCwd }) }), [scopeSessionId, scopeCwd])

  /** One fetch pass: the repo probe (empty inventory = not a repository) and
   *  the named log settle INDEPENDENTLY, so a non-repo cwd reads as "not a
   *  repository" instead of as a load failure. */
  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    const gen = generation.current
    const [listed, logSettled] = await Promise.all([
      api.gitWorktrees(gitScope(), signal).catch(() => [] as GitWorktree[]),
      api.gitLog(gitScope(), ROUND_LOG_COUNT, 0, undefined, signal, { files: true }).then(
        view => ({ ok: true as const, view }),
        () => ({ ok: false as const, view: [] as GitLogEntry[] }),
      ),
    ])
    if (gen !== generation.current || signal.aborted === true) return
    setIsRepo(listed.length > 0)
    setEntries(logSettled.view)
    setFailed(!logSettled.ok)
    setLoaded(true)
  }, [gitScope])

  // Scope change: drop every derived surface before the new answers arrive.
  useEffect(() => {
    generation.current += 1
    setEntries([])
    setExpanded(new Set())
    setLazyFiles(new Map())
    lazyPending.current = new Set()
    setLoaded(false)
    setFailed(false)
  }, [scopeSessionId, scopeCwd])

  // Load on mount, on every visibility rise, and whenever the scope changed
  // (the reset above cleared the surfaces; this fetches the new ones).
  useEffect(() => {
    if (!visible) return
    void load(new AbortController().signal)
  }, [visible, load])

  // The lens's own cadence (a stable task identity: usePolling restarts on a
  // changing task, which would keep resetting the interval).
  const pollLoad = useCallback((signal: AbortSignal): Promise<void> => load(signal), [load])
  usePolling(visible, pollLoad, { intervalMs: ROUND_POLL_MS })

  // The header's refresh action.
  useEffect(() => {
    if (refreshTick === 0) return
    void load(new AbortController().signal)
    // Only the tick drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick])

  // A NEW add in the event fold may have landed in a commit by now: exactly
  // one reload per change (the first observation rides the mount load).
  const addsKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const key = adds.length > 0 ? `${String(adds.length)}:${adds[0]!.callId}` : '0'
    const previous = addsKeyRef.current
    addsKeyRef.current = key
    if (previous === null || key === previous) return
    void load(new AbortController().signal)
  }, [adds, load])

  /** The commits inside the (approximate) round window, oldest-kept order. */
  const roundCommits = useMemo(() => entries.filter((entry) => {
    const time = Date.parse(entry.date)
    // An unparseable date stays: dropping evidence over a clock format would
    // be worse than one stray row.
    return Number.isNaN(time) || time >= roundStart - ROUND_WINDOW_SLACK_MS
  }), [entries, roundStart])

  /** Every add operand of the round, normalized against its own call's
   *  workdir and the session cwd; errored adds staged nothing. */
  const addOperands = useMemo(() => {
    const rows: { record: GitAddRecord; norm: string }[] = []
    for (const record of adds) {
      if (record.isError || record.all) continue
      const bases = [record.workdir ?? '', scopeCwd ?? '']
      for (const path of record.paths) {
        const norm = normalizeAddPath(path, bases)
        if (norm !== '' && !rows.some(row => row.norm === norm)) rows.push({ record, norm })
      }
    }
    return rows
  }, [adds, scopeCwd])

  /** Every file any round commit is KNOWN to contain. */
  const committedPaths = useMemo(() => {
    const set = new Set<string>()
    for (const entry of roundCommits) {
      for (const file of filesOf(entry, lazyFiles)) set.add(file.path)
    }
    return set
  }, [roundCommits, lazyFiles])

  /** The staged-but-uncommitted view: operands matched into NO round commit,
   *  plus the `add -A`/`add .` records whose file set cannot be enumerated. */
  const staged = useMemo(() => {
    const rows: StagedRow[] = addOperands
      .filter(operand => ![...committedPaths].some(path => addPathInCommit(operand.norm, path)))
      .map(operand => ({ path: operand.norm }))
    const allRecords = adds.filter(record => !record.isError && record.all)
    return { rows, allRecords }
  }, [addOperands, committedPaths, adds])

  /** Files that a round add staged, per commit — the badge evidence. */
  const addMatchedByCommit = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const entry of roundCommits) {
      const matched = new Set<string>()
      for (const file of filesOf(entry, lazyFiles)) {
        for (const operand of addOperands) {
          if (addPathInCommit(operand.norm, file.path)) {
            matched.add(file.path)
            break
          }
        }
      }
      map.set(entry.hashFull, matched)
    }
    return map
  }, [roundCommits, addOperands, lazyFiles])

  // Old-host recovery: expanding a commit the log answered WITHOUT `files`
  // pulls its diff once and parses the touched-file list out of the headers.
  useEffect(() => {
    if (expanded.size === 0) return
    for (const hashFull of expanded) {
      if (lazyFiles.has(hashFull) || lazyPending.current.has(hashFull)) continue
      const entry = entries.find(candidate => candidate.hashFull === hashFull)
      if (entry === undefined || entry.files !== undefined) continue
      lazyPending.current.add(hashFull)
      const gen = generation.current
      api.gitCommitDiff(gitScope(), hashFull)
        .then(({ diff }) => {
          if (gen !== generation.current) return
          setLazyFiles(current => new Map(current).set(hashFull, parseDiffFiles(diff)))
        })
        .catch(() => {
          if (gen !== generation.current) return
          // A failed recovery settles empty: the row shows no files rather
          // than retrying on every render.
          setLazyFiles(current => new Map(current).set(hashFull, []))
        })
    }
  }, [expanded, entries, lazyFiles, gitScope])

  const toggleCommit = useCallback((hashFull: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(hashFull)) next.delete(hashFull)
      else next.add(hashFull)
      return next
    })
  }, [])

  const previewCommit = useCallback((entry: GitLogEntry): void => {
    onPreview({ kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject })
  }, [onPreview])

  const empty = loaded && !failed && isRepo && adds.length === 0 && roundCommits.length === 0

  return (
    <div className={css.commits} data-commits-root>
      <div className={css.commitsList}>
        {!loaded && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
        {loaded && !isRepo && <Notice kind="empty" tone="page">{t('notRepo')}</Notice>}
        {loaded && isRepo && failed && <Notice kind="error" role="alert">{t('changesCommitsLoadError')}</Notice>}
        {empty && <Notice kind="empty" tone="page">{t('changesCommitsEmpty')}</Notice>}

        {loaded && isRepo && (staged.rows.length > 0 || staged.allRecords.length > 0) && (
          <div data-section="staged">
            <SectionHeader label={t('changesStagedUncommitted')} count={staged.rows.length > 0 ? staged.rows.length : undefined} />
            {staged.rows.map(row => (
              <div key={row.path} className={css.stagedFile} data-staged-file={row.path}>
                <span className={css.addBadge} data-add-badge>{t('changesAddBadge')}</span>
                <span className={css.commitFilePath} title={row.path}>{row.path}</span>
              </div>
            ))}
            {staged.allRecords.map(record => (
              <div key={record.callId} className={css.addAllNote} data-add-all-note>
                <span className={css.addAllCommand}>{record.command}</span>
                <span>{t('changesAddAllNote')} · {relativeTime(new Date(record.time).toISOString())}</span>
              </div>
            ))}
          </div>
        )}

        {loaded && isRepo && roundCommits.length > 0 && (
          <div data-section="commits">
            <SectionHeader label={t('changesCommitsSection')} count={roundCommits.length} />
            {roundCommits.map(entry => (
              <CommitRow
                key={entry.hashFull}
                entry={entry}
                files={filesOf(entry, lazyFiles)}
                matched={addMatchedByCommit.get(entry.hashFull) ?? NO_MATCH}
                open={expanded.has(entry.hashFull)}
                selected={selectedRef?.kind === 'commit' && selectedRef.hashFull === entry.hashFull}
                onToggle={toggleCommit}
                onPreview={previewCommit}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** The touched-file list of one commit: the log's own answer, or the lazily
 *  recovered one (old host). Undefined while the recovery is still in flight. */
function filesOf(entry: GitLogEntry, lazyFiles: ReadonlyMap<string, readonly CommitFile[]>): readonly CommitFile[] | undefined {
  if (entry.files !== undefined) return entry.files
  return lazyFiles.get(entry.hashFull)
}

/** One commit row: line 1 = hash + subject, line 2 = refs + author·time and
 *  the collapsed file count; the chevron discloses the touched-file list, the
 *  row's body previews the commit. Two independent actions on one row. */
const CommitRow = memo(function CommitRow(props: {
  entry: GitLogEntry
  files: readonly CommitFile[] | undefined
  matched: ReadonlySet<string>
  open: boolean
  selected: boolean
  onToggle: (hashFull: string) => void
  onPreview: (entry: GitLogEntry) => void
}) {
  const { entry, files, matched, open, selected } = props
  const filesId = `round-commit-files-${entry.hashFull}`
  return (
    <div className={css.roundCommit} data-commit={entry.hashFull}>
      <div className={css.roundCommitRow}>
        <div
          role="button"
          tabIndex={0}
          className={css.logRow}
          data-selected={selected ? 'true' : undefined}
          title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
          onClick={() => { props.onPreview(entry) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              props.onPreview(entry)
            }
          }}
        >
          <span className={css.logLine1}>
            <span className={css.logHash}>{entry.hash}</span>
            <span className={css.logSubject}>{entry.subject}</span>
          </span>
          <span className={css.logLine2}>
            {refNamesOf(entry.refs).map(ref => (
              <span key={ref} className={css.logRef}>{ref}</span>
            ))}
            <span className={css.logMeta}>{entry.author} · {relativeTime(entry.date)}</span>
            {files !== undefined && (
              <span className={css.commitFileCount} data-file-count={files.length}>
                {t('changesCommitFileCount', { count: files.length })}
              </span>
            )}
          </span>
        </div>
        <button
          type="button"
          className={css.commitToggle}
          aria-expanded={open}
          aria-controls={filesId}
          aria-label={entry.subject}
          title={entry.subject}
          onClick={(event) => {
            event.stopPropagation()
            props.onToggle(entry.hashFull)
          }}
        >
          <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true">
            <IconChevronRightOutlineRegular size={12} />
          </span>
        </button>
      </div>
      {open && files !== undefined && (
        <div className={css.commitFiles} id={filesId} data-commit-files={entry.hashFull}>
          {files.length === 0 && <span className={css.commitFileEmpty}>{t('changesCommitFileCount', { count: 0 })}</span>}
          {files.map(file => (
            <div key={`${file.status}:${file.path}`} className={css.commitFile} data-commit-file={file.path}>
              <StatusBadge tone={toneOf(file.status)} title={file.path}>{file.status}</StatusBadge>
              <span className={css.commitFilePath} title={file.path}>{file.path}</span>
              {matched.has(file.path) && <span className={css.addBadge} data-add-badge>{t('changesAddBadge')}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

/** GitLens's decoration fold (`HEAD -> main` → `main`), duplicated here rather
 *  than exported from there — a lens stays a leaf. */
function refNamesOf(refs: string): string[] {
  return [...new Set(
    refs
      .split(',')
      .map(ref => ref.trim())
      .filter(ref => ref !== '')
      .map(ref => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
      .map(ref => (ref.startsWith('tag: ') ? ref.slice(5) : ref)),
  )]
}
