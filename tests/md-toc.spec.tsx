/**
 * MdToc spec: the markdown preview's outline button + popover. Covers the
 * minimum-headings gate, collection from the rendered DOM (including headings
 * inside HTML `<details>` runs, which appear late through the observer),
 * jump behavior (smooth scroll + flash + auto-expanding collapsed ancestors)
 * and Esc-to-close. The 「固定展开」 describes add the plugin-global pin:
 * button gating, toggle + persist, preference seeding, pinned immovability,
 * the outline button's unpin-and-collapse and cross-instance sync; the
 * 「滚动跟随」 describe mocks layout rects onto the jsdom tree to assert the
 * active-entry computation and the panel's own centering scroll.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdToc, TOC_MIN_HEADINGS } from '../src/client/md-toc.tsx'

// The act() environment flag (React 18.2 reads it before flushing effects).
import { setupReactAct } from './test-utils.ts'
setupReactAct()

const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

// The pin store seeds itself through the real api module and the toggle
// persists through a PrefsWriter — both need a mock: jsdom has no settings
// route, and the specs asserting the persisted patch want a recording wire.
// Defaults answer an empty document and accept every write; the seed spec
// overrides settingsGet's reply.
vi.mock('../src/client/api.ts', () => ({
  api: {
    settingsGet: vi.fn(async () => ({ value: {}, revision: 1 })),
    settingsUpdate: vi.fn(async () => ({ value: {}, revision: 2 })),
  },
}))

import { api } from '../src/client/api.ts'
import { resetMdTocPinStoreForTests } from '../src/client/md-toc-pin.ts'
import { t } from '../src/client/locales.ts'

/** The preview-harness shape MdToc mounts in: the bar is a direct child of
 *  the scroll container, headings are siblings (inside or outside details). */
interface HeadingSpec {
  tag: string
  text: string
  insideClosedDetails?: boolean
}

function Harness({ specs }: { specs: readonly HeadingSpec[] }): React.ReactElement {
  return createElement(
    'div',
    null,
    createElement(MdToc),
    ...specs.map((spec) => spec.insideClosedDetails === true
      ? createElement('details', null, createElement(spec.tag, null, spec.text))
      : createElement(spec.tag, null, spec.text)),
  )
}

/** Render the harness; returns the scroll container (the bar's parent). */
async function mountToc(specs: readonly HeadingSpec[]): Promise<{ container: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(Harness, { specs }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  const container = host.firstElementChild as HTMLDivElement
  return { container, root }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

beforeEach(() => {
  // The pin store is module-global: every spec starts from the pristine
  // store, and the api mocks from their default documents.
  resetMdTocPinStoreForTests()
  document.body.innerHTML = ''
  scrollIntoView.mockClear()
  vi.mocked(api.settingsGet).mockClear()
  vi.mocked(api.settingsGet).mockImplementation(async () => ({ value: {}, revision: 1 }))
  vi.mocked(api.settingsUpdate).mockClear()
  vi.mocked(api.settingsUpdate).mockImplementation(async () => ({ value: {}, revision: 2 }))
})

describe('MdToc', () => {
  it('exposes the minimum-headings threshold', () => {
    expect(TOC_MIN_HEADINGS).toBe(3)
  })

  it('stays hidden below the heading threshold', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'One' },
      { tag: 'h2', text: 'Two' },
    ])
    expect(container.querySelector('[data-dsh-md-toc]')).toBeNull()
    await unmount(root)
  })

  it('shows the button and lists collected headings', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'Install' },
      { tag: 'h2', text: 'Usage' },
      { tag: 'h3', text: 'Deep' },
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
    const panel = container.querySelector('[data-dsh-md-toc-panel]')
    expect(panel).not.toBeNull()
    const items = [...panel!.querySelectorAll('button')]
    expect(items.map((item) => item.textContent)).toEqual(['1Title', '2Install', '2Usage', '3Deep'])
    await unmount(root)
  })

  it('jumps: expands collapsed details ancestors, smooth-scrolls, flashes, closes', async () => {
    // Mount with real timers (the settle await needs them), then fake only the
    // flash-removal timeout window.
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'Outside' },
      { tag: 'h3', text: 'Hidden', insideClosedDetails: true },
    ])
    vi.useFakeTimers()
    try {
      const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
      await act(async () => { button.click() })
      const target = [...container.querySelectorAll('h3')].find((h) => h.textContent === 'Hidden')!
      const item = [...container.querySelectorAll<HTMLButtonElement>('[data-dsh-md-toc-panel] button')]
        .find((candidate) => candidate.textContent?.includes('Hidden'))!
      await act(async () => { item.click() })
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
      expect(target.closest('details')?.hasAttribute('open'), 'the collapsed ancestor must open').toBe(true)
      expect(target.className, 'the jumped-to heading must flash').not.toBe('')
      expect(container.querySelector('[data-dsh-md-toc-panel]'), 'the panel must close on jump').toBeNull()
      vi.advanceTimersByTime(1300)
      expect(target.className, 'the flash class must clear after the timeout').toBe('')
      await unmount(root)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collects headings that appear after mount (observer path)', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'Only two so far' },
    ])
    expect(container.querySelector('[data-dsh-md-toc]')).toBeNull()
    const late = document.createElement('h2')
    late.textContent = 'Late'
    await act(async () => {
      container.appendChild(late)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    expect(container.querySelector('[data-dsh-md-toc]'), 'late headings must surface the button').not.toBeNull()
    await unmount(root)
  })

  it('closes the popover on Escape', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'A' },
      { tag: 'h2', text: 'B' },
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
    await act(async () => { button.click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).toBeNull()
    await unmount(root)
  })

  it('closes the popover when a pointerdown lands outside the button and panel', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'A' },
      { tag: 'h2', text: 'B' },
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
    await act(async () => { button.click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).not.toBeNull()
    // A press on a heading that sits in the scroll container (a sibling of the
    // TOC bar) is "blank space" to the outline: it must dismiss the popover.
    const heading = container.querySelector('h2')!
    await act(async () => {
      heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 'outside press must close the panel').toBeNull()
    await unmount(root)
  })

  it('keeps the toggle working: a press inside the bar does not dismiss, a click re-closes', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'A' },
      { tag: 'h2', text: 'B' },
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
    await act(async () => { button.click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).not.toBeNull()
    // A pointerdown on the toggle itself must not be swallowed by the dismiss
    // handler (the button re-enables pointer events inside the pointer-events:
    // none bar), so the subsequent click still toggles it closed.
    await act(async () => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 'press on the toggle must not dismiss').not.toBeNull()
    await act(async () => { button.click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 're-clicking the toggle must close').toBeNull()
    await unmount(root)
  })
})

/* ------------------------------------------------------------------ *
 * 「固定展开」— the plugin-global tocPinned store behind the pin
 * button. Selections go through data attributes: the CSS-module class
 * names are hashed under vitest's unprocessed css.
 * ------------------------------------------------------------------ */

/** The pin button of one container (data-pinned/aria-pressed are unique). */
function pinButtonIn(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-pinned]')!
}

/** Run the seed read / prefs-writer microtask chain under act(). */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

/** The persisted writes issued since the settingsUpdate mock was cleared. */
function persistedWrites(): ReadonlyArray<Record<string, unknown>> {
  return vi.mocked(api.settingsUpdate).mock.calls.map((call) => call[0]!)
}

/** Two-instance harness: each MdToc sits in its own scroll container. */
function MultiHarness({ instances }: { instances: readonly (readonly HeadingSpec[])[] }): React.ReactElement {
  return createElement(
    'div',
    null,
    instances.map((specs, index) => createElement(
      'div',
      { key: index },
      createElement(MdToc),
      ...specs.map((spec) => spec.insideClosedDetails === true
        ? createElement('details', null, createElement(spec.tag, null, spec.text))
        : createElement(spec.tag, null, spec.text)),
    )),
  )
}

/** Mount several MdToc previews; returns their scroll containers. */
async function mountTocs(instances: readonly (readonly HeadingSpec[])[]): Promise<{ containers: HTMLDivElement[]; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(MultiHarness, { instances }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  const containers = [...(host.firstElementChild as HTMLDivElement).children] as HTMLDivElement[]
  return { containers, root }
}

describe('MdToc pin (固定展开)', () => {
  /** Just past the TOC_MIN_HEADINGS gate. */
  const gated: readonly HeadingSpec[] = [
    { tag: 'h1', text: 'Title' },
    { tag: 'h2', text: 'A' },
    { tag: 'h2', text: 'B' },
  ]

  it('shows the pin button, initially unpinned, at the heading threshold', async () => {
    const { container, root } = await mountToc(gated)
    const pin = pinButtonIn(container)
    expect(pin, 'three headings pass the gate').not.toBeNull()
    expect(pin.dataset.pinned).toBe('false')
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    expect(pin.getAttribute('aria-label'), 'the resting copy is the pin copy').toBe(t('tocPin'))
    await unmount(root)
  })

  it('hides both the pin and the outline button below the heading threshold', async () => {
    const { container, root } = await mountToc(gated.slice(0, 2))
    expect(container.querySelector('[data-pinned]')).toBeNull()
    expect(container.querySelector('[data-dsh-md-toc]')).toBeNull()
    await unmount(root)
  })

  it('pinning expands the panel immediately and persists tocPinned: true', async () => {
    const { container, root } = await mountToc(gated)
    expect(container.querySelector('[data-dsh-md-toc-panel]')).toBeNull()
    vi.mocked(api.settingsUpdate).mockClear()
    await act(async () => { pinButtonIn(container).click() })
    const pin = pinButtonIn(container)
    expect(pin.dataset.pinned).toBe('true')
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    expect(
      container.querySelector('[data-dsh-md-toc-panel]'),
      'the panel must open in the same tick as the pin',
    ).not.toBeNull()
    await flushAsync()
    const writes = persistedWrites()
    expect(writes, 'exactly one persisted write').toHaveLength(1)
    expect(writes[0]).toEqual({ tocPinned: true })
    await unmount(root)
  })

  it('seeds the persisted pin once per page load: a fresh mount starts expanded', async () => {
    vi.mocked(api.settingsGet).mockResolvedValue({ value: { tocPinned: true }, revision: 5 })
    const first = await mountToc(gated)
    await flushAsync()
    expect(
      first.container.querySelector('[data-dsh-md-toc-panel]'),
      'the seeded store must expand the panel without a click',
    ).not.toBeNull()
    expect(pinButtonIn(first.container).dataset.pinned).toBe('true')
    // The module-level promise guard: a second mount shares the ONE read.
    const second = await mountToc(gated)
    await flushAsync()
    expect(second.container.querySelector('[data-dsh-md-toc-panel]')).not.toBeNull()
    expect(vi.mocked(api.settingsGet), 'the seed read must happen exactly once').toHaveBeenCalledTimes(1)
    await unmount(first.root)
    await unmount(second.root)
  })

  it('a pinned panel survives Esc, an outside pointerdown and a jump', async () => {
    const { container, root } = await mountToc(gated)
    await act(async () => { pinButtonIn(container).click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 'Esc must not collapse a pinned panel').not.toBeNull()
    await act(async () => {
      container.querySelector('h2')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 'an outside press must not collapse a pinned panel').not.toBeNull()
    const item = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc-panel] button')!
    await act(async () => { item.click() })
    expect(scrollIntoView).toHaveBeenCalled()
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 'a jump must not collapse a pinned panel').not.toBeNull()
    expect(pinButtonIn(container).dataset.pinned).toBe('true')
    await unmount(root)
  })

  it('the outline button in the pinned state unpins and collapses', async () => {
    const { container, root } = await mountToc(gated)
    await act(async () => { pinButtonIn(container).click() })
    await flushAsync()
    vi.mocked(api.settingsUpdate).mockClear()
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!.click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]'), 'the panel must collapse with the unpin').toBeNull()
    const pin = pinButtonIn(container)
    expect(pin.dataset.pinned).toBe('false')
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    await flushAsync()
    const writes = persistedWrites()
    expect(writes, 'exactly one persisted write').toHaveLength(1)
    expect(writes[0]).toEqual({ tocPinned: false })
    await unmount(root)
  })

  it('syncs one pin across every mounted instance', async () => {
    const { containers, root } = await mountTocs([gated, gated])
    expect(containers, 'two independent previews').toHaveLength(2)
    expect(containers[0]!.querySelector('[data-dsh-md-toc-panel]')).toBeNull()
    expect(containers[1]!.querySelector('[data-dsh-md-toc-panel]')).toBeNull()
    vi.mocked(api.settingsUpdate).mockClear()
    await act(async () => { pinButtonIn(containers[0]!).click() })
    for (const container of containers) {
      expect(container.querySelector('[data-dsh-md-toc-panel]'), 'the peer preview must follow the pin').not.toBeNull()
      expect(pinButtonIn(container).dataset.pinned).toBe('true')
    }
    await flushAsync()
    const writes = persistedWrites()
    expect(writes, 'the toggling instance alone persists').toHaveLength(1)
    expect(writes[0]).toEqual({ tocPinned: true })
    await unmount(root)
  })
})

/* ------------------------------------------------------------------ *
 * 「滚动跟随」— the active-entry computation and the panel's own
 * centering scroll, driven against mocked layout rects (jsdom has no
 * layout). The scroll listener recomputes once per animation frame;
 * vitest's jsdom runs real rAF, so each dispatch awaits one frame.
 * ------------------------------------------------------------------ */

describe('MdToc scroll follow (滚动跟随)', () => {
  /** Four entries whose document-space tops (px) are {@link docTops}. */
  const four: readonly HeadingSpec[] = [
    { tag: 'h1', text: 'One' },
    { tag: 'h2', text: 'Two' },
    { tag: 'h2', text: 'Three' },
    { tag: 'h3', text: 'Four' },
  ]
  const docTops = [10, 50, 150, 500]
  const CONTAINER_HEIGHT = 300
  const CONTAINER_SCROLL = 1200
  const PANEL_HEIGHT = 200
  const ITEM_HEIGHT = 20
  const ITEM_TOPS = [100, 140, 180, 220]

  /** Own-property layout metric (jsdom's prototype getters read as 0). */
  function stubMetric(el: Element, key: 'scrollTop' | 'clientHeight' | 'scrollHeight' | 'offsetTop' | 'offsetHeight', value: number): void {
    Object.defineProperty(el, key, { value, writable: true, configurable: true })
  }

  /** A non-zero rect whose viewport top is `top` (zero rects read hidden). */
  function stubRectTop(el: Element, top: number): void {
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: (): DOMRect => ({ x: 0, y: top, width: 800, height: 24, top, right: 800, bottom: top + 24, left: 0, toJSON: () => ({}) }) as DOMRect,
      configurable: true,
    })
  }

  interface FollowRig {
    container: HTMLDivElement
    panel: HTMLDivElement
    items: HTMLButtonElement[]
    headings: Element[]
    /** Jump the mocked scroll position and heading rects in one step. */
    scrollTo(top: number): void
    root: Root
  }

  /** Mount four headings, mock the layout, open the panel (arms follow). */
  async function mountFollowRig(): Promise<FollowRig> {
    const mounted = await mountToc(four)
    const { container, root } = mounted
    const headings = [...container.querySelectorAll('h1, h2, h3')]
    stubMetric(container, 'clientHeight', CONTAINER_HEIGHT)
    stubMetric(container, 'scrollHeight', CONTAINER_SCROLL)
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: (): DOMRect => ({ x: 0, y: 0, width: 800, height: CONTAINER_HEIGHT, top: 0, right: 800, bottom: CONTAINER_HEIGHT, left: 0, toJSON: () => ({}) }) as DOMRect,
      configurable: true,
    })
    const scrollTo = (top: number): void => {
      stubMetric(container, 'scrollTop', top)
      headings.forEach((el, index) => { stubRectTop(el, docTops[index]! - top) })
    }
    scrollTo(0)
    // Opening the popover expands the panel, which arms the scroll-follow
    // listener; the arm-time recompute runs against the mocked layout above.
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!.click() })
    const panel = container.querySelector<HTMLDivElement>('[data-dsh-md-toc-panel]')!
    stubMetric(panel, 'clientHeight', PANEL_HEIGHT)
    stubMetric(panel, 'scrollTop', 0)
    const items = [...panel.querySelectorAll<HTMLButtonElement>('button')]
    expect(items).toHaveLength(4)
    items.forEach((item, index) => {
      stubMetric(item, 'offsetTop', ITEM_TOPS[index]!)
      stubMetric(item, 'offsetHeight', ITEM_HEIGHT)
    })
    return { container, panel, items, headings, scrollTo, root }
  }

  /** Fire one scroll event and let the rAF-throttled recompute run. */
  async function scrollOneFrame(container: HTMLElement): Promise<void> {
    await act(async () => {
      container.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => { requestAnimationFrame(resolve) })
    })
  }

  it('follows the scroll: the entry under the threshold line goes active and the panel centers it', async () => {
    const rig = await mountFollowRig()
    // Line = container top + max(clientHeight/3, 72) = 100. At scrollTop 0
    // the tops are 10/50/150/500: Two (50) is the last one above the line.
    expect(rig.items.map((item) => item.dataset.active)).toEqual(['false', 'true', 'false', 'false'])
    rig.scrollTo(120)
    // Tops become -110/-70/30/380: Three (30) is the last above the line,
    // and 120 + 300 is far from the 1198 bottom, so the bottom rule is off.
    await scrollOneFrame(rig.container)
    expect(rig.items.map((item) => item.dataset.active)).toEqual(['false', 'false', 'true', 'false'])
    // centerPanelItem: item.offsetTop - (panel.clientHeight - item.offsetHeight) / 2
    //               = 180 - (200 - 20) / 2 = 90
    expect(rig.panel.scrollTop, 'the active entry must ride the panel middle').toBe(90)
    await unmount(rig.root)
  })

  it('forces the last entry active at the bottom of the scroll', async () => {
    const rig = await mountFollowRig()
    // 900 + 300 >= 1200 - 2: the bottom rule. Four keeps a rect BELOW the
    // line so only the bottom rule can select it.
    rig.scrollTo(900)
    stubRectTop(rig.headings[3]!, 500)
    await scrollOneFrame(rig.container)
    expect(rig.items.map((item) => item.dataset.active)).toEqual(['false', 'false', 'false', 'true'])
    await unmount(rig.root)
  })
})
