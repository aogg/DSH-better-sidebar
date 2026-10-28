/**
 * The global `fs.trees` request gate: at most TWO batch listings in flight,
 * everything else FIFO.
 *
 * Every tree instance lists its visible set (root + expanded levels) through
 * `fs.trees` batches. With the mount set fully kept alive (every visited tab
 * body stays mounted) and the trees sharing nothing, a burst — a refresh
 * tick reaching several trees, or many trees mounting at once — used to fire
 * every batch at full concurrency and stampede the host's fs layer. The gate
 * is MODULE-level on purpose: one queue for the whole client, so the in-
 * flight cap holds ACROSS tree instances, cwds and tabs, and a queued batch
 * keeps its FIFO order (first asked, first served).
 *
 * A queued batch costs nothing until its slot opens: the caller's promise
 * just settles later. Nothing else about the call changes — the per-tree
 * generation guard and the retry semantics stay exactly where they were.
 * @module dsh-better-sidebar/fs-trees-queue
 */

/** The in-flight cap: two `fs.trees` batches at a time, client-wide. */
const MAX_IN_FLIGHT = 2

/** The waiting starters, in arrival order. */
const queue: Array<() => void> = []
/** Batches currently on the wire. */
let inFlight = 0

/**
 * Run one `fs.trees` batch through the global gate: at most
 * {@linkcode MAX_IN_FLIGHT} tasks are in flight client-wide; the rest wait
 * in FIFO order and start as slots free.
 * @param task - the batch request itself (already built; it starts only
 *   when a slot opens).
 * @returns the task's own outcome, settled whenever the slot system lets it
 *   run and the request completes (rejections pass through unchanged).
 */
export function runFsTreesBatch<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      inFlight += 1
      task().then(resolve, reject).finally(() => {
        inFlight -= 1
        const next = queue.shift()
        if (next !== undefined) next()
      })
    }
    if (inFlight < MAX_IN_FLIGHT) start()
    else queue.push(start)
  })
}

/** Test seam: how many batches are running and waiting right now. */
export function fsTreesQueueStateForTests(): { inFlight: number; queued: number } {
  return { inFlight, queued: queue.length }
}
