/**
 * 「命令」脚本规则的深度 glob 匹配器（src/glob-match.ts，服务端与客户端共用
 * 同一份语义）。钉住：`**` 跨任意段（含零段）、`*`/`?` 段内不跨段、`[abc]`
 * 字符类、绝对/相对两种写法、Windows 反斜杠归一、静态前缀提取（服务端扫描
 * 根）、非法形态永不命中而不是抛错。
 */
import { describe, expect, it } from 'vitest'
import { globSegmentHasWildcard, globStaticPrefix, globToMatcher, matchGlob } from '../src/glob-match.ts'

describe('matchGlob（深度 glob 语义）', () => {
  it('`**` 跨任意段，含零段：/a/b/**/*.sh 命中 /a/b/x.sh 与 /a/b/c/d/x.sh', () => {
    expect(matchGlob('/a/b/**/*.sh', '/a/b/x.sh')).toBe(true)
    expect(matchGlob('/a/b/**/*.sh', '/a/b/c/d/x.sh')).toBe(true)
    expect(matchGlob('/a/b/**/*.sh', '/a/b/c/d/e/f/deep.sh')).toBe(true)
    // 不命中：前缀不同 / 扩展名不同。
    expect(matchGlob('/a/b/**/*.sh', '/a/x/c.sh')).toBe(false)
    expect(matchGlob('/a/b/**/*.sh', '/a/b/c/d/x.txt')).toBe(false)
    expect(matchGlob('/a/b/**/*.sh', '/a/bx.sh')).toBe(false)
  })

  it('相对 pattern：scripts/**/*.sh 命中 scripts/x.sh 与 scripts/a/b/x.sh', () => {
    expect(matchGlob('scripts/**/*.sh', 'scripts/x.sh')).toBe(true)
    expect(matchGlob('scripts/**/*.sh', 'scripts/a/b/x.sh')).toBe(true)
    expect(matchGlob('scripts/**/*.sh', 'src/scripts/x.sh')).toBe(false)
    expect(matchGlob('scripts/**/*.sh', 'scripts/x.txt')).toBe(false)
  })

  it('`*` 只在段内，不跨段', () => {
    expect(matchGlob('scripts/*.sh', 'scripts/x.sh')).toBe(true)
    expect(matchGlob('scripts/*.sh', 'scripts/a/x.sh')).toBe(false)
    expect(matchGlob('*.sh', 'x.sh')).toBe(true)
    expect(matchGlob('*.sh', 'a/x.sh')).toBe(false)
    // `*a*` 的段内任意位置通配。
    expect(matchGlob('*run*.sh', 'rerun.sh')).toBe(true)
    expect(matchGlob('*run*.sh', 'run/a.sh')).toBe(false)
  })

  it('`?` 段内单字符', () => {
    expect(matchGlob('scripts/?.sh', 'scripts/a.sh')).toBe(true)
    expect(matchGlob('scripts/?.sh', 'scripts/ab.sh')).toBe(false)
    expect(matchGlob('scripts/?.sh', 'scripts//.sh')).toBe(false)
  })

  it('`[abc]` 字符类（含否定）；未闭合的 `[` 按字面量', () => {
    expect(matchGlob('scripts/[ab].sh', 'scripts/a.sh')).toBe(true)
    expect(matchGlob('scripts/[ab].sh', 'scripts/c.sh')).toBe(false)
    expect(matchGlob('scripts/[!a].sh', 'scripts/b.sh')).toBe(true)
    expect(matchGlob('scripts/[!a].sh', 'scripts/a.sh')).toBe(false)
    expect(matchGlob('scripts/[ab.sh', 'scripts/[ab.sh')).toBe(true)
    expect(matchGlob('scripts/[ab.sh', 'scripts/x')).toBe(false)
  })

  it('Windows 反斜杠归一成 / 再匹配；尾随 / 去掉', () => {
    expect(matchGlob('scripts\\**\\*.sh', 'scripts/a/b/x.sh')).toBe(true)
    expect(matchGlob('scripts/**/*.sh', 'scripts\\a\\x.sh')).toBe(true)
    expect(matchGlob('a/**', 'a')).toBe(true)
    expect(matchGlob('a/**', 'a/')).toBe(true)
  })

  it('尾部 `/**`：目录自身与其下所有内容都命中', () => {
    expect(matchGlob('a/**', 'a')).toBe(true)
    expect(matchGlob('a/**', 'a/b')).toBe(true)
    expect(matchGlob('a/**', 'a/b/c')).toBe(true)
    expect(matchGlob('a/**', 'ab')).toBe(false)
  })

  it('首部 `**/`：任意深度（含根）', () => {
    expect(matchGlob('**/*.sh', 'x.sh')).toBe(true)
    expect(matchGlob('**/*.sh', 'a/b/x.sh')).toBe(true)
    expect(matchGlob('**/*.sh', 'a.txt')).toBe(false)
  })

  it('globToMatcher 非法形态返回 undefined（调用方按永不命中处理，不抛错）', () => {
    expect(globToMatcher('')).toBeUndefined()
    expect(globToMatcher('**')).toBeUndefined()
    expect(globToMatcher('/**')).toBeUndefined()
    expect(globToMatcher('a/**')).toBeDefined()
    expect(globToMatcher('a//b')).toBeUndefined()
  })

  it('matcher 可复用（同一 pattern 多次调用结果一致）', () => {
    const matcher = globToMatcher('scripts/**/*.sh')
    expect(matcher).toBeDefined()
    for (const path of ['scripts/x.sh', 'scripts/a/b/x.sh']) expect(matcher!(path)).toBe(true)
    expect(matcher!('other/x.sh')).toBe(false)
  })
})

describe('globSegmentHasWildcard / globStaticPrefix（服务端扫描根）', () => {
  it('段内通配符探测', () => {
    expect(globSegmentHasWildcard('*.sh')).toBe(true)
    expect(globSegmentHasWildcard('a?c')).toBe(true)
    expect(globSegmentHasWildcard('[ab]')).toBe(true)
    expect(globSegmentHasWildcard('scripts')).toBe(false)
  })

  it('静态前缀 = 第一个含通配符的段之前的部分', () => {
    expect(globStaticPrefix('/a/b/**/*.sh')).toBe('/a/b')
    expect(globStaticPrefix('scripts/**/*.sh')).toBe('scripts')
    expect(globStaticPrefix('**/*.sh')).toBe('')
    expect(globStaticPrefix('a/b/*.sh')).toBe('a/b')
  })

  it('无通配符段 → undefined（按字面量文件处理，不做目录扫描）', () => {
    expect(globStaticPrefix('scripts/deploy.sh')).toBeUndefined()
    expect(globStaticPrefix('')).toBeUndefined()
  })
})
