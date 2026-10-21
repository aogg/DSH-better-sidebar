/**
 * 「历史发送」记录跳转：打开记录所属的会话并滚动定位到那条发送。
 *
 * 打开会话走宿主现成桥：`ctx.get('uiWorkspace')` 的 `openSession(target)`
 * （SessionTarget = SessionId | SubagentAddress，传 sessionId 字符串即可，
 * 与 SubagentView 的 ConversationNavigation 用法一致；宿主契约不动）。
 *
 * 滚动定位（宿主没有消息级锚点动词可用的调查结论，落地为 DOM 兜底）：
 * - openSession 只收会话标识、无锚点参数；uiWorkspace / ISessions 都没有
 *   scrollToMessage 类动词；主视图 conversation 渲染层（dsh-client-ui-chat）
 *   的 `data-chat-anchor-key` 是引擎内部 flowKey，类型层不暴露、wire 记录的
 *   seq 推不回去——没有可优先使用的宿主原生机制。
 * - 兜底：openSession 之后在主聊天 DOM 里定位那条用户消息。宿主渲染层的
 *   稳定钩子是 `[data-conversation-scroll]`（滚动容器）与每行消息的
 *   `[data-chat-flow-key]`（用户消息行 `data-chat-flow-kind="user"`）；
 *   按记录 text 的空白归一前缀匹配行文本（data-* 缺席的老宿主降级为全
 *   元素最深匹配）。等待渲染用 MutationObserver + 250ms 短轮询双保险，
 *   5s 超时后静默放弃（绝无常驻轮询）；定位到就滚动（只滚宿主的
 *   conversation 滚动容器，不惊动外层布局）并短暂高亮后复原。
 * - 找不到/结构不认识：会话已打开（或本就开着），只是不滚动——调用方把
 *   按钮 title 换成「已打开会话」。
 *
 * 记录依据字段就是 HistorySendRecord 现有的 sessionId/text（wire 形状不改）。
 */
import type { Context } from '../context-types.ts'

/** 宿主 uiWorkspace 上本模块消费的面（与 SubagentView 的同名声明一致）。 */
interface ConversationNavigation {
  openSession?(target: unknown): void
}

/** 定位等待上限（跨会话切换后主视图重排的最大等待）。 */
export const HISTORY_JUMP_LOCATE_TIMEOUT_MS = 5000
/** 等待期的短轮询间隔（MutationObserver 的兜底，超时即拆）。 */
export const HISTORY_JUMP_POLL_INTERVAL_MS = 250
/** 高亮停留时长（到点复原行内样式）。 */
export const HISTORY_JUMP_HIGHLIGHT_MS = 2600
/** 匹配用的文本前缀长度（归一后截断；长提示词足够唯一且抗截断渲染差异）。 */
export const HISTORY_JUMP_NEEDLE_CHARS = 160

/** 跳转结果：located=已滚动定位；opened=会话已打开但没滚动到；unavailable=跨会话且宿主桥缺席。 */
export type HistoryJumpOutcome = 'located' | 'opened' | 'unavailable'

/** 打开记录所属会话（宿主桥）。@returns 是否真的发起了打开。 */
export function openHistorySession(ctx: Context | undefined, sessionId: string): boolean {
  if (ctx === undefined || sessionId === '') return false
  try {
    const workspace = ctx.get('uiWorkspace') as unknown as ConversationNavigation | undefined
    if (typeof workspace?.openSession === 'function') {
      workspace.openSession(sessionId)
      return true
    }
  } catch {
    // 宿主桥抛错按缺席处理（至少不滚动，绝不冒泡）。
  }
  return false
}

/** 空白归一（DOM textContent 与 wire 文本的换行/缩进差异都抹平）。 */
export function normalizeForHistoryMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 记录文本 → 匹配用前缀（归一 + 截断 + 小写不区分大小写）。 */
export function historyJumpNeedle(recordText: string): string {
  return normalizeForHistoryMatch(recordText).slice(0, HISTORY_JUMP_NEEDLE_CHARS)
}

/** 定位选项（测试注入 doc/win/时长；生产用默认全局）。 */
export interface HistoryLocateOptions {
  doc?: Document
  win?: Window & typeof globalThis
  timeoutMs?: number
  highlightMs?: number
}

/**
 * 在主聊天 DOM 里找到含 needle 的那条用户消息行（纯查询，无副作用）。
 * 优先宿主的稳定 data-* 行（kind=user 的 flow 行 → 任意 flow 行），缺席时
 * 降级为全元素里「文本最短（最深、最具体）的匹配」。找不到返回 undefined。
 */
export function findHistoryRecordRow(needle: string, doc: Document): HTMLElement | undefined {
  if (needle === '') return undefined
  const scrollport = doc.querySelector('[data-conversation-scroll]')
  const root = scrollport ?? doc.body
  if (root === null) return undefined
  // 本插件自己的历史列表（data-dsh-history-view 子树）里也有同样的文本，
  // 整段排除——定位只面向主视图。
  const inSidebar = (element: Element): boolean => element.closest('[data-dsh-history-view]') !== null
  const flowRows = root.querySelectorAll<HTMLElement>('[data-chat-flow-key]')
  if (flowRows.length > 0) {
    const users: HTMLElement[] = []
    const others: HTMLElement[] = []
    for (const row of flowRows) {
      if (inSidebar(row)) continue
      if (row.getAttribute('data-chat-flow-kind') === 'turn-process') continue
      if (!normalizeForHistoryMatch(row.textContent ?? '').includes(needle)) continue
      if (row.getAttribute('data-chat-flow-kind') === 'user') users.push(row)
      else others.push(row)
    }
    if (users.length > 0) return users[0]
    if (others.length > 0) return others[0]
    return undefined
  }
  // 老宿主没有 flow 行 data-*：全元素扫，取文本最短（最具体）的匹配。
  let best: HTMLElement | undefined
  let bestLength = Number.POSITIVE_INFINITY
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (inSidebar(element)) continue
    const text = normalizeForHistoryMatch(element.textContent ?? '')
    if (text === '' || !text.includes(needle)) continue
    if (text.length < bestLength) {
      best = element
      bestLength = text.length
    }
  }
  return best
}

/** 滚动定位：只滚宿主的 conversation 滚动容器；缺容器/滚不动再 scrollIntoView。 */
function scrollRowIntoView(row: HTMLElement, doc: Document): void {
  const scrollport = doc.querySelector('[data-conversation-scroll]')
  if (scrollport !== null) {
    try {
      const rect = row.getBoundingClientRect()
      const portRect = scrollport.getBoundingClientRect()
      const target = scrollport.scrollTop + rect.top - portRect.top - scrollport.clientHeight / 3
      scrollport.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
      return
    } catch {
      // 环境没有 scrollTo（jsdom 等）：落到底部的 scrollIntoView 兜底。
    }
  }
  try {
    row.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  } catch {
    // 滚不动就算了：高亮仍会指出位置。
  }
}

/** 短暂高亮：行内样式上、到点复原（不动宿主样式表）。data-* 标记同步翻转
 *  （测试与诊断读标记，不解析样式串）。 */
function flashHighlight(row: HTMLElement, win: Window & typeof globalThis, ms: number): void {
  const previous = {
    outline: row.style.outline,
    outlineOffset: row.style.outlineOffset,
    borderRadius: row.style.borderRadius,
  }
  row.dataset.dshHistoryHighlight = '1'
  row.style.outline = '2px solid var(--dsw-alias-interactive-focus, var(--dsw-alias-border-l4))'
  row.style.outlineOffset = '-2px'
  row.style.borderRadius = '6px'
  win.setTimeout(() => {
    delete row.dataset.dshHistoryHighlight
    row.style.outline = previous.outline
    row.style.outlineOffset = previous.outlineOffset
    row.style.borderRadius = previous.borderRadius
  }, ms)
}

/**
 * 等主视图渲染出那条消息并滚动定位（一次性等待：MutationObserver + 短轮询
 * 双保险，超时静默放弃）。@returns 是否定位到了。
 */
export function locateHistoryRecord(needle: string, options: HistoryLocateOptions = {}): Promise<boolean> {
  const doc = options.doc ?? document
  const win = options.win ?? window
  const timeoutMs = options.timeoutMs ?? HISTORY_JUMP_LOCATE_TIMEOUT_MS
  const highlightMs = options.highlightMs ?? HISTORY_JUMP_HIGHLIGHT_MS
  return new Promise(resolve => {
    let settled = false
    let observer: MutationObserver | undefined
    let pollTimer: number | undefined
    let timeoutTimer: number | undefined
    const cleanup = (): void => {
      observer?.disconnect()
      observer = undefined
      if (pollTimer !== undefined) win.clearInterval(pollTimer)
      pollTimer = undefined
      if (timeoutTimer !== undefined) win.clearTimeout(timeoutTimer)
      timeoutTimer = undefined
    }
    const settle = (row: HTMLElement | undefined): void => {
      if (settled) return
      settled = true
      cleanup()
      if (row === undefined) {
        resolve(false)
        return
      }
      scrollRowIntoView(row, doc)
      flashHighlight(row, win, highlightMs)
      resolve(true)
    }
    // 立即试一次（会话本就开着/消息已在屏上：不用等）。
    settle(findHistoryRecordRow(needle, doc))
    if (settled) return
    try {
      observer = new win.MutationObserver(() => {
        // 每次变更只做一次轻量查询；找到即拆观察器。
        settle(findHistoryRecordRow(needle, doc))
      })
      observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })
    } catch {
      observer = undefined
    }
    pollTimer = win.setInterval(() => {
      settle(findHistoryRecordRow(needle, doc))
    }, HISTORY_JUMP_POLL_INTERVAL_MS)
    timeoutTimer = win.setTimeout(() => {
      settle(undefined)
    }, timeoutMs)
  })
}

/**
 * 一条发送记录的完整跳转：跨会话先经宿主桥打开目标会话（本会话的记录不开
 * ——主视图已是它），再等渲染并滚动定位。定位失败/宿主桥缺席都静默降级，
 * 结果由调用方换按钮 title。
 */
export async function jumpToHistoryRecord(
  ctx: Context | undefined,
  record: { sessionId: string; text: string },
  currentSessionId: string | undefined,
  options: HistoryLocateOptions = {},
): Promise<HistoryJumpOutcome> {
  const sameSession = record.sessionId !== '' && record.sessionId === currentSessionId
  if (!sameSession) {
    if (!openHistorySession(ctx, record.sessionId)) return 'unavailable'
  }
  const located = await locateHistoryRecord(historyJumpNeedle(record.text), options)
  return located ? 'located' : 'opened'
}
