// @vitest-environment jsdom
/**
 * The host guide start-page adaptive-grid patch (src/client/native/guide-grid.ts):
 * `registerGuideGrid` injects ONE tagged stylesheet into document.head for the
 * caller's effect lifetime — a static `data-dsh-guide-grid` tag whose rules
 * retarget ONLY the host's published data-* hooks: the guide root
 * (`[data-sidebar-right-guide]`) drops its single flex column for an
 * `auto-fill` minmax grid, and the entry cells/capsules shed their fixed
 * 380px. jsdom has no layout engine, so this spec pins the STRING and DOM
 * contract only — never the visual outcome.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { registerGuideGrid } from '../src/client/native/guide-grid.ts'

/** The patch's injected tag(s) currently in the head. */
const injected = (): HTMLElement[] =>
  [...document.head.querySelectorAll<HTMLElement>('style[data-dsh-guide-grid]')]

afterEach(() => {
  for (const tag of injected()) tag.remove()
})

describe('registerGuideGrid', () => {
  it('injects one tagged style tag into document.head with the host-hook grid rules', () => {
    const dispose = registerGuideGrid()
    try {
      const tags = injected()
      expect(tags).toHaveLength(1)
      expect(tags[0]!.getAttribute('data-dsh-guide-grid')).toBe('')
      expect(tags[0]!.parentElement).toBe(document.head)
      const text = tags[0]!.textContent ?? ''
      // The patch anchors on the HOST guide's data-* hook and replaces the
      // fixed single-column layout with an adaptive track list...
      expect(text).toContain('[data-sidebar-right-guide]')
      expect(text).toContain('repeat(auto-fill')
      // ...and the fixed-column semantics it replaces are gone: the grid
      // track list is the layout primitive, no 380px capsule width anywhere.
      expect(text).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(140px,\s*1fr\)\)/)
      expect(text).not.toContain('width: 380px')
    } finally {
      dispose()
    }
  })

  it('removes the tag from the head when the disposer runs', () => {
    const dispose = registerGuideGrid()
    expect(injected()).toHaveLength(1)
    dispose()
    expect(injected()).toHaveLength(0)
    // Removing twice stays a no-op — the effect-cleanup contract of the
    // sibling patches (strip-compression.ts, strip-add-button.tsx).
    expect(() => { dispose() }).not.toThrow()
    expect(injected()).toHaveLength(0)
  })

  it('keeps repeated register/dispose cycles clean with no leftover tags', () => {
    for (let round = 0; round < 3; round += 1) {
      const dispose = registerGuideGrid()
      expect(injected(), `round ${round}: exactly one live tag while registered`).toHaveLength(1)
      dispose()
      expect(injected(), `round ${round}: no residue after dispose`).toHaveLength(0)
    }
    // Overlapping lifetimes (host re-mounts before the old effect cleans up):
    // each disposer owns exactly its own tag.
    const disposeA = registerGuideGrid()
    const disposeB = registerGuideGrid()
    expect(injected()).toHaveLength(2)
    disposeA()
    expect(injected()).toHaveLength(1)
    disposeB()
    expect(injected()).toHaveLength(0)
  })
})
