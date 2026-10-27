/**
 * Paste sanitization for the plugin's xterm surfaces (the bottom workbench
 * terminal, the 命令 run tab).
 *
 * Two reported symptoms, one root cause each:
 *
 * 1. Pasting colored terminal content turned the pasted region black-on-black
 *    (or otherwise off-theme): the clipboard carried ANSI escape sequences
 *    (SGR color/attribute runs from a copied `ls --color` output, prompt
 *    coloring, …) and xterm replayed them verbatim. {@link stripAnsiSequences}
 *    removes EVERY escape sequence — CSI (colors, cursor moves), OSC (window
 *    title, hyperlinks, shell-integration markers) and the remaining two/…
 *    byte ESC forms — before the text ever reaches the emulator. Pure and
 *    unit-tested (tests/terminal-paste.spec.ts).
 *
 * 2. Literal `^[[200~` / `^[[201~` caret notation sometimes appeared in the
 *    pasted text: a terminal that had bracketed-paste markers DISABLED still
 *    printed them because the SOURCE application had copied the markers as
 *    plain text (the caret spelling of ESC [ 200 ~). {@link sanitizePastedText}
 *    strips that literal spelling too.
 *
 * The DOM-facing half, {@link attachPasteTakeover}, takes the `paste` event
 * away from xterm entirely: xterm 6 registers its own paste listeners on BOTH
 * the textarea and the emulator root element (lib/xterm.js:
 * `L(this.textarea,"paste",e)`, `L(this.element,"paste",e)`), and at the event
 * target listeners fire in registration order — one attached after `open()`
 * can never run first. A CAPTURE-phase listener on the screen container (an
 * ancestor of both) is the only reliable interception point: ancestor capture
 * runs before any target listener, so `preventDefault` + `stopPropagation`
 * there stops xterm's raw forwarding completely. The sanitized text is then
 * written through the model: newlines normalized to `\r` (the Enter keystroke
 * a PTY understands), and — ONLY while the shell's bracketed-paste mode
 * (DECSET 2004) is active — wrapped in `\x1b[200~ … \x1b[201~` so a multi-line
 * paste lands on the prompt line instead of executing line by line.
 */
import type { Terminal } from '@xterm/xterm'

/**
 * Strip every ANSI escape sequence from `text`, keeping plain text (including
 * \n / \r / \t and non-ASCII) untouched.
 *
 * Recognized forms (ECMA-48 / VT100):
 * - CSI  `ESC [  params(0x30–0x3F)* intermediates(0x20–0x2F)* final(0x40–0x7E)`
 * - string sequences `ESC ]`(OSC) `ESC P`(DCS) `ESC X`(SOS) `ESC ^`(PM)
 *   `ESC _`(APC) — terminated by BEL (0x07) or ST (`ESC \`); an UNterminated
 *   one (a clipboard truncated mid-sequence) swallows the rest of the string,
 *   which is exactly what a real emulator's parser would render as garbage.
 * - nF sequences `ESC (B`-style (intermediates 0x20–0x2F, then one final byte).
 * - two-byte ESC sequences (`ESC 7`, `ESC =`, `ESC c`, …); a trailing lone ESC
 *   is dropped.
 */
export function stripAnsiSequences(text: string): string {
  // Fast path: the overwhelming majority of pastes carry no ESC at all.
  if (!text.includes('\x1b')) return text
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i] as string
    if (ch !== '\x1b') {
      out += ch
      i += 1
      continue
    }
    const next = text[i + 1] as string | undefined
    if (next === undefined) break // trailing lone ESC — nothing to render
    if (next === '[') {
      // CSI: consume parameter + intermediate bytes, then the final byte.
      i += 2
      while (i < n && (text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f)) i += 1
      if (i < n && text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e) i += 1
      continue
    }
    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
      // String sequence (OSC/DCS/SOS/PM/APC): run to BEL or ST.
      i += 2
      let terminated = false
      while (i < n) {
        const code = text.charCodeAt(i)
        if (code === 0x07) {
          i += 1
          terminated = true
          break
        }
        if (code === 0x1b && text.charCodeAt(i + 1) === 0x5c) {
          i += 2
          terminated = true
          break
        }
        i += 1
      }
      // Unterminated (truncated clipboard): the rest would render as garbage.
      if (!terminated) i = n
      continue
    }
    if (next.charCodeAt(0) >= 0x20 && next.charCodeAt(0) <= 0x2f) {
      // nF escape (e.g. `ESC ( B` charset designation): intermediates + final.
      i += 2
      while (i < n && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i += 1
      if (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x7e) i += 1
      continue
    }
    // Two-byte ESC sequence.
    i += 2
  }
  return out
}

/** The literal caret spelling of the bracketed-paste markers (plain text). */
const LITERAL_BRACKET_MARKERS = /\^\[\[(?:200|201)~/g

/**
 * Full paste sanitization: strip the literal `^[[200~` / `^[[201~` caret
 * markers, strip every ANSI escape sequence, then normalize newlines to `\r`
 * (the Enter keystroke xterm/PTY expect — \n alone would not submit a line).
 */
export function sanitizePastedText(text: string): string {
  const stripped = stripAnsiSequences(text.replace(LITERAL_BRACKET_MARKERS, ''))
  return stripped.replace(/\r\n?/g, '\r').replace(/\n/g, '\r')
}

/** Whether one CSI params entry is the DECSET/DECRST number 2004. */
function is2004(param: number | number[]): boolean {
  if (typeof param === 'number') return param === 2004
  return param[0] === 2004
}

/** The subset of the parser API the takeover tracks DECSET 2004 through. */
interface PasteParser {
  registerCsiHandler?(
    id: { readonly prefix?: string; readonly final: string },
    callback: (params: (number | number[])[]) => boolean,
  ): { dispose(): void }
}

/** The public dispose handle of a paste takeover. */
export interface PasteTakeover {
  dispose(): void
}

/** The bracketed-paste wrappers (sent only while DECSET 2004 is active). */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * Take the terminal's paste events over (see the module header for WHY the
 * listener must sit on the screen container in the capture phase).
 *
 * Bracketed-paste tracking follows the shell: DECSET/DECRST 2004 arrives as
 * `CSI ? 2004 h` / `CSI ? 2004 l`, watched through
 * `xterm.parser.registerCsiHandler` — the handler returns `false` so xterm's
 * own internal bracketed-paste state still updates (we only observe). A
 * runtime without the parser API (tests, a future xterm reshuffle) degrades to
 * reading `terminal.modes.bracketedPasteMode` at paste time; if NEITHER is
 * available the paste is written unwrapped (plain text, still sanitized).
 *
 * @param surface - an ANCESTOR of the emulator root (the `.screen` container).
 * @param terminal - the xterm instance (textarea/parser/modes are read).
 * @param write - the sink for the sanitized text (the model's `write`).
 */
export function attachPasteTakeover(surface: HTMLElement, terminal: Terminal, write: (data: string) => void): PasteTakeover {
  let bracketed = false
  const parser = terminal.parser as unknown as PasteParser | undefined
  // DECSET (`h`) / DECRST (`l`) of mode 2004, prefix `?` only — the ANSI
  // SM/RM forms without the prefix are a different mode family.
  const setHandler = parser?.registerCsiHandler?.({ prefix: '?', final: 'h' }, (params) => {
    if (params.some(is2004)) bracketed = true
    return false
  })
  const resetHandler = parser?.registerCsiHandler?.({ prefix: '?', final: 'l' }, (params) => {
    if (params.some(is2004)) bracketed = false
    return false
  })
  const onPaste = (event: ClipboardEvent): void => {
    // Beat every target-phase listener (xterm forwards the RAW clipboard).
    event.preventDefault()
    event.stopPropagation()
    const raw = event.clipboardData?.getData('text/plain') ?? ''
    if (raw === '') return
    const text = sanitizePastedText(raw)
    if (text === '') return
    // The CSI observers may be absent: ask the emulator itself as the fallback.
    const modes = terminal.modes as { bracketedPasteMode?: boolean } | undefined
    const wrapped = setHandler !== undefined || resetHandler !== undefined
      ? bracketed
      : modes?.bracketedPasteMode === true
    write(wrapped ? `${PASTE_START}${text}${PASTE_END}` : text)
  }
  surface.addEventListener('paste', onPaste, true)
  return {
    dispose(): void {
      surface.removeEventListener('paste', onPaste, true)
      setHandler?.dispose()
      resetHandler?.dispose()
    },
  }
}
