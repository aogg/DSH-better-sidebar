/**
 * 会话相位的客户端读取（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达；客户端据此在输入区渲染
 * 备用入口，并在会话脱离 blank（发出第一条消息）后退场、把入口还给会话头。
 *
 * 判定来自插件 host 半区的只读路由（与会话对象同源），**不做任何 DOM 探测**。
 * 读取策略：优先走 /sidebar/ws/session 推送（watch 当前会话，socket 打开期间不跑
 * 轮询，收到本会话的 phase 帧 blank:false 即落定并结束）；socket 连不上/断开时退回
 * 每 1s 的 HTTP 轮询（原兜底路径），翻转为非 blank 即停止；路由/宿主不支持时按非
 * blank 降级（入口留在会话头，行为与今天一致）。
 */
import { useEffect, useState } from 'react'
import { sessionPhase, type SessionPhase } from './api.ts'
import { connectSessionPush } from './session-push.ts'

/** 轮询间隔：blank 是一次性状态（发一条消息即翻转），无需更快。 */
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
    // 推送 socket 是否处于打开状态：打开期间轮询暂停，断开即自动恢复（兜底）。
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
    void request()
    timer = setInterval(() => {
      if (pushOpen) return
      request()
    }, POLL_MS)
    // 推送通道：服务端只在本会话发出首条 user/assistant message 时推一次 phase 帧，
    // 与路由同源同判定；帧到即非 blank，无需再问。
    stopPush = connectSessionPush([sessionId], (frame) => {
      if (!alive) return
      if (frame.kind !== 'phase' || frame.sessionId !== sessionId) return
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
