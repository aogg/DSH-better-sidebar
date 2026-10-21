# 右侧栏「搜索」页：Find in Files（PhpStorm 式内容搜索）

日期：2026-10-21　状态：设计稿（客户端页面与文件页迁移未实现；host 侧 v2 契约已在工作区落地，见 §10）

> 定位：新增一个与「文件」（`editor`，order 10）、「变动」（`git`，order 20）同级的独立
> tab 类型 `search`（order 15），承接 PhpStorm Find in Files 的使用方式。参考 PhpStorm 的
> 三段式（顶部查找输入条 / 结果树 / 右侧预览），但本插件是**右侧窄边栏**，用户已明确修正：
> **不做左右分栏**——每条匹配块上放「查看」按钮，点击在编辑器打开该文件并跳到匹配行。
>
> 原文件页里的「文本内容搜索」**整体迁走并删除**：范围 chips、默认大小写不敏感字面量匹配、
> 预算与 truncated 语义、explorerExclude 偏好叠加等全部语义由新搜索页继承。

## 1. 背景与问题

现状的内容搜索藏在文件页（`TreePanel`）树面板的一个折叠区里（入口行
`src/client/TreePanel.tsx:509-519` + 面板 `:520-602`），产品上有四个硬伤：

1. **只回文件名**：结果是一个文件路径列表（`:646-670`），看不到命中行、行号与上下文，
   打开文件后还得再 Ctrl+F 找一遍。
2. **与文件名搜索互相顶掉**：两个搜索共享一个结果区、互斥（`:224-231`），输入文件名查询会
   清掉内容查询，反之亦然（`:423-428`、`runContentSearch :267-272`）。
3. **藏在折叠区**：功能存在感低，与「文件」「变动」同级的核心动作不匹配。
4. **无匹配器能力**：迁移前只有大小写不敏感字面量匹配，没有区分大小写 / 全词 / 正则。

诉求不是「在树面板里再改一改」，而是把内容搜索升格为一级页面。

## 2. 已定决策（实现不得偏离）

1. **新内置 tab 描述符** `id: 'search'`、`order: 15`（文件=10、变动=20 之间）。
   `createTab` 铸 `search:<uuid>` 实现多实例——与 `terminal-bottom:${crypto.randomUUID()}`
   及 `sidechat:new-${uuid}` 同一模式（`src/client/builtins/tabs.tsx` 里两个 createTab
   描述符，符号名定位；该文件正被并行修改，行号不锚）；
   **不声明 `dedupeKey`/`single`**（service 层因此永不 dedupe：`src/client/service.ts:1227-1229`）。
   非 `bottomOnly`、非 `hidden`，于是原生右栏 tab 类型 + guide 胶囊
   （`src/client/native/index.ts:452-461、380-391`）与底部工作台 `+` 菜单
   （`src/client/sidebar/TabContent.tsx:57-69`）都自动出现，不需要额外入口代码。
2. **搜索页状态存 `tab.meta`**（随布局持久化、重载恢复：`src/client/state.ts:43-45` 与
   `sanitizePersistedTab :856-864` 逐字透传）；**结果不持久化**，挂载时 query 非空自动重跑。
   注意 `updateTab` 的 `meta` 是**整体替换**（`state.ts:397-404`），页面要读-改-写
   （先例：`src/client/EditorHost.tsx:98-100` 的 `patchMeta`）。
3. **tab 标题**：未搜索时「搜索」（`t('search')`，由 `createTab` 铸进 tab 记录）；提交搜索后
   变为「搜索: "查询词"」（超长截断，见 §4.7），视图经
   `ctx.get('betterSidebar')?.updateTab(tab.id, { title }, scope.sessionId)` 改记录标题
   （先例：`src/client/SideChatView.tsx:728`）。描述符自身的 `title()`/guide 标题恒为
   「搜索」——`+` 菜单与 guide 不随实例变。
4. **host：升级现有 `fs.contentSearch` 路由为行级结果 v2**（路由名不变，插件内 host+client
   同包同发，无兼容窗口）。**契约类型已在本仓库落地**：`src/content-search-types.ts`
   （host/client 共用的无依赖类型模块，形状见 §5.1）。rg 侧改用 `--json -C 2` 解析
   match/context 事件；plain JS walk 兜底自己扫行；**命中区间由 host 对解码后的行文本用
   同一匹配器（字面量/全词/JS 正则）重新推导**，不采信 rg 的字节偏移（编码坑隔离在 host
   一侧）。预算：文件数 200、每文件命中上限、总命中预算、visited 100k 不变，truncated
   语义保持诚实（实现值见 §5.4）。
5. **匹配器选项走 wire**：`caseSensitive` / `wholeWord` / `regex`（默认 = 大小写不敏感
   字面量，与旧语义一致）；正则用 JS RegExp 校验，非法 → `bad-request`
   （路由内编译一次即拒，与该路由对 query 超长的既有拒绝方式同一形态）。
6. **客户端点击「查看」**：`openSidebarFile(ctx, sessionId, absolutePath, line)`
   （`src/client/sidebar-file.ts:131-147`，已支持 1 基行跳转，#826）。
7. **搜索历史**：localStorage key `dsh-sidebar:search-history:v1`（与仓库既有
   `dsh-sidebar:v1:*`、`dsh-sidebar:settings-tab` 同族），条目
   `{ query, include[], exclude[], at }`，按 `query + include + exclude` 去重、最新在前、
   上限 20；下拉每行可单删；跨 tab / 跨会话共享（`storage` 事件同步已打开的下拉）。
8. **文件页移除点**（逐行清单见 §6.1）：`src/client/TreePanel.tsx` 的内容搜索区；
   `src/client/FileTree.tsx` 的 `onAddToContentSearch` 旧逻辑（菜单项保留但改语义，
   见 §3.3）。文件名搜索不动。

## 3. 信息架构与入口流

### 3.1 `+` 菜单与 guide（零额外代码，靠描述符声明）

- 底部工作台 `+` 菜单：`buildNewTabOptions` 列出非 hidden 且启用的描述符（按 `order` 排序），
  「搜索」落在「文件」「变动」之间。
- 宿主右栏 guide 胶囊：`sync()` 给非 bottomOnly 描述符注册 guide 行
  （id `search`、order 15、标题「搜索」、描述 `guideDescSearch`）。注意宿主在 guide 条目
  >4 条时只渲染标题不渲染描述（`service.ts:172-181`），描述仍要声明（有朝一日条目变少）。
- settings 里该类型可被禁用：禁用后两处菜单都不出现，`openTab` 拒绝（`service.ts:1175-1178`），
  已开实例继续渲染——与所有内置类型同一契约，不特判。

### 3.2 开始页胶囊「搜索」

`src/client/sidebar/start-links.tsx`：`StartLink['kind']` 联合类型（`:46`）加 `'search'`，
`links` 数组（`:178-198`）在「变动」之后插入胶囊，`openStartLink`（`:87-128`）加分支
`service.openTab({ type: 'search' })`。语义与其余插件 tab 胶囊一致：无活动会话时 openTab
内部静默返回（不抛错）；每次点击铸一个**新**搜索 tab（多实例语义对胶囊同样生效）。

### 3.3 文件树右键菜单「添加到搜索中」→ 重定向

菜单结构不变（`src/client/FileTree.tsx:2131-2144` 的 `addToSearchSubmenu`，文案
`addToSearch / addToSearchInclude / addToSearchExclude` 保留），但行为改为：

1. 点击「添加到包含 / 添加到排除」时，把右键行的路径折算成 chip 形状——
   cwd 相对路径（`relativeTo(cwd, path)`），越界路径以绝对值透传（沿用旧
   `addToContentSearch` 的折算规则，`TreePanel.tsx:343-350`，host 对两种拼写同义分类）；
2. 调 `parkSearchSeed({ target, chip })` 后 `service.openTab({ type: 'search' })`——
   **铸一个新搜索 tab**（即使已开着别的搜索页），新 tab 的 `meta.include`/`meta.exclude`
   预填该 chip；**不自动执行搜索**（与历史回填同一语义：回填 ≠ 运行）；
3. 不再注入文件页面内的搜索面板（旧路径整体删除）。

**机制说明（为什么用一次性种子而不是 seed.meta）**：`createTab` 描述符的 open 会忽略
seed 的 `title/path/id`（`service.ts:722-727` 注释、`:1231`），且 seed.meta 对铸出的
meta 是整体替换而非合并（`:1254` `meta: seed.meta ?? minted?.tab.meta`）——回填需要与
默认开关/chips 合并。因此走一次性模块级种子，由 `createTab` 消费，与本仓库既有
`consumeBottomTerminalCwd` / `consumeSidechatSeed` 同构（均在 tabs.tsx 的
createTab 描述符里被消费）。
接线：`EditorHost`（持有 ctx/scope，渲染 TreePanel 于 `:679/:821`）实现处理器并作为
`onAddToSearch` prop 传 `TreePanel` → `FileTree`（替换原 `onAddToContentSearch` prop，
`TreePanel.tsx:695`、`FileTree.tsx:739-744`）。

### 3.4 打开后的落点

`openTab` 默认落右栏原生面（`target` 缺省 `'right'`）；createTab 描述符每次铸新 tab、
`revealIfOpened=false`（`service.ts:1235`），不产生 dedupe 聚焦。不提供「在底部工作台打开」
的入口（搜索页是右栏页面，非 bottomOnly）。

## 4. 页面布局与交互规格

### 4.1 布局（窄边栏，自上而下）

```
┌──────────────────────────────────────────────┐
│ [🔍 查询词____________________] [Aa][W][.*]  │ ← 工具栏：查询框 + 三开关
│ [包含: 目录/文件/通配符 ⏎]  [history ▾]      │ ← include chips / 历史下拉
│   (src/**) (docs) ×                          │
│ [排除: … ⏎]                                  │ ← exclude chips
│   (dist) ×                                   │
├──────────────────────────────────────────────┤
│ src/client/TreePanel.tsx　18 处命中      [▾] │ ← 文件头行（相对路径·命中数·折叠）
│  ├ 234 │ const runContentSearch = (): void => {   [查看] │ ← 块首行：命中高亮 + 查看
│  ├ 233 │ /**                                 │        │ ← 上下文行（上 2）
│  ├ 235 │   const next = contentDraft.trim()  │
│  ├ 236 │   if (next === '') return           │        ← 上下文行（下 2）
│  ├ 237 │   setQuery('')                      │
│  ├ 267 │ const runContentSearch = …          │ ← 第二块（上下文窗口不重叠）
│  …                                            │
│ src/client/FileTree.tsx　4 处命中        [▸] │ ← 折叠的文件
│ ── 结果过多，仅显示部分匹配（已截断） ──      │ ← 截断提示
└──────────────────────────────────────────────┘
```

### 4.2 工具栏

- **查询框**：单行输入；Enter=运行；Esc=清空（先清输入，再清结果，见 §4.6）。
- **三个开关**（PhpStorm 同款、i18n 悬停提示）：区分大小写 `Aa`、全词 `W`、正则 `.*`；
  切换态高亮。默认全关 = 大小写不敏感字面量（继承旧语义）。
  正则开启时查询框失焦/提交前预校验：`new RegExp` 抛错则输入框标红 + 行内提示
  （新键 `searchRegexInvalid`），**不发请求**；宿主 `bad-request` 是兜底。
- **include/exclude chips**：两个输入行 + chip 列表，Enter 追加（trim、去重、空串忽略），
  chip 上 × 删除——交互与旧面板一致（`TreePanel.tsx:292-307、535-600`），语义继承
  host 侧分类（存在目录 → 子树范围/剔除，存在文件 → 单文件，其余按 exclude-patterns
  子集 glob（`classifyEntries`/`buildContentFilter`，`src/fs-content-search.ts`），全部不动）。
- **历史下拉**：查询框尾部时钟图标；见 §4.3。
- **运行 / 清空**：Enter 即运行（不设独立运行按钮，与旧面板 Enter 提交一致）；
  查询框有内容时显示 × 清空（清输入 + 清结果 + 标题回「搜索」）。

### 4.3 搜索历史（下拉）

- 存储条目 `{ query, include[], exclude[], at }`；**只记提交**（Enter/点击运行且查询
  非空、请求成功发出时）。开关状态不入历史。
- 去重键 `query + include.join('\0') + exclude.join('\0')`（数组原序）；命中即删旧插首。
  最新在前，上限 20，超限丢尾。跨 tab/跨会话共享：写后派发 `storage` 事件同步已打开
  的下拉；读写失败（隐私模式等）静默降级为「本次会话内存态」。
- 下拉每行：查询词（粗体）+ include/exclude 计数徽标 + 单删 ×。**点击 = 快速回填**
  query/include/exclude 三项，**不自动执行搜索**；开关保持页面当前值。
- 空历史显示占位文案（`searchHistoryEmpty`）。

### 4.4 结果区

- **文件头行**：相对路径（root-relative、'/' 分隔，同 v1 排序语义：文件按路径字典序）
  + 命中数（host 下发的真实总数 `count`）+ 折叠箭头。文件级截断时命中数旁加
  「已截断」小标记。点击头部本身不跳转（防误触）；折叠态只显示头部行。
- **块**（核心概念）：一块 = 1 条命中行（高亮）+ 上 2 行 + 下 2 行，全部带行号。
  **同一文件内上下文窗口重叠/相接的块合并成一块**：命中按行号升序，块的行区间为
  `[min(line−2), max(line+2)]`，下一条命中的窗口与当前块区间相接（`next.line − blockEnd ≤ 3`）
  即并入。合并算法放独立纯函数模块（§6.3 的 `search-blocks.ts`），单测钉住（§8）。
- **命中高亮**：一行内多处命中渲染多个高亮 span，用 host 下发的 `column/length`
  切片（`text.slice(column, column+length)`）。
- **查看按钮**：每块命中行行尾一个 ghost「查看」（悬停显形，新键 `searchView`），
  点击 `openSidebarFile(ctx, scope.sessionId, absolutePath, 块首命中行号)`；
  双击任意命中行 = 打开该行（同一调用，行号取被双击的行）。路径用
  `resolveSidebarPath(cwd, rel)` 还原绝对路径（旧面板同款，`TreePanel.tsx:661`）。
- **行号**：块内每行左侧，行号列右对齐、上下文行淡色。

### 4.5 状态与空态

| 状态 | 表现 |
|---|---|
| 加载 | 结果区显示 `loading` 文案（旧面板同款键） |
| 无结果 | `searchNoResults`（或复用 `editorSearchNoResults`） |
| 错误 | 红字一行（正则非法是提交前本地拦，不落到这里） |
| 截断 | 结果区底部一条提示：全局截断用 `editorSearchTruncated` 语义；文件级截断在文件头命中数旁显示「已截断」标记 |

- 空 query：不发请求、清结果（继承 v1「空查询不触引擎」：`contentSearch` 入口对空查询直接返回）。
- 会话无 cwd（`scope.cwd === undefined`）：页面显示空态「无会话工作区」，禁用工具栏。
- **自动重跑规则**：挂载时 `meta.query` 非空自动重跑（已定决策）；结果已展示时，chips
  或开关变化自动重跑（继承旧面板 effect 语义，`TreePanel.tsx:352-382`，沿用
  AbortController：新提交中止在途请求）；**查询词变化不自动重跑**（保持 Enter 提交式）。

### 4.6 键盘

| 焦点 | 键 | 行为 |
|---|---|---|
| 查询框 | Enter | 运行 |
| 查询框 | Esc | 有输入先清输入；无输入清结果并收起历史 |
| 查询框 | ↓ | 焦点移到结果区并选中首个/上次块 |
| 历史下拉开 | ↑/↓ | 在历史项间移动 |
| 历史下拉开 | Enter | 回填该项（不执行） |
| 历史下拉开 | Esc | 收起下拉 |
| 结果区 | ↑/↓ | 在块间移动选中 |
| 结果区 | Enter | 打开选中块首命中行（同「查看」） |
| 结果区/页面 | Esc | 清空查询与结果，焦点回查询框 |

双击命中行 = 打开该行（鼠标等价物）。

### 4.7 多实例与标题

- 每次打开（胶囊/+/右键重定向）都铸 `search:<uuid>` 新 tab，可同时开任意多个；
  两个搜索 tab 状态互不影响（各自 meta）。
- 标题：未搜索「搜索」；提交后 `搜索: "查询词"`，查询词超 24 个 UTF-16 字符截断加 `…`
  （tab strip 自身还有 CSS 截断，这里截的是记录标题本身）。标题改动经 `updateTab`
  持久化，重载后恢复（`sanitizePersistedTab` 保留 title）。内置描述符的标题/描述
  两两互异断言（`tests/builtins.spec.ts:118-150`）自动守护「搜索/Search」不撞名。

### 4.8 持久化行为汇总

| 数据 | 去向 | 重载后 |
|---|---|---|
| query、三开关、include/exclude chips | `tab.meta`（随布局，`dsh-sidebar:v1:<id>`） | 恢复；query 非空自动重跑 |
| 结果、块折叠状态、滚动位置 | 不持久化 | 重跑得到 |
| tab 标题 | tab 记录 | 恢复 |
| 搜索历史 | `localStorage['dsh-sidebar:search-history:v1']`（全局，不分会话） | 跨 tab/会话共享 |

## 5. host 契约 v2（`fs.contentSearch`）

### 5.1 wire 形状

请求（在现 payload 上加三个开关键，`include/exclude/prefExclude` 语义逐字不变）：

```
{ query: string, include?: string[], exclude?: string[], prefExclude?: string[],
  caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean }
```

客户端 `api.fsContentSearch` 把三个开关收进一个 `match?: ContentSearchMatchOptions`
参数再平铺上 payload（已按此实现，`src/client/api.ts` 的 `fsContentSearch`）。

响应（v1 的 `matches: string[]` 升级为行级分组；类型即 `src/content-search-types.ts`
的 `ContentSearchResult/ContentFileHit/ContentLineHit`）：

```
{ matches: [{ path, count, truncated,
              hits: [{ line, column, length, text, before: string[], after: string[] }] }],
  truncated }
```

- `line`：1 基行号（与 `openSidebarFile` 的 line 跳转一致）。
- `column`：0 基行内下标（UTF-16 码元），`length`：命中片段长度——均为 JS 字符串索引
  （解码后行文本 `text`），由 host 重推导（§5.3），前端直接切片。
- `text`：整行文本（不含行尾符）；`before`/`after`：上下 2 行的文本数组（`≤2` 条，
  文件首尾不足则短）。
- `count`：该文件**真实命中总数**（扫描不被 payload 预算截断，预算只截 `hits` 的装载）；
  `hits.length < count` 当且仅当每文件命中上限截断了装载，文件级 `truncated` 恰好标记
  这种情况（`content-search-types.ts` 的 `ContentFileHit` 注释即口径）。
- `hits` 按行号升序；同一行多处命中为多个条目（同 line 不同 column）。
- 顶层 `truncated`：任一预算触碰（文件数 / 每文件 / 总命中 / visited / 流哨兵 / 15s 超时）
  即 true——诚实语义沿 v1。

### 5.2 匹配器（单一语义源，已实现）

host 侧唯一匹配器是 `createLineMatcher(query, resolvedOptions)`（导出自
`src/fs-content-search.ts`，选项经 `resolveMatchOptions` 归一，类型在
`src/content-search-types.ts`）：给定解码行文本，返回全部 `{ column, length }`。
rg 与 plain walk 用同一个实例，保证命中区间与引擎无关。

- 字面量：大小写折叠沿用 v1 口径（`toLowerCase` 比较）。
- 全词：字面量 + 两侧边界（非 `[A-Za-z0-9_]`，即 JS `\b` 的 ASCII 语义，行首尾算边界；
  Unicode 边界列入 §8 已知边界）。
- 正则：JS RegExp 编译一次；编译失败由路由转 `bad-request`。
- 空查询：不触引擎直接空结果（v1 不变）。

### 5.3 rg 通道

- argv（已实现为 `contentRgArgv`，`src/fs-content-search.ts`）：`--json -C 2` +
  按选项组合 `-F`（字面量）/ `-i`（!caseSensitive）/ `-w`（wholeWord）；跳过目录
  `--iglob` 对、`--hidden --no-ignore`、`--path-separator /`、`--` 后多根 include 路径
  ——全部保留；模式形 include/exclude 仍由 host `compileExcludePatterns` 裁决
  （单一语义原则不变）。
- 解析只取 `match` 事件的 `line_number` 与 `lines.text`、`context` 事件的 `lines.text`；
  **忽略 rg 的 submatch 字节偏移**，命中区间由 §5.2 匹配器对该行文本重推导
  （rg 只当「行级召回引擎」；JS 匹配器不认的行直接丢弃，语义以 JS 匹配器为准）。
- **哨兵口径（实现必读）**：现有 `runEngineArgv`/`streamLines` 的截断哨兵是
  「行数 > maxMatches+1 即 kill」（`src/search-engines.ts:263-319、575-583`，未改）。
  `--json` 下每行是一个事件（begin/match/context/end 混排），哨兵必须以**按 match 事件
  计数**的总命中预算为准（上下文事件随行自然携带），否则 truncated 会失真。exit 1=
  无匹配、15s 超时→本树过大回落 walk、失败禁用引擎至进程结束——这些既有契约全部不动。

### 5.4 plain JS walk 兜底

`searchContentPlain` 升级为产 hits（已实现）：预算、skip 集、符号链接环路安全、
512 KiB 上限、8 KiB NUL 二进制嗅探全部不变；读入后自行按行扫描，用 §5.2 匹配器产
`{line, column, length}`，context 取同一 buffer 相邻行。
**预算常量（实现值，均需进单测）**：文件数 200（`DEFAULT_MAX_MATCHES`）、
每文件命中 100（`MAX_HITS_PER_FILE`）、总命中 2000（`MAX_TOTAL_HITS`）、上下文窗口 2
（`CONTEXT_LINES`）、visited 100_000（`DEFAULT_MAX_VISITED`）、query ≤ 256 字符
（`exclude-patterns.ts:21`）。

### 5.5 分类与偏好叠加（逐字继承）

`classifyEntries` / `buildContentFilter` / explorerExclude `prefExclude` 叠加、
`sidebarEntryListOf`、`compileExcludePatterns` 接线（`src/index.ts` 的
`fs.contentSearch` 路由）不动，只在路由里多透传三个开关、多一层正则校验
（正则编译一次放在路由入口，非法即 `bad-request`）。

## 6. 范围变更清单

### 6.1 移除（文件页）

| 位置 | 移除内容 |
|---|---|
| `src/client/TreePanel.tsx:208-221` | 内容搜索 state：`contentOpen/contentQuery/contentDraft/contentInclude/contentExclude/includeDraft/excludeDraft/contentResults/contentError` |
| `:224-231` | `contentNeedle/contentActive` 与两搜索互斥逻辑（`searching` 收敛为仅文件名） |
| `:262-283` | `runContentSearch` / `toggleContentOpen` |
| `:292-307` | `addChip` / `addContentEntry`（chips 逻辑随页面迁走，新页面自实现） |
| `:343-350` | `addToContentSearch`（语义移交 §3.3 的新处理器） |
| `:352-382` | 内容搜索 effect（`fsContentSearch` 调用点） |
| `:423-428` | 输入文件名时清内容查询的分支 |
| `:505-602` | 入口行 + 面板 JSX（含 chips） |
| `:646-670` | 结果区内容搜索分支（保留文件名分支 `:615-645`） |
| `:695` | `onAddToContentSearch` prop 传递（换新 prop） |
| `:1-29` | 模块头注释改写（去掉内容搜索段落） |
| `src/client/FileTree.tsx:739-744、813、2120-2144、2880-2883、2983-2986` | `onAddToContentSearch` prop 与旧回调（菜单项与 `addToSearchSubmenu` 保留，onSelect 改投新回调） |
| `src/client/sidebar.module.css:1584-1649` 一带 | `.contentSearch*` 规则删除；chips 样式若新页面复用则迁入新模块 |
| `src/client/locales.ts` | 删键：`contentSearchToggle/contentSearchQueryPlaceholder/contentSearchIncludePlaceholder/contentSearchExcludePlaceholder/contentSearchRemove`（若更名复用则按新键处理）；`addToSearch*` 三键保留 |

### 6.2 保留（文件页）

文件名搜索全套（输入框、300ms 防抖 effect、`fs.search`、目录命中导航、truncated 提示、
`exclude` 偏好透传）逐字不动；右键菜单「添加到搜索中」两级结构不动（仅回调改语义）。

### 6.3 新增

| 文件 | 职责 |
|---|---|
| `src/client/SearchView.tsx`（+ `.module.css`） | 搜索页主体（工具栏/结果区/状态面），颜色一律 `--dsw-*` 令牌（`tests/theme.spec.ts` 守护无硬编码颜色） |
| `src/client/search-blocks.ts` | 纯函数：hits → 合并后的块（含行区间与高亮 span 切分） |
| `src/client/search-history.ts` | localStorage 历史读写（去重/上限/单删/`storage` 事件） |
| `src/client/search-seed.ts` | 一次性种子 `parkSearchSeed/consumeSearchSeed`（§3.3） |
| `src/client/builtins/tabs.tsx` | 第 9 个描述符 `search`（order 15、createTab 铸 `search:<uuid>`、meta 默认值、component） |
| `src/client/builtins/tab-icons.tsx` | `searchTabIcon`（`VscSearch` + css map 加 `'search'` 键，`tab-icons.module.css` 加类） |
| `src/client/api.ts`（`fsContentSearch`） | 签名升 v2：`match?: ContentSearchMatchOptions` 参数 + `ContentSearchResult` 返回（已实现） |
| `src/content-search-types.ts` | v2 wire 类型（host/client 共用、无依赖）——**已存在**，实现以它为准 |
| `src/index.ts`、`src/fs-content-search.ts` | 路由与引擎 v2（§5）——**host 半边已在本工作区实现**（未提交） |
| `src/client/sidebar/start-links.tsx` | 「搜索」胶囊（§3.2） |
| `src/client/EditorHost.tsx` | 「添加到搜索中」重定向处理器（§3.3） |
| `src/client/locales.ts` + 19 个 `locales-XX.ts` | 新键（`search`、`guideDescSearch`、查询框/开关/chips/历史/查看/无结果/截断/正则非法等约 15 键）+ 废弃键清理。**注意：新键必须同步进全部 19 个懒加载语言包**——`tests/locales.spec.ts:109`（en 键集=zh）与 `:112-118`（19 包键集=zh）把键集相等钉死了，运行时 zh/en 兜底链（`locales.ts:1622-1648`）救不了测试 |

## 7. 验收清单

入口与多实例
- [ ] 底部 `+` 菜单出现「搜索」，位于「文件」「变动」之间；宿主 guide 出现 order 15 的「搜索」胶囊
- [ ] 开始页 hero 出现「搜索」胶囊，点击铸新 tab；无活动会话点击不抛错
- [ ] 连续打开三次得到三个独立搜索 tab（id 均为 `search:<uuid>` 形态），状态互不影响
- [ ] settings 禁用该类型后：`+` 菜单/guide/胶囊全部消失，`openTab` 拒绝，已开实例仍渲染

搜索与结果
- [ ] Enter 运行；结果按文件分组、文件按路径排序；块 = 命中行高亮 + 上下各 2 行，全带行号
- [ ] 同文件上下文窗口重叠的块合并为一块（构造相距 1/2/3/4 行的命中验证合并与不合并边界）
- [ ] 一行多处命中显示多个高亮 span；查看按钮/双击行在编辑器打开文件并落在该行
- [ ] Aa/W/.* 三开关生效；正则非法时本地拦截不发请求；默认全关 = 旧的大小写不敏感字面量
- [ ] include/exclude chips 增删、去重、分类语义与旧面板一致（目录子树/单文件/glob）
- [ ] explorerExclude 偏好仍叠加在结果上（与文件树、文件名搜索一致）
- [ ] 截断提示诚实：全局截断出底部提示；文件级截断在命中数旁出「已截断」标记；空 query 不发请求

历史
- [ ] 提交后历史新增；相同 query+include+exclude 去重置顶；上限 20；单删生效
- [ ] 点击历史回填三项且不自动执行；开关保持当前值；第二个浏览器 tab 打开时历史同步

文件页迁移
- [ ] 文件页不再有「文本内容搜索」入口/面板/结果分支；文件名搜索行为与迁移前逐字一致
- [ ] 右键「添加到搜索中 → 添加到包含/排除」铸新搜索 tab 并预填 chip（cwd 相对形状；越界路径绝对值透传），不自动搜索

状态与持久化
- [ ] meta 恢复：重载后 query/开关/chips/标题还原，query 非空自动重跑
- [ ] 加载/无结果/错误/无 cwd 四态文案正确；chips/开关变化在结果已展示时自动重跑

i18n 与工程门禁
- [ ] zh/en 新键齐全；19 个语言包键集仍与 zh 相等（locales.spec 绿）；废弃键无残留引用
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿；无新增硬编码颜色（theme.spec 绿）

## 8. 建议单测

| 文件 | 用例 |
|---|---|
| `tests/search-blocks.spec.ts`（新） | 合并算法：窗口重叠/相接/相距 1/不相接；同 line 多命中；块首尾行号；文件首尾上下文截短 |
| `tests/search-history.spec.ts`（新） | 去重键、最新在前、上限 20 丢尾、单删、坏 JSON/隐私模式降级、`storage` 事件同步 |
| `tests/fs-content-search.spec.ts`（改写） | rg `--json` 假事件流解析；命中区间重推导（字面量/大小写/全词/正则各一组）；context ≤2；预算四件套与 truncated 诚实；二进制/超 512KiB 跳过；include/exclude 分类与 prefExclude 叠加回归（v1 用例尽量平移）；非法正则 → bad-request；空查询零副作用 |
| `tests/search-engines.spec.ts`（补） | `--json` 下按 match 事件计数的哨兵（kill 时机、truncated 标志） |
| `tests/builtins.spec.ts`（改） | 内置 8→9；`search` 描述符形状：order 15、无 dedupeKey/single、非 bottomOnly、createTab 铸唯一 id、meta 默认值；标题/描述互异既有断言自动覆盖新键 |
| `tests/native-registration.spec.ts`（补同形用例） | `search` 注册出 native 类型 + guide 行（order 15）；事件日志口径照抄该 spec「bottomOnly」块（353-392 行）的既有写法 |
| `tests/start-links.spec.tsx`（改） | 7→8 胶囊与顺序数组；点「搜索」以 `type: 'search'` 调 openTab |
| `tests/file-tree-content-search.spec.tsx`（删/改） | 删除旧断言；可留一条负面断言（TreePanel 不再渲染 `data-dsh-content-search-*`） |
| `tests/file-tree-add-to-search.spec.tsx`（改写） | 新语义：菜单仍在；点击后种子被消费、`openTab({type:'search'})` 收到调用、新 tab meta 预填 chip；TreePanel 不再持有 chips |
| `tests/smoke.spec.ts`（补路由断言，如该 spec 惯例覆盖） | `fs.contentSearch` v2 响应形状一行断言 |

## 9. 明确不做 / 已知边界

1. **不做替换（Replace）**；不做「在文件中替换」的任何前置 UI。
2. **不做左右分栏预览**（用户已定）：以「查看」跳编辑器替代，预览即编辑器本身。
3. **结果不持久化**：重载靠 meta 自动重跑；折叠状态/滚动位置一并放弃。
4. **rg 正则方言与 JS RegExp 不完全同构**：v1 只承诺常见语法；host 以 JS 匹配器对行文本
   重推导兜底正确性（rg 召回多出的行若 JS 匹配器不认会被丢弃，rg 漏召回的方言差异
   不补），文档口径如实地写在实现注释里。
5. **minified 超大文件**：命中按预算截断（512 KiB 以上根本不读、单文件命中超上限即截），
   不做长行特殊处理。
6. **全词边界是 ASCII 语义**（`\b` 等价），Unicode 词边界不做。
7. **结果区不引入虚拟化**：最坏规模受预算约束（约 200 文件 × 每文件 100 命中 × ≤5 行/块），
   与文件树「不引入虚拟化」的既有决策（docs/plans/2026-10-13 §4.1）同一口径；实测卡顿
   再议，不在本轮。
8. 搜索根仍是会话 cwd + include 可越界的 v1 现状；不做跨工作区/任意根选择器。

## 10. 附：与调度方决策的核对记录（实现前必读）

- 「文件=10、变动=20」核实一致：`tabs.tsx` 中 `editor` order 10（标题「文件」）、
  `git` order 20（标题「变动」）；描述符 id 用实际值 `editor`/`git`，新类型 id `search`。
- **i18n「新键可暂缺」只在运行时成立**：`tests/locales.spec.ts:109/112-118` 把
  en 与 19 个懒加载包的键集相等钉死了，新键必须同步 19 包，否则测试红（§6.3 表）。
- **两处计数断言会被打破**：`tests/builtins.spec.ts:41-45`（8 个内置 id）需改 9；
  `tests/start-links.spec.tsx:107-118`（7 个胶囊与顺序）需改 8。
- localStorage 键 `dsh-sidebar:search-history:v1` 与仓库既有键族
  （`dsh-sidebar:v1:task-firstseen`、`dsh-sidebar:v1:redaction`、`dsh-sidebar:settings-tab`）
  同族，按给定值使用。
- rg 哨兵口径需随 `--json` 重定义（§5.3），否则 truncated 失真——这是对「预算与
  truncated 语义保持诚实」的落地说明，不是改决策。
- `openTab` 对 createTab 描述符忽略 seed 的 title/path/id、seed.meta 是整体替换
  （`service.ts:722-727、1231、1254`），故右键重定向用一次性种子（§3.3）。
- **host v2 半边已在工作区实现（撰写本文时未提交）**：`src/content-search-types.ts`
  （wire 类型）、`src/fs-content-search.ts`（`createLineMatcher`/`resolveMatchOptions`/
  `contentRgArgv --json -C 2`/`MAX_HITS_PER_FILE = 100`/`MAX_TOTAL_HITS = 2000`）、
  `src/client/api.ts`（`match` 参数）、`src/index.ts` 路由。与调度方决策一致；两处细节
  以实现为准：每文件命中上限取 **100**、`count` 为**真实命中总数**（预算只截装载）。
  本文对 `fs-content-search.ts` / `api.ts` / `index.ts` 的一律给符号名不给行号——这几个
  文件正被并行修改，行号锚点会漂移；未涉及的文件（TreePanel/FileTree/service/state/
  start-links/native 等）行号以撰写时快照为准。
- 客户端页面（`SearchView`、块合并、历史、种子、描述符、i18n、文件页迁移）与两处 spec
  计数断言仍未实现，是本文档的主体工作面。
