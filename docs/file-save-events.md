# 文件保存事件（v0.27.0+）

面向消费插件开发者。内置编辑器「保存一个文件」成功之后，你的插件可以参与这个时机：挂自己的回调，或者只是订阅到这次保存。两个暴露面，一个事实来源：**写入成功**。

## 解决什么问题

此前要知道「编辑器刚保存了文件」，只能轮询 mtime，或者订阅宿主 session 事件——后者是模型用工具改文件的通道，见下文「边界」。现在保存成功本身就是一个可订阅的事实：client 侧走服务方法，host 侧走 cordis 事件总线。失败与 fs-conflict 拒绝不是保存，没有事件。

## client 面：`ctx.betterSidebar.onFileSaved(...)`

浏览器侧。注入 `'betterSidebar'` 后订阅，返回 disposer：

```ts
import type {} from 'dsh-better-sidebar'   // 触发类型合并（见 external-plugin-guide.md §2）

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  if (!ctx.betterSidebar.features.includes('fileSaveEvents')) return  // 0.27.0 之前的 host 上没有 onFileSaved
  // ctx.effect 包裹：插件卸载 / HMR 时自动退订，不包会泄漏
  ctx.effect(
    ctx.betterSidebar.onFileSaved((event) => {
      console.log('saved', event.path, event.bytes, 'bytes at', event.savedAt)
    }),
    'my-plugin: file-saved',
  )
}
```

- 老 host 兼容：先看 `ctx.betterSidebar.features` 是否含 `'fileSaveEvents'`（v0.27.0 起恒在），再订阅——上例与 §「本插件未安装 / 版本过旧时会怎样」都是这个顺序。
- 投递是**快照式**的：回调执行过程中新注册的 listener 从下一个事件开始收。
- 单个 listener 抛错被吞掉（`console.error`），不影响保存本身、不影响其他 listener、不影响发射方。

### `SidebarFileSavedEvent` 字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `path` | `string` | 保存时的路径**原样**（不归一化、不拼 cwd；绝对、相对、两种分隔符都可能出现） |
| `sessionId` | `string` | 保存所属会话 |
| `bytes` | `number` | 保存内容的 UTF-8 字节数。是**交给宿主的内容**长度；落盘字节可能因宿主的编码 / 行尾还原而不同 |
| `savedAt` | `number` | 写入成功确认时刻（epoch ms） |
| `source` | `'editor'` | 发射方标识。`'editor'` 是内置文本编辑器；字段为后续复用同一发射器的 viewer 预留 |

类型导入：`import type { SidebarFileSavedEvent } from 'dsh-better-sidebar/client/service'`（包根 `dsh-better-sidebar` 也 re-export）。

## host 面：`ctx.on('better-sidebar/file-saved', ...)`

Node 侧。任何 host 插件都能订阅这个 cordis 字符串事件，不需要 inject 本插件：

```ts
export function apply(ctx: Context): void {
  const dispose = ctx.on('better-sidebar/file-saved', (payload) => {
    console.log('saved', payload.path, payload.size, 'bytes in', payload.cwd)
  })
  ctx.effect(() => dispose, 'my-plugin: file-saved')
}
```

- 广播点是 `/sidebar/write` 路由，`writeWorkspaceText` 成功、响应写回**之后**。内置编辑器的保存走这条路由，所以 host 侧天然覆盖编辑器保存；你的 viewer 如果也走 `api.fsWrite`（即 `/sidebar/write`），订阅方同样能看到。
- cordis `emit` 同步派发、listener 异常会传回调用方；本插件在路由里包了 try/catch，坏 listener 不会把已完成的保存变成错误响应。但也别在 listener 里做重活——它在保存路径上同步执行。

### payload 字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `sessionId` | `string` | 会话 id（请求参数） |
| `cwd` | `string` | 该路由解析出的会话根（activeWorktreeRoot，可能是 linked worktree，不一定是请求携带的 cwd 拼写） |
| `path` | `string` | 请求里的 path 原样 |
| `size` | `number`（可缺省） | 写入后实测的磁盘字节数；post-write stat 失败时缺省 |
| `mtimeMs` | `number`（可缺省） | 写入后的新 mtime 基线（与 size 同一次 stat；客户端把它用作下一次保存的乐观锁基线） |
| `at` | `number` | 广播时刻（epoch ms） |

## 最小可运行示例

一个 client 插件，监听保存并在保存后把路径写进自己的状态（骨架沿用 external-plugin-guide.md §3）：

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  if (!ctx.betterSidebar.features.includes('fileSaveEvents')) return
  ctx.effect(
    ctx.betterSidebar.onFileSaved(({ path }) => {
      // 例：保存后重读该文件、刷新自绘缓存、计时器归零……
      console.log('[my-plugin] editor saved', path)
    }),
    'my-plugin: file-saved',
  )
}
```

host 半（同一个插件的 Node 侧）订阅同一类事实：

```ts
// my-plugin/src/index.ts
export function apply(ctx: Context): void {
  const dispose = ctx.on('better-sidebar/file-saved', (payload) => {
    // 例：记录保存时间线、触发外部格式化……
    console.log('[my-plugin] /sidebar/write wrote', payload.path)
  })
  ctx.effect(() => dispose, 'my-plugin: file-saved')
}
```

## 本插件未安装 / 版本过旧时会怎样

你的插件按上文写了注册 / 订阅代码，但用户环境里 better-sidebar 缺失或过旧。三种情形行为不同，结论全部来自代码查证（本仓库 vendored `@deepseek-ai/cordis` 4.0.4 + 宿主 client runtime `@deepseek-ai/dsh-cordis-client-runner` 0.2.0-rc.2），位置见本节末尾。

### client 面：better-sidebar 未安装

**会发生什么**：你的插件停在未激活状态，`apply` 不执行，零报错；装载流程照常成功完成，结果里带 `waitingFor: ['betterSidebar']`（runtime 自己的原话：装载应答对 "parked or active" 的包都返回 `ok: true`）。机制：

- 你返回的插件对象带着自己的 `inject` 原样交给 cordis（client runtime 只包一层 `apply`，不剥依赖声明）；cordis Fiber 构造时逐个注入名查实现，`betterSidebar` 无实现 → epoch 置 `INACTIVE` → 走卸载分支。`apply` 永不执行。
- 停等不挂起装载：未激活的 fiber 上 `await()` 立即返回。
- better-sidebar 之后装载并 `ctx.provide('betterSidebar', …)` 时，cordis 会通知所有等这个服务的 fiber：回填实现 → 重新评估 → 你的 `apply` 届时才执行。**先装 better-sidebar 的那次加载里消费插件自动跟上，无需重启、无所谓安装顺序**——`provide` 触发的通知不挑先后，后装的一方总能追上先停等的一方。
- 反向同理：better-sidebar 升级 / 禁用使服务消失，你的插件随之停等，`ctx.effect` 注册的清理照常执行（client runtime 的报错文案原话："The runtime then parks the package if the provider unloads"）。

**该怎么写**：

- 用 `inject = ['betterSidebar']` 声明依赖，把等待交给 cordis，**不要手动判空**：这个 cordis 版本没有可选注入（不存在 `{ required: false }` 或 `'?'` 写法），声明了 inject 的插件 `apply` 只会在服务就绪后运行，`ctx.betterSidebar` 不会以 `undefined` 出现在你的 `apply` 里。
- `import type {} from 'dsh-better-sidebar'` 是纯类型导入，编译时擦除——包未安装也不会有运行时模块解析错误。
- `peerDependenciesMeta` 的 `optional: true` 只是 npm 安装层声明（peer 缺失时 `npm install` 不报错），运行时行为完全由 inject 决定。
- 别在 `apply` 之外碰 `ctx.betterSidebar`：在未激活的 context 上访问注入名，cordis 直接抛 `cannot get required service "betterSidebar" in inactive context`。

### client 面：装了但版本 < 0.27.0

**会发生什么**：服务在、你的插件正常激活，但旧版服务对象上没有 `onFileSaved`——直接调用是 `TypeError: ctx.betterSidebar.onFileSaved is not a function`。

**该怎么写**：先探 feature 再订阅。`features` 能力列表自 v0.12.0 起存在、只增不减，`'fileSaveEvents'` 是 0.27.0 新增：

```ts
if (!ctx.betterSidebar.features.includes('fileSaveEvents')) return
ctx.effect(
  ctx.betterSidebar.onFileSaved((event) => { /* … */ }),
  'my-plugin: file-saved',
)
```

上文两个 client 示例用的就是这个顺序。（比 0.12.0 更老的版本连 `features` 都没有——早于服务化 API 基线，不在兼容范围。）

### host 面：未安装 / 版本过旧

完全免疫。`ctx.on('better-sidebar/file-saved', …)` 订阅的是一个 cordis 字符串事件；better-sidebar 缺失或旧版时没人 emit 它，你的 listener 永不触发、零错误。宿主升级到 0.27.0+ 后广播开始出现，listener 自动开始收，中间不需要任何操作。host 半本来就不需要 inject 本插件（见上文 host 面），所以也没有停等一说。

两个暴露面在这件事上的差异：client 面有激活门槛（inject → 停等 → 服务出现自动激活），host 面没有（订阅总在，只是没事件可收）。

### 查证位置

- 本仓库 `node_modules/@deepseek-ai/cordis/lib/index.js`：1099-1100（Fiber 构造末尾逐注入名 `_checkImpl` + `_refresh`）、1317-1329（`_refresh`：任一注入无实现 → `INACTIVE`）、1330-1344（`_setEpoch` → `_unload`，`apply` 不执行）、832-852（`provide` → `notify` → 回填 → 重载，遍历全部已注册 fiber）、1399-1403（未激活时 `await()` 立即返回）、755-765（`get` 缺服务返回 `undefined`）、688（未激活访问注入名抛错）、1491-1499 与 1058-1061（`Inject.resolve` 把数组条目映射为 `null` 的 intercept 配置；`isNullable(config)` 分支跳过的只是 intercept，与可选注入无关——该版本没有可选注入）。
- 宿主 checkout `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`：596-601 与 620-628（返回插件的 `inject` 原样保留并交给 cordis 装载）、590 与 644-651（`waitingFor` 统计与 "parked or active" 仍 `ok: true` 的装载应答）、331（"The runtime then parks the package if the provider unloads"）。
- 宿主 checkout `node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`：433-461（loader entry 导入模块后经 `registry.plugin` 起 fiber）。宿主运行时自带的 `@deepseek-ai/cordis` 同为 4.0.4，与本仓库 vendored 逐机制一致。

## 边界

- **client 事件只覆盖两类发射**：内置编辑器保存成功，以及主动调用 `emitFileSaved` 的发射方（`src/client/service.ts` 的模块级导出；内置编辑器就是它）。`emitFileSaved` 是 client half 内部的发射器——client half 打包为单文件 bundle，外部插件**无法**把它作为值导入；外部 viewer 想让自己的保存被 client 侧听到，目前没有通道，需要先在插件仓库开 issue。
- **host 事件覆盖所有走 `/sidebar/write` 的写入**；上传（`/sidebar/upload`）、`fs.createFile`、rename、archive 等其他写路径不广播。
- **模型在会话里用工具改文件（write / edit）不走这两条**——那是宿主 session 事件的事。要反应「模型改了文件」，订阅 session 事件流（编辑器预览的 #855 自动刷新走的就是 `changes.ops` 通道），不要依赖保存事件。
- **listener 抛错被吞**（client 侧 `console.error`；host 侧由路由包住）。保存永不因订阅方而失败；反过来，订阅方也不该假设事件与磁盘写之间的时序之外的东西——事件发出时写入已确认。
