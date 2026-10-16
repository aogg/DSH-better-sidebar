// @vitest-environment jsdom
/**
 * The native tab registration LIFECYCLE (`src/client/native/index.ts`): what a
 * store/service notification may do to the host's tab-type registry, and what
 * a failed registration is allowed to leave behind.
 *
 * The failure this locks is a plugin RELOAD: cordis tears the fiber down, each
 * built-in descriptor is unregistered one by one, every unregistration notifies
 * the plugin's service, and `sync()` therefore runs again on a context that is
 * already inactive. A registration attempted there throws
 * (`ctx.effect` on an inactive context) — and if the host-side type was already
 * registered at that point, its disposer is lost, the id stays taken for the
 * rest of the page's life, and every later attempt is refused with
 * `tab type id "…" is already registered`. The kind then renders the host's
 * "nothing here can view this kind of content" face until a page refresh.
 *
 * Three properties keep that impossible, and all are asserted here:
 *   1. an unrelated notification never re-creates the `files` takeover (the
 *      tear-down/re-register window the reload used to walk into);
 *   2. a registration that fails after its type was registered releases the
 *      type again, so the id stays registrable and one broken descriptor cannot
 *      take the others down with it;
 *   3. slots installed before the failing one are released too (the partial
 *      release inside `registerSlots`).
 *
 * The assertions are written against the fake registry's EVENT LOG, not only
 * against the set of live ids: an orphaned type leaves the key set identical to
 * a healthy one, so a key-set assertion would pass on the unfixed code and pin
 * nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

/**
 * The fake `sidebarRightTabs`, mirroring the host's two hard rules: one
 * registration per id, and the returned disposer is the only way to free it.
 */
function createRegistry() {
  const registered = new Map<string, () => void>()
  const events: string[] = []
  /** Every definition the plugin handed the host, guide rows included. */
  const definitions: Array<{ id: string; kind: string; multiple?: boolean; guide?: Array<{ id?: unknown }> }> = []
  let failReleaseOf: string | undefined
  return {
    registered,
    events,
    definitions,
    failRelease(id: string): void { failReleaseOf = id },
    register(definition: { id: string; kind: string; multiple?: boolean; guide?: Array<{ id?: unknown }> }): () => void {
      definitions.push(definition)
      if (registered.has(definition.id)) {
        throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
      }
      events.push(`register ${definition.id}`)
      // The host's disposer is IDEMPOTENT (a cordis effect disposer returns
      // the same task on a second call), so a repeated release must neither
      // log again nor pretend to free something twice.
      let released = false
      const dispose = (): void => {
        if (released) return
        if (failReleaseOf === definition.id) throw new Error(`cannot release ${definition.id}`)
        released = true
        registered.delete(definition.id)
        events.push(`release ${definition.id}`)
      }
      registered.set(definition.id, dispose)
      return dispose
    },
  }
}

/**
 * The host's slot DECLARATIONS this surface touches, with each slot's `kind`.
 * `@deepseek-ai/dsh-client-ui-slots` validates every registration against the
 * declaration's kind, and the host's sidebar-right package declares exactly
 * these three (its `rightbar.session` children table):
 *
 *   - `sidebar.right.pane.tab`        keyed — one body per native tab type
 *   - `sidebar.right.pane.tab.title`  keyed — one chip title per native tab type
 *   - `sidebar.right.tab.menu.item`   list  — the tab-menu copy rows
 *
 * The fake `slots.register` below validates AGAINST THIS TABLE — the host's
 * word, not the plugin's habits — with the host's exact error messages. The
 * original bug (fixed in 61edbf2) shipped precisely because the previous fake
 * accepted whatever the plugin happened to send: a `key` handed to the list
 * slot passed the fake and exploded only at runtime on the real host
 * (`list slot "sidebar.right.tab.menu.item" requires options.id`).
 */
const SLOT_KINDS: Record<string, 'keyed' | 'list'> = {
  'sidebar.right.pane.tab': 'keyed',
  'sidebar.right.pane.tab.title': 'keyed',
  'sidebar.right.tab.menu.item': 'list',
}

/**
 * A fake client context: `slots.inject` runs its callback synchronously (the
 * real one resolves the declaration and calls `ctx.effect`, which throws while
 * `inactive`), a slot listed in `failSlots` throws from `slots.register`, and
 * `inject` hands back the registry while honouring the callback's own teardown.
 *
 * `failSlots` is keyed by the slot's IDENTITY, which follows its declared
 * kind: `name::key` for a keyed slot, `name#id` for a list one. Both slots of
 * a descriptor share the same key, so a key-keyed failure can only ever fail
 * the FIRST slot; failing the second one for a single descriptor is the only
 * shape that exercises `registerSlots`' partial release (the first slot is
 * already installed when the second throws).
 */
function createHost() {
  const registry = createRegistry()
  /** Slot registrations and releases, in order (the partial-release witness). */
  const slotEvents: string[] = []
  // One mutable state object the ctx closures read: the test flips it after
  // the host was built.
  const state = {
    /** True while the plugin's context is being torn down (the reload case). */
    inactive: false,
    /** Slot identities whose registration throws (kind-shaped, see above). */
    failSlots: new Set<string>(),
  }
  const ctx = {
    inject: (
      _deps: readonly string[],
      callback: (injected: { get: (name: string) => unknown }) => (() => void) | void,
    ) => {
      const teardown = callback({ get: () => registry })
      return { dispose: () => { if (typeof teardown === 'function') teardown() } }
    },
    get: () => registry,
    slots: {
      inject: (_name: string, callback: () => Array<() => void> | (() => void)) => {
        if (state.inactive) throw new Error('cannot create effect on inactive context')
        return typeof callback === 'function' ? callback() : () => {}
      },
      register: (options: { name: string; key?: string; id?: string }) => {
        // The host refuses an undeclared slot before it even looks at the
        // options (dsh-client-ui-slots: `slot "…" is not declared …`).
        const kind = SLOT_KINDS[options.name]
        if (kind === undefined) {
          throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
        }
        // Then the per-kind option requirements, VERBATIM from the host's
        // `register`: a keyed slot needs `options.key`, a list slot needs
        // `options.id` — a `key` is NOT an id, so the old `key:`-shaped menu
        // registration throws here exactly as it did on the real host.
        if (kind === 'keyed' && options.key === undefined) {
          throw new Error(`keyed slot "${options.name}" requires options.key`)
        }
        if (kind === 'list' && options.id === undefined) {
          throw new Error(`list slot "${options.name}" requires options.id`)
        }
        const identity = kind === 'list' ? `${options.name}#${options.id}` : `${options.name}::${options.key}`
        if (state.failSlots.has(identity)) throw new Error(`slot registration for "${identity}" failed`)
        slotEvents.push(`register ${identity}`)
        return () => { slotEvents.push(`release ${identity}`) }
      },
    },
  }
  return { registry, slotEvents, state, ctx }
}

/** A store + service with two enabled descriptors, plus the record registry. */
function createPlugins() {
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  service.registerTab({ id: 'editor', title: 'Files', component: () => null, icon: () => null })
  service.registerTab({ id: 'git', title: 'Changes', component: () => null })
  return { store, service, records: createNativeTabRecords() }
}

/** Silence (and count) the failure logs the fixed code reports on purpose. */
function silenceFailures(): { restore: () => void; messages: string[] } {
  const messages: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(' '))
  })
  return { restore: () => { spy.mockRestore() }, messages }
}

/**
 * The phase labels a surface reports through the client's visible diagnostic
 * channel (`reportFailure` → `fail('native ' + phase, error)`), plus the error
 * messages themselves — some assertions need the HOST's exact wording.
 */
function collectReports(): { phases: string[]; errors: string[]; report: (phase: string, error?: unknown) => void } {
  const phases: string[] = []
  const errors: string[] = []
  return {
    phases,
    errors,
    report: (phase, error) => {
      phases.push(phase)
      if (error !== undefined) errors.push(error instanceof Error ? error.message : String(error))
    },
  }
}

describe('native tab registration lifecycle', () => {
  it('releases a type whose slot registration failed, and can register it again later', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const reports = collectReports()
    // The reload: the context goes inactive while notifications are still
    // arriving, so every slot registration fails after its type registered.
    host.state.inactive = true
    expect(() => registerNativeSurface({
      ctx: host.ctx as never, store, service, records, reportFailure: reports.report,
    })).not.toThrow()
    expect([...host.registry.registered.keys()], 'a failed registration leaves no type behind').toEqual([])
    // Each of them is reported through the visible channel, not swallowed —
    // the tab-menu copy-row slot too: injected ahead of `sync()` in the same
    // body, an inactive window fails it like any descriptor's slots, and the
    // fix routes that failure through this same visible channel (pinned here).
    expect(reports.phases.sort()).toEqual([
      'register editor',
      'register files',
      'register git',
      'register the tab-menu copy rows',
    ])

    // The context comes back (the reload's next activation): the same ids must
    // be registrable — no "already registered" from the orphan. The event log
    // is the discriminating assertion: a leaked type would keep the key set
    // looking correct while the retry throws into the same catch.
    host.state.inactive = false
    host.registry.events.length = 0
    store.setPrefs(store.getPrefs())
    expect(host.registry.events.sort()).toEqual([
      'register dsh-better-sidebar:editor',
      'register dsh-better-sidebar:files',
      'register dsh-better-sidebar:git',
    ])
  })

  it('never re-creates the "files" takeover on an unrelated notification', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })
    // The takeover is this module's own entry (never a descriptor), so no
    // store/service notification has any business touching it. Before the fix
    // every notification disposed and re-created it.
    host.registry.events.length = 0
    for (let round = 0; round < 3; round++) store.setPrefs(store.getPrefs())
    expect(host.registry.events, 'no notification may tear the "files" takeover down').toEqual([])
    expect(host.registry.registered.has('dsh-better-sidebar:files')).toBe(true)
    dispose()
  })

  it('keeps the other tab types when one descriptor cannot register', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const reports = collectReports()
    // The SECOND slot of ONE descriptor: its type and its body slot are
    // already installed when this one throws.
    host.state.failSlots.add('sidebar.right.pane.tab.title::dsh-better-sidebar:git')
    const log = silenceFailures()
    try {
      expect(() => registerNativeSurface({
        ctx: host.ctx as never, store, service, records, reportFailure: reports.report,
      })).not.toThrow()
      expect([...host.registry.registered.keys()].sort()).toEqual([
        'dsh-better-sidebar:editor',
        'dsh-better-sidebar:files',
      ])
      expect(reports.phases).toEqual(['register git'])
      // The body slot installed before the failure was released; the failing
      // one never registered, so there is nothing to release for it.
      expect(host.slotEvents.filter(event => event === 'release sidebar.right.pane.tab::dsh-better-sidebar:git'))
        .toHaveLength(1)
      expect(host.slotEvents.filter(event => event === 'release sidebar.right.pane.tab.title::dsh-better-sidebar:git'))
        .toEqual([])

      // The broken descriptor is retried on the next sync instead of being
      // written off — and the retry REGISTERS it (event log), rather than
      // merely ending up with a key set a leaked type produces as well.
      host.state.failSlots.clear()
      host.registry.events.length = 0
      store.setPrefs(store.getPrefs())
      expect(host.registry.events).toEqual(['register dsh-better-sidebar:git'])
    } finally {
      log.restore()
    }
  })

  it('releases every registration on teardown even when one release throws', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const log = silenceFailures()
    try {
      const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })
      host.registry.failRelease('dsh-better-sidebar:editor')
      expect(() => dispose()).not.toThrow()
      expect([...host.registry.registered.keys()]).toEqual(['dsh-better-sidebar:editor'])
    } finally {
      log.restore()
    }
  })
})

/**
 * The host `multiple` contract (`SidebarRightTabDefinition.multiple`): with it,
 * every open by kind mints independent content; without it the host keeps ONE
 * page per kind in each pane and only re-delivers navigation params. The
 * registration keys it off `descriptor.createTab`: a descriptor that mints its
 * own tabs per open (the side chat) needs every open to become a new page,
 * while the page kinds must stay one-per-pane — the host's dedupe is what
 * focuses a repeat open of those (and re-delivers the params a focus needs).
 */
describe('the native type registration carries the host `multiple` contract', () => {
  it('registers a createTab kind with multiple and the page kinds without', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    // The sidechat shape (the only built-in with `createTab` that ever reaches
    // the native surface; terminal-bottom has one too but is `bottomOnly`).
    service.registerTab({
      id: 'sidechat',
      title: 'Side Chat',
      createTab: () => ({ tab: { id: `sidechat:${crypto.randomUUID()}`, type: 'sidechat', title: 'Side Chat' } }),
      dedupeKey: (tab) => (tab.meta as { threadId?: string } | undefined)?.threadId,
      component: () => null,
    })
    // The single-page kinds: `single` is sugar for `dedupeKey: () => id`, and
    // none of them mints (files/changes/tasks/subagent/settings).
    service.registerTab({ id: 'subagent', title: 'Tasks', single: true, component: () => null })
    service.registerTab({ id: 'settings', title: 'Settings', single: true, component: () => null })
    const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })
    const multipleOf = (kind: string): unknown =>
      host.registry.definitions.find(definition => definition.kind === kind)?.multiple
    expect(multipleOf('sidechat')).toBe(true)
    // Absent — not merely falsy: `multiple === true` is the host's exact mint
    // test, so anything else (including a forgotten field) keeps one page per
    // kind per pane.
    for (const kind of ['editor', 'git', 'files', 'subagent', 'settings']) {
      expect(multipleOf(kind), `kind "${kind}" must stay a single page`).toBeUndefined()
    }
    dispose()
  })
})

/**
 * `bottomOnly` (#774): the type lives in the plugin's own workbench only.
 *
 * The mount lane pins the OUTCOME (the host's guide still lists exactly one
 * `terminal` capsule), but until this case existed the MECHANISM had no unit
 * guard at all: the #774 verification measured 14 related specs / 158
 * assertions staying green with the `bottomOnly` skip in `sync()` deleted, so
 * only a full deployment could catch it. This is the unit half, written on what
 * actually reached the host rather than on what the plugin intended to send.
 */
describe('a bottomOnly descriptor never reaches the native surface', () => {
  it('registers no tab type, no slot and no guide row for it', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    // The sixth built-in (#774), declared through the same public API an
    // external plugin uses.
    service.registerTab({
      id: 'terminal-bottom',
      title: () => 'Terminal',
      description: () => 'Bottom shell',
      bottomOnly: true,
      single: true,
      component: () => null,
    })
    const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })

    // Positive control FIRST: the other descriptors did reach the host, and the
    // visible one did contribute its guide row — so the absences below cannot
    // be satisfied by a surface that registers nothing at all. (The `files`
    // takeover follows the descriptor loop, hence its place at the end.)
    expect(host.registry.events).toEqual([
      'register dsh-better-sidebar:editor',
      'register dsh-better-sidebar:git',
      'register dsh-better-sidebar:files',
    ])
    const guideIds = host.registry.definitions
      .flatMap(definition => (definition.guide ?? []).map(entry => entry.id))
    expect(guideIds.sort()).toEqual(['files', 'git'])

    // The absence rides the EVENT LOG, not the live key set: a type registered
    // and then orphaned leaves a key set that looks exactly like this one.
    expect(host.registry.registered.has('dsh-better-sidebar:terminal-bottom')).toBe(false)
    expect(host.registry.events.filter(event => event.includes('terminal-bottom'))).toEqual([])
    expect(host.slotEvents.filter(event => event.includes('terminal-bottom'))).toEqual([])

    // A notification re-runs `sync()`; the skip must survive it.
    store.setPrefs(store.getPrefs())
    expect(host.registry.events.filter(event => event.includes('terminal-bottom'))).toEqual([])
    dispose()
  })
})

/**
 * The HOST tab context menu's copy rows (src/client/native/tab-menu.tsx):
 * one `sidebar.right.tab.menu.item` slot registration per surface activation,
 * carrying the list entry id `better-sidebar-copy-path`. The slot is declared
 * `kind: "list"` by the host's sidebar-right package, so the entry is
 * identified by `options.id` — a `key` is not read there at all — and ONE
 * registration serves every file-address tab in the column — it is
 * deliberately NOT a descriptor entry and never lives in the per-descriptor
 * `live` map, so the assertions are written against the fake registry's slot
 * EVENT LOG: once registered, untouched by any notification, and the FIRST
 * slot released when the surface's disposer runs.
 */
describe('the host tab-menu copy rows ride the sidebar.right.tab.menu.item slot', () => {
  it('registers the slot once, keeps it across notifications, and releases it first on teardown', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const dispose = registerNativeSurface({ ctx: host.ctx as never, store, service, records })

    // Registered during the surface's activation, before any descriptor's
    // slots (the inject body installs it ahead of `sync()`), and the event
    // carries BOTH the slot name and the list entry ID (the `name#id`
    // identity — a `::` key would mean the plugin regressed to `key:`).
    expect(host.slotEvents[0]).toBe('register sidebar.right.tab.menu.item#better-sidebar-copy-path')

    // One registration serves every tab, so no store/service pulse may
    // rebuild it — the same no-churn rule the descriptor slots are pinned
    // with above.
    store.setPrefs(store.getPrefs())
    expect(host.slotEvents.filter(event => event.includes('sidebar.right.tab.menu.item'))).toEqual([
      'register sidebar.right.tab.menu.item#better-sidebar-copy-path',
    ])

    dispose()
    // And the menu slot is the FIRST slot released — the teardown runs the
    // menu disposers ahead of the descriptor registrations, so a partial
    // teardown never strands the rows on a live menu.
    expect(host.slotEvents.filter(event => event.startsWith('release'))[0])
      .toBe('release sidebar.right.tab.menu.item#better-sidebar-copy-path')
  })
})

/**
 * The fake slot registry must enforce the host's per-kind options contract —
 * the regression this file now guards against shipped precisely because the
 * old fake accepted a `key` where the host's list slot demands `options.id`,
 * so the mismatch only ever surfaced at runtime on a deployed plugin. These
 * cases pin the fake to the host's exact messages (dsh-client-ui-slots'
 * `register`) and prove that a violating registration is REPORTED through the
 * visible channel without taking the rest of the surface down.
 */
describe('the fake slot registry enforces the host per-kind options contract', () => {
  it('throws the host message when the list slot lacks options.id (the regression shape)', () => {
    const host = createHost()
    // The pre-fix plugin's exact call shape: `key` handed to a list slot. The
    // host never reads `key` there, so the id is simply missing — and it must
    // fail identically with the key present and with nothing at all.
    expect(() => host.ctx.slots.register({ name: 'sidebar.right.tab.menu.item', key: 'better-sidebar-copy-path' }))
      .toThrowError('list slot "sidebar.right.tab.menu.item" requires options.id')
    expect(() => host.ctx.slots.register({ name: 'sidebar.right.tab.menu.item' }))
      .toThrowError('list slot "sidebar.right.tab.menu.item" requires options.id')
  })

  it('reports the missing-id menu registration through the visible channel and keeps the descriptors up', () => {
    const host = createHost()
    const { store, service, records } = createPlugins()
    const reports = collectReports()
    // Simulate the pre-fix plugin (the shape 61edbf2 replaced): whatever id
    // the surface hands over is stripped, so the host-facing call carries
    // `key` only — the fake must reject it with the host's message.
    const register = host.ctx.slots.register as (options: unknown, component?: unknown) => () => void
    host.ctx.slots.register = (options: { name: string; key?: string; id?: string }, component?: unknown) => (
      options.name === 'sidebar.right.tab.menu.item'
        ? register({ ...options, id: undefined, key: 'better-sidebar-copy-path' }, component)
        : register(options, component)
    )
    expect(() => registerNativeSurface({
      ctx: host.ctx as never, store, service, records, reportFailure: reports.report,
    })).not.toThrow()
    expect(reports.phases).toEqual(['register the tab-menu copy rows'])
    expect(reports.errors).toEqual(['list slot "sidebar.right.tab.menu.item" requires options.id'])
    // The menu slot never installed…
    expect(host.slotEvents.filter(event => event.includes('sidebar.right.tab.menu.item'))).toEqual([])
    // …and the failure took nothing else down — the containment the visible
    // report channel exists for.
    expect([...host.registry.registered.keys()].sort()).toEqual([
      'dsh-better-sidebar:editor',
      'dsh-better-sidebar:files',
      'dsh-better-sidebar:git',
    ])
  })

  it('throws the host message when a keyed slot lacks options.key', () => {
    const host = createHost()
    expect(() => host.ctx.slots.register({ name: 'sidebar.right.pane.tab', id: 'dsh-better-sidebar:editor' }))
      .toThrowError('keyed slot "sidebar.right.pane.tab" requires options.key')
  })
})
