/**
 * Shared wiring for the plugin's xterm screens (TerminalView's
 * {@link TerminalScreen}, CmdRunView's {@link CmdRunScreen}): theme bridging
 * and paste takeover, so the two surfaces cannot drift.
 *
 * THEME BRIDGE (the white-screen defense, R0): xterm needs concrete colors and
 * the stylesheet paints from `--dsw-*` tokens, so the values are read back off
 * the screen element. The read is GUARDED — `readPaintColors` answers
 * `undefined` while the computed values do not actually paint (the boot window
 * before the host's token stylesheets land answers `rgba(0, 0, 0, 0)`, and
 * glass skins answer translucent values) — and a guarded miss subscribes to
 * `<head>` style mutations (`subscribeStylesReady`) and re-reads the moment
 * styles land. Without the guard the emulator could freeze on a transparent
 * background for the whole session: the old effect only re-read on a
 * scheme/model/phase change, and a boot that reached `connected` before the
 * theme CSS arrived never saw another one — the reported white screen.
 */
import type { Terminal } from '@xterm/xterm'
import { readPaintColors, subscribeStylesReady } from './theme.ts'
import { attachPasteTakeover, type PasteTakeover } from './terminal-paste.ts'

/** Apply the surface theme to one emulator; `false` while colors do not paint. */
export function applySurfaceTheme(node: Element, xterm: Terminal): boolean {
  const colors = readPaintColors(node)
  if (colors === undefined) return false
  xterm.options.theme = {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: colors.foreground,
    selectionForeground: colors.background,
  }
  return true
}

/**
 * Bind the theme with the boot-window defense: apply now, and while the
 * values do not paint yet, watch `<head>` styles and apply the moment they do
 * (the disposer covers both the satisfied path and the effect cleanup — it is
 * idempotent). The scheme-flip re-read is the CALLER's effect dependency, as
 * before.
 */
export function bindSurfaceTheme(node: Element, xterm: Terminal): () => void {
  if (applySurfaceTheme(node, xterm)) return () => {}
  const dispose = subscribeStylesReady(() => {
    if (applySurfaceTheme(node, xterm)) dispose()
  })
  return dispose
}

export { attachPasteTakeover }
export type { PasteTakeover }
