/**
 * dsh-ssh-workspace 集成的唯一出口：{@link registerSshWorkspaceSupport}。
 *
 * 职责（全部 ssh-workspace 逻辑都封在本文件夹内，外面只有 start-links.tsx
 * 引一个胶囊组件）：
 * 1. 取/铸网关单例（gateway.ts 的工厂 + Null-object）；
 * 2. 首轮探测；**available 之后**才 `service.registerTab(...)`——未安装 =
 *    从不注册，宿主 + 菜单 / guide / tab 条零痕迹；
 * 3. 返回 disposer：撤销「未完成的注册」（探测在途就收到 dispose 时不落
 *    注册）、反注册已落地的 tab、销毁网关单例（HMR / 插件停用安全；重新
 *    激活时下一次 getSsh 铸新实例、重新探测）。
 *
 * 探测成功后的注册是一次性的：之后可用性波动由描述符自身的 `available`
 * 回调（page.tsx）门控——不可用时宿主渲染 disabled 行，而不是报错或反复
 * 注册/反注册。
 */
import type { Context } from '../../context-types.ts'
import type { BetterSidebarService } from '../service.ts'
import {
  disposeSshWorkspaceGateway,
  getSshWorkspaceGateway,
  SSH_WORKSPACE_TAB_TYPE,
} from './gateway.ts'
import { createSshWorkspaceTabDescriptor } from './page.tsx'

/**
 * 注册 dsh-ssh-workspace 集成（client index.tsx 的一个 ctx.effect）。
 * @param ctx - client 插件上下文（保留给描述符/组件面；当前无直接消费）。
 * @param service - 侧边栏注册服务（tab 落点）。
 * @returns disposer：反注册 + 网关销毁。
 */
export function registerSshWorkspaceSupport(ctx: Context, service: BetterSidebarService): () => void {
  const gateway = getSshWorkspaceGateway()
  let registered: (() => void) | undefined
  let disposed = false

  const maybeRegister = (): void => {
    if (disposed) return
    if (!gateway.getState().available) return
    // 已注册（重复通知 / HMR 后的重复探测）不再注册。
    if (service.getTab(SSH_WORKSPACE_TAB_TYPE) !== undefined) return
    registered = service.registerTab(createSshWorkspaceTabDescriptor())
  }

  const unsubscribe = gateway.subscribe(maybeRegister)
  // 首轮探测（probe 永不 reject，结果折叠进快照）；成功后订阅回调会补上
  // 注册。disposed 后到达的探测结果只会改一个已无人订阅的网关，无害。
  void gateway.probe()

  return () => {
    disposed = true
    unsubscribe()
    // 撤销注册（探测成功后已落地的情形）；探测在途就 dispose 的情形下
    // registered 仍是 undefined，之后到位的通知也被 disposed 拦下。
    registered?.()
    registered = undefined
    disposeSshWorkspaceGateway()
  }
}
