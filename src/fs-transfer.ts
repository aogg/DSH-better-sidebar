/**
 * Async tree transfers for the file tree's 复制 / 剪切黏贴 (Windows-file-manager
 * semantics): copy or move a BATCH of tree rows into one target directory as a
 * HOST-side background job with progress reporting.
 *
 * Why a background job: a paste can name a directory with gigabytes inside it.
 * The wire call answers immediately with the PRE-WALKED totals (files + bytes),
 * the transfer keeps running on the host, and its progress reaches the client
 * as PUSH frames over `/sidebar/ws/fs-jobs` (fs-jobs-push.ts) that drive the
 * top-right progress card — no client timer ever polls `fs.transferStatus`
 * again. Byte progress is folded into one frame per coalescing window
 * ({@link NOTIFY_FLUSH_MS}, the debounce the 规范 allows); every state change
 * — the cancel flag, the terminal settle — flushes immediately.
 * `fs.transferCancel` flips a flag the copy loop checks between files — the
 * in-flight file finishes, everything after it never starts (the Windows
 * cancel semantics: a partial copy stays partial).
 *
 * Conflict policy (the client asks BEFORE starting, Windows "Replace or Skip"
 * dialog): `replace` overwrites — a file over a file truncates in place, a
 * directory over a directory MERGES (files inside are overwritten one by one,
 * which is what Explorer does); `skip` leaves every conflicting top-level item
 * untouched and transfers the rest. A type mismatch under `replace` (a file
 * where the source has a directory, or vice versa) fails THAT ITEM only — the
 * batch continues, the failure lands in `itemErrors` and the completion card
 * says how many items did not make it.
 *
 * Node fs only — no external binaries (the repo's tests must run everywhere,
 * including Windows), and every destination rides
 * {@link ensureWorkspaceWritePath} like every other mutation. Progress counts
 * regular-file bytes streamed through a counting transform; renames (instant
 * moves) credit their size immediately. Directory caches of every touched
 * level are invalidated on completion so the next listing is fresh.
 * @module dsh-better-sidebar/fs-transfer
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { Transform } from 'node:stream'
import { lstat, mkdir, readdir, readlink, rename, rm, symlink, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { invalidateDirectoryCache, requireAbsolute } from './fs-tree.ts'
import { ensureWorkspaceWritePath, resolveTarget } from './path-security.ts'
import { SidebarError } from './wire.ts'

/** The two paste flavors (复制 vs 剪切黏贴). */
export type TransferMode = 'copy' | 'move'

/** The conflict choice the client's dialog collected BEFORE the job started. */
export type TransferConflict = 'replace' | 'skip'

/** Lifecycle of one transfer job. */
export type TransferState = 'running' | 'canceling' | 'done' | 'error' | 'canceled'

/** One walked source node: what to copy/move, and where it lands. */
interface TransferNode {
  src: string
  dest: string
  isDir: boolean
  isSymlink: boolean
  /** Regular-file size in bytes (0 for dirs and links — links carry none). */
  size: number
}

/** One top-level item: the row the user pasted, and its destination path. */
interface TransferItem {
  src: string
  dest: string
  nodes: TransferNode[]
  /** Sum of the item's regular-file sizes (progress credit when skipped). */
  bytes: number
  /** Count of non-dir nodes (progress credit when skipped). */
  files: number
}

/** The client-visible status snapshot (the `fs.transferStatus` answer and
 * the `/sidebar/ws/fs-jobs` frame payload — one small JSON object). */
export interface TransferStatusView {
  transferId: string
  mode: TransferMode
  state: TransferState
  totalFiles: number
  totalBytes: number
  filesDone: number
  bytesDone: number
  /** Per-item failures that did not stop the batch. */
  itemErrors: readonly string[]
  /** The catastrophic message (only when `state` is `error`). */
  error?: string
}

/** Inputs of one paste job: the batch, the target directory, the choice. */
export interface WorkspaceTransferInput {
  /** The session workspace root (the base of session-relative targets). */
  cwd: string
  /** `copy` duplicates; `move` relocates (剪切黏贴). */
  mode: TransferMode
  /** The pasted rows (absolute, session-relative, or `~`-relative). */
  items: readonly string[]
  /** The directory the rows land in (a directory row, or a file's parent). */
  targetDir: string
  /** What to do when the target already holds a same-named entry. */
  conflict: TransferConflict
}

interface TransferRecord extends TransferStatusView {
  conflict: TransferConflict
  cancelRequested: boolean
  items: TransferItem[]
  targetDir: string
  touchedSourceParents: readonly string[]
  gcTimer: NodeJS.Timeout | undefined
  /** Pending progress-coalescing window (terminal states flush it away). */
  notifyTimer: NodeJS.Timeout | undefined
}

/** The live registry (one plugin process). Cleared per job after retention. */
const transfers = new Map<string, TransferRecord>()

/**
 * How long a burst of progress credit (a copy's chunks, a rename batch) is
 * folded into ONE push frame — a coalescing window, never a poll tick: with
 * no listener connected nothing runs at all, and no timer ever issues a
 * status read.
 */
const NOTIFY_FLUSH_MS = 200

/** Push sinks (the fs-jobs hub registers one per plugin mount). */
const listeners = new Set<(status: TransferStatusView) => void>()

/**
 * Follow every transfer update (coalesced progress; immediate state
 * changes). The listener receives status snapshots ONLY — it can never
 * mutate the record, and a throwing listener is contained so one bad sink
 * cannot stall a running copy.
 * @returns the unsubscriber.
 */
export function onTransferUpdate(listener: (status: TransferStatusView) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The wire snapshot of one record (the status route and the frames share it). */
function viewOf(record: TransferRecord): TransferStatusView {
  return {
    transferId: record.transferId,
    mode: record.mode,
    state: record.state,
    totalFiles: record.totalFiles,
    totalBytes: record.totalBytes,
    filesDone: record.filesDone,
    bytesDone: record.bytesDone,
    itemErrors: [...record.itemErrors],
    ...(record.error !== undefined ? { error: record.error } : {}),
  }
}

/** Hand one record's current snapshot to every push sink. */
function emitUpdate(record: TransferRecord): void {
  if (listeners.size === 0) return
  const status = viewOf(record)
  for (const listener of [...listeners]) {
    try {
      listener(status)
    } catch (error) {
      // Contained and logged, never swallowed silently — but a bad sink must
      // not stall the copy loop that is the record's whole purpose.
      console.error('[dsh-better-sidebar] transfer update listener failed:', error)
    }
  }
}

/** Fold a burst of progress credit into one frame ({@link NOTIFY_FLUSH_MS}). */
function scheduleNotify(record: TransferRecord): void {
  if (record.notifyTimer !== undefined) return
  record.notifyTimer = setTimeout(() => {
    record.notifyTimer = undefined
    emitUpdate(record)
  }, NOTIFY_FLUSH_MS)
  // A pending frame must never hold the host process open.
  record.notifyTimer.unref?.()
}

/** Push the record's state NOW — a state change never waits for the window. */
function flushNotify(record: TransferRecord): void {
  if (record.notifyTimer !== undefined) {
    clearTimeout(record.notifyTimer)
    record.notifyTimer = undefined
  }
  emitUpdate(record)
}

/** Walk budget: a paste pasting more entries than this refuses up front. */
const MAX_TRANSFER_ENTRIES = 100_000
/** Depth budget for the pre-walk (a pathological tree cannot recurse forever). */
const MAX_TRANSFER_DEPTH = 128
/** How long a finished job stays pollable before the registry forgets it. */
const TRANSFER_RETAIN_MS = 5 * 60_000

/**
 * Resolve one client row path the way every mutation does (lexical, no
 * realpath — a symlink row must keep addressing the link).
 */
function resolveEntryPath(cwd: string, target: string): string {
  return resolveTarget(requireAbsolute(cwd), target)
}

/** Whether `candidate` is `dir` itself or anywhere inside it (lexical). */
function isInsideOrEqual(dir: string, candidate: string): boolean {
  const rel = relative(dir, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Pre-walk one source item into its node list (totals for the progress bar and
 * the per-node work list). Symlinks are LEAF nodes (the link is the row, never
 * its target — the same rule rename/delete follow); directories recurse with
 * the depth and entry budgets.
 */
async function walkItem(src: string, dest: string, depth: number, budget: { left: number }): Promise<TransferNode[]> {
  if (depth > MAX_TRANSFER_DEPTH) {
    throw new SidebarError('fs-error', `"${src}" is deeper than ${MAX_TRANSFER_DEPTH} levels`, 400)
  }
  const info = await lstat(src)
  budget.left -= 1
  if (budget.left < 0) {
    throw new SidebarError('fs-error', `the paste exceeds ${MAX_TRANSFER_ENTRIES} entries`, 400)
  }
  if (info.isSymbolicLink()) {
    return [{ src, dest, isDir: false, isSymlink: true, size: 0 }]
  }
  if (!info.isDirectory()) {
    return [{ src, dest, isDir: false, isSymlink: false, size: info.size }]
  }
  const nodes: TransferNode[] = [{ src, dest, isDir: true, isSymlink: false, size: 0 }]
  const children = await readdir(src)
  for (const child of children) {
    nodes.push(...await walkItem(join(src, child), join(dest, child), depth + 1, budget))
  }
  return nodes
}

/**
 * Stream one regular file to its destination, crediting every byte to the
 * record's progress (the counting transform sits between the pipes, so the
 * number climbs WHILE the copy runs, not only after it).
 */
async function copyFileWithProgress(src: string, dest: string, record: TransferRecord): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(
    createReadStream(src),
    new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
        record.bytesDone += chunk.length
        scheduleNotify(record)
        callback(null, chunk)
      },
    }),
    createWriteStream(dest),
  )
  record.filesDone += 1
  scheduleNotify(record)
}

/** Recreate one symlink row at the destination (the link, never its target). */
async function copySymlink(src: string, dest: string, record: TransferRecord): Promise<void> {
  const target = await readlink(src)
  await rm(dest, { force: true, recursive: true })
  await symlink(target, dest)
  record.filesDone += 1
  scheduleNotify(record)
}

/**
 * Transfer ONE walked node (a file, a link, or a directory shell). `move`
 * renames where it can (instant, same volume) and falls back to a streamed
 * copy + unlink across devices; `copy` always streams files and recreates
 * links. Directory nodes only mkdir their destination — merge semantics fall
 * out naturally (an existing destination directory is merged into, an
 * existing destination FILE was already removed by the item-level replace
 * logic before the nodes ran).
 */
async function transferNode(node: TransferNode, mode: TransferMode, record: TransferRecord): Promise<void> {
  if (node.isDir) {
    await mkdir(node.dest, { recursive: true })
    return
  }
  if (node.isSymlink) {
    if (mode === 'move') {
      await rm(node.dest, { force: true, recursive: true })
      try {
        await rename(node.src, node.dest)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        await copySymlink(node.src, node.dest, record)
        await unlink(node.src)
      }
      record.filesDone += 1
      scheduleNotify(record)
      return
    }
    await copySymlink(node.src, node.dest, record)
    return
  }
  // Regular file.
  if (mode === 'move') {
    await mkdir(dirname(node.dest), { recursive: true })
    try {
      await rename(node.src, node.dest)
      record.bytesDone += node.size
      record.filesDone += 1
      scheduleNotify(record)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      // Cross-device: stream it, then drop the source.
    }
  }
  await copyFileWithProgress(node.src, node.dest, record)
  if (mode === 'move') await unlink(node.src)
}

/**
 * Run one top-level item: the replace pre-check (clear a non-merging
 * destination out of the way), the node loop with the cancel checks, and the
 * move's source cleanup. Item failures land in `record.itemErrors` and the
 * batch continues.
 */
async function transferItem(item: TransferItem, mode: TransferMode, conflict: TransferConflict, record: TransferRecord): Promise<void> {
  try {
    // A paste into the row's own directory with the same name is a no-op
    // (Windows copies to "name - Copy" instead; the dialog already fired only
    // when the name existed, so an identical src===dest here is the no-op).
    if (item.src === item.dest) {
      record.filesDone += item.files
      record.bytesDone += item.bytes
      scheduleNotify(record)
      return
    }
    let existing: Stats | undefined
    try {
      existing = await lstat(item.dest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== undefined && conflict === 'skip') {
      // Conflicting item the user chose to keep: credit its totals so the
      // bar completes, touch nothing.
      record.filesDone += item.files
      record.bytesDone += item.bytes
      scheduleNotify(record)
      return
    }
    if (existing !== undefined && conflict === 'replace') {
      const sourceIsDir = item.nodes[0]?.isDir === true
      if (!sourceIsDir && existing.isDirectory()) {
        // A file cannot replace a directory: fail the ITEM, keep the batch.
        record.itemErrors = [...record.itemErrors, `"${basename(item.dest)}": cannot overwrite a directory with a file`]
        record.filesDone += item.files
        record.bytesDone += item.bytes
        scheduleNotify(record)
        return
      }
      if (sourceIsDir && !existing.isDirectory()) {
        // A directory replaces a file: clear the file first (Explorer does).
        await rm(item.dest, { force: true, recursive: true })
      }
    }
    for (const node of item.nodes) {
      if (record.cancelRequested) return
      await transferNode(node, mode, record)
    }
    if (mode === 'move') {
      // The nodes moved out; only empty directory shells remain (merge case
      // included — files were renamed out, dirs mkdir'ed at the target).
      await rm(item.src, { force: true, recursive: true })
    }
  } catch (error) {
    record.itemErrors = [...record.itemErrors, `"${basename(item.dest)}": ${error instanceof Error ? error.message : String(error)}`]
    scheduleNotify(record)
  }
}

/** The never-throwing job body: runs the items, settles the final state. */
async function runTransfer(record: TransferRecord): Promise<void> {
  try {
    for (const item of record.items) {
      if (record.cancelRequested) break
      await transferItem(item, record.mode, record.conflict as TransferConflict, record)
    }
    for (const parent of record.touchedSourceParents) invalidateDirectoryCache(parent)
    invalidateDirectoryCache(record.targetDir)
    if (record.cancelRequested) {
      record.state = 'canceled'
    } else if (record.itemErrors.length > 0 && record.filesDone === 0) {
      record.state = 'error'
      record.error = record.itemErrors[0]
    } else {
      record.state = 'done'
    }
  } catch (error) {
    record.state = 'error'
    record.error = error instanceof Error ? error.message : String(error)
  } finally {
    // The terminal frame rides the settle itself, never the coalescing
    // window — a finished job's card must not wait for a timer.
    flushNotify(record)
    record.gcTimer = setTimeout(() => {
      if (record.notifyTimer !== undefined) clearTimeout(record.notifyTimer)
      record.notifyTimer = undefined
      transfers.delete(record.transferId)
    }, TRANSFER_RETAIN_MS)
    record.gcTimer.unref?.()
  }
}

/**
 * Start one paste job: validate, pre-walk the batch (the totals the wire
 * answer carries), register the record, and kick the async body. Throws
 * (SidebarError) only for REQUEST problems — a bad shape, a missing target,
 * an empty/self-contained batch. Everything that can fail mid-run is the
 * job's own progress state.
 */
export async function startWorkspaceTransfer(input: WorkspaceTransferInput): Promise<{ transferId: string; totalFiles: number; totalBytes: number }> {
  const cwd = requireAbsolute(input.cwd)
  if (input.mode !== 'copy' && input.mode !== 'move') {
    throw new SidebarError('bad-request', `mode must be "copy" or "move", got ${JSON.stringify(input.mode)}`, 400)
  }
  if (input.conflict !== 'replace' && input.conflict !== 'skip') {
    throw new SidebarError('bad-request', `conflict must be "replace" or "skip", got ${JSON.stringify(input.conflict)}`, 400)
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new SidebarError('bad-request', 'items must be a non-empty array of paths', 400)
  }
  const targetDir = await ensureWorkspaceWritePath(cwd, resolveEntryPath(cwd, input.targetDir))
  const targetInfo = await lstat(targetDir).catch((error: NodeJS.ErrnoException) => {
    throw new SidebarError('fs-error', `target directory "${input.targetDir}" does not exist: ${error.message}`, 400)
  })
  if (!targetInfo.isDirectory()) {
    throw new SidebarError('bad-request', `"${input.targetDir}" is not a directory`, 400)
  }

  // Resolve the batch, dropping rows the paste would fold into themselves
  // (pasting `a` into `a` or `a/b` — silently skipped, Windows behaves the
  // same way for the equal case; the client filters the obvious ones too).
  const budget = { left: MAX_TRANSFER_ENTRIES }
  const items: TransferItem[] = []
  const touchedSourceParents = new Set<string>()
  for (const raw of input.items) {
    const src = resolveEntryPath(cwd, raw)
    if (isInsideOrEqual(src, targetDir)) continue
    const dest = await ensureWorkspaceWritePath(cwd, join(targetDir, basename(src)))
    const nodes = await walkItem(src, dest, 0, budget)
    if (nodes.length === 0) continue
    items.push({
      src,
      dest,
      nodes,
      bytes: nodes.reduce((sum, node) => sum + node.size, 0),
      files: nodes.filter(node => !node.isDir).length,
    })
    touchedSourceParents.add(dirname(src))
  }
  if (items.length === 0) {
    throw new SidebarError('bad-request', 'nothing to transfer (every source contains the target)', 400)
  }

  const transferId = `t-${randomUUID()}`
  const record: TransferRecord = {
    transferId,
    mode: input.mode,
    state: 'running',
    conflict: input.conflict,
    totalFiles: items.reduce((sum, item) => sum + item.files, 0),
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    filesDone: 0,
    bytesDone: 0,
    itemErrors: [],
    cancelRequested: false,
    items,
    targetDir,
    touchedSourceParents: [...touchedSourceParents],
    gcTimer: undefined,
    notifyTimer: undefined,
    error: undefined,
  }
  transfers.set(transferId, record)
  // The job outlives the wire call; the route answers with the totals.
  void runTransfer(record)
  return { transferId, totalFiles: record.totalFiles, totalBytes: record.totalBytes }
}

/** One job's status snapshot (`undefined` for an unknown/retired id). */
export function transferStatus(transferId: string): TransferStatusView | undefined {
  const record = transfers.get(transferId)
  if (record === undefined) return undefined
  return viewOf(record)
}

/** Ask one job to stop after its current file (`false` for an unknown id). */
export function transferCancel(transferId: string): boolean {
  const record = transfers.get(transferId)
  if (record === undefined) return false
  if (record.state === 'running') record.state = 'canceling'
  record.cancelRequested = true
  // The cancellation is a state change the card must show at once.
  flushNotify(record)
  return true
}
