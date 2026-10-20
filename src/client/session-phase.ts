/**
 * 会话相位的客户端读取（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达；客户端据此在输入区渲染
 * 备用入口，并在会话脱离 blank（发出第一条消息）后退场、把入口还给会话头。
 *
 * 判定来自插件 host 半区的只读路由（与会话对象同源），**不做任何 DOM 探测**。
 * 读取策略：ws 是唯一数据通道，相位答案只走 /sidebar/ws/session 推送 —— watch 当前
 * 会话时宿主就解析并推送当前相位（`blank:true` 表示还在等，`blank:false` 即翻转落定）。
 * 挂载零 HTTP；断线时绝不发 HTTP 轮询，只靠 connectSessionPush 现成的重连退避
 * （1s→15s，连上即复位）继续重连。socket 一直连不上（宿主/路由不支持）时相位恒为
 * undefined，调用方按非 blank 对待（入口留在会话头，与旧降级路径可见行为一致，
 * 但零 HTTP）。
 */
import { useEffect, useState } from 'react'
import type { SessionPhase } from './api.ts'
import { connectSessionPush } from './session-push.ts'

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
    let stopPush: (() => void) | undefined
    /** 落定为非 blank：停推送，本 hook 到此结束（入口还给会话头）。 */
    const finish = (): void => {
      stopPush?.()
      stopPush = undefined
    }
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
    })
    return () => {
      alive = false
      finish()
    }
  }, [sessionId])
  return phase
}
