/**
 * The floating-window layer of the side conversations: one persistent
 * FloatingWindow per popped-out thread, mounted at the sidebar root so the
 * windows survive every tab switch inside the panel (the TaskWindow/JobsDrawer
 * windows live inside their tabs and die with them — a chat is a watched
 * surface, exactly the thing that must NOT die).
 *
 * Multi-open is the feature: every record in {@link sidechatWindows} renders
 * its own window, so several conversations sit on screen at once next to the
 * sidebar, the workbench or each other. Fresh windows cascade by their open
 * slot (FloatingWindow's `offset`) instead of stacking pixel-exact.
 *
 * Each window renders the SAME {@link SideChatView} the tab renders, on a
 * synthetic tab carrying the thread binding (`floating` mutes its tab-title
 * sync — the synthetic id is not a real sidebar tab). Closing a window only
 * closes the window: the thread stays persisted, and its sidebar tab (when
 * open) keeps working. 收回侧栏 closes the window and focuses that tab.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { FloatingWindow } from './FloatingWindow.tsx'
import { SideChatView, sidechatThreadIdOf } from './SideChatView.tsx'
import { activateTab, allLeaves, type SidebarStore, type SidebarTab } from './state.ts'
import { sidechatWindows, type SidechatWindowRecord } from './sidechat-windows.ts'

/** Fresh-window cascade: each open shifts by one step so windows stack visibly. */
const CASCADE_STEP = 28
/** A chat wants a tall-narrow window, not the log window's 70%×60%. */
const INITIAL_SIZE = { width: 560, height: 640 }
const MIN_SIZE = { width: 380, height: 300 }

/** The synthetic tab a floating window's view renders on. The `sidechat-float:`
 *  prefix keeps the id out of the sidebar tab id space by construction. */
function floatingTabOf(record: SidechatWindowRecord): SidebarTab {
  return {
    id: `sidechat-float:${record.threadId}`,
    type: 'sidechat',
    title: record.title,
    meta: { threadId: record.threadId },
  }
}

/** One popped-out conversation's window. */
function SidechatWindow(props: {
  ctx: Parameters<typeof SideChatView>[0]['ctx']
  record: SidechatWindowRecord
  onDockBack: (threadId: string) => void
}): ReactNode {
  const { ctx, record, onDockBack } = props
  const tab = floatingTabOf(record)
  return (
    <FloatingWindow
      title={record.title}
      initialSize={INITIAL_SIZE}
      minSize={MIN_SIZE}
      offset={{ x: record.slot * CASCADE_STEP, y: record.slot * CASCADE_STEP }}
      bodyLayout="fill"
      onClose={() => { onDockBack(record.threadId) }}
    >
      <SideChatView
        ctx={ctx}
        scope={{ sessionId: record.sessionId, cwd: record.cwd }}
        tab={tab}
        visible
        floating
        onDockBack={() => { onDockBack(record.threadId) }}
      />
    </FloatingWindow>
  )
}

/**
 * The window layer itself: mounted ONCE by the sidebar root (see Sidebar.tsx),
 * it renders every popped-out conversation and owns the dock-back gesture —
 * close the window, then focus the sidebar tab still bound to the thread when
 * one exists in the current session's tree.
 */
export function SidechatWindows(props: {
  ctx: Parameters<typeof SideChatView>[0]['ctx']
  store: SidebarStore
}): ReactNode {
  const { ctx, store } = props
  const windows = useSyncExternalStore(sidechatWindows.subscribe, sidechatWindows.getSnapshot)

  const dockBack = useCallback((threadId: string) => {
    sidechatWindows.close(threadId)
    // Focus the sidebar tab bound to this thread, when the current session
    // still carries one (a closed or other-session tab just leaves the
    // thread to the composer-bar thread menu).
    const snapshot = store.getSnapshot()
    const tree = snapshot.state?.bottomSplits
    if (tree === undefined) return
    for (const leaf of allLeaves(tree)) {
      const tab = leaf.tabs.find(candidate => sidechatThreadIdOf(candidate) === threadId)
      if (tab !== undefined) {
        store.reduce(current => activateTab(current, leaf.id, tab.id))
        return
      }
    }
  }, [store])

  return (
    <>
      {windows.map(record => (
        <SidechatWindow key={record.threadId} ctx={ctx} record={record} onDockBack={dockBack} />
      ))}
    </>
  )
}
