/**
 * Workspace-dir-prefix compatibility for chat-spelled relative paths.
 *
 * A model writing a markdown link in the chat body often spells a
 * workspace-relative path with the workspace directory's own name as the
 * first segment — it copies the shape of the absolute path it sees in its
 * environment (`/code/www/my/gitee/my-ai/dsh/…` → `my-ai/dsh/…`). The host
 * turns such a link into a `dsh-resource://file/…` address verbatim, and the
 * sidebar's fs routes then join it onto the session cwd, producing
 * `<cwd>/my-ai/dsh/…` — one segment too many — and the open fails with
 * ENOENT.
 *
 * This module computes, purely lexically, the path with that first segment
 * stripped, so the resolution layer can PROBE both readings and prefer the
 * literal one (see `resolveTargetCompat` in path-security.ts — the fallback
 * lives THERE, on the host, because only the host can stat; this module
 * cannot and must not decide by itself).
 *
 * When a strip is even considered (ALL must hold):
 *
 * - the target is relative — OR absolute but spelled as `<cwd>/…` (the
 *   client's own joins — the editor path input, resolveSidebarPath — turn a
 *   typed relative path into exactly that shape before it reaches the host);
 * - after dropping no-op segments (`''` / `.` — `resolve()` ignores them
 *   too), the FIRST remaining segment equals `basename(cwd)` EXACTLY. Exact,
 *   case-sensitive comparison: on Windows the filesystem is case-insensitive,
 *   so a case variant of a real subdirectory hits the literal probe first and
 *   never reaches the strip; on POSIX, case matters and a differently-cased
 *   name is a different directory;
 * - no segment anywhere is `..`. Traversal keeps its existing meaning
 *   verbatim — stripping a segment in front of a `..` would RESOLVE to a
 *   different path (`my-ai/../x` is `<cwd>/x` as-is but `<cwd>/../x` once
 *   stripped), so `..` disables the compatibility entirely;
 * - the first segment outside this rule is untouched (`a/my-ai/b` is never
 *   stripped), and a `~`-relative target is refused (`~` already names the
 *   user's home — #713 — and must keep doing so).
 *
 * Separators follow the plugin's wire convention: paths travel `/`-separated,
 * and backslashes in an incoming target (or cwd) are normalized for analysis
 * only. No win32 module semantics are introduced.
 */

/** Whether a `/`-normalized path is absolute in any spelling the host accepts. */
function isAbsoluteNormalized(normalized: string): boolean {
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
}

/**
 * The target with a leading workspace-directory-name segment removed, or
 * `undefined` when the target does not qualify for the compatibility (the
 * caller must then resolve it verbatim). An EMPTY string result means the
 * target named the workspace root itself (`basename(cwd)` alone) and is a
 * valid resolution input (`join(cwd, '')` is the cwd).
 * @param cwd - the session workspace root (either separator style).
 * @param target - the client-supplied path (either separator style).
 */
export function workspaceDirPrefixRemainder(cwd: string, target: string): string | undefined {
  const normalized = target.replace(/\\/g, '/')
  const root = cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const base = root.slice(root.lastIndexOf('/') + 1)
  if (base === '' || base === '.' || base === '..') return undefined

  // A client-prejoined spelling carries the cwd as a literal prefix; take it
  // off so both shapes of the same intent reach the same first-segment test.
  // An absolute path that does not start with the cwd has no candidate at all.
  const candidate = isAbsoluteNormalized(normalized)
    ? normalized.startsWith(`${root}/`) && normalized.length > root.length
      ? normalized.slice(root.length + 1)
      : undefined
    : normalized
  if (candidate === undefined) return undefined

  const segments = candidate.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0) return undefined
  if (segments.some(segment => segment === '..')) return undefined
  if (segments[0] === '~') return undefined
  if (segments[0] !== base) return undefined
  return segments.slice(1).join('/')
}
