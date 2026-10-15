/**
 * The dual-scope open-with composition: `mergeOpenWithConfigs` folds the
 * GLOBAL and PROJECT configs into the one effective config (project wins
 * where both sides configure the same thing, both sides contribute
 * everywhere else), and `openWithPinScope` decides which blob a pin toggle
 * must write so the two scopes never cross-contaminate each other.
 */
import { describe, expect, it } from 'vitest'
import {
  applyPathMappings,
  mergeOpenWithConfigs,
  OPEN_WITH_DEFAULTS,
  openWithPinScope,
  parseOpenWithConfig,
  type OpenWithConfig,
} from '../src/client/open-with.ts'

function config(patch: Partial<OpenWithConfig>): OpenWithConfig {
  return { ...OPEN_WITH_DEFAULTS, ...patch }
}

describe('mergeOpenWithConfigs', () => {
  it('an empty project config leaves the global config standing', () => {
    const globalConfig = config({
      sshHost: 'dev',
      customEditors: [{ id: 'a', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false }],
      pinned: ['vscode'],
      pathMappings: [{ id: 'm1', from: '/code/www', to: 'D:/code/www' }],
    })
    expect(mergeOpenWithConfigs(globalConfig, parseOpenWithConfig(undefined))).toEqual(globalConfig)
  })

  it('the project sshHost wins when set; a blank one falls through to global', () => {
    const globalConfig = config({ sshHost: 'dev' })
    expect(mergeOpenWithConfigs(globalConfig, config({ sshHost: 'prod' })).sshHost).toBe('prod')
    expect(mergeOpenWithConfigs(globalConfig, config({ sshHost: '  ' })).sshHost).toBe('dev')
  })

  it('custom editors merge by id: project rows first, global rows appended, collisions keep the project row', () => {
    const globalConfig = config({
      customEditors: [
        { id: 'shared', name: 'Global Name', urlTemplate: 'global://file/{path}', isVscodeFamily: false },
        { id: 'only-global', name: 'OnlyGlobal', urlTemplate: 'g2://file/{path}', isVscodeFamily: true },
      ],
    })
    const project = config({
      customEditors: [{ id: 'shared', name: 'Project Name', urlTemplate: 'project://file/{path}', isVscodeFamily: true }],
    })
    const merged = mergeOpenWithConfigs(globalConfig, project)
    expect(merged.customEditors.map(editor => editor.id)).toEqual(['shared', 'only-global'])
    expect(merged.customEditors[0]?.name).toBe('Project Name')
    expect(merged.customEditors[0]?.urlTemplate).toBe('project://file/{path}')
  })

  it('pinned ids union project-first and dedupe', () => {
    const merged = mergeOpenWithConfigs(
      config({ pinned: ['vscode', 'custom:a'] }),
      config({ pinned: ['zed', 'vscode'] }),
    )
    expect(merged.pinned).toEqual(['zed', 'vscode', 'custom:a'])
  })

  it('path mappings from both scopes apply; a same-prefix project row wins the tie', () => {
    const merged = mergeOpenWithConfigs(
      config({ pathMappings: [{ id: 'g1', from: '/code/www', to: 'G:/www' }, { id: 'g2', from: '/other', to: 'X:/other' }] }),
      config({ pathMappings: [{ id: 'p1', from: '/code/www', to: 'P:/www' }] }),
    )
    // The project row overrides the same-prefix global row…
    expect(applyPathMappings('/code/www/a.ts', merged.pathMappings)).toBe('P:/www/a.ts')
    // …while every other global mapping still applies.
    expect(applyPathMappings('/other/b.ts', merged.pathMappings)).toBe('X:/other/b.ts')
    // A longer global prefix still beats a shorter project one (longest wins).
    const longer = mergeOpenWithConfigs(
      config({ pathMappings: [{ id: 'g1', from: '/code/www/sub', to: 'S:/sub' }] }),
      config({ pathMappings: [{ id: 'p1', from: '/code/www', to: 'P:/www' }] }),
    )
    expect(applyPathMappings('/code/www/sub/c.ts', longer.pathMappings)).toBe('S:/sub/c.ts')
  })
})

describe('openWithPinScope', () => {
  const globalConfig = config({
    customEditors: [{ id: 'g-edit', name: 'GlobalEdit', urlTemplate: 'ge://file/{path}', isVscodeFamily: false }],
    pinned: ['vscode'],
  })
  const project = config({
    customEditors: [{ id: 'p-edit', name: 'ProjectEdit', urlTemplate: 'pe://file/{path}', isVscodeFamily: false }],
    pinned: ['zed'],
  })

  it('built-ins go to the global blob unless the project already pins them', () => {
    expect(openWithPinScope(globalConfig, project, 'explorer')).toBe('global')
    expect(openWithPinScope(globalConfig, project, 'vscode')).toBe('global')
    // `zed` is a built-in pinned on the PROJECT side — the toggle must land
    // there, or the pin could never be unpinned.
    expect(openWithPinScope(globalConfig, project, 'zed')).toBe('project')
  })

  it('a custom editor id lands in the blob that defines it', () => {
    expect(openWithPinScope(globalConfig, project, 'custom:p-edit')).toBe('project')
    expect(openWithPinScope(globalConfig, project, 'custom:g-edit')).toBe('global')
  })

  it('an unknown id defaults to the global blob', () => {
    expect(openWithPinScope(globalConfig, project, 'custom:ghost')).toBe('global')
  })
})
