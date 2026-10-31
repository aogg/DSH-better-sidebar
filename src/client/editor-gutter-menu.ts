/**
 * The editor line-number gutter's context menu entry point: right-clicking a
 * line number opens the plugin's own menu (Word Wrap / Annotate with Git
 * Blame) instead of the browser's. The extension only DETECTS the gesture —
 * the menu itself is React (the shared `Menu` primitive, portaled and
 * free-positioned through `getAnchorRect`, the same pattern the changes
 * tab's row menus use); this module hands the click coordinates to the
 * owner through one callback and swallows nothing else.
 *
 * The native menu is intercepted ONLY over the line numbers
 * (`.cm-lineNumbers`): a right-click on the code, the change bar or the
 * blame column keeps the browser's own spelling/selection menu.
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Build the gutter context-menu extension. `onOpen` receives the pointer
 * position (viewport coordinates, ready for `DOMRect` anchoring); it stays
 * open-event-only — the extension never renders anything of its own.
 */
export function editorGutterContextMenu(onOpen: (x: number, y: number) => void): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event: MouseEvent): boolean {
      // The line-number gutter only; `closest` covers the number cells and
      // their children (the markers the git tint hangs off them).
      const target = event.target
      if (!(target instanceof Element) || target.closest('.cm-lineNumbers') === null) return false
      event.preventDefault()
      onOpen(event.clientX, event.clientY)
      // Handled: CodeMirror's own content handlers have nothing to add to a
      // gutter context event.
      return true
    },
  })
}
