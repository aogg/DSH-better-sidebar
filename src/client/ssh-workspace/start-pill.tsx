/**
 * 开始页的「远程工作区」胶囊——本功能在 hero 入口网格里的**标识**。
 *
 * - 仅当网关探测 available（dsh-ssh-workspace 插件在）时才渲染；未安装 =
 *   零痕迹（连 DOM 都不留，网格里看不到这一格）；
 * - 点击 `service.openTab({ type: 'ssh-workspace' })` 打开状态页；
 * - 徽章三件套：已挂载数量数字 chip（>0 才显示）、连接状态小圆点（全部
 *   connected = 正常色，任一 broken = 警示色）、当前会话工作区是 ssh:// 时
 *   追加「远程」小标记；
 * - 样式复用 start-links.module.css 的胶囊类（与其他胶囊同一形制），本模块
 *   只画附加徽章；DOM 位置在 commands 与 settings 之间（settings 恒最后，
 *   由 start-links.tsx 的渲染顺序保证）。
 *
 * title/aria 注明数据来源（dsh-ssh-workspace 插件），避免与其他「远程」
 * 语义混淆。数据变化经网关订阅实时反映（60s TTL 探测 + 可见期的页面轮询
 * 都会推给这里）；会话切换经宿主 mounted 喂同步。
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '../../context-types.ts'
import type { BetterSidebarService } from '../service.ts'
import { t } from '../locales.ts'
import startCss from '../sidebar/start-links.module.css'
import { getSshWorkspaceGateway, SSH_WORKSPACE_TAB_TYPE } from './gateway.ts'
import { isSshWorkspacePath, useCurrentWorkspacePath } from './current-workspace.ts'
import { sshWorkspaceTabIcon } from './tab-icon.tsx'
import pillCss from './start-pill.module.css'

export function SshWorkspaceStartPill(props: { ctx: Context; service: BetterSidebarService }): ReactNode {
  const { ctx, service } = props
  const gateway = getSshWorkspaceGateway()
  const subscribe = useCallback((listener: () => void) => gateway.subscribe(listener), [gateway])
  const getState = useCallback(() => gateway.getState(), [gateway])
  const state = useSyncExternalStore(subscribe, getState)
  const workspacePath = useCurrentWorkspacePath(ctx)

  // 未安装（或被禁用）= 零痕迹：开始页网格里不出现这一格。
  if (!state.available) return null

  const status = state.status
  const mountedCount = Array.isArray(status?.mounted) ? status.mounted.length : 0
  const connections = Array.isArray(status?.connections) ? status.connections : []
  const anyBroken = connections.some(connection => {
    const connectionState = (connection as { state?: unknown } | null)?.state
    return connectionState === 'broken'
  })
  const remote = isSshWorkspacePath(workspacePath)
  const label = t('sshWorkspacePage')

  return (
    <button
      type="button"
      className={startCss.pill}
      data-dsh-start-link={SSH_WORKSPACE_TAB_TYPE}
      aria-label={t('guideDescSshWorkspace')}
      title={t('guideDescSshWorkspace')}
      onClick={() => { service.openTab({ type: SSH_WORKSPACE_TAB_TYPE }) }}
    >
      <span className={startCss.icon} aria-hidden="true">{sshWorkspaceTabIcon(14)}</span>
      <span className={startCss.label}>{label}</span>
      {mountedCount > 0 && <span className={pillCss.count}>{mountedCount}</span>}
      <span
        className={`${pillCss.dot} ${anyBroken ? pillCss.dotBroken : ''}`}
        {...(anyBroken
          ? { role: 'img', 'aria-label': t('sshConnBroken', { count: 1 }) }
          : { 'aria-hidden': true })}
      />
      {remote && <span className={pillCss.remote}>{t('sshRemoteMark')}</span>}
    </button>
  )
}
