/**
 * Git change push behind `/sidebar/ws/git`.
 *
 * Every git-domain surface the phase-2 polling audit named — the shared
 * status store's ink (`ui/git-status.ts`), the changes tab's worktree
 * inventory / branches / history (`changes/GitLens.tsx`), and the round
 * lenses' log / range diff (`changes/RoundCommitsLens.tsx`,
 * `changes/RoundDiffLens.tsx`) — used to advance on client-side
 * `usePolling` timers. This hub replaces them with the fs-watch model
 * (`fs-watch.ts`): the HOST watches where the data changes and pushes a
 * debounced, data-free INVALIDATION; the client re-pulls the affected
 * api once. No frame carries git output, and no server timer ever runs a
 * git command — the only timers here fold bursts (debounce, not polling).
 *
 * What is watched per subscribed worktree:
 *
 * - the checkout's FILES (`fs.watch` recursive where the platform allows
 *   it — a plain edit touches no `.git` metadata, so this is the only way
 *   an unstaged change can notify). Where recursive watch is unavailable
 *   (old Linux Node) the fallback is a shallow root watch: top-level
 *   edits still notify, deeper ones may not — there is NO polling
 *   fallback (the 规范 forbids it), the `.git` watchers below still catch
 *   every stage / commit / checkout, and mutations + reconnect re-pulls
 *   cover the rest.
 * - the checkout's GIT METADATA: `HEAD`, `index`, `packed-refs` at the
 *   git dir's top and `refs/` `logs/` `worktrees/` below it. A branch
 *   switch rewrites HEAD, a commit rewrites a ref plus the reflog, a
 *   stage rewrites the index, and `git worktree add` lands in
 *   `.git/worktrees` — so the MAIN checkout's watch notices a linked
 *   worktree the agent creates mid-session (requirement: the inventory
 *   must discover it). A LINKED checkout's git dir (`.git` is a file
 *   there, pointing into the main repository's `.git/worktrees/<id>`)
 *   is watched on its own, so notices name the checkout that actually
 *   changed; shared-ref events still reach the main checkout's entry.
 *
 * The burst window is first-trigger 250 ms with a 2 s floor per
 * worktree: an idle repository fires nothing at all, one save fires one
 * notice, and a continuously-written tree (a build, a watcher) fires at
 * most one notice per 2 s — the timer-free replacement of the old
 * status store's "slow down until the timer stops" ladder, without ever
 * letting a pathological repository keep a `git status` chain running
 * back to back. Firing also drops the repository's git-read cache
 * (`invalidateGitCache`, the same reason `fs-watch` drops the listing
 * cache): the client's re-pull must not be answered from a cache level
 * computed before the change.
 * @module dsh-better-sidebar/git-push
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { WebSocket } from 'ws'
import { invalidateGitCache } from './git-cache.ts'
import { resolveTarget } from './path-security.ts'

/** How long a burst of filesystem events is folded into a single notice. */
const GIT_DEBOUNCE_MS = 250

/** Minimum spacing between two notices of one worktree: the cost guard
 *  that replaces the old client-side slow-tier ladder. With no events
 *  there is no timer at all — this floors storms, it never invents work. */
const GIT_NOTICE_MIN_INTERVAL_MS = 2_000

/** Worktrees one socket may watch (a resource guard, not a policy). */
const MAX_WATCHED = 32

/** The frames the host pushes: a watched worktree's git state changed. */
export type GitPushFrame =
  /**
   * INVALIDATION ONLY (the side-chat push model): `worktree` names the
   * checkout whose files or git metadata moved, spelled exactly as the
   * client's own watch frame spelled it. The reaction is always one
   * one-shot re-pull; no git output ever rides the frame.
   */
  | { kind: 'git'; worktree: string }

/** The frame the client sends to replace its watch set. */
interface WatchFrame {
  op?: unknown
  worktrees?: unknown
}

/** Warning sink: the hub never crashes a socket over an unwatchable path. */
export type GitWatchWarn = (message: string, error?: unknown) => void

/** The host-side push hub: a shared watcher registry, any number of sockets. */
export interface GitWatchHub {
  /**
   * Serve one accepted socket: read its watch frames, share the watchers
   * of every worktree it names, push notices until it closes.
   * @param ws - the accepted WebSocket.
   * @param cwdOf - resolves the socket's session cwd (watch paths resolve
   *   against it exactly like every git route's targets do).
   */
  attach(ws: WebSocket, cwdOf: () => Promise<string>): void
  /** Close every socket and release every watcher (idempotent). */
  dispose(): void
}

/** One watched worktree's shared, refcounted watcher set. */
interface WorktreeEntry {
  /** Sockets currently watching this path (registry lifetime = this count). */
  refs: number
  /** The main checkout's root — the git-cache invalidation target. */
  repoRoot: string
  watchers: FSWatcher[]
  /** Pending burst window (first-trigger, floored — see module doc). */
  timer: NodeJS.Timeout | undefined
  /** `Date.now()` of the last fired notice (the 2 s floor's anchor). */
  firedAt: number
}

/** Where a checkout's git metadata lives, and the repository root it serves. */
interface GitDirs {
  /** This checkout's own git dir (`.git` proper, or the linked admin dir). */
  own: string
  /** The main checkout's root (cache-invalidation target). */
  repoRoot: string
}

/**
 * Resolve one checkout's git dir. A main checkout has `.git` as a
 * directory; a linked worktree (and a submodule) has a `.git` FILE whose
 * `gitdir:` line points into the main repository's
 * `.git/worktrees/<id>` — the metadata that checkout's own HEAD / index
 * / reflog live under.
 * @param worktree - the checkout root, resolved absolute.
 * @returns the git dir + repository root, or undefined when the path is
 *   not a git worktree at all (nothing to observe, nothing to push).
 */
async function resolveGitDirs(worktree: string): Promise<GitDirs | undefined> {
  const dotGit = join(worktree, '.git')
  const info = await stat(dotGit).catch(() => undefined)
  if (info === undefined) return undefined
  if (info.isDirectory()) return { own: dotGit, repoRoot: worktree }
  if (!info.isFile()) return undefined
  const text = await readFile(dotGit, 'utf8').catch(() => '')
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (match === null) return undefined
  const own = resolve(match[1]!.trim())
  // `<main>/.git/worktrees/<id>` → the main checkout's git dir → its root.
  const mainGitDir = dirname(dirname(own))
  return { own, repoRoot: dirname(mainGitDir) }
}

/**
 * Register the git push hub.
 * @param warn - warning sink (an unwatchable path degrades that path only).
 * @returns the hub; `attach` per accepted socket, `dispose` on unload.
 */
export function createGitWatchHub(warn: GitWatchWarn): GitWatchHub {
  /** Shared watchers, keyed by the resolved worktree path. */
  const entries = new Map<string, WorktreeEntry>()
  const sockets = new Set<GitSocket>()

  /** One handle onto one path, or remove it again when the watch failed. */
  const attachWatcher = (entry: WorktreeEntry, key: string, path: string, recursive: boolean): boolean => {
    let watcher: FSWatcher
    try {
      watcher = watch(path, { persistent: false, recursive })
    } catch {
      return false
    }
    entry.watchers.push(watcher)
    watcher.on('change', () => { schedule(key, entry) })
    watcher.on('error', (error) => {
      // Degrade, never crash: drop THIS handle (the entry keeps its
      // others); the client re-subscribes on its next reconnect if the
      // path comes back (a pruned worktree, a transient mount).
      warn(`git watcher on "${path}" failed`, error)
      const at = entry.watchers.indexOf(watcher)
      if (at >= 0) entry.watchers.splice(at, 1)
      try {
        watcher.close()
      } catch {
        // Already closed by the error itself.
      }
    })
    return true
  }

  const createEntry = async (key: string): Promise<WorktreeEntry | undefined> => {
    const dirs = await resolveGitDirs(key)
    if (dirs === undefined) {
      warn(`"${key}" is not a git worktree; not watched`)
      return undefined
    }
    const entry: WorktreeEntry = { refs: 1, repoRoot: dirs.repoRoot, watchers: [], timer: undefined, firedAt: 0 }
    // (1) The checkout's files. Recursive where the platform allows it;
    //     the shallow fallback still sees the checkout's top level.
    if (!attachWatcher(entry, key, key, true)) {
      warn(`recursive fs.watch unavailable; watching "${key}" shallow (edits below the root may not notify)`)
      attachWatcher(entry, key, key, false)
    }
    // (2) The checkout's git metadata. Recursive where possible; the
    //     shallow fallback covers the four places the moving files live:
    //     the top (HEAD / index / packed-refs), refs/, logs/, worktrees/.
    const before = entry.watchers.length
    attachWatcher(entry, key, dirs.own, true)
    if (entry.watchers.length === before) {
      for (const sub of ['', 'refs', 'logs', 'worktrees']) {
        attachWatcher(entry, key, join(dirs.own, sub), false)
      }
    }
    if (entry.watchers.length === 0) {
      warn(`cannot watch "${key}"`)
      return undefined
    }
    entries.set(key, entry)
    return entry
  }

  const acquire = async (key: string): Promise<WorktreeEntry | undefined> => {
    const existing = entries.get(key)
    if (existing !== undefined) {
      existing.refs += 1
      return existing
    }
    return createEntry(key)
  }

  const release = (key: string): void => {
    const entry = entries.get(key)
    if (entry === undefined) return
    entry.refs -= 1
    if (entry.refs > 0) return
    entries.delete(key)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    for (const watcher of entry.watchers) {
      try {
        watcher.close()
      } catch {
        // Already closed by its own error path.
      }
    }
    entry.watchers.length = 0
  }

  /** First-trigger window with a storm floor: one notice per burst, at
   *  most one per {@link GIT_NOTICE_MIN_INTERVAL_MS}. No event, no timer. */
  const schedule = (key: string, entry: WorktreeEntry): void => {
    if (entries.get(key) !== entry || entry.timer !== undefined) return
    const quietFor = Date.now() - entry.firedAt
    const wait = Math.max(GIT_DEBOUNCE_MS, GIT_NOTICE_MIN_INTERVAL_MS - quietFor)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entries.get(key) !== entry) return
      entry.firedAt = Date.now()
      // The re-pull this notice triggers must not be answered from a
      // cache level computed before the change — the same reason
      // fs-watch drops the host's listing cache for the changed directory.
      invalidateGitCache(entry.repoRoot)
      for (const socket of sockets) {
        const spelling = socket.spellingOf(key)
        if (spelling !== undefined) socket.send({ kind: 'git', worktree: spelling })
      }
    }, wait)
    // A pending notice must never hold the host process open.
    entry.timer.unref()
  }

  return {
    attach: (ws, cwdOf) => {
      const socket = new GitSocket(
        ws,
        cwdOf,
        { acquire, release, warn, detach: () => { sockets.delete(socket) } },
      )
      sockets.add(socket)
    },
    dispose: () => {
      for (const socket of [...sockets]) socket.close()
    },
  }
}

/** The per-socket seam the hub hands each {@link GitSocket}. */
interface GitSocketHub {
  acquire(key: string): Promise<WorktreeEntry | undefined>
  release(key: string): void
  warn: GitWatchWarn
  /** Remove the socket from the hub's push set (its close path). */
  detach(): void
}

/**
 * Serve one socket's watch set until it closes.
 *
 * Watch frames are `{ op: 'watch', worktrees: [...] }` — a FULL
 * replacement, the session-push model, so a reconnect (the client
 * re-sends the whole set) and a membership change (the client's union
 * hub reconciling) share one code path. Frames are applied serialized:
 * path resolution is async (the `.git` probe), and a later frame must
 * always observe the previous one's registrations.
 */
class GitSocket {
  private readonly ws: WebSocket
  private readonly hub: GitSocketHub
  private readonly cwdOf: () => Promise<string>
  /** Resolved path → the client's own spelling (frames echo it back). */
  private readonly watched = new Map<string, string>()
  /** Serialized frame application (resolution is async). */
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ws: WebSocket, cwdOf: () => Promise<string>, hub: GitSocketHub) {
    this.ws = ws
    this.cwdOf = cwdOf
    this.hub = hub
    ws.on('message', (data: unknown) => { this.onMessage(data) })
    ws.on('close', () => { this.close() })
    ws.on('error', () => { this.close() })
  }

  /** The client's spelling of one watched path, if this socket watches it. */
  spellingOf(key: string): string | undefined {
    return this.watched.get(key)
  }

  /** Push one notice (silently dropped once the socket is gone). */
  send(frame: GitPushFrame): void {
    if (this.closed) return
    try {
      this.ws.send(JSON.stringify(frame))
    } catch {
      // A send on a dying socket is expected; the close handler cleans up.
    }
  }

  /** Apply one watch frame (an unparseable frame is ignored, never fatal). */
  private onMessage(data: unknown): void {
    if (this.closed) return
    let frame: WatchFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as WatchFrame
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object' || frame.op !== 'watch') return
    const list = Array.isArray(frame.worktrees)
      ? frame.worktrees.filter((path): path is string => typeof path === 'string' && path !== '')
      : []
    this.chain = this.chain
      .then(() => this.apply(list.slice(0, MAX_WATCHED)))
      .catch((error: unknown) => { this.hub.warn('git watch frame failed', error) })
  }

  /** Bring the watched set in line with one frame's list, serialized. */
  private async apply(list: readonly string[]): Promise<void> {
    if (this.closed) return
    let cwd: string
    try {
      cwd = await this.cwdOf()
    } catch (error) {
      this.hub.warn('cannot resolve the git watch session cwd', error)
      return
    }
    const next = new Map<string, string>()
    for (const original of list) {
      try {
        // Resolution (not trust): relative spellings join the session cwd,
        // the result is lexically normalized — the git routes' own rule.
        const key = resolveTarget(cwd, original)
        if (!next.has(key)) next.set(key, original)
      } catch (error) {
        this.hub.warn(`cannot resolve git watch path "${original}"`, error)
      }
    }
    for (const [key, original] of next) {
      if (this.watched.has(key)) continue
      const entry = await this.hub.acquire(key)
      if (entry === undefined) continue
      if (this.closed) {
        this.hub.release(key)
        return
      }
      this.watched.set(key, original)
    }
    for (const key of [...this.watched.keys()]) {
      if (next.has(key)) continue
      this.watched.delete(key)
      this.hub.release(key)
    }
  }

  /** Stop serving: no further frames apply, every registration releases. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.hub.detach()
    // Registrations a still-running frame application adds must release
    // too — hence releasing AFTER the chain drains.
    void this.chain.then(() => {
      for (const key of this.watched.keys()) this.hub.release(key)
      this.watched.clear()
    }).catch((error: unknown) => { this.hub.warn('git watch teardown failed', error) })
  }
}
