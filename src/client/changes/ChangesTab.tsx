/**
 * The unified changes tab: one tab, three lenses on "what changed?" — Git
 * (repository truth: staged/unstaged files, commit box, history), the
 * round commits (the session's own `git add` trail cross-checked against
 * `git log`, see {@link RoundCommitsLens}), and the session round (agent
 * truth: every file the model read, wrote, or edited). A 36px header carries
 * the host {@link SegmentedControl} and the current lens's refresh action;
 * every lens previews its selections in a shared resizable bottom pane
 * ({@link DiffPane}), and git targets expand into the dedicated diff tab
 * docked in the workbench's diff pane. The active lens and the pane height
 * persist in the tab's meta, so the tab reopens exactly where it was left.
 *
 * The session events ride the host's `changes.ops` route (the client runtime
 * exposes no event-log face): the tab pulls the delta past its cursor and
 * folds it into ops (and, from the same window, the `git add` records), and
 * publishes the op count to a module-level cache the tab-strip badge reads.
 * The pull is one catch-up whenever the tab becomes visible and then a cadence
 * ONLY while an event-backed lens is on screen — the git lens has no use for
 * the session event log (and the shared git-status store owns its own poller).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconRefreshOutlineRegular, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSessionEvent } from '../../context-types.ts'
import type { TabComponentProps } from '../service.ts'
import { t } from '../locales.ts'
import { api } from '../api.ts'
import { usePolling } from '../use-polling.ts'
import type { SidebarDiffRef } from '../state.ts'
import { IconButton, Notice } from '../ui/index.ts'
import { GitLens } from './GitLens.tsx'
import { SessionLens } from './SessionLens.tsx'
import { DiffPane, clampPaneHeight, diffTabOf, type ChangesPreview } from './DiffPane.tsx'
import { extractFileOps, knownContentBefore, type FileOp } from './ops.ts'
import { extractGitAdds, type GitAddRecord } from './round-commits.ts'
import { RoundCommitsLens } from './RoundCommitsLens.tsx'
import css from './changes.module.css'

/** The default preview pane height (px) before the first drag. */
const PANE_HEIGHT_DEFAULT = 300

/** Cap on accumulated events: the lens shows the recent window, not eternity
 *  (the host enforces the same bound per response). */
const EVENTS_CAP = 4000

/** Live op count per session: the tab's poller writes, the badge reads (a
 *  badge cannot fetch — it must resolve synchronously during render). */
const opCounts = new Map<string, number>()

/** The session's traced-op count as of the last poll (undefined before the
 *  tab has ever pulled; 0 hides the badge pill). */
export function opCountOf(sessionId: string): number | undefined {
  return opCounts.get(sessionId)
}

type Lens = 'commits' | 'git' | 'session'

/** The persisted tab meta (JSON-serializable; rides the layout). */
interface ChangesMeta {
  lens?: Lens
  previewH?: number
}

/** What the user selected to preview: a git ref, or the IDENTITY of a session
 *  op. Holding the callId (not the op object) is what makes the pane follow
 *  the op as it settles: every render re-derives the op from the latest fold,
 *  so a running call turns into its result without the user re-clicking. */
type PreviewSelection =
  | { kind: 'git'; ref: SidebarDiffRef }
  | { kind: 'op'; path: string; callId: string }

export function ChangesTab({ ctx, store, scope, tab, visible, onOpenFile, onOpenDiff }: TabComponentProps) {
  const meta = (tab.meta ?? {}) as ChangesMeta
  const [lens, setLens] = useState<Lens>(meta.lens === 'session' ? 'session' : meta.lens === 'commits' ? 'commits' : 'git')
  const [selection, setSelection] = useState<PreviewSelection | null>(null)
  const [paneHeight, setPaneHeight] = useState<number>(() => clampPaneHeight(
    typeof meta.previewH === 'number' ? meta.previewH : PANE_HEIGHT_DEFAULT,
  ))
  /** The header refresh action: BOTH git-backed lenses reload through this
   *  tick (each lens owns its own queue; an unmounted lens ignores it). */
  const [refreshTick, setRefreshTick] = useState(0)

  // ── Session-event accumulation: one catch-up pull when the tab becomes
  //    visible, then a 2.5s delta poll while the SESSION lens is on screen.
  //    The cursor is the last delivered seq, so each poll ships only what the
  //    accumulator lacks. ───────────────────────────────────────────────────
  const eventsRef = useRef<readonly SidebarSessionEvent[]>([])
  // The fold of eventsRef as of the last poll. extractFileOps parses every
  // accumulated tool/call (up to EVENTS_CAP events); running it once per
  // poll and REUSING the result across renders (the render used to re-fold
  // the whole window, twice per tick, and the fresh array defeated the
  // downstream memo on every poll) keeps the 2.5s tick at one fold.
  const opsRef = useRef<readonly FileOp[]>([])
  /** The sibling fold over the SAME window: the bash `git add` records the
   *  round-commits lens cross-checks against git. Same-source, same-tick, and
   *  held to the same identity discipline as `opsRef`. */
  const addsRef = useRef<readonly GitAddRecord[]>([])
  const seqRef = useRef(0)
  const pollGen = useRef(0)
  /** One delta request in flight at a time (the poller is fixed-interval, so a
   *  slow host would otherwise run two pulls over the same cursor and append
   *  the same delta twice). A pull that arrives while one is running is a
   *  no-op: the in-flight answer already carries everything up to now. */
  const pullingRef = useRef(false)
  const [opsError, setOpsError] = useState(false)
  const [tick, setTick] = useState(0)
  const pull = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const generation = pollGen.current
    if (pullingRef.current) return
    pullingRef.current = true
    try {
      const { events, lastSeq } = await api.changesOps(scope, seqRef.current, signal)
      // An aborted poll belongs to a torn-down run: its answer must never
      // publish state (the transport may deliver it anyway).
      if (generation !== pollGen.current || signal?.aborted === true) return
      // Nothing new: KEEP the previous fold's identity. Re-folding an
      // unchanged window produced a fresh array every 2.5s, which defeated
      // every downstream memo — the session lens re-encoded each op body into
      // a Blob to size it, on every idle tick.
      if (events.length === 0 && lastSeq <= seqRef.current && opsRef.current.length > 0) {
        setOpsError(false)
        return
      }
      if (events.length > 0) {
        const merged = [...eventsRef.current, ...events]
        eventsRef.current = merged.length > EVENTS_CAP ? merged.slice(merged.length - EVENTS_CAP) : merged
      }
      if (lastSeq > seqRef.current) seqRef.current = lastSeq
      const folded = extractFileOps(eventsRef.current)
      opsRef.current = folded
      addsRef.current = extractGitAdds(eventsRef.current)
      opCounts.set(scope.sessionId, folded.length)
      setOpsError(false)
      setTick(value => value + 1)
    } catch {
      // Offline / route unavailable: keep the last fold; surface it inline
      // only while nothing has ever loaded.
      if (generation === pollGen.current && signal?.aborted !== true) setOpsError(true)
    } finally {
      pullingRef.current = false
    }
    // Granular scope fields: the scope object's identity churns, only its
    // sessionId / cwd fields gate the poll target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])
  useEffect(() => {
    pollGen.current += 1
    eventsRef.current = []
    opsRef.current = []
    addsRef.current = []
    seqRef.current = 0
    setOpsError(false)
  }, [scope.sessionId])
  // One catch-up whenever the tab becomes visible (the badge count follows the
  // tab being opened); the CADENCE below runs only while an event-backed lens
  // is showing (the git lens folds nothing from the session log).
  useEffect(() => { if (visible) void pull() }, [visible, pull])
  usePolling(visible && lens !== 'git', pull, { intervalMs: 2_500 })
  // tick only forces the re-render; the fold reads the ref directly.
  void tick
  const ops = opsRef.current
  const adds = addsRef.current
  /** The (approximate) "this round" boundary: the event window's earliest
   *  event time. The window is capped at {@link EVENTS_CAP} events, so an old
   *  session's round start drifts forward — the lens keeps a one-minute slack
   *  and unparseable commit dates for exactly that reason. */
  const roundStart = useMemo(() => {
    let min = Number.POSITIVE_INFINITY
    for (const event of eventsRef.current) {
      if (event.time < min) min = event.time
    }
    return Number.isFinite(min) ? min : Date.now()
    // The window only changes when a poll ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  /** The preview target of the current selection, re-derived every render so
   *  an op that settled (or fell out of the window) is reflected immediately. */
  const previewTarget = useMemo<ChangesPreview | null>(() => {
    if (selection === null) return null
    if (selection.kind === 'git') return selection
    const op = ops.find(candidate => candidate.callId === selection.callId)
    if (op === undefined) return null
    return { kind: 'op', path: selection.path, op, prior: knownContentBefore(ops, selection.path, op) }
  }, [selection, ops])

  /** Persist a meta patch onto the tab (lens choice, pane height). */
  const patchMeta = (patch: ChangesMeta): void => {
    ctx.get('betterSidebar')?.updateTab(tab.id, {
      meta: { ...(tab.meta as ChangesMeta | undefined ?? {}), ...patch },
    }, scope.sessionId)
  }

  const chooseLens = (next: Lens): void => {
    if (next === lens) return
    setLens(next)
    patchMeta({ lens: next })
  }

  /** The header's refresh action: the git-backed lenses reload through their
   *  shared tick (GitLens's queue, the commits lens's fetch), the session lens
   *  re-pulls its event delta — and the commits lens ALSO re-pulls, since its
   *  add evidence rides the same event window. */
  const refreshCurrent = (): void => {
    if (lens === 'session') {
      void pull()
      return
    }
    setRefreshTick(value => value + 1)
    if (lens === 'commits') void pull()
  }

  /** Preview one git change (worktree file or commit) from the Git lens. */
  const previewGit = (ref: SidebarDiffRef): void => {
    setSelection({ kind: 'git', ref })
  }

  /** Preview one session op by callId (the tab re-derives it each render). */
  const previewOp = (path: string, op: FileOp): void => {
    setSelection({ kind: 'op', path, callId: op.callId })
  }

  /** Expand the current git preview into the dedicated diff tab, docked
   *  into the workbench's diff pane. */
  const expandPreview = (): void => {
    if (previewTarget?.kind !== 'git') return
    onOpenDiff?.(diffTabOf(previewTarget.ref))
  }

  const previewKey = (target: ChangesPreview): string => target.kind === 'git'
    ? (target.ref.kind === 'worktree'
        ? `git:w:${target.ref.path}:${target.ref.staged ? 's' : 'u'}`
        : `git:c:${target.ref.hashFull}`)
    : `op:${target.op.callId}`

  return (
    <div className={css.root}>
      <div className={css.head}>
        <SegmentedControl
          id={`changes-lens-${tab.id}`}
          value={lens}
          options={[
            // The round-commits lens sits LEFT of the git lens: the session's
            // own trail comes first, the repository's full view second. The
            // segment shows the short name (three lenses share one 36px head);
            // the full name rides the hover title.
            { value: 'commits', label: t('changesCommitsLensShort'), title: t('changesCommitsLens') },
            { value: 'git', label: t('changesGitLens') },
            { value: 'session', label: t('changesSessionLens') },
          ]}
          onChange={chooseLens}
          label={t('changes')}
        />
        <IconButton
          className={css.headAction}
          icon={<IconRefreshOutlineRegular />}
          label={t('refresh')}
          onClick={refreshCurrent}
        />
      </div>
      {lens === 'git'
        ? (
          <GitLens
            ctx={ctx}
            scope={scope}
            store={store}
            visible={visible}
            refreshTick={refreshTick}
            onOpenFile={onOpenFile ?? (() => { /* no-op */ })}
            onPreview={previewGit}
            selectedRef={previewTarget !== null && previewTarget.kind === 'git' ? previewTarget.ref : null}
          />
        )
        : lens === 'commits'
          ? (
            <RoundCommitsLens
              scope={scope}
              visible={visible}
              refreshTick={refreshTick}
              adds={adds}
              roundStart={roundStart}
              onPreview={previewGit}
              selectedRef={previewTarget !== null && previewTarget.kind === 'git' ? previewTarget.ref : null}
            />
          )
          : (
            <SessionLens
              ops={ops}
              loadError={opsError && ops.length === 0}
              onPreview={previewOp}
              selectedCallId={selection !== null && selection.kind === 'op' ? selection.callId : null}
            />
          )}
      {previewTarget !== null && (
        <DiffPane
          key={previewKey(previewTarget)}
          target={previewTarget}
          ctx={ctx}
          scope={scope}
          height={paneHeight}
          onHeightCommit={(height) => { setPaneHeight(height); patchMeta({ previewH: height }) }}
          onClose={() => { setSelection(null) }}
          onExpand={expandPreview}
        />
      )}
      {selection !== null && selection.kind === 'op' && previewTarget === null && (
        <div className={css.paneGone}>
          <Notice kind="warn">{t('changesOpGone')}</Notice>
          <IconButton
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            label={t('changesClosePreview')}
            onClick={() => { setSelection(null) }}
          />
        </div>
      )}
    </div>
  )
}
