/**
 * The one-shot seed behind the file tree's「添加到搜索中」redirect: the menu
 * parks the right-clicked row (as a chip shape + which list) and opens a NEW
 * search tab; the tab descriptor's `createTab` consumes the seed to prefill
 * the minted tab's `meta.include`/`meta.exclude`.
 *
 * Why a module-level one-shot and not the openTab seed's own `meta`: a
 * `createTab` descriptor mints the tab itself, the open IGNORES the seed's
 * `title`/`path`/`id`, and `seed.meta` would REPLACE the minted meta wholesale
 * instead of merging with the default toggles/chips (service.ts's native
 * branch — `meta: seed.meta ?? minted?.tab.meta`). The same hand-off shape as
 * the bottom terminal's `requestBottomTerminalAt`/`consumeBottomTerminalCwd`
 * and the side chat's `consumeSidechatSeed` (both consumed inside `createTab`
 * in builtins/tabs.tsx).
 *
 * Fire discipline mirrors the terminal seed: park immediately before the one
 * `service.openTab({ type: 'search' })` meant to consume it; callers gate on
 * `isTabEnabled('search')` first, so a refused open leaves nothing parked.
 */

/** The parked redirect: which chip list the row belongs to + the chip text
 *  (cwd-relative; an out-of-root row passes through as an absolute path —
 *  the host classifies both spellings identically). */
export interface SearchSeed {
  target: 'include' | 'exclude'
  chip: string
}

let parkedSeed: SearchSeed | undefined

/** Park the chip for the NEXT minted search tab (call right before openTab). */
export function parkSearchSeed(seed: SearchSeed): void {
  parkedSeed = seed
}

/** Take (and clear) the parked chip; `undefined` = plain mint (empty chips). */
export function consumeSearchSeed(): SearchSeed | undefined {
  const seed = parkedSeed
  parkedSeed = undefined
  return seed
}
