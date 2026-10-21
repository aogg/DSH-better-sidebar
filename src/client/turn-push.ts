/**
 * One shared session-turn subscription per session (`/sidebar/ws/session`'s
 * `turn` frames).
 *
 * An open editor tab wants to know "the session's reply just settled" so it
 * can re-read the file it shows. The signal arrives over the session push
 * socket, and the naive wiring — one `connectSessionPush` per tab — has the
 * same multiplication problem ops-stream.ts solved for its delta poller: the
 * native right sidebar keeps every visited tab body mounted (`keepMounted`),
 * so an N-editor session would hold N sockets watching the SAME session id
 * (plus the session hooks' own connections), each receiving byte-identical
 * frames. This module is the WS-side answer to that "one leader per session"
 * rule, minus the election: a WebSocket connection is cheap to share, so the
 * FIRST subscriber of a session opens the single connection, every
 * `kind:'turn'` frame of that session fans out to all of them, and the LAST
 * unsubscriber closes it. No polling anywhere — the socket is the only
 * channel, its own reconnect backoff (1s → 15s) the only availability story,
 * exactly like every other consumer of {@linkcode connectSessionPush}.
 *
 * Frames are filtered HERE (kind and session id), so a subscriber callback
 * only ever runs for its own session's settled turns — the other kinds on
 * the shared wire (phase/cwd/history/history-seed) are invisible to it, and
 * the hooks that DO consume those keep their own connections untouched.
 * @module dsh-better-sidebar/turn-push
 */
import { connectSessionPush, type SessionPushFrame } from './session-push.ts'

/** One session's shared connection: the disposer plus its live subscribers. */
interface TurnHub {
  /** Close the shared socket (called when `subscribers` empties). */
  close: () => void
  subscribers: Set<() => void>
}

/** One hub per session id, alive while at least one subscriber holds it. */
const hubs = new Map<string, TurnHub>()

/**
 * Subscribe to one session's turn-settled pushes.
 * @param sessionId - the session whose settled reply steps to hear.
 * @param onTurn - called once per coalesced `turn` frame of THAT session
 *   (never for another session's, never for any other frame kind).
 * @returns the disposer; the last one for a session closes the shared
 *   connection (idempotent, like every disposer in this codebase).
 */
export function subscribeSessionTurns(sessionId: string, onTurn: () => void): () => void {
  let hub = hubs.get(sessionId)
  if (hub === undefined) {
    const subscribers = new Set<() => void>()
    const close = connectSessionPush([sessionId], (frame: SessionPushFrame) => {
      // The wire also carries phase/cwd/history/history-seed frames for the
      // hooks sharing the protocol — none of them means "a reply settled".
      if (frame.kind !== 'turn' || frame.sessionId !== sessionId) return
      // A throwing subscriber is CONTAINED, not allowed to starve the rest —
      // the same isolation the sidebar store's own notify() fans out with.
      for (const subscriber of [...subscribers]) {
        try {
          subscriber()
        } catch (error) {
          console.error('[dsh-better-sidebar] turn subscriber error:', error)
        }
      }
    })
    hub = { close, subscribers }
    hubs.set(sessionId, hub)
  }
  hub.subscribers.add(onTurn)
  return () => {
    const current = hubs.get(sessionId)
    if (current === undefined || !current.subscribers.delete(onTurn)) return
    if (current.subscribers.size === 0) {
      hubs.delete(sessionId)
      current.close()
    }
  }
}
