/**
 * The sidebar's 设置 page (the「设置」guide capsule / + menu entry opens here):
 * the Side card preferences section rendered as a real sidebar page — the same
 * component the hero start page's settings panel mounts, fed by the same shared
 * store, so every surface shows and writes the one settings document.
 *
 * The page is a plain scroll container around the section: the section owns its
 * groups, cards and popups, and the native pane provides the page chrome.
 */
import type { ReactNode } from 'react'
import type { Context } from '../context-types.ts'
import { SideCardSection } from './SideCardSection.tsx'
import type { SidebarStore } from './state.ts'
import type { BetterSidebarService } from './service.ts'
import css from './settings-page.module.css'

/** The page body (exported for tests; the descriptor's component wraps it). */
export function SettingsPage(props: { ctx: Context; store: SidebarStore }): ReactNode {
  const service = props.ctx.get('betterSidebar') as BetterSidebarService | undefined
  if (service === undefined) return null
  return (
    <div className={css.page} data-dsh-settings-page="">
      <SideCardSection store={props.store} service={service} />
    </div>
  )
}
