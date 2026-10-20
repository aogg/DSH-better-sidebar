// @vitest-environment jsdom
/**
 * The「+」stand-in this plugin injects into the HOST tab strip
 * (src/client/native/strip-add-button.ts).
 *
 * The host gates its per-pane + button on "no guide tab in the pane"
 * (`canAddTab: (paneId) => guideIn(…) === void 0`), so while the hero start
 * page occupies a pane the button is absent from the DOM entirely. The
 * stand-in restores it: one button per strip holding ≥1 tab chip and no host
 * +, removed again when the host's own button renders or the last chip goes
 * away. These cases pin the contract at the DOM boundary:
 *   1. registration syncs ONCE synchronously — a strip with one tab and no
 *      host + has its stand-in immediately after `registerStripAddButton`
 *      returns, carrying the host's attribute name with the strip's pane id,
 *      the stand-in marker, the zh copy (navigator.language = 'zh-CN') and
 *      the host's position (right after the tabs row);
 *   2. a click hands the host controller `openTab('guide', { paneId,
 *      revealIfOpened: false })` — the exact call the host's own addTab
 *      makes, so guide re-opens/focuses in THAT pane;
 *   3. the host's own + always wins — once it renders, the stand-in is gone
 *      within one debounced sync (never two + in a row);
 *   4. the last tab chip going away removes the stand-in (an empty pane is
 *      the host's own no-+ state);
 *   5. dispose removes every stand-in and the style tag and stops the
 *      observer — later DOM churn injects nothing;
 *   6. a click never throws — neither when the controller face is missing
 *      (cordis throws without inject) nor when `openTab` itself throws.
 *
 * The fake ctx is the minimal `get` face the module reads; the observer's
 * debounce is async (rAF in vitest's jsdom, setTimeout without frames), so
 * the dynamic cases flush through flushDebounce().
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { registerStripAddButton } from '../src/client/native/strip-add-button.ts'

/** The disposer of the registration under test (disposed again in afterEach). */
let dispose: (() => void) | undefined

/** Point the browser-language fallback at Chinese so the copy asserts. */
function stubZh(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
  })
}

/**
 * Build the host-shaped strip DOM the observer reads: the strip row carries
 * its pane id, a tabs row child holds `tabs` bare tab chips. Appended to
 * document.body, so the MutationObserver sees later edits to it.
 */
function buildStrip(paneId: string, tabs: number): { strip: HTMLElement; tabsRow: HTMLElement } {
  const strip = document.createElement('div')
  strip.setAttribute('data-dockkit-strip', paneId)
  const tabsRow = document.createElement('div')
  tabsRow.setAttribute('data-dockkit-strip-tabs', '')
  for (let index = 0; index < tabs; index += 1) {
    const chip = document.createElement('div')
    chip.setAttribute('data-dockkit-tab', '')
    tabsRow.appendChild(chip)
  }
  strip.appendChild(tabsRow)
  document.body.appendChild(strip)
  return { strip, tabsRow }
}

/** The stand-in button inside `strip`, if one is injected. */
function standInOf(strip: HTMLElement): HTMLButtonElement | null {
  return strip.querySelector<HTMLButtonElement>('[data-dsh-add-tab-standin]')
}

/** The minimal ctx face the module reads: `get('sidebarRight')` → controller. */
function ctxWith(openTab: ((kind: string, options?: unknown) => void) | undefined): Context {
  return {
    get: (id: string) => (id === 'sidebarRight' && openTab !== undefined ? { openTab } : undefined),
  } as unknown as Context
}

/**
 * Flush the observer's debounce: when the environment has frames (vitest's
 * jsdom does), the pending rAF must fire first; the trailing macrotask beat
 * also covers the setTimeout fallback path (environments without rAF).
 */
async function flushDebounce(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
  }
  await new Promise(resolve => { setTimeout(resolve, 25) })
}

/** A native click on `target` (plain DOM listeners, no React involved). */
function click(target: Element): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ''
  for (const tag of [...document.head.querySelectorAll('style[data-dsh-add-button-standin]')]) tag.remove()
  vi.restoreAllMocks()
})

describe('registerStripAddButton', () => {
  it('injects a stand-in + immediately for a strip with one tab and no host button', () => {
    stubZh()
    const { strip, tabsRow } = buildStrip('pane-1', 1)
    dispose = registerStripAddButton(ctxWith(vi.fn()))
    const standIn = standInOf(strip)
    expect(standIn, 'the sync pass at registration must have injected the stand-in').not.toBeNull()
    expect(standIn!.tagName).toBe('BUTTON')
    expect(standIn!.type).toBe('button')
    // The host's own attribute name and value (the strip's pane id)...
    expect(standIn!.getAttribute('data-dockkit-add-tab')).toBe('pane-1')
    // ...the stand-in marker for CSS and dispose...
    expect(standIn!.hasAttribute('data-dsh-add-tab-standin')).toBe(true)
    // ...the host's copy...
    expect(standIn!.getAttribute('aria-label')).toBe('新建标签页')
    expect(standIn!.getAttribute('title')).toBe('新建标签页')
    // ...and the host's position: right after the tabs row.
    expect(standIn!.previousElementSibling).toBe(tabsRow)
    // The look must come from the injected stylesheet, tagged for DevTools.
    const tag = document.head.querySelector('style[data-dsh-add-button-standin]')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toContain('[data-dsh-add-tab-standin]')
    // Token-only colors (guide §12): no hardcoded hex in the rules.
    expect(tag!.textContent).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(tag!.textContent).toContain('var(--dsw-alias-label-secondary)')
    expect(tag!.textContent).toContain('var(--dsw-alias-interactive-bg-hover)')
  })

  it('clicking the stand-in opens guide in that pane through the host controller', () => {
    stubZh()
    const openTab = vi.fn()
    const { strip } = buildStrip('pane-2', 1)
    dispose = registerStripAddButton(ctxWith(openTab))
    click(standInOf(strip)!)
    // The exact call the host's own addTab makes (single-instance guide:
    // re-open resolves to the existing start-page tab and focuses it).
    expect(openTab).toHaveBeenCalledTimes(1)
    expect(openTab).toHaveBeenCalledWith('guide', { paneId: 'pane-2', revealIfOpened: false })
  })

  it('removes the stand-in once the host renders its own + (never two plus buttons)', async () => {
    stubZh()
    const { strip } = buildStrip('pane-3', 1)
    dispose = registerStripAddButton(ctxWith(vi.fn()))
    expect(standInOf(strip)).not.toBeNull()
    // The host's own button appears (anywhere in the strip — the sync only
    // asks "is one there").
    const hostButton = document.createElement('button')
    hostButton.setAttribute('data-dockkit-add-tab', 'pane-3')
    strip.appendChild(hostButton)
    await flushDebounce()
    expect(standInOf(strip)).toBeNull()
    expect(strip.querySelectorAll('[data-dockkit-add-tab]')).toHaveLength(1)
  })

  it('removes the stand-in when the pane\'s last tab chip goes away', async () => {
    stubZh()
    const { strip, tabsRow } = buildStrip('pane-4', 1)
    dispose = registerStripAddButton(ctxWith(vi.fn()))
    expect(standInOf(strip)).not.toBeNull()
    tabsRow.querySelector('[data-dockkit-tab]')!.remove()
    await flushDebounce()
    expect(standInOf(strip)).toBeNull()
  })

  it('dispose removes the stand-in and the style tag and stops future injection', async () => {
    stubZh()
    const { strip } = buildStrip('pane-5', 1)
    dispose = registerStripAddButton(ctxWith(vi.fn()))
    expect(standInOf(strip)).not.toBeNull()
    expect(document.head.querySelectorAll('style[data-dsh-add-button-standin]')).toHaveLength(1)
    dispose()
    dispose = undefined
    expect(standInOf(strip)).toBeNull()
    expect(document.head.querySelectorAll('style[data-dsh-add-button-standin]')).toHaveLength(0)
    // The observer is disconnected: DOM churn afterwards injects nothing.
    const { strip: later } = buildStrip('pane-6', 1)
    await flushDebounce()
    expect(standInOf(later)).toBeNull()
    expect(standInOf(strip)).toBeNull()
  })

  it('a click stays silent when openTab itself throws', () => {
    stubZh()
    const openTab = vi.fn(() => { throw new Error('sidebarRight: no mounted seat') })
    const { strip } = buildStrip('pane-7', 1)
    dispose = registerStripAddButton(ctxWith(openTab))
    expect(() => { click(standInOf(strip)!) }).not.toThrow()
    expect(openTab).toHaveBeenCalledTimes(1)
  })

  it('a click stays silent when the controller face is missing entirely', () => {
    stubZh()
    const { strip } = buildStrip('pane-8', 1)
    // Cordis throws on `ctx.get` of a service without inject — the handler
    // must degrade to a no-op click, not surface the throw.
    dispose = registerStripAddButton({
      get: () => { throw new Error('cannot get "sidebarRight" without inject') },
    } as unknown as Context)
    expect(() => { click(standInOf(strip)!) }).not.toThrow()
  })
})
