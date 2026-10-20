/**
 * Stand-in「+」(new tab) button for the HOST tab strip (the native right
 * Sidebar's top tab bar).
 *
 * Why the plugin draws a stand-in at all: the strip's「+」is dockkit chrome,
 * and the host gates it per pane — `canAddTab: (paneId) => guideIn(…) ===
 * void 0` — so while the hero start page (the host's own `guide` kind)
 * occupies a pane's tab row, the host renders NO + button at all: not
 * disabled, not hidden — ABSENT from the DOM. CSS cannot bring back an
 * element that was never rendered, so this module injects one: a
 * MutationObserver keeps one stand-in button in every strip that holds at
 * least one tab chip but no host「+」, and removes it again the moment the
 * host's own button appears (the row must never show two +) or the pane's
 * last tab chip goes away (the host's + is gone too there, by its own
 * design, so the strip is back under host control).
 *
 * Why the click re-opens `guide`: the host's own + is literally
 * `addTab: (paneId) => openTab("guide", { paneId, revealIfOpened: false })` —
 * guide is a single-instance kind, so a re-open resolves to the pane's
 * existing start-page tab and activates it. The stand-in calls the same face
 * (`ctx.get('sidebarRight').openTab`) with the same arguments and the strip's
 * own pane id, so its behavior IS the host's semantics, not a guess.
 *
 * Why the styling transcribes the host's `._addTab_` block: the stand-in sits
 * in the host's row and must read as the host's own control. The block is
 * copied through the `--dsw-*` skin tokens the host block already uses (no
 * hardcoded colors — guide §12), with the host's icon size (14px, stroke =
 * currentColor).
 *
 * Why the `data-dockkit-*` hooks: the same contract as strip-compression.ts —
 * the strip row, its scrolling tabs row and every chip carry stable
 * attributes (`data-dockkit-strip` / `data-dockkit-strip-tabs` /
 * `data-dockkit-tab`), and only the native right column is dockkit — the
 * plugin's own bottom workbench TabBar carries no such attributes and must
 * not be touched. If a host update renames the attributes, the rules simply
 * stop matching: the stand-in turns itself off, harmlessly.
 */

import type { Context } from '../../context-types.ts'
import { t } from '../locales.ts'

/** Marker attribute on every stand-in button (inspectable in DevTools, and
 *  the selector the sync/dispose passes match on). */
const STAND_IN_MARKER = 'data-dsh-add-tab-standin'
/** Marker attribute on the injected stylesheet tag. */
const STYLE_TAG_MARKER = 'data-dsh-add-button-standin'

/**
 * The stand-in's rules — the host's own `._addTab_` block plus its `:hover`
 * block, transcribed verbatim (extracted from the host's sidebar-right
 * stylesheet). Colors ride the same `--dsw-*` skin tokens the host block
 * already uses, so a skin re-theme restyles the stand-in with the row.
 */
const STAND_IN_CSS = `
[${STAND_IN_MARKER}] { display: flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; color: var(--dsw-alias-label-secondary); line-height: 1; background: transparent; border: none; border-radius: var(--dsw-radius-sm); cursor: pointer; }
[${STAND_IN_MARKER}]:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
`

/**
 * The + glyph: 14px (the host icon size), stroke = currentColor so the skin
 * tokens keep owning the color, drawn on a 16-unit grid (the host icon set's
 * grid) so it aligns with the chips' own glyphs.
 */
const PLUS_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>'

/**
 * The controller face the click reads (a structural slice of the host's
 * `ISidebarRight`). `paneId` inside the options is the host's
 * `placement.paneId`, which `place()` adopts verbatim — the exact field the
 * host's own addTab path fills.
 */
interface SidebarRightFace {
  openTab?(kind: string, options?: { paneId?: string; revealIfOpened?: boolean }): void
}

/**
 * Inject the host-strip「+」stand-in for the caller's effect lifetime.
 * @param ctx - the client context; only `ctx.get('sidebarRight')` is read,
 *   at click time (the controller can arrive late or be absent — both
 *   degrade to a click that does nothing).
 * @returns a disposer disconnecting the observer, canceling a pending
 *   debounced sync, removing every stand-in still on the page and removing
 *   the injected style tag.
 */
export function registerStripAddButton(ctx: Context): () => void {
  // Tagged like the sibling patches: the attribute carries the source
  // identity so the running patch is inspectable in DevTools.
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_TAG_MARKER, '')
  tag.textContent = STAND_IN_CSS
  document.head.appendChild(tag)

  let disposed = false
  /** True while a debounced sync is still in flight (one per frame at most). */
  let scheduled = false
  /** Cancels the in-flight debounce, whatever primitive carries it. */
  let cancelScheduled: (() => void) | undefined

  /** The click face: same face, same arguments, same pane as the host's own
   *  `addTab` (`openTab('guide', { paneId, revealIfOpened: false })`). */
  const onAddClick = (event: Event): void => {
    const button = event.currentTarget
    // A stand-in that a sync pass has not removed yet but that the host has
    // already detached (its pane died) does nothing — the next sync cleans up.
    if (!(button instanceof Element) || !button.isConnected) return
    const paneId = button.closest('[data-dockkit-strip]')?.getAttribute('data-dockkit-strip') ?? null
    if (paneId === null || paneId === '') return
    try {
      const controller = ctx.get('sidebarRight') as SidebarRightFace | undefined
      controller?.openTab?.('guide', { paneId, revealIfOpened: false })
    } catch {
      // Silent by the sibling patches' degrade contract: a click on a cosmetic
      // stand-in must never surface — the controller may be absent (cordis
      // throws on a service without inject, the seat may not be mounted yet)
      // or may throw for a pane the host has already torn down. The worst
      // case is the click doing nothing, which is exactly what the host's own
      // + does for a pane it cannot open into.
    }
  }

  /** Build one stand-in button for `paneId` (not yet attached). */
  const buildStandIn = (paneId: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    // The host's own attribute name AND value: tests and future tooling read
    // the stand-in exactly like the native button it stands in for.
    button.setAttribute('data-dockkit-add-tab', paneId)
    button.setAttribute(STAND_IN_MARKER, '')
    const label = t('newTab')
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    button.innerHTML = PLUS_ICON_SVG
    button.addEventListener('click', onAddClick)
    return button
  }

  /** One pass over every dockkit strip on the page (add / keep / remove). */
  const sync = (): void => {
    if (disposed) return
    for (const strip of document.querySelectorAll<HTMLElement>('[data-dockkit-strip]')) {
      const standIn = strip.querySelector<HTMLElement>(`[${STAND_IN_MARKER}]`)
      // The host's own button wins: ours must go, or the row shows two +.
      if (strip.querySelector(`[data-dockkit-add-tab]:not([${STAND_IN_MARKER}])`) !== null) {
        standIn?.remove()
        continue
      }
      const tabsRow = strip.querySelector<HTMLElement>('[data-dockkit-strip-tabs]')
      const tabCount = tabsRow?.querySelectorAll('[data-dockkit-tab]').length ?? 0
      // No tab chips → the host draws no + either (its own design), so there
      // is nothing to stand in for.
      if (tabsRow === null || tabCount < 1) {
        standIn?.remove()
        continue
      }
      if (standIn !== null) continue
      const paneId = strip.getAttribute('data-dockkit-strip')
      if (paneId === null) continue
      // The host's own order is the tabs row followed by the + — mirror it.
      tabsRow.insertAdjacentElement('afterend', buildStandIn(paneId))
    }
  }

  const run = (): void => {
    scheduled = false
    cancelScheduled = undefined
    sync()
  }

  /** Coalesce an observer burst into ONE sync per frame (rAF; setTimeout
   *  when the environment has no frames — the fallback the jsdom tests
   *  flush against). */
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(run)
      cancelScheduled = () => { cancelAnimationFrame(frame) }
    } else {
      const timer = setTimeout(run, 0)
      cancelScheduled = () => { clearTimeout(timer) }
    }
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  // First pass synchronously: a strip already on screen at registration gets
  // its stand-in immediately (and tests can assert without flushing).
  sync()
  return () => {
    disposed = true
    observer.disconnect()
    cancelScheduled?.()
    cancelScheduled = undefined
    scheduled = false
    for (const standIn of document.querySelectorAll(`[${STAND_IN_MARKER}]`)) standIn.remove()
    if (tag.isConnected) tag.remove()
  }
}
