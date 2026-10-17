/**
 * Client-side "first seen" timestamps for the shared team-task board.
 *
 * The host's `TeamTaskView` carries NO creation time (verified against the
 * dsh-experimental-agent-team task-board types), so the board's 创建时间 is
 * what THIS browser can honestly attest: the first moment it observed the
 * task. Each `(rootId, taskId)` pair is recorded once per browser —
 * localStorage when available, a module-level Map when it is not (private
 * windows, quota errors, non-browser test environments) — and an existing
 * record is NEVER overwritten by observation: a task seen yesterday must not
 * age to "now" because the page re-rendered.
 *
 * The one sanctioned overwrite is {@link markTaskFirstSeen}: the browser that
 * CREATED a task knows the exact creation moment (the create response), which
 * beats any later poll's observation. A task another browser created, or one
 * created before this feature shipped, has no record here and the UI shows an
 * em-dash with the unknown-time note instead of inventing a time.
 */

/** localStorage namespace: the same `dsh-sidebar:v1` root the layout store uses. */
const STORAGE_PREFIX = 'dsh-sidebar:v1:task-firstseen'

/** The in-memory mirror (and the fallback when localStorage throws). */
const memory = new Map<string, number>()

/** The storage key of one task under one team root. */
function storageKey(rootId: string, taskId: string): string {
  return `${STORAGE_PREFIX}:${rootId}:${taskId}`
}

/** Read one record (memory first, then localStorage; corrupt rows are ignored). */
function readStored(key: string): number | undefined {
  const cached = memory.get(key)
  if (cached !== undefined) return cached
  try {
    if (typeof localStorage === 'undefined') return undefined
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) return undefined
    memory.set(key, value)
    return value
  } catch {
    // localStorage can throw on access itself (security/privacy settings):
    // degrade to the memory map without ever breaking a render.
    return undefined
  }
}

/** Write one record; `overwrite` is reserved for the create-success path. */
function writeStored(key: string, at: number, overwrite: boolean): void {
  if (!overwrite) {
    // An existing record wins wherever it lives: memory first, then storage.
    // The storage check MUST precede the memory write — otherwise a record
    // that only exists in storage would be shadowed by the fresher in-memory
    // value this call was about to create, and every later read (memory
    // first) would keep aging the task's first-seen moment.
    if (memory.has(key)) return
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(key) !== null) {
        const stored = Number(localStorage.getItem(key))
        if (Number.isFinite(stored) && stored > 0) memory.set(key, stored)
        return
      }
    } catch {
      // localStorage unusable: the memory map below is the whole store.
    }
  }
  memory.set(key, at)
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, String(at))
  } catch {
    // Silent by design: the memory map already holds the value, so this
    // page still shows a time; only a reload loses it.
  }
}

/**
 * Record the first-seen moment of every task in the list. Batch-call this
 * BEFORE rendering a task list (the board does, every render): it is
 * idempotent — existing records win, so only tasks this browser has never
 * seen get stamped.
 */
export function observeTaskFirstSeen(
  rootId: string,
  tasks: readonly { id: string }[],
): void {
  const now = Date.now()
  for (const task of tasks) writeStored(storageKey(rootId, task.id), now, false)
}

/** The first-seen epoch ms of one task, or undefined when this browser has none. */
export function taskFirstSeen(rootId: string, taskId: string): number | undefined {
  return readStored(storageKey(rootId, taskId))
}

/**
 * Pin one task's first-seen record to `at` (default now). Called from the
 * task window's CREATE path: this browser authored the task, so its response
 * time is the closest thing to the true creation time any client can hold.
 */
export function markTaskFirstSeen(rootId: string, taskId: string, at: number = Date.now()): void {
  writeStored(storageKey(rootId, taskId), at, true)
}
