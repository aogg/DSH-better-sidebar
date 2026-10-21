/**
 * The built-in tab descriptors: the plugin registers its own pages
 * (editor / git — the unified changes tab / subagent / sidechat / terminal-bottom /
 * settings / diff) through
 * the same {@link BetterSidebarService} external plugins use — eating its
 * own dogfood. The editor IS the files window (the old standalone explorer
 * merged into it).
 *
 * DSH 0.1.6-alpha.2 ships its own right-Sidebar terminal and browser tab
 * types, so this plugin contributes neither: the host's `terminal` kind owns
 * interactive shells outright, and the host's `browser` kind (delegated to
 * from the chat's http(s) links) owns embedded pages. See
 * docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md.
 *
 * `terminal-bottom` (#774) is the one type that is NOT a host tab: it is the
 * plugin's own bottom workbench terminal, driving the host's session-scoped
 * terminal service through a self-drawn xterm. It declares `bottomOnly` so it
 * can never become a second right-Sidebar terminal capsule beside the host's
 * own. See docs/plans/2026-10-05-bottom-terminal-tab.md.
 *
 * `settings` is the sidebar's OWN settings page: its guide registration puts a
 * 「设置」door on the right column's start page (the host guide), and picking it
 * opens the Side card preferences as a real page — the same section the hero
 * start page's settings panel mounts, on the same store.
 */
import { IconCodeOutlineRegular, IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  changesTabIcon, filesTabIcon, historyTabIcon, settingsTabIcon, sidechatTabIcon, tasksTabIcon, terminalTabIcon,
} from './tab-icons.tsx'
import { t } from '../locales.ts'
import { openSidebarFile } from '../sidebar-file.ts'
import { EditorHost } from '../EditorHost.tsx'
import { OpenWithSettings } from '../open-with-settings.tsx'
import { CommitModelSettings } from '../changes/CommitModelSettings.tsx'
import { ChangesTab, opCountOf } from '../changes/ChangesTab.tsx'
import { DiffTab } from '../DiffTab.tsx'
import { SettingsPage } from '../SettingsPage.tsx'
import { SubagentView } from '../SubagentView.tsx'
import { consumeSidechatSeed, SideChatView, sidechatThreadIdOf } from '../SideChatView.tsx'
import { isSidechatFloating } from '../sidechat-windows.ts'
import { HistoryView } from '../HistoryView.tsx'
import { LazyTerminalBottom } from '../terminal-lazy.tsx'
import { CWD_FIELD, INSTANCE_FIELD, closeBottomTerminal, consumeBottomTerminalCwd, webTerminals } from '../terminal-client.ts'
import { api } from '../api.ts'
import type { Context } from '../../context-types.ts'
import type { TabDescriptor } from '../service.ts'

/** The 7 built-in tab descriptors (the host owns the right-Sidebar terminal and browser). */
export function builtinTabs(ctx: Context): readonly TabDescriptor[] {
  return [
    {
      id: 'editor',
      description: () => t('guideDescFiles'),
      // The single files window: an editor tab with no path IS the file
      // explorer (empty hint + docked tree); with a path it previews/edits
      // the file. Visible in the + menu in the explorer's old slot.
      title: () => t('files'),
      icon: filesTabIcon,
      order: 10,
      hidden: false,
      dedupeKey: (tab) => tab.path,
      // Declarative settings: the file-open behavior picker (in-place switch
      // vs per-path windows) renders as an iconed select row under the
      // editor card's gear in the Side card settings page; the exclude-pattern
      // rows (VS Code files.exclude style) sit below it, and the "open with"
      // configuration (SSH host + custom editors) is the custom panel BELOW
      // those rows — the settings seam renders rows first, custom panel after.
      // The workspace-fence switch is GONE: there is no containment to toggle.
      settings: {
        toggles: [{
          key: 'editorExplorer',
          type: 'select',
          title: () => t('editorExplorer'),
          desc: () => t('editorExplorerDesc'),
          options: [
            {
              value: true,
              icon: (size: number) => <IconPanelLeftOutlineRegular size={size} />,
              title: () => t('editorExplorerMerged'),
              desc: () => t('editorExplorerMergedDesc'),
            },
            {
              value: false,
              icon: (size: number) => <IconCodeOutlineRegular size={size} />,
              title: () => t('editorExplorerSplit'),
              desc: () => t('editorExplorerSplitDesc'),
            },
          ],
        }, {
          key: 'explorerExclude',
          type: 'patterns',
          title: () => t('explorerExclude'),
          desc: () => t('explorerExcludeDesc'),
          patternsPlaceholder: t('explorerExcludePlaceholder'),
        }, {
          // The tree's TortoiseGit-style status badges (green ✓ overlay on a
          // tracked clean path, the colored ! / ✕ / + vocabulary otherwise).
          // One plain boolean, default on; off restores the plain tree.
          key: 'explorerGitBadges',
          title: () => t('settingsExplorerGitBadgesTitle'),
          desc: () => t('settingsExplorerGitBadgesDesc'),
        }],
        // Plugin-owned rows (values live in `pluginSettings['editor']`): the
        // plugin's own open-with targets are shown only when the host reports
        // no local application, unless the user asks for both side by side.
        pluginToggles: [{
          key: 'openWithPluginTargets',
          title: () => t('settingsOpenWithPluginTitle'),
          desc: () => t('settingsOpenWithPluginDesc'),
        }],
        render: ({ pluginSettings, updatePluginSetting }) => (
          <OpenWithSettings pluginSettings={pluginSettings} updatePluginSetting={updatePluginSetting} />
        ),
      },
      component: ({ ctx, store, scope, tab, visible, expanded, revealed, onToggleDir, onReferenceFile }) => (
        <EditorHost
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          visible={visible}
          expanded={expanded ?? []}
          revealed={revealed ?? []}
          onToggleDir={onToggleDir ?? (() => { /* no-op */ })}
          onReferenceFile={onReferenceFile ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      // The unified changes tab (id kept as 'git' so persisted layouts keep
      // resolving): the Git lens is the former source-control panel; the
      // session lens is the former file-trace tab (PR #471). Both preview
      // through one shared diff stack. The badge reads the op-count cache
      // the tab's event poll publishes (the client ctx exposes no event
      // log, and the git status needs a fetch — both stay out of the badge).
      id: 'git',
      title: () => t('changes'),
      description: () => t('guideDescGit'),
      icon: changesTabIcon,
      order: 20,
      single: true,
      // Custom settings panel (not a declarative toggle row): the pinned
      // commit-message model is picked from the DISCOVERED catalog, so the
      // option list only exists at render time.
      settings: {
        render: CommitModelSettings,
      },
      badge: (_ctx, scope) => {
        const count = opCountOf(scope.sessionId)
        return count === undefined || count === 0 ? null : count
      },
      component: ({ ctx, store, scope, tab, visible, onOpenDiff }) => (
        <ChangesTab
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          visible={visible}
          onOpenFile={(path) => { openSidebarFile(ctx, scope.sessionId, path) }}
          onOpenDiff={onOpenDiff}
        />
      ),
    },
    {
      id: 'subagent',
      title: () => t('subagent'),
      description: () => t('guideDescSubagent'),
      icon: tasksTabIcon,
      order: 30,
      single: true,
      // Declarative settings: the auto-open switches render under this row in
      // the Side card settings page (the Tasks page's related settings).
      settings: {
        toggles: [{
          key: 'autoOpenSubagent',
          title: () => t('settingsSubagentTitle'),
          desc: () => t('settingsSubagentDesc'),
        }, {
          key: 'autoOpenJobs',
          title: () => t('settingsJobsTitle'),
          desc: () => t('settingsJobsDesc'),
        }, {
          key: 'tasksViewMode',
          type: 'select',
          title: () => t('settingsViewModeTitle'),
          desc: () => t('settingsViewModeDesc'),
          options: [
            {
              value: 'graph',
              title: () => t('settingsViewModeGraph'),
              desc: () => t('settingsViewModeGraphDesc'),
            },
            {
              value: 'tree',
              title: () => t('settingsViewModeTree'),
              desc: () => t('settingsViewModeTreeDesc'),
            },
          ],
        }],
      },
      component: ({ ctx, store, scope, visible, onSubagentJump }) => (
        <SubagentView
          sessionId={scope.sessionId}
          ctx={ctx}
          store={store}
          active={visible}
          onOpenChild={(address) => { onSubagentJump?.(address.childSessionId) }}
        />
      ),
    },
    {
      id: 'sidechat',
      title: () => t('sideChat'),
      description: () => t('guideDescSidechat'),
      icon: sidechatTabIcon,
      order: 35,
      // Codex-style: EVERY side conversation is its own tab. A plain open
      // mints a fresh tab flagged `autoCreate` (the view creates the EMPTY
      // thread on mount); a thread switch from the header menu parks the
      // target id for a deterministic `sidechat:<threadId>` reattach tab.
      createTab: () => {
        const threadId = consumeSidechatSeed()
        if (threadId !== undefined) {
          return {
            tab: {
              id: `sidechat:${threadId}`,
              type: 'sidechat',
              title: t('sideChat'),
              meta: { threadId },
            },
          }
        }
        return {
          tab: {
            id: `sidechat:new-${crypto.randomUUID()}`,
            type: 'sidechat',
            title: t('sideChatUntitled'),
            meta: { autoCreate: true },
          },
        }
      },
      // One tab per thread: an already-open thread focuses instead of
      // duplicating; unbound fresh tabs never dedupe (each mints its own).
      dedupeKey: (tab) => sidechatThreadIdOf(tab),
      // Closing the tab releases the thread's live agent; the session and
      // its history stay persisted (reopen from any thread's header menu).
      // A thread that is currently POPPED OUT keeps its agent: the floating
      // window is still a live surface for it, so a tab close must not kill
      // the conversation the window is showing.
      onClose: (tab) => {
        const threadId = sidechatThreadIdOf(tab)
        if (threadId !== undefined && !isSidechatFloating(threadId)) {
          void api.sidechatDispose(threadId).catch(() => {})
        }
      },
      component: ({ ctx, scope, tab, visible }) => (
        <SideChatView ctx={ctx} scope={scope} tab={tab} visible={visible} />
      ),
    },
    {
      // 「历史发送」(the start page's prompt-history door): the hero pill's
      // openTab({ type: 'history' }) lands here — one shared page listing
      // the prompts the user has sent across sessions, grouped by session.
      // Records come from the history.list route backed by the plugin's
      // persistent per-project store; live appends and the seed-scan state
      // arrive over the session-push socket (no polling). Comments, tags and
      // related groups persist server-side too (see
      // src/prompt-history-routes.ts).
      id: 'history',
      title: () => t('historySent'),
      description: () => t('guideDescHistory'),
      icon: historyTabIcon,
      // Between the side chat (35) and the bottom terminal (40): a tool
      // page, but a visible door on the guide and in the + menu.
      order: 38,
      single: true,
      component: ({ scope, visible }) => (
        <HistoryView visible={visible} sessionId={scope.sessionId} />
      ),
    },
    {
      // The bottom workbench's terminal (#774). NOT the host's right-Sidebar
      // terminal: the plugin owns no PTY, this page is a self-drawn xterm
      // driven by the host's session-scoped terminal service
      // (src/client/terminal-client.ts), and the two terminals are separate
      // processes on purpose. `bottomOnly` is what keeps this type out of the
      // host's guide — a second "Terminal" capsule there would be the
      // shadowing the mount lane pins as absent.
      id: 'terminal-bottom',
      title: () => t('terminal'),
      description: () => t('guideDescTerminal'),
      icon: terminalTabIcon,
      // Below the four host-facing pages (10..35) and above the hidden diff
      // tab: the terminal is a secondary tool, but a visible menu row.
      order: 40,
      bottomOnly: true,
      // Multiple bottom terminals per session workbench (#774 follow-up).
      // Dropping the old `single: true` is the whole point: each open now
      // MINTS its own tab (unique id + `meta.terminalInstance`), so the +
      // menu stacks as many live shells as the host grants slots for, and
      // two tabs never share one host process (terminal-client.ts keys the
      // host binding by instance+run).
      //
      // A mint may also carry a start directory (the file tree's 「打开终端」,
      // parked by `requestBottomTerminalAt` immediately before its openTab —
      // the same one-shot seed the side chat's thread bootstrap uses, since a
      // createTab kind never sees the seed's own `meta`). The view spends the
      // field once the shell is writable (TerminalView.tsx) and drops it, so
      // a reload never re-runs the `cd`.
      createTab: () => {
        const startCwd = consumeBottomTerminalCwd()
        return {
          tab: {
            id: `terminal-bottom:${crypto.randomUUID()}`,
            type: 'terminal-bottom',
            title: t('terminal'),
            meta: {
              [INSTANCE_FIELD]: crypto.randomUUID(),
              ...(startCwd === undefined ? {} : { [CWD_FIELD]: startCwd }),
            },
          },
        }
      },
      // The service is probed, never injected (it is absent on deployments
      // without the host terminal controller): a missing service shows a
      // disabled menu row instead of a terminal that cannot start.
      available: (ctx) => webTerminals(ctx) !== undefined,
      // The bottom terminal never declares a title override: the tab strip
      // reads the descriptor's own title.
      component: LazyTerminalBottom,
      // Unmounting the view deliberately leaves the shell running (the host's
      // "a view survives DOM unmount" contract, and what makes a reload
      // reattach), so closing the TAB is the only thing that ends the process
      // — without it every closed bottom terminal would hold one of the host's
      // per-session terminal slots forever.
      onClose: (tab, scope) => {
        // Every close path resolves a scope (the type makes it required), so
        // this guard should be unreachable. It returns instead of substituting
        // `''` for a missing one because an empty session id is the ONE option
        // that is worse than doing nothing: the host would look the terminal up
        // in a session that does not exist, no-op, and leave the shell running
        // — invisibly holding a per-session terminal slot for the page's life.
        const sessionId: string | undefined = scope?.sessionId
        if (sessionId === undefined || sessionId === '') return
        closeBottomTerminal(ctx, tab, sessionId)
      },
    },
    {
      id: 'settings',
      // The sidebar's OWN settings page (the 侧边栏开始页's「设置」door): the
      // guide capsule lands through the descriptor's native guide registration,
      // and picking it opens this page in the pane — one real page, not a
      // popup. The hero start page's「设置」pill keeps its own in-hero panel;
      // both mount the same SideCardSection on the same store.
      title: () => t('startSettings'),
      description: () => t('guideDescSettings'),
      icon: settingsTabIcon,
      // Below the four host-facing pages and the bottom terminal (10..40): a
      // tool, but a visible door on the guide and in the + menu.
      order: 50,
      single: true,
      component: ({ ctx, store }) => (
        <SettingsPage ctx={ctx} store={store} />
      ),
    },
    {
      id: 'diff',
      title: () => t('changes'),
      icon: changesTabIcon,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.id,
      component: ({ scope, tab }) => (
        tab.diff === undefined ? null
          : <DiffTab sessionId={scope.sessionId} cwd={scope.cwd} diff={tab.diff} />
      ),
    },
  ]
}
