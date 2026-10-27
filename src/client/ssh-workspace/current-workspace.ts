/**
 * 「当前会话工作区」的判定：在屏会话（宿主 mounted 喂）+ 宿主工作区注册表
 * 按会话成员匹配（同 conversation-draft.ts 的读法），返回该会话的
 * `WorkspaceView.path`——以 `ssh://` 开头即远端会话。开始页胶囊的「远程」
 * 小标记与状态页的「当前会话工作区」行共用这一个 hook，两处永远同答案。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Context } from '../../context-types.ts'
import { mountedSessions } from '../native/surface.ts'

/** 宿主工作区服务面（结构化探测；同 conversation-draft.ts 的读法）。 */
interface WorkspacesListFace {
  list: {
    getSnapshot(): {
      readonly phase: string
      readonly state: string
      readonly items: readonly { readonly path: string; readonly sessionIds: readonly string[] }[]
    }
    subscribe(listener: () => void): () => void
  }
}

/**
 * 解析宿主工作区服务面。cordis 对未提供的服务会 throw（双 cordis 实例的
 * 解析差异，见 context-types.ts 头注释）；缺席是正常形态（服务还没注入），
 * 调用方用 useMemo 只探一次（ctx 变化才重探），warn 一次即可，绝不进渲染
 * 热路径刷屏。
 */
function workspacesFaceOf(ctx: Context): WorkspacesListFace | undefined {
  try {
    const face = ctx.get('workspaces') as WorkspacesListFace | undefined
    return typeof face?.list?.getSnapshot === 'function' ? face : undefined
  } catch (error) {
    console.warn('[dsh-better-sidebar] ssh-workspace: workspaces service unavailable:', error)
    return undefined
  }
}

/**
 * 当前在屏会话的工作区路径（`undefined` = 无在屏会话 / 工作区未就绪 /
 * 成员未匹配——三种情况都无法断言远端，调用方一律按「非远程」处理）。
 */
export function useCurrentWorkspacePath(ctx: Context): string | undefined {
  const mounted = useMemo(() => mountedSessions(ctx), [ctx])
  const sessionId = useSyncExternalStore(mounted.subscribe, mounted.getSnapshot)
  const face = useMemo(() => workspacesFaceOf(ctx), [ctx])
  return useSyncExternalStore(
    useCallback(
      (listener: () => void) => face?.list.subscribe(listener) ?? (() => {}),
      [face],
    ),
    useCallback(() => {
      if (sessionId === undefined) return undefined
      const snapshot = face?.list.getSnapshot()
      return snapshot?.phase === 'ready' && snapshot.state === 'idle'
        ? snapshot.items.find(item => item.sessionIds.includes(sessionId))?.path
        : undefined
    }, [sessionId, face]),
  )
}

/** 该路径是否 ssh:// 拼写（远端工作区）。 */
export function isSshWorkspacePath(path: string | undefined): boolean {
  return path !== undefined && path.startsWith('ssh://')
}
