/**
 * The round-diff lens of the changes tab: the round's changes laid out as
 * INLINE patches — ONE `git diff <rev>` (the new `git.diff-range` route)
 * against the newest commit that predates the round, staged and unstaged
 * together, A/M/D/R all inside the same patch — instead of the tab's bottom
 * preview pane. The patch renders through the shared {@link DiffFiles}
 * (per-file collapsible headers + DiffRows), and a compact summary band (one
 * M/A/D/R badge per file, parsed from the SAME patch via {@link parseDiffFiles}
 * — no second git read) tops the list. Each file section's body scrolls
 * INSIDE its group (the `.rounddiffList` cap in changes.module.css, hooked
 * onto DiffFiles' own `button[aria-expanded]` + next-sibling body) while the
 * header sticks, so one huge file cannot push the rest of the round away.
 *
 * "This round" is EXACTLY the round-commits lens' boundary: the event
 * window's earliest event time with a one-minute slack; the baseline comes
 * from {@link pickRoundDiffBase} — the newest pre-round commit, the empty
 * tree when every commit landed inside the round, and the empty state for a
 * repository without commits.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitLogEntry, GitWorktree, SessionScope } from '../api.ts'
import { api } from '../api.ts'
import { usePolling } from '../use-polling.ts'
import { t } from '../locales.ts'
import { Notice, SectionHeader, StatusBadge } from '../ui/index.ts'
import { commitFileTone, parseDiffFiles, type CommitFile } from './round-commits.ts'
import { EMPTY_TREE_HASH, pickRoundDiffBase } from './round-diff.ts'
import { DiffFiles } from '../diff/DiffFiles.tsx'
import css from './changes.module.css'

/** How many log commits the baseline scan sees: the recent window, not
 *  eternity (the same fetch shape the commits lens uses). */
const ROUND_LOG_COUNT = 50

/** The lens's own cadence (the patch follows the moving worktree). */
const ROUND_DIFF_POLL_MS = 10_000

/** Slack around the approximate round boundary (see the module doc). */
const ROUND_DIFF_SLACK_MS = 60_000

export interface RoundDiffLensProps {
  scope: SessionScope
  /** Only fetch while the tab is actually on screen. The lens MOUNTS only
   *  while `lens === 'rounddiff'` (the tab renders it conditionally), so
   *  `visible` alone is the whole gate — the commits lens' arrangement. */
  visible: boolean
  /** Bumped by the tab header's refresh action (0 = never asked). */
  refreshTick?: number
  /** The event window's earliest event time — the (approximate) round start. */
  roundStart: number
}

export function RoundDiffLens({ scope, visible, refreshTick = 0, roundStart }: RoundDiffLensProps) {
  // Granular scope fields: the scope object's identity churns, only its
  // sessionId / cwd fields gate the fetch target.
  const scopeSessionId = scope.sessionId
  const scopeCwd = scope.cwd
  /** The one-shot patch (null until the first pass) and its parsed file rows
   *  — the summary band's M/A/D/R evidence, parsed from the SAME text. */
  const [diff, setDiff] = useState<string | null>(null)
  const [files, setFiles] = useState<readonly CommitFile[]>([])
  /** False until the first fetch settled: distinguishes "loading" from "empty". */
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [isRepo, setIsRepo] = useState(true)
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
    setIsRepo(listed.length > 0)
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

  // Scope change: drop every derived surface before the new answers arrive.
  useEffect(() => {
    generation.current += 1
    setDiff(null)
    setFiles([])
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
  usePolling(visible, pollLoad, { intervalMs: ROUND_DIFF_POLL_MS })

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
              {files.map(file => (
                <div key={`${file.status}:${file.path}`} className={css.commitFile} data-round-file={file.path}>
                  <StatusBadge tone={commitFileTone(file.status)} title={file.path}>{file.status}</StatusBadge>
                  <span className={css.commitFilePath} title={file.path}>{file.path}</span>
                </div>
              ))}
            </div>
            {diff !== null && <DiffFiles diff={diff} />}
          </>
        )}
      </div>
    </div>
  )
}
