/**
 * 「远程工作区」状态页（tab type: `ssh-workspace`，单实例）：对本机安装的
 * dsh-ssh-workspace 插件的**只读**一览——概览统计、当前会话工作区、已挂载
 * 工作区、SSH 主机、端口转发与最近诊断事件。不做它的管理界面（挂载/停用/
 * 转发开关都是那个插件「远程工作区」面板自己的事），数据全部来自其 status
 * 接口，经 {@link ./gateway.ts} 的网关单例（探测可用性、TTL 重试与订阅都
 * 在那里）。
 *
 * 刷新节奏：页面可见时每 {@link PAGE_REFRESH_MS}（8s）强拉一轮 + 手动刷新
 * 按钮；不可见即停（`visible === false` 不持有任何定时器）。这里的轮询是
 * 对既有第三方路由的消费——ssh 插件不提供订阅通道，本插件也不改宿主与
 * 其他插件，无 ws 可用（插件自身的后端接口契约「能用 ws 不轮询」约束的是
 * 新增自有接口，见 my-ai 好设计·必须遵守规范）。
 *
 * 展示拼写（ssh 插件 docs/protocol.md 68-69 行）：`ssh://别名/路径` 在界面
 * 上写成 `ssh://别名@/路径`（读起来像 SSH 地址）；复制与一切功能用原始
 * 拼写（{@link sshDisplayPath} 只影响展示）。
 *
 * 降级路径（绝不抛未捕获异常）：网关不可用（插件未装/被禁用）→ 空态文案
 * （提示需安装 dsh-ssh-workspace）；从未探测完成 → 占位行；有过成功数据后
 * 的瞬时失败 → 保留旧数据 + 「读取失败」行 + 重试按钮（判定在 gateway 的
 * applyFailure）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { TabComponentProps, TabDescriptor } from '../service.ts'
import { t } from '../locales.ts'
import { getSshWorkspaceGateway, sshArrayOf, SSH_WORKSPACE_TAB_TYPE } from './gateway.ts'
import { isSshWorkspacePath, useCurrentWorkspacePath } from './current-workspace.ts'
import { sshWorkspaceTabIcon } from './tab-icon.tsx'
import css from './page.module.css'

/** 页面可见时的强拉间隔（手动刷新按钮随时可点）。 */
const PAGE_REFRESH_MS = 8_000

/* ── payload 行的宽松面（字段缺失/异形一律兜底，绝不抛）──────────────── */

interface SshConnectionFace {
  alias?: unknown
  state?: unknown
}

interface SshWorkspaceFace {
  path?: unknown
  title?: unknown
  sessionIds?: unknown
}

/** 活动转发（forward.js #describe）与已存 join 行（joinForwards）共用的面。 */
interface SshForwardFace {
  alias?: unknown
  localHost?: unknown
  localPort?: unknown
  remoteHost?: unknown
  remotePort?: unknown
  live?: unknown
}

interface SshEventFace {
  at?: unknown
  kind?: unknown
  message?: unknown
}

function strOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 展示拼写：`ssh://别名/rest` → `ssh://别名@/rest`。非 ssh:// 拼写原样返回。
 * 只用于展示——复制按钮永远拿原始拼写。
 */
export function sshDisplayPath(path: string): string {
  const match = /^ssh:\/\/([^/]+)(\/.*)$/.exec(path)
  return match === null ? path : `ssh://${match[1]}@${match[2]}`
}

/** 复制按钮：点一下写剪贴板（原始拼写），1.5s 内显示「已复制」。 */
function CopyButton(props: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => { setCopied(false) }, 1_500)
    return () => { window.clearTimeout(timer) }
  }, [copied])
  const label = t(copied ? 'sshCopied' : 'sshCopy')
  return (
    <button
      type="button"
      className={css.copy}
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text)
          .then(() => { setCopied(true) })
          .catch(() => { /* 剪贴板被拒（权限/非安全上下文）：按钮留在「复制」态，不打断页面 */ })
      }}
    >
      {label}
    </button>
  )
}

/** 一个分区卡片（标题 + 行）。 */
function Section(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>{props.title}</div>
      {props.children}
    </div>
  )
}

/** 「远程工作区」页面本体（只读；数据全部来自网关缓存的 status）。 */
export function SshWorkspacePage(props: Pick<TabComponentProps, 'ctx' | 'visible'>): ReactNode {
  const { ctx, visible } = props
  const gateway = getSshWorkspaceGateway()
  // useSyncExternalStore 需要稳定引用：网关是类实例，方法要包一层再给 React。
  const subscribe = useCallback((listener: () => void) => gateway.subscribe(listener), [gateway])
  const getState = useCallback(() => gateway.getState(), [gateway])
  const state = useSyncExternalStore(subscribe, getState)

  // 当前会话工作区：在屏会话（宿主 mounted 喂）+ 宿主工作区注册表按会话
  // 成员匹配（current-workspace.ts），ssh:// 拼写即远端会话。
  const workspacePath = useCurrentWorkspacePath(ctx)

  // 可见时 8s 一轮强拉；不可见（或卸载）即停——页面不持有任何后台定时器，
  // 常驻的低频 TTL 重试在网关里（胶囊徽章的活），两边互不重复计费。
  useEffect(() => {
    if (!visible) return
    void gateway.refresh()
    const timer = window.setInterval(() => { void gateway.refresh() }, PAGE_REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [visible, gateway])

  const onRefresh = useCallback(() => { void getSshWorkspaceGateway().refresh() }, [])

  if (state.status === null) {
    // 从未拿到过 status：占位行（未探测完）或不可用空态（404 / 首探失败）。
    const unavailable = state.probedAt !== null
    return (
      <div className={css.view} data-dsh-ssh-page="">
        <div className={css.stateLine}>
          {unavailable ? t('sshUnavailable') : `${t('sshWorkspacePage')}…`}
        </div>
        {unavailable && state.error !== null && (
          <div className={css.stateLine}>{`${t('sshLoadFailed')}：${state.error}`}</div>
        )}
      </div>
    )
  }

  const status = state.status
  const connections = sshArrayOf<SshConnectionFace>(status.connections)
  const workspaces = sshArrayOf<SshWorkspaceFace>(status.workspaces)
  const mountedRoots = sshArrayOf<unknown>(status.mounted)
  const disabledRoots = sshArrayOf<string>(status.disabled)
  const forwards = sshArrayOf<SshForwardFace>(status.forwards)
  // 老版本插件没有 forwardRows：整段退回活动转发列表（同一行的字段子集）。
  const forwardRows = status.forwardRows === undefined ? forwards : sshArrayOf<SshForwardFace>(status.forwardRows)
  const events = sshArrayOf<SshEventFace>(status.events)
  const brokenCount = connections.filter(connection => connection.state === 'broken').length
  const brokenLabel = t('sshConnBroken', { count: brokenCount })

  const isRemote = isSshWorkspacePath(workspacePath)

  return (
    <div className={css.view} data-dsh-ssh-page="">
      <div className={css.head}>
        <span className={css.headTitle}>{t('sshWorkspacePage')}</span>
        {/* 汇总连接状态点：全绿 = 全部 connected；任一 broken = 警示色。 */}
        <span
          className={`${css.dot} ${brokenCount > 0 ? css.dotBroken : css.dotOk}`}
          {...(brokenCount > 0
            ? { role: 'img', 'aria-label': brokenLabel, title: brokenLabel }
            : { 'aria-hidden': true })}
        />
        <button type="button" className={css.refresh} onClick={onRefresh}>{t('sshRefresh')}</button>
      </div>

      {state.error !== null && (
        <div className={css.errorRow} data-dsh-ssh-error="">
          <span className={css.errorText}>{`${t('sshLoadFailed')}：${state.error}`}</span>
          <button type="button" className={css.errorRetry} onClick={onRefresh}>{t('sshRetry')}</button>
        </div>
      )}

      <div className={css.stats}>
        <span className={css.stat}>
          <span className={css.statLabel}>{t('sshStatHosts')}</span>
          <span className={css.statValue}>{connections.length}</span>
        </span>
        <span className={css.stat}>
          <span className={css.statLabel}>{t('sshStatMounted')}</span>
          <span className={css.statValue}>{mountedRoots.length}</span>
        </span>
        <span className={css.stat}>
          <span className={css.statLabel}>{t('sshStatDisabled')}</span>
          <span className={css.statValue}>{disabledRoots.length}</span>
        </span>
        <span className={css.stat}>
          <span className={css.statLabel}>{t('sshStatForwards')}</span>
          <span className={css.statValue}>{forwards.length}</span>
        </span>
      </div>

      {workspacePath !== undefined && workspacePath !== '' && (
        <Section title={t('sshCurrentWorkspace')}>
          <div className={css.row}>
            <span className={css.rowMain}>
              {isRemote ? sshDisplayPath(workspacePath) : workspacePath}
            </span>
            {isRemote && (
              <span className={`${css.chip} ${css.chipRemote}`} title={workspacePath}>
                {t('sshRemoteMark')}
              </span>
            )}
            {isRemote && <CopyButton text={workspacePath} />}
          </div>
        </Section>
      )}

      <Section title={t('sshSectionWorkspaces')}>
        {workspaces.length === 0 && <div className={`${css.row} ${css.muted}`}>—</div>}
        {workspaces.map(item => {
          const path = strOf(item.path)
          if (path === '') return null
          const title = strOf(item.title) || path
          const disabled = disabledRoots.includes(path)
          const sessionCount = sshArrayOf<unknown>(item.sessionIds).length
          return (
            <div key={path} className={css.row}>
              <span className={`${css.rowMain} ${disabled ? css.muted : ''}`}>{title}</span>
              <span className={`${css.rowSub} ${disabled ? css.muted : ''}`}>{sshDisplayPath(path)}</span>
              {disabled && <span className={css.chip}>{t('sshStatDisabled')}</span>}
              <CopyButton text={path} />
              <span className={css.chip} title={path}>{t('sshSessionsCount', { count: sessionCount })}</span>
            </div>
          )
        })}
      </Section>

      <Section title={t('sshStatHosts')}>
        {connections.length === 0 && <div className={`${css.row} ${css.muted}`}>—</div>}
        {connections.map((connection, index) => {
          const alias = strOf(connection.alias)
          const broken = connection.state === 'broken'
          return (
            // status 接口不携带密钥信息（hosts 列表在另一条路由上）；这里的
            // 「状态」即连接池的 connected/broken（routes.js 786-790 行）。
            <div key={`${alias}:${index}`} className={css.row}>
              <span
                className={`${css.dot} ${broken ? css.dotBroken : css.dotOk}`}
                {...(broken ? { title: brokenLabel } : { 'aria-hidden': true })}
              />
              <span className={css.rowMain}>{alias === '' ? '—' : alias}</span>
            </div>
          )
        })}
      </Section>

      <Section title={t('sshStatForwards')}>
        {forwardRows.length === 0 && <div className={`${css.row} ${css.muted}`}>—</div>}
        {forwardRows.map((forward, index) => {
          const target = `${strOf(forward.localHost)}:${numOf(forward.localPort)} → `
            + `${strOf(forward.remoteHost)}:${numOf(forward.remotePort)}`
          const alias = strOf(forward.alias)
          const live = forward.live !== false
          return (
            <div key={`${alias}:${index}`} className={css.row}>
              <span
                className={`${css.dot} ${live ? css.dotOk : ''}`}
                {...(live ? { 'aria-hidden': true } : {})}
              />
              <span className={`${css.rowMain} ${css.fwdTarget} ${live ? '' : css.muted}`}>{target}</span>
              {alias !== '' && <span className={css.chip}>{alias}</span>}
            </div>
          )
        })}
      </Section>

      <Section title={t('sshSectionEvents')}>
        {events.length === 0 && <div className={`${css.row} ${css.muted}`}>—</div>}
        {/* 最近 ≤5 条，最新在前（接口最旧在前，这里翻一下再截）。 */}
        {events.slice(-5).reverse().map((event, index) => {
          const at = numOf(event.at)
          const time = at > 0 ? new Date(at).toLocaleTimeString() : '—'
          return (
            <div key={`${at}:${index}`} className={css.row}>
              <span className={css.eventTime}>{time}</span>
              <span className={css.chip}>{strOf(event.kind) || '—'}</span>
              <span className={css.rowMain}>{strOf(event.message)}</span>
            </div>
          )
        })}
      </Section>
    </div>
  )
}

/** tab 描述符（registerSshWorkspaceSupport 在探测可用后注册）。 */
export function createSshWorkspaceTabDescriptor(): TabDescriptor {
  return {
    id: SSH_WORKSPACE_TAB_TYPE,
    title: () => t('sshWorkspacePage'),
    description: () => t('guideDescSshWorkspace'),
    icon: sshWorkspaceTabIcon,
    // 状态页排在 commands 配置页(40)/terminal-bottom(41) 之后、settings(50)
    // 之前：可见的工具页门（进 + 菜单与 native guide）。
    order: 42,
    hidden: false,
    single: true,
    // 网关不可用（未装/被禁用/注册后又消失）→ + 菜单 disabled 行，不报错。
    available: () => getSshWorkspaceGateway().getState().available,
    component: ({ ctx, visible }) => <SshWorkspacePage ctx={ctx} visible={visible} />,
  }
}
