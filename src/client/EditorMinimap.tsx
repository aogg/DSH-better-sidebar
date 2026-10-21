/**
 * VS Code-style minimap: the document-overview strip at the RIGHT edge of the
 * CodeMirror surface (`code` always; markdown/html/jsonl only in edit mode).
 *
 * Shape of the thing:
 *  - a <canvas> paints ONE ink bar per (sampled) document line — sampled when
 *    `lines × row height` exceeds the strip so the WHOLE document always fits
 *    (the strip itself never scrolls), x-mapped against a capped line length;
 *  - a translucent band (a plain div, so scrolling never re-rasterizes the
 *    canvas) tracks the editor's visible range;
 *  - pressing + dragging the strip center-aligns the band under the pointer
 *    (VS Code's own drag feel), a plain click jumps the same way, and the
 *    wheel forwards to the editor — every path writes ONLY
 *    `view.scrollDOM.scrollTop` (+ `requestMeasure`). CodeMirror's
 *    scrollIntoView is deliberately NOT used: it walks every scrollable
 *    ancestor and drags the whole sidebar (see TextEditor.tsx).
 *
 * Observation only: the strip owns no CodeMirror extension. The host pushes
 * "a view exists / the document changed" through {@link EditorMinimapProps.syncRef}
 * (its updateListener), everything else is scroll/resize listeners of this
 * component. All layout math is exported as pure functions for the specs.
 *
 * Chunk boundary: imported ONLY by TextEditor.tsx (the lazy editor chunk,
 * lib/client-editor.js). The core bundle must never pull this module.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import { createFrameBatcher } from './frame-batcher.ts'
import css from './sidebar.module.css'

/** Pixel pitch of one sampled document row on the strip. */
export const MINIMAP_ROW_HEIGHT = 2
/** Document columns the strip maps onto its full width; longer lines cap. */
export const MINIMAP_MAX_COLUMNS = 200
/** The strip hides entirely below this editor-pane width (the sidebar is
 *  narrow; the overview costs more than it shows). Mirrored by the
 *  `@container` rule in sidebar.module.css. */
export const MINIMAP_MIN_EDITOR_WIDTH = 420

/**
 * The sampling stride that fits `lineCount` rows into `trackHeight`: 1 while
 * everything fits, else the smallest step whose sampled row count does fit
 * (the LAST line is always drawn — sample from line 1 upward).
 */
export function minimapStride(lineCount: number, trackHeight: number): number {
  const rows = Math.max(1, Math.floor(trackHeight / MINIMAP_ROW_HEIGHT))
  if (lineCount <= rows) return 1
  return Math.ceil(lineCount / rows)
}

/** First/last non-blank column (0-based) of one line. */
export interface MinimapInkSpan {
  start: number
  end: number
}

const isBlank = (code: number): boolean => code === 0x20 || code === 0x09

/**
 * The ink bar of one line: its first/last non-blank character, clamped into
 * the mapped column range. `null` for a blank line (no bar at all — a row of
 * pure whitespace is not ink).
 */
export function lineInkSpan(text: string, maxColumns: number = MINIMAP_MAX_COLUMNS): MinimapInkSpan | null {
  const length = text.length
  let start = 0
  while (start < length && isBlank(text.charCodeAt(start))) start += 1
  if (start >= length) return null
  let end = length - 1
  while (end > start && isBlank(text.charCodeAt(end))) end -= 1
  // A line whose ink begins past the cap keeps a one-column sliver at the
  // right edge: "there is ink, far out" beats erasing the line entirely.
  start = Math.min(start, maxColumns - 1)
  end = Math.min(end, maxColumns - 1)
  return { start, end }
}

/** The viewport slider's rectangle on the strip, in strip pixels. */
export interface MinimapBand {
  top: number
  height: number
}

/** The slider's height: the viewport's share of the whole document. */
export function minimapBandHeight(clientHeight: number, scrollHeight: number, trackHeight: number): number {
  if (trackHeight <= 0) return 0
  if (scrollHeight <= 0 || clientHeight <= 0) return trackHeight
  // Never smaller than one row: the slider must stay findable in a huge file.
  return Math.min(trackHeight, Math.max(MINIMAP_ROW_HEIGHT, (clientHeight / scrollHeight) * trackHeight))
}

/**
 * Where the editor's visible range sits on the strip: the same proportion
 * top and bottom, so scrolling to the very end lands the slider's bottom on
 * the strip's bottom.
 */
export function viewportBand(scrollTop: number, clientHeight: number, scrollHeight: number, trackHeight: number): MinimapBand {
  const height = minimapBandHeight(clientHeight, scrollHeight, trackHeight)
  if (height <= 0) return { top: 0, height: 0 }
  const maxTop = Math.max(0, trackHeight - height)
  const top = scrollHeight > 0
    ? Math.min(maxTop, Math.max(0, (scrollTop / scrollHeight) * trackHeight))
    : 0
  return { top, height }
}

/**
 * The `scrollDOM.scrollTop` that center-aligns the viewport slider under a
 * pointer at `offsetY` on the strip (VS Code's drag semantics: the document
 * moves with the pointer, and grabbing the slider mid-drag never jumps it).
 * Clamped into the scrollable range; 0 when there is nothing to scroll.
 */
export function scrollTopForPointer(offsetY: number, trackHeight: number, scrollHeight: number, clientHeight: number): number {
  if (trackHeight <= 0 || scrollHeight <= 0) return 0
  const height = minimapBandHeight(clientHeight, scrollHeight, trackHeight)
  const scrollTop = ((offsetY - height / 2) / trackHeight) * scrollHeight
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  return Math.min(maxScroll, Math.max(0, scrollTop))
}

/** Host-injected handles: everything the strip needs from TextEditor. */
export interface EditorMinimapProps {
  /** The live CodeMirror view (null until the host's creation effect ran). */
  viewRef: { readonly current: EditorView | null }
  /** The app's resolved color scheme; a flip repaints the ink. */
  dark: boolean
  /** Registration slot: the strip writes its `sync()` here on mount (and
   *  nulls it on unmount); the host calls it once a view exists / after any
   *  document change. Idempotent — an unchanged binding just redraws. */
  syncRef: { current: (() => void) | null }
}

/** Canvas ink tints (concrete rgba — a canvas cannot read CSS variables). */
const INK_DARK = 'rgba(226,230,244,0.42)'
const INK_LIGHT = 'rgba(26,31,48,0.40)'

export function EditorMinimap(props: EditorMinimapProps): ReactNode {
  const { viewRef, dark, syncRef } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bandRef = useRef<HTMLDivElement | null>(null)
  const darkRef = useRef(dark)
  darkRef.current = dark
  /** The view the scroll listener is currently bound to. */
  const boundRef = useRef<{ view: EditorView; detach: () => void } | null>(null)
  const draggingRef = useRef(false)
  /** Ink redraws are O(document) — frame-coalesced like any pointer stream. */
  const inkBatcher = useMemo(() => createFrameBatcher(), [])
  const bandBatcher = useMemo(() => createFrameBatcher(), [])

  /** Paint the whole-document thumbnail. Skips silently when the canvas has
   *  no 2d context (jsdom) or the strip has no box yet (hidden tab). */
  const drawInk = useCallback((): void => {
    const view = viewRef.current
    const canvas = canvasRef.current
    const container = containerRef.current
    if (view === null || canvas === null || container === null) return
    const width = container.clientWidth
    const height = container.clientHeight
    if (width <= 0 || height <= 0) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const ratio = globalThis.devicePixelRatio || 1
    const deviceWidth = Math.max(1, Math.floor(width * ratio))
    const deviceHeight = Math.max(1, Math.floor(height * ratio))
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth
      canvas.height = deviceHeight
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const doc = view.state.doc
    const stride = minimapStride(doc.lines, height)
    ctx.fillStyle = darkRef.current ? INK_DARK : INK_LIGHT
    for (let number = 1; number <= doc.lines; number += stride) {
      const span = lineInkSpan(doc.line(number).text)
      if (span === null) continue
      const y = Math.floor((number - 1) / stride) * MINIMAP_ROW_HEIGHT
      const left = (span.start / MINIMAP_MAX_COLUMNS) * width
      const right = ((span.end + 1) / MINIMAP_MAX_COLUMNS) * width
      ctx.fillRect(left, y, Math.max(1, right - left), MINIMAP_ROW_HEIGHT - 1)
    }
  }, [viewRef])

  /** Reposition the viewport slider from the editor's scroll state. */
  const drawBand = useCallback((): void => {
    const view = viewRef.current
    const container = containerRef.current
    const band = bandRef.current
    if (view === null || container === null || band === null) return
    const scroller = view.scrollDOM
    const box = viewportBand(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight, container.clientHeight)
    band.style.top = `${box.top}px`
    band.style.height = `${box.height}px`
  }, [viewRef])

  /** (Re)bind to the live view and refresh both layers. Registered into the
   *  host's `syncRef`: called once per view creation and per doc change. */
  const sync = useCallback((): void => {
    const view = viewRef.current
    const bound = boundRef.current
    if (view !== null && (bound === null || bound.view !== view)) {
      bound?.detach()
      const onScroll = (): void => { bandBatcher.schedule(drawBand) }
      view.scrollDOM.addEventListener('scroll', onScroll)
      boundRef.current = { view, detach: () => { view.scrollDOM.removeEventListener('scroll', onScroll) } }
    }
    inkBatcher.schedule(drawInk)
    bandBatcher.schedule(drawBand)
  }, [viewRef, drawInk, drawBand, inkBatcher, bandBatcher])

  // The strip renders into a display:none editor while a markdown/html/jsonl
  // preview is up? No — the host unmounts it there; but a PARKED tab body
  // (retainTab moves the node) keeps the strip mounted with a stale box.
  // Resize events cover both the parked-tab reveal and window resizes.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onResize = (): void => {
      inkBatcher.schedule(drawInk)
      bandBatcher.schedule(drawBand)
    }
    const observers: Array<() => void> = []
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(onResize)
      resize.observe(container)
      observers.push(() => { resize.disconnect() })
    }
    window.addEventListener('resize', onResize)
    // The wheel is redirected to the editor (the strip itself never
    // scrolls), which needs preventDefault — React's onWheel is passive, so
    // this one listener is native and non-passive.
    const onWheel = (event: WheelEvent): void => {
      const view = viewRef.current
      if (view === null) return
      event.preventDefault()
      view.scrollDOM.scrollTop += event.deltaY
      view.requestMeasure()
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    syncRef.current = sync
    sync()
    return () => {
      syncRef.current = null
      container.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', onResize)
      for (const dispose of observers) dispose()
      boundRef.current?.detach()
      boundRef.current = null
      inkBatcher.dispose()
      bandBatcher.dispose()
    }
  }, [sync, drawInk, drawBand, inkBatcher, bandBatcher, syncRef, viewRef])

  // A scheme flip repaints the ink in the new palette (the band recolors
  // through the re-rendered class).
  useEffect(() => {
    inkBatcher.schedule(drawInk)
  }, [dark, inkBatcher, drawInk])

  /** Press = jump (center-aligned); a drag keeps following the pointer. */
  const jumpToPointer = useCallback((clientY: number): void => {
    const view = viewRef.current
    const container = containerRef.current
    if (view === null || container === null) return
    const rect = container.getBoundingClientRect()
    const scrollTop = scrollTopForPointer(clientY - rect.top, container.clientHeight, view.scrollDOM.scrollHeight, view.scrollDOM.clientHeight)
    view.scrollDOM.scrollTop = scrollTop
    // A plain scrollTop write on the editor's own scroller can never touch
    // anything outside the editor (the scrollIntoView pitfall — see
    // TextEditor.tsx); the fresh measure is what moves the virtualized
    // viewport to the new position promptly.
    view.requestMeasure()
    bandBatcher.schedule(drawBand)
  }, [viewRef, bandBatcher, drawBand])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    event.preventDefault()
    const container = containerRef.current
    try {
      container?.setPointerCapture(event.pointerId)
    } catch {
      // jsdom (and a pointer that vanished mid-event): dragging just won't
      // capture — the initial jump below still happened.
    }
    draggingRef.current = true
    jumpToPointer(event.clientY)
  }, [jumpToPointer])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    jumpToPointer(event.clientY)
  }, [jumpToPointer])

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      containerRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // The capture was already gone — nothing to release.
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`${css.editorMinimap} ${dark ? css.editorMinimapDark : css.editorMinimapLight}`}
      data-minimap=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <canvas ref={canvasRef} className={css.editorMinimapCanvas} aria-hidden />
      <div ref={bandRef} className={css.editorMinimapBand} data-minimap-band="" aria-hidden />
    </div>
  )
}
