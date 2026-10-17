/**
 * The session lens of the changes tab: agent truth — every file the model
 * read, wrote, or edited in this session, folded into a DIRECTORY tree (the
 * Git lens's shape, see {@link buildSessionTree}: single-child chains
 * compressed, directories before files), with kind filters. A directory row
 * (chevron + folder artwork + label + file count) discloses its subtree and
 * starts EXPANDED: folding is tracked as the set of COLLAPSED directories, so
 * a directory that first appears in a later poll is born open. Each file's op
 * history is FOLDED by default: the header discloses it (chevron +
 * `aria-expanded`; the file's own name on the row, the full path in the
 * title), and the folded header carries the summary — how many ops the file
 * has and how fresh the newest one is. A preview selection inside a folded
 * group auto-expands the group AND every directory above it, so an op clicked
 * elsewhere (or restored from the pane) is always visible. Clicking an op
 * previews it in the tab's shared bottom pane (see {@link DiffPane}): writes
 * and edits as line diffs, reads as a line-numbered content view, failures as
 * their real error text. The ops arrive pre-folded from the tab (which owns
 * the event poll); this component is purely presentational.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { relativeTime, t } from '../locales.ts'
import { builtinFileIcon, builtinFolderIcon } from '../file-icons.tsx'
import { formatBytes } from '../diff/rows.ts'
import { Chip, Notice, StatusBadge } from '../ui/index.ts'
import { groupByFile, type FileOp, type FileOpKind } from './ops.ts'
import { ancestorDirs, buildSessionTree, type SessionDir, type SessionFile } from './session-tree.ts'
import css from './changes.module.css'

/** The op-kind filter chips: 'all' or one concrete kind. */
type OpFilter = 'all' | FileOpKind

const KIND_LABEL = { read: 'changesRead', write: 'changesWrite', edit: 'changesEdit' } as const

export interface SessionLensProps {
  /** The folded file operations, newest first (the tab's poll owns them). */
  ops: readonly FileOp[]
  /** Every poll failed and nothing loaded: an inline notice, not an empty
   *  state that would read as "no operations". */
  loadError: boolean
  /** Preview one op in the shared bottom pane. */
  onPreview: (path: string, op: FileOp) => void
  /** The op currently previewed (row highlight); null when the pane is closed. */
  selectedCallId: string | null
}

export function SessionLens({ ops, loadError, onPreview, selectedCallId }: SessionLensProps) {
  const [filter, setFilter] = useState<OpFilter>('all')
  /** The files whose op history is EXPANDED (default: none — every group
   *  folds to its header summary). */
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set())
  /** The directories the user FOLDED (default: none — the tree starts fully
   *  expanded). An absence-set rather than an open-set on purpose: a
   *  directory that first appears in a later poll tick is not in it, so new
   *  work arrives expanded without anyone seeding the state. */
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set())
  const filteredOps = useMemo(
    () => (filter === 'all' ? ops : ops.filter(op => op.kind === filter)),
    [ops, filter],
  )
  const groups = useMemo(() => groupByFile(filteredOps), [filteredOps])
  // One fold per filter change: the tree only ever contains directories that
  // still hold a file, so a narrowed filter removes emptied branches whole.
  const tree = useMemo(() => buildSessionTree(groups), [groups])
  const counts = useMemo(() => {
    const map = new Map<FileOpKind, number>([['read', 0], ['write', 0], ['edit', 0]])
    for (const op of ops) map.set(op.kind, (map.get(op.kind) ?? 0) + 1)
    return map
  }, [ops])

  // Sizing a row's content constructs a Blob (a UTF-8 encode of the whole
  // edit) — that was per row PER RENDER, re-encoding every field on every
  // poll tick. ops keeps its identity between unchanged polls (see the
  // tab's opsRef), so one pass per changed fold covers every render.
  const opSizes = useMemo(() => {
    const sizes = new Map<string, string>()
    for (const op of ops) {
      if (op.kind !== 'read' && !op.isError) {
        sizes.set(op.callId, formatBytes(new Blob([op.edit?.newString ?? op.content ?? '']).size))
      }
    }
    return sizes
  }, [ops])

  // A preview selection must never hide behind a fold: expand the group
  // holding it AND every directory above it (once — the guard keeps this
  // effect loop-free: a pass that has nothing to open sets nothing).
  useEffect(() => {
    if (selectedCallId === null) return
    for (const [path, fileOps] of groups) {
      if (!fileOps.some(op => op.callId === selectedCallId)) continue
      if (!expandedFiles.has(path)) setExpandedFiles(current => new Set(current).add(path))
      const shut = ancestorDirs(path).filter(dir => collapsedDirs.has(dir))
      if (shut.length > 0) {
        setCollapsedDirs((current) => {
          const next = new Set(current)
          for (const dir of shut) next.delete(dir)
          return next
        })
      }
      return
    }
  }, [selectedCallId, groups, expandedFiles, collapsedDirs])

  const toggleFile = (path: string): void => {
    setExpandedFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** Fold or unfold one directory row (keyed by the tree's own dir path). */
  const toggleDir = (dirPath: string): void => {
    setCollapsedDirs((current) => {
      const next = new Set(current)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  /** One file row: the disclosure chevron + the file's artwork + its own NAME
   *  (the full path rides the title) + — only while folded — the summary rung
   *  (op count + the newest op's kind badge and relative time). Disclosing
   *  reveals the op history rows below. */
  const renderFile = (node: SessionFile): ReactNode => {
    const open = expandedFiles.has(node.path)
    const newest = node.ops[0]
    const opsId = `changes-file-ops-${encodeURIComponent(node.path)}`
    return (
      <div key={node.path} className={css.fileGroup} data-file-group={node.path}>
        <button
          type="button"
          className={css.filePathButton}
          data-file-head={node.path}
          aria-expanded={open}
          aria-controls={opsId}
          title={node.path}
          onClick={() => { toggleFile(node.path) }}
        >
          <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true">
            <IconChevronRightOutlineRegular size={12} />
          </span>
          <span className={css.rowIcon} aria-hidden="true">{builtinFileIcon(node.path, 14)}</span>
          <span className={css.filePathText}>{node.name}</span>
          {!open && newest !== undefined && (
            <span className={css.fileHeadSummary}>
              <StatusBadge tone={newest.kind}>{t(KIND_LABEL[newest.kind])}</StatusBadge>
              <span className={css.opTime}>{relativeTime(new Date(newest.time).toISOString())}</span>
              <span className={css.countPill} data-op-count={node.ops.length}>{node.ops.length}</span>
            </span>
          )}
        </button>
        {open && (
          <div className={css.fileOps} id={opsId} data-file-ops={node.path}>
            {node.ops.map(op => (
              <button
                type="button"
                key={op.callId}
                className={css.opRow}
                data-op-kind={op.kind}
                data-op-error={op.isError ? 'true' : undefined}
                data-selected={selectedCallId === op.callId ? 'true' : undefined}
                onClick={() => { onPreview(node.path, op) }}
              >
                <StatusBadge tone={op.kind}>{t(KIND_LABEL[op.kind])}</StatusBadge>
                {op.running && <span className={css.opFlag}>{t('changesRunning')}</span>}
                {op.isError && <span className={css.opFlagError}>{t('changesError')}</span>}
                <span className={css.opMeta}>
                  {opSizes.get(op.callId) !== undefined && (
                    <span className={css.opSize}>
                      {opSizes.get(op.callId)}
                    </span>
                  )}
                  <span className={css.opTime}>{relativeTime(new Date(op.time).toISOString())}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  /** One directory row plus its subtree: the chevron + folder artwork + the
   *  label (a compressed chain reads as one 'src/client' line) + how many
   *  files changed beneath, then the children in the shared indented gutter
   *  (the Git lens tree's own classes, so the two lists read alike). */
  const renderDir = (node: SessionDir): ReactNode => {
    const open = !collapsedDirs.has(node.path)
    return (
      <div key={`dir:${node.path}`}>
        <div className={css.row}>
          <button
            type="button"
            className={css.dirRow}
            data-dir-group={node.path}
            aria-expanded={open}
            title={node.path}
            onClick={() => { toggleDir(node.path) }}
          >
            <span className={css.chevron} data-open={open ? 'true' : undefined} aria-hidden="true">
              <IconChevronRightOutlineRegular size={12} />
            </span>
            <span className={css.rowIcon} aria-hidden="true">{builtinFolderIcon(open, 14)}</span>
            <span className={css.dirName}>{node.name}</span>
            <span className={css.countPill} data-count={node.files}>{node.files}</span>
          </button>
        </div>
        {open && (
          <div className={css.treeChildren}>
            {node.children.map(child => (child.kind === 'dir' ? renderDir(child) : renderFile(child)))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={css.session}>
      <div className={css.filterRow} role="group" aria-label={t('changesSessionLens')}>
        <Chip active={filter === 'all'} count={ops.length} onClick={() => { setFilter('all') }}>
          {t('changesFilterAll')}
        </Chip>
        {(['write', 'edit', 'read'] as const).map(kind => (
          <Chip
            key={kind}
            active={filter === kind}
            count={counts.get(kind) ?? 0}
            onClick={() => { setFilter(kind) }}
          >
            {t(KIND_LABEL[kind])}
          </Chip>
        ))}
      </div>
      <div className={css.sessionList}>
        {loadError && <Notice kind="error" role="alert">{t('changesLoadError')}</Notice>}
        {ops.length === 0 && !loadError && <Notice kind="empty" tone="page">{t('changesSessionEmpty')}</Notice>}
        {ops.length > 0 && filteredOps.length === 0 && <Notice kind="empty" tone="page">{t('changesFilterEmpty')}</Notice>}
        {tree.map(node => (node.kind === 'dir' ? renderDir(node) : renderFile(node)))}
      </div>
    </div>
  )
}
