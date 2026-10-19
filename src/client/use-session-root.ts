/**
 * The root the explorer and the git panel should use for one session.
 *
 * The client session list carries the session HEADER cwd, captured once when
 * the session started. The HOST is the authority on where the session is
 * actually working, because it can follow the agent into a linked git worktree
 *  including one belonging to a different repository. Ask the host, prefer
 * its answer, and re-ask when the window regains focus, when a file refresh is
 * requested, and on a slow timer so a mid-session worktree move is picked up.
 *
 * The slow timer is the fallback, not the primary signal: the session push
 * socket (`/sidebar/ws/session`, see session-push.ts) announces "a tool call
 * just ran in this session", and THAT re-ask carries `fresh` so the host skips
 * its TTL cache — the push is the explicit "it changed" signal, while the 5s
 * poll stays free (cache-hit) and covers a dropped socket.
 *
 * Shared by both client surfaces: the plugin's own sidebar shell
 * (`Sidebar.tsx`) and the native DSH right-sidebar tab body
 * (`native/tab-adapter.tsx`). They used to disagree  the native body read the
 * frozen list summary directly, so a host-side worktree change never reached
 * the file list drawn in the host's own right Sidebar.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { api } from './api.ts'
import { connectSessionPush } from './session-push.ts'

/** How often the host is re-asked while the document is visible. */
const SESSION_ROOT_POLL_MS = 5_000

/**
 * Resolve the live workspace root for one session.
 * @param ctx - client plugin context (owns the session list feed + API).
 * @param sessionId - the session to resolve; `undefined` resolves to `undefined`.
 * @returns the host's active root, falling back to the list summary cwd.
 */
export function useSessionRoot(ctx: Context, sessionId: string | undefined): string | undefined {
  const summaryCwd = useSyncExternalStore(
    useMemo(() => (listener: () => void) => ctx.sessions.list.subscribe(listener), [ctx]),
    () => sessionId === undefined ? undefined : ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd,
  )
  const [fetched, setFetched] = useState<{ sessionId: string; cwd: string } | undefined>(undefined)

  useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    /**
     * Ask the host once. `fresh` skips the host's 3s TTL cache: a push notice
     * already said the root moved, and the server-side 250ms coalescing window
     * bounds how often that can arrive, so the recompute is worth paying now.
     */
    const load = (fresh = false): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      api.sessionCwd({ sessionId }, fresh ? { fresh: true } : undefined)
        .then(result => {
          if (cancelled) return
          setFetched(previous => (
            previous !== undefined && previous.sessionId === sessionId && previous.cwd === result.cwd
              ? previous
              : { sessionId, cwd: result.cwd }
          ))
        })
        .catch(() => { /* the explorer/git rows surface their own errors */ })
    }
    // DOM listeners hand their Event to the callback; the poll paths are never fresh.
    const poll = (): void => { load(false) }
    load()
    window.addEventListener('focus', poll)
    window.addEventListener('dsh-sidebar:refresh-files', poll)
    const timer = window.setInterval(poll, SESSION_ROOT_POLL_MS)
    // Push channel: a cwd notice for THIS session is an immediate fresh re-ask,
    // so a mid-session worktree move lands within the host's 250ms coalescing
    // window instead of waiting for the next 5s tick. The poll stays as the
    // fallback; the same-value fold below keeps the extra answers free.
    const stopPush = connectSessionPush([sessionId], (frame) => {
      if (frame.kind === 'cwd' && frame.sessionId === sessionId) load(true)
    })
    return () => {
      cancelled = true
      window.removeEventListener('focus', poll)
      window.removeEventListener('dsh-sidebar:refresh-files', poll)
      window.clearInterval(timer)
      stopPush()
    }
  }, [sessionId])

  return fetched !== undefined && fetched.sessionId === sessionId ? fetched.cwd : summaryCwd
}
