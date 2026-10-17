// @vitest-environment jsdom
/**
 * The host tab-strip compression patch (src/client/native/strip-compression.ts):
 * `registerStripCompression` injects ONE tagged stylesheet into document.head
 * for the caller's effect lifetime — a fixed-width `container-type` on the
 * host's strip row, chip rules that undo the host's 80px min-width floor and
 * thin the padding, and a ≤480px container query that hides the plugin's own
 * decorative chip glyph (its class hash comes from the same
 * sidebar.module.css the chip renders with), and active-chip rules that
 * reserve the host close button's absolute overlay area with real padding
 * and undo the host's active-title fade mask. jsdom has no layout or
 * container queries, so this spec pins the STRING and DOM contract only —
 * never the visual outcome.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { registerStripCompression } from '../src/client/native/strip-compression.ts'
import css from '../src/client/sidebar.module.css'
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

  it('puts container-type on the strip row and the chip min-width/padding rules on the tabs row', () => {
    const dispose = registerStripCompression({} as Context)
    try {
      const text = injected()[0]!.textContent ?? ''
      // The container MUST be the fixed-width strip row...
      expect(text).toMatch(/\[data-dockkit-strip\]\s*\{\s*container-type:\s*inline-size;?\s*\}/)
      // ...never the flex tabs row: containing it would size the row to zero.
      expect(text).not.toMatch(/\[data-dockkit-strip-tabs\][^{]*\{[^}]*container-type/)
      // The chip rule undoes the host's 80px floor and thins both paddings.
      const chipRule = text.match(/\[data-dockkit-strip-tabs\]\s+\[data-dockkit-tab\]\s*\{([^}]*)\}/)
      expect(chipRule).not.toBeNull()
      expect(chipRule![1]).toMatch(/min-width:\s*0/)
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
      // Both rules are unconditional layout fixes and sit BEFORE the
      // @container block — the small-column query stays icon-only.
      const containerStart = text.indexOf('@container')
      expect(containerStart).toBeGreaterThan(0)
      expect(text.slice(0, containerStart)).toContain('[data-dockkit-tab][aria-selected="true"]:not([data-dockkit-tab-quiet]) { padding-right: 24px; }')
      expect(text.slice(0, containerStart)).toContain('> [data-dockkit-tab-title]:not([data-dockkit-tab-clipped]) { mask-image: none; }')
      expect(text.slice(containerStart), 'no active-tab rules inside @container').not.toContain('aria-selected')
    } finally {
      dispose()
    }
  })

  it('hides the css-module-hashed chip icon inside the ≤480px container query', () => {
    const dispose = registerStripCompression({} as Context)
    try {
      const text = injected()[0]!.textContent ?? ''
      const block = text.match(/@container \(max-width: 480px\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? ''
      expect(block, 'the @container block must exist').not.toBe('')
      // The selector carries the class hash from the SAME module the chip
      // renders with, so dev and built bundle agree on the name.
      expect(block).toContain(String(css.chipIcon))
      expect(block).toMatch(new RegExp(`\\.${String(css.chipIcon)}\\s*\\{\\s*display:\\s*none`))
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
