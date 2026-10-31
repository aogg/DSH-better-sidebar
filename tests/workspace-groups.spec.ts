/**
 * 独立工作区组的纯逻辑层（src/client/workspace-groups.ts）+ 组 scope 链接
 * 的解析契约（src/client/workspace-focus.ts）：
 * - `?ws=` 值的三态解析（parseFocusScope：裸 id = 单工作区 / `g:` 前缀 =
 *   组 / 非法 = null 退全量）；
 * - 组解析 → 专注集合（resolveGroupFocus：组内 id ∩ 快照 id）；
 * - 空组 / 组不存在 / 交集为空 → null（调用方退全量 + toast）；
 * - 组数据容错校验与增删改；
 * - 两种复制格式：整组一条 `g:` 链接 / 多行单工作区裸链接。
 */
import { describe, expect, it } from 'vitest'
import {
  GROUP_SCOPE_PREFIX,
  buildGroupFocusLink,
  buildWorkspaceFocusLink,
  parseFocusScope,
} from '../src/client/workspace-focus.ts'
import {
  WORKSPACE_GROUPS_SETTING_KEY,
  addGroup,
  buildEachWorkspaceFocusLinks,
  deleteGroup,
  groupsContaining,
  newGroupId,
  parseWorkspaceGroups,
  renameGroup,
  resolveGroupFocus,
  setGroupWorkspace,
  type WorkspaceGroup,
} from '../src/client/workspace-groups.ts'
import type { FocusWorkspaceItem } from '../src/client/workspace-focus.ts'

describe('parseFocusScope（?ws= 值的三态）', () => {
  it('a bare value is a single-workspace scope (legacy links unchanged)', () => {
    expect(parseFocusScope('w1')).toEqual({ kind: 'workspace', id: 'w1' })
    expect(parseFocusScope('  w1 ')).toEqual({ kind: 'workspace', id: 'w1' })
    expect(parseFocusScope('ws-with:colon')).toEqual({ kind: 'workspace', id: 'ws-with:colon' })
  })

  it('the g: prefix is a group scope whose id is the unique value', () => {
    expect(parseFocusScope('g:grp1')).toEqual({ kind: 'group', id: 'grp1' })
    expect(parseFocusScope(' g:grp1 ')).toEqual({ kind: 'group', id: 'grp1' })
    expect(parseFocusScope(`${GROUP_SCOPE_PREFIX}a.b-c_d`)).toEqual({ kind: 'group', id: 'a.b-c_d' })
  })

  it('answers null for absent, blank, empty-group-id and oversized values (show everything)', () => {
    expect(parseFocusScope(null)).toBeNull()
    expect(parseFocusScope(undefined)).toBeNull()
    expect(parseFocusScope('')).toBeNull()
    expect(parseFocusScope('   ')).toBeNull()
    // `g:` 前缀后没有 id：不是组，也不是工作区，退全量。
    expect(parseFocusScope('g:')).toBeNull()
    expect(parseFocusScope('g:   ')).toBeNull()
    expect(parseFocusScope('w'.repeat(201))).toBeNull()
    expect(parseFocusScope(`g:${'g'.repeat(201)}`)).toBeNull()
  })
})

describe('resolveGroupFocus（组解析 → 专注集合）', () => {
  const groups: WorkspaceGroup[] = [
    { id: 'grp1', name: '组A', workspaceIds: ['w1', 'w2', 'w-gone'] },
    { id: 'grp2', name: '组B', workspaceIds: [] },
  ]
  const items: FocusWorkspaceItem[] = [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s3'] },
    { workspaceId: 'w3', sessionIds: [] },
  ]

  it('resolves a group to its member ids intersected with the snapshot', () => {
    const resolved = resolveGroupFocus(groups, 'grp1', items)
    expect(resolved).not.toBeNull()
    expect(resolved!.group.name).toBe('组A')
    // 组内 3 个 id，快照只有 w1/w2 → 交集 = {w1, w2}（失效的 w-gone 剔除）。
    expect(resolved!.workspaceIds).toEqual(new Set(['w1', 'w2']))
  })

  it('answers null when the group is missing, empty, or its intersection is empty (fall back to everything)', () => {
    expect(resolveGroupFocus(groups, 'nope', items)).toBeNull()
    expect(resolveGroupFocus(groups, 'grp2', items)).toBeNull()
    expect(resolveGroupFocus([{ id: 'grp3', name: '组C', workspaceIds: ['x1', 'x2'] }], 'grp3', items)).toBeNull()
  })
})

describe('parseWorkspaceGroups（坏值兜底）', () => {
  it('accepts a bare array and the persisted { groups: [...] } wrapper', () => {
    const bare: WorkspaceGroup[] = [{ id: 'g1', name: '组', workspaceIds: ['w1'] }]
    expect(parseWorkspaceGroups(bare)).toEqual(bare)
    expect(parseWorkspaceGroups({ groups: bare })).toEqual(bare)
  })

  it('falls back to an empty array for non-array shapes', () => {
    expect(parseWorkspaceGroups(undefined)).toEqual([])
    expect(parseWorkspaceGroups(null)).toEqual([])
    expect(parseWorkspaceGroups('nope')).toEqual([])
    expect(parseWorkspaceGroups(42)).toEqual([])
    expect(parseWorkspaceGroups({})).toEqual([])
    expect(parseWorkspaceGroups({ groups: 'nope' })).toEqual([])
  })

  it('drops broken entries (non-object, blank id, duplicate id) and filters bad members', () => {
    expect(parseWorkspaceGroups([
      'nope',
      null,
      { name: '没有 id' },
      { id: '  ', name: '空白 id' },
      { id: 'g1', name: '组1', workspaceIds: ['w1', '', 42, 'w1', 'w2'] },
      { id: 'g1', name: '重复 id 丢弃', workspaceIds: [] },
      { id: 'g2', workspaceIds: 'nope' },
    ])).toEqual([
      { id: 'g1', name: '组1', workspaceIds: ['w1', 'w2'] },
      { id: 'g2', name: 'g2', workspaceIds: [] },
    ])
  })

  it('defaults a blank name to the id and trims both', () => {
    expect(parseWorkspaceGroups([{ id: ' g3 ', name: '  ', workspaceIds: [] }]))
      .toEqual([{ id: 'g3', name: 'g3', workspaceIds: [] }])
  })
})

describe('组的增删改（纯函数，幂等）', () => {
  const seed = (): WorkspaceGroup[] => [
    { id: 'g1', name: '组A', workspaceIds: ['w1'] },
    { id: 'g2', name: '组B', workspaceIds: [] },
  ]

  it('newGroupId yields short unique ids', () => {
    const first = newGroupId()
    expect(first).toMatch(/^[0-9a-z]{1,9}$/)
    const ids = new Set(Array.from({ length: 200 }, () => newGroupId()))
    expect(ids.size).toBe(200)
  })

  it('addGroup appends an empty named group and returns it', () => {
    const { groups, group } = addGroup(seed(), '  新组  ')
    expect(groups).toHaveLength(3)
    expect(group.name).toBe('新组')
    expect(group.workspaceIds).toEqual([])
    expect(groups[2]).toBe(group)
  })

  it('renameGroup renames by id and no-ops on blank names or unknown ids', () => {
    expect(renameGroup(seed(), 'g2', ' 组二 ')[1]!.name).toBe('组二')
    expect(renameGroup(seed(), 'g2', '   ')).toEqual(seed())
    expect(renameGroup(seed(), 'nope', 'x')).toEqual(seed())
  })

  it('deleteGroup removes by id and no-ops on unknown ids', () => {
    expect(deleteGroup(seed(), 'g1')).toEqual([{ id: 'g2', name: '组B', workspaceIds: [] }])
    expect(deleteGroup(seed(), 'nope')).toEqual(seed())
  })

  it('setGroupWorkspace adds/removes membership idempotently and ignores unknown groups', () => {
    expect(setGroupWorkspace(seed(), 'g2', 'w2', true)[1]!.workspaceIds).toEqual(['w2'])
    // 重复添加 → 原样。
    expect(setGroupWorkspace(seed(), 'g1', 'w1', true)).toEqual(seed())
    expect(setGroupWorkspace(seed(), 'g1', 'w1', false)[0]!.workspaceIds).toEqual([])
    // 移除不存在的成员 → 原样。
    expect(setGroupWorkspace(seed(), 'g1', 'w9', false)).toEqual(seed())
    expect(setGroupWorkspace(seed(), 'nope', 'w1', true)).toEqual(seed())
    // 保序：新成员追加在尾部。
    expect(setGroupWorkspace(seed(), 'g1', 'w0', true)[0]!.workspaceIds).toEqual(['w1', 'w0'])
  })

  it('groupsContaining lists every owning group in order (multi-group membership allowed)', () => {
    const groups: WorkspaceGroup[] = [
      { id: 'g1', name: '组A', workspaceIds: ['w2', 'w1'] },
      { id: 'g2', name: '组B', workspaceIds: [] },
      { id: 'g3', name: '组C', workspaceIds: ['w1'] },
    ]
    expect(groupsContaining(groups, 'w1').map((group) => group.id)).toEqual(['g1', 'g3'])
    expect(groupsContaining(groups, 'w2').map((group) => group.id)).toEqual(['g1'])
    expect(groupsContaining(groups, 'w9')).toEqual([])
  })

  it('exposes the settings descriptor key (pluginSettings subtree, volatile-open)', () => {
    expect(WORKSPACE_GROUPS_SETTING_KEY).toBe('workspaceGroups')
  })
})

describe('复制格式（一条 g: 链接 / 多行裸链接）', () => {
  it('buildGroupFocusLink yields ONE g:-scoped link for the whole group', () => {
    const link = buildGroupFocusLink('http://h:3080/', 'grp9')
    expect(new URL(link).searchParams.get('ws')).toBe('g:grp9')
    // 与单工作区链接同参数名、同拼装规则（其余部分原样保留）。
    expect(link).toBe(buildWorkspaceFocusLink('http://h:3080/', 'g:grp9'))
    expect(buildGroupFocusLink('http://h:3080/app?theme=dark', 'grp1'))
      .toBe('http://h:3080/app?theme=dark&ws=g%3Agrp1')
  })

  it('buildEachWorkspaceFocusLinks yields one bare per-line link per workspace (panel fallback)', () => {
    const text = buildEachWorkspaceFocusLinks('http://h:3080/', ['w1', 'w2'])
    expect(text.split('\n')).toEqual([
      'http://h:3080/?ws=w1',
      'http://h:3080/?ws=w2',
    ])
    expect(buildEachWorkspaceFocusLinks('http://h:3080/', [])).toBe('')
  })
})
