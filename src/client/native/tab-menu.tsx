/**
 * The copy-path rows this plugin appends to the HOST's native tab context
 * menu.
 *
 * Right-clicking a tab chip in DSH's native right Sidebar (dockkit) opens the
 * host's own menu: a close row followed by everything registered on the
 * `sidebar.right.tab.menu.item` slot. The slot is declared `kind: "list"` —
 * every registration coexists, so these rows never collide with another
 * implementation — and `scope: "session"`, so the slot framework hands the
 * SEAT session id to `inject` and this component receives it as `sessionId`
 * (the session the column is drawn in, not necessarily the session a file
 * address names).
 *
 * The path comes from the tab's `contentId`: a file tab addresses
 * `dsh-resource://file/…` (parsed by `resource-address.ts`), a page tab
 * addresses `sidebar://<kind>`. Only a parseable file address with a
 * non-empty path renders rows — a page tab, an unparseable address, or the
 * workspace-root address adds NOTHING to the menu, which the host draws as a
 * normal (close-row-only) menu when the extras list is empty.
 *
 * The rows mirror the plugin's own TabBar menu exactly (`copyRelative` /
 * `copyAbsolute`, the copy glyph, `writeClipboard` then `dismiss`): the
 * relative row projects the address path against the session's live workspace
 * root (`useSessionRoot`) with `relativeTo`'s absolute fallback — the same
 * rule the FileTree row menu uses — and the absolute row copies the address
 * path verbatim.
 */
import type { ReactNode } from 'react'
import { IconCopyOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { t } from '../locales.ts'
import { relativeTo } from '../paths.ts'
import { parseFileAddress } from '../resource-address.ts'
import type { SidebarStore } from '../state.ts'
import { useSessionRoot } from '../use-session-root.ts'
import css from '../sidebar.module.css'

/** What the registration injects: the client context, the shared store, and the seat session id the slot framework hands over (`scope: "session"`). */
export interface NativeTabMenuInjected {
  readonly ctx: Context
  readonly store: SidebarStore
  readonly sessionId: string
}

/** The native tab record the host's menu was opened for (the slot's extras). */
export interface NativeTabMenuTab {
  readonly id: string
  readonly kind: string
  readonly contentId: string
  readonly title: string
}

/** The props {@link NativeTabMenuItems} receives (injected face + host extras). */
export interface NativeTabMenuProps extends NativeTabMenuInjected {
  readonly tab: NativeTabMenuTab
  /** Closes the host menu (the host hands it to `renderSlot` alongside `tab`). */
  readonly dismiss: () => void
}

/**
 * The host tab-menu's plugin rows: copy the right-clicked file's path,
 * relative to its session's workspace root or absolute. Rendered after the
 * host's own close row; renders nothing for a tab that is not a file.
 * @param props - the injected face plus the host's tab record and `dismiss`.
 * @returns the two menu rows, or `null` for a non-file tab.
 */
export function NativeTabMenuItems(props: NativeTabMenuProps): ReactNode {
  const file = parseFileAddress(props.tab.contentId)
  // The session the relative copy projects against: a session-scoped address
  // names its own content session (a tab can show ANOTHER session's file),
  // the same rule the native surface's `fileSessionIdOf` applies; anything
  // else resolves against the seat session.
  const cwdSessionId = file?.scope === 'session' && file.sessionId !== undefined
    ? file.sessionId
    : props.sessionId
  // Unconditional: React hook order must not depend on the tab shape, so the
  // session id is resolved and the root fetched BEFORE the empty-render check
  // below (a page tab simply resolves its own seat session's root for nothing).
  const cwd = useSessionRoot(props.ctx, cwdSessionId)
  // A page tab (`sidebar://…`), an unparseable address, or the workspace-root
  // address (empty path) has no path to copy: no rows at all.
  if (file === undefined || file.path === '') return null

  const copy = (text: string): void => {
    void writeClipboard(text)
    props.dismiss()
  }

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={css.nativeTabMenuItem}
        onClick={() => copy(relativeTo(cwd ?? '', file.path))}
      >
        <IconCopyOutlineRegular size={14} />
        {t('copyRelative')}
      </button>
      <button
        type="button"
        role="menuitem"
        className={css.nativeTabMenuItem}
        onClick={() => copy(file.path)}
      >
        <IconCopyOutlineRegular size={14} />
        {t('copyAbsolute')}
      </button>
    </>
  )
}
