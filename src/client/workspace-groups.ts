/**
 * 独立工作区组（standalone workspace groups）的纯逻辑层：组的存储形状与
 * 容错解析、增删改、与核心 workspaces.list 快照的交集解析，以及两种复制
 * 格式（整组一条 `?ws=g:<groupId>` 链接 / 每行一条单工作区裸链接）。
 *
 * 存储位置在设置通道的 `pluginSettings['workspaceGroups']`（`pluginSettings`
 * 子树对新键免校验——顶层未声明字段会被 dsh-settings 拒，见
 * docs/plans/2026-10-15-project-settings-tabs-design.md），本模块不碰
 * api/DOM，只做值与值的变换，vitest 直测（tests/workspace-groups.spec.ts）。
 * 组 id 即「唯一值」：专注链接 `?ws=g:<groupId>` 打开时按它反查整组。
 */
import { buildWorkspaceFocusLink, type FocusWorkspaceItem } from './workspace-focus.ts'

/** 设置通道里承载组数组的 descriptor 键（pluginSettings 子树，volatile 免校验）。 */
export const WORKSPACE_GROUPS_SETTING_KEY = 'workspaceGroups'

/** 一个独立工作区组：组内工作区 id 与核心行键 / `?ws=` 链接同源。 */
export interface WorkspaceGroup {
  /** 短随机唯一 id（链接 `g:<id>` 的「唯一值」）。 */
  id: string
  /** 组名（专注横幅 / 子菜单 / 管理面板展示用）。 */
  name: string
  /** 组内工作区 id 列表（去重、保序；允许多组同属）。 */
  workspaceIds: string[]
}

/**
 * 容错解析持久化的组数据（接受 `{ groups: [...] }` 包裹或裸数组）。任何一段
 * 坏值（非对象条目、空 id、重复 id、非字符串成员）按段丢弃，整体坏值兜底
 * 空数组——设置通道是开放 map，绝不让坏数据炸掉菜单。
 */
export function parseWorkspaceGroups(value: unknown): WorkspaceGroup[] {
  const raw = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? (value as { groups?: unknown }).groups
      : undefined
  if (!Array.isArray(raw)) return []
  const groups: WorkspaceGroup[] = []
  const seenIds = new Set<string>()
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id === '' || seenIds.has(id)) continue
    seenIds.add(id)
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : id
    const workspaceIds: string[] = []
    if (Array.isArray(record.workspaceIds)) {
      for (const workspaceId of record.workspaceIds) {
        if (typeof workspaceId === 'string' && workspaceId !== '' && !workspaceIds.includes(workspaceId)) {
          workspaceIds.push(workspaceId)
        }
      }
    }
    groups.push({ id, name, workspaceIds })
  }
  return groups
}

/** 造一个短随机组 id（crypto 优先，缺 API 的环境退 Math.random）。 */
export function newGroupId(): string {
  const bytes = new Uint8Array(6)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 9)
}

/** 追加一个新组（返回新数组 + 新组；调用方保证 name 非空，这里只去空白）。
 *  组 id 是链接「唯一值」，与现有组撞号会在下次解析时被当重复丢掉（等于
 *  悄悄吞组），故撞号重造；重试有上限——随机源坏死的病态环境退化为长度
 *  增长的确定性后缀，有限步必唯一，绝不为造 id 死循环。 */
export function addGroup(groups: readonly WorkspaceGroup[], name: string): { groups: WorkspaceGroup[]; group: WorkspaceGroup } {
  const taken = new Set(groups.map((group) => group.id))
  let id = newGroupId()
  for (let attempt = 0; attempt < 32 && taken.has(id); attempt += 1) id = newGroupId()
  while (taken.has(id)) id = `${id}-${taken.size}`
  const group: WorkspaceGroup = { id, name: name.trim(), workspaceIds: [] }
  return { groups: [...groups, group], group }
}

/** 重命名一个组；id 不存在时原样返回（不改引用也不报错）。 */
export function renameGroup(groups: readonly WorkspaceGroup[], groupId: string, name: string): WorkspaceGroup[] {
  const trimmed = name.trim()
  if (trimmed === '') return [...groups]
  return groups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group))
}

/** 删除一个组；id 不存在时原样返回。 */
export function deleteGroup(groups: readonly WorkspaceGroup[], groupId: string): WorkspaceGroup[] {
  return groups.filter((group) => group.id !== groupId)
}

/**
 * 把一个工作区加进 / 移出一个组（member=false 即移出）；组不存在或重复添加
 * / 移除不存在的成员都幂等原样返回。
 */
export function setGroupWorkspace(
  groups: readonly WorkspaceGroup[],
  groupId: string,
  workspaceId: string,
  member: boolean,
): WorkspaceGroup[] {
  return groups.map((group) => {
    if (group.id !== groupId) return group
    const has = group.workspaceIds.includes(workspaceId)
    if (member === has) return group
    return {
      ...group,
      workspaceIds: member ? [...group.workspaceIds, workspaceId] : group.workspaceIds.filter((id) => id !== workspaceId),
    }
  })
}

/** 当前工作区所属的组（保序；一个工作区可同时属于多个组）。 */
export function groupsContaining(groups: readonly WorkspaceGroup[], workspaceId: string): WorkspaceGroup[] {
  return groups.filter((group) => group.workspaceIds.includes(workspaceId))
}

/**
 * 组解析：按组 id 找组，并把组内 id 与快照求交集。组不存在或交集为空
 * → null（调用方退全量 + toast，对齐「过期链接退全量」契约）。
 */
export interface ResolvedGroupFocus {
  /** 命中的组（横幅取组名）。 */
  group: WorkspaceGroup
  /** 组内 id ∩ 快照 id：专注视图实际显示的工作区集合。 */
  workspaceIds: ReadonlySet<string>
}

export function resolveGroupFocus(
  groups: readonly WorkspaceGroup[],
  groupId: string,
  items: readonly FocusWorkspaceItem[],
): ResolvedGroupFocus | null {
  const group = groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) return null
  const known = new Set(items.map((item) => item.workspaceId))
  const workspaceIds = new Set(group.workspaceIds.filter((id) => known.has(id)))
  if (workspaceIds.size === 0) return null
  return { group, workspaceIds }
}

/** 「复制全部单工作区链接」（管理面板兜底）：每行一条裸 `?ws=<id>` 链接。 */
export function buildEachWorkspaceFocusLinks(href: string, workspaceIds: readonly string[]): string {
  return workspaceIds.map((workspaceId) => buildWorkspaceFocusLink(href, workspaceId)).join('\n')
}
