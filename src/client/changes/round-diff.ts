/**
 * Baseline picking for the changes tab's round-diff lens: given the
 * repository's recent `git log` (newest first) and the (approximate) round
 * boundary, name the revision the ONE-SHOT `git diff <rev>` should aim at so
 * the answer carries exactly this round's changes — round-committed or still
 * uncommitted, A/M/D/R included. Pure — no React, no DOM, no git process.
 *
 * The boundary is an APPROXIMATION by design (see the round-commits lens):
 * the event window's earliest event time with a one-minute slack, and a
 * commit whose date cannot be parsed STAYS in the round rather than dropping
 * out of it — the mirror of the round-commits window filter, and for the same
 * reason: one stray clock format must never widen what "this round" claims.
 */
import type { GitLogEntry } from '../api.ts'

/**
 * Git's well-known empty tree hash. Present in every repository without ever
 * being created (git resolves it virtually), so `git diff <empty tree>` works
 * as the "everything is new" baseline when the round predates the repository
 * itself — every commit of the log landed inside the round.
 */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** What the round diff should diff the worktree against. */
export type RoundDiffBase =
  /** The newest commit that predates the round window (diff this one). */
  | { kind: 'commit'; hashFull: string }
  /** The repository has commits but every one sits inside the round: the
   *  round starts at the repository's birth — diff against the empty tree. */
  | { kind: 'empty-tree' }
  /** The repository has no commits at all: nothing can have been committed
   *  this round (tracked files do not exist yet), so the lens reads as empty
   *  instead of fetching a diff that could only ever answer with untracked
   *  nothing. */
  | { kind: 'no-commits' }

/**
 * Pick the diff baseline for one round window: the FIRST (newest) commit
 * whose parsed author date falls before `roundStart - slackMs`. Diffing the
 * worktree against that commit shows precisely the round's changes plus
 * whatever is still uncommitted; anything earlier would over-report, the
 * in-round HEAD itself would under-report (its own commit vanishes from the
 * patch).
 *
 * A commit with an unparseable date is skipped as a candidate (it can never
 * prove it predates the round) while the scan continues to the older entries
 * — and the repository still counts as "has commits", so an all-unparseable
 * log falls to the empty-tree baseline, never to the empty state.
 * @param entries - the recent `git log` rows, NEWEST FIRST (the host's order).
 * @param roundStart - the event window's earliest event time (epoch ms).
 * @param slackMs - the boundary slack (the lens passes its one-minute value).
 */
export function pickRoundDiffBase(
  entries: readonly Pick<GitLogEntry, 'date' | 'hashFull'>[],
  roundStart: number,
  slackMs: number,
): RoundDiffBase {
  if (entries.length === 0) return { kind: 'no-commits' }
  for (const entry of entries) {
    const time = Date.parse(entry.date)
    if (Number.isNaN(time)) continue
    if (time < roundStart - slackMs) return { kind: 'commit', hashFull: entry.hashFull }
  }
  return { kind: 'empty-tree' }
}
