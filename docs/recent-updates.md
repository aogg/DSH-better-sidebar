# 🆕 最近更新

本插件的逐版本更新说明，自 [`README.md`](../README.md) 的「最近更新」节迁出，按版本倒序排列。当前支持的 DSH 版本见 README 顶部 badge，完整发布历史见 [CHANGELOG](../CHANGELOG.md) 与 [GitHub Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)。英文版：[recent-updates-en.md](./recent-updates-en.md)。

---

### v0.26.0

> 🚀 **四件大事**：① **传输全面流式化**——上传 / 下载 / HTML 预览 / 打包都不再有大小上限（三个部署限额键 `readLimit` / `mediaLimit` / `uploadLimit` 随之删除），编辑器保存也拆掉了 1 MiB 的请求体墙；② **超大文件从「截断成半份文档」改为只读分页预览**（滚到底自动续读 + 「加载全部」，到 5 万行提示改用下载），并新增第 4 个内置 viewer **`.jsonl` / `.ndjson`**（逐条可折叠卡片 + 可保存编辑）；③ **侧边对话补齐到接近原生**——实时推送（纯失效帧 + 增量重拉）、排队可见与按 id 撤回、per-thread 模型选择；④ **任务管理面板整批重构**（按组展开、Token 用量与耗时、画布动效与错峰入场）。另有底部工作台**多终端 Tab**、编辑器**引用行号**的四处收尾、文件改名 / 删除**同时作用于原生右栏页签**（修掉「改名后保存把旧文件重建」「删掉的文件被保存复活」这类数据面问题）、三处静默数据问题等，逐条见 [CHANGELOG](../CHANGELOG.md#v0260)。

> ⚡ **性能**：修掉一个会让界面发卡的 git 状态轮询——编辑器打开文件后**不再长期持有轮询**（此前每 2.5 s 跑一次 `git status --untracked-files=all` 加两条全仓库 `--numstat`，在未忽略的大目录上实测 59,631 条 / 9.24 MB / 0.13 s 一次），基线改为 **30 s** 并按实测自动退档（60 s / 180 s / 停止自动轮询），**空闲轮询也不再触发重渲染**；文件树的折叠链预加载与逐子目录探测两处放大一并收敛。

### v0.25.0

> 📦 **支持线前移：仅适配 DSH `0.2.0-rc.2+`**（peer 下限 `^0.2.0-rc.2`，CI 与挂载 lane 钉 `@deepseek-ai/dsh@0.2.0-rc.2`）。DSH 的 npm `latest` 现在正是 **0.2.0-rc.2**，本版就钉在它上面；**0.2.0-rc.1 及更早（含 0.1.7 线）请固定 v0.24.1**——`^0.2.0-rc.2` 对 rc.1 判定为 false，会被宿主的启动兼容性预检整行静默禁用。本次前移是一次**纯声明与钉版变更**：0.2.0-rc.2 对本插件消费的宿主面仍是纯增量，运行时零改动。
>
> 🙏 本版包含多位贡献者的工作（按合并先后列在 [CHANGELOG](../CHANGELOG.md#v0250) 里）。

### v0.24.1

> 🐞 **修复版**：修掉两处会让文件树「一操作就整体刷新」的缺陷——① 原生承载面在**每次会话状态写入**时都会重建 `files` 接管项的 slot 注册，宿主因此换掉 slot entry、把整个 tab body 卸载重挂（展开/收起、切 tab、拖底部工作台都会触发）→ 文件树丢失层缓存、滚动位置与目录 watcher 并重列整棵可见树；② 目录实时刷新的重列**先把该层缓存删掉**再请求，导致行被「Loading…」占位替换后重建（构建/格式化/模型跑 bash 时整层闪空）。现在展开只请求被展开那一层、tab body 不再重建、变更只增量更新行。

### v0.23.0

> 🧭 **开发线版本（从未发布到 npm，内容随 v0.24.1 一并发布）**：文件页与文件变动页的整体 UI/UX 重构。文件页新增 **Ctrl/Cmd 与 Shift 多选**、批量条、**Git 变更着色**、**新建文件夹**、拖拽上传重做，**多选可右键「压缩并下载」**（宿主侧带进度的打包任务）；「打开方式」改为宿主本机关联应用与插件自研目标**双源并存**（可用设置 `openWithPluginTargets` 强制并存），右键菜单收敛层级；文件变动页**重构为层级树**（Git 视角 + Agent 视角，目录可暂存）。性能：`fs.tree` 实测 **22.8ms → 3.8ms**（10k 条目），新增批量路由 `fs.trees`（挂载/刷新从 N+1 请求变 1 个），菜单打开不再重列目录。⚠️ **行为变更（安全相关）**：**删除工作区路径检测**，插件 fs 路由可读写宿主用户能访问的任意路径（仅受 OS 权限约束）。详见 [CHANGELOG](../CHANGELOG.md#v0230)。

### v0.24.0

> 📦 **支持线前移**：仅适配 DSH **0.2.0-rc.1+**（peer 下限 `^0.2.0-rc.1`，CI 钉 `@deepseek-ai/dsh@0.2.0-rc.1`）。**0.1.7 线（含 npm `latest` 的 0.1.7-rc.2）请固定 v0.22.1（0.1.7 线最后发布的版本）**：caret 范围跨 minor 不成立，`^0.1.7-rc.1` 在 0.2.0 宿主上会被启动兼容性预检整行禁用（实测 `semver.satisfies('0.2.0-rc.1','^0.1.7-rc.1',{includePrerelease:true}) === false`）。

- 📦 **基线整体抬到 `0.2.0-rc.1`**：14 条 DSH peer 与 27 个 `@deepseek-ai/*` devDependencies 同步；`dsh.plugin.json` 的 `engines.dsh` 随之前移。
- 🔍 **实测确认是纯增量**：本插件用到的 19 个宿主包里**零个值导出被删除**；类型面只有 `ui-primitives`（`DisclosureRow` / `TextShimmer` / `Tooltip` 新增可选 prop、overlay 顶部内距）、`dsh-session`（新增 `ToolCallRecovery`）与 `dsh-api-remotes`（新增 product-analytics remote）变化；会话格式仍 v4、`SUBAGENT_DESCRIPTOR_VERSION` 仍 3、`dsh/lib/bin.js` 与 `dsh-client-modules` 运行时逐字未变。因此**没有为 0.1.7 保留任何兼容分支**。
- 🧪 **挂载 lane 与 CI 钉版同步到 `0.2.0-rc.1`**；`tests/market-manifest.spec.ts` 的 peer 形状规则改为钉当前基线 tuple，并记下「caret 跨 minor 必失效」这条教训。
- ⚠️ **生态连带**：`@huanlin/dsh-plugin-better-locale`（可选集成，非本插件依赖面）的 peer 钉在 `^0.1.x` 线上，在 0.2.0 上无法加载，其 5 条 unmet peer 是本次 `pnpm peers check` 唯一残留（上游未适配，与本插件的 14 条 peer 无关）。
**支持的 DSH 版本**：<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="支持的 DSH 版本（v0.22.1）：0.1.7-rc.1+" src="https://img.shields.io/badge/DSH-0.1.7--rc.1%2B-4d6bfe" /></a> · 完整发布历史见 [Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)

### v0.22.1

> 📦 **正式版**（npm `latest`）：支持线**不变**——仍仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`），0.21.1 / 0.22.0 的用户直接升级即可。修掉两个**真机可复现、单测却全绿**的缺陷；**DSH 0.1.6-alpha.2 及更早请继续固定 v0.19.1**。

- 🐛 **`files` 接管被孤儿化 → 报错刷屏 + 文件树空态**（社区 #770 / #771，官方桌面壳日志实证）：客户端条目替换（插件市场更新 / Plugins 页禁用→启用 / HMR 重打）时，`sync()` 的清理循环会把**不属于描述符**的 `files` 接管释放掉、又在同一轮里重建——而重建发生在**已经 inactive** 的插件上下文上：`tabs.register` 建在宿主上下文上照样取走了 id，紧随的 `ctx.slots.inject` 却抛 `cannot create effect on inactive context`，于是 disposer 丢失、该 id 在**整个页面生命周期内不可再注册**（表现就是 `native register files error: … already registered` 刷屏 + 文件树落到宿主空态，只有刷新页面才恢复）。现在清理循环**跳过 `FILES_KIND`**（接管的寿命只由编辑器类型开关与 seat disposer 决定），并且**任何在宿主取走 id 之后失败的注册都会回滚释放**（含已建好的槽位），失败只留一个「下次通知可重试」的状态。修复取自社区 PR #777（@yanzhaohui1999）。
- 🖥️ **macOS 桌面版窗口拖拽 / 双击标题栏缩放失效**（#772）：插件宿主是直挂 `body` 的子元素，宿主的 `html[data-platform=darwin] body > :not(#root) { -webkit-app-region: no-drag }` 命中它，而 app-region **无视 `pointer-events`**——铺满视口的面板层把下面每条拖拽带一起抵消（拖第一次还行、之后全失效）。现在 `[data-dsh-better-sidebar]` / `[data-dsh-panel-host]` / 放大视图 `.mermaidModal` 都用中性值 `initial !important` 退出计算，层内的面板与控件保持 `no-drag`（点击不被吞）；合并社区 PR #773 并补齐放大视图这最后一个铺满视口的 body 直挂层。
- ✅ **守住它们**：新增单元用例把「接管不得被通知拆建」「注册失败必须回滚已占用 id 与已建槽位」钉在注册表**事件日志**上（未修复代码上 4/4 红），并新增**部署级回归门** `tests/e2e/native-reload.e2e.ts`（在 npm 0.22.0 上连续 3 次运行全红、修复版连续 3 次全绿（1 个用例重复跑三次））；拖拽契约由单元用例 + 挂载 lane 的**真实级联探针**（按宿主规则读计算值）守护。验证：`pnpm test` 122 files / 1293 passed / 9 skipped，`pnpm test:mount` 与 `test:mount:aggregate` 绿。事故记录见 [docs/plans/2026-09-28-native-files-takeover-reload-leak.md](./plans/2026-09-28-native-files-takeover-reload-leak.md)。

### v0.22.0

> 📦 **正式版**（npm `latest`）：支持线**不变**——仍仅支持 **DSH 0.1.7-rc.1+**（peer 下限 `^0.1.7-rc.1`，CI 钉 `@deepseek-ai/dsh@0.1.7-rc.1`），0.21.1 的用户直接升级即可。**DSH 0.1.6-alpha.2 及更早请继续固定 v0.19.1**。

- 🧩 **任务管理页重做成工作流图**（主显示模式）：会话树渲染为分层节点 + 贝塞尔连线——拖拽平移、滚轮缩放到光标、内容包围盒居中适配、右下角控制条（图/树切换 + 折叠开关 + 缩放 + 适配）；**经典缩进树保留**（键盘可导航），两种模式共享同一个视图模型，折叠状态与团队富化不会视觉漂移。
- 🃏 **双段式节点卡**：上段是类型徽章（主代理 / 子代理 / 成员 / 工作流 / 已完成聚合）+ 相位徽标 + **模式 chip**（一次性 / 可持续，与徽标同一行）+ 名称（只有工作流 run 另带一行状态 / 成员元信息）；下段小条是状态点 + **原生状态文本**（**主 Agent 同款合并活动行**：并发工具按类别归并 + 计数 + 在跑那条的细节，措辞取宿主 `chat` 词条——`正在分析请求` / `正在读取文件 · main.ts` / `正在准备读取文件` / `正在运行命令 · npm run build`），运行中与已结算都由它**取代状态词**（不再念两遍「运行中 / 已完成」），`空闲` 与 `出错` 保留状态词、没有活动数据时回退状态词；已完成节点在小条上有折叠按钮；运行中小条从左到右**完整扫过**（`prefers-reduced-motion` 下关闭）。8px 圆角、层级只用上段极淡底色表达、当前会话加粗 accent 描边。
- 🔀 **工作流 run 入图**：从 `tool-workflow/*` 事件折叠出 run（与官方面板同一批），run 挂在发起代理下、成员 agent 重挂到 run 下并按相位分框、同色相位徽标；catalog 里没有的成员用 run 数据合成占位节点，跑完的 run 仍能看到成员。
- 🗂 **折叠分两组、各自说清是什么**：`✓ N 已完成`（含出错，失败单独报 `出错 N`）与 `N 个待命`（跑完一轮、随时可被叫起来的 teammate）是**两行**；手动折叠按钮永远有效，自动聚合只在待命成员 ≥3 时收空闲成员；聚合卡名字行写「前两个名字 + `+N`」、徽标写**真实计数**（`✓ N 已完成` / `N 个待命`），小条是动作行（图标 + 「展开」+ 出错尾注 + 展开箭头）；**点聚合只展开该组**（兄弟组与页级折叠都不动），页级展开/折叠仍在右下控制条，且那里收起时会把按组展开一并清掉。
- 🪟 **两个常驻浮动窗**（抽出可复用的 `FloatingWindow`）：后台任务输出与共享任务详情/编辑——可拖拽、可四边拉伸、内容区自滚动，只靠关闭按钮或 Escape 结束（外部点击 / 失焦 / 锚点离屏都不关）；任务窗把余量交给描述区，拉大是给内容更多空间而不是留白，动作行固定在底部。
- 👥 **Agent Teams 任务板（实验层）**：成员富化到对应节点、常驻任务条列出成员与共享任务；状态机跟随宿主（待办 → 认领 → 进行中 → 完成 → 重开）+ 改派 / 编辑 / 两击删除，CAS 过期修订单独提示；成员活动由 `subagents.live` 的 running 叠加。
- 🔄 **后台任务改读宿主客户端 `ctx.jobs`**（推送 roster + 非消费输出流 + kill）：删掉自建的 `jobs.list` / `jobs.output` / `jobs.kill` 三条路由与事件回放镜像，彻底不碰模型 `job_output` 游标；输出在常驻浮动窗里流式显示并尾随，代理数 ≥8 时抽屉自动折叠。
- 🛠 **DSH 0.1.7 数据面重写**：上游删掉了 `agentTeams.remoteView` 三个 Remote 方法 → 团队改为读 Lead Session 的 **`agentTeam` Session projection**（推送式，删掉 `teams.view` 路由与 5 秒轮询）；写路径两条路由保留，拒绝从「返回联合」变为「抛 `TeamError`」，过期修订映射 409 `team-conflict`。**修掉的真实故障**：0.1.7 上团队条从来不渲染（路由报 `remoteView is not a function`，页面静默无提示）。
- 🐛 **真机抓到、单测全绿的四个缺陷**：逐节点折叠按钮点了没反应（被自动折叠的守卫卡住）；「待命」卡片从不画折叠按钮；认领后标签错显「阻塞」；队列任务上「完成」必失败（需先认领）。
- 🎨 **窄屏与手机设置**：按原生右侧栏窄宽重新定档卡片与行距；设置页新增**手机**分组——窄屏（≤768px）不自动弹出新任务页、任务页默认树状图。

> 📜 **更早版本**：完整发布历史见 [CHANGELOG.md](../CHANGELOG.md)（v0.21.1 → v0.12.3）与 [GitHub Releases](https://github.com/omdsh-dev/DSH-better-sidebar/releases)。
