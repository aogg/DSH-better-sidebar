# 独立工作区一级菜单 + 独立工作区组（已实现，v0.28.35）

- 日期：2026-10-29
- 状态：**已实现（v0.28.35）**——需求 1/2/4 按本稿落地；需求 3 的「批量打开/复制全组链接」按新契约重设计（见文末「需求3 契约落地记录」）
- 来源：用户指令三条
  1. 「复制独立工作区链接」所在的更多菜单不能是新菜单，要加在 dsh 原有的工作区 ⋯ 菜单上，参照「复制工作区目录地址」那一项的做法。
  2. 新增一级菜单「独立工作区」，里面放 复制链接 / 新窗口打开；以后凡属独立工作区的功能都收进这个一级菜单。
  3. 新增「独立工作区组」：多个工作区放进一个组，整组新窗口打开 + 整组复制链接。

## 现状（源码已核对）

- 功能在 dsh-better-sidebar 0.28.32（b96204f，已部署热更）：
  - `src/client/workspace-link-menu.ts`：DOM 注入「复制独立工作区链接」「新窗口打开独立工作区」两项到工作区行 ⋯ 的官方 portal 菜单。识别 = 捕获阶段按锚按钮 aria 模板（zh「工作区“{name}”的操作」/ en "Workspace actions for {name}"），从行 `data-row-key="workspace:<id>"` 取 id；MutationObserver 看到 body 直挂 `[role=menu]` 挂载后，把「分隔线 + 两项」追加到 `menu.firstElementChild`。
  - 链接 = `?ws=<workspaceId>`（`workspace-focus.ts` 的 `buildWorkspaceFocusLink`，5 行纯函数）；新窗口项在点击手势内 `window.open(url, '_blank', 'noopener')`。
- 对照物 dsh-ao-local（A1，`client-parts/90-apply.js` 的 `tryInjectOfficialMenu`，约 5172-5228 行）：把 归档/收藏/快速搜索/复制工作区目录地址 注入**同一个**官方菜单。差异有两处：
  - 容器取 `menu.querySelector('[class*="_viewport"]') ?? menu`（不是 firstElementChild）；
  - 注入增高后做了菜单视口夹取（`rect.bottom` 超出视口 12px 边距就把 `menu.style.top` 上移）。
- 核心 Menu 结构（0.2.0-rc.2 `dsh-client-ui-primitives/lib/index.js` 已核实）：`div[role=menu]` 首子元素就是 `.viewport`（role=presentation，items + React children 都在里面）；Menu 原生支持子菜单——`entry.submenu` 渲染嵌套 MenuSurface（`role=menu`、class submenu），行带 `aria-haspopup="menu"`，CSS 定位 `bottom:-4px` / `left:calc(100%+10px)`，无视口钳制（menu-flip.ts 记录的宿主缺陷）。

## 「新菜单」疑点（开发第 0 步，先定位再动手）

静态核对结论：注入目标就是官方 ⋯ 菜单本体，firstElementChild 理论上就是 viewport，与 ao-local 等效——「用户看到新菜单」在本地检出的代码上解释不通。剩余假设按概率排序：

1. **运行宿主的核心版本 ≠ 本地 0.2.0-rc.2 检出**：菜单 DOM 多一层包装 → firstElementChild 不是 viewport，注入项落在菜单卡片外，视觉上是另一块浮层。
2. **注入撑高未夹回**：ao-local 注入后做了视口夹取，better-sidebar 没有；两组「分隔线+项」叠加后菜单底被推出视口，看起来断出一截像第二个菜单。
3. **用户点的是 ao-local A2/A3 自建行**（活跃分组/收藏/归档桶行，`.ao-local-menu` 自绘菜单壳）——那套菜单本来就没有独立工作区两项；两项只存在于官方行菜单，用户对官方菜单反而陌生。

第 0 步动作：拿用户一张截图（点开 ⋯ 后两项在哪个容器、与「复制工作区目录地址」是否同卡片），或在浏览器 DOM 实测。定位后才进入开发。

## 目标形态

```
工作区行 ⋯ 菜单（dsh 官方 portal 菜单，一张卡片）
├ 重命名
├ 删除工作区
├ ────────────────  ← ao-local 注入组（现状保留，不动）
├ 归档工作区
├ 收藏工作区
├ 快速搜索会话…
├ 复制工作区目录地址
├ ────────────────  ← better-sidebar 注入组（本规划改动面）
└ 独立工作区              ▸ 子菜单（紧贴行右侧弹出，核心子菜单同款）
    ├ 复制链接             → 复制 ?ws=<id>
    ├ 新窗口打开           → window.open ?ws=<id>
    ├ ──────────────
    ├ 加入到组             ▸ ☑ 组A / ☐ 组B / ＋ 新建组…
    ├ 组A                 ▸ 新窗口打开全组 / 复制全组链接 / 从该组移出
    └ 管理独立工作区组…    → 自绘管理面板
```

## 方案

### 1. 修复注入落点（对齐 A1 的成熟做法）

- 容器改 `menu.querySelector('[class*="_viewport"]') ?? menu`，与 ao-local 同一查询；
- 追加后做同款视口夹取（超视口底部就把菜单 top 上移回 12px 边距内）；
- 未分组桶（`workspace:` 空 key）依旧不出该项（与复制目录地址同规则）；
- 顺序：追加在 viewport 末尾，天然落在 ao-local 注入组之后，不做跨插件强制排序。

### 2. 「独立工作区」一级项 + 子菜单

- 删掉两项平铺，替换为一个一级项「独立工作区」（14px SVG 图标、`aria-haspopup="menu"`，样式转录核心 Menu .item 配方——类名是构建产物不作为钩子，颜色全走 `--dsw-*` 令牌）；
- 子菜单 DOM 自绘：嵌套 `div[role=menu]`，定位照核心配方 `bottom:-4px` / `left:calc(100%+10px)`；贴右缘/上缘翻转复用本仓库 menu-flip 的 body 属性令牌机制（`data-dsh-sidebar-submenu` 的 CSS 只在属性存在时生效，宿主自有菜单不受染）；
- 交互：hover 开（对齐核心 onMouseOver 语义）+ 点击兜底；Escape / 菜单外 pointerdown 收起；子菜单挂在父菜单容器内，父菜单随官方 onClose 卸载时天然随迁；
- 子菜单内容（本期）：复制链接 / 新窗口打开 / 分隔线 / 加入到组 ▸ / 所属组各一条 ▸ / 管理独立工作区组…；
- 降级契约不变：核心改 aria 模板或行键 → 捕获不命中，菜单保持原样（缺一项，绝不坏页）。

### 3. 独立工作区组

- **存储**：DSH 设置服务 `dsh-better-sidebar` 命名空间的 `pluginSettings.workspaceGroups`。理由：2026-10-15 设置页 tab 方案已验证——schema 未声明的**顶层**字段写入会被 dsh-settings 拒（`Config field … is not volatile`），而 `pluginSettings` 子树是 volatile 开放 map，校验首层跳过，新旧宿主都收；跨浏览器跟随宿主存储。读写走既有 `api.settingsGet` / `api.settingsUpdate`，坏值按空数组兜底。
- **形状**：`Array<{ id: string; name: string; workspaceIds: string[] }>`；id 用短随机 id；workspaceId 与核心行键 / `?ws=` 链接同源。
- **入口**（都在「独立工作区」子菜单内）：
  - 加入到组 ▸：组清单勾选态点选切换归属；末条「＋ 新建组…」行内输入建组并勾上；
  - 所属组每条 ▸：新窗口打开全组 / 复制全组链接 / 从该组移出；
  - 管理独立工作区组…：自绘管理面板（跟随 open-with-settings / AnchoredPopover 既有模式）——组的新建/重命名/删除，组内成员 chip 增删（候选 = `workspaces.list` 快照），每组行内「新窗口全部打开」「复制全部链接」。
- **批量打开**：同一用户手势内逐个 `window.open(_blank,'noopener')`；浏览器对同手势多次 open 可能从第二个起拦截——被拦的剩余链接整串复制进剪贴板 + toast「已打开 N 个，剩余 M 个已复制（允许弹窗可全开）」。动作时对 `workspaces.list` 快照求交集，失效 id（工作区已删）跳过，管理面板里标灰可清。
- **复制全组链接**：每行一条 `?ws=` 链接（默认纯链接逐行；备选「名字 链接」两列，开发前拍板）。
- **专注模式零改动**：链接仍是 `?ws=<id>`，`workspace-focus` / `workspace-focus-dom` 照常。

### 4. i18n / 版本 / 测试

- `locales.ts` zh/en 新键（独立工作区 / 复制链接 / 新窗口打开 / 加入到组 / 新建组… / 管理独立工作区组… / 组动作 / toast 系），其余语言走 zh/en 回退链；旧键 workspaceCopyLink / workspaceOpenStandalone 随重构处置，CHANGELOG 记迁移。
- 版本 0.28.32 → 0.28.33（package.json / dsh.plugin.json / SIDEBAR_SERVICE_VERSION 三处）。
- 测试（vitest 单测；**不做 e2e / mount / playwright**，遵守环境临时规则）：
  - `tests/workspace-link-menu.spec.tsx` 扩展：注入容器断言（落在 `_viewport` 内）、一级项 + 子菜单结构、旧两项不再平铺、降级契约回归；
  - 新 `tests/workspace-groups.spec.ts`：组数据校验 / 增删改 / 与快照交集过滤 / 批量 open 拦截兜底 / 复制格式；
  - 管理面板组件测试（跟随既有组件测试模式）。

## 交付通道（开发完成后）

- 源码开发在 `/code/www/my/github/DSH-better-sidebar`；构建按环境规则**不在 [项目www目录] 内 build**——改动同步到 `/app/cache/my/github/DSH-better-sidebar` 构建（`pnpm build && pnpm pack`），tgz 产物放同目录。
- `/root/.dsh/profiles/web/package.json` 的 `dsh-better-sidebar` file: 指向新 tgz → `pnpm install` → touch cordis.patch.yml 注释行触发 dsh-hmr reconcile → 浏览器普通刷新生效；判活：`/plugins/??dsh-better-sidebar/client.js&rev=<新rev>` 回 200。
- 遵守 `ai/好设计/组件-扩展/deepseek-harness/插件/必须遵守规范.md`：不重启 dsh；交付说明写清「无需重启、普通刷新即可」。
- 新增/改动不涉及后端接口（组存储走既有设置通道），无需新增路由。
- 提交（仓库惯例，注意工作树可能有并行会话改动，按 hunk 分离只提本功能）：
  - `[auto] feat([工作区]): [独立工作区菜单] 注入落点修复+一级子菜单`
  - `[auto] feat([工作区]): [独立工作区组] 分组存储+批量打开/复制`

## 开发前待用户拍板

1. 「新菜单」截图一张（有最好；没有则开发第 0 步浏览器 DOM 实测定位）。
2. 一个工作区是否允许同时属于多个组：默认**允许多组**（清单勾选语义）；要单选请说。
3. 复制全组链接格式：默认**每行一条纯链接**；要「名字+链接」两列请说。

## 需求3 契约落地记录（v0.28.35，覆盖上文「批量打开/复制全组链接」旧设计）

用户原话：**「搞个唯一值，打开的时候解析要显示多少」**。据此 `?ws=` 值升级 scope 语义、向后兼容，上文规划里「同一手势逐个 window.open + 弹窗拦截兜底」与「复制全组 = 每行一条链接」整套废弃，落地如下：

- **scope 解析**：`workspace-focus.ts` 新增 `parseFocusScope(value) → {kind:'workspace',id} | {kind:'group',id} | null`——裸值 = 单工作区（存量链接不变）；`g:<groupId>` = 独立工作区组（**组 id 即唯一值**）；空值 / 空 id / 超长 → null 退全量。
- **打开时解析**：`workspace-focus-dom.ts` 对 group scope 从设置通道读 `pluginSettings.workspaceGroups`（异步一拍，读取失败按「未就绪」不过滤不误报），`workspace-groups.ts` 的 `resolveGroupFocus` 按组 id 反查并把组内 id 与 `workspaces.list` 快照求交集——专注视图显示的就是**组内 N 个工作区及其会话**（显示多少 = 交集）；组不存在 / 组为空 / 交集为空 → 退全量 + toast「专注链接已过期」（对齐既有过期链接契约）。专注横幅显示组名与数量（`focusBannerGroupLabel`：「专注：{name}（{count} 个工作区）」）。`focusMembership` 扩展为接受工作区 id 集合，`workspace-focus-dom` 按集合过滤。
- **组链接 = 一条 `?ws=g:<groupId>`**：`buildGroupFocusLink`（与单工作区同参数名同拼装）。**新窗口打开全组** = 用户手势内 `window.open` 这一条（一窗整组，无第二次 open、无弹窗拦截问题）；**复制全组链接** = 复制这一条 + toast 带组名与数量。
- **管理面板兜底**：每组保留「复制全部单工作区链接」（`buildEachWorkspaceFocusLinks`，多行裸 `?ws=<id>`），用于想把组拆开发给别人的场景；「新窗口打开全组」在面板里同样是那一条 g: 链接。
- **多组归属**：允许（清单勾选语义，`groupsContaining` 保序返回全部所属组）——上文待拍板第 2 条按默认落地；第 3 条（复制格式）按新契约改为一条 g: 链接为主、多行裸链接为面板兜底。
- **实现分布**：纯逻辑 `src/client/workspace-groups.ts`（解析/增删改/交集/两种复制格式，vitest 直测 tests/workspace-groups.spec.ts）；菜单与面板 `src/client/workspace-link-menu.ts`（组行/加入到组/管理面板）；scope 消费 `src/client/workspace-focus.ts` + `workspace-focus-dom.ts`。
