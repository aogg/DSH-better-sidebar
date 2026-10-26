/**
 * The markdown preview's table of contents: a sticky zero-height bar keeping
 * a small "outline" button — plus a pin button beside it — at the top-right
 * of the preview's scroll container, visible once the document has at least
 * {@link TOC_MIN_HEADINGS} headings. The outline button opens a popover
 * panel (h1–h6 collected from the rendered DOM — so headings inside HTML
 * runs count too); clicking an entry expands any collapsed `<details>`
 * ancestor, smooth-scrolls the heading into view and flashes it. The scan
 * re-runs through a MutationObserver so late content (lazy mermaid chunk,
 * shiki highlighting) is picked up.
 *
 * Pin semantics: the pin button toggles a PROJECT-GLOBAL preference
 * (`tocPinned`, see {@link ./md-toc-pin.ts}) — while pinned the panel stays
 * expanded on every md preview at once (the store notifies all mounted
 * instances in the same tick) and survives files, sessions and restarts.
 * Pinned, nothing collapses the panel: not Esc, not an outside pointerdown,
 * not a jump; the outline button's one gesture there is unpin + collapse.
 * Both buttons sit behind the same minimum-headings gate, so a short
 * document never shows them (a pin made elsewhere never opens a panel on
 * one).
 *
 * Scroll follow: while the panel is visible (popover OR pinned), a passive
 * rAF-throttled scroll listener on the preview container recomputes the
 * active heading (the last one above a line one-third down the viewport,
 * floor 72px; bottom-of-scroll forces the last entry), highlights its entry
 * and centers that entry in the panel's own scroll — panel scrolling never
 * writes back into the preview.
 *
 * Mount contract: render as a DIRECT child of the scroll container it
 * outlines. The container is discovered through the bar's own DOM position
 * (`parentElement`), not a passed ref — React attaches a parent host
 * element's ref only after its children's layout effects have run, so a
 * ref-based container read here would see null at mount and never re-run.
 * The bar itself renders unconditionally (zero height, pointer-events
 * none), so it never affects the preview layout.
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
  IconListPenOutlineRegular,
  IconPinFillRegular,
  IconPinOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { createPrefsWriter, type PrefsWriter } from './prefs.ts'
import {
  getMdTocPinned,
  seedMdTocPinPref,
  setMdTocPinned,
  subscribeMdTocPin,
} from './md-toc-pin.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Fewer headings than this and the button stays hidden (no outline value). */
export const TOC_MIN_HEADINGS = 3

/**
 * The scroll-follow threshold line sits this fraction of the container's
 * viewport height below its top — but never higher than this floor, so a
 * short preview still reads past its first heading.
 */
const ACTIVE_LINE_MIN_PX = 72

/** One collected outline entry; `el` is the live rendered heading element. */
interface TocEntry {
  level: number
  text: string
  el: HTMLElement
}

/** The signature used to skip no-op rescans (identity-safe setState guard). */
function signatureOf(entries: readonly TocEntry[]): string {
  return entries.map((entry) => `${entry.level}:${entry.text}`).join('\n')
}

/**
 * The active entry's index for the scroll follow: the LAST heading whose top
 * has crossed the threshold line (headings arrive in document order), the
 * first entry when none has, and the last one once the container sits at its
 * bottom. Headings hidden inside a collapsed `<details>` have a zero rect —
 * they sit at no scroll position and never claim the highlight.
 */
function activeHeadingIndex(container: HTMLElement, entries: readonly TocEntry[]): number {
  if (entries.length === 0) return -1
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
    return entries.length - 1
  }
  const line = container.getBoundingClientRect().top
    + Math.max(container.clientHeight / 3, ACTIVE_LINE_MIN_PX)
  let active = 0
  let index = 0
  for (const entry of entries) {
    const rect = entry.el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (rect.top <= line) active = index
    index++
  }
  return active
}

export function MdToc(): ReactNode {
  const barRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<TocEntry[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const signatureRef = useRef('')
  // The project-global pin (one store shared by every mounted MdToc) and the
  // per-instance preference writer, created lazily on the first toggle — the
  // factory rule forbids a module-level writer singleton.
  // The store is a plain boolean snapshot and the persisted-preference seed
  // only runs in the client layout effect below, so server rendering reads
  // the same getter (always-false default) — pass it as getServerSnapshot.
  const pinned = useSyncExternalStore(subscribeMdTocPin, getMdTocPinned, getMdTocPinned)
  const writerRef = useRef<PrefsWriter | null>(null)

  useLayoutEffect(() => {
    // One settings.get per page load seeds the store from the persisted
    // preference; safe to call from every mount.
    seedMdTocPinPref()
    // The bar's own host ref is attached before this effect runs; the scroll
    // container is its parent by the mount contract above.
    const container = barRef.current?.parentElement ?? null
    if (container === null) return
    const scan = (): void => {
      const found: TocEntry[] = []
      for (const el of container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
        const text = (el.textContent ?? '').trim()
        if (text === '') continue
        found.push({ level: Number(el.tagName.charAt(1)), text, el })
      }
      const signature = signatureOf(found)
      if (signature === signatureRef.current) return
      signatureRef.current = signature
      setEntries(found)
    }
    scan()
    const observer = new MutationObserver(() => { scan() })
    observer.observe(container, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  // The preference writer lives as long as this instance does; dispose drops
  // its cached revision so a dead preview never queues another write.
  useLayoutEffect(() => () => { writerRef.current?.dispose() }, [])

  /** Update the global pin store (every md preview re-renders) and persist
   *  the preference in the background; the writer never throws. */
  const applyPin = (next: boolean): void => {
    setMdTocPinned(next)
    if (writerRef.current === null) writerRef.current = createPrefsWriter(api)
    void writerRef.current({ tocPinned: next })
  }

  // Esc / an outside pointerdown close the POPOVER only — a pinned panel is
  // exactly the "stays open" promise, so both dismissals stand down while
  // pinned (unpinning is the pin button's or the toggle's explicit job).
  useLayoutEffect(() => {
    if (!open || pinned) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      const bar = barRef.current
      if (bar !== null && bar.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, pinned])

  const expanded = pinned || open

  // Scroll follow — armed exactly while the panel is visible (popover or
  // pinned): a passive listener recomputes the active entry at most once per
  // frame; entry rescans recompute too (the entries dependency).
  useLayoutEffect(() => {
    if (!expanded) return
    const container = barRef.current?.parentElement ?? null
    if (container === null) return
    let frame = 0
    const recompute = (): void => {
      frame = 0
      const next = activeHeadingIndex(container, entries)
      setActiveIndex((previous) => (previous === next ? previous : next))
    }
    const onScroll = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(recompute)
    }
    recompute()
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      container.removeEventListener('scroll', onScroll)
    }
  }, [expanded, entries])

  /** Roll the panel's own scroll so entry `index` rides the panel's vertical
   *  middle. Direct assignment (no smooth): the follow must track continuous
   *  scrolling. The panel is the items' offsetParent (absolute panel, static
   *  children), so `offsetTop` is already panel-relative. */
  const centerPanelItem = (index: number): void => {
    if (index < 0) return
    const panel = panelRef.current
    const item = panel?.children[index]
    if (panel === null || !(item instanceof HTMLElement)) return
    panel.scrollTop = item.offsetTop - (panel.clientHeight - item.offsetHeight) / 2
  }

  // The active highlight doubles as the follow: whenever the computed entry
  // moves, keep it vertically centered in the panel.
  useLayoutEffect(() => {
    if (!expanded) return
    centerPanelItem(activeIndex)
  }, [activeIndex, expanded])

  const jump = (entry: TocEntry, index: number): void => {
    entry.el.closest('details:not([open])')?.setAttribute('open', '')
    entry.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const el = entry.el
    const flash = css.tocFlash
    if (flash !== undefined) {
      el.classList.add(flash)
      window.setTimeout(() => { el.classList.remove(flash) }, 1200)
    }
    // The jump's own scroll feed recomputes the active entry, but center the
    // clicked entry right away — the smooth scroll takes a moment to get
    // there and the panel should lead, not trail. Pinned, the panel stays.
    setActiveIndex(index)
    centerPanelItem(index)
    if (!pinned) setOpen(false)
  }

  const showOutline = entries.length >= TOC_MIN_HEADINGS
  return (
    <div className={css.tocBar} ref={barRef}>
      {expanded && showOutline && (
        <div className={css.tocPanel} ref={panelRef} data-dsh-md-toc-panel>
          {entries.map((entry, index) => (
            <button
              key={index}
              type="button"
              className={css.tocItem}
              data-level={entry.level}
              data-active={index === activeIndex ? 'true' : 'false'}
              title={entry.text}
              onClick={() => { jump(entry, index) }}
            >
              <span className={css.tocItemLevel}>{entry.level}</span>
              <span className={css.tocItemText}>{entry.text}</span>
            </button>
          ))}
        </div>
      )}
      {showOutline && (
        <>
          <button
            type="button"
            className={css.tocPinButton}
            data-pinned={String(pinned)}
            aria-pressed={pinned}
            aria-label={pinned ? t('tocUnpin') : t('tocPin')}
            title={pinned ? t('tocUnpin') : t('tocPin')}
            onClick={() => { applyPin(!pinned) }}
          >
            {pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
          </button>
          <button
            type="button"
            className={css.tocButton}
            data-dsh-md-toc=""
            aria-label={t('toc')}
            title={t('toc')}
            aria-expanded={expanded}
            onClick={() => {
              // Pinned, one gesture: unpin AND collapse — the outline button
              // keeps reading as a plain toggle in either state.
              if (pinned) {
                applyPin(false)
                setOpen(false)
              } else {
                setOpen(!open)
              }
            }}
          >
            <IconListPenOutlineRegular />
          </button>
        </>
      )}
    </div>
  )
}
