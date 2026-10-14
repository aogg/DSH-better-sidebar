/**
 * The top-right paste-progress card (文件树黏贴的进度条): ONE fixed card for
 * the whole page, mounted once by `registerTransferToast` and driven by the
 * `transfer-client` store. Running shows a determinate bar (bytes, falling
 * back to files when the batch has no regular-file bytes) plus the counts;
 * a terminal state collapses to a one-line summary — done/canceled linger
 * briefly and take themselves away, an error stays until dismissed, and a
 * batch with per-item failures lists the count under the summary.
 *
 * Skin contract: every color/font goes through `--dsw-alias-*` tokens (the
 * module has zero literals), and the card is `role="status"` +
 * `aria-live="polite"` so progress is announced without stealing focus — the
 * same accessibility shape as the tree's archive progress line.
 */
import { useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IconCheckOutlineRegular, IconCloseFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'
import { cancelTransfer, dismissTransfer, getTransferView, subscribeTransferView } from './transfer-client.ts'
import css from './transfer-toast.module.css'

/** 1 234 567 → `1.2 MB` (the card's byte counter; units are metric-ish). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** The card body (exported for tests; the register wrapper only portals it). */
export function TransferToast(): React.ReactNode {
  const view = useSyncExternalStore(subscribeTransferView, getTransferView)
  if (view === null) return null
  const fraction = view.totalBytes > 0
    ? (view.totalFiles > 0 ? view.bytesDone / view.totalBytes : 0)
    : (view.totalFiles > 0 ? view.filesDone / view.totalFiles : 0)
  const percent = Math.min(100, Math.round(fraction * 100))
  const title = view.mode === 'copy'
    ? t('transferCopyTitle', { count: view.totalFiles })
    : t('transferMoveTitle', { count: view.totalFiles })
  const terminal = view.state === 'done' || view.state === 'error' || view.state === 'canceled'
  return (
    <div className={css.card} data-dsh-transfer-toast={view.state} role="status" aria-live="polite">
      <div className={css.head}>
        <span className={css.title}>{title}</span>
        <span className={css.state}>
          {view.state === 'done' && (
            <span className={css.doneLabel}>
              <IconCheckOutlineRegular size={12} />
              {t('transferDone')}
            </span>
          )}
          {view.state === 'canceled' && <span className={css.doneLabel}>{t('transferCanceled')}</span>}
          {view.state === 'error' && <span className={css.errorLabel}>{t('transferFailed')}</span>}
          {view.state === 'canceling' && <span className={css.dimLabel}>{t('transferCanceling')}</span>}
        </span>
        {view.state === 'running' && (
          <button type="button" className={css.button} onClick={cancelTransfer}>
            {t('clipCancel')}
          </button>
        )}
        {terminal && (
          <button type="button" className={css.iconButton} aria-label={t('close')} onClick={dismissTransfer}>
            <IconCloseFillRegular size={12} />
          </button>
        )}
      </div>
      <div className={css.bar} aria-hidden="true">
        <div className={css.barFill} style={{ width: `${percent}%` }} />
      </div>
      <div className={css.meta}>
        <span>{percent}%</span>
        <span>{formatBytes(view.bytesDone)} / {formatBytes(view.totalBytes)}</span>
        <span>{view.filesDone}/{view.totalFiles}</span>
      </div>
      {view.itemErrors.length > 0 && (
        <div className={css.errors}>
          {t('transferPartialErrors', { count: view.itemErrors.length })}
        </div>
      )}
      {view.state === 'error' && view.error !== undefined && (
        <div className={css.errors} role="alert">{view.error}</div>
      )}
    </div>
  )
}

/**
 * Mount the card once for the page's lifetime (a body-level portal — the card
 * must survive any tree/tab unmount, and top-right is a viewport corner, not
 * a panel slot). Returns the disposer (HMR / plugin disable).
 */
export function registerTransferToast(): () => void {
  const host = document.createElement('div')
  host.setAttribute('data-dsh-transfer-toast-host', '')
  document.body.appendChild(host)
  let root: Root | undefined
  try {
    root = createRoot(host)
    root.render(<TransferToast />)
  } catch {
    host.remove()
    return () => {}
  }
  return () => {
    try {
      root?.unmount()
    } catch {
      // Already detached.
    }
    host.remove()
  }
}
