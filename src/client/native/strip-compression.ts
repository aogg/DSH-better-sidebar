/**
 * Adaptive-width patch for the HOST tab strip's chips (the native right-
 * Sidebar's top tab bar).
 *
 * Why the plugin patches the host's strip at all: that strip is rendered by
 * DSH's dockkit — the plugin only supplies the chip content — and its stock
 * chip (`._tab_`: `flex: 0 1 auto; min-width: 80px; max-width: 170px;
 * padding: 0 10px; white-space: nowrap`) hard-clips a long title at 170px and
 * squeezes EVERY chip towards its 80px floor once several tabs are open —
 * with the title box `overflow: hidden`, a squeezed chip degrades to its
 * glyph only. The product contract is the opposite: every tab title shows in
 * full, no matter how many tabs are open.
 *
 * The patch therefore replaces the strip's "compress to fit" semantics with
 * "content-adaptive + scroll": each chip takes its title's full width
 * (`flex: 0 0 auto` — the stock `flex-shrink: 1` is what shrinks chips below
 * their content) and never shrinks again, so the icon-only degradation is
 * gone. When the row runs out of room it overflows into the host's own
 * horizontal scroll (`data-dockkit-strip-tabs` already ships `overflow-x:
 * auto` with scroll-on-activate) — no scrollbar styles invented here. One
 * extreme ceiling stays: a single pathological title must not own the whole
 * row, so a chip caps at `60cqw` (container-query units against the
 * `container-type: inline-size` strip row). Within the cap a chip is as wide
 * as its content; past it the host's own `data-dockkit-tab-clipped` fade
 * marks the rare clipped title, and the chip content's native `title`
 * tooltip (tab-adapter.tsx) carries the full name on hover.
 *
 * The ACTIVE chip keeps its fix: the host's close button (`×`) is
 * absolutely positioned over the chip's right edge (`right: 4px`, 20px
 * square) and the host's only "make room" measure is a fade mask over the
 * active title's last 30px. On a content-sized chip with a CJK title the
 * title box hugs the text, so the mask erases the trailing glyphs outright
 * and the × covers them — 「文件变动」 would render as 「文件变 ×」. The patch
 * reserves the ×'s overlay area with REAL padding on the active closable
 * chip, and undoes the host's active fade mask: once the space is real
 * padding the title box still hugs the text, so the mask would keep erasing
 * the very glyphs it was supposed to protect. Only a genuinely clipped
 * title (the host sets `data-dockkit-tab-clipped`) keeps its fade, as the
 * truncation hint it is.
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

/**
 * The patch's rules — layout only, no colors. One dockkit mechanism per rule:
 *
 * - `container-type: inline-size` on the strip ROW turns the fixed-width flex
 *   row into the query container for the chip ceiling's `cqw` units below. It
 *   MUST sit on `[data-dockkit-strip]`, never on `[data-dockkit-strip-tabs]`:
 *   the tabs row is `flex: 0 1 auto`, and an inline-size container's contents
 *   contribute nothing to its own width — containing the tabs row would size
 *   it to zero and collapse the whole strip.
 * - `flex: 0 0 auto` on every chip: the `auto` basis sizes the chip to its
 *   content (the full, un-clipped title — the host's 170px ceiling is
 *   overridden below) and `flex-shrink: 0` retires the stock `flex: 0 1
 *   auto` squeeze, so a chip can never shrink below its title again — the
 *   row simply overflows into the host's own horizontal scroll.
 * - `max-width: 60cqw` is the ONE extreme ceiling, in container-query units
 *   against the strip row above (so it scales with the column, not the
 *   viewport): a pathological title cannot own the whole row — 60% always
 *   leaves the rest of the row visible — while virtually every real title
 *   stays under it and shows in full. Past the ceiling the host's
 *   `data-dockkit-tab-clipped` fade marks the clipped title and the chip's
 *   native `title` tooltip (tab-adapter.tsx) carries the full name.
 * - the 6px side padding (host: 10px) keeps chips compact.
 * - the ACTIVE, closable chip (`aria-selected="true"`; `data-dockkit-tab-quiet`
 *   chips excluded — a single unclosable tab renders no ×) reserves the ×'s
 *   overlay area with `padding-right: 24px` (20px button + 4px `right`
 *   offset): without real reserved space the absolutely positioned × sits on
 *   top of the last title glyphs.
 * - that same chip's title drops the host's active fade mask
 *   (`mask-image: none`). The mask was the host's old "make room for the ×"
 *   trick — fading the title's last 30px — and once the × area is real
 *   padding it serves no purpose except erasing the trailing CJK glyphs
 *   (the title box hugs the text, so the fade lands ON the text). A
 *   genuinely clipped title (the host sets `data-dockkit-tab-clipped`)
 *   keeps the fade as its truncation hint.
 */
const STRIP_ADAPTIVE_CSS = `
[data-dockkit-strip] { container-type: inline-size; }
[data-dockkit-strip-tabs] [data-dockkit-tab] { flex: 0 0 auto; max-width: 60cqw; padding-left: 6px; padding-right: 6px; }
[data-dockkit-strip-tabs] [data-dockkit-tab][aria-selected="true"]:not([data-dockkit-tab-quiet]) { padding-right: 24px; }
[data-dockkit-strip-tabs] [data-dockkit-tab][aria-selected="true"]:not([data-dockkit-tab-quiet]) > [data-dockkit-tab-title]:not([data-dockkit-tab-clipped]) { mask-image: none; }
`

/**
 * Inject the host-strip adaptive-width stylesheet for the caller's effect
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
  tag.textContent = STRIP_ADAPTIVE_CSS
  document.head.appendChild(tag)
  return () => {
    if (tag.isConnected) tag.remove()
  }
}
