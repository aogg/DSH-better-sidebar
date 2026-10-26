/**
 * 「命令」服务端脚本扫描（src/commands-scan.ts，fs 注入面驱动，不用真实目录）。
 * 钉住：非法 pattern 行内 error、绝对/相对扫描根（相对落 cwd）、静态前缀根
 * 不存在 → error、`**` 深度匹配与零段命中、排除目录不下钻、字面量 pattern 按
 * 单文件处理、深度/访问量/结果数三重上限置 truncated、整批互不拖累、rel 带
 * pattern 前缀头。
 */
import { describe, expect, it } from 'vitest'
import {
  SCRIPT_SCAN_MAX_DEPTH,
  SCRIPT_SCAN_MAX_MATCHES,
  SCRIPT_SCAN_MAX_VISITED,
  scanPatternIsAbsolute,
  scanScriptRule,
  scanScriptsByRules,
  type ScanFsFace,
} from '../src/commands-scan.ts'

/** 极简内存 fs：一条路径表（目录以 / 结尾区分），全部 mtime=1、size=2。 */
function fakeFs(paths: readonly string[]): ScanFsFace {
  const dirs = new Set(paths.filter(path => path.endsWith('/')))
  const files = new Set(paths.filter(path => !path.endsWith('/')))
  return {
    async stat(path) {
      if (dirs.has(`${path}/`)) return { isDirectory: () => true, isFile: () => false, mtimeMs: 1, size: 0 }
      if (files.has(path)) return { isDirectory: () => false, isFile: () => true, mtimeMs: 1, size: 2 }
      return undefined
    },
    async readdir(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      const children = new Set<string>()
      for (const path of [...dirs, ...files]) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const head = rest.split('/')[0]
        if (head === undefined || head === '') continue
        children.add(head)
      }
      return [...children].map(name => ({
        name,
        isDirectory: () => dirs.has(`${prefix}${name}/`),
        isSymbolicLink: () => false,
      }))
    },
  }
}

describe('scanScriptRule（单规则）', () => {
  it('相对 pattern 以 cwd 为基：scripts/**/*.sh 深度命中（含零段）', async () => {
    const fs = fakeFs([
      '/ws/',
      '/ws/scripts/',
      '/ws/scripts/deploy.sh',
      '/ws/scripts/sub/',
      '/ws/scripts/sub/nested.sh',
      '/ws/scripts/sub/deep/',
      '/ws/scripts/sub/deep/x.sh',
      '/ws/src/index.ts',
    ])
    const scan = await scanScriptRule('/ws', { id: 'r1', pattern: 'scripts/**/*.sh' }, fs)
    expect(scan.error).toBeUndefined()
    expect(scan.truncated).toBeUndefined()
    // rel 相对扫描根（模块契约：展示 + 按父目录分组都用它）。
    expect(scan.matches.map(match => match.rel).sort()).toEqual([
      'deploy.sh',
      'sub/deep/x.sh',
      'sub/nested.sh',
    ])
    const nested = scan.matches.find(match => match.rel === 'sub/nested.sh')
    expect(nested?.abs).toBe('/ws/scripts/sub/nested.sh')
    expect(nested?.dir).toBe('/ws/scripts/sub')
    expect(nested?.name).toBe('nested.sh')
    expect(nested?.mtime).toBe(1)
    expect(nested?.size).toBe(2)
  })

  it('绝对 pattern：取静态前缀作扫描根', async () => {
    const fs = fakeFs([
      '/opt/tools/',
      '/opt/tools/a.sh',
      '/opt/tools/sub/',
      '/opt/tools/sub/b.sh',
    ])
    const scan = await scanScriptRule('/ws', { id: 'r2', pattern: '/opt/tools/**/*.sh' }, fs)
    expect(scan.matches.map(match => match.rel).sort()).toEqual(['a.sh', 'sub/b.sh'])
    expect(scan.matches.map(match => match.abs).sort()).toEqual(['/opt/tools/a.sh', '/opt/tools/sub/b.sh'])
  })

  it('扫描根不存在 / 不是目录 / pattern 非法 → 行内 error，不抛', async () => {
    const fs = fakeFs([])
    expect((await scanScriptRule('/ws', { id: 'r', pattern: 'nope/**/*.sh' }, fs)).error).toContain('not found')
    expect((await scanScriptRule('/ws', { id: 'r', pattern: '' }, fs)).error).toContain('invalid pattern')
    // 根是文件：同样 error。
    const fileFs = fakeFs(['/ws/a.sh'])
    expect((await scanScriptRule('/ws', { id: 'r', pattern: 'a.sh/**/*.sh' }, fileFs)).error).toContain('not a directory')
  })

  it('排除目录（node_modules/.git 等）不匹配也不下钻', async () => {
    const fs = fakeFs([
      '/ws/',
      '/ws/deploy.sh',
      '/ws/node_modules/',
      '/ws/node_modules/pkg/',
      '/ws/node_modules/pkg/run.sh',
      '/ws/.git/hooks/',
      '/ws/.git/hooks/pre-commit.sh',
    ])
    const scan = await scanScriptRule('/ws', { id: 'r', pattern: '**/*.sh' }, fs)
    expect(scan.matches.map(match => match.rel)).toEqual(['deploy.sh'])
  })

  it('字面量 pattern（无通配符段）按单文件处理；文件缺席 → error', async () => {
    const fs = fakeFs(['/ws/', '/ws/deploy.sh'])
    const hit = await scanScriptRule('/ws', { id: 'r', pattern: 'deploy.sh' }, fs)
    expect(hit.matches).toHaveLength(1)
    expect(hit.matches[0]?.abs).toBe('/ws/deploy.sh')
    expect(hit.matches[0]?.rel).toBe('deploy.sh')
    const miss = await scanScriptRule('/ws', { id: 'r', pattern: 'gone.sh' }, fs)
    expect(miss.matches).toEqual([])
    expect(miss.error).toContain('file not found')
  })

  it('三重上限：深度 → truncated；结果数 → truncated；访问量 → truncated', async () => {
    // 深度：/ws/d/d/... 链（SCRIPT_SCAN_MAX_DEPTH + 2 层），叶文件在链底 ——
    // walk 深度超过上限即置 truncated，即使沿路有命中也停。
    const chain: string[] = ['/ws/']
    let prefix = '/ws'
    for (let index = 0; index < SCRIPT_SCAN_MAX_DEPTH + 2; index += 1) {
      prefix = `${prefix}/d`
      chain.push(`${prefix}/`)
    }
    const depthFs = fakeFs([...chain, `${prefix}/leaf.sh`])
    const depthScan = await scanScriptRule('/ws', { id: 'r', pattern: '**/*.sh' }, depthFs)
    expect(depthScan.truncated).toBe(true)
    expect(depthScan.matches).toEqual([])

    // 结果数：SCRIPT_SCAN_MAX_MATCHES + 1 个命中 → 收满即停并置 truncated。
    const many = ['/ws/']
    for (let index = 0; index < SCRIPT_SCAN_MAX_MATCHES + 1; index += 1) many.push(`/ws/s${index}.sh`)
    const manyScan = await scanScriptRule('/ws', { id: 'r', pattern: '*.sh' }, fakeFs(many))
    expect(manyScan.matches).toHaveLength(SCRIPT_SCAN_MAX_MATCHES)
    expect(manyScan.truncated).toBe(true)

    // 访问量：单目录塞 SCRIPT_SCAN_MAX_VISITED + 1 个不命中条目 → 访问计数
    // 触顶置 truncated（一个 readdir 就把预算烧完）。
    const flood = ['/ws/']
    for (let index = 0; index < SCRIPT_SCAN_MAX_VISITED + 1; index += 1) flood.push(`/ws/f${index}.txt`)
    const floodScan = await scanScriptRule('/ws', { id: 'r', pattern: '**/*.sh' }, fakeFs(flood))
    expect(floodScan.truncated).toBe(true)
    expect(floodScan.matches).toEqual([])
  })

  it('readdir 抛异常 → error 行内带回（已收集的 matches 保留）', async () => {
    const fs: ScanFsFace = {
      stat: async (path) => path === '/ws' ? { isDirectory: () => true, isFile: () => false, mtimeMs: 1, size: 0 } : undefined,
      readdir: async () => {
        throw new Error('EACCES: permission denied')
      },
    }
    const scan = await scanScriptRule('/ws', { id: 'r', pattern: '**/*.sh' }, fs)
    expect(scan.error).toContain('EACCES')
    expect(scan.matches).toEqual([])
  })

  it('scanPatternIsAbsolute：POSIX 根 / Windows 盘符', () => {
    expect(scanPatternIsAbsolute('/a/b/**/*.sh')).toBe(true)
    expect(scanPatternIsAbsolute('C:\\tools\\*.sh')).toBe(true)
    expect(scanPatternIsAbsolute('scripts/*.sh')).toBe(false)
  })
})

describe('scanScriptsByRules（整批）', () => {
  it('每条规则独立执行，坏规则不影响其余；顺序与入参一致', async () => {
    const fs = fakeFs([
      '/ws/',
      '/ws/scripts/',
      '/ws/scripts/a.sh',
    ])
    const scans = await scanScriptsByRules('/ws', [
      { id: 'good', pattern: 'scripts/**/*.sh' },
      { id: 'bad', pattern: 'gone/**/*.sh' },
      { id: 'empty', pattern: '' },
    ], fs)
    expect(scans.map(scan => scan.id)).toEqual(['good', 'bad', 'empty'])
    expect(scans[0]?.matches).toHaveLength(1)
    expect(scans[1]?.error).toContain('not found')
    expect(scans[2]?.error).toContain('invalid pattern')
  })
})
