/**
 * The editor minimap (the VS Code-style document overview strip at the
 * CodeMirror surface's right edge).
 *
 * Pinned here:
 *  - the LAYOUT MATH as pure functions: the sampling stride that always fits
 *    the whole document into the strip, the per-line ink span (first/last
 *    non-blank column, capped at the mapped width), the viewport band's
 *    proportional rectangle, and the pointer → scrollTop mapping of the
 *    center-aligned VS Code drag;
 *  - the WIRING against a real EditorView: the strip binds the editor's own
 *    scroller and moves the band on its scroll events (never the reverse —
 *    every interaction writes only `scrollDOM.scrollTop`), and the wheel is
 *    forwarded to the editor;
 *  - the GATES: rendered by default for the `code` viewer, hidden while the
 *    ONE setting is off (live flip, no reopen), hidden in the markdown/jsonl
 *    preview and back in edit mode, and silent — container rendered, nothing
 *    thrown — when the canvas has no 2d context (jsdom).
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const { gitStatus, gitDiffHead, gitBlame } = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitDiffHead: vi.fn(),
  gitBlame: vi.fn(),
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      gitStatus: (...args: unknown[]) => gitStatus(...args),
      gitDiffHead: (...args: unknown[]) => gitDiffHead(...args),
      gitBlame: (...args: unknown[]) => gitBlame(...args),
    },
  }
})

import { renderRoot, setupReactAct } from './test-utils.ts'
import {
  EditorMinimap,
  MINIMAP_MAX_COLUMNS,
  MINIMAP_MIN_EDITOR_WIDTH,
  MINIMAP_ROW_HEIGHT,
  lineInkSpan,
  minimapBandHeight,
  minimapStride,
  scrollTopForPointer,
  viewportBand,
} from '../src/client/EditorMinimap.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { EditorToolbarControls, FileViewerProps } from '../src/client/service.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } { return { active: this.active } }
  subscribe(_fn: () => void): () => void { return () => {} }
}

beforeEach(() => {
  attachLocale(new FakeLocale())
  gitStatus.mockReset()
  gitDiffHead.mockReset()
  gitBlame.mockReset()
  gitStatus.mockResolvedValue({ isRepo: false, entries: [], repositories: [] })
  gitDiffHead.mockResolvedValue({ diff: '' })
  gitBlame.mockResolvedValue({ lines: [] })
})

afterEach(() => {
  attachLocale(undefined)
  document.body.innerHTML = ''
})

describe('minimap layout math (pure functions)', () => {
  it('samples with the smallest stride that fits the whole document', () => {
    // 100 rows fit a 200px strip at a 2px pitch — no sampling.
    expect(MINIMAP_ROW_HEIGHT).toBe(2)
    expect(minimapStride(100, 200)).toBe(1)
    // One line over: stride 2 halves the drawn rows and still fits.
    expect(minimapStride(101, 200)).toBe(2)
    expect(Math.ceil(101 / minimapStride(101, 200)) * MINIMAP_ROW_HEIGHT).toBeLessThanOrEqual(200)
    // A big document: every sampled row stays inside the strip.
    expect(minimapStride(1000, 100)).toBe(20)
    expect(Math.ceil(1000 / 20) * MINIMAP_ROW_HEIGHT).toBeLessThanOrEqual(100)
    // Zero-size strip (hidden tab / jsdom): degenerate but never divides by 0.
    expect(minimapStride(5, 0)).toBe(5)
  })

  it('maps one ink bar to the first/last non-blank column, capped', () => {
    expect(lineInkSpan('code')).toEqual({ start: 0, end: 3 })
    expect(lineInkSpan('   code  ')).toEqual({ start: 3, end: 6 })
    expect(lineInkSpan('   \t ')).toBeNull()
    expect(lineInkSpan('')).toBeNull()
    // A line longer than the mapped width caps at the last mapped column.
    expect(lineInkSpan('a'.repeat(300))).toEqual({ start: 0, end: MINIMAP_MAX_COLUMNS - 1 })
    // Ink that STARTS past the cap keeps a one-column sliver at the edge.
    expect(lineInkSpan(`${' '.repeat(250)}x`, 200)).toEqual({ start: 199, end: 199 })
  })

  it('places the viewport band proportionally (bottom lands at the end)', () => {
    // Everything visible: the band IS the strip.
    expect(viewportBand(0, 200, 200, 200)).toEqual({ top: 0, height: 200 })
    // A third of the document visible, scrolled to half the scrollable range:
    // the band is a third of the strip, its top at scrollTop's share.
    expect(viewportBand(200, 200, 600, 300)).toEqual({ top: 100, height: 100 })
    // Scrolled to the very end: the band's bottom sits on the strip's bottom.
    const end = viewportBand(400, 200, 600, 300)
    expect(end.top + end.height).toBe(300)
    // Degenerate boxes never divide by zero.
    expect(viewportBand(0, 0, 0, 100)).toEqual({ top: 0, height: 100 })
    expect(viewportBand(0, 100, 0, 0)).toEqual({ top: 0, height: 0 })
    // Never smaller than one row: the slider stays findable in a huge file.
    expect(minimapBandHeight(50, 100000, 200)).toBe(2)
  })

  it('center-aligns the band under the pointer and clamps to the range', () => {
    // track 200, scroll 400, client 100 → band height 50. Pointer at 100:
    // the band centers there → scrollTop (100 - 50/2) / 200 × 400 = 150.
    expect(scrollTopForPointer(100, 200, 400, 100)).toBe(150)
    // A pointer above the top clamps to 0, below the bottom to maxScroll.
    expect(scrollTopForPointer(0, 200, 400, 100)).toBe(0)
    expect(scrollTopForPointer(200, 200, 400, 100)).toBe(300)
    // Nothing to scroll (short document / zero strip): always 0.
    expect(scrollTopForPointer(100, 200, 100, 200)).toBe(0)
    expect(scrollTopForPointer(100, 0, 400, 100)).toBe(0)
  })

  it('names a real stylesheet rule for every class and the narrow-pane hide', () => {
    // The class names live in a plain string (css editorMinimap), so a typo
    // would silently paint nothing — same reasoning as the gutter's check.
    const sheet = readFileSync(resolve(import.meta.dirname, '../src/client/sidebar.module.css'), 'utf8')
    for (const source of [
      'editorCmRow',
      'editorMinimap',
      'editorMinimapCanvas',
      'editorMinimapBand',
      'editorMinimapDark .editorMinimapBand',
      'editorMinimapLight .editorMinimapBand',
    ]) {
      expect(sheet, source).toContain(`.${source}`)
    }
    // The narrow-pane hide mirrors MINIMAP_MIN_EDITOR_WIDTH (420px), and the
    // 60px strip width lives here too — keep code and sheet in step.
    expect(MINIMAP_MIN_EDITOR_WIDTH).toBe(420)
    expect(sheet).toContain('@container (max-width: 419px)')
    expect(sheet).toContain('width: 60px')
  })
})

describe('EditorMinimap against a real EditorView', () => {
  /** Override an unmeasurable jsdom box (getBoundingClientRect is all zeros). */
  function fakeBox(element: Element, values: { scrollTop?: number; clientHeight?: number; scrollHeight?: number; clientWidth?: number }): void {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(element, key, { configurable: true, value })
    }
  }

  /** A real view in the document + the strip mounted with a captured sync slot. */
  function mountStrip(view: EditorView): ReturnType<typeof renderRoot> & { syncSlot: { current: (() => void) | null } } {
    const syncSlot: { current: (() => void) | null } = { current: null }
    const strip = renderRoot(createElement(EditorMinimap, {
      viewRef: { current: view },
      dark: true,
      syncRef: syncSlot,
    }))
    return Object.assign(strip, { syncSlot })
  }

  it('binds the editor scroller and moves the band with its scroll events', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({
      state: EditorState.create({ doc: 'one\ntwo\nthree\n' }),
      parent: host,
    })
    const strip = mountStrip(view)
    try {
      // The mount registered the sync slot the host (TextEditor) calls.
      expect(typeof strip.syncSlot.current).toBe('function')
      const stripEl = strip.container.querySelector('[data-minimap]') as HTMLElement
      expect(stripEl).not.toBeNull()

      // jsdom gives no layout: fake the scroll state (a 100px viewport over a
      // 400px document) and a 200px strip, then fire the editor's scroll.
      fakeBox(view.scrollDOM, { scrollTop: 100, clientHeight: 100, scrollHeight: 400 })
      fakeBox(stripEl, { clientHeight: 200 })
      await act(async () => { view.scrollDOM.dispatchEvent(new Event('scroll')) })
      await new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
      // Band = the viewport's share (100/400 → 50px tall) at scrollTop's
      // share of the strip (100/400 × 200px → top 50px). The band is a plain
      // div, so a scroll never re-rasterizes the canvas.
      const band = strip.container.querySelector('[data-minimap-band]') as HTMLElement
      expect(band.style.height).toBe('50px')
      expect(band.style.top).toBe('50px')
    } finally {
      strip.unmount()
      view.destroy()
    }
  })

  it('renders its container and never throws when the canvas has no 2d context', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({
      state: EditorState.create({ doc: 'one\ntwo\nthree\n' }),
      parent: host,
    })
    const strip = mountStrip(view)
    try {
      const stripEl = strip.container.querySelector('[data-minimap]') as HTMLElement
      expect(stripEl).not.toBeNull()
      expect(strip.container.querySelector('canvas')).not.toBeNull()
      // Give the strip a box, then push the full ink redraw the host sends on
      // "a view exists / the document changed": a skip, not a crash.
      fakeBox(stripEl, { clientWidth: 60, clientHeight: 400 })
      expect(() => { strip.syncSlot.current?.() }).not.toThrow()
      // The band path reads only boxes — it answers on the same push. The
      // scroller here has no box at all, so the band covers the whole strip.
      await new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
      const band = strip.container.querySelector('[data-minimap-band]') as HTMLElement
      expect(band.style.height).toBe('400px')
    } finally {
      strip.unmount()
      view.destroy()
      getContext.mockRestore()
    }
  })

  it('forwards the wheel to the editor scroller and swallows the event', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const view = new EditorView({
      state: EditorState.create({ doc: 'one\ntwo\nthree\n' }),
      parent: host,
    })
    const strip = mountStrip(view)
    try {
      const stripEl = strip.container.querySelector('[data-minimap]') as HTMLElement
      const event = new WheelEvent('wheel', { deltaY: 40, cancelable: true, bubbles: true })
      stripEl.dispatchEvent(event)
      // The strip itself never scrolls — the editor does, by the wheel delta,
      // and the page behind it does not (preventDefault on a non-passive
      // native listener; React's onWheel would be passive).
      expect(event.defaultPrevented).toBe(true)
      expect(view.scrollDOM.scrollTop).toBe(40)
    } finally {
      strip.unmount()
      view.destroy()
    }
  })
})

describe('TextEditor wiring', () => {
  function viewerProps(overrides: Partial<FileViewerProps> = {}): FileViewerProps {
    return {
      ctx: {} as FileViewerProps['ctx'],
      store: createSidebarStore(),
      scope: { sessionId: 's1', cwd: '/p' },
      path: '/p/a.ts',
      title: 'a.ts',
      viewerId: 'code',
      content: 'one\ntwo\nthree\n',
      ...overrides,
    }
  }

  it('shows the strip for the code viewer by default, inside the editor pane row', () => {
    const mountedEditor = renderRoot(createElement(TextEditor, viewerProps()))
    try {
      const strip = mountedEditor.container.querySelector('[data-minimap]')
      expect(strip).not.toBeNull()
      // The strip shares the pane with the CodeMirror host (a flex item in
      // the same row, not an overlay), and the editor itself still rendered.
      expect(strip!.parentElement!.querySelector('.cm-editor')).not.toBeNull()
      expect(mountedEditor.container.querySelector('.cm-content')).not.toBeNull()
    } finally {
      mountedEditor.unmount()
    }
  })

  it('hides and shows the strip live with the ONE setting (no reopen)', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), editorMinimap: false })
    const mountedEditor = renderRoot(createElement(TextEditor, viewerProps({ store })))
    try {
      expect(mountedEditor.container.querySelector('[data-minimap]')).toBeNull()
      // The pref read is an external store: flipping it re-renders the editor
      // and the strip appears/disappears in place — no reopen, editor intact.
      act(() => { store.setPrefs({ ...store.getPrefs(), editorMinimap: true }) })
      expect(mountedEditor.container.querySelector('[data-minimap]')).not.toBeNull()
      act(() => { store.setPrefs({ ...store.getPrefs(), editorMinimap: false }) })
      expect(mountedEditor.container.querySelector('[data-minimap]')).toBeNull()
      expect(mountedEditor.container.querySelector('.cm-content')).not.toBeNull()
    } finally {
      mountedEditor.unmount()
    }
  })

  it('markdown: hidden in the preview, back in edit mode', () => {
    const controlsRef: { current: EditorToolbarControls | null } = { current: null }
    const mountedEditor = renderRoot(createElement(TextEditor, viewerProps({
      viewerId: 'markdown',
      path: '/p/a.md',
      toolbar: 'host',
      onToolbarControls: (next) => { controlsRef.current = next },
    })))
    try {
      const stripOf = (): Element | null => mountedEditor.container.querySelector('[data-minimap]')
      // The markdown viewer opens in its rendered preview: no strip over a
      // rendered page (VS Code semantics), editor alive underneath.
      expect(stripOf()).toBeNull()
      expect(mountedEditor.container.querySelector('.cm-content')).not.toBeNull()
      // Edit mode: the CodeMirror surface is the pane again — strip returns.
      act(() => { controlsRef.current?.setMode('edit') })
      expect(stripOf()).not.toBeNull()
      act(() => { controlsRef.current?.setMode('preview') })
      expect(stripOf()).toBeNull()
    } finally {
      mountedEditor.unmount()
    }
  })

  it('jsonl: the record-list preview hides the strip too', () => {
    const mountedEditor = renderRoot(createElement(TextEditor, viewerProps({
      viewerId: 'jsonl',
      path: '/p/a.jsonl',
      content: '{"a":1}\n{"a":2}\n',
      // Parked tab: the paged record preview must not fetch anything here.
      visible: false,
    })))
    try {
      expect(mountedEditor.container.querySelector('[data-minimap]')).toBeNull()
    } finally {
      mountedEditor.unmount()
    }
  })
})
