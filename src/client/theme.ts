/**
 * Live theme access for surfaces that cannot consume the token colors
 * directly — xterm's palette and CodeMirror's theme extensions need concrete
 * values, but the app's scheme flips at runtime (ui-layout's ThemePresenter
 * projects prefers-color-scheme and the user's choice onto
 * body[data-ds-dark-theme] and html { color-scheme }). This module reads the
 * resolved scheme and token values, and notifies subscribers on flips, so
 * the terminal and the editor re-theme in place instead of freezing in the
 * scheme they happened to be created under.
 */

/** Whether the app shell resolved to the dark scheme.
 *
 * The presenter sets `html { color-scheme }` together with the body palette
 * attribute, so a set color-scheme means the decision is authoritative (an
 * absent attribute is then LIGHT even when the OS prefers dark — the user
 * chose light). Before the presenter has run, fall back to the OS media
 * query as the best guess.
 */
export function isDarkScheme(): boolean {
  if (typeof document === 'undefined') return true
  const decided = document.documentElement.style.colorScheme !== ''
  if (decided) return document.body.hasAttribute('data-ds-dark-theme')
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** One token's computed value on <body> ('' while the theme has not applied). */
export function tokenValue(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.body).getPropertyValue(name).trim()
}

/** Minimal alpha for a token color to count as effectively opaque. Skin
 *  systems turn `--dsw-alias-bg-base` translucent for glass panels (the
 *  dsh-web-ui skins use rgba 0.16–0.7; `transparent` is 0); below this
 *  floor a text surface (terminal, editor) would render over the skin's
 *  backdrop art, so callers fall back to an opaque color. Values at or
 *  above the floor (e.g. a skin's scoped 0.96 porcelain) pass through —
 *  the skin still controls the surface. */
const OPAQUE_ALPHA_MIN = 0.9

/** The alpha channel of a computed CSS color, or null when the format is
 *  not parseable (named colors, `color()`… — treated as opaque). Handles
 *  the shapes getComputedStyle actually returns: the rgb()/rgba() and
 *  hsl()/hsla() function forms (comma or space syntax, with or without the
 *  `/ alpha` slot) and the #rgb/#rgba/#rrggbb/#rrggbbaa hex family. */
export function colorAlpha(color: string): number | null {
  const s = color.trim()
  // #rgb / #rgba / #rrggbb / #rrggbbaa
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex !== null) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      const a = digits.length === 4 ? digits[3]! : 'f'
      return parseInt(a + a, 16) / 255
    }
    const alphaHex = digits.length === 8 ? digits.slice(6) : 'ff'
    return parseInt(alphaHex, 16) / 255
  }
  // rgb(r g b) / rgb(r g b / a) / rgba(r, g, b, a) — the trailing slot is alpha.
  const fn = /^(rgba?|hsla?)\(([^)]+)\)$/i.exec(s)
  if (fn !== null) {
    const parts = fn[2]!.split(/[,\s/]+/).filter(Boolean)
    const alphaPart = parts[3]
    if (alphaPart === undefined) return 1
    const alpha = Number.parseFloat(alphaPart)
    return Number.isFinite(alpha) ? alpha : 1
  }
  return null
}

/**
 * A token value that actually PAINTS something — the guard for text
 * surfaces (issue #90). Skin systems routinely set global tokens to
 * `transparent` (glass skins) or translucent glass values (`rgba(…,0.16–0.7)`,
 * e.g. the dsh-web-ui skins) — both are truthy strings, so callers using
 * `|| fallback` never fire and the terminal/editor goes see-through over
 * the skin's backdrop. This returns '' for visually inert values (unset
 * keywords, transparent, and any color below the opacity floor) so the
 * caller's fallback chain engages; effectively opaque values pass through.
 */
export function isPaintableColor(color: string): boolean {
  switch (color) {
    case '':
    case 'transparent':
    case 'initial':
    case 'inherit':
    case 'unset':
      return false
    default: {
      const alpha = colorAlpha(color)
      if (alpha !== null && alpha < OPAQUE_ALPHA_MIN) return false
      return true
    }
  }
}

export function effectiveTokenValue(name: string): string {
  const raw = tokenValue(name)
  return isPaintableColor(raw) ? raw : ''
}

/**
 * Read the surface pair a text surface needs off its own element — the same
 * values the stylesheet paints from tokens, resolved through the live cascade
 * (skin scoped overrides included). `undefined` while the values do not
 * PAINT yet: the boot window where the host's token stylesheets have not
 * landed (getComputedStyle answers `rgba(0,0,0,0)`/inherit) and glass skins'
 * translucent surfaces (issue #90 — a translucent background would render the
 * terminal over the skin's backdrop art, and over a white workbench that is
 * the reported "white screen"). Callers MUST treat `undefined` as "not yet"
 * and re-read (subscribeStylesReady below), never fall back to a guessed
 * color.
 */
export function readPaintColors(node: Element): { background: string; foreground: string } | undefined {
  if (typeof document === 'undefined') return undefined
  const style = getComputedStyle(node)
  const background = style.backgroundColor
  const foreground = style.color
  if (!isPaintableColor(background) || !isPaintableColor(foreground)) return undefined
  return { background, foreground }
}

/**
 * Fire `callback` when stylesheets under `<head>` change — the event-driven
 * signal that token values MAY have become available (the host injecting its
 * theme styles, a skin landing, a media query flipping). The callback re-reads
 * and, once satisfied, disposes the returned watcher itself; the watcher is
 * idempotent so both the "satisfied" and effect-cleanup paths can call it.
 * This is a MutationObserver, not polling: it only fires while the terminal
 * surface is actually waiting for styles.
 */
export function subscribeStylesReady(callback: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(() => { callback() })
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['media', 'disabled', 'href'],
  })
  let done = false
  return () => {
    if (done) return
    done = true
    observer.disconnect()
  }
}

/**
 * Subscribe to color-scheme flips (the presenter toggles the body
 * attribute). The callback fires after the attribute changed; re-read the
 * scheme inside it.
 * @returns the disposer.
 */
export function subscribeColorScheme(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const observer = new MutationObserver(() => { callback() })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  return () => { observer.disconnect() }
}
