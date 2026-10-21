/**
 * A full unified-diff document (one changed file, or every file of a commit
 * patch): collapsible per-file headers — source files open by default, tests
 * / docs / generated files stay folded — each expanded file rendering through
 * the shared {@link DiffRows} (so git diffs get the same rewrite tinting,
 * intra-line highlights, syntax colors and hunk folds as session-op diffs).
 * A narrow-viewport caller (a commit patch on a phone) passes
 * `allCollapsedByDefault` to flip the default: every file starts folded and
 * the reader expands headers one by one instead of facing a diff wall.
 * Untracked files produce no `git diff` output; the caller passes their
 * content to render as a full-file addition instead.
 *
 * Two opt-in extensions exist for the round-diff lens (both absent on every
 * other caller, whose DOM and behavior stay byte-identical): `onOpenFile`
 * renders a trailing 「查看原文件」 icon button on each file header (an
 * absolutely positioned sibling of the header — never a child of it, so the
 * header's `button[aria-expanded] + div` body contract survives), and
 * `foldCommand` lets a parent drive every header open or closed at once
 * (「全部展开」/「全部收起」) through a monotonic sequence number.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from '../locales.ts'
import { IconButton } from '../ui/index.ts'
import { diffStats, displayPath, parseUnifiedDiff, unifiedSegments, untrackedFile, type DiffFile, type DiffRow, type FoldSegment } from './rows.ts'
import { langOfPath } from './highlight.ts'
import { DiffRows } from './DiffRows.tsx'
import css from './diff.module.css'

const TEST_PATH = /(^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|snapshots?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const DOC_PATH = /(^|\/)(?:docs?|documentation)(?:\/|$)|(^|\/)(?:readme|changelog|contributing|license|authors|notice)(\.[^/]*)?$/i
const GENERATED_PATH = /(^|\/)(?:dist|build|coverage|generated|vendor|node_modules)(?:\/|$)|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|cargo\.lock|poetry\.lock)$/i
const SOURCE_PATH = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|rb|php|java|kt|kts|scala|go|rs|swift|c|h|cc|cpp|cxx|hpp|hh|hxx|cs|fs|fsx|vb|dart|lua|r|ex|exs|erl|hrl|clj|cljs|cljc|groovy|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less)$/i

/** Source files open by default; tests, docs, generated files and unknown types stay folded. */
function defaultExpandedFiles(files: readonly DiffFile[]): Set<number> {
  const expanded = new Set<number>()
  files.forEach((file, index) => {
    const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
    if (!file.binary && file.hunks.length > 0
      && !TEST_PATH.test(path) && !DOC_PATH.test(path) && !GENERATED_PATH.test(path)
      && SOURCE_PATH.test(path)) {
      expanded.add(index)
    }
  })
  return expanded
}

/** The default expanded set for one parsed document: everything folded when
 *  the caller asked for the narrow-viewport presentation (each header opens
 *  on tap), otherwise the source-open {@link defaultExpandedFiles} defaults. */
function expandedFilesDefault(files: readonly DiffFile[], allCollapsed: boolean): Set<number> {
  return allCollapsed ? new Set<number>() : defaultExpandedFiles(files)
}

/** The file header badge: added / deleted / renamed / binary ('' for a plain edit). */
function fileTag(file: DiffFile): string | null {
  if (file.binary) return t('diffBinary')
  if (file.oldPath === '/dev/null') return t('diffAdded')
  if (file.newPath === '/dev/null') return t('diffDeleted')
  const oldPath = displayPath(file.oldPath)
  const newPath = displayPath(file.newPath)
  if (oldPath !== newPath) return t('diffRenamed')
  return null
}

/**
 * The path an open-the-original-file action targets on one parsed file: the
 * side the change LANDS on — the new path, except a deletion (`/dev/null`
 * new side) where only the old path exists; a rename names both and the new
 * one wins. Display-stripped (`a/`/`b/` prefixes off), so the callback sees
 * the same spelling the header prints.
 * @param file - one parsed diff file.
 * @returns the repo-relative display path to open.
 */
export function openTargetOf(file: DiffFile): string {
  return displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
}

/**
 * One externally issued fold instruction (「全部展开」/「全部收起」 from the
 * round-diff lens's summary controls). `seq` is the issuer's monotonic
 * command number: the component replays a command only when its seq differs
 * from the last one it applied, so a re-render carrying the same command
 * never re-folds the headers — and `seq` 0 means "never asked" (the initial
 * state, never issued), leaving the ordinary defaults untouched.
 */
export interface DiffFoldCommand {
  mode: 'expand' | 'collapse'
  seq: number
}

export interface DiffFilesProps {
  /** Unified diff text (`git.diff` or `git.commit-diff` payloads). */
  diff: string
  /** Untracked-file content: when present, renders as a full-file addition instead of parsing. */
  untrackedPath?: string
  untrackedContent?: string
  /** Fetch a git gap fold's hidden rows on demand (both sides' contents by
   *  the fold's line ranges); forwarded to every file's DiffRows. Absent
   *  folds without `rows` stay non-expandable (session-op diffs and
   *  untracked additions always carry theirs). */
  resolveFold?: (file: DiffFile, segment: FoldSegment) => Promise<readonly DiffRow[]>
  /** Narrow-viewport (commit-patch) mode: EVERY file section starts folded,
   *  headers expand on tap. The flag participates in the parsed-document
   *  reset, so crossing the breakpoint rebuilds the defaults (manual
   *  expand/collapse states survive only while both stay unchanged). */
  allCollapsedByDefault?: boolean
  /** Render a 「查看原文件」 icon button on every file header's row end,
   *  calling back the file's display path (the new side, or the old side of
   *  a deletion). Absent (every caller but the round-diff lens) renders
   *  nothing and leaves the header DOM exactly as before. */
  onOpenFile?: (path: string) => void
  /** The latest open-all/close-all instruction (see {@link DiffFoldCommand});
   *  a changed `seq` resets every header to the asked state. Undefined (or a
   *  seq the component already applied) leaves the manual states alone. */
  foldCommand?: DiffFoldCommand
}

export function DiffFiles({ diff, untrackedPath, untrackedContent, resolveFold, allCollapsedByDefault = false, onOpenFile, foldCommand }: DiffFilesProps) {
  const parsed = useMemo(() => {
    if (untrackedPath !== undefined) {
      return { files: [untrackedFile(untrackedPath, untrackedContent ?? '')] }
    }
    return parseUnifiedDiff(diff)
  }, [diff, untrackedPath, untrackedContent])
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(() => expandedFilesDefault(parsed.files, allCollapsedByDefault))
  useEffect(() => { setExpandedFiles(expandedFilesDefault(parsed.files, allCollapsedByDefault)) }, [parsed, allCollapsedByDefault])

  // One external open-all/close-all instruction at a time: a seq the
  // component has not applied yet resets every header to the asked state.
  // The applied-seq ref starts at 0 ("never asked"), so a caller that has
  // issued nothing renders the ordinary defaults — and a document swap
  // (parsed) still rebuilds them through the reset effect above, exactly as
  // it does for callers that never pass a command.
  const appliedFoldSeq = useRef(0)
  useEffect(() => {
    if (foldCommand === undefined || foldCommand.seq === appliedFoldSeq.current) return
    appliedFoldSeq.current = foldCommand.seq
    setExpandedFiles(() => {
      if (foldCommand.mode === 'collapse') return new Set<number>()
      // Expand every header that CAN open: binary and hunk-less files have
      // disabled headers with no body, so seeding their indices would only
      // make the later `has()` reads claim a body that cannot render.
      const next = new Set<number>()
      parsed.files.forEach((file, index) => {
        if (!file.binary && file.hunks.length > 0) next.add(index)
      })
      return next
    })
  }, [foldCommand, parsed])

  // One in-flight/resolved promise per file+fold key, so a fold re-clicked
  // after a remount (file header collapsed and re-expanded) resolves without
  // a second fetch and concurrent clicks join the same request. The cache
  // dies with `parsed` (a new diff text); rejected promises are dropped so a
  // later retry can go through.
  const foldCache = useRef(new Map<string, Promise<readonly DiffRow[]>>())
  useEffect(() => { foldCache.current = new Map() }, [parsed])
  const loadFold = (file: DiffFile, segment: FoldSegment): Promise<readonly DiffRow[]> => {
    if (resolveFold === undefined) return Promise.resolve([])
    const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
    const key = `${path}|${String(segment.oldStart)}|${String(segment.newStart)}`
    let promise = foldCache.current.get(key)
    if (promise === undefined) {
      promise = resolveFold(file, segment)
      foldCache.current.set(key, promise)
      promise.catch(() => { foldCache.current.delete(key) })
    }
    return promise
  }

  // Segments and header stats computed once per file.
  const files = useMemo(
    () => parsed.files.map((file) => {
      const segments = unifiedSegments(file)
      return { file, segments, stats: diffStats(segments) }
    }),
    [parsed],
  )

  const renderFile = (entry: (typeof files)[number], fileIndex: number): ReactNode => {
    const { file, segments, stats } = entry
    const tag = fileTag(file)
    const from = displayPath(file.oldPath)
    const to = displayPath(file.newPath)
    const expandable = !file.binary && file.hunks.length > 0
    const fileExpanded = expandedFiles.has(fileIndex)
    return (
      <div key={`file-${String(fileIndex)}`} className={css.fileBlock}>
        <button
          type="button"
          className={clsx(css.file, onOpenFile !== undefined && css.fileWithOpen)}
          disabled={!expandable}
          aria-expanded={expandable ? fileExpanded : undefined}
          onClick={() => {
            setExpandedFiles(current => {
              const next = new Set(current)
              if (next.has(fileIndex)) next.delete(fileIndex)
              else next.add(fileIndex)
              return next
            })
          }}
        >
          {expandable && <span aria-hidden="true" className={clsx(css.fileChevron, fileExpanded && css.fileChevronExpanded)}>›</span>}
          <span className={css.filePath}>{to}</span>
          {from !== to && <span className={css.fileOld}>← {from}</span>}
          {tag !== null && <span className={css.fileTag}>{tag}</span>}
          {expandable && (stats.added > 0 || stats.deleted > 0) && (
            <span className={css.fileStats}>
              {stats.added > 0 && <span className={css.statAdd}>+{String(stats.added)}</span>}
              {stats.deleted > 0 && <span className={css.statDel}>−{String(stats.deleted)}</span>}
            </span>
          )}
        </button>
        {expandable && fileExpanded && (
          <DiffRows segments={segments} lang={langOfPath(to)} resolveFold={resolveFold !== undefined ? (segment) => loadFold(file, segment) : undefined} />
        )}
        {/* The open action rides OUTSIDE the header button (a button inside a
            button is invalid HTML) and AFTER the body sibling, so the sticky
            header's `button[aria-expanded] + div` body contract survives; the
            sheet pins it to the block's row end instead. A click never
            reaches the header (siblings, not ancestors); stopPropagation
            keeps the intent if the shape ever nests. */}
        {onOpenFile !== undefined && (
          <IconButton
            size="sm"
            className={css.fileOpen}
            icon={<IconCodeOutlineRegular size={14} />}
            label={t('changesViewOriginalFile')}
            onClick={(event) => {
              event.stopPropagation()
              onOpenFile(openTargetOf(file))
            }}
          />
        )}
      </div>
    )
  }

  if (parsed.files.length === 0) return null
  return (
    <div className={css.files}>
      {files.map(renderFile)}
    </div>
  )
}
