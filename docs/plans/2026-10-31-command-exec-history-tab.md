# 「命令」页新增「执行历史」tab（已实现）

- 日期：2026-10-31
- 状态：**已实现**（实现 + 测试 + 文档 + 提交；构建与部署由下一段负责）
- 需求：把本次会话（当前 sessionId 的会话日志）里执行过的命令类工具调用收集成列表，每条尽量带执行结果文本、执行时所在目录（workdir）、环境变量（仅当调用参数带 env——宿主日志不逐条记录 env，没有就明示「未记录」），并支持一键「再次运行」。

## 数据源

- 会话事件日志（宿主信封 `{type,seq,time,data}`）：
  - `tool/call` 且 `activityOf(name) === 'commands'`（复用 src/process-activity.ts：bash/pwsh/exec_command/write_stdin 与 `terminal_*` 前缀；`*_inspect` 后缀不算）；
  - `tool/result` 按 callId 配对（复用导出的 `resultCallId`：0.1.7 `data.callId` / `message.toolCallId` 与 0.1.6 `message.source.callId` 两种历史日志形态）；
  - 结果文本复用 sidechat-core.ts 导出的 `toolResultText`（0.1.7 顶层 content blocks 与 0.1.6 `tool-result` 包裹块两种形态，勿复制实现）。
- 每行（`ExecCommandRow`，wire 形状）：命令文本（args 第一个存在的字符串键，command→cmd→input→data→characters，8000 字符截断打标）、workdir、description、timeoutMs、background、env（仅 `args.env` 为对象；≤40 条、单值 200 字符，超限打 `envTruncated`）、结果文本（4000 字符截断打标）、exitCode（认在**完整**结果文本尾部的 `[exit code: N]`，展示截断不影响判定）、status（无结果=running / exit 0 或未知=ok / >0=fail）、durationMs（双方时间都存在且为正）。

## 协议

- 服务端路由 `commands.execHistory`（src/index.ts 路由表，入参 `{sessionId}`）：活会话 `snapshotEvents()` 优先，未水化退 `readPersistedSessionCached` 冷读（changes.ops 单日志路径同款）；两路不可得回 `{ rows: [], truncated: false }` 不报错。折叠纯逻辑在 src/command-history-extract.ts（框架自由，与 prompt-history-extract.ts 同形制），默认 limit 200，新→旧，超出丢最旧并置 `truncated`。
- 客户端 `api.commandsExecHistory(sessionId)`；视图 src/client/CommandHistoryView.tsx：挂载首拉 + `useSessionOps` 订阅当前 sessionId 的 `ops` 帧（WS 驱动，无任何 setInterval 轮询；in-flight 期间帧合并为一次尾随重拉；断线重连 onReconnect 补拉）。关键字本地筛选（command+description 不分大小写子串）+ 条数徽标 + 手动刷新；行点击展开详情（完整命令可复制、workdir、env chips 或「未记录」提示、结果块）；「▶ 再次运行」走 CommandsPageView 同一套 mint 语义（`parkCmdRun` 紧贴 `openTab({type: CMD_RUN_TAB_TYPE})`，`buildCommandCommandline` 把 workdir 拼成 `cd 'dir' &&`，sourceKey `history:<callId>`），无命令文本或终端能力缺席时禁用。
- CommandsPageView 改页内双 tab（「命令」/「执行历史」，本地 useState 不持久化），「命令」tab 的列表/表单/变量弹窗行为与 data-* 钩子原样不动。

## 测试与验证

- tests/command-history-extract.spec.ts：13 例（正常/exit 2/running、pwsh 与 terminal_* 前缀、非命令类与 `*_inspect` 排除、后台、env 提取与双重上限、三种 callId 配对形态、坏 JSON、键优先序、截断上限与退出码、limit 排序、duration 给法）。
- tests/command-history-view.spec.tsx：8 例（首拉渲染、筛选、展开详情、无服务禁用、park+openTab 契约、ops 帧/重连补拉、失败降级、页内双 tab 切换）。
- `pnpm vitest run` 全量 + `pnpm typecheck` + `pnpm lint` 全绿（本机既有失败基线见提交说明）。

## 部署

- 不重启 dsh 不生效不了服务端：改完需重启 dsh 后安装 `/app/cache/my/github/DSH-better-sidebar/`（构建产物由下一段负责，本段禁止任何 build）。客户端资源随 bundle 路由下发，无需浏览器强刷。
