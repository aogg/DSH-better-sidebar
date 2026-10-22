/**
 * The paste job driver + the top-right progress card's state (文件树黏贴的异步
 * 后半段): `startTransfer` fires the host's `fs.transfer` job, then follows it
 * over the session's shared `fs-jobs` push socket (fs-jobs-push.ts) — the
 * host pushes the job's coalesced byte/file progress and its terminal state,
 * and the card renders them; the user can cancel (Windows semantics: the
 * file in flight finishes, the rest never starts). The state here is a tiny
 * module store — ONE card for the whole page no matter which tree instance
 * started the paste — mounted once by `registerTransferToast`
 * (TransferToast.tsx).
 *
 * No timer ever polls `fs.transferStatus` again: ONE one-shot fetch runs
 * when the job is accepted (a job that settled before the subscription frame
 * landed) and one after every push-socket re-open (the outage swallowed
 * frames); everything else is frames. A dropped socket is retried with the
 * connector's 1s → 15s backoff — never with polling.
 *
 * Failure surface: a rejected `fs.transfer` (bad shape, unknown route — e.g.
 * a DSH that has not been restarted since the host half landed) puts the card
 * into `error` with the wire message and STAYS until dismissed; the caller's
 * promise rejects with the same error so the tree can surface it in its own
 * action strip too. A catch-up fetch that answers `null` (host restart,
 * retention GC) settles the card as `transfer lost`.
 * @module dsh-better-sidebar/transfer-client
 */

import { api } from './api.ts'
import { subscribeFsJobsWatch, type FsJobsWatchHandle } from './fs-jobs-push.ts'
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

/** One status answer's shape — a push frame's payload or a fetch's. */
type TransferStatus = TransferView

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
  stopWatching()
  view = null
  emit()
}

/** Ask the running job to stop after its current file (idempotent). */
export function cancelTransfer(): void {
  if (view === null || view.state !== 'running') return
  view = { ...view, state: 'canceling' }
  emit()
  void api.fsTransferCancel(view.transferId).catch(() => { /* the push settles the state anyway */ })
}

/** How long a finished card lingers before it takes itself away. */
const DONE_LINGER_MS = 2500

let hideTimer: ReturnType<typeof setTimeout> | undefined

/** The push subscription of the CURRENT job (a terminal state closes it). */
let watch: FsJobsWatchHandle | undefined

function stopWatching(): void {
  watch?.close()
  watch = undefined
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
 * `onSettled` fires ONCE when the job reaches a terminal state (driven by
 * the same push frames that move the card) — the tree's refresh/tab-retarget
 * hooks ride it instead of running their own follower.
 */
export function startTransfer(
  scope: SessionScope,
  mode: 'copy' | 'move',
  items: readonly string[],
  targetDir: string,
  conflict: 'replace' | 'skip',
  onSettled?: (outcome: TransferOutcome) => void,
): Promise<string> {
  stopWatching()
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer)
    hideTimer = undefined
  }
  return api.fsTransfer(scope, mode, items, targetDir, conflict).then((accepted) => {
    const transferId = accepted.transferId
    view = {
      transferId,
      mode,
      state: 'running',
      totalFiles: accepted.totalFiles,
      totalBytes: accepted.totalBytes,
      filesDone: 0,
      bytesDone: 0,
      itemErrors: [],
    }
    emit()

    /**
     * One status answer — a push frame or a one-shot fetch — applied to the
     * card. A terminal answer can arrive twice (the frame and a racing
     * fetch); the first one settles the card, the second is a no-op.
     */
    const applyStatus = (status: TransferStatus): void => {
      if (view === null || status.transferId !== view.transferId) return
      if (view.state !== 'running' && view.state !== 'canceling') return
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
        stopWatching()
        onSettled?.({ state: status.state, itemErrors: status.itemErrors })
        scheduleHide()
      } else if (status.state === 'error') {
        stopWatching()
        onSettled?.({
          state: 'error',
          itemErrors: status.itemErrors,
          ...(status.error !== undefined ? { error: status.error } : {}),
        })
      }
    }

    /**
     * One one-shot `fs.transferStatus` fetch — the initial read after the
     * acceptance and the catch-up after every socket re-open. This is the
     * old poll's replacement for the failure surfaces frames cannot carry:
     * `null` (the job is gone — host restart, retention GC) and a rejected
     * request settle the card instead of following a ghost forever.
     */
    const pullOnce = (): void => {
      void api.fsTransferStatus(transferId)
        .then((status) => {
          if (view === null || view.transferId !== transferId) return
          if (status === null) {
            if (view.state !== 'running' && view.state !== 'canceling') return
            stopWatching()
            view = { ...view, state: 'error', error: 'transfer lost' }
            emit()
            return
          }
          applyStatus(status)
        })
        .catch((error: unknown) => {
          if (view === null || view.transferId !== transferId) return
          if (view.state !== 'running' && view.state !== 'canceling') return
          stopWatching()
          view = { ...view, state: 'error', error: error instanceof Error ? error.message : String(error) }
          emit()
        })
    }

    watch = subscribeFsJobsWatch(
      scope.sessionId,
      [transferId],
      (frame) => {
        if (frame.kind !== 'transfer') return
        applyStatus(frame)
      },
      pullOnce,
    )
    // The initial one-shot read: it covers a job that settled before the
    // subscription frame could land (and doubles as the old first poll).
    pullOnce()
    return transferId
  })
}
