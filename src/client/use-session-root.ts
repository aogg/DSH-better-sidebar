/**
 * The root the explorer and the git panel should use for one session.
 *
 * The client session list carries the session HEADER cwd, captured once when
 * the session started. The HOST is the authority on where the session is
 * actually working, because it can follow the agent into a linked git
 * worktree — including one belonging to a different repository.
 *
 * The session push socket (`/sidebar/ws/session`, see session-push.ts) is
 * the ONLY data channel: while it is open, the host pushes the cwd ANSWER
 * itself — on watch, on every (re)connect, and at the end of each coalesced
 * tool/call burst — and the hook lands it directly. There is NO HTTP ask,
 * not even at mount: a dropped socket is answered with reconnects only (the
 * connector's 1s → 15s backoff, reset on success), never with HTTP polling.
 * While the socket is down the root simply stays at the list's summary cwd.
 * A bare cwd frame without an answer — an older host, or a failed host-side
 * resolution — is IGNORED: the next tool/call burst pushes the answer over
 * the same socket, so there is nothing to re-ask.
 *
 * Shared by both client surfaces: the plugin's own sidebar shell
 * (`Sidebar.tsx`) and the native DSH right-sidebar tab body
 * (`native/tab-adapter.tsx`). They used to disagree  the native body read the
 * frozen list summary directly, so a host-side worktree change never reached
 * the file list drawn in the host's own right Sidebar.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { connectSessionPush } from './session-push.ts'

/**
 * Resolve the live workspace root for one session.
 * @param ctx - client plugin context (owns the session list feed).
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
    /** Fold one answer in; the same-value fold keeps repeated answers re-render-free. */
    const applyCwd = (cwd: string): void => {
      setFetched(previous => (
        previous !== undefined && previous.sessionId === sessionId && previous.cwd === cwd
          ? previous
          : { sessionId, cwd }
      ))
    }
    const stopPush = connectSessionPush([sessionId], (frame) => {
      if (cancelled) return
      if (frame.kind !== 'cwd' || frame.sessionId !== sessionId) return
      // Only a frame that CARRIES the answer lands. A bare one (older host /
      // failed host resolution) is ignored: the host re-pushes on the next
      // tool/call burst — never re-asked over HTTP, not even when offline.
      if (typeof frame.cwd === 'string' && frame.cwd !== '') applyCwd(frame.cwd)
    })
    return () => {
      cancelled = true
      stopPush()
    }
  }, [sessionId])

  return fetched !== undefined && fetched.sessionId === sessionId ? fetched.cwd : summaryCwd
}
