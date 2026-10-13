/**
 * 右栏打开宽度占比（`rightbarOpenRatio`）的应用与回写。
 *
 * 宿主事实（0.2.0-rc.2 bundle 复核）：`ctx.get('layout')` 是 LayoutController，
 * `.panels` 是 **dsh-client-store 实例的 actions（只写面）**——`setRightbar(px)`
 * 内部 clamp 到 [300, viewport*0.7]，但这个对象**没有** getSnapshot/subscribe，
 * 快照读不到；`panelInfo` 只投影面板选中，subscribe 也帮不上「读宽度」。因此：
 * - 写：结构化探测 `panels.setRightbar`（每次应用时重取，服务迟到也能接上）；
 * - 读：宿主 AppFrame 的稳定 `data-*` 标记。`[data-rightbar-col]`（RightbarColumn
 *   恒渲染）的父元素就是 AppFrame 根；它的内联 `grid-template-columns` 第三轨是
 *   `minmax(0px, ${rightbarMax}px)`，rightbarMax 即 clamp 后的右栏宽度偏好
 *   （收起时为 0）。`px > 0` 就是「有轨道的展开态」；viewport 用宿主同一把尺
 *   （frame 的 getBoundingClientRect().width，与宿主自己的 measure 同源）。
 * - 脉冲：frame 元素上的 MutationObserver（attributes）——React 渲染写内联样式
 *   即触发。**不能用布局 store 的订阅当脉冲**：它在 store 提交时同步发火，而
 *   DOM 要等 React 渲染，打开跳变那一刻读到的还是旧样式，会漏掉唯一一次应用
 *   时机。frame 元素身份由每次 sync 时的廉价 querySelector 复核（AppFrame 重挂
 *   即换锚）；MutationObserver 缺席的极端环境降级 500ms 轮询
 *   （right-panel-open.ts 的节拍）。
 *
 * 防回环：应用宽度只由「无轨道 → 有轨道」的跳变触发（打开动作），拖动/回写期间
 * shown 不变、不会再应用；回写按 px 变化驱动（resize 只变 viewport 不触发），去抖
 * 800ms 后 px/viewport 四舍五入到 0.001、clamp，与现值相等则不写（应用自身的
 * setRightbar 引起的 px 变化最终折算回同一占比，也不写）。宿主每帧拖动都过这里，
 * 重活只有一个正则和一个 setTimeout 重排。
 */
import type { Context } from '../../context-types.ts'
import { clampRightbarRatio } from '../../prefs-shared.ts'

/** 回写去抖：拖动停稳后才落一次偏好（宿主拖动是每帧 store 提交）。 */
export const WRITE_BACK_DEBOUNCE_MS = 800

/** 无 MutationObserver 时的轮询节拍（与 right-panel-open.ts 对齐）。 */
const POLL_MS = 500

/** 布局服务的结构化探测面（只消费 .panels 的写动作）。 */
interface LayoutFace {
  panels?: { setRightbar?(px: number): void }
}

function probeLayout(ctx: Context): LayoutFace | undefined {
  try {
    const layout = ctx.get('layout') as LayoutFace | undefined
    if (layout === null || typeof layout !== 'object') return undefined
    return layout
  } catch {
    return undefined
  }
}

/** 一次 DOM 读的结果：有轨道（展开）与否、轨道 px、frame 宽度。 */
export interface TrackState {
  shown: boolean
  px: number
  viewport: number
}

/**
 * 从宿主 DOM 读当前右栏轨道状态。
 * @param doc - 可注入 document（测试）。
 * @returns 读不到 frame / 样式形状不符时为 undefined（调用方保持上一态，不误判跳变）。
 */
export function readRightbarTrack(doc: Document = document): TrackState | undefined {
  // RightbarColumn 恒渲染 `[data-rightbar-col]`；fragment 不产生 DOM，父元素即 frame。
  const column = doc.querySelector('[data-rightbar-col]')
  const frame = column?.parentElement
  if (frame === null || frame === undefined) return undefined
  const template = (frame as HTMLElement).style?.gridTemplateColumns ?? ''
  // 第三轨形如 `minmax(0px, 508px)`；正则锚定 0px 下界 + 结尾，避免吃到中列的
  // `minmax(400px, 1fr)`。
  const match = template.match(/minmax\(0px,\s*([0-9.]+)px\)\s*$/)
  if (match === null) return undefined
  const px = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(px) || px < 0) return undefined
  const viewport = frame.getBoundingClientRect().width
  if (!Number.isFinite(viewport) || viewport <= 0) return undefined
  return { shown: px > 0, px, viewport }
}

export interface RightbarWidthSync {
  dispose(): void
}

export interface RightbarWidthSyncOptions {
  ctx: Context
  /** 当前占比偏好（共享 store）。 */
  getRatio: () => number
  /** 持久化一个新占比（后台写路径；实现方自行排队与容错）。 */
  writeRatio: (ratio: number) => void
}

/**
 * 建立右栏宽度同步。全部探测失败时静默降级：不订阅、不写、不抛。
 */
export function createRightbarWidthSync(options: RightbarWidthSyncOptions): RightbarWidthSync {
  const { ctx, getRatio, writeRatio } = options

  let last: TrackState | undefined
  let timer: number | undefined
  let disposed = false
  let observedFrame: Element | undefined
  let observer: MutationObserver | undefined
  let stopPolling: (() => void) | undefined

  const setRightbarOf = (): ((px: number) => void) | undefined => {
    const setRightbar = probeLayout(ctx)?.panels?.setRightbar
    return typeof setRightbar === 'function' ? px => { setRightbar(px) } : undefined
  }

  /** 展开跳变：按配置占比应用一次宽度（写动作只在这里发生）。 */
  const applyConfiguredWidth = (viewport: number): void => {
    const setRightbar = setRightbarOf()
    if (setRightbar === undefined || viewport <= 0) return
    const px = Math.round(clampRightbarRatio(getRatio()) * viewport)
    setRightbar(px)
  }

  const cancelWriteBack = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }

  /** 拖动停稳（去抖后）把 px/viewport 四舍五入到 0.001 写回；与现值相等不写。 */
  const scheduleWriteBack = (): void => {
    cancelWriteBack()
    timer = window.setTimeout(() => {
      timer = undefined
      if (disposed) return
      const now = readRightbarTrack()
      if (now === undefined || !now.shown || now.viewport <= 0) return
      const ratio = clampRightbarRatio(Math.round((now.px / now.viewport) * 1000) / 1000)
      if (ratio !== getRatio()) writeRatio(ratio)
    }, WRITE_BACK_DEBOUNCE_MS)
  }

  const sync = (): void => {
    if (disposed) return
    attachObserver()
    const state = readRightbarTrack()
    // 探测失败（宿主形状变了/无 DOM）：保持上一态——宁可不动作，不误判跳变。
    if (state === undefined) return
    const prev = last
    last = state
    if (prev === undefined) return
    if (!prev.shown && state.shown) applyConfiguredWidth(state.viewport)
    if (state.shown && state.px !== prev.px) scheduleWriteBack()
    if (!state.shown) cancelWriteBack()
  }

  /** frame 身份复核 + 属性观察（AppFrame 重挂即换锚；observe 幂等）。 */
  const attachObserver = (): void => {
    if (typeof MutationObserver === 'undefined') return
    const frame = document.querySelector('[data-rightbar-col]')?.parentElement
    if (frame === null || frame === undefined || frame === observedFrame) return
    observer?.disconnect()
    observedFrame = frame
    observer = new MutationObserver(sync)
    observer.observe(frame, { attributes: true })
  }

  if (typeof MutationObserver === 'undefined') {
    // 极端环境（无 MutationObserver）：轮询既当脉冲也当换锚复核。
    const interval = window.setInterval(sync, POLL_MS)
    stopPolling = () => { window.clearInterval(interval) }
  } else {
    // 首帧探不中（激活早于宿主渲染）也没关系：轮询兜底每 500ms 重试挂锚，
    // 挂上后 observer 接管，轮询自然只剩兜底意义——为省一个定时器，挂锚成功
    // 即停轮询（frame 丢失时下一次 observer 回调仍会读 undefined 保持上一态，
    // 且 attachObserver 在每次 sync 重跑时重挂新锚）。
    attachObserver()
    if (observedFrame === undefined) {
      const interval = window.setInterval(() => {
        attachObserver()
        if (observedFrame !== undefined) {
          window.clearInterval(interval)
          stopPolling = undefined
          sync()
        }
      }, POLL_MS)
      stopPolling = () => { window.clearInterval(interval) }
    }
  }

  return {
    dispose: (): void => {
      disposed = true
      cancelWriteBack()
      observer?.disconnect()
      observer = undefined
      observedFrame = undefined
      stopPolling?.()
    },
  }
}
