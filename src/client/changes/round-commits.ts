/**
 * Git-add extraction for the changes tab's round-commits lens: folds the
 * session's append-only event log (`tool/call` + `tool/result` pairs) into one
 * record per bash call that (fuzzily) staged something with `git add` — the
 * evidence the lens cross-checks against the repository's own `git log` (which
 * commits did the staged files actually land in). Pure — no React, no DOM.
 *
 * Everything here is defensive: the `arguments` payload is model-emitted wire
 * data, the command line is arbitrary shell text, and a match is BEST EFFORT
 * by design (`git add` spelled through an alias, a script file, or `git -c
 * key=val add` simply produces no record rather than a wrong one).
 */
import type { SidebarSessionEvent } from '../../context-types.ts'
import { resultIsError, type ToolResultMessageLike } from './ops.ts'

/** One recognized `git add` execution. */
export interface GitAddRecord {
  /** Stable identity: the originating tool-call id. */
  readonly callId: string
  /** Unix epoch ms of the call; the result time when only that is known. */
  readonly time: number
  /** The raw command text (the `add -A` summary line prints it verbatim). */
  readonly command: string
  /** The call's working directory when the model named one. */
  readonly workdir?: string
  /** The path operands exactly as the command spelled them (flags excluded). */
  readonly paths: readonly string[]
  /** True when the command staged everything (`-A`/`--all`/`-u`/`.`): the file
   *  set cannot be enumerated from the command line. */
  readonly all: boolean
  /** True while the call has no result yet. */
  readonly running: boolean
  /** True when the result reported an error. */
  readonly isError: boolean
}

/** One file a commit touched (the lazy `gitCommitDiff` fallback parses these). */
export interface CommitFile { readonly path: string; readonly status: string }

/** Parse one tool-call arguments JSON body defensively (see ops.ts's twin). */
function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Strip one PAIR of surrounding quotes; the inner spelling stays verbatim. */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return token.slice(1, -1)
  }
  return token
}

/**
 * Split one command line into segments at the chaining operators. `||` must
 * precede `|` in the alternation so a two-char operator is never read as two
 * pipes; a quoted `&&` inside one word survives (best effort — the split is
 * lexical, not a shell parser).
 */
function commandSegments(command: string): string[] {
  return command.split(/&&|\|\||;|\n|\|/)
}

/** The fuzzy per-segment matcher: `git [-C <path>] add …`, extra whitespace
 *  and a quoted `-C` operand tolerated. `git commit`, `git add -h` (flag-only,
 *  still the `add` verb — but it stages nothing) and every non-add verb fall
 *  out naturally: `commit` fails the `add` token, `-h` leaves no operands. */
const ADD_SEGMENT = /^git(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))?\s+add(?:\s|$)/

/** Operands meaning "everything" rather than one path: the update/all flags,
 *  and the bare pathspecs `.` / `./` (git add . stages the whole tree). */
const ALL_TOKENS = new Set(['-A', '--all', '-u', '--update', '-A.', '.', './'])

/** One add segment's operands: the explicit paths and the "everything" mark. */
interface AddOperands { paths: string[]; all: boolean }

/**
 * Tokenize the text after `add` the way a shell would for this purpose:
 * whitespace separates tokens, a quoted run (single or double) belongs to one
 * token and keeps its inner spelling — quotes come OFF here, so the tokens
 * are already the operands as spelled.
 */
function tokenizeOperands(rest: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of rest) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t') {
      if (current !== '') tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current !== '') tokens.push(current)
  return tokens
}

/** Extract the operands of one matched `git add` segment. Value-taking flags
 *  (`--pathspec-from-file=…`) contribute nothing; after a bare `--` every
 *  remaining token is a path even when it starts with `-`. */
function parseAddSegment(segment: string): AddOperands | undefined {
  const trimmed = segment.trim()
  const match = ADD_SEGMENT.exec(trimmed)
  if (match === null) return undefined
  const operands: AddOperands = { paths: [], all: false }
  let pathsOnly = false
  for (const token of tokenizeOperands(trimmed.slice(match[0].length))) {
    if (pathsOnly) {
      operands.paths.push(token)
      continue
    }
    if (token === '--') {
      pathsOnly = true
      continue
    }
    if (token.startsWith('-')) {
      if (ALL_TOKENS.has(token)) operands.all = true
      continue
    }
    if (ALL_TOKENS.has(token)) {
      operands.all = true
      continue
    }
    operands.paths.push(token)
  }
  return operands
}

/** Fold one bash command's add segments into a single operand set (a chained
 *  `git add a && git add b` is one call and one record). */
function parseAddCommand(command: string): AddOperands | undefined {
  let found: AddOperands | undefined
  for (const segment of commandSegments(command)) {
    const operands = parseAddSegment(segment)
    if (operands === undefined) continue
    if (found === undefined) {
      found = { paths: [...operands.paths], all: operands.all }
      continue
    }
    found.all = found.all || operands.all
    for (const path of operands.paths) {
      if (!found.paths.includes(path)) found.paths.push(path)
    }
  }
  return found
}

/**
 * Fold a session event log into the bash calls that staged something with
 * `git add`, newest first. A `tool/call` seeds a running record; its
 * `tool/result` settles `running`/`isError` by callId (the same two logged
 * shapes ops.ts reads). Non-bash tools and commands without an add segment
 * produce nothing.
 * @param events - the session's append-only event log (oldest → newest).
 */
export function extractGitAdds(events: readonly SidebarSessionEvent[]): GitAddRecord[] {
  const byCall = new Map<string, GitAddRecord>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
      if (data.name !== 'bash' || typeof data.callId !== 'string') continue
      const args = parseArgs(typeof data.arguments === 'string' ? data.arguments : '')
      const command = args.command
      if (typeof command !== 'string' || command === '') continue
      const operands = parseAddCommand(command)
      if (operands === undefined) continue
      // An add with NO operands and no "everything" flag (`git add -h`, a
      // bare `git add`) stages nothing knowable: it falls out entirely.
      if (operands.paths.length === 0 && !operands.all) continue
      const workdir = typeof args.workdir === 'string' && args.workdir !== '' ? args.workdir : undefined
      byCall.set(data.callId, {
        callId: data.callId,
        time: event.time,
        command,
        ...(workdir !== undefined ? { workdir } : {}),
        paths: operands.paths,
        all: operands.all,
        running: true,
        isError: false,
      })
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: unknown }).message as ToolResultMessageLike | undefined
      if (message === undefined) continue
      const callId = message.source?.callId
      if (typeof callId !== 'string') continue
      const record = byCall.get(callId)
      if (record === undefined) continue
      byCall.set(callId, { ...record, running: false, isError: resultIsError(message) })
    }
  }
  return [...byCall.values()].sort((a, b) => b.time - a.time)
}

/**
 * Normalize one add operand for comparison against commit file rows: paired
 * quotes off, Windows separators folded to `/`, and an absolute path under one
 * of the candidate bases (the call's `workdir`, the session's `cwd`) reduced
 * to its relative tail. The comparison is case-insensitive on the base prefix
 * (Windows drive letters) but the kept tail keeps its own spelling. Best
 * effort: anything else passes through normalized.
 */
export function normalizeAddPath(raw: string, bases: readonly string[]): string {
  const candidate = stripQuotes(raw).replace(/\\/g, '/')
  const lowered = candidate.toLowerCase()
  for (const base of bases) {
    if (typeof base !== 'string' || base === '') continue
    const prefix = `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/`.toLowerCase()
    if (prefix !== '/' && lowered.startsWith(prefix)) return candidate.slice(prefix.length)
  }
  return candidate
}

/**
 * Whether one normalized add operand and one commit file row name the same
 * file: equal, or one is a tail of the other at a directory boundary (the add
 * may be spelled from a subdirectory while the commit reports repo-relative
 * paths, or the other way around). Best effort — unmatched pairs are never
 * forced together.
 */
export function addPathInCommit(addPath: string, commitPath: string): boolean {
  if (addPath === '' || commitPath === '') return false
  if (addPath === commitPath) return true
  return commitPath.endsWith(`/${addPath}`) || addPath.endsWith(`/${commitPath}`)
}

/**
 * Parse the `diff --git a/… b/…` headers of one commit patch into file rows —
 * the OLD-HOST fallback: a host older than the `git.log files` option answers
 * without `files`, and the lens recovers the touched-file list from the
 * commit diff it already loads for the preview. The status letter is inferred
 * from the header's own metadata lines (new file / deleted file / rename);
 * anything else reads as a modification.
 */
export function parseDiffFiles(diff: string): CommitFile[] {
  const files: CommitFile[] = []
  let current: CommitFile | undefined
  for (const line of diff.split('\n')) {
    const match = /^diff --git (?:"a\/(.+)"|a\/(.+)) (?:"b\/(.+)"|b\/(.+))$/.exec(line)
    if (match !== null) {
      // The b-side name is the file as the commit leaves it (a pure rename's
      // current path); a quoted header keeps its spelling minus the quotes.
      const oldPath = match[1] ?? match[2] ?? ''
      const path = match[3] ?? match[4] ?? oldPath
      if (path === '') continue
      current = { path, status: 'M' }
      files.push(current)
      continue
    }
    // The header's own metadata lines sharpen the seed letter.
    if (current === undefined) continue
    if (line.startsWith('new file mode')) current.status = 'A'
    else if (line.startsWith('deleted file mode')) current.status = 'D'
    else if (line.startsWith('rename from')) current.status = 'R'
  }
  return files
}
