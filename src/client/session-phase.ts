/**
 * 会话相位的客户端读取（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达；客户端据此在输入区渲染
 * 备用入口，并在会话脱离 blank（发出第一条消息）后退场、把入口还给会话头。
 *
 * 判定来自插件 host 半区的只读路由（与会话对象同源），**不做任何 DOM 探测**。
 * 读取策略：相位答案完全走 /sidebar/ws/session 推送 —— watch 当前会话时宿主就
 * 解析并推送当前相位（blank:true 表示还在等，blank:false 即翻转落定），挂载时
 * 零 HTTP；socket 连不上/断开时退回每 1s 的 HTTP 轮询（兜底路径），翻转为非
 * blank 即停止；路由/宿主不支持时按非 blank 降级（入口留在会话头，行为与今天
 * 一致）。
 */
import { useEffect, useState } from 'react'
import { sessionPhase, type SessionPhase } from './api.ts'
import { connectSessionPush } from './session-push.ts'

/** 轮询间隔：blank 是一次性状态（发一条消息即翻转），无需更快；且只在断线期间跑。 */
const POLL_MS = 1_000

/**
 * 跟踪一个会话的 blank 相位。
 * @param sessionId - 当前会话（undefined 时不读取，返回 undefined）。
 * @returns 相位；尚未读到时为 undefined（调用方应视为非 blank，先不渲染备用入口）。
 */
export function useSessionPhase(sessionId: string | undefined): SessionPhase | undefined {
  const [phase, setPhase] = useState<SessionPhase | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined) {
      setPhase(undefined)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    let stopPush: (() => void) | undefined
    // 推送 socket 是否处于打开状态：打开期间轮询暂停（相位答案由 watch 帧送达），
    // 断开即自动恢复（兜底）。
    let pushOpen = false
    const stop = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    /** 落定为非 blank：停轮询、停推送，本 hook 到此结束（入口还给会话头）。 */
    const finish = (): void => {
      stop()
      stopPush?.()
      stopPush = undefined
    }
    const request = (): void => {
      sessionPhase(sessionId).then((next) => {
        if (!alive) return
        setPhase(next)
        if (!next.blank) finish()
      }).catch(() => {
        // 路由/宿主不支持：按非 blank 降级（不渲染备用入口，入口留在会话头）。
        if (!alive) return
        setPhase({ blank: false })
        finish()
      })
    }
    // 挂载零 HTTP：相位答案由推送 watch 帧送达。这个 1s 轮询是断线兜底，只在
    // socket 关闭期间真正发出请求（pushOpen 门控）。
    timer = setInterval(() => {
      if (pushOpen) return
      request()
    }, POLL_MS)
    // 推送通道：watch 订阅时宿主即推送当前相位（blank:true = 还在等，照常等；
    // blank:false = 翻转落定），与会话相位路由同源同判定；无 blank 字段的旧
    // 宿主帧恒为翻转（旧格式只推翻转），同样落定结束。
    stopPush = connectSessionPush([sessionId], (frame) => {
      if (!alive) return
      if (frame.kind !== 'phase' || frame.sessionId !== sessionId) return
      if (frame.blank === true) {
        // 还在等：blank 会话继续等待，翻转帧稍后到达。
        setPhase((previous) => (previous !== undefined && previous.blank === true ? previous : { blank: true }))
        return
      }
      // blank:false（或旧宿主帧缺省该字段）＝ 非空白，落定并结束。
      setPhase({ blank: false })
      finish()
    }, (open) => { pushOpen = open })
    return () => {
      alive = false
      finish()
    }
  }, [sessionId])
  return phase
}
