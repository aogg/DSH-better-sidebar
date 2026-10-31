/**
 * The editor's git-blame ANNOTATION column (PhpStorm's Annotate view), hung
 * off the line-number gutter's own context menu. The same restraint rules as
 * the uncommitted-change gutter apply (see editor-git-gutter.ts): a plain
 * text cell per line — short hash, author, day stamp — in the gutter's own
 * tertiary ink. No badges, no animation, no gradient; hovering a cell shows
 * the commit's full info through the SAME hoverTooltip the gutter already
 * carries (activated explicitly for the pointer's line, since CodeMirror's
 * hover detection only watches the content area), and clicking a cell copies
 * the full commit hash.
 *
 * Data rules:
 *  - The column renders only what a StateField carries; the React side
 *    fetches the whole file's blame ONCE per (file, save revision) through
 *    the existing `git.blame` range API — one git process for the whole
 *    column, never per-line requests, and only after the user explicitly
 *    turned the view on (never on file open).
 *  - Rows go stale while the user types (git blamed the saved bytes); the
 *    next save bumps the revision and re-reads, exactly like the uncommitted
 *    gutter's own invalidation contract.
 *  - An empty blame answer (not a repository, untracked file, git failure)
 *    is the React side's cue to flip the toggle back off and surface the
 *    friendly notice — the column itself just stays empty.
 */
import { Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, GutterMarker, activateHover, closeHoverTooltips, gutter } from '@codemirror/view'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitBlameLine } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Structural class of the annotation gutter (also the DOM hook the event
 *  handlers resolve cells through). */
export const BLAME_GUTTER_CLASS = 'cm-dsh-blame-gutter'

/** Whether a blame row points at a commit git cannot name yet (the worktree
 *  edit — blame answers all-zero hashes for it). */
export function isUncommittedHash(hash: string): boolean {
  return /^0+$/.test(hash)
}

/** `MM-DD` within the current year, `YYYY-MM-DD` across a year boundary —
 *  the day stamp the compact cells carry (the tooltip shows the full time). */
function stampDay(iso: string): string {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const date = new Date(then)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === new Date().getFullYear() ? md : `${date.getFullYear()}-${md}`
}

/** One cell's compact text: `a1b2c3d author 03-04`; a not-yet-committed line
 *  reads as the localized 「未提交」 instead of a zero hash. */
function blameCellText(entry: GitBlameLine): string {
  if (isUncommittedHash(entry.hash)) return t('editorBlamePending')
  const parts = [entry.hash.slice(0, 7)]
  if (entry.author !== '') parts.push(entry.author)
  const day = stampDay(entry.date)
  if (day !== '') parts.push(day)
  return parts.join(' ')
}

// ── CodeMirror plumbing ─────────────────────────────────────────────────────

const setBlameAnnotations = StateEffect.define<ReadonlyMap<number, GitBlameLine>>()

/** The whole-file blame answer, as line number → row (empty while loading). */
const blameAnnotationsField = StateField.define<ReadonlyMap<number, GitBlameLine>>({
  create: () => new Map(),
  update: (value, transaction) => {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(setBlameAnnotations)) next = effect.value
    }
    return next
  },
})

/** Marker carrying one line's annotation cell (the full row it renders is
 *  what equality compares, so an updated blame re-renders the column). */
class BlameCellMarker extends GutterMarker {
  constructor(private readonly text: string, private readonly pending: boolean) {
    super()
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof BlameCellMarker && other.text === this.text && other.pending === this.pending
  }

  override toDOM(): Node {
    const cell = document.createElement('div')
    cell.className = this.pending
      ? `${css.editorBlameCell ?? ''} ${css.editorBlameCellPending ?? ''}`
      : css.editorBlameCell ?? ''
    cell.textContent = this.text
    return cell
  }
}

const blameGutter = gutter({
  class: `${css.editorBlameGutter ?? ''} ${BLAME_GUTTER_CLASS}`,
  lineMarker: (view, block) => {
    const map = view.state.field(blameAnnotationsField)
    if (map.size === 0) return null
    const entry = map.get(view.state.doc.lineAt(block.from).number)
    if (entry === undefined) return null
    return new BlameCellMarker(blameCellText(entry), isUncommittedHash(entry.hash))
  },
  lineMarkerChange: update => update.startState.field(blameAnnotationsField) !== update.state.field(blameAnnotationsField),
  // While the answer is in flight (and for lines git could not attribute)
  // a spacer keeps the column's width reserved — the code never shifts
  // sideways when the annotations arrive.
  initialSpacer: () => new BlameCellMarker('', true),
})

/**
 * Push one whole-file blame answer into a live view (no-op without the
 * annotation extensions — e.g. right after a file switch rebuilt the view).
 */
export function applyGitBlameAnnotations(view: EditorView, rows: ReadonlyMap<number, GitBlameLine>): void {
  if (!view.state.field(blameAnnotationsField, false)) return
  view.dispatch({ effects: setBlameAnnotations.of(rows) })
}

/**
 * The annotation extensions for one view (empty = the column is off). The
 * event handlers map a pointer position over the column back to its line via
 * `posAtCoords` (the gutter shares the content's line geometry): hovering
 * shows the full-info tooltip through the gutter's own hoverTooltip, a
 * mousedown copies the full hash.
 */
export function blameAnnotationExtensions(on: boolean): Extension[] {
  if (!on) return []
  let tooltipLine = -1
  return [
    blameAnnotationsField,
    blameGutter,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        const target = event.target
        if (!(target instanceof Element) || target.closest(`.${BLAME_GUTTER_CLASS}`) === null) {
          if (tooltipLine >= 0) {
            // Leaving the column closes the tooltip the built-in hover flow
            // would keep open (explicit activation does not auto-close).
            tooltipLine = -1
            view.dispatch({ effects: closeHoverTooltips })
          }
          return false
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        const line = view.state.doc.lineAt(pos)
        if (line.number === tooltipLine) return false
        const map = view.state.field(blameAnnotationsField, false)
        if (map === undefined || map.size === 0 || !map.has(line.number)) return false
        tooltipLine = line.number
        activateHover(view, line.from, 1)
        return false
      },
      mousedown(event, view) {
        const target = event.target
        if (!(target instanceof Element) || target.closest(`.${BLAME_GUTTER_CLASS}`) === null) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        const map = view.state.field(blameAnnotationsField, false)
        const entry = map?.get(view.state.doc.lineAt(pos).number)
        if (entry === undefined || isUncommittedHash(entry.hash)) return false
        // A click is a copy; swallowing it also keeps the editor from
        // treating the gutter press as a selection gesture.
        event.preventDefault()
        void writeClipboard(entry.hash)
        return true
      },
    }),
  ]
}

/**
 * A Compartment holding the annotation extensions. Created once per editor
 * view; flipping the toggle dispatches `reconfigure(on)` so the document,
 * undo history, scroll and keymaps survive.
 */
export class CmBlameAnnotationsCompartment {
  private readonly compartment = new Compartment()

  /** `of(...)` payload for EditorState.create. */
  of(on: boolean): Extension {
    return this.compartment.of(blameAnnotationExtensions(on))
  }

  /** Reconfigure for a toggle flip (or a new file). */
  reconfigure(on: boolean): ReturnType<Compartment['reconfigure']> {
    return this.compartment.reconfigure(blameAnnotationExtensions(on))
  }
}
