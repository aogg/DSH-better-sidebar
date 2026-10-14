/**
 * 右栏打开宽度占比的同步（src/client/sidebar/rightbar-width.ts）。
 *
 * 宿主布局 store 的快照不可达（`.panels` 是 actions-only，bundle 复核），读路径
 * 是 AppFrame 的稳定 `data-*` + 内联 grid-template-columns；脉冲是 frame 元素的
 * attributes MutationObserver（React 渲染写样式即触发，时序在渲染之后——store
 * 订阅在提交时就发火，会读到旧 DOM 漏掉打开跳变）。这里用假 frame 复刻那个形状，
 * 脉冲用一次真实的属性变更驱动（`data-rightbar-pulse`），并钉住：展开跳变应用
 * 配置宽度、拖动去抖回写、clamp、等于现值不写、resize 只变 viewport 不触发、
 * 探测失败静默降级、frame 迟到时轮询挂锚、dispose 清理。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRightbarWidthSync, readRightbarTrack, WRITE_BACK_DEBOUNCE_MS } from '../src/client/sidebar/rightbar-width.ts'
import type { Context } from '../src/context-types.ts'

interface Fixture {
  ctx: Context
  setRightbar: ReturnType<typeof vi.fn>
}

/** 假布局服务：只暴露 panels.setRightbar（快照面在宿主不存在）。 */
function makeCtx(options: { setRightbar?: (px: number) => void } = {}): Fixture {
  const setRightbar = options.setRightbar ?? vi.fn()
  const layout = { panels: { setRightbar } }
  const ctx = {
    get: (name: string) => (name === 'layout' ? layout : undefined),
  } as unknown as Context
  return { ctx, setRightbar: setRightbar as ReturnType<typeof vi.fn> }
}

/** 假宿主 frame：`[data-rightbar-col]` 的父元素带内联三轨 grid 与可注入 rect。 */
function buildFrame(px: number, viewport: number): HTMLElement {
  document.body.innerHTML = ''
  const frame = document.createElement('div')
  const column = document.createElement('div')
  column.setAttribute('data-rightbar-col', '')
  frame.appendChild(column)
  document.body.appendChild(frame)
  setTrack(frame, px)
  frame.getBoundingClientRect = () => ({
    width: viewport, height: 900, x: 0, y: 0, left: 0, top: 0, right: viewport, bottom: 900,
    toJSON: () => ({}),
  }) as DOMRect
  return frame
}

function setTrack(frame: HTMLElement, px: number): void {
  frame.style.gridTemplateColumns = `280px minmax(400px, 1fr) minmax(0px, ${px}px)`
}

let pulseSeq = 0

/** 一次真实的属性变更：观察者回调是微任务，两拍 Promise 即冲刷（不碰假计时器）。 */
async function pulse(frame: HTMLElement): Promise<void> {
  frame.setAttribute('data-rightbar-pulse', String(pulseSeq += 1))
  await Promise.resolve()
  await Promise.resolve()
}

/** 带可变占比偏好的 harness。 */
function harness(fixture: Fixture, ratio: number): { setRatio: (next: number) => void; writeRatio: ReturnType<typeof vi.fn>; dispose: () => void } {
  let current = ratio
  const writeRatio = vi.fn()
  const sync = createRightbarWidthSync({
    ctx: fixture.ctx,
    getRatio: () => current,
    writeRatio: (next) => { current = next; writeRatio(next) },
  })
  return { setRatio: (next) => { current = next }, writeRatio, dispose: () => { sync.dispose() } }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('readRightbarTrack（DOM 读路径）', () => {
  it('从第三轨 minmax(0px, Npx) 读宽度，px>0 即展开', () => {
    const frame = buildFrame(508, 1440)
    expect(readRightbarTrack()).toEqual({ shown: true, px: 508, viewport: 1440 })
    setTrack(frame, 0)
    expect(readRightbarTrack()).toEqual({ shown: false, px: 0, viewport: 1440 })
  })

  it('中列的 minmax(400px, 1fr) 不参与；形状不符返回 undefined', () => {
    buildFrame(508, 1440)
    expect(readRightbarTrack()).toBeDefined()
    const frame = document.querySelector('[data-rightbar-col]')!.parentElement! as HTMLElement
    // jsdom 的 cssstyle 会忽略非法值并保留旧值，所以清空而不是赋 'bogus'。
    frame.style.gridTemplateColumns = ''
    expect(readRightbarTrack()).toBeUndefined()
    expect(readRightbarTrack(document.implementation.createHTMLDocument('x'))).toBeUndefined()
  })
})

describe('rightbar width sync（应用与回写）', () => {
  it('展开跳变（无轨道→有轨道）按配置占比应用一次宽度', async () => {
    const frame = buildFrame(0, 1800)
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      await pulse(frame) // 基线：收起
      expect(fixture.setRightbar).not.toHaveBeenCalled()
      setTrack(frame, 648) // 宿主 openRightbar 落的首开偏好
      await pulse(frame)
      // 35% × 1800 = 630：我们的应用覆盖宿主首开默认。
      expect(fixture.setRightbar).toHaveBeenCalledWith(630)
      expect(state.writeRatio).not.toHaveBeenCalled()
    } finally {
      state.dispose()
    }
  })

  it('拖动（shown 期间 px 变化）去抖 800ms 后按 px/viewport 回写', async () => {
    const frame = buildFrame(630, 1800)
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      await pulse(frame) // 基线：展开 630
      setTrack(frame, 900)
      await pulse(frame)
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS - 1)
      expect(state.writeRatio).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(state.writeRatio).toHaveBeenCalledOnce()
      expect(state.writeRatio).toHaveBeenCalledWith(0.5)
    } finally {
      state.dispose()
    }
  })

  it('应用自身触发的 px 变化不产生回写（回写值等于现值时不写）', async () => {
    const frame = buildFrame(0, 1800)
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      await pulse(frame)
      setTrack(frame, 630) // 打开
      await pulse(frame)
      expect(fixture.setRightbar).toHaveBeenCalledWith(630)
      setTrack(frame, 630) // 宿主吸收我们的 setRightbar 后（假 DOM 里同值）
      await pulse(frame)
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS * 2)
      expect(state.writeRatio).not.toHaveBeenCalled()
    } finally {
      state.dispose()
    }
  })

  it('回写前 clamp（0.15–0.7）', async () => {
    const frame = buildFrame(0, 1000)
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      await pulse(frame)
      setTrack(frame, 100) // 0.1 → clamp 0.15
      await pulse(frame)
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS)
      expect(state.writeRatio).toHaveBeenCalledWith(0.15)
    } finally {
      state.dispose()
    }
  })

  it('viewport 变化但 px 不变（resize）不触发回写', async () => {
    const frame = buildFrame(630, 1800)
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      await pulse(frame)
      frame.getBoundingClientRect = () => ({
        width: 1200, height: 900, x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 900,
        toJSON: () => ({}),
      }) as DOMRect
      await pulse(frame)
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS * 2)
      expect(state.writeRatio).not.toHaveBeenCalled()
    } finally {
      state.dispose()
    }
  })

  it('收起取消挂起的回写；dispose 取消挂起的回写', async () => {
    const frame = buildFrame(630, 1800)
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      await pulse(frame)
      setTrack(frame, 900)
      await pulse(frame)
      setTrack(frame, 0) // 拖动后立刻收起
      await pulse(frame)
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS * 2)
      expect(state.writeRatio).not.toHaveBeenCalled()
    } finally {
      state.dispose()
    }

    const frame2 = buildFrame(630, 1800)
    const fixture2 = makeCtx()
    const state2 = harness(fixture2, 0.35)
    await pulse(frame2)
    setTrack(frame2, 900)
    await pulse(frame2)
    state2.dispose()
    vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS * 2)
    expect(state2.writeRatio).not.toHaveBeenCalled()
  })

  it('探测失败全部静默：ctx 抛错 / 缺 setRightbar / 无 DOM 都不抛', async () => {
    const throwingCtx = {
      get: () => { throw new Error('layout absent') },
    } as unknown as Context
    expect(() => createRightbarWidthSync({
      ctx: throwingCtx,
      getRatio: () => 0.35,
      writeRatio: () => {},
    })).not.toThrow()

    // frame 在但 panels.setRightbar 缺：跳变时无从应用，回写照常。
    const frame = buildFrame(0, 1000)
    const bareLayoutCtx = {
      get: (name: string) => (name === 'layout' ? { panels: {} } : undefined),
    } as unknown as Context
    const writeRatio = vi.fn()
    const sync = createRightbarWidthSync({ ctx: bareLayoutCtx, getRatio: () => 0.35, writeRatio })
    try {
      await pulse(frame)
      setTrack(frame, 648)
      await pulse(frame)
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS)
      expect(writeRatio).toHaveBeenCalledWith(0.648)
    } finally {
      sync.dispose()
    }

    // 完全无 DOM：sync 读 undefined，保持上一态，不误判。
    document.body.innerHTML = ''
    const writeRatio2 = vi.fn()
    const sync2 = createRightbarWidthSync({
      ctx: makeCtx().ctx,
      getRatio: () => 0.35,
      writeRatio: writeRatio2,
    })
    try {
      vi.advanceTimersByTime(WRITE_BACK_DEBOUNCE_MS * 3)
      expect(writeRatio2).not.toHaveBeenCalled()
    } finally {
      sync2.dispose()
    }
  })

  it('frame 迟到（激活早于宿主渲染）：轮询挂锚后接管，之后属性变更自动驱动', async () => {
    document.body.innerHTML = '' // 创建时无 frame → 轮询
    const fixture = makeCtx()
    const state = harness(fixture, 0.35)
    try {
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      const frame = buildFrame(0, 1800) // 宿主渲染出来了
      vi.advanceTimersByTime(500) // 挂锚 + 基线；轮询停
      expect(fixture.setRightbar).not.toHaveBeenCalled()
      setTrack(frame, 648)
      await pulse(frame) // 挂锚后由 observer 驱动
      expect(fixture.setRightbar).toHaveBeenCalledWith(630)
      // 轮询已停：不再有 500ms 节拍计时器（只剩可能的回写计时）。
      vi.advanceTimersByTime(500)
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1) // 回写计时器（若有）
    } finally {
      state.dispose()
    }
  })
})
