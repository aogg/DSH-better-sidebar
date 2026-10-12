/**
 * The file tree "open with" pure logic: config parsing (tolerant), target
 * resolution (built-ins + custom, SSH filtering), URL building (local file
 * URLs and VSCode-family SSH-remote URLs), the workspace→target path-prefix
 * mappings (segment-boundary match, longest prefix wins, URL targets only)
 * and the custom-editor validators.
 */
import { describe, expect, it } from 'vitest'
import {
  applyPathMappings,
  isValidCustomEditor,
  newCustomEditorId,
  normalizeUrlPath,
  openWithSshActive,
  openWithUrl,
  parseOpenWithConfig,
  resolveOpenWithTargets,
  type CustomEditor,
  type OpenWithTarget,
  type PathMapping,
} from '../src/client/open-with.ts'

describe('parseOpenWithConfig', () => {
  it('returns the defaults for null / non-object / array values', () => {
    const defaults = { sshHost: '', customEditors: [], pinned: [], pathMappings: [] }
    expect(parseOpenWithConfig(null)).toEqual(defaults)
    expect(parseOpenWithConfig('junk')).toEqual(defaults)
    expect(parseOpenWithConfig([])).toEqual(defaults)
  })

  it('keeps structurally valid custom editors (incl. in-progress rows) and drops junk', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      customEditors: [
        { id: 'a', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false },
        { id: 'b', name: '', urlTemplate: 'b://file/{path}', isVscodeFamily: true },
        { id: 'c', name: 'Trae', urlTemplate: 'trae://file/{path}', isVscodeFamily: true },
        'junk',
        null,
        42,
      ],
      pinned: ['vscode', 'custom:a', 42, '', 'custom:c'],
    })
    expect(config.sshHost).toBe('dev')
    expect(config.customEditors.map(editor => editor.id)).toEqual(['a', 'b', 'c'])
    expect(config.pinned).toEqual(['vscode', 'custom:a', 'custom:c'])
  })

  it('parses pathMappings tolerantly: junk rows dropped, blank-prefix rows kept', () => {
    const config = parseOpenWithConfig({
      pathMappings: [
        { id: 'm1', from: '/code/www', to: 'D:/code/www' },
        { id: 'm2', from: '', to: '' }, // in-progress settings row survives
        'junk',
        null,
        42,
        { id: 'm3', from: 42, to: 'X' }, // non-string prefix
        { id: 'm4', from: '/a' }, // missing to
        { id: '', from: '/a', to: 'B' }, // blank id
        { from: '/a', to: 'B' }, // missing id
      ],
    })
    expect(config.pathMappings).toEqual([
      { id: 'm1', from: '/code/www', to: 'D:/code/www' },
      { id: 'm2', from: '', to: '' },
    ])
  })

  it('falls back to no path mappings when the field is malformed or absent', () => {
    expect(parseOpenWithConfig({}).pathMappings).toEqual([])
    expect(parseOpenWithConfig({ pathMappings: 'junk' }).pathMappings).toEqual([])
    expect(parseOpenWithConfig(null).pathMappings).toEqual([])
  })
})

describe('resolveOpenWithTargets', () => {
  const localCustom: CustomEditor = { id: 'e1', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false }
  const familyCustom: CustomEditor = { id: 'e2', name: 'Zed-like fork', urlTemplate: 'x-zed://file/{path}', isVscodeFamily: true }

  it('lists built-ins first, then custom editors (local mode)', () => {
    const targets = resolveOpenWithTargets(parseOpenWithConfig({ customEditors: [localCustom] }))
    expect(targets.map(target => target.id)).toEqual(['explorer', 'vscode', 'cursor', 'zed', 'custom:e1'])
    expect(targets[0]?.kind).toBe('reveal')
    expect(targets[1]?.urlTemplate).toBe('vscode://file/{path}')
  })

  it('excludes incomplete custom-editor rows from the menu (they stay in the blob)', () => {
    const targets = resolveOpenWithTargets(parseOpenWithConfig({
      customEditors: [
        { id: 'e1', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false },
        { id: 'e2', name: '', urlTemplate: 'incomplete://file/{path}', isVscodeFamily: true },
      ],
    }))
    expect(targets.map(target => target.id)).toEqual(['explorer', 'vscode', 'cursor', 'zed', 'custom:e1'])
  })

  it('drops the local-only URL openers in SSH mode but KEEPS reveal (file manager)', () => {
    const config = parseOpenWithConfig({ sshHost: 'dev', customEditors: [localCustom, familyCustom] })
    const targets = resolveOpenWithTargets(config)
    // Zed and the non-VSCode custom editor cannot reach a remote path. The
    // `explorer` target stays: reveal runs on the host machine (the one that
    // owns the workspace) and is the only reveal left when the DSH host's own
    // open-in-app capability is unavailable.
    expect(targets.map(target => target.id)).toEqual(['explorer', 'vscode', 'cursor', 'custom:e2'])
    expect(targets[0]?.kind).toBe('reveal')
    expect(targets.filter(target => target.kind === 'reveal')).toHaveLength(1)
  })

  it('prunes unknown pinned ids only when resolving (the parse keeps them)', () => {
    const config = parseOpenWithConfig({ pinned: ['ghost'] })
    expect(config.pinned).toEqual(['ghost'])
    expect(resolveOpenWithTargets(config).map(target => target.id)).toContain('vscode')
  })
})

const mapping = (from: string, to: string, id = 'm'): PathMapping => ({ id, from, to })

describe('applyPathMappings', () => {
  const one = [mapping('/code/www', 'D:/code/www')]

  it('replaces the workspace prefix at a path-segment boundary', () => {
    expect(applyPathMappings('/code/www/my/x.ts', one)).toBe('D:/code/www/my/x.ts')
    expect(applyPathMappings('/code/www', one)).toBe('D:/code/www')
  })

  it('never matches half a segment name', () => {
    expect(applyPathMappings('/code/wwwx/a.ts', one)).toBe('/code/wwwx/a.ts')
    expect(applyPathMappings('/code/www-x/a.ts', one)).toBe('/code/www-x/a.ts')
    expect(applyPathMappings('/code/wwwa', one)).toBe('/code/wwwa')
  })

  it('ignores trailing slashes on from when matching', () => {
    const slash = [mapping('/code/www/', 'D:/code/www')]
    expect(applyPathMappings('/code/www/a.ts', slash)).toBe('D:/code/www/a.ts')
    expect(applyPathMappings('/code/www', slash)).toBe('D:/code/www')
  })

  it('picks the longest from; equal lengths keep the first configured row', () => {
    const two = [mapping('/code', 'X:/c', 'a'), mapping('/code/www', 'D:/code/www', 'b')]
    expect(applyPathMappings('/code/www/a.ts', two)).toBe('D:/code/www/a.ts')
    expect(applyPathMappings('/code/other.ts', two)).toBe('X:/c/other.ts')
    const tie = [mapping('/aa', 'FIRST', 'a'), mapping('/aa', 'SECOND', 'b')]
    expect(applyPathMappings('/aa/f.ts', tie)).toBe('FIRST/f.ts')
  })

  it('replaces once, at the head of the path only', () => {
    expect(applyPathMappings('/code/www/code/www/a.ts', one)).toBe('D:/code/www/code/www/a.ts')
  })

  it('normalizes backslashes of the path and from for matching', () => {
    expect(applyPathMappings('\\code\\www\\a.ts', [mapping('\\code\\www', 'D:/code/www')])).toBe('D:/code/www/a.ts')
    expect(applyPathMappings('/code/www\\a.ts', one)).toBe('D:/code/www/a.ts')
  })

  it('inserts to verbatim (no separator fixups)', () => {
    expect(applyPathMappings('/code/www/a.ts', [mapping('/code/www', 'D:/code/www/')])).toBe('D:/code/www//a.ts')
  })

  it('skips rows with a blank from or to', () => {
    const rows = [mapping('', 'D:/x', 'a'), mapping('/code/www', '', 'b'), mapping('  ', 'D:/x', 'c')]
    expect(applyPathMappings('/code/www/a.ts', rows)).toBe('/code/www/a.ts')
  })

  it('leaves unmatched paths unchanged', () => {
    expect(applyPathMappings('/home/u/a.ts', one)).toBe('/home/u/a.ts')
    expect(applyPathMappings('code/www/a.ts', one)).toBe('code/www/a.ts')
    expect(applyPathMappings('/code/www/a.ts', [])).toBe('/code/www/a.ts')
  })
})

describe('openWithUrl', () => {
  const targets = resolveOpenWithTargets(parseOpenWithConfig({}))
  const byId = (id: string): OpenWithTarget => {
    const target = targets.find(item => item.id === id)
    if (target === undefined) throw new Error(`no target ${id}`)
    return target
  }

  it('builds local file URLs with the raw path (backslashes normalized)', () => {
    expect(openWithUrl(byId('vscode'), '/home/u/f.ts', parseOpenWithConfig({}))).toBe('vscode://file//home/u/f.ts')
    expect(openWithUrl(byId('vscode'), 'C:\\Users\\u\\f.ts', parseOpenWithConfig({}))).toBe('vscode://file/C:/Users/u/f.ts')
    expect(openWithUrl(byId('zed'), '/x/y', parseOpenWithConfig({}))).toBe('zed://file//x/y')
  })

  it('builds SSH-remote URLs for VSCode-family targets in SSH mode', () => {
    const config = parseOpenWithConfig({ sshHost: 'dev' })
    expect(openWithUrl(byId('vscode'), '/home/u/f.ts', config))
      .toBe('vscode://vscode-remote/ssh-remote+dev/home/u/f.ts')
    expect(openWithUrl(byId('cursor'), '/home/u/f.ts', config))
      .toBe('cursor://vscode-remote/ssh-remote+dev/home/u/f.ts')
  })

  it('keeps the local URL form for non-VSCode-family targets even in SSH mode', () => {
    // (Such targets are hidden from the SSH menu; the URL builder stays honest.)
    expect(openWithUrl(byId('zed'), '/x', parseOpenWithConfig({ sshHost: 'dev' }))).toBe('zed://file//x')
  })

  it('returns undefined for reveal targets and malformed templates', () => {
    expect(openWithUrl(byId('explorer'), '/x', parseOpenWithConfig({}))).toBeUndefined()
    const noScheme: OpenWithTarget = { id: 'x', name: '', kind: 'url', urlTemplate: 'not-a-url {path}', isVscodeFamily: false, localOnly: false }
    expect(openWithUrl(noScheme, '/x', parseOpenWithConfig({}))).toBeUndefined()
    const noSlash: OpenWithTarget = { id: 'y', name: '', kind: 'url', urlTemplate: 'a:file/{path}', isVscodeFamily: false, localOnly: false }
    expect(openWithUrl(noSlash, '/x', parseOpenWithConfig({}))).toBeUndefined()
  })

  it('uses the custom template scheme for SSH URLs of VSCode-family custom editors', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      customEditors: [
        { id: 'e', name: 'Fork', urlTemplate: 'myfork://file/{path}', isVscodeFamily: true },
      ],
    })
    const targets = resolveOpenWithTargets(config)
    expect(openWithUrl(targets[targets.length - 1]!, '/r/f.ts', config))
      .toBe('myfork://vscode-remote/ssh-remote+dev/r/f.ts')
  })

  it('maps the workspace prefix for URL targets before the template substitution', () => {
    const config = parseOpenWithConfig({ pathMappings: [mapping('/code/www', 'D:/code/www')] })
    expect(openWithUrl(byId('vscode'), '/code/www/my/x.ts', config)).toBe('vscode://file/D:/code/www/my/x.ts')
    expect(openWithUrl(byId('zed'), '/code/www/my/x.ts', config)).toBe('zed://file/D:/code/www/my/x.ts')
  })

  it('maps custom-editor URL targets too', () => {
    const config = parseOpenWithConfig({
      pathMappings: [mapping('/code/www', 'D:/code/www')],
      customEditors: [{ id: 'e', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false }],
    })
    const target = resolveOpenWithTargets(config).find(item => item.id === 'custom:e')!
    expect(openWithUrl(target, '/code/www/a.ts', config)).toBe('windsurf://file/D:/code/www/a.ts')
  })

  it('leaves unmatched paths on the plain URL form', () => {
    const config = parseOpenWithConfig({ pathMappings: [mapping('/code/www', 'D:/code/www')] })
    expect(openWithUrl(byId('vscode'), '/home/u/f.ts', config)).toBe('vscode://file//home/u/f.ts')
    expect(openWithUrl(byId('vscode'), '/code/wwwx/f.ts', config)).toBe('vscode://file//code/wwwx/f.ts')
  })

  it('never maps reveal targets (the host file manager resolves the real path)', () => {
    const config = parseOpenWithConfig({ pathMappings: [mapping('/code/www', 'D:/code/www')] })
    expect(openWithUrl(byId('explorer'), '/code/www/x.ts', config)).toBeUndefined()
  })

  it('skips the mappings in SSH mode (the remote path is another namespace)', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      pathMappings: [mapping('/code/www', 'D:/code/www')],
    })
    expect(openWithUrl(byId('vscode'), '/code/www/f.ts', config))
      .toBe('vscode://vscode-remote/ssh-remote+dev/code/www/f.ts')
    expect(openWithUrl(byId('zed'), '/code/www/f.ts', config)).toBe('zed://file//code/www/f.ts')
  })
})

describe('helpers', () => {
  it('normalizeUrlPath converts backslashes to slashes', () => {
    expect(normalizeUrlPath('a\\b\\c')).toBe('a/b/c')
  })

  it('openWithSshActive trims the host', () => {
    expect(openWithSshActive(parseOpenWithConfig({ sshHost: '  ' }))).toBe(false)
    expect(openWithSshActive(parseOpenWithConfig({ sshHost: ' dev ' }))).toBe(true)
  })

  it('isValidCustomEditor requires a name, a {path} placeholder and a scheme:// prefix', () => {
    expect(isValidCustomEditor({ name: 'A', urlTemplate: 'a://file/{path}' })).toBe(true)
    expect(isValidCustomEditor({ name: '', urlTemplate: 'a://file/{path}' })).toBe(false)
    expect(isValidCustomEditor({ name: 'A', urlTemplate: 'a://file/x' })).toBe(false)
    expect(isValidCustomEditor({ name: 'A', urlTemplate: 'a:file/{path}' })).toBe(false)
  })

  it('newCustomEditorId yields unique non-empty ids', () => {
    const first = newCustomEditorId()
    const second = newCustomEditorId()
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThan(0)
  })
})
