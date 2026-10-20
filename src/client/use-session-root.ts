/**
 * The root the explorer and the git panel should use for one session.
 *
 * The client session list carries the session HEADER cwd, captured once when
 * the session started. The HOST is the authority on where the session is
 * actually working, because it can follow the agent into a linked git worktree
 *  including one belonging to a different repository. Ask the host, prefer
 * its answer, and re-ask when the window regains focus and when a file
 * refresh is requested.
 *
 * The PRIMARY signal is the session push socket (`/sidebar/ws/session`, see
 * session-push.ts): while it is open, the host pushes the cwd ANSWER itself —
 * on watch, on every (re)connect, and at the end of each coalesced tool/call
 * burst — so the 5s timer is SUSPENDED for the socket's whole lifetime. The
 * timer is the DROPPED-SOCKET fallback: it resumes the moment the socket
 * closes, covering a host without the channel or a mid-session disconnect.
 * The mount-time HTTP fetch stays too, so first paint has a snapshot before
 * the socket even opens. A bare cwd frame without an answer — an older host,
 * or a failed host-side resolution — still triggers an immediate `fresh`
 * HTTP re-ask, exactly like before.
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

/** Fallback re-ask cadence, running only while the push socket is closed. */
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
    /** Fold one answer in; the same-value fold keeps repeated answers re-render-free. */
    const applyCwd = (cwd: string): void => {
      setFetched(previous => (
        previous !== undefined && previous.sessionId === sessionId && previous.cwd === cwd
          ? previous
          : { sessionId, cwd }
      ))
    }
    /**
     * Ask the host once. `fresh` skips the host's 3s TTL cache: a bare cwd
     * frame already said the root moved, so the recompute is worth paying now.
     */
    const load = (fresh = false): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      api.sessionCwd({ sessionId }, fresh ? { fresh: true } : undefined)
        .then(result => {
          if (cancelled) return
          applyCwd(result.cwd)
        })
        .catch(() => { /* the explorer/git rows surface their own errors */ })
    }
    // DOM listeners hand their Event to the callback; these asks are never fresh.
    const poll = (): void => { load(false) }
    load()
    window.addEventListener('focus', poll)
    window.addEventListener('dsh-sidebar:refresh-files', poll)
    // The 5s timer is the dropped-socket fallback only: suspended while the
    // push socket is open (its frames carry the answers), resumed the moment
    // it closes — so a mid-session disconnect or an old host still self-heals.
    let timer: number | undefined
    const startPoll = (): void => {
      if (timer === undefined) timer = window.setInterval(poll, SESSION_ROOT_POLL_MS)
    }
    const stopPoll = (): void => {
      if (timer === undefined) return
      window.clearInterval(timer)
      timer = undefined
    }
    startPoll()
    const stopPush = connectSessionPush([sessionId], (frame) => {
      if (frame.kind !== 'cwd' || frame.sessionId !== sessionId) return
      if (typeof frame.cwd === 'string' && frame.cwd !== '') {
        // The frame carries the answer: land it directly, no HTTP round trip.
        applyCwd(frame.cwd)
        return
      }
      // Bare invalidation (older host / failed host resolution): the push is
      // the explicit "it moved" signal, so the re-ask skips the host's TTL cache.
      load(true)
    }, (open) => {
      if (open) stopPoll()
      else startPoll()
    })
    return () => {
      cancelled = true
      window.removeEventListener('focus', poll)
      window.removeEventListener('dsh-sidebar:refresh-files', poll)
      stopPoll()
      stopPush()
    }
  }, [sessionId])

  return fetched !== undefined && fetched.sessionId === sessionId ? fetched.cwd : summaryCwd
}
