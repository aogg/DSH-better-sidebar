/**
 * Adaptive-grid patch for the HOST guide start page (the native right
 * Sidebar's start page, rendered by the host package
 * `@deepseek-ai/dsh-client-ui-sidebar-right` under
 * `[data-sidebar-right-guide]`).
 *
 * Why the plugin patches the host's guide at all: the host lays every entry
 * out as a fixed 380px-wide row capsule (both its `.entryCell` wrapper and
 * the `.entry` button carry `width: 380px`) stacked in ONE centered flex
 * column. This plugin alone contributes ~10 capsules (files / changes /
 * tasks / subagent / settings, …), so the single column no longer fits the
 * viewport and the page overflows instead of showing its entries.
 *
 * The patch therefore replaces the fixed-column semantics with an
 * auto-fill grid: the guide root becomes `repeat(auto-fill,
 * minmax(140px, 1fr))`, so as many ≥140px cards fit per row as the column
 * allows and the rest wrap — the count of entries stops mattering. The
 * capsules drop their hard 380px (`width: 100%; min-width: 0`), tighten to
 * card proportions (48px min-height, 10px/14px padding), and the compass
 * hero (`> span[aria-hidden="true"]`) keeps its own full-width, centered
 * row above the cards. The host's entry titles already ellipsize, so no
 * text-overflow handling is added here.
 *
 * Why the selectors are ONLY the host's published `data-*` hooks
 * (`[data-sidebar-right-guide]`, `[data-slot='sidebar.right.tab.guide.entry']`,
 * `[data-sidebar-right-guide-entry]`): the host's class names are build-time
 * hashes that must never be hardcoded (the same contract as
 * strip-compression.ts / strip-add-button.ts). If a host update renames the
 * attributes, the rules simply stop matching and the page falls back to the
 * host's own single-column layout — the patch turns itself off, harmlessly.
 *
 * Why `:has()` is only an enhancement: the `entryCell` unwrapping rule needs
 * `:has()` to reach a cell through its `display:contents` slot wrapper. In a
 * browser without `:has()` that one rule never matches, and each cell keeps
 * the host's own `max-width: 100%` — the row stays 380px-wide (the stock
 * layout) instead of breaking: grid columns, the hero row and the capsule
 * restyle all still land, so the degrade is cosmetic, not structural.
 */

/**
 * The patch's rules — layout only, zero color literals. One host mechanism
 * per rule:
 *
 * - the guide ROOT: flex column → auto-fill grid. `align-content: center`
 *   keeps the whole block vertically centered in the pane the way the host's
 *   centered column did; `width: 100%` lets the track count follow the
 *   column's real width instead of the capsules' 380px.
 * - `> span[aria-hidden='true']`: the compass hero spans every track
 *   (`grid-column: 1 / -1`) and centers, so it reads as one banner above the
 *   cards rather than the first cell of the first row.
 * - `> div:has([data-slot='sidebar.right.tab.guide.entry'])`: the host's
 *   fixed 380px `.entryCell` becomes a plain grid item (`width: auto;
 *   min-width: 0`) — `min-width: 0` is what lets a cell shrink into a
 *   narrower track instead of overflowing it (grid items default to
 *   `min-width: auto`).
 * - `[data-sidebar-right-guide-entry]`: the capsule button fills its cell
 *   and tightens to card proportions (48px min-height, 10px/14px padding,
 *   10px gap) — the host's own 56px/14px/20px row proportions, scaled down.
 */
const GUIDE_GRID_CSS = `
[data-sidebar-right-guide] { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; align-content: center; width: 100%; }
[data-sidebar-right-guide] > span[aria-hidden='true'] { grid-column: 1 / -1; justify-content: center; }
[data-sidebar-right-guide] > div:has([data-slot='sidebar.right.tab.guide.entry']) { width: auto; min-width: 0; }
[data-sidebar-right-guide] [data-sidebar-right-guide-entry] { width: 100%; min-width: 0; min-height: 48px; gap: 10px; padding: 10px 14px; }
`

/**
 * Inject the host-guide adaptive-grid stylesheet for the caller's effect
 * lifetime. Pure static CSS — no observer: the rules live in the document
 * and re-match by themselves whenever the host re-renders the guide.
 * @returns a disposer removing the injected tag (a no-op once the tag is no
 *   longer connected).
 */
export function registerGuideGrid(): () => void {
  // Tagged like the sibling patches: the attribute carries the source
  // identity so the running patch is inspectable in DevTools.
  const tag = document.createElement('style')
  tag.setAttribute('data-dsh-guide-grid', '')
  tag.textContent = GUIDE_GRID_CSS
  document.head.appendChild(tag)
  return () => {
    if (tag.isConnected) tag.remove()
  }
}
