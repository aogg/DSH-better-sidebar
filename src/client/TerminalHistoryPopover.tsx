/**
 * 「执行命令历史」弹窗的正文：底部工作台终端右上角按钮点开的浮层（几何与
 * 关闭契约都在 AnchoredPopover，与 Tasks 页的节点详情同一骨架）。
 *
 * 内容 = 会话共享的命令执行记录（terminal-history.ts 的环形队列，最新在上），
 * 每条一行：状态点 + 命令 + 状态文案；点行展开完整输出（等宽、限高、内部
 * 滚动）。运行中的记录实时跟随（日志的 revision 经 useSyncExternalStore
 * 推给浮层，无任何轮询）。数据纯内存：刷新页面即清空。
 */
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { t } from './locales.ts'
import { terminalHistoryLogOf, type TerminalCommandRecord } from './terminal-history.ts'
import css from './terminal.module.css'

/** 一条记录的状态文案：退出码只在前端真的拿到时才说。 */
function statusLabel(record: TerminalCommandRecord): string {
  switch (record.status) {
    case 'running':
      return t('terminalHistoryStatusRunning')
    case 'success':
      return t('terminalHistoryStatusSuccess')
    case 'failed':
      return record.exitCode === undefined
        ? t('terminalHistoryStatusFailed')
        : t('terminalHistoryStatusFailedCode', { code: record.exitCode })
    case 'interrupted':
      return t('terminalHistoryStatusInterrupted')
    case 'done':
      return t('terminalHistoryStatusDone')
  }
}

/** 弹窗属性：锚点按钮 + 关闭回调 + 会话（日志按会话共享）。 */
export interface TerminalHistoryPopoverProps {
  anchor: HTMLElement
  onClose(): void
  sessionId: string
}

/**
 * The history card. Subscribes to the session log's revision so a running
 * command's status/output updates live while the popover is open.
 */
export function TerminalHistoryPopover(props: TerminalHistoryPopoverProps): ReactNode {
  const { anchor, onClose, sessionId } = props
  const log = useMemo(() => terminalHistoryLogOf(sessionId), [sessionId])
  // The revision counter is the snapshot (a number): the record objects are
  // mutated in place by the recorder, so a stable record identity must not
  // gate updates. The component only re-renders when the revision moves, so
  // the list is simply read fresh per render (a copy — never the live array).
  const revision = useSyncExternalStore(
    useCallback((callback: () => void) => log.subscribe(callback), [log]),
    useCallback(() => log.getRevision(), [log]),
  )
  void revision
  const records = log.list()
  const [openId, setOpenId] = useState<number | undefined>(undefined)

  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} width={460}>
      <div className={css.historyCard} role="dialog" aria-label={t('terminalHistory')}>
        <div className={css.historyHead}>
          <span>{t('terminalHistory')}</span>
          {records.length > 0 && <span className={css.historyCount}>{records.length}</span>}
        </div>
        {records.length === 0 ? (
          <p className={css.historyEmpty}>{t('terminalHistoryEmpty')}</p>
        ) : (
          <div className={css.historyList}>
            {records.map(record => (
              <div key={record.id} className={css.historyItem}>
                <button
                  type="button"
                  className={css.historyRow}
                  data-status={record.status}
                  aria-expanded={openId === record.id}
                  title={record.command}
                  onClick={() => { setOpenId(current => (current === record.id ? undefined : record.id)) }}
                >
                  <span className={css.historyDot} aria-hidden="true" />
                  <span className={css.historyCommand}>{record.command}</span>
                  <span className={css.historyState}>{statusLabel(record)}</span>
                </button>
                {openId === record.id && (
                  <pre className={css.historyOutput} data-testid="terminal-history-output">
                    {record.output === '' ? t('terminalHistoryNoOutput') : record.output}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </AnchoredPopover>
  )
}
