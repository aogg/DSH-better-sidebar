# 设置页作用域 tab：项目设置 / 全局设置（打开方式双作用域）

- 日期：2026-10-15
- 状态：已实现
- 来源会话：`session-7efcd2ea`（设置真页面）+ 用户指令「设置里搞个 tab 切换，项目设置和全局设置；现有的设置都是全局设置；『打开方式』（路径映射）同时支持全局配置和项目配置」

## 需求

- 设置页（罗盘 guide 起始页「设置」胶囊 / 开始页设置面板 / + 菜单，三处同一个 `SideCardSection`）顶部加作用域 tab：**项目设置｜全局设置**。
- 现有全部设置保持**全局**，归入「全局设置」tab，行为不变。
- 「项目设置」tab 只放一件事：**打开方式**（SSH 主机 / 自定义编辑器 / 路径映射 / 钉选）——历史上唯一明确按项目提的设置（session-dca2613f：`/code/www → D:/code/www` 是每个工作区自己的事实）。
- 打开方式**同时支持全局配置和项目配置**：两边都可编辑，生效时合并，冲突项目优先。

## 存储

- 全局文档（DSH 设置服务 `dsh-better-sidebar` 命名空间）新增顶层开放字段：

  ```
  projectSettings: { [工作区根绝对路径]: { openWith?: … } }
  ```

  - key = `api.sessionCwd` 报告的会话工作区根（host 权威，会跟随 linked worktree）。
  - schema（config.ts）`z.dict(z.dict(z.any())).default({})`，随 `PrefsSchema.dict` 自动 volatile（偏好编辑走 loader/volatile-update，不重挂插件）。
  - `SidebarPrefs.projectSettings` + `parsePrefs` 容错解析（复用 `pluginSettingsMapOf`）。

## 合并语义（`mergeOpenWithConfigs`）

| 字段 | 规则 |
|---|---|
| `sshHost` | 项目非空则项目，否则全局（空白 =「用全局的答案」，不是「本地」） |
| `customEditors` | 项目行在前，全局行按 id 去重后追加；id 冲突保留项目行 |
| `pinned` | 项目 pin 在前，全局 pin 去重追加（菜单顺序随合并序） |
| `pathMappings` | 项目行在前、全局行在后；映射器取最长 `from`（等长取第一条=项目行），全局其余映射照常生效 |

## 钉选写入落点（`openWithPinScope`）

项目自定义编辑器的 pin、以及**已存在于项目 pin 列表的 id**（内置 target 也一样，否则永远解不开）→ 写 `projectSettings[cwd]`；其余（内置、仅全局的自定义编辑器）→ 写 `pluginSettings['editor']`。两个作用域互不串写。

## UI

- tab 栏：`role=tablist` 分段控件，`localStorage['dsh-sidebar:settings-tab']` 记住停留；SSR 安全（无 localStorage → 全局）。
- 项目 tab：
  - 无活动会话 → `data-dsh-project-empty` 空态提示；
  - 有 → 工作区头（目录名 + 完整根路径）+ 合并语义提示 + `OpenWithSettings` 面板（同一组件，绑定项目 blob，`updatePluginSetting('openWith', …)` 经 `writeProjectBlob` 走同一套乐观更新 + revision 防并发管线写 `projectSettings`）。
- 全局 tab：原版全部内容原样（编辑器卡片齿轮里仍保留全局「打开方式」面板——两边都配）。

## 消费点（EditorHost）

- `openWithConfig` = `mergeOpenWithConfigs(全局解析, 项目解析)`——菜单 targets、SSH 模式、URL 构建（含路径映射）全部吃合并后的配置；无项目 blob 时行为与旧版逐字节一致。
- `toggleOpenWithPin` 按 `openWithPinScope` 落到对应 blob（新 `updateProjectSettings` 队列，与 `updatePluginSettings` 同一条串行链）。

## 测试

- `tests/open-with-merge.spec.ts`：合并八例（空项目=恒等、ssh 覆盖/回落、编辑器按 id 归并、pin 去重并集、路径映射双作用域生效+等长项目胜+更长全局仍胜）、pin 归属四例。
- `tests/side-card-scope-tabs.spec.tsx`：默认全局、切项目解析 cwd + 面板渲染 + localStorage 记忆、SSH 输入只写 `projectSettings[cwd]`、无会话空态、记住 tab。
- 既有 `prefs.spec` 全量对象断言补 `projectSettings: {}`。

## 明确不做（用户裁定）

- 其余候选（explorerExclude、commitModel、内容搜索圈定、基准分支、排序、项目信息卡）全部**不**迁移，保持全局。
