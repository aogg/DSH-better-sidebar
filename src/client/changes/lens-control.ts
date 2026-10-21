/**
 * The imperative fold handle the changes tab's header buttons drive.
 *
 * The「全部展开」/「全部收起」buttons live in the tab's 36px header, while
 * every fold axis (commit disclosures, directory rows, per-file diff folds)
 * lives INSIDE the mounted lens. Rather than lifting four unrelated fold
 * states into the tab, each lens exposes this one handle through
 * `forwardRef` + `useImperativeHandle`; the tab holds a single ref and hands
 * it to whichever lens is mounted. A lens switch re-arms the ref with the new
 * lens's handle (React detaches the outgoing one on unmount), so a click
 * can never reach an unmounted lens — at worst the ref reads null and the
 * click is a harmless no-op, which is also the empty-content case.
 */
export interface LensControl {
  /** Open every fold axis of the lens (the state each lens already owns). */
  expandAll(): void
  /** Close every fold axis of the lens, down to the leaves. */
  collapseAll(): void
}
