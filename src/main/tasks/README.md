# Task 内存队列

目前仅建立基础模块及查询／取消 IPC，提供结果判定、防重复提交和关闭收尾能力，没有接入任何压缩、扫描、Agent、前端按钮或应用退出流程。队列和结果只保留在当前进程内，不写 SQLite，退出后不保留历史或自动恢复。`repository.ts` 继续占位。

## 主进程调用

所有业务入口使用 `service.ts` 导出的 `tasks`，共享一个先进先出的队列；测试或独立场景可自行创建 `TaskManager`。

下面是手动调用示例，不会在应用启动时执行，也不处理文件：

```ts
import { tasks } from './tasks/service' // 从 src/main 下的调用方导入

const batch = tasks.submitBatch(
  [
    {
      title: '计算第一项',
      run: async (signal, reportProgress) => {
        signal.throwIfAborted()
        reportProgress({ message: '正在计算' })
        return { value: 2 + 2 }
      }
    },
    {
      title: '计算第二项',
      run: async (signal) => {
        signal.throwIfAborted()
        return { value: 3 + 3 }
      }
    }
  ],
  { onError: 'continue' }
)

tasks.list(batch.batchId)
tasks.get(batch.taskIds[0])
tasks.cancel(batch.taskIds[0])
tasks.cancelBatch(batch.batchId)
```

`submitBatch(jobs, options)` 同步返回 `{ batchId, taskIds }`，任务在随后开始执行；返回 ID 不表示完成。只有 `run` 被队列调用时才开始业务操作，不要提前创建已在执行的 Promise。不同批次也按提交顺序共用一个队列，每次只运行一项。一次操作的编码、校验、备份由业务函数内部编排，不拆成独立 Task。

提交时必须由业务入口显式选择失败策略，没有默认值：

```ts
tasks.submitBatch(independentJobs, { onError: 'continue' }) // 一项失败，继续同批次其他项
tasks.submitBatch(dependentJobs, { onError: 'stop' }) // 一项失败，跳过同批次剩余项
```

`stop` 将剩余排队项标记为 `skipped`，通过 `skipReason` 说明原因；已成功、已失败或已取消的结果保留，其他批次继续运行。顺序执行本身不代表存在依赖，Task 不推断任务之间的业务关系。

主进程通过 `tasks.subscribe(listener)` 接收变更通知，返回解除订阅函数；通知后使用 `list`／`get` 获取快照。快照和执行结果通过 structured clone 隔离，`run` 应返回可跨 IPC 传输的普通数据，不返回函数或进程句柄。

## 业务结果判定

普通返回值表示成功，普通异常表示失败。Task 不解析 Service 自己的 `status` 字段，也不把 `no-savings` 自动解释成失败。由业务入口判断目标是否完成；如果压缩完成但备份失败等情况需要让任务失败，可抛出 `TaskFailure` 并保留已有结果：

```ts
import { TaskFailure, TaskCancelled } from './tasks/service'

// 以下语句分别放在 run 内对应的业务分支；result 是 Service 的实际返回值。
throw new TaskFailure('压缩已完成，但原件备份失败。', result)
throw new TaskCancelled('处理已取消，已完成的结果保留。', result)
```

`TaskFailure` 使状态变为 `failed`，保存 `error` 与 `result`，并应用批次的 `onError` 策略。即使同时收到取消请求，显式业务失败仍标记失败，不掩盖真正的问题。

`TaskCancelled` 使状态变为 `cancelled`，保存 `cancellationReason` 与 `result`，无需先触发 AbortSignal。它不触发失败策略；需要中止整批时使用 `cancelBatch`。两种异常在构造时复制结果，结果必须可通过 structured clone 传输。

## 防止重复提交

业务入口可以为任务提供可选的 `key`：

```ts
const batch = tasks.submitBatch(
  [{ title: '计算示例', key: 'calculate:example', run: async () => ({ value: 4 }) }],
  { onError: 'continue' }
)
```

同一个 TaskManager 中，排队／运行中的同键任务会拒绝新批次，抛出 `DuplicateTaskError`；异常包含 `key`，如果重复项来自现有任务，还包含可用于查询的 `taskId`。一个批次内部的重复 key 也会被拒绝；提交先完整校验，失败时不会创建一部分任务。

同键任务结束后允许重新提交。排队取消立即释放 key；运行中的任务在取消收尾结束前继续占用 key。未提供 key 的任务不做防重。key 按完整字符串匹配，由业务定义操作身份、规范化文件路径并决定参数是否属于身份，Task 不自行扫描或解析文件路径。该能力防止重复执行，前端提交中的禁用状态仍需在未来接线时设置。

## 前端可用接口

```ts
const api = window.api
if (api) {
  const refresh = async () => console.log(await api.tasks.list())
  const unsubscribe = api.tasks.onChanged(() => {
    void refresh()
  })
  await refresh() // 先订阅再查询，补齐已有状态
  // 组件卸载时调用 unsubscribe()
}
```

前端还可调用 `api.tasks.get(id)`、`cancel(id)` 和 `cancelBatch(batchId)`。不存在的 ID 查询返回 `undefined`，取消返回 `false`；批次取消返回本次新接受的取消请求数量。非法格式的 ID 会被 IPC 拒绝。

没有通用“提交执行函数”的 IPC。将来由图片等业务 IPC 校验请求、完成授权和输出位置选择，再构造 `TaskJob` 并调用 `submitBatch`。UI 和 Agent 通过同一业务入口提交，避免绕过业务规则。当前所有已注册应用窗口共用任务视图与取消能力。

## 状态、进度和取消

- 状态：`queued → running → succeeded / failed / cancelled`；排队项可直接变为 `cancelled`。
- `onError: 'stop'` 的批次发生失败时，剩余排队项从 `queued` 变为 `skipped`，不调用执行函数。
- 进度：业务函数通过第二个参数上报 `{ percent?, message? }`；百分比必须为 0–100，不提供时仅展示阶段信息，不生成模拟百分比。
- 排队取消：不调用执行函数。运行取消：设置 `cancellationRequested` 并触发 `AbortSignal`，任务保持运行状态直到执行函数完成收尾，之后才启动下一项。
- 执行函数响应取消信号而拒绝，或抛出 `TaskCancelled` 时标记取消；显式 `TaskFailure` 仍标记失败。正常返回仍标记成功并保留真实结果，避免把已提交的文件操作误报成取消。
- 取消不回滚已完成的副作用；不自动重试。业务函数若忽略取消信号，队列会继续等待它结束。
- `onError` 只控制失败，单项取消仍只影响该项；有依赖关系且需中止后续工作的批次应使用 `cancelBatch`。
- 页面卸载只解除前端订阅，不取消任务。应用退出会丢失内存状态。

## 关闭收尾

```ts
await tasks.close()
// Task 完成收尾后，再关闭业务资源，例如 await catalog.close()。
```

`close()` 永久停止接受新批次，取消所有排队项，通知运行项取消，并等待执行函数真正结束。重复调用返回同一个 Promise，包括变更订阅中再次调用的情况；已完成的结果保留，关闭后不能重新打开这个实例。

如果运行项忽略取消信号，`close()` 继续等待它结束；如果该项完成了提交并正常返回，保留成功结果。不会超时后强杀进程、提前关闭数据库或假报已收尾。业务函数必须等待自己启动的操作和清理工作结束，不应在自己的 `run` 内等待 `tasks.close()`。当前只提供关闭方法，未来接入业务时再把它接到应用退出事件，并协调现有 Catalog 的关闭顺序。

## 验证

在代码项目根目录执行 `rtk proxy node scripts/check-tasks.mjs`，验证顺序执行、批次失败策略、部分结果、防重、取消收尾、关闭等待、快照和订阅等行为。

先执行 `rtk proxy pnpm run build`，再运行 `rtk proxy node scripts/check-tasks.mjs --ipc`，可额外使用真实 Electron 窗口与构建后的 preload 验证查询、订阅、取消、页面重载及窗口校验。测试只提交内存夹具，不调用现有业务。
