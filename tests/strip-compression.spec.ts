// @vitest-environment jsdom
/**
 * The host tab-strip adaptive-width patch (src/client/native/strip-compression.ts):
 * `registerStripCompression` injects ONE tagged stylesheet into document.head
 * for the caller's effect lifetime — a fixed-width `container-type` on the
 * host's strip row (the `cqw` anchor), chip rules that make every chip
 * content-sized and never-shrinking (`flex: 0 0 auto`) under the one `60cqw`
 * extreme ceiling, the thin 6px paddings, and active-chip rules that reserve
 * the host close button's absolute overlay area with real padding and undo
 * the host's active-title fade mask. jsdom has no layout or container
 * queries, so this spec pins the STRING and DOM contract only — never the
 * visual outcome.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { registerStripCompression } from '../src/client/native/strip-compression.ts'
import type { Context } from '../src/context-types.ts'

/** The patch's injected tag(s) currently in the head. */
const injected = (): HTMLElement[] =>
  [...document.head.querySelectorAll<HTMLElement>('style[data-dsh-strip-compression]')]

afterEach(() => {
  for (const tag of injected()) tag.remove()
})

describe('registerStripCompression', () => {
  it('injects one tagged style tag into document.head', () => {
    const dispose = registerStripCompression({} as Context)
    try {
      const tags = injected()
      expect(tags).toHaveLength(1)
      expect(tags[0]!.getAttribute('data-dsh-strip-compression')).toBe('')
      expect(tags[0]!.parentElement).toBe(document.head)
    } finally {
      dispose()
    }
  })

  it('puts container-type on the strip row and the content-adaptive chip rules on the tabs row', () => {
    const dispose = registerStripCompression({} as Context)
    try {
      const text = injected()[0]!.textContent ?? ''
      // The container MUST be the fixed-width strip row...
      expect(text).toMatch(/\[data-dockkit-strip\]\s*\{\s*container-type:\s*inline-size;?\s*\}/)
      // ...never the flex tabs row: containing it would size the row to zero.
      expect(text).not.toMatch(/\[data-dockkit-strip-tabs\][^{]*\{[^}]*container-type/)
      // The chip rule is content-adaptive + scroll: the `auto` basis sizes the
      // chip to its full title and `flex-shrink: 0` retires the squeeze — no
      // `min-width` tier may come back (the old `min-width: 0` is what let a
      // chip degrade to its glyph).
      const chipRule = text.match(/\[data-dockkit-strip-tabs\]\s+\[data-dockkit-tab\]\s*\{([^}]*)\}/)
      expect(chipRule).not.toBeNull()
      expect(chipRule![1]).toMatch(/flex:\s*0\s+0\s+auto/)
      expect(chipRule![1]).not.toMatch(/min-width/)
      // The ONE extreme ceiling is in container units against the strip row,
      // so a pathological title cannot own the whole row.
      expect(chipRule![1]).toMatch(/max-width:\s*60cqw/)
      expect(chipRule![1]).toMatch(/padding-left:\s*6px/)
      expect(chipRule![1]).toMatch(/padding-right:\s*6px/)
    } finally {
      dispose()
    }
  })

  it('reserves the active closable chip\'s close-button area and undoes its title fade mask outside the container query', () => {
    const dispose = registerStripCompression({} as Context)
    try {
      const text = injected()[0]!.textContent ?? ''
      // The ACTIVE closable chip reserves the absolutely positioned ×'s
      // overlay area with REAL padding: 20px button + 4px `right` offset.
      // Quiet chips (a single unclosable tab) render no × and stay compact.
      const paddingRule = text.match(
        /\[data-dockkit-tab\]\[aria-selected="true"\]:not\(\[data-dockkit-tab-quiet\]\)\s*\{([^}]*)\}/,
      )
      expect(paddingRule, 'the active-chip padding rule must exist').not.toBeNull()
      expect(paddingRule![1]).toMatch(/padding-right:\s*24px/)
      // With the × area reserved by real padding, the host's active fade
      // mask would only keep erasing the trailing title glyphs — undo it,
      // except where the host flags a genuinely clipped title.
      const maskRule = text.match(
        /:not\(\[data-dockkit-tab-quiet\]\)\s*>\s*\[data-dockkit-tab-title\]:not\(\[data-dockkit-tab-clipped\]\)\s*\{([^}]*)\}/,
      )
      expect(maskRule, 'the active-title mask rule must exist').not.toBeNull()
      expect(maskRule![1]).toMatch(/mask-image:\s*none/)
      // Both rules are unconditional layout fixes — the old ≤480px hide-icon
      // container query is gone with the compression semantics: full titles
      // at every column width, the row scrolls instead.
      expect(text, 'no container query may remain').not.toContain('@container')
      expect(text).toContain('[data-dockkit-tab][aria-selected="true"]:not([data-dockkit-tab-quiet]) { padding-right: 24px; }')
      expect(text).toContain('> [data-dockkit-tab-title]:not([data-dockkit-tab-clipped]) { mask-image: none; }')
    } finally {
      dispose()
    }
  })

  it('keeps the compression tiers out of the adaptive patch', () => {
    const dispose = registerStripCompression({} as Context)
    try {
      const text = injected()[0]!.textContent ?? ''
      // No icon-hiding container query (the "icon-only" degradation) and no
      // shrinking of any kind: the patch's contract is full titles + the
      // host's own overflow-x scroll.
      expect(text).not.toContain('@container')
      expect(text).not.toContain('display: none')
      expect(text).not.toContain('min-width')
    } finally {
      dispose()
    }
  })

  it('removes the tag on dispose and tolerates a second call', () => {
    const dispose = registerStripCompression({} as Context)
    expect(injected()).toHaveLength(1)
    dispose()
    expect(injected()).toHaveLength(0)
    expect(() => { dispose() }).not.toThrow()
    expect(injected()).toHaveLength(0)
  })
})
