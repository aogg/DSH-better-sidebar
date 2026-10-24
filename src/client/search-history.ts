/**
 * The search page's persistent query history: localStorage key
 * `dsh-sidebar:search-history:v1` (the `dsh-sidebar:*` key family), shared by
 * every open search tab across tabs and sessions (docs/plans/2026-10-21
 * -find-in-files-page.md §4.3).
 *
 * Rules (all pinned by `tests/search-history.spec.ts`):
 * - Entries are `{ query, include, exclude, gitFrom?, at }`; ONLY an actual
 *   submit is recorded (toggle states never ride the history).
 * - Dedup key = `query + include + exclude + gitFrom` (arrays in order, joined
 *   with `\0`; an absent/empty gitFrom keys as '' — old entries dedup
 *   unchanged): a re-submit deletes the old entry and re-inserts at the top.
 * - Newest first, capped at {@link SEARCH_HISTORY_MAX} (20); the tail is lost.
 * - Every write dispatches a synthetic `storage` event on `window` so
 *   already-open dropdowns in THIS document refresh; real `storage` events
 *   (other documents, same origin) arrive through the same listener.
 * - localStorage failures (privacy mode, quota) and corrupt JSON degrade
 *   silently to an in-memory list for this page's lifetime.
 */

/** The storage key (design-doc-pinned value; the repo's `dsh-sidebar:*` family). */
export const SEARCH_HISTORY_KEY = 'dsh-sidebar:search-history:v1'

/** Newest-first entry cap: the tail is dropped beyond this. */
export const SEARCH_HISTORY_MAX = 20

/** One recorded submit: the three form fields + the commit timestamp.
 *  `gitFrom` is the「git 起点」the submit ran with (''/absent = not
 *  enabled); it is OPTIONAL so stored entries from before the field exist
 *  keep reading — absence IS "not enabled", never a corrupt row. */
export interface SearchHistoryEntry {
  query: string
  include: string[]
  exclude: string[]
  gitFrom?: string
  at: number
}

/** In-memory fallback when `localStorage` is unavailable (read OR write). */
let memoryFallback: SearchHistoryEntry[] = []

/**
 * The dedup key of one entry (also the remove identity together with `at`):
 * the query plus both chip lists in their exact order plus the git 起点,
 * `\0`-joined so no realistic query/chip text can forge a collision. An
 * entry without `gitFrom` keys identically to one with `''` — old and new
 * shapes dedup as the same "not enabled" submit.
 */
export function historyKeyOf(entry: Pick<SearchHistoryEntry, 'query' | 'include' | 'exclude' | 'gitFrom'>): string {
  return `${entry.query}\u0000${entry.include.join('\u0000')}\u0000${entry.exclude.join('\u0000')}\u0000${entry.gitFrom ?? ''}`
}

/** Shape-check one parsed entry (corrupt rows are dropped, not trusted). */
function entryOf(value: unknown): SearchHistoryEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<SearchHistoryEntry>
  if (typeof candidate.query !== 'string' || candidate.query === '') return undefined
  if (!Array.isArray(candidate.include) || !candidate.include.every(item => typeof item === 'string')) return undefined
  if (!Array.isArray(candidate.exclude) || !candidate.exclude.every(item => typeof item === 'string')) return undefined
  // A non-string (or empty) gitFrom reads as "not enabled" — the field is
  // simply absent from the parsed entry, exactly like the pre-gitFrom rows.
  const gitFrom = typeof candidate.gitFrom === 'string' && candidate.gitFrom !== '' ? candidate.gitFrom : undefined
  return {
    query: candidate.query,
    include: candidate.include,
    exclude: candidate.exclude,
    ...(gitFrom === undefined ? {} : { gitFrom }),
    at: typeof candidate.at === 'number' && Number.isFinite(candidate.at) ? candidate.at : 0,
  }
}

/** Read the whole history (newest first). Corrupt JSON resets to empty. */
export function readSearchHistory(): SearchHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY)
    if (raw === null) return memoryFallback
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return memoryFallback
    return parsed.map(entryOf).filter((entry): entry is SearchHistoryEntry => entry !== undefined)
  } catch {
    return memoryFallback
  }
}

/** Persist the list; falls back to memory when the write (or the storage
 *  access itself) fails. Always re-notifies same-document listeners. */
function writeSearchHistory(entries: SearchHistoryEntry[]): void {
  memoryFallback = entries
  try {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(entries))
  } catch {
    // Privacy mode / quota: the in-memory copy keeps this page working.
  }
  notifySearchHistory()
}

/**
 * Record one submit: dedup by {@link historyKeyOf}, move to front, cap the
 * tail. Returns the resulting list. An empty `gitFrom` (or none) is stored
 * as "field absent" so the entry reads identically to the pre-gitFrom shape.
 */
export function upsertSearchHistory(entry: Pick<SearchHistoryEntry, 'query' | 'include' | 'exclude' | 'gitFrom'>): SearchHistoryEntry[] {
  const key = historyKeyOf(entry)
  const rest = readSearchHistory().filter(candidate => historyKeyOf(candidate) !== key)
  const gitFrom = entry.gitFrom ?? ''
  const next = [
    {
      query: entry.query,
      include: [...entry.include],
      exclude: [...entry.exclude],
      ...(gitFrom === '' ? {} : { gitFrom }),
      at: Date.now(),
    },
    ...rest,
  ]
  writeSearchHistory(next.slice(0, SEARCH_HISTORY_MAX))
  return readSearchHistory()
}

/**
 * Remove one entry (single-row × in the dropdown): matched by the entry's
 * dedup key AND its `at` stamp, so a same-shaped entry re-added a moment
 * earlier by another tab survives.
 */
export function removeSearchHistory(entry: SearchHistoryEntry): SearchHistoryEntry[] {
  const key = historyKeyOf(entry)
  writeSearchHistory(readSearchHistory().filter(candidate => !(historyKeyOf(candidate) === key && candidate.at === entry.at)))
  return readSearchHistory()
}

/** Same-document change notification: a synthetic `storage` event (the same
 *  shape a sibling document's write produces), so one listener kind covers
 *  both same-tab and cross-tab refreshes. */
function notifySearchHistory(): void {
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: SEARCH_HISTORY_KEY }))
  } catch {
    // A host without the StorageEvent constructor still has the in-memory
    // list; the dropdown just misses same-document live refresh.
  }
}

/**
 * Subscribe to history changes (own writes AND other documents' writes).
 * Returns the unsubscribe disposer.
 */
export function subscribeSearchHistory(listener: () => void): () => void {
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener('storage', listener) }
}
