# 侧边对话「历史对话」弹窗：全局未读分组（跨工作区）

日期：2026-10-21　分支：`main`（直接提交）

## 1. 背景

「侧边对话」右上角的「历史对话」弹窗此前只列**当前父会话**下的线程（`sideThreadRows` 按 `parentId === scope.sessionId` 过滤）。侧边对话的线程本体是跨工作区持久化的子会话，客户端会话列表 `ctx.sessions.list.getSnapshot().byId` 推送的本来就是**所有工作区**的全会话——用户在 A 工作区发起的追问，跑到 B 工作区时既看不到「还有没读的回答」，也没有入口跳回去。历史按钮因此是纯功能钮，没有任何"有事发生"的信号。

## 2. 目标

1. 弹窗分两组：**「全局未读」**（跨工作区、所有会话的未读侧边对话线程；无未读时整组不渲染）→ **「本会话」**（现有列表）；空态文案只在两组都空时出现。
2. 全局未读行必须回答三个问题：**哪条线程**（标题，去 `Side: ` 前缀）、**在哪个工作区**（父会话 cwd 的 basename）、**属于哪个父会话**（父会话标题）；点击即跳转到对应会话并打开该线程，同时标记已读。
3. 历史按钮加未读数徽标（>9 显示 `9+`），不开弹窗也能看到信号。

## 3. 方案

### 3.1 纯投影（src/sidechat-core.ts，framework-free，node 可测）

`globalSideThreadRows(byId, { archivedIds?, excludeIds? })` 是 `sideThreadRows` 的"全局版"：不按 `parentId` 过滤，遍历整个 `byId`，筛 `origin === 'subagent' && displayTitle.startsWith('Side: ')`。行结构 `GlobalSideThreadRow` 携带跳转所需的一切：`parentId / parentTitle / workspaceName / lastActivityAt`。父会话缺失（不在 `byId`）的行**保留**（线程本身存在），父字段为 `undefined`，由 UI 决定渲染成禁用态。排序按 `lastActivityAt` 降序，0 值排最后，稳定排序。

工作区名 = 父 cwd 的最后一个 `/` 或 `\` 之后段（宿主可能给 Windows 路径）；尾分隔符/空 cwd 得不到非空段 → `workspaceName` 为 `undefined`，UI 省略该段。

### 3.2 已读水位存储（新文件 src/client/sidechat-unread.ts）

- localStorage key `dsh-sidebar:sidechat-read:v1`（命名对齐 state.ts 的 `dsh-sidebar:v1`），值 `{ [threadId]: epochMs }`。
- **水位语义**：`sidechatReadAt(id)` 返回该线程"最后一次被读者拿着"的时刻（tab 挂载、或任何一次转录拉取成功）；未读过返回 0。未读判定由调用方做：`最后活动 > sidechatReadAt(id)`。时间戳级、刻意不做 seq 级——会话列表没有 per-thread seq 游标，且 mark 写 `Date.now() + 1` 规避同毫秒相等边界。
- **memory 为准、storage 落盘**：存储只在首次快照（页面加载）读一次，之后每次 mark 写穿。写失败（隐私模式/配额）只丢跨刷新持久性，本页内存水位仍有效；损坏 JSON / 非 JSON 对象一律静默按"无水位"读，绝不把异常抛进渲染路径。
- `subscribe + getSnapshot`（稳定箭头属性，`getSnapshot` 返回稳定引用）直接喂 `useSyncExternalStore`；mark 时前向比较（旧水位 ≥ 新值直接 no-op），避免每次转录轮询的白写与白通知。

### 3.3 未读判定（SideChatView.tsx）

每线程「最后活动」= 会话行 `updatedAt`（0/缺失退化 0）→ 为 0 时由调用方回退**各自父会话**的投影 `projectionsBySession[parentId].values.subagentCatalog` 里该线程的 `createdAt`（参考既有 `threadCreatedAt` 的读法）；两个来源都没有 = 0 = 永不未读（伪造"刚刚"比沉默更糟）。`useMemo` 从 `byId + archivedIds + excludeIds` 计算候选行，排除当前 tab 绑定线程与浮窗中的线程（`sidechatWindows`，浮窗 = 正在看 = 已读），再与 `sidechatReads` 快照比对得未读行；mark 落地会改变快照 → 组即时收敛。

### 3.4 跳转链路（openGlobalUnread）

点击先 `markSidechatThreadRead(row.id)`，然后：

- `row.parentId === scope.sessionId`：走既有 `reopenThread`（park + `openTab({type:'sidechat'}, scope)` + 去重）。
- 跨会话：`parkSidechatReopen(row.id)` → `openTab({ type: 'sidechat' }, { sessionId: parentId, cwd: parentCwd? })`（**以父会话为 scope**，tab 座位落在它所属的会话里）→ 复用 history-jump.ts 的 `openHistorySession(ctx, parentId)` 切主视图 → 收起弹窗。
- 父会话不在 `byId` 的行：渲染为 `disabled`，点击不 park、不跳转。

### 3.5 markRead 时机

挂载且 `threadId` 有值时 mark 一次（`useEffect [threadId]`，浮窗复用同组件自动覆盖）；此后每次 `fetchThread` 成功（push 去抖拉取、轮询、重连补拉都汇于此处）再 mark——mark 是同步 localStorage 写，只放在这个异步成功路径，绝不进渲染。

## 4. 数据与判定

| 数据 | 来源 | 缺失时 |
|---|---|---|
| `updatedAt` | 宿主 projectList（0.2.0-rc.2+）；context-types.ts 新增可选字段镜像 | catalog 兜底行写 0 → 回退父投影 createdAt → 再无则 0 |
| 未读 | `最后活动 > sidechatReadAt(id)` 且非绑定线程、非浮窗线程、未归档 | 水位 0 = 一切有活动的都未读 |
| 徽标 | `globalUnreadRows.length` | 0 时徽标不渲染；>9 显示 `9+` |

## 5. 边界

- **同毫秒竞态**：mark 写 `Date.now() + 1`，同一毫秒落地的消息仍计为已读；更细的追平交给下一次拉取成功后的 mark。
- **跨页签**：水位存储为 memory-为准、每页写穿，另一页签的 mark 不实时同步到本页（本需求范围外；同一页内浮窗/多 tab 共享同一模块单例）。
- **归档**：归档线程整行不进全局组（与既有 threads 过滤一致）；父会话被归档不影响行本身（按线程 id 过滤，需求如此）。
- **占位线程**：`Side: New thread` 占位行 `threadDisplayTitle` 本地化为「新对话」；宿主不给 updatedAt 的老宿主上无日期行排组尾且不可判未读。
- **无 workspaces 服务的宿主**：`useArchivedSessionIds` 读到"无归档"，全局组照常工作。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `src/context-types.ts` | `SidebarSessionSummary` 新增 `updatedAt?: number`（唯一改动） |
| `src/sidechat-core.ts` | 新增 `GlobalSideThreadRow` + `globalSideThreadRows` + 工作区 basename 助手 |
| `src/client/sidechat-unread.ts` | 新增：已读水位 store（mark/sidechatReadAt/sidechatReadStore） |
| `src/client/SideChatView.tsx` | 全局未读分组、徽标、openGlobalUnread 跳转、两处 markRead 时机 |
| `src/client/SideChatView.module.css` | 组头/计数 chip/未读圆点/徽标/全局行禁用态 |
| `src/client/locales.ts` | zh/en 各加 `sideChatGlobalUnread`、`sideChatCurrentSession`（其余 locale 走回退） |
| `tests/sidechat-unread.spec.ts` | 新增：投影（识别/排序/过滤/父缺失/工作区段）+ store（落盘、前向、静默降级、注入与真实 storage） |
| `tests/sidechat-view.spec.tsx` | 既有历史列表用例打水位适配 + 新增全局未读分组 4 用例 |
| `docs/plans/2026-10-21-sidechat-global-unread-design.md` | 本文档 |

## 7. 测试与门禁

- `pnpm exec vitest run tests/sidechat-unread.spec.ts tests/sidechat-core.spec.ts tests/sidechat-view.spec.tsx` → 85 用例全绿。
- `pnpm lint` → 干净。`pnpm typecheck`：**本需求涉及的全部文件 0 错误**；仓库现存错误全部位于「文件内容搜索」相关文件（`tests/file-tree-content-search.spec.tsx`、`tests/fs-content-search.spec.ts` 等），已用 `git archive HEAD` 在仓库外对 HEAD 快照复跑 tsc 证实**先于本次改动存在**，且同工作区另有并行的 find-in-files 在途改动（SearchView.tsx 等），均不属本需求范围、未触碰。
- 未跑（按约束禁止）：`pnpm build` / vite / dev / e2e。安装由调用方负责（/app/cache/my/github/DSH-better-sidebar）。
