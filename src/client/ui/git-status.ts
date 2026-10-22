/**
 * The plugin's ONE git-status store.
 *
 * Before this module the git status was fetched by the changes tab alone
 * (a 2 s poll inside `changes/GitLens.tsx`) while the file tree had no git
 * data at all — so a VS Code-style "color the changed rows" feature would
 * have added a SECOND poller of the same `git status --porcelain` call. The
 * store keeps one snapshot per `sessionId + cwd + repoRoot + worktree`, one
 * push subscription per key while at least one VISIBLE consumer is
 * subscribed, and one path index built lazily per snapshot, so the tree
 * (coloring) and the changes page (list) read the same answer.
 *
 * The path index is keyed case-insensitively with '/' separators: git reports
 * repo-root-relative POSIX paths while the tree rows carry host paths (a
 * Windows host mixes separators), and a color lookup must not depend on that
 * difference. The cost is that two paths differing only in case share an
 * entry — invisible in the tree, which lists one of them anyway.
 *
 * Coalescing: a `refresh()` that lands while a fetch is in flight is queued
 * once and re-run when it settles — never dropped (the old `GitLens.refresh`
 * returned early, so a click during the poll silently did nothing).
 *
 * Freshness is EVENT-DRIVEN (the phase-2 polling rule): the store used to
 * re-fetch on a self-built `setInterval` ladder (30 s baseline, dropping a
 * tier whenever a round trip came back slow, finally stopping the timer —
 * a cost guard for pathological repositories). Every slot now subscribes,
 * for as long as at least one visible consumer holds it, to its session's
 * `/sidebar/ws/git` push socket (`../git-push.ts`, one connection per
 * sessionId): the host watches the
 * checkout's files and `.git` metadata and names the worktree when they
 * move, and the notice re-pulls ONCE — no client timer drives any fetch.
 * The old slow-tier ladder is subsumed by the notice path itself: the host
 * debounces bursts and floors them at one notice per 2 s per worktree, so
 * a continuously-written tree cannot keep a `git status` chain running
 * back to back, and an idle repository costs nothing at all. The
 * worktree identity of a slot is the linked checkout the consumer named,
 * else the checkout root the first answer reports (`snapshot.root`) —
 * before that first answer there is nothing to refresh anyway. Every
 * consumer keeps the event-driven refreshes (`refresh()`,
 * `invalidateGitStatus`) and the mount/visibility initial load.
 *
 * One kind of consumer exists: any visible one holds both the answer and
 * the subscription. (The old `poll: false` kind — the editor's gutter —
 * existed so a consumer could never keep a TIMER running; with the timer
 * gone the distinction is gone with it, and a gutter-held slot only
 * fetches when something actually changed.)
 *
 * Idle notices are silent: a fetch that returns the same status notifies
 * nobody. Bumping the version on every answer re-rendered every consumer
 * — the file tree's rows included — once per change for no reason, which
 * is what the snapshot identity check below exists to prevent.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type GitLineCounts, type GitStatusResult, type SessionScope } from '../api.ts'
import { subscribeGitWatch, type GitWatchHandle } from '../git-push.ts'

/** The semantic class of one changed path (drives the row's ink). */
export type GitTone =
  | 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied' | 'conflict'

/** One path's git state, derived from its two-letter porcelain code. */
export interface GitFileStatus {
  /** Display letter: the index side wins, else the worktree side ('??' → 'U'). */
  letter: string
  tone: GitTone
  /** The index (staged) side carries a change. */
  staged: boolean
  /** The worktree (unstaged) side carries a change. */
  unstaged: boolean
}

/** The porcelain letter → tone rule (both sides share one vocabulary). */
function toneOfLetter(letter: string): GitTone | undefined {
  switch (letter) {
    case 'M': return 'modified'
    case 'T': return 'modified'
    case 'A': return 'added'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'U': return 'conflict'
    default: return undefined
  }
}

/**
 * Derive one path's status from its porcelain `XY` code, or `undefined` for a
 * clean (`'  '`) or ignored (`'!!'`) entry. Untracked (`??`) reports 'U' —
 * git's own letter for "not in the index" would be a blank.
 */
export function statusOfXY(xy: string): GitFileStatus | undefined {
  if (xy === '??') return { letter: 'U', tone: 'untracked', staged: false, unstaged: true }
  if (xy.length < 2 || xy === '!!') return undefined
  const x = xy[0]!
  const y = xy[1]!
  if (x === ' ' && y === ' ') return undefined
  const staged = x !== ' ' && x !== '?'
  const unstaged = y !== ' ' && y !== '?'
  // A conflict (any unmerged combination) outranks a plain modification: the
  // user must act on it first, so it owns the row's ink.
  const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
  const tone = conflict
    ? 'conflict'
    : toneOfLetter(x !== ' ' && x !== '?' ? x : y) ?? 'modified'
  return {
    letter: x !== ' ' && x !== '?' ? x : y,
    tone,
    staged,
    unstaged,
  }
}

/**
 * The TortoiseGit-style severity ladder of the overlay vocabulary: which tone
 * WINS when a directory's subtree holds several. A conflict demands action
 * before anything else, a deletion can eat work, and so on down to an
 * untracked file — the same intuition TortoiseGit's overlay set encodes, and
 * the order the directory badge shows (`dirToneOf` answers the WORST tone
 * under the directory, because that is the one the user must notice).
 */
const TONE_SEVERITY: Readonly<Record<GitTone, number>> = {
  conflict: 6,
  deleted: 5,
  modified: 4,
  added: 3,
  renamed: 2,
  copied: 1,
  untracked: 0,
}

/**
 * The store's normalized path key (case-insensitive, '/' separators).
 */
function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Join a repo-root-relative git path onto the repo root. */
function joinRoot(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return `${base}/${rel.replace(/^[\\/]+/, '')}`
}

/**
 * Whether two entries carry the same line counts. A numstat-only change — an
 * edit that adds lines without touching either porcelain letter, e.g. more
 * lines appended to an already-modified file — must still publish a NEW
 * snapshot: keeping the previous identity would freeze the row's numbers at
 * their first reading for as long as the porcelain codes stay put.
 */
function sameCounts(left: GitLineCounts | undefined, right: GitLineCounts | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if ('additions' in left && 'additions' in right) {
    return left.additions === right.additions && left.deletions === right.deletions
  }
  return 'binary' in left && 'binary' in right
}

/**
 * Whether two status snapshots carry the same information. Compared field by
 * field (never by serializing the whole object): the entries are the payload
 * and their order is stable, so a length + pairwise compare is enough.
 */
function sameStatus(a: GitStatusResult, b: GitStatusResult): boolean {
  if (a === b) return true
  if (a.isRepo !== b.isRepo || a.branch !== b.branch || a.root !== b.root
    || a.truncated !== b.truncated || a.entries.length !== b.entries.length) return false
  if (a.repositories?.length !== b.repositories?.length) return false
  if (a.repositories !== undefined && b.repositories !== undefined
    && a.repositories.some((root, index) => root !== b.repositories![index])) return false
  // The ignore list is part of the payload (it moves the tree's ⊘ badges):
  // an idle poll that brings a different ignore set must notify, and one
  // that re-answers with the same set must stay silent. `undefined` and `[]`
  // are the same answer — the field is optional for older snapshots.
  const aIgnored = a.ignored ?? []
  const bIgnored = b.ignored ?? []
  if (a.ignoredTruncated === true !== (b.ignoredTruncated === true)) return false
  if (aIgnored.length !== bIgnored.length) return false
  if (aIgnored.some((path, index) => path !== bIgnored[index])) return false
  return a.entries.every((entry, index) => {
    const other = b.entries[index]!
    return entry.path === other.path && entry.xy === other.xy && sameCounts(entry.counts, other.counts)
  })
}

interface Index {
  /** Normalized absolute path → status (files only). */
  files: Map<string, GitFileStatus>
  /**
   * Normalized absolute directory → the WORST tone anywhere in its subtree
   * (the {@link TONE_SEVERITY} ladder decides). The file tree's TortoiseGit
   * badges read this directly (`dirToneOf`); the plain membership question
   * (`dirHasChanges`) stays a `.has()` on the same map, so its old callers
   * see no difference.
   */
  dirs: Map<string, GitTone>
  /**
   * Normalized absolute paths git IGNORES — both the entries themselves
   * (files AND collapsed `dir/` rows) and, through the ancestor walk in
   * `isIgnored`, everything under an ignored directory. Nothing here can
   * wear a change badge (git never reports one for an ignored path); the
   * set exists so the tree can badge these rows ⊘ instead of lying with
   * the green ✓.
   */
  ignored: Set<string>
}

/** Build the lookup index for one snapshot (once per snapshot, O(rows × depth)). */
function buildIndex(snapshot: GitStatusResult): Index {
  const files = new Map<string, GitFileStatus>()
  const dirs = new Map<string, GitTone>()
  const ignored = new Set<string>()
  const root = snapshot.root
  if (!snapshot.isRepo || root === undefined) return { files, dirs, ignored }
  for (const entry of snapshot.entries) {
    const status = statusOfXY(entry.xy)
    if (status === undefined) continue
    const absolute = normPath(joinRoot(root, entry.path))
    files.set(absolute, status)
    // Propagate the file's tone UP the ancestor chain, keeping the worst one
    // seen (`dirToneOf` = the subtree's most severe). The early break is the
    // original Set version's, promoted to severities: the walk may stop at
    // the first ancestor whose stored tone already outranks this file's,
    // because an ancestor's tone is ALWAYS ≥ its children's — every write to
    // a directory carried the same tone (or a worse one) to everything above
    // it, so a stronger stored tone implies the whole chain above is strong
    // too. Without that invariant the break would under-report a directory
    // two levels up; with it, each changed file costs O(depth) map writes at
    // most, exactly what the Set build cost.
    let at = absolute.lastIndexOf('/')
    while (at > 0) {
      const dir = absolute.slice(0, at)
      const existing = dirs.get(dir)
      if (existing !== undefined && TONE_SEVERITY[existing] >= TONE_SEVERITY[status.tone]) break
      dirs.set(dir, status.tone)
      at = dir.lastIndexOf('/')
    }
  }
  // The ignored entries: the row itself (a collapsed `dir/` arrives here
  // slash-stripped by normPath) seeds the set, and the ancestor walk inside
  // `isIgnored` covers everything UNDER an ignored directory — one Set, no
  // per-descendant rows to enumerate (node_modules stays O(1), never O(n)).
  for (const rel of snapshot.ignored ?? []) {
    const absolute = normPath(joinRoot(root, rel))
    if (absolute !== '') ignored.add(absolute)
  }
  return { files, dirs, ignored }
}

interface Slot {
  key: string
  sessionId: string
  cwd: string | undefined
  repoRoot: string | undefined
  worktree: string | undefined
  snapshot: GitStatusResult | null
  loading: boolean
  error: boolean
  version: number
  /** Bumped per fetch so a late response from an older fetch is dropped. */
  generation: number
  running: boolean
  pending: boolean
  /** Consumers that want the ANSWER (each visible consumer holds one). */
  visible: number
  /** The push subscription while at least one consumer holds the slot. */
  watch: GitWatchHandle | undefined
  listeners: Set<() => void>
  index: Index | null
  /** The snapshot the current index was built from (identity compare). */
  indexSource: GitStatusResult | null
}

const slots = new Map<string, Slot>()

function slotOf(scope: SessionScope, worktree: string | undefined): Slot {
  const { sessionId, cwd, repoRoot } = scope
  const key = `${sessionId}\u0000${cwd ?? ''}\u0000${repoRoot ?? ''}\u0000${worktree ?? ''}`
  const existing = slots.get(key)
  if (existing !== undefined) return existing
  const slot: Slot = {
    key, sessionId, cwd, repoRoot, worktree,
    snapshot: null, loading: false, error: false, version: 0, generation: 0,
    running: false, pending: false, visible: 0, watch: undefined,
    listeners: new Set(),
    index: null, indexSource: null,
  }
  slots.set(key, slot)
  return slot
}

function notify(slot: Slot): void {
  slot.version += 1
  for (const listener of slot.listeners) listener()
}

/** Fetch one snapshot; a concurrent call just marks the slot dirty. */
function fetchSlot(slot: Slot): void {
  if (slot.running) {
    slot.pending = true
    return
  }
  slot.running = true
  const generation = ++slot.generation
  const wasLoading = slot.loading
  slot.loading = slot.snapshot === null
  if (slot.loading !== wasLoading) notify(slot)
  // Whether this fetch changed anything a consumer can SEE. An idle notice
  // that returns the same status must stay silent: the version counter is
  // the `useSyncExternalStore` snapshot, so notifying re-renders every
  // consumer — the changes list and every rendered file-tree row with it —
  // once per change for nothing. The snapshot identity below is preserved
  // for exactly this reason; the notification has to honour it too.
  let changed = false
  const scope: SessionScope = { sessionId: slot.sessionId, cwd: slot.cwd, repoRoot: slot.repoRoot }
  api.gitStatus(scope, slot.worktree)
    .then((snapshot) => {
      if (generation !== slot.generation) return
      // Idle notices return the same answer as a NEW object. Keeping the
      // previous identity when nothing changed is what lets every downstream
      // memo (the changes tree, the file tree's row model, the icon index)
      // hold across refreshes.
      if (slot.snapshot !== null && sameStatus(slot.snapshot, snapshot)) {
        if (slot.error) { slot.error = false; changed = true }
        return
      }
      slot.snapshot = snapshot
      slot.error = false
      changed = true
      // The first answer names the checkout this slot describes — exactly
      // the worktree identity the push subscription keys on. Before it,
      // only the consumer-named linked checkout could be subscribed.
      ensureSlotWatch(slot)
    })
    .catch(() => {
      if (generation !== slot.generation) return
      if (!slot.error) { slot.error = true; changed = true }
    })
    .finally(() => {
      if (generation !== slot.generation) return
      slot.running = false
      const stillLoading = slot.loading
      slot.loading = false
      if (changed || stillLoading) notify(slot)
      if (slot.pending) {
        slot.pending = false
        fetchSlot(slot)
      }
    })
}

/** The worktree identity this slot's answer describes: the linked checkout
 *  the consumer named, else the checkout root the last answer reported. */
function watchRootsOf(slot: Slot): string[] {
  if (slot.worktree !== undefined) return [slot.worktree]
  const snapshot = slot.snapshot
  const root = snapshot?.root
  return snapshot !== null && snapshot.isRepo && typeof root === 'string' && root !== ''
    ? [root]
    : []
}

/**
 * Subscribe the slot to the shared git push socket — once it has a worktree
 * identity and a consumer to refresh. A notice (or the socket's reconnect)
 * re-pulls ONE snapshot through the coalescing fetch above; the hub filters
 * frames by the set given here, so the slot only ever hears about ITS
 * checkout.
 */
function ensureSlotWatch(slot: Slot): void {
  if (slot.watch !== undefined || slot.visible === 0) return
  const roots = watchRootsOf(slot)
  if (roots.length === 0) return
  const invalidate = (): void => { if (slot.visible > 0) fetchSlot(slot) }
  slot.watch = subscribeGitWatch(slot.sessionId, roots, invalidate, invalidate)
}

function retain(slot: Slot): void {
  slot.visible += 1
  // The answer is fetched for the FIRST consumer, and the subscription
  // follows the same edge — the last consumer's release drops both.
  if (slot.visible === 1) {
    if (slot.snapshot === null) fetchSlot(slot)
    ensureSlotWatch(slot)
  }
}

function release(slot: Slot): void {
  slot.visible = Math.max(0, slot.visible - 1)
  if (slot.visible === 0) {
    if (slot.watch !== undefined) {
      slot.watch.close()
      slot.watch = undefined
    }
    // No consumer left: drop the snapshot so a later mount re-reads the truth
    // instead of coloring rows from a stale answer.
    slot.snapshot = null
    slot.index = null
    slot.indexSource = null
    notify(slot)
  }
}

/** The index for the current snapshot, rebuilt only when the snapshot changed. */
function indexOf(slot: Slot): Index {
  if (slot.index === null || slot.indexSource !== slot.snapshot) {
    slot.index = slot.snapshot === null
      ? { files: new Map(), dirs: new Map(), ignored: new Set() }
      : buildIndex(slot.snapshot)
    slot.indexSource = slot.snapshot
  }
  return slot.index
}

/**
 * Force a re-read of one session's git status (after stage/commit/discard,
 * or from a manual refresh). Queues one fetch when another is in flight.
 * Every live key of that session is refreshed, so the tree and the changes
 * page never disagree.
 */
export function invalidateGitStatus(sessionId: string): void {
  for (const slot of slots.values()) {
    if (slot.sessionId === sessionId) fetchSlot(slot)
  }
}

/** The consumer-facing view of one key's status. */
export interface GitStatusView {
  /** The last snapshot, or null before the first answer. */
  snapshot: GitStatusResult | null
  loading: boolean
  error: boolean
  /** Re-read now (queued when a fetch is already in flight). */
  refresh(): void
  /** The status of one absolute path, or undefined when clean/unknown. */
  statusOf(absolutePath: string): GitFileStatus | undefined
  /** Whether `absoluteDir` or anything under it has a change. */
  dirHasChanges(absoluteDir: string): boolean
  /**
   * Whether `absolutePath` is one of git's IGNORED paths or lives under an
   * ignored directory. The file tree badges these rows ⊘ (they sit outside
   * the repository's management) instead of the lying green ✓; `false` also
   * covers a missing/failed ignore read, where "not known ignored" must
   * degrade to the old behavior, never to a fabricated badge.
   */
  isIgnored(absolutePath: string): boolean
  /**
   * The WORST tone anywhere under `absoluteDir` (the TortoiseGit severity
   * ladder), or undefined when the subtree is clean/unknown. What the file
   * tree's directory badges paint — a plain "has changes" boolean cannot tell
   * a conflict-red row from an untracked one.
   */
  dirToneOf(absoluteDir: string): GitTone | undefined
}

/**
 * Subscribe to the shared git status of one session (optionally of one linked
 * worktree). While `visible` is true the consumer holds the answer AND the
 * slot's push subscription (its session's `/sidebar/ws/git` socket): the
 * first answer is fetched on the first visible consumer, every host notice of
 * the slot's checkout re-pulls it once, and the last consumer's release drops
 * both the snapshot and the subscription. No consumer can keep a timer
 * running, because there is no timer — a held slot only fetches when
 * something actually changed.
 */
export function useGitStatus(
  scope: SessionScope,
  options: {
    worktree?: string
    visible?: boolean
    /**
     * @deprecated No-op since the timer ladder was removed (the phase-2
     *  polling rule): every visible consumer holds the push subscription,
     *  and the removed `poll: false` kind (the editor's gutter) is subsumed
     *  by "fetches only when something changed". Kept in the TYPE so the
     *  not-yet-migrated specs keep typechecking.
     */
    poll?: boolean
    /** @deprecated No-op with the timer gone (see {@link poll}). */
    pollMs?: number
  } = {},
): GitStatusView {
  const { worktree, visible = true } = options
  const slot = slotOf(scope, worktree)
  const subscribe = useCallback((listener: () => void) => {
    slot.listeners.add(listener)
    return () => { slot.listeners.delete(listener) }
  }, [slot])
  // The third argument (server snapshot) keeps a consumer that is rendered to
  // a string alive — the editor does exactly that in the markdown specs, and
  // the slot's version is 0 on both sides.
  useSyncExternalStore(subscribe, () => slot.version, () => slot.version)

  useEffect(() => {
    if (!visible) return undefined
    retain(slot)
    return () => { release(slot) }
  }, [slot, visible])

  const refresh = useCallback(() => { fetchSlot(slot) }, [slot])
  const statusOf = useCallback(
    (absolutePath: string) => indexOf(slot).files.get(normPath(absolutePath)),
    [slot],
  )
  const dirHasChanges = useCallback(
    (absoluteDir: string) => indexOf(slot).dirs.has(normPath(absoluteDir)),
    [slot],
  )
  const isIgnored = useCallback((absolutePath: string): boolean => {
    // Ancestor walk: the path itself, then each parent, against ONE set that
    // holds both ignored entries and collapsed ignored directories. O(depth)
    // Set hits per query — the same cost class as the render-path lookups
    // above, and the empty-set fast path keeps non-repo trees at O(1).
    const ignored = indexOf(slot).ignored
    if (ignored.size === 0) return false
    let at = normPath(absolutePath)
    while (at !== '') {
      if (ignored.has(at)) return true
      const cut = at.lastIndexOf('/')
      at = cut <= 0 ? '' : at.slice(0, cut)
    }
    return false
  }, [slot])
  const dirToneOf = useCallback(
    (absoluteDir: string) => indexOf(slot).dirs.get(normPath(absoluteDir)),
    [slot],
  )

  return { snapshot: slot.snapshot, loading: slot.loading, error: slot.error, refresh, statusOf, dirHasChanges, dirToneOf, isIgnored }
}
