/**
 * The tab-loading registry (src/client/tab-loading.ts): set/clear publish and
 * delete per `sessionId::tabId` entry (the same tab id under two sessions is
 * isolated — the editor-dirty lesson this store exists not to repeat), the
 * session-less clear drops the id in EVERY session (the tests' cleanup shape),
 * and the notification only fires on real changes. The hook half pins the
 * reader's snapshot to the tab's OWN boolean through `useSyncExternalStore`,
 * so a flag flip anywhere re-renders only the reader whose tab flipped.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  clearTabLoading, setTabLoading, subscribeTabLoading, tabLoadingCount, tabLoadingOf, tabLoadingRevision, useTabLoading,
} from '../src/client/tab-loading.ts'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** The ids the cases below use; the session-less clear is the cleanup. */
const USED_IDS = ['t1', 't2']

afterEach(() => {
  for (const id of USED_IDS) clearTabLoading(id)
})

describe('tab-loading store', () => {
  it('registers a load and clears it on settle', () => {
    expect(tabLoadingOf('s1', 't1')).toBe(false)
    setTabLoading('t1', true, 's1')
    expect(tabLoadingOf('s1', 't1')).toBe(true)
    expect(tabLoadingCount()).toBe(1)
    setTabLoading('t1', false, 's1')
    expect(tabLoadingOf('s1', 't1')).toBe(false)
    expect(tabLoadingCount()).toBe(0)
  })

  it('isolates the same tabId across sessions', () => {
    setTabLoading('t1', true, 's1')
    // Session B's same-numbered tab is not loading — and its settle cannot
    // clear A's load (the bare-id keying this store refuses).
    expect(tabLoadingOf('s2', 't1')).toBe(false)
    setTabLoading('t1', false, 's2')
    expect(tabLoadingOf('s1', 't1')).toBe(true)
    // And the mirror: A's settle leaves B's load standing.
    setTabLoading('t2', true, 's2')
    setTabLoading('t2', false, 's1')
    expect(tabLoadingOf('s2', 't2')).toBe(true)
  })

  it('clearTabLoading without a session drops the id in EVERY session', () => {
    setTabLoading('t1', true, 's1')
    setTabLoading('t1', true, 's2')
    clearTabLoading('t1')
    expect(tabLoadingOf('s1', 't1')).toBe(false)
    expect(tabLoadingOf('s2', 't1')).toBe(false)
    expect(tabLoadingCount()).toBe(0)
  })

  it('notifies subscribers only on real changes, monotonically', () => {
    const revisions: number[] = []
    const dispose = subscribeTabLoading(() => { revisions.push(tabLoadingRevision()) })
    try {
      setTabLoading('t1', true, 's1') // register → notify
      setTabLoading('t1', true, 's1') // the same state again → silent
      setTabLoading('t1', false, 's1') // settle → notify
      setTabLoading('t1', false, 's1') // clearing an absent entry → silent
      clearTabLoading('t1', 's1') // idempotent → silent
      expect(revisions).toHaveLength(2)
      expect(revisions[1]!).toBeGreaterThan(revisions[0]!)
    } finally {
      dispose()
    }
    // The disposer detaches: nothing records the next change.
    setTabLoading('t1', true, 's1')
    expect(revisions).toHaveLength(2)
    setTabLoading('t1', false, 's1')
  })
})

describe('useTabLoading', () => {
  it('re-renders the reader when its own tab flips, and only then', () => {
    let renders = 0
    let seen: boolean | undefined
    const Probe = (props: { sessionId: string | undefined; tabId: string }): ReactNode => {
      renders += 1
      seen = useTabLoading(props.sessionId, props.tabId)
      return createElement('div', null, seen === true ? 'loading' : 'idle')
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(Probe, { sessionId: 's1', tabId: 't1' })) })
    try {
      expect(seen).toBe(false)
      expect(container.textContent).toBe('idle')
      const rendersBefore = renders
      // A DIFFERENT tab's load must not re-render this reader: the boolean
      // snapshot did not change, so useSyncExternalStore bails out (this is
      // why the hook does not snapshot the store-wide revision).
      act(() => { setTabLoading('t2', true, 's1') })
      expect(renders).toBe(rendersBefore)
      // This tab's own load flips it, and the settle flips it back.
      act(() => { setTabLoading('t1', true, 's1') })
      expect(seen).toBe(true)
      expect(container.textContent).toBe('loading')
      act(() => { setTabLoading('t1', false, 's1') })
      expect(seen).toBe(false)
      expect(container.textContent).toBe('idle')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('pins the flag to false without a session (a strip that cannot name its seat)', () => {
    setTabLoading('t1', true, 's1')
    let seen: boolean | undefined
    const Probe = (props: { sessionId: string | undefined; tabId: string }): ReactNode => {
      seen = useTabLoading(props.sessionId, props.tabId)
      return null
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(Probe, { sessionId: undefined, tabId: 't1' })) })
    try {
      expect(seen).toBe(false)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
