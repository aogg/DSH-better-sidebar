/**
 * 单工作区专注模式的纯逻辑层（src/client/workspace-focus.ts）：
 * URL 参数读取/拼装/清除、成员集合计算、树行判定。
 */
import { describe, expect, it } from 'vitest'
import {
  FOCUS_URL_PARAM,
  buildWorkspaceFocusLink,
  dropFocusParam,
  focusMembership,
  focusRowVerdict,
  readFocusWorkspaceId,
  type FocusWorkspaceItem,
} from '../src/client/workspace-focus.ts'

describe('readFocusWorkspaceId', () => {
  it('reads the ws param from a query string (with or without the leading ?)', () => {
    expect(readFocusWorkspaceId('?ws=abc-123')).toBe('abc-123')
    expect(readFocusWorkspaceId('ws=abc-123')).toBe('abc-123')
    expect(readFocusWorkspaceId('?other=1&ws=abc-123&x=2')).toBe('abc-123')
  })

  it('decodes percent-encoded values and trims whitespace', () => {
    expect(readFocusWorkspaceId('?ws=%20ws%201%20')).toBe('ws 1')
  })

  it('answers null when the param is absent, blank, or oversized', () => {
    expect(readFocusWorkspaceId('')).toBeNull()
    expect(readFocusWorkspaceId('?other=1')).toBeNull()
    expect(readFocusWorkspaceId('?ws=')).toBeNull()
    expect(readFocusWorkspaceId('?ws=%20%20')).toBeNull()
    expect(readFocusWorkspaceId(`?ws=${'w'.repeat(201)}`)).toBeNull()
  })
})

describe('buildWorkspaceFocusLink / dropFocusParam', () => {
  it('keeps origin, path and other params, and sets/replaces ws', () => {
    expect(buildWorkspaceFocusLink('http://h:3080/', 'w1')).toBe(`http://h:3080/?${FOCUS_URL_PARAM}=w1`)
    expect(buildWorkspaceFocusLink('http://h:3080/app?theme=dark', 'w1'))
      .toBe('http://h:3080/app?theme=dark&ws=w1')
    // 已在专注态再复制另一个工作区：替换而不是追加。
    expect(buildWorkspaceFocusLink('http://h:3080/?ws=old#frag', 'new'))
      .toBe('http://h:3080/?ws=new#frag')
  })

  it('drops ws and keeps everything else (exit focus)', () => {
    expect(dropFocusParam('http://h:3080/?ws=w1')).toBe('http://h:3080/')
    expect(dropFocusParam('http://h:3080/app?theme=dark&ws=w1')).toBe('http://h:3080/app?theme=dark')
    expect(dropFocusParam('http://h:3080/?ws=w1#frag')).toBe('http://h:3080/#frag')
  })
})

describe('focusMembership', () => {
  const items: FocusWorkspaceItem[] = [
    { workspaceId: 'w1', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
  ]

  it('collects the focus workspace sessions plus the extra keep set (current session)', () => {
    const membership = focusMembership(items, 'w1', ['s9'])
    expect(membership).not.toBeNull()
    expect(membership!.workspaceId).toBe('w1')
    expect([...membership!.memberSessionIds].sort()).toEqual(['s1', 's2', 's9'])
  })

  it('answers null for an unknown focus id (data not ready / stale link)', () => {
    expect(focusMembership(items, 'missing')).toBeNull()
  })
})

describe('focusRowVerdict', () => {
  const membership = focusMembership([{ workspaceId: 'w1', sessionIds: ['s1'] }], 'w1')

  it('is outside for every row when focus is inactive (null membership)', () => {
    for (const key of ['workspace:w1', 'workspace:', 'session:s1', 'session:x', 'overflow:w1', 'empty', 'file:a.ts']) {
      expect(focusRowVerdict(key, null)).toBe('outside')
    }
  })

  it('keeps only the focus workspace group and hides the others (incl. ungrouped)', () => {
    expect(focusRowVerdict('workspace:w1', membership)).toBe('visible')
    expect(focusRowVerdict('workspace:w2', membership)).toBe('hidden')
    // 未分组桶的 key 是空串：永远不等于真实工作区 id → 隐藏。
    expect(focusRowVerdict('workspace:', membership)).toBe('hidden')
  })

  it('keeps only member session rows and the focus group overflow button', () => {
    expect(focusRowVerdict('session:s1', membership)).toBe('visible')
    expect(focusRowVerdict('session:s2', membership)).toBe('hidden')
    expect(focusRowVerdict('overflow:w1', membership)).toBe('visible')
    expect(focusRowVerdict('overflow:w2', membership)).toBe('hidden')
  })

  it('never touches rows outside the workspace browser contract', () => {
    expect(focusRowVerdict('empty', membership)).toBe('outside')
    expect(focusRowVerdict('file:src/a.ts', membership)).toBe('outside')
    expect(focusRowVerdict('dir:src', membership)).toBe('outside')
  })
})
