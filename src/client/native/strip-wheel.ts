/**
 * Plain-wheel → horizontal scroll for the HOST tab strip (the native right-
 * Sidebar's top tab row).
 *
 * Why this exists: the host strip's tab row (`data-dockkit-strip-tabs`)
 * ships `overflow-x: auto` with its scrollbar hidden, so once the
 * adaptive-width patch (strip-compression.ts) lets chips take their full
 * width, an overflowing row can only be scrolled by a horizontal trackpad
 * delta or shift+wheel — a plain mouse wheel emits `deltaY`, which a
 * horizontal scrollport never consumes. The plugin's own bottom TabBar
 * (TabBar.tsx) already fixes the same gap for its strip, but that strip is
 * React-rendered and can hold a ref; the HOST strip is mounted by dockkit
 * outside this plugin's React tree — there is no element to attach to at
 * registration time (it may not exist yet) and no ref to keep across its
 * mount/unmount cycles.
 *
 * The fix is therefore ONE delegated, NON-passive `wheel` listener on
 * `document` (the stable ancestor every strip mounts under): at event time
 * `event.target.closest('[data-dockkit-strip-tabs]')` decides whether the
 * gesture is over a host strip. Delegation covers every strip instance and
 * any dynamic mount/unmount for free — no MutationObserver, no re-binding.
 *
 * The guard order mirrors TabBar's wheel handler exactly:
 * - modifier keys (shift / ctrl / cmd / alt) pass through untouched, so
 *   shift+wheel keeps its native horizontal scroll and ctrl/cmd keep zoom;
 * - a row that does not overflow is left alone, so the page scrolls
 *   normally under the cursor;
 * - otherwise the event is consumed (`preventDefault()` — a no-op in a
 *   passive listener, which is why this cannot be `{ passive: true }` or
 *   React's root-delegated onWheel) and the deltas are translated into
 *   `scrollLeft`, scaled per `deltaMode` like the browser would (1 = line
 *   → 16px, 2 = page → clientWidth), horizontal trackpad deltas included.
 *
 * Why `document` and not a closer stable ancestor: the DOM between the
 * sidebar column and the strip belongs to the host and its structure is
 * not a contract; `document` is the one mount point guaranteed to exist
 * for the client bundle's lifetime, and the attribute check keeps the
 * listener's blast radius to exactly the dockkit strips — wheel events
 * anywhere else (the plugin's own workbench TabBar included, which ships
 * its own per-strip handler) never reach `preventDefault()`. The host
 * strip's own drag interactions are pointer/touch-action based and carry
 * no wheel semantics, so they are untouched by this.
 */

import type { Context } from '../../context-types.ts'

/** The host strip's scrollable tab row, by its stable dockkit attribute. */
const STRIP_TABS_SELECTOR = '[data-dockkit-strip-tabs]'

/**
 * Translate plain-wheel deltas into horizontal scrolling on every host tab
 * strip, for the caller's effect lifetime.
 * @param _ctx - the client context. Unused — the listener is scoped by the
 *   `data-dockkit-strip-tabs` attribute alone — and kept in the signature
 *   for uniformity with the other `register*` helpers.
 * @returns a disposer removing the document listener.
 */
export function registerStripWheel(_ctx: Context): () => void {
  const onWheel = (event: WheelEvent): void => {
    // Only gestures over a host strip's tab row: everything else — the
    // plugin's own pages, the rest of the host UI — keeps the browser's
    // wheel behavior untouched (never preventDefaulted here).
    const target = event.target
    if (!(target instanceof Element)) return
    const strip = target.closest(STRIP_TABS_SELECTOR)
    if (strip === null) return
    // Modifier keys keep their native meaning: shift = horizontal scroll,
    // ctrl/cmd = zoom, alt = the browser's own fallback.
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    // A row that fits leaves the event alone so the page scrolls normally.
    if (strip.scrollWidth <= strip.clientWidth) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1
    strip.scrollLeft += (event.deltaX + event.deltaY) * unit
  }
  // NON-passive is the point: preventDefault() inside a passive listener
  // is a no-op (the same reason TabBar cannot use React's onWheel).
  document.addEventListener('wheel', onWheel, { passive: false })
  return () => { document.removeEventListener('wheel', onWheel) }
}
