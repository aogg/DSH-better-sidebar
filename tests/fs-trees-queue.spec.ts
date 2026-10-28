/**
 * The global `fs.trees` request gate (src/client/fs-trees-queue.ts): at most
 * TWO batches in flight client-wide (across every tree instance), the rest
 * FIFO. The rules under test:
 *  - CAP: four tasks → exactly two start at once, two wait.
 *  - FIFO: the next waiting task starts in arrival order as slots free.
 *  - PASS-THROUGH: a settled task's value (and a rejection) reach the caller
 *    unchanged, and the slot frees even on failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fsTreesQueueStateForTests, runFsTreesBatch } from '../src/client/fs-trees-queue.ts'

/** A deferred the test resolves manually (the in-flight `fs.trees` call). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  // The queue is module-level; a prior test's leak would show up here.
  expect(fsTreesQueueStateForTests()).toEqual({ inFlight: 0, queued: 0 })
})

afterEach(() => {
  expect(fsTreesQueueStateForTests()).toEqual({ inFlight: 0, queued: 0 })
})

describe('runFsTreesBatch (the 2-in-flight gate)', () => {
  it('starts exactly two tasks at once and queues the rest', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()]
    const settled: string[] = []
    const promises = gates.map((gate, index) =>
      runFsTreesBatch(() => gate.promise).then(value => { settled.push(value); return value }))
    // Two on the wire, two waiting.
    expect(fsTreesQueueStateForTests()).toEqual({ inFlight: 2, queued: 2 })
    gates[0]!.resolve('a')
    // Slot freed → the FIRST queued task starts (FIFO, not LIFO). The slot
    // frees a microtask after the caller's promise settles, so poll the
    // state.
    await vi.waitFor(() => {
      expect(fsTreesQueueStateForTests()).toEqual({ inFlight: 2, queued: 1 })
    })
    gates[2]!.resolve('c')
    gates[1]!.resolve('b')
    gates[3]!.resolve('d')
    await Promise.all(promises)
    expect(settled).toEqual(['a', 'c', 'b', 'd'])
  })

  it('starts immediately while slots are free (no artificial wait)', async () => {
    const gate = deferred<number>()
    const promise = runFsTreesBatch(() => gate.promise)
    expect(fsTreesQueueStateForTests()).toEqual({ inFlight: 1, queued: 0 })
    gate.resolve(7)
    await expect(promise).resolves.toBe(7)
  })

  it('frees the slot when a task REJECTS, and the rejection reaches the caller', async () => {
    const failing = deferred<number>()
    const queued = deferred<number>()
    const failingPromise = runFsTreesBatch(() => failing.promise)
    const queuedPromise = runFsTreesBatch(() => queued.promise)
    failing.reject(new Error('host down'))
    await expect(failingPromise).rejects.toThrow('host down')
    // The freed slot let the queued task start.
    expect(fsTreesQueueStateForTests()).toEqual({ inFlight: 1, queued: 0 })
    queued.resolve(1)
    await expect(queuedPromise).resolves.toBe(1)
  })
})
