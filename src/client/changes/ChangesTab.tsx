/**
 * The unified changes tab: one tab, four lenses on "what changed?" — the
 * round commits (the session's own `git add` trail cross-checked against
 * `git log`, see {@link RoundCommitsLens}), Git (repository truth:
 * staged/unstaged files, commit box, history), the session round (agent
 * truth: every file the model read, wrote, or edited) and the round diff
 * (the whole round's changes as inline patches against the newest pre-round
 * commit, see {@link RoundDiffLens}). A 36px header carries the host
 * {@link SegmentedControl}, the 全部展开/全部收起 pair (driving the mounted
 * lens's {@link LensControl} fold handle) and the current lens's refresh
 * action; three lenses preview their selections in a shared resizable bottom
 * pane ({@link DiffPane}) — the round diff lays its patches out inline instead —
 * and git targets expand into the dedicated diff tab docked in the
 * workbench's diff pane. The active lens and the pane height persist in the
 * tab's meta, so the tab reopens exactly where it was left.
 *
 * The session events ride the host's `changes.ops` route (the client runtime
 * exposes no event-log face): the tab pulls the delta past its cursor and
 * folds it into ops (and, from the same window, the `git add` records), and
 * publishes the op count to a module-level cache the tab-strip badge reads.
 * The pull is one catch-up whenever the tab becomes visible or an
 * event-backed lens enters the screen, and then ONE one-shot fetch per
 * invalidation — the host's `ops` frames (see ../ops-push.ts) name the
 * session TREE (delegated agents write in child sessions), so the git lens
 * is the only lens with no use for the session event log (and the shared
 * git-status store owns its own poller).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconChevronsUpDownOutlineRegular, IconRefreshOutlineRegular, SegmentedControl,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSessionEvent } from '../../context-types.ts'
import type { TabComponentProps } from '../service.ts'
import { t } from '../locales.ts'
import { api } from '../api.ts'
import { useSessionOps } from '../ops-push.ts'
import { treeSessionIds } from '../subagent-lineage.ts'
import { clearTabLoading, setTabLoading } from '../tab-loading.ts'
import type { SidebarDiffRef } from '../state.ts'
import { IconButton, Notice } from '../ui/index.ts'
import { GitLens } from './GitLens.tsx'
import { SessionLens } from './SessionLens.tsx'
import { DiffPane, clampPaneHeight, diffTabOf, type ChangesPreview } from './DiffPane.tsx'
import { extractFileOps, knownContentBefore, type FileOp } from './ops.ts'
import { extractGitAdds, type GitAddRecord } from './round-commits.ts'
import { RoundCommitsLens } from './RoundCommitsLens.tsx'
import { RoundDiffLens } from './RoundDiffLens.tsx'
import type { LensControl } from './lens-control.ts'
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

/**
 * The append-merge identity of one session event: its (type, callId) pair —
 * the fold's own key (a tool call and its result share the callId but not the
 * type), so two events with the same identity fold to the same bytes and the
 * re-send the subtree server's closed bound produces can be dropped on
 * arrival. `null` for an event without a usable callId: it is appended
 * undeduplicated, because a lost real event can never be re-fetched (the
 * cursor already moved past it) while a duplicate is harmless.
 */
function identityOf(event: SidebarSessionEvent): string | null {
  const data = event.data as { callId?: unknown; message?: { source?: { callId?: unknown } } }
  const callId = event.type === 'tool/call'
    ? data.callId
    : data.message?.source?.callId
  return typeof callId === 'string' ? `${event.type}\u0000${callId}` : null
}

type Lens = 'commits' | 'git' | 'session' | 'rounddiff'

/** The persisted tab meta (JSON-serializable; rides the layout). */
interface ChangesMeta {
  lens?: Lens
  previewH?: number
  /**
   * The git lens' history path filter: an absolute path (the tree's 「查看
   * Git 历史」 hands one over) or a repo-relative pathspec the reader typed;
   * absent = the unfiltered branch log. Persisted so the filter survives the
   * lens switches (GitLens unmounts/remounts) and reloads.
   */
  gitPathFilter?: string
  /**
   * The monotonic request number the LAST 「查看 Git 历史」 hand-off rode in
   * on. ChangesTab adopts a filter only from a seq it has not adopted yet, so
   * the tab's own meta writes (lens picks, pane heights) never replay an old
   * request, and re-opening the SAME path still re-arms the git lens.
   */
  gitPathFilterSeq?: number
}

/**
 * The meta patch that delivers one 「查看 Git 历史」 request to the changes
 * tab: switch to the git lens and filter its history to `path` (a directory
 * pathspec covers the whole subtree — git's own rule). The seq makes every
 * request distinguishable from the tab's own meta writes, including a repeat
 * click on the same path. The opener spreads this over an existing tab's meta
 * (workbench lane) or seeds a fresh open with it (native lane) — see
 * EditorHost's `openGitHistory`.
 */
let gitPathFilterSeqCounter = 0
export function gitHistoryRequestMeta(path: string): { lens: 'git'; gitPathFilter: string; gitPathFilterSeq: number } {
  gitPathFilterSeqCounter += 1
  return { lens: 'git', gitPathFilter: path, gitPathFilterSeq: gitPathFilterSeqCounter }
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
  const [lens, setLens] = useState<Lens>(
    meta.lens === 'session'
      ? 'session'
      : meta.lens === 'commits'
        ? 'commits'
        : meta.lens === 'rounddiff'
          ? 'rounddiff'
          : 'git',
  )
  const [selection, setSelection] = useState<PreviewSelection | null>(null)
  /**
   * The git lens' history path filter (the meta field's live copy). Held HERE
   * — not inside GitLens — because GitLens is conditionally mounted: a lens
   * switch away and back must keep the filter, and the tree's 「查看 Git
   * 历史」 must reach it while the git lens is not even on screen.
   */
  const [gitPathFilter, setGitPathFilter] = useState<string | null>(
    typeof meta.gitPathFilter === 'string' && meta.gitPathFilter !== '' ? meta.gitPathFilter : null,
  )
  const [paneHeight, setPaneHeight] = useState<number>(() => clampPaneHeight(
    typeof meta.previewH === 'number' ? meta.previewH : PANE_HEIGHT_DEFAULT,
  ))
  /** The header refresh action: BOTH git-backed lenses reload through this
   *  tick (each lens owns its own queue; an unmounted lens ignores it). */
  const [refreshTick, setRefreshTick] = useState(0)
  /**
   * The mounted lens's fold handle ({@link LensControl}): the header's
   * 「全部展开」/「全部收起」 buttons call straight into whichever lens is on
   * screen. Every fold axis stays INSIDE its lens — the tab only forwards the
   * commands. React re-arms the ref on each lens switch (and detaches it when
   * a lens unmounts), so a click at worst reads null and no-ops; it can never
   * fold a lens that is not on screen.
   */
  const lensControl = useRef<LensControl | null>(null)

  // ── Session-event accumulation: one catch-up pull when the tab becomes
  //    visible or an event-backed lens enters the screen, then one one-shot
  //    delta fetch per WS invalidation while such a lens is showing. The
  //    cursor is the last delivered seq, so each pull ships only what the
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
  /** One delta request in flight at a time (a notice arriving while one runs
   *  is a no-op: the in-flight answer already carries everything up to now),
   *  and an invalidation landing mid-flight re-arms exactly one trailing
   *  pull — the timer-free replacement of the old poll's next tick. */
  const pullingRef = useRef(false)
  const pendingPullRef = useRef(false)
  const [opsError, setOpsError] = useState(false)
  const [tick, setTick] = useState(0)
  /**
   * Whether the tab's FIRST event pull has settled (resolve or reject —
   * whatever it brought back). Until it has, the page shows nothing but a
   * loading Notice and the tab reports itself loading to the strip (see the
   * effect below). A steady-state invalidation pull is NOT a load: once the
   * first pull is in, the flag stays true and the later pulls never touch it
   * (setting an already-true state is a React bail-out, no re-render).
   */
  const [firstPullSettled, setFirstPullSettled] = useState(false)
  const pull = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const generation = pollGen.current
    if (pullingRef.current) {
      pendingPullRef.current = true
      return
    }
    pullingRef.current = true
    try {
      const { events, lastSeq } = await api.changesOps(scope, seqRef.current, signal)
      // An aborted poll belongs to a torn-down run: its answer must never
      // publish state (the transport may deliver it anyway).
      if (generation !== pollGen.current || signal?.aborted === true) return
      // Nothing new: KEEP the previous fold's identity and touch nothing that
      // renders — not even the tick counter. This is a finished session's
      // steady state (the server answers an empty window), so an idle
      // invalidation pull must cost ZERO renders; `setOpsError(false)` is a
      // bail-out no-op while the flag is already false, and a real recovery
      // from an error still clears the banner with the one render it needs.
      if (events.length === 0 && lastSeq <= seqRef.current) {
        setOpsError(false)
        return
      }
      if (events.length > 0) {
        // Append the delta MERGED BY IDENTITY: the subtree server answers on
        // a CLOSED bound (`>= afterSeq` — see ./changes-subtree.ts), so its
        // boundary event rides again on every delta that carries anything
        // new. A repeated (type, callId) pair is exactly that re-send — the
        // fold below is keyed by callId, so refolding it changes nothing —
        // while a genuinely new event always carries a pair the window has
        // not seen. Events without a usable callId (the fold skips them
        // anyway) are appended without dedup so nothing real is ever dropped.
        const seen = new Set(eventsRef.current.map(identityOf))
        const fresh = events.filter(event => {
          const id = identityOf(event)
          return id === null || !seen.has(id)
        })
        if (fresh.length > 0) {
          const merged = [...eventsRef.current, ...fresh]
          eventsRef.current = merged.length > EVENTS_CAP ? merged.slice(merged.length - EVENTS_CAP) : merged
        }
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
      // The first pull has settled — its own outcome does not matter, the
      // tab is no longer "coming up" (idempotent for every later poll). A
      // STALE generation's settle must not land: the session switch has
      // already reset the flag for the fresh pull that is now in flight.
      if (generation === pollGen.current) {
        setFirstPullSettled(true)
        // An invalidation arrived mid-flight: re-pull once (the in-flight
        // answer was fetched before those rows landed). A stale generation
        // drops the re-arm — the session switch's own first pull covers it.
        if (pendingPullRef.current) {
          pendingPullRef.current = false
          void pull()
        }
      } else {
        pendingPullRef.current = false
      }
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
    // The new session's first pull has not run yet — the tab is "coming up"
    // again (the report effect below re-arms from this reset).
    setFirstPullSettled(false)
  }, [scope.sessionId])
  // One catch-up whenever the tab becomes visible (the badge count follows the
  // tab being opened), and one whenever an event-backed lens enters the screen
  // (the old poll's first tick used to serve this — an immediate one-shot
  // fetch, never a cadence). The git lens folds nothing from the session log,
  // so it pulls none.
  useEffect(() => { if (visible) void pull() }, [visible, pull])
  useEffect(() => { if (visible && lens !== 'git') void pull() }, [lens, pull])
  // The tab's ops watch set: the session plus its subagent descendants (the
  // `changes.ops` answer folds the whole parentSession subtree, so a child's
  // write must invalidate too). Root first — the host's 64-session watch
  // guard always keeps the head. A hydrating session row degrades to the
  // session itself.
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const watchIds = useMemo(
    () => [...new Set([scope.sessionId, ...treeSessionIds(sessionList.byId, scope.sessionId)])],
    [sessionList, scope.sessionId],
  )
  // WS-driven invalidation (see ../ops-push.ts): an `ops` frame of the session
  // tree — or the shared socket's re-open after a drop — pulls the delta
  // once, only while an event-backed lens is on screen. No timer drives any
  // request; a notice mid-flight re-arms one trailing pull inside `pull`.
  useSessionOps({
    sessionIds: visible && lens !== 'git' ? watchIds : [],
    onInvalidate: () => { void pull() },
    onReconnect: () => { void pull() },
  })
  // Report the first pull's in-flight state to the tab strip's loading
  // registry: until it settles the tab shows nothing but a loading Notice, so
  // the strip's spinner is the tab's only "this page is coming" feedback.
  // The cleanup clears on unmount (tab closed) so a spinner can never outlive
  // its load; the session switch above re-arms through the reset.
  useEffect(() => {
    setTabLoading(tab.id, visible && !firstPullSettled, scope.sessionId)
    return () => { clearTabLoading(tab.id, scope.sessionId) }
  }, [tab.id, visible, firstPullSettled, scope.sessionId])
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

  /**
   * Adopt an externally delivered 「查看 Git 历史」 request: the meta's
   * `gitPathFilterSeq` is a request number no mount of this tab has adopted
   * yet. The ref starts at the MOUNT meta's seq (a persisted request was
   * already applied by the initial state above — replaying it would yank a
   * reader who deliberately switched lenses back to git), so only a genuinely
   * new hand-off — including a repeat click on the same path — lands.
   */
  const adoptedGitRequest = useRef<number | null>(
    typeof meta.gitPathFilterSeq === 'number' && Number.isSafeInteger(meta.gitPathFilterSeq)
      ? meta.gitPathFilterSeq
      : null,
  )
  useEffect(() => {
    const next = (tab.meta ?? {}) as ChangesMeta
    const seq = typeof next.gitPathFilterSeq === 'number' && Number.isSafeInteger(next.gitPathFilterSeq)
      ? next.gitPathFilterSeq
      : null
    if (seq === null || seq === adoptedGitRequest.current) return
    adoptedGitRequest.current = seq
    setGitPathFilter(typeof next.gitPathFilter === 'string' && next.gitPathFilter !== '' ? next.gitPathFilter : null)
    setLens('git')
  }, [tab.meta])

  /** Set/clear the git lens' path filter (GitLens's chip; persisted like the
   *  lens choice — clearing stores the field's ABSENCE, not an empty string). */
  const changeGitPathFilter = (next: string | null): void => {
    setGitPathFilter(next)
    patchMeta({ gitPathFilter: next ?? undefined })
  }

  /** The header's refresh action: the git-backed lenses reload through their
   *  shared tick (GitLens's queue, the commits lens's fetch, the round diff's
   *  fetch), the session lens re-pulls its event delta — and the commits lens
   *  ALSO re-pulls, since its add evidence rides the same event window. */
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
            // round diff rides last (its patches are the widest read). The
            // segment shows the short name (four lenses share one 36px head);
            // the full name rides the hover title.
            { value: 'commits', label: t('changesCommitsLensShort'), title: t('changesCommitsLens') },
            { value: 'git', label: t('changesGitLens') },
            { value: 'session', label: t('changesSessionLens') },
            { value: 'rounddiff', label: t('changesRoundDiffLensShort'), title: t('changesRoundDiffLens') },
          ]}
          onChange={chooseLens}
          label={t('changes')}
        />
        <IconButton
          icon={<IconChevronsUpDownOutlineRegular />}
          label={t('changesExpandAll')}
          title={t('changesExpandAll')}
          onClick={() => { lensControl.current?.expandAll() }}
        />
        <IconButton
          icon={<IconChevronsUpDownOutlineRegular />}
          label={t('changesCollapseAll')}
          title={t('changesCollapseAll')}
          onClick={() => { lensControl.current?.collapseAll() }}
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
            ref={lensControl}
            ctx={ctx}
            scope={scope}
            store={store}
            visible={visible}
            refreshTick={refreshTick}
            pathFilter={gitPathFilter}
            onPathFilterChange={changeGitPathFilter}
            onOpenFile={onOpenFile ?? (() => { /* no-op */ })}
            onPreview={previewGit}
            selectedRef={previewTarget !== null && previewTarget.kind === 'git' ? previewTarget.ref : null}
          />
        )
        : lens === 'commits'
          ? (
            <RoundCommitsLens
              ref={lensControl}
              scope={scope}
              visible={visible}
              refreshTick={refreshTick}
              adds={adds}
              roundStart={roundStart}
              onPreview={previewGit}
              selectedRef={previewTarget !== null && previewTarget.kind === 'git' ? previewTarget.ref : null}
            />
          )
          : lens === 'rounddiff'
            ? (
              <RoundDiffLens
                ref={lensControl}
                ctx={ctx}
                store={store}
                scope={scope}
                visible={visible}
                refreshTick={refreshTick}
                roundStart={roundStart}
                onOpenFile={onOpenFile ?? (() => { /* no-op */ })}
              />
            )
            : (
              <SessionLens
                ref={lensControl}
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
