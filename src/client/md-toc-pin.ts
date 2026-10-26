/**
 * The module-level pin store behind the md outline's 「固定展开」 button.
 * The pinned state is a PLUGIN-GLOBAL preference, not per-preview state: one
 * small external store here lets every mounted MdToc instance (any number of
 * md previews can be open at once) render the same answer — toggling the pin
 * in one preview re-renders the others in the same tick. Persistence is the
 * caller's job: the toggling component writes `tocPinned` through its own
 * lazily-created {@link createPrefsWriter} (the factory rule — no
 * module-level writer singleton), while this module only owns the in-memory
 * value, the fan-out, and the ONE settings read that seeds the store on the
 * first mount of a page load. Any read failure silently keeps `false`, the
 * same fallback posture as `loadPrefs`.
 */
import { api } from './api.ts'
import { parsePrefs } from './prefs.ts'

/** A store subscriber; invoked after the value changed. */
type PinListener = () => void

let pinned = false
const listeners = new Set<PinListener>()
/** Set once a USER toggle happened; the seed read must not override it. */
let userTouched = false
/** Guards the seed read: every mount of the page shares ONE settings.get. */
let seedPromise: Promise<void> | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * The store's current value (the `useSyncExternalStore` snapshot).
 */
export function getMdTocPinned(): boolean {
  return pinned
}

/**
 * Subscribe to pin changes; returns the unsubscribe function.
 */
export function subscribeMdTocPin(listener: PinListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Update the store (all mounted MdToc instances see it immediately) and mark
 * the value as user-authored so the async seed read can never overwrite it.
 * The caller persists the preference itself.
 */
export function setMdTocPinned(next: boolean): void {
  userTouched = true
  if (pinned === next) return
  pinned = next
  notify()
}

/**
 * Seed the store from the persisted preference, ONCE per page load (the
 * module-level promise guard — every MdToc mount calls this, only the first
 * call reaches the wire). Only `true` is ever written into the store, so a
 * late-resolving seed can not unpin a toggle that already happened; a failed
 * read (route rejected, malformed value) silently keeps the default `false`.
 */
export function seedMdTocPinPref(): void {
  if (seedPromise !== null) return
  seedPromise = (async () => {
    try {
      const view = await api.settingsGet()
      if (!userTouched && parsePrefs(view.value).tocPinned) {
        pinned = true
        notify()
      }
    } catch {
      // Transport/fence rejection or a malformed response: keep false.
    }
  })()
}

/**
 * Test-only reset: drops the value, the listeners and the seed guard so a
 * spec starts from the pristine store. Not used by production code.
 */
export function resetMdTocPinStoreForTests(): void {
  pinned = false
  listeners.clear()
  userTouched = false
  seedPromise = null
}
