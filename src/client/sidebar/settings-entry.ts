/**
 * 「设置」入口的打开机制：打开 DSH 宿主设置壳（settings shell）。
 *
 * 公开 API 结论（DSH 0.2.0-rc.2 已安装 bundle 只读核实，均为当前基线真值）：
 * - `ctx.layout.selectPanel` / `beginNavigation` 只作用于根级 `main` keyed 槽
 *   注册的全局面板（conversation / plugins / schedule bundle 面板）；设置壳是
 *   `sidebar.settings` 槽里的对话框而非 main 面板，对未注册 id 按契约 throw
 *   （dsh-client-ui-layout lib/client.js `layout.selectPanel: … is not registered`）。
 * - `ctx.shortcuts` 公开面（dsh-client-shortcuts lib/types/client/index.d.ts 的
 *   `Shortcuts` 接口）只有 catalog / register / edit / describeBinding，没有
 *   按 id 触发的 invoke；`settings.open` 命令的 resolve 只能经内部 registry
 *   到达（`invoke` 仅接 desktop 原生菜单输入）。
 * - 设置壳的 open / openSection 动作是 `sidebar.settings` 槽注册闭包里的私有
 *   store（dsh-client-ui-settings-general lib/client.js 的
 *   `createSettingsShellStore()` 调用点），从未 provide 成 ctx 服务。
 * ⇒ 宿主没有「打开设置 / 直达分区」的公开 API，按任务约定走结构化探测；
 *   每一步失败都静默降级为 no-op，绝不向点击处理外抛错（本模块不裸吞运行
 *   时异常：各探测函数按构造不抛，唯一保留的 try 只圈宿主服务发现）。
 *
 * 探测链（按优先级，全部有界、可失败）：
 * 1. 设置壳已开：面板带稳定 data-* 锚 `data-shortcut-modal="settings"`（宿主
 *    SettingsPanel 的输出），在其 nav 里找可见文本等于本插件分区标题
 *    （`t('settingsNav')`，「Side card」/「侧边卡片」，与 settings-nav-icon.ts
 *    同一匹配规则）的行并 click —— 直达本插件分区。
 * 2. 未开：从 `ctx.shortcuts.catalog`（公开只读面，反映用户自定义后的生效
 *    binding）读 `settings.open` 行的规范化 binding（仅单键；二键 chord 无法
 *    用单个事件合成），在 document.body 派发合成 keydown —— 宿主 web 键盘
 *    适配器在 window 气泡相监听、不检查 isTrusted（dsh-client-shortcuts
 *    lib/client.js installKeyboard），经 registry.dispatch 命中 settings.open
 *    → 设置壳 `actions.open()`。
 * 3. 打开后的直达是 best effort：0ms / 120ms 两次尝试点击分区行（React 面板
 *    异步提交），找不到就停在默认分区 —— 设置页已打开，需求已满足。
 *
 * 刻意不走「账户菜单两步点」：web 壳的设置触发位被 ui-settings-account 的
 * AccountMenu 占据（settings.launcher 是 single 槽，settings-general 的齿轮
 * fallback 不渲染），菜单项 `button[role="menuitem"]` 没有稳定 data-id
 * （ui-primitives Menu 只以 React key 记 id），两步之间任一步失败都会留下
 * 一个肉眼可见的悬空菜单 —— 比静默 no-op 更糟。
 */
import type { Context } from '../../context-types.ts'
import { t } from '../locales.ts'

/** 宿主设置壳面板的稳定 data-* 锚（SettingsPanel 的 `data-shortcut-modal`）。 */
const SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'

/** 打开后的直达尝试节奏：先立即（React 离散事件同步提交），再补一次异步。 */
const DIRECT_ATTEMPT_DELAYS_MS: readonly number[] = [0, 120]

/** 宿主快捷键目录的结构化探测面（只取 `settings.open` 的生效 binding）。 */
interface ShortcutCatalogBindingFace {
  catalog?: {
    getSnapshot?(): readonly { id?: unknown; binding?: unknown }[]
  }
}

/** 规范化 binding 的形状（dsh-client-shortcuts protocol：主修饰键已按平台展开）。 */
interface SettingsBinding {
  code: string
  modifiers: ('control' | 'alt' | 'shift' | 'meta')[]
}

const KNOWN_MODIFIERS: readonly string[] = ['control', 'alt', 'shift', 'meta']

/**
 * 从宿主快捷键目录读 `settings.open` 的生效 binding（仅单键）。服务缺席 /
 * 目录形状不符（含二键 chord、未知修饰键、无 binding）一律 undefined，
 * 由调用方静默降级。
 */
export function settingsOpenBinding(ctx: Context): SettingsBinding | undefined {
  let entries: readonly { id?: unknown; binding?: unknown }[] | undefined
  try {
    const catalog = (ctx.get('shortcuts') as ShortcutCatalogBindingFace | undefined)?.catalog
    entries = typeof catalog?.getSnapshot === 'function' ? catalog.getSnapshot() : undefined
  } catch {
    // 宿主服务发现失败（无 shortcuts 服务 / 形状漂移）：探测面不存在，降级。
    // 这是任务要求的静默降级点，与 start-links.tsx 的 terminalShortcutKeys 同款。
    return undefined
  }
  const row = entries?.find(candidate => candidate?.id === 'settings.open')
  const binding = row?.binding
  if (typeof binding !== 'object' || binding === null) return undefined
  const record = binding as Record<string, unknown>
  const { code, modifiers, secondCode } = record
  if (typeof code !== 'string' || code === '' || (secondCode !== undefined && secondCode !== null)) return undefined
  if (!Array.isArray(modifiers) || modifiers.some(modifier => !KNOWN_MODIFIERS.includes(modifier as string))) {
    return undefined
  }
  // 归一到宿主 normalizeBinding 的 canonical 修饰键序（control/alt/shift/meta）：
  // 合成事件的修饰键布尔本身无序，但返回值保持宿主目录同形，便于比对与测试。
  return {
    code,
    modifiers: KNOWN_MODIFIERS.filter(canonical => modifiers.includes(canonical)) as SettingsBinding['modifiers'],
  }
}

/**
 * 在已开的设置壳里点本插件分区行（可见文本 === `t('settingsNav')`）。
 * 找到并派发 click 返回 true；壳未开 / 行不存在 / 标题为空返回 false。
 * 按构造不抛（querySelector(All) 不抛、textContent 判空、click 不检查 isTrusted）。
 */
export function clickSideCardNavRow(): boolean {
  const label = t('settingsNav').trim()
  if (label === '' || document.querySelector(SETTINGS_PANEL_SELECTOR) === null) return false
  const rows = document.querySelectorAll<HTMLButtonElement>(`${SETTINGS_PANEL_SELECTOR} nav button`)
  for (const row of rows) {
    if (row.textContent?.trim() === label) {
      row.click()
      return true
    }
  }
  return false
}

/**
 * 把 `settings.open` 的生效 binding 派发成合成 keydown（在 body 上派发、
 * bubbles 到 window —— 宿主适配器的监听相）。binding 缺席、环境无
 * KeyboardEvent 构造器或无 body 时不派发并返回 false；派发本身不检查
 * 返回值（dispatchEvent 的 true 只表示「未被 preventDefault」）。
 */
export function dispatchSettingsShortcut(ctx: Context): boolean {
  const binding = settingsOpenBinding(ctx)
  if (binding === undefined || typeof KeyboardEvent !== 'function' || document.body === null) return false
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: binding.code,
    ctrlKey: binding.modifiers.includes('control'),
    altKey: binding.modifiers.includes('alt'),
    shiftKey: binding.modifiers.includes('shift'),
    metaKey: binding.modifiers.includes('meta'),
  }))
  return true
}

/**
 * 执行「设置」入口：优先直达已开设置壳的本插件分区，否则打开设置壳并在
 * 面板渲染后 best effort 直达。全链失败静默 no-op（hero 相位下宿主壳形状
 * 可能整体缺席，点击不应报错）。
 */
export function openSettingsEntry(ctx: Context): void {
  // 1. 壳已开：直达本插件分区（无公开直达 API 时的结构化等价物）。
  if (clickSideCardNavRow()) return
  // 2. 打开设置壳（公开目录 binding 的合成快捷键）；探测失败到此为止。
  if (!dispatchSettingsShortcut(ctx)) return
  // 3. best effort 直达：有限次尝试点分区行，命中即停；失败=停在默认分区。
  let done = false
  const attempt = (): void => {
    if (done) return
    done = clickSideCardNavRow()
  }
  for (const delay of DIRECT_ATTEMPT_DELAYS_MS) window.setTimeout(attempt, delay)
}
