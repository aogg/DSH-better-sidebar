/**
 * Workspace-dir-prefix compatibility for file-open path resolution.
 *
 * A model spelling a workspace-relative path in the chat body copies the
 * shape of the absolute path it sees (`/code/www/my/gitee/my-ai/dsh/…` →
 * `my-ai/dsh/…`), so the first segment is the workspace directory's own
 * name. Joined onto the session cwd verbatim that is one segment too many
 * and the open fails with ENOENT.
 *
 * The contract pinned here (see src/workspace-prefix.ts and
 * path-security.resolveTargetCompat):
 *
 * - the fallback lives on the HOST, at the layer that can stat — never in a
 *   purely lexical one;
 * - the LITERAL reading always wins when it exists (a real same-named
 *   subdirectory must never be hijacked);
 * - the stripped reading is tried only when the literal one is MISSING and
 *   the stripped one EXISTS; neither exists → the literal error, verbatim;
 * - only the FIRST segment strips, and only when it equals basename(cwd)
 *   exactly; `..` traversal, `~`, absolute-outside-cwd and non-first
 *   mentions are untouched;
 * - the write side (fs.write / editor save) redirects ONLY an edit session
 *   that carries a numeric mtime baseline and whose stripped destination
 *   exists — a missing destination is the normal case for a new file and is
 *   never redirected.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { apply } from '../src/index.ts'
import { AgentOpenRegistry, registerOpenTool } from '../src/agent-opens.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { pathExists, resolveTargetCompat } from '../src/path-security.ts'
import { workspaceDirPrefixRemainder } from '../src/workspace-prefix.ts'
import type { Context, SidebarWebRoute } from '../src/context-types.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fresh workspace whose LAST SEGMENT doubles as the chat prefix. */
function workspace(): { root: string; prefix: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wsp-'))
  roots.push(root)
  return { root, prefix: basename(root) }
}

describe('workspaceDirPrefixRemainder (pure lexical layer)', () => {
  it('strips a first segment equal to the workspace directory name (the repro spelling)', () => {
    // Non-ASCII directory names are exactly what real workspaces carry.
    expect(workspaceDirPrefixRemainder('/code/www/my/gitee/my-ai', 'my-ai/dsh/common公共/profiles/manage/index.md'))
      .toBe('dsh/common公共/profiles/manage/index.md')
  })

  it('returns an empty remainder when the target names the workspace root itself', () => {
    expect(workspaceDirPrefixRemainder('/code/www/my/gitee/my-ai', 'my-ai')).toBe('')
  })

  it('drops no-op segments but keeps the first-segment rule', () => {
    expect(workspaceDirPrefixRemainder('/ws/my-ai', './my-ai/./dsh/x.md')).toBe('dsh/x.md')
    expect(workspaceDirPrefixRemainder('/ws/my-ai', 'my-ai//dsh/x.md')).toBe('dsh/x.md')
  })

  it('never strips a non-first mention', () => {
    expect(workspaceDirPrefixRemainder('/ws/my-ai', 'a/my-ai/b')).toBeUndefined()
    expect(workspaceDirPrefixRemainder('/ws/my-ai', 'my-ai/my-ai/b')).toBe('my-ai/b')
  })

  it('refuses traversal anywhere in the path', () => {
    expect(workspaceDirPrefixRemainder('/ws/my-ai', '../my-ai/x')).toBeUndefined()
    expect(workspaceDirPrefixRemainder('/ws/my-ai', 'my-ai/../x')).toBeUndefined()
  })

  it('refuses a ~ target (home expansion owns that spelling)', () => {
    expect(workspaceDirPrefixRemainder('/ws/~', '~/x')).toBeUndefined()
    expect(workspaceDirPrefixRemainder('/ws/my-ai', '~/my-ai/x')).toBeUndefined()
  })

  it('matches the first segment exactly (case-sensitive)', () => {
    expect(workspaceDirPrefixRemainder('/ws/My-AI', 'my-ai/x')).toBeUndefined()
  })

  it('accepts a client-prejoined absolute spelling (<cwd>/prefix/…)', () => {
    expect(workspaceDirPrefixRemainder('/code/www/my/gitee/my-ai', '/code/www/my/gitee/my-ai/my-ai/dsh/x.md'))
      .toBe('dsh/x.md')
    // An absolute path that does not start with the cwd has no candidate.
    expect(workspaceDirPrefixRemainder('/code/www/my/gitee/my-ai', '/elsewhere/my-ai/dsh/x.md')).toBeUndefined()
    expect(workspaceDirPrefixRemainder('/code/www/my/gitee/my-ai', '/code/www/my/gitee/my-ai')).toBeUndefined()
  })

  it('normalizes both separator styles (win32 spellings included)', () => {
    expect(workspaceDirPrefixRemainder('C:\\code\\my-ai', 'my-ai/dsh/x.md')).toBe('dsh/x.md')
    expect(workspaceDirPrefixRemainder('C:/code/my-ai', 'my-ai\\dsh\\x.md')).toBe('dsh/x.md')
    expect(workspaceDirPrefixRemainder('C:\\code\\my-ai', 'C:/code/my-ai/my-ai/dsh/x.md')).toBe('dsh/x.md')
  })

  it('refuses a basename-less cwd', () => {
    expect(workspaceDirPrefixRemainder('/', 'my-ai/x')).toBeUndefined()
  })
})

describe('resolveTargetCompat (the probing layer)', () => {
  it('keeps the literal reading when it exists — a real same-named subdirectory wins', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, prefix), { recursive: true })
    writeFileSync(join(root, prefix, 'real.md'), 'inner')
    writeFileSync(join(root, 'real.md'), 'outer')
    await expect(resolveTargetCompat(root, `${prefix}/real.md`)).resolves.toBe(join(root, prefix, 'real.md'))
  })

  it('strips when the literal reading is missing and the stripped one exists (the repro)', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'index.md'), 'content')
    await expect(resolveTargetCompat(root, `${prefix}/dsh/index.md`)).resolves.toBe(join(root, 'dsh', 'index.md'))
  })

  it('returns the literal resolution when neither reading exists (error stays verbatim upstream)', async () => {
    const { root, prefix } = workspace()
    await expect(resolveTargetCompat(root, `${prefix}/dsh/missing.md`)).resolves.toBe(join(root, prefix, 'dsh', 'missing.md'))
    expect(await pathExists(join(root, prefix, 'dsh', 'missing.md'))).toBe(false)
  })

  it('leaves a non-qualifying target untouched (no prefix, no probes)', async () => {
    const { root } = workspace()
    await expect(resolveTargetCompat(root, 'a/missing.md')).resolves.toBe(join(root, 'a', 'missing.md'))
    // `..` traversal keeps its verbatim meaning (lexical collapse only).
    await expect(resolveTargetCompat(root, '../outside.md')).resolves.toBe(resolve(join(root, '..', 'outside.md')))
  })

  it('strips a client-prejoined absolute spelling when only the stripped one exists', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'index.md'), 'content')
    await expect(resolveTargetCompat(root, join(root, prefix, 'dsh', 'index.md'))).resolves.toBe(join(root, 'dsh', 'index.md'))
  })
})

/** Mount the plugin against a fake context whose session cwd is `workspace`. */
function mountApi(workspacePath: string): { api: SidebarWebRoute; write: SidebarWebRoute } {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: { register: (route: SidebarWebRoute) => { routes.push(route); return () => {} }, registerUpgrade: () => () => {} },
    sessions: { get: () => ({ header: { cwd: workspacePath } }) },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as unknown as Context, {})
  return {
    api: routes.find(route => route.path === '/sidebar/api')!,
    write: routes.find(route => route.path === '/sidebar/write')!,
  }
}

/** One JSON api call through the mounted route. */
async function invokeApi(
  route: SidebarWebRoute,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; value?: Record<string, unknown>; error?: { code?: string; message?: string } }> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Record<string, unknown>, status: out.status } as never
}

/** One raw-body save through `/sidebar/write` (the editor save route). */
async function invokeWrite(
  route: SidebarWebRoute,
  input: { path: string; content: string; expectedMtimeMs?: number },
): Promise<{ ok: boolean; status: number; error?: { code?: string; message?: string } }> {
  const params = new URLSearchParams({ sessionId: 's', path: input.path })
  if (input.expectedMtimeMs !== undefined) params.set('expectedMtimeMs', String(input.expectedMtimeMs))
  const body = Buffer.from(input.content, 'utf8')
  const req = {
    method: 'POST',
    url: `/sidebar/write?${params.toString()}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Record<string, unknown>, status: out.status } as never
}

describe('fs routes (route-level integration)', () => {
  it('fs.read opens a chat-spelled `prefix/dsh/…` path (the real repro)', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh', 'common公共', 'profiles', 'manage'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'common公共', 'profiles', 'manage', 'index.md'), '# manage')
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.read', { sessionId: 's', path: `${prefix}/dsh/common公共/profiles/manage/index.md` })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.value).toMatchObject({ kind: 'text', content: '# manage' })
  })

  it('fs.read keeps a real same-named subdirectory winning over the strip', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, prefix), { recursive: true })
    writeFileSync(join(root, prefix, 'real.md'), 'inner')
    writeFileSync(join(root, 'real.md'), 'outer')
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.read', { sessionId: 's', path: `${prefix}/real.md` })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.value).toMatchObject({ kind: 'text', content: 'inner' })
  })

  it('fs.read keeps absolute paths resolving verbatim', async () => {
    const { root } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'index.md'), 'content')
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.read', { sessionId: 's', path: join(root, 'dsh', 'index.md') })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.value).toMatchObject({ kind: 'text', content: 'content' })
  })

  it('fs.read keeps `..` traversal verbatim (never stripped)', async () => {
    const { root } = workspace()
    // Exactly where the verbatim join lands: the workspace's parent level.
    const outside = resolve(root, '..', 'outside.md')
    writeFileSync(outside, 'traversal')
    roots.push(outside)
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.read', { sessionId: 's', path: '../outside.md' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.value).toMatchObject({ kind: 'text', content: 'traversal' })
  })

  it('fs.read does not strip a non-first mention (the literal error surfaces)', async () => {
    const { root, prefix } = workspace()
    writeFileSync(join(root, 'real.md'), 'outer')
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.read', { sessionId: 's', path: `sub/${prefix}/real.md` })
    expect(out.ok).toBe(false)
    // The failure names the LITERAL path (the cwd join), never the stripped one.
    expect(out.error?.message ?? '').toContain(join(root, 'sub', prefix, 'real.md'))
  })

  it('fs.tree lists a chat-spelled `prefix/dsh` directory at the stripped root', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'a.md'), 'a')
    writeFileSync(join(root, 'dsh', 'b.md'), 'b')
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.tree', { sessionId: 's', path: `${prefix}/dsh` })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const value = out.value as { path: string; entries: { name: string }[] }
    expect(value.path).toBe(join(root, 'dsh'))
    expect(value.entries.map(entry => entry.name).sort()).toEqual(['a.md', 'b.md'])
  })

  it('fs.trees resolves a prefixed batch level (and reports failures under the requested spelling)', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'a.md'), 'a')
    const { api } = mountApi(root)
    const out = await invokeApi(api, 'fs.trees', { sessionId: 's', paths: [`${prefix}/dsh`, `${prefix}/missing`] })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    const levels = (out.value as { levels: { path: string; entries?: unknown; error?: string }[] }).levels
    expect(levels[0]!.path).toBe(join(root, 'dsh'))
    expect(levels[0]!.entries).toHaveLength(1)
    expect(levels[1]!.error).toBeDefined()
    expect(levels[1]!.path).toBe(join(root, prefix, 'missing'))
  })

  it('an editor save through /sidebar/write lands on the stripped file when a baseline proves the session', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'save.md'), 'base')
    const baseline = statSync(join(root, 'dsh', 'save.md')).mtimeMs
    const { write } = mountApi(root)
    const out = await invokeWrite(write, { path: `${prefix}/dsh/save.md`, content: 'edited', expectedMtimeMs: baseline })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(readFileSync(join(root, 'dsh', 'save.md'), 'utf8')).toBe('edited')
    // The literal destination was never created.
    expect(await pathExists(join(root, prefix))).toBe(false)
  })

  it('a save without a baseline is never redirected (new-file intent stays literal)', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'existing.md'), 'base')
    const { write } = mountApi(root)
    const out = await invokeWrite(write, { path: `${prefix}/dsh/existing.md`, content: 'x' })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    // No baseline, no session: the literal destination gets the bytes.
    expect(readFileSync(join(root, prefix, 'dsh', 'existing.md'), 'utf8')).toBe('x')
    expect(readFileSync(join(root, 'dsh', 'existing.md'), 'utf8')).toBe('base')
  })
})

describe('sidebar_open tool (the tool-row open entry)', () => {
  /** The minimal ToolRunContext the tool needs. */
  function exec(sessionId: string): ToolRunContext {
    return { signal: { throwIfAborted: () => {}, aborted: false }, agent: { session: { id: sessionId } } } as unknown as ToolRunContext
  }

  /** Register the real tool against a fake context. */
  function mountTool(resolveCwd: (sessionId: string) => Promise<string>): ToolDefinition {
    const captured: ToolDefinition[] = []
    const ctx = { tools: { register: (tool: unknown) => { captured.push(tool as ToolDefinition); return () => {} } } } as unknown as Context
    const prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS }
    registerOpenTool(ctx, new AgentOpenRegistry(), resolveCwd, () => prefs)
    return captured[0]!
  }

  it('opens the stripped reading of a prefixed relative target', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, 'dsh'), { recursive: true })
    writeFileSync(join(root, 'dsh', 'index.md'), 'content')
    const tool = mountTool(async () => root)
    const value = await tool.execute({ target: `${prefix}/dsh/index.md` }, exec('s1')) as Record<string, unknown>
    expect(value).toMatchObject({ kind: 'file', target: join(root, 'dsh', 'index.md'), title: 'index.md' })
  })

  it('keeps a real same-named subdirectory winning and the literal error verbatim', async () => {
    const { root, prefix } = workspace()
    mkdirSync(join(root, prefix), { recursive: true })
    writeFileSync(join(root, prefix, 'real.md'), 'inner')
    writeFileSync(join(root, 'real.md'), 'outer')
    const tool = mountTool(async () => root)
    const inner = await tool.execute({ target: `${prefix}/real.md` }, exec('s1')) as Record<string, unknown>
    expect(inner).toMatchObject({ kind: 'file', target: join(root, prefix, 'real.md') })
    await expect(tool.execute({ target: `${prefix}/missing.md` }, exec('s1')))
      .rejects.toThrow(/does not exist/)
  })
})
