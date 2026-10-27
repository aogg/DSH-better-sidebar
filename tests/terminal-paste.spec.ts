/**
 * Paste sanitization for the terminal surfaces (R2).
 *
 * `stripAnsiSequences` / `sanitizePastedText` are the pure halves; the DOM
 * takeover (attachPasteTakeover) gets its own small harness: a fake surface
 * recording capture-phase listeners, and a fake terminal carrying the parser
 * (CSI handlers) and modes (bracketedPasteMode) the takeover tracks.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { attachPasteTakeover, sanitizePastedText, stripAnsiSequences } from '../src/client/terminal-paste.ts'

describe('stripAnsiSequences', () => {
  it('leaves plain text untouched (fast path)', () => {
    expect(stripAnsiSequences('hello 世界\nsecond line\ttabbed')).toBe('hello 世界\nsecond line\ttabbed')
  })

  it('strips SGR color/attribute CSI runs (the black-on-black paste bug)', () => {
    expect(stripAnsiSequences('\x1b[01;32mgreen\x1b[0m plain'))
      .toBe('green plain')
    // A colored `ls` fragment: every byte of the sequences goes, text stays.
    expect(stripAnsiSequences('\x1b[38;5;196mfile.zip\x1b[38;5;244;1m  12K\x1b[0m'))
      .toBe('file.zip  12K')
  })

  it('strips cursor-movement and mode CSI sequences', () => {
    expect(stripAnsiSequences('a\x1b[2K\r b\x1b[?25l c\x1b[2J')).toBe('a\r b c')
    // With intermediates (`CSI ! p` soft-reset shape).
    expect(stripAnsiSequences('x\x1b[!py')).toBe('xy')
  })

  it('strips OSC sequences in both BEL and ST terminations', () => {
    expect(stripAnsiSequences('\x1b]0;window title\x07prompt'))
      .toBe('prompt')
    expect(stripAnsiSequences('\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\'))
      .toBe('link')
  })

  it('swallows an unterminated string sequence to end of text (truncated clipboard)', () => {
    expect(stripAnsiSequences('ok\x1b]83;href=https://x')).toBe('ok')
  })

  it('strips two-byte and nF ESC sequences and a trailing lone ESC', () => {
    expect(stripAnsiSequences('a\x1b7b\x1b=c\x1b(Bd\x1b')).toBe('abcd')
  })

  it('keeps C0 text bytes and non-ASCII content', () => {
    expect(stripAnsiSequences('列1\t列2\r\n中文✓')).toBe('列1\t列2\r\n中文✓')
  })
})

describe('sanitizePastedText', () => {
  it('strips the literal caret notation of the bracketed-paste markers', () => {
    // The reported symptom: `^[[200~` showing up inside the pasted text.
    expect(sanitizePastedText('^[[200~echo hi^[[201~')).toBe('echo hi')
  })

  it('strips real escape sequences AND the literal markers together', () => {
    expect(sanitizePastedText('\x1b[32m^[[200~pasted\x1b[0m^[[201~')).toBe('pasted')
  })

  it('normalizes every newline shape to \\r (the Enter keystroke)', () => {
    expect(sanitizePastedText('a\nb\r\nc\rd')).toBe('a\rb\rc\rd')
  })

  it('returns the empty string for markers-only or escapes-only clips', () => {
    expect(sanitizePastedText('^[[200~^[[201~')).toBe('')
    expect(sanitizePastedText('\x1b[31m\x1b[0m')).toBe('')
  })
})

/** The DOM pieces the takeover needs, faked minimally. */
function makeSurface(): {
  node: HTMLElement
  listenerCount(): number
  dispatch(text: string | undefined): ClipboardEvent
} {
  const node = document.createElement('div')
  const listeners: Array<(event: ClipboardEvent) => void> = []
  node.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type !== 'paste') return
    listeners.push(listener as (event: ClipboardEvent) => void)
  }) as HTMLElement['addEventListener']
  node.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type !== 'paste') return
    const at = listeners.indexOf(listener as (event: ClipboardEvent) => void)
    if (at >= 0) listeners.splice(at, 1)
  }) as HTMLElement['addEventListener']
  return {
    node,
    listenerCount: () => listeners.length,
    dispatch(text) {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
      for (const listener of [...listeners]) listener(event)
      return event
    },
  }
}

interface FakeCsiHandler {
  id: { prefix?: string; final: string }
  cb: (params: (number | number[])[]) => boolean
  disposed: boolean
}

/** A terminal double exposing just `parser` + `modes` (the takeover's reads). */
function makeTerminal(options?: { bracketed?: boolean }): {
  terminal: Parameters<typeof attachPasteTakeover>[1]
  handlers: FakeCsiHandler[]
} {
  const handlers: FakeCsiHandler[] = []
  const terminal = {
    modes: { bracketedPasteMode: options?.bracketed === true },
    parser: {
      registerCsiHandler: (id: { prefix?: string; final: string }, cb: (params: (number | number[])[]) => boolean) => {
        const entry: FakeCsiHandler = { id, cb, disposed: false }
        handlers.push(entry)
        return { dispose: () => { entry.disposed = true } }
      },
    },
  }
  return { terminal: terminal as unknown as Parameters<typeof attachPasteTakeover>[1], handlers }
}

describe('attachPasteTakeover', () => {
  it('prevents default, sanitizes, and writes unwrapped before any DECSET 2004', () => {
    const surface = makeSurface()
    const { terminal, handlers } = makeTerminal()
    const writes: string[] = []
    const takeover = attachPasteTakeover(surface.node, terminal, (data) => { writes.push(data) })
    expect(handlers.map(handler => `${handler.id.prefix ?? ''}${handler.id.final}`).sort())
      .toEqual(['?h', '?l'])

    const event = surface.dispatch('one\ntwo')
    expect(event.defaultPrevented).toBe(true)
    expect(writes).toEqual(['one\rtwo'])

    takeover.dispose()
    expect(surface.listenerCount()).toBe(0)
    expect(handlers.every(handler => handler.disposed)).toBe(true)
  })

  it('wraps the paste in the bracket markers only while DECSET 2004 is on', () => {
    const surface = makeSurface()
    const { terminal, handlers } = makeTerminal()
    const writes: string[] = []
    const takeover = attachPasteTakeover(surface.node, terminal, (data) => { writes.push(data) })

    const setH = handlers.find(handler => handler.id.final === 'h')!
    const setL = handlers.find(handler => handler.id.final === 'l')!

    // Colored clipboard + literal caret markers, with brackets ON (`CSI ? 2004 h`).
    setH.cb([2004])
    surface.dispatch('\x1b[31mred\x1b[0m ^[[200~x^[[201~')
    expect(writes[0]).toBe('\x1b[200~red x\x1b[201~')

    // DECRST via `CSI ? 2004 l`: back to plain writes.
    setL.cb([2004])
    surface.dispatch('tail')
    expect(writes[1]).toBe('tail')

    // Unrelated DECSET numbers (e.g. cursor hide, 25) must not flip the mode.
    setH.cb([25])
    surface.dispatch('still-plain')
    expect(writes[2]).toBe('still-plain')

    takeover.dispose()
  })

  it('reads terminal.modes.bracketedPasteMode when the parser API is absent', () => {
    const surface = makeSurface()
    const writes: string[] = []
    const { terminal } = makeTerminal({ bracketed: true })
    // Strip the parser: the modes read is the only bracketed-paste signal left.
    const bare = { modes: (terminal as unknown as { modes: { bracketedPasteMode: boolean } }).modes }
    const takeover = attachPasteTakeover(surface.node, bare as unknown as Parameters<typeof attachPasteTakeover>[1], (data) => { writes.push(data) })
    surface.dispatch('guarded')
    expect(writes).toEqual(['\x1b[200~guarded\x1b[201~'])
    takeover.dispose()
  })

  it('ignores empty and sanitizes-to-empty clipboards', () => {
    const surface = makeSurface()
    const { terminal } = makeTerminal()
    const writes: string[] = []
    const takeover = attachPasteTakeover(surface.node, terminal, (data) => { writes.push(data) })
    surface.dispatch('')
    surface.dispatch(undefined)
    surface.dispatch('^[[200~^[[201~')
    expect(writes).toEqual([])
    takeover.dispose()
  })
})
