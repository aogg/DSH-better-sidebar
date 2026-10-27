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
 *
 * The store refines WHAT a notice costs in three steps, all additive:
 *
 * - HYDRATION (`./git-status-storage.ts`): every accepted snapshot is
 *   written through to `localStorage`, and a slot hydrates from it at
 *   creation — the first paint of a fresh page already carries the last
 *   answer's ink, and the push subscription attaches before the
 *   calibration pull returns (the cached answer names the checkout root).
 *   The pull itself always still runs: the cache decides how the page
 *   looks for its first instants, the live answer what it converges to.
 *   At most the freshest eight slot documents survive (an LRU sweep on
 *   the key prefix); storage failures degrade to memory, never break a
 *   render.
 * - PER-PATH PATCHING: the host's file watcher now names WHAT moved — a
 *   `git` frame can carry `paths` (worktree-relative, deduped, capped;
 *   absent on pure `.git` metadata events, on overflow, and from old
 *   hosts). A paths-bearing notice no longer re-pulls the whole
 *   repository: the paths are deduplicated, chunked, and answered by
 *   `git.statusPaths` (only what was asked), and the answer is patched
 *   into the snapshot row by row — added/changed rows land, rows that
 *   went clean are dropped, the ignored overlay merges the same way —
 *   with ONE notify at the end and only when something actually changed.
 *   A paths-LESS notice (or a patch whose answer says truncated / root
 *   mismatched) still means "any path may have moved" and takes the full
 *   calibration pull, as does the socket's reconnect catch-up.
 * - TURN CALIBRATION: while a slot is visibly held it also holds its
 *   session's turn subscription (`../turn-push.ts`): each settled reply
 *   of the agent (a durable assistant step — the model just wrote its
 *   files) triggers one full asynchronous re-pull, so the tree's ink is
 *   honest at the end of every round even if the file watcher's burst
 *   window folded the writes into a notice the slot patched coarsely.
 *   The subscription follows the SAME visible edge as the watch — no
 *   consumer, no socket, no fetch of any kind.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, type GitLineCounts, type GitStatusPathsResult, type GitStatusResult, type SessionScope } from '../api.ts'
import { subscribeGitWatch, type GitWatchHandle } from '../git-push.ts'
import { subscribeSessionTurns } from '../turn-push.ts'
import { readGitStatusSnapshot, writeGitStatusSnapshot } from './git-status-storage.ts'

/** How many paths one incremental `gitStatusPaths` call carries. Well below
 *  the host's own pathspec cap (200): the chunk bounds one request's argv and
 *  keeps a 64-path overflow notice — patched as a paths-less full pull in
 *  practice — from ever crossing the wire as one giant ask anyway. */
const GIT_PATHS_CHUNK = 128

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
 * Lexically resolve an absolute path's `.`/`..` segments (preserving the
 * leading separator). The patch path joins worktree-relative frame paths
 * through the snapshot root, and a `../`-spelled name must leave the root
 * instead of merely sitting under a `root/..` prefix that string-prefix
 * checks would wrongly call "inside".
 */
function lexicalAbsolute(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`
  const segments: string[] = []
  for (const segment of absolute.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
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
  /** The session-turn subscription (the reply-settled calibration) while
   *  at least one consumer holds the slot — the same visible edge. */
  turns: (() => void) | undefined
  listeners: Set<() => void>
  index: Index | null
  /** The snapshot the current index was built from (identity compare). */
  indexSource: GitStatusResult | null
  /** A per-path patch is in flight; its chunks must not stampede. */
  patchRunning: boolean
  /** Paths a notice named while a patch ran — folded into one trailing patch. */
  patchPending: Map<string, string> | undefined
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
    running: false, pending: false, visible: 0, watch: undefined, turns: undefined,
    listeners: new Set(),
    index: null, indexSource: null,
    patchRunning: false, patchPending: undefined,
  }
  // Hydrate BEFORE anything can render the slot: the cached snapshot (if any)
  // colors the first paint, and its `root` is the worktree identity the push
  // subscription keys on — so the socket attaches at the first retain, before
  // the calibration pull returns. The pull still always runs; the cache only
  // decides the first instants.
  slot.snapshot = readGitStatusSnapshot(gitStatusStorageKeyOf(slot))
  slots.set(key, slot)
  return slot
}

/** The slot's localStorage key (sessionId + cwd/worktree digest — see the
 *  storage module). */
function gitStatusStorageKeyOf(slot: Slot): string {
  return gitStatusStorageKey(slot.sessionId, slot.cwd, slot.worktree)
}

/**
 * (Re-)hydrate a slot from storage. Runs at creation AND at the first
 * retain after a release: a release drops the in-memory snapshot, but the
 * stored document survives, so the next mount pre-colors from it again and
 * recalibrates with the pull that follows. A hydrated snapshot never blocks
 * a fetch — the retain path fetches unconditionally (see retain).
 */
function hydrateSlot(slot: Slot): void {
  if (slot.snapshot !== null) return
  slot.snapshot = readGitStatusSnapshot(gitStatusStorageKeyOf(slot))
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
      // The answer is durable across reloads: write it through (a storage
      // failure degrades silently — see the storage module). An idle answer
      // (same status) skips the write: nothing the cache could gain.
      writeGitStatusSnapshot(gitStatusStorageKeyOf(slot), snapshot)
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

/**
 * The per-path notice: patch the snapshot for exactly the paths the host
 * named, never re-pull the repository.
 *
 * Flow: deduplicate the frame's paths against the store's normalized key
 * (original spellings ride the wire — a lowercased pathspec would miss on
 * a case-sensitive checkout), drop paths outside the slot's repository
 * root (they cannot have a status here), chunk below
 * {@link GIT_PATHS_CHUNK}, and answer each chunk with `gitStatusPaths`.
 * Every answer is merged into the CURRENT snapshot (see applyPathsAnswer);
 * the index rebuilds once per chunk; ONE notify follows — and only when
 * something a consumer could see actually changed (the same idle-silence
 * contract the full pull runs under). A successful patch writes through
 * to storage like any accepted answer.
 *
 * Guards: no visible consumer → nothing runs (the same rule the fetch
 * path obeys); no snapshot yet (a notice racing the first pull, or an
 * error state) → the full fetch takes over, there is nothing to patch;
 * a truncated answer or a root that disagrees with the snapshot's → the
 * patch cannot be trusted, the full fetch recalibrates; a failed request
 * → the patch gives up silently (the next full calibration heals — a
 * patch failure must never flip the slot's error state, which belongs to
 * the full read); a snapshot replaced mid-patch → the patch abandons (the
 * newer full answer already knows more). A notice landing while a patch
 * runs is folded into ONE trailing patch (the fetch path's pending flag,
 * per-path).
 */
function patchSlot(slot: Slot, rawPaths: readonly string[]): void {
  if (slot.visible === 0) return
  /** normalized key → the ORIGINAL spelling (the wire carries originals). */
  const wanted = new Map<string, string>()
  for (const raw of rawPaths) {
    if (typeof raw !== 'string' || raw === '') continue
    const normalized = normPath(raw)
    if (!wanted.has(normalized)) wanted.set(normalized, raw)
  }
  if (wanted.size === 0) return
  if (slot.patchRunning) {
    const pending = slot.patchPending ?? new Map<string, string>()
    for (const [normalized, original] of wanted) if (!pending.has(normalized)) pending.set(normalized, original)
    slot.patchPending = pending
    return
  }
  slot.patchRunning = true
  void runPatch(slot, wanted).finally(() => {
    slot.patchRunning = false
    const pending = slot.patchPending
    slot.patchPending = undefined
    if (pending !== undefined && pending.size > 0 && slot.visible > 0) patchSlot(slot, [...pending.values()])
  })
}

/** One patch pass over one deduplicated path set. */
async function runPatch(slot: Slot, wanted: Map<string, string>): Promise<void> {
  if (slot.visible === 0) return
  const snapshot = slot.snapshot
  if (snapshot === null || !snapshot.isRepo || snapshot.root === undefined) {
    fetchSlot(slot)
    return
  }
  const rootNorm = normPath(snapshot.root)
  // The frame's paths are worktree-RELATIVE (the host's watcher reports
  // filenames against the watch root); the store's rows and the
  // `gitStatusPaths` wire are ABSOLUTE (the host route folds them back to
  // pathspecs against its own root — relative spellings would resolve
  // against the session cwd, which may be a subdirectory of the checkout).
  // Join through the snapshot root and key on the store's normalized form.
  const root = snapshot.root
  const inside = new Map<string, string>()
  for (const [, original] of wanted) {
    const absolute = /^(?:[A-Za-z]:)?\//.test(original) ? lexicalAbsolute(original) : lexicalAbsolute(joinRoot(root, original))
    const normalized = normPath(absolute)
    if ((normalized === rootNorm || normalized.startsWith(`${rootNorm}/`)) && !inside.has(normalized)) {
      inside.set(normalized, absolute)
    }
  }
  if (inside.size === 0) return
  const scope: SessionScope = { sessionId: slot.sessionId, cwd: slot.cwd, repoRoot: slot.repoRoot }
  let changed = false
  const flat = [...inside.entries()]
  for (let at = 0; at < flat.length; at += GIT_PATHS_CHUNK) {
    const chunk = flat.slice(at, at + GIT_PATHS_CHUNK)
    let answer: GitStatusPathsResult
    try {
      answer = await api.gitStatusPaths(scope, chunk.map(([, absolute]) => absolute), slot.worktree)
    } catch {
      return // silent: the next full calibration (turn / paths-less notice) heals
    }
    // Superseded (a full fetch replaced the snapshot), released, or the
    // answer describes a different checkout than the snapshot's: the patch
    // cannot be trusted — the full read recalibrates.
    if (slot.visible === 0 || slot.snapshot !== snapshot) return
    if (answer.truncated === true || answer.root === undefined || normPath(answer.root) !== rootNorm) {
      fetchSlot(slot)
      return
    }
    changed = applyPathsAnswer(slot, snapshot, chunk, answer) || changed
  }
  if (changed && slot.snapshot !== null) {
    writeGitStatusSnapshot(gitStatusStorageKeyOf(slot), slot.snapshot)
    notify(slot)
  }
}

/**
 * Merge ONE `gitStatusPaths` answer into the slot's snapshot. The
 * requested paths define the patch's blast radius — everything at or under
 * them is REPLACED by the answer (an answered row updates its letter and
 * counts, an un-answered old row went clean and is dropped, an answered
 * ignored row joins the overlay, an ignored row the answer stops listing
 * is removed) — and everything else is untouched. Absolute identity runs
 * through the store's `normPath` (case-insensitive, '/'-separated), the
 * same key the index builds on, so Windows separators and case never
 * split a row.
 *
 * Row ORDER is preserved for the surviving rows; newly-answered rows
 * append. A later full pull re-orders canonically — a patch only has to
 * be truthful, not git's own order.
 *
 * @returns whether any consumer-visible field actually moved (the caller
 *  notifies only then).
 */
function applyPathsAnswer(
  slot: Slot,
  before: GitStatusResult,
  requested: ReadonlyArray<[normalized: string, original: string]>,
  answer: GitStatusPathsResult,
): boolean {
  const root = before.root
  if (root === undefined) return false
  const underRequested = (abs: string): boolean =>
    requested.some(([normalized]) => abs === normalized || abs.startsWith(`${normalized}/`))
  // The answer, keyed the way the snapshot is keyed.
  const answered = new Map<string, GitStatusResult['entries'][number]>()
  for (const entry of answer.entries) {
    answered.set(normPath(joinRoot(root, entry.path)), entry)
  }
  /** The patched rows, git's root-relative spelling (the snapshot's own). */
  const rows: GitStatusResult['entries'] = []
  const seen = new Set<string>()
  let mutated = 0
  for (const entry of before.entries) {
    const abs = normPath(joinRoot(root, entry.path))
    if (seen.has(abs)) continue // duplicate spelling: one row is the truth
    seen.add(abs)
    if (!underRequested(abs)) {
      rows.push(entry)
      continue
    }
    const fresh = answered.get(abs)
    if (fresh === undefined) {
      mutated += 1 // the path went clean: absence IS the answer
      continue
    }
    answered.delete(abs)
    if (fresh.xy !== entry.xy || !sameCounts(fresh.counts, entry.counts)) mutated += 1
    rows.push(fresh)
  }
  let added = 0
  for (const entry of answer.entries) {
    const abs = normPath(joinRoot(root, entry.path))
    if (!underRequested(abs) || seen.has(abs)) continue
    seen.add(abs)
    rows.push(entry)
    added += 1
  }
  // The ignored overlay, same blast radius: re-keyed by normalized absolute
  // path, rows at/under the request replaced by the answer's subset. The
  // sweep below drops rows the answer stopped listing.
  const ignoredOld = before.ignored ?? []
  const ignoredMap = new Map<string, string>()
  for (const rel of ignoredOld) {
    const abs = normPath(joinRoot(root, rel))
    if (abs !== '' && !ignoredMap.has(abs)) ignoredMap.set(abs, rel)
  }
  const scopedBefore = new Set<string>()
  for (const abs of ignoredMap.keys()) if (underRequested(abs)) scopedBefore.add(abs)
  for (const rel of answer.ignored) {
    const abs = normPath(joinRoot(root, rel))
    if (abs === '' || !underRequested(abs)) continue
    scopedBefore.add(abs) // answered rows survive the sweep below
    ignoredMap.set(abs, rel)
  }
  for (const abs of [...ignoredMap.keys()]) {
    if (underRequested(abs) && !scopedBefore.has(abs)) ignoredMap.delete(abs)
  }
  const ignored = [...ignoredMap.values()]
  const branch = answer.branch ?? before.branch
  const ignoredChanged = ignored.length !== ignoredOld.length
    || ignored.some(rel => !ignoredOld.includes(rel))
  const changed = mutated > 0 || added > 0 || ignoredChanged || branch !== before.branch
  if (!changed) return false
  // One new snapshot object per accepted patch — the identity discipline
  // the full pull runs under (downstream memos compare references).
  slot.snapshot = { ...before, branch, entries: rows, ignored }
  // The index rebuilds lazily on the next read, once per patched batch —
  // the same defer the full pull's notify path uses.
  slot.index = null
  slot.indexSource = null
  return true
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
 * identity and a consumer to refresh. A paths-bearing notice patches the
 * snapshot per path (the incremental read — see patchSlot); a paths-LESS
 * notice (pure `.git` metadata, overflow, an old host) and the socket's
 * reconnect catch-up re-pull the WHOLE snapshot, because those are exactly
 * the events that can move any path (stage / commit / checkout / an outage
 * whose frames were swallowed). The hub filters frames by the set given
 * here, so the slot only ever hears about ITS checkout. The session-turn
 * subscription rides the same visible edge (see ensureSlotTurns).
 */
function ensureSlotWatch(slot: Slot): void {
  if (slot.visible === 0) return
  ensureSlotTurns(slot)
  if (slot.watch !== undefined) return
  const roots = watchRootsOf(slot)
  if (roots.length === 0) return
  const invalidate = (worktree: string, paths?: string[]): void => {
    if (slot.visible === 0) return
    if (paths !== undefined && paths.length > 0) patchSlot(slot, paths)
    else fetchSlot(slot)
  }
  const catchUp = (): void => { if (slot.visible > 0) fetchSlot(slot) }
  slot.watch = subscribeGitWatch(slot.sessionId, roots, invalidate, catchUp)
}

/**
 * Hold the slot's session-turn subscription while it is visibly consumed:
 * every settled reply of the agent (a durable assistant step — typically
 * "the model just wrote/committed files") triggers one FULL asynchronous
 * calibration re-pull through the coalescing fetch. The subscription needs
 * only the sessionId (the endpoint's own fence), so it attaches at the
 * first retain — earlier than the git watch can, which waits for the
 * answer to name the checkout. The last release drops it: a slot nobody
 * sees holds no socket and runs no fetch.
 */
function ensureSlotTurns(slot: Slot): void {
  if (slot.turns !== undefined || slot.visible === 0) return
  slot.turns = subscribeSessionTurns(slot.sessionId, () => {
    if (slot.visible > 0) fetchSlot(slot)
  })
}

function retain(slot: Slot): void {
  slot.visible += 1
  // The answer is fetched for the FIRST consumer — always, even over a
  // hydrated cache (the cache only pre-colors; the pull is the arbiter) —
  // and both subscriptions follow the same edge; the last consumer's
  // release drops all three.
  if (slot.visible === 1) {
    hydrateSlot(slot)
    fetchSlot(slot)
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
    if (slot.turns !== undefined) {
      slot.turns()
      slot.turns = undefined
    }
    // A trailing patch may still land after the release; it must not
    // resurrect the slot's data — patchSlot/runPatch re-check `visible`
    // at every step (the same guard the fetch path's callbacks run).
    slot.patchRunning = false
    slot.patchPending = undefined
    // No consumer left: drop the snapshot so a later mount re-reads the
    // truth (via the storage re-hydration + calibration pull) instead of
    // coloring rows from a stale in-memory answer.
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
