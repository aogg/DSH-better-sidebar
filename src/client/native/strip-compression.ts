/**
 * Compression patch for the HOST tab strip's chips (the native right-Sidebar's
 * top tab bar).
 *
 * Why the plugin patches the host's strip at all: that strip is rendered by
 * DSH's dockkit — the plugin only supplies the chip content — and its stock
 * chip (`._tab_`: `flex: 0 1 auto; min-width: 80px; max-width: 170px;
 * padding: 0 10px; white-space: nowrap`) overflows the column as soon as a
 * few tabs are open. On every active-tab change the host runs one layout
 * effect that scrolls the ACTIVE chip into view, so activating a right-side
 * chip (opening the changes page appends its chip at the row's end and
 * activates it) scrolls every chip left of it out of sight — the scrollbar
 * itself is hidden (`scrollbar-width: none`, fade masks at the edges only),
 * which reads as "switching to 文件变动 loses the other tabs, switching to
 * anything else restores them".
 *
 * The patch gives the row room to fit WITHOUT scrolling: chips may shrink
 * below the host's 80px floor, waste less padding, and below a 480px column
 * the decorative chip glyph hides too. The host already styles truncated
 * titles (`data-dockkit-tab-clipped` fade mask), so a shrunken chip is the
 * host's own designed compact look. When the row still cannot fit, the
 * host's scroll-on-activate keeps working exactly as before — no regression.
 *
 * Why the selectors are the `data-dockkit-*` hooks: the strip row, its
 * scrolling tab row and every chip carry stable attributes
 * (`data-dockkit-strip` / `data-dockkit-strip-tabs` / `data-dockkit-tab`),
 * and only the native right column is dockkit — the plugin's own bottom
 * workbench TabBar (sidebar.module.css) carries no such attributes and must
 * not be touched. If a host update renames the attributes, the rules simply
 * stop matching: the patch turns itself off, harmlessly.
 */

import type { Context } from '../../context-types.ts'
import css from '../sidebar.module.css'

/**
 * The patch's rules — layout only, no colors. One dockkit mechanism per rule:
 *
 * - `container-type: inline-size` on the strip ROW turns the fixed-width flex
 *   row into the query container for the `@container` rule below. It MUST sit
 *   on `[data-dockkit-strip]`, never on `[data-dockkit-strip-tabs]`: the tabs
 *   row is `flex: 0 1 auto`, and an inline-size container's contents
 *   contribute nothing to its own width — containing the tabs row would size
 *   it to zero and collapse the whole strip.
 * - `min-width: 0` undoes the host's per-chip 80px floor — the floor is what
 *   forces the row to overflow — and the host's own
 *   `data-dockkit-tab-clipped` fade mask covers the truncated title.
 * - the 6px side padding (host: 10px) saves 8px per chip.
 * - inside a ≤480px container the decorative chip glyph hides (an
 *   `aria-hidden` span by contract, so the chip's accessible name keeps the
 *   title), saving ~20px more per chip. The class hash comes from the SAME
 *   css module the chip renders with (`tab-adapter.tsx`), so dev and built
 *   bundle agree on the name.
 */
const STRIP_COMPRESSION_CSS = `
[data-dockkit-strip] { container-type: inline-size; }
[data-dockkit-strip-tabs] [data-dockkit-tab] { min-width: 0; padding-left: 6px; padding-right: 6px; }
@container (max-width: 480px) {
  [data-dockkit-strip-tabs] [data-dockkit-tab] .${css.chipIcon} { display: none; }
}
`

/**
 * Inject the host-strip compression stylesheet for the caller's effect
 * lifetime.
 * @param _ctx - the client context. Unused — the patch is static CSS scoped
 *   to the host's own `data-dockkit-*` attributes — and kept in the signature
 *   for uniformity with the other `register*` helpers.
 * @returns a disposer removing the injected tag (a no-op once the tag is no
 *   longer connected).
 */
export function registerStripCompression(_ctx: Context): () => void {
  // Tagged like the user-CSS injection in Sidebar.tsx: the attribute carries
  // the source identity so the running patch is inspectable in DevTools.
  const tag = document.createElement('style')
  tag.setAttribute('data-dsh-strip-compression', '')
  tag.textContent = STRIP_COMPRESSION_CSS
  document.head.appendChild(tag)
  return () => {
    if (tag.isConnected) tag.remove()
  }
}
