// @vitest-environment jsdom
/**
 * Host strip wheel-scroll tests (src/client/native/strip-wheel.ts): a plain
 * mouse wheel over the host tab row emits deltaY, which the row's horizontal
 * scrollport (`overflow-x: auto`, hidden scrollbar) never consumes — the
 * delegated document listener translates it into horizontal scrolling. It
 * must consume the event ONLY over a `[data-dockkit-strip-tabs]` row that
 * actually overflows (else the page scrolls normally), must leave
 * modifier-key gestures to the browser (shift = native horizontal scroll,
 * ctrl/cmd = zoom), must reach the strip from any descendant (delegation via
 * `closest`), must cover several strip instances at once, and must scale
 * deltaMode lines/pages like the browser would. jsdom has no layout, so the
 * scrollport geometry is stubbed like tab-bar-wheel.spec.tsx does.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { Context } from '../src/context-types.ts'
import { registerStripWheel } from '../src/client/native/strip-wheel.ts'

/** Mount a fake host strip (with one chip child) and stub its geometry. */
function mountStrip(overflow: boolean): { strip: HTMLElement; chip: HTMLElement } {
  const strip = document.createElement('div')
  strip.setAttribute('data-dockkit-strip-tabs', '')
  const chip = document.createElement('div')
  chip.setAttribute('data-dockkit-tab', '')
  strip.append(chip)
  document.body.append(strip)
  // jsdom has no layout: stub the scrollport geometry to simulate overflow.
  Object.defineProperty(strip, 'scrollWidth', { value: overflow ? 600 : 200, configurable: true })
  Object.defineProperty(strip, 'clientWidth', { value: 200, configurable: true })
  return { strip, chip }
}

/** Dispatch a wheel event on a node and return it (defaultPrevented read). */
function wheel(node: Element, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init })
  node.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('registerStripWheel', () => {
  it('translates a vertical wheel delta into scrollLeft when the strip overflows', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip, chip } = mountStrip(true)
      strip.scrollLeft = 0
      // Fired on the CHIP, not the strip: proves the delegated listener
      // reaches the strip through `closest` from any descendant.
      const event = wheel(chip, { deltaY: 120 })
      expect(event.defaultPrevented).toBe(true)
      expect(strip.scrollLeft).toBe(120)
    } finally {
      dispose()
    }
  })

  it('scrolls left for a negative delta', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip } = mountStrip(true)
      strip.scrollLeft = 500
      const event = wheel(strip, { deltaY: -80 })
      expect(event.defaultPrevented).toBe(true)
      expect(strip.scrollLeft).toBe(420)
    } finally {
      dispose()
    }
  })

  it('does not consume the event when the strip does not overflow', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip } = mountStrip(false)
      strip.scrollLeft = 0
      const event = wheel(strip, { deltaY: 120 })
      expect(event.defaultPrevented).toBe(false)
      expect(strip.scrollLeft).toBe(0)
    } finally {
      dispose()
    }
  })

  it('leaves modifier-key gestures to the browser', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip } = mountStrip(true)
      strip.scrollLeft = 0
      const ctrl = wheel(strip, { deltaY: 120, ctrlKey: true })
      const shift = wheel(strip, { deltaY: 120, shiftKey: true })
      const meta = wheel(strip, { deltaY: 120, metaKey: true })
      const alt = wheel(strip, { deltaY: 120, altKey: true })
      expect(ctrl.defaultPrevented).toBe(false)
      expect(shift.defaultPrevented).toBe(false)
      expect(meta.defaultPrevented).toBe(false)
      expect(alt.defaultPrevented).toBe(false)
      expect(strip.scrollLeft).toBe(0)
    } finally {
      dispose()
    }
  })

  it('never touches wheel events outside a host strip', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      mountStrip(true)
      const outside = document.createElement('div')
      document.body.append(outside)
      Object.defineProperty(outside, 'scrollWidth', { value: 600, configurable: true })
      Object.defineProperty(outside, 'clientWidth', { value: 200, configurable: true })
      outside.scrollLeft = 0
      const event = wheel(outside, { deltaY: 120 })
      expect(event.defaultPrevented).toBe(false)
      expect(outside.scrollLeft).toBe(0)
    } finally {
      dispose()
    }
  })

  it('covers several strip instances with the one listener', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const a = mountStrip(true)
      const b = mountStrip(true)
      a.strip.scrollLeft = 0
      b.strip.scrollLeft = 0
      const ea = wheel(a.chip, { deltaY: 100 })
      const eb = wheel(b.strip, { deltaY: 50 })
      expect(ea.defaultPrevented).toBe(true)
      expect(eb.defaultPrevented).toBe(true)
      expect(a.strip.scrollLeft).toBe(100)
      expect(b.strip.scrollLeft).toBe(50)
    } finally {
      dispose()
    }
  })

  it('scales line-mode deltas by 16px per line', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip } = mountStrip(true)
      strip.scrollLeft = 0
      const event = wheel(strip, { deltaY: 3, deltaMode: 1 })
      expect(event.defaultPrevented).toBe(true)
      expect(strip.scrollLeft).toBe(48)
    } finally {
      dispose()
    }
  })

  it('scales page-mode deltas by the scrollport width', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip } = mountStrip(true)
      strip.scrollLeft = 0
      const event = wheel(strip, { deltaY: 2, deltaMode: 2 })
      expect(event.defaultPrevented).toBe(true)
      expect(strip.scrollLeft).toBe(400)
    } finally {
      dispose()
    }
  })

  it('adds a horizontal trackpad delta to the scroll', () => {
    const dispose = registerStripWheel({} as Context)
    try {
      const { strip } = mountStrip(true)
      strip.scrollLeft = 0
      const event = wheel(strip, { deltaX: 40 })
      expect(event.defaultPrevented).toBe(true)
      expect(strip.scrollLeft).toBe(40)
    } finally {
      dispose()
    }
  })

  it('stops intercepting after dispose', () => {
    const dispose = registerStripWheel({} as Context)
    const { strip } = mountStrip(true)
    strip.scrollLeft = 0
    dispose()
    const event = wheel(strip, { deltaY: 120 })
    expect(event.defaultPrevented).toBe(false)
    expect(strip.scrollLeft).toBe(0)
  })
})
