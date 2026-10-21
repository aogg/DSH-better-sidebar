/**
 * Wire types shared by the host's `fs.contentSearch` route and the client's
 * `api.fsContentSearch` — the LINE-LEVEL v2 content-search contract (the
 * PhpStorm-style search page's foundation).
 *
 * Why a dedicated module: the client bundle must not import host modules that
 * pull in `node:` builtins (fs/path), so the payload shapes live in this
 * dependency-free file and both sides import it as types (the same pattern
 * sidechat-core.ts / fs-batch.ts already use).
 *
 * Matching semantics ride three loose booleans on the request payload
 * (`caseSensitive` / `wholeWord` / `regex`, default false each — i.e. the v1
 * literal case-insensitive search). The resolved combination is applied
 * identically by BOTH engines (rg's argv and the plain walk's matcher), so a
 * hit's `column`/`length` never depends on which engine answered.
 */

/** The three match-mode booleans, exactly as the wire carries them. */
export interface ContentSearchMatchOptions {
  /** Case-sensitive matching (default false = case-insensitive). */
  caseSensitive?: boolean
  /** Whole-word matching: both edges of a hit must abut a non-word character
   *  (JS `\w` negation, line start/end counting as boundaries). */
  wholeWord?: boolean
  /** Interpret `query` as a regular expression (default false = literal).
   *  The host compiles it once per search; an uncompilable pattern is a
   *  `bad-request` from the route. */
  regex?: boolean
}

/** One hit on ONE line: `line` is 1-based, `column` the 0-based index of the
 *  hit's first character and `length` its length — both in JS string indices
 *  of the DECODED line (`text`), never byte offsets. `text` is the full line
 *  without its line terminator, leading whitespace kept. `before`/`after`
 *  carry up to two context lines each (same file, verbatim, may be shorter
 *  at the file's edges); two adjacent hits share their context lines. */
export interface ContentLineHit {
  line: number
  column: number
  length: number
  text: string
  before: string[]
  after: string[]
}

/** One file's grouped hits. `path` is root-relative and '/'-separated (the
 *  same form the v1 file list used). `count` is the file's TOTAL number of
 *  matching hits, which may exceed `hits.length` when the per-file hit
 *  budget cut the payload — `truncated` marks exactly that. */
export interface ContentFileHit {
  path: string
  count: number
  truncated: boolean
  hits: ContentLineHit[]
}

/** The v2 route result: files sorted by path, `truncated` true when any
 *  budget (per-file hits, total hits, listed files, visited entries, engine
 *  stream) cut the answer short. */
export interface ContentSearchResult {
  matches: ContentFileHit[]
  truncated: boolean
}
