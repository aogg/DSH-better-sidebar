/**
 * The paste job driver + the top-right progress card's state (文件树黏贴的异步
 * 后半段): `startTransfer` fires the host's `fs.transfer` job, then polls
 * `fs.transferStatus` while the card shows the byte/file progress; the user
 * can cancel (Windows semantics: the file in flight finishes, the rest never
 * starts). The state here is a tiny module store — ONE card for the whole
 * page no matter which tree instance started the paste — mounted once by
 * `registerTransferToast` (TransferToast.tsx).
 *
 * Failure surface: a rejected `fs.transfer` (bad shape, unknown route — e.g.
 * a DSH that has not been restarted since the host half landed) puts the card
 * into `error` with the wire message and STAYS until dismissed; the caller's
 * promise rejects with the same error so the tree can surface it in its own
 * action strip too.
 * @module dsh-better-sidebar/transfer-client
 */

import { api } from './api.ts'
import type { SessionScope } from './service.ts'

/** What the progress card renders (a stable snapshot between updates). */
export interface TransferView {
  transferId: string
  mode: 'copy' | 'move'
  state: 'running' | 'canceling' | 'done' | 'error' | 'canceled'
  totalFiles: number
  totalBytes: number
  filesDone: number
  bytesDone: number
  itemErrors: readonly string[]
  error?: string
}

let view: TransferView | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** The current card state (stable reference between updates; null = hidden). */
export function getTransferView(): TransferView | null {
  return view
}

/** Subscribe to card-state changes (useSyncExternalStore-shaped). */
export function subscribeTransferView(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Dismiss the card (the ✕ on an error, or any terminal state's close). */
export function dismissTransfer(): void {
  if (view === null) return
  view = null
  emit()
}

/** Ask the running job to stop after its current file (idempotent). */
export function cancelTransfer(): void {
  if (view === null || view.state !== 'running') return
  view = { ...view, state: 'canceling' }
  emit()
  void api.fsTransferCancel(view.transferId).catch(() => { /* the poll settles the state anyway */ })
}

const POLL_MS = 400
/** How long a finished card lingers before it takes itself away. */
const DONE_LINGER_MS = 2500

let pollTimer: ReturnType<typeof setInterval> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function scheduleHide(): void {
  if (hideTimer !== undefined) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = undefined
    // A newer job may have taken the card over while this one lingered.
    if (view !== null && (view.state === 'done' || view.state === 'canceled')) dismissTransfer()
  }, DONE_LINGER_MS)
}

/** What the starter learns when the job settles (one call, terminal only). */
export interface TransferOutcome {
  state: 'done' | 'error' | 'canceled'
  itemErrors: readonly string[]
  error?: string
}

/**
 * Start one paste job and drive the card until it settles. Resolves with the
 * transfer id once the host ACCEPTED the job (totals are already known);
 * rejects with the wire error when the job could not start at all.
 * `onSettled` fires ONCE when the job reaches a terminal state (driven by the
 * same poll that moves the card) — the tree's refresh/tab-retarget hooks ride
 * it instead of running their own poller.
 */
export function startTransfer(
  scope: SessionScope,
  mode: 'copy' | 'move',
  items: readonly string[],
  targetDir: string,
  conflict: 'replace' | 'skip',
  onSettled?: (outcome: TransferOutcome) => void,
): Promise<string> {
  stopPolling()
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer)
    hideTimer = undefined
  }
  return api.fsTransfer(scope, mode, items, targetDir, conflict).then((accepted) => {
    view = {
      transferId: accepted.transferId,
      mode,
      state: 'running',
      totalFiles: accepted.totalFiles,
      totalBytes: accepted.totalBytes,
      filesDone: 0,
      bytesDone: 0,
      itemErrors: [],
    }
    emit()
    pollTimer = setInterval(() => {
      if (view === null) {
        stopPolling()
        return
      }
      void api.fsTransferStatus(view.transferId).then((status) => {
        if (view === null || status === null || status.transferId !== view.transferId) {
          // The job is gone (host restart, retention GC): say so instead of
          // polling a ghost forever.
          if (view !== null && status === null) {
            stopPolling()
            view = { ...view, state: 'error', error: 'transfer lost' }
            emit()
          }
          return
        }
        view = {
          transferId: status.transferId,
          mode: status.mode,
          state: status.state,
          totalFiles: status.totalFiles,
          totalBytes: status.totalBytes,
          filesDone: status.filesDone,
          bytesDone: status.bytesDone,
          itemErrors: status.itemErrors,
          ...(status.error !== undefined ? { error: status.error } : {}),
        }
        emit()
        if (status.state === 'done' || status.state === 'canceled') {
          stopPolling()
          onSettled?.({ state: status.state, itemErrors: status.itemErrors })
          scheduleHide()
        } else if (status.state === 'error') {
          stopPolling()
          onSettled?.({
            state: 'error',
            itemErrors: status.itemErrors,
            ...(status.error !== undefined ? { error: status.error } : {}),
          })
        }
      }).catch((error: unknown) => {
        stopPolling()
        if (view === null) return
        view = { ...view, state: 'error', error: error instanceof Error ? error.message : String(error) }
        emit()
      })
    }, POLL_MS)
    return accepted.transferId
  })
}
