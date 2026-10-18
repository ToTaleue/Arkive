# Task 内存队列

图片、视频、PDF、Office 压缩与用户主动检测、独立归档、备份重试、批量标签、文件写操作、Mole 分析／预览／应用清单／清理、重复扫描及 APFS 克隆去重已接入共用队列，按钮和 Agent 共用业务入口提交任务。提供结果判定、防重复提交、查询／取消 IPC 和退出收尾能力。队列和结果只保留在当前进程内，不写 SQLite，退出后不保留历史或自动恢复。`repository.ts` 继续占位。

归档列表／详情查询、打开／定位、后台 Finder 标签同步、启动恢复和 Pi 上游只读工具仍直接调用。Agent 对话循环和管理员授权弹窗不占用业务队列。压缩内部的媒体探测、编码、原件备份和归档直接调用底层 Service，避免嵌套排队。Task 调度的是用户业务操作，不是每一个内部函数或 IPC。

## 已接入的压缩流程

- 选择输出位置后才提交任务，不占用队列等待原生对话框。图片、视频、PDF、Office 及其他已接入操作跨入口串行执行；排队期间不启动编码或创建 Catalog 记录。
- 同一个 `realpath` 输入使用 `compress:<路径>` 防重，排队／运行期间拒绝再次提交，即使档位或输出位置不同。它不是通用文件锁，不识别硬链接别名；输入和输出路径在提交前规范化，请求参数复制后再入队。
- `compressImageAndBackup`／`compressVideoAndBackup`／`compressPdfAndBackup` 仍返回实际业务结果的 Promise，Agent 不能把提交 ID 当作完成。不要在外面再包一个 Task。
- 编码、校验、原件备份和可选归档属于同一个任务。无体积收益属于成功；备份或请求的归档失败时 Task 标记失败并保留完整结果，原有调用方仍收到业务结果以展示失败信息、按 ID 重试。
- 前端通过可选 `requestId` 关联已有 IPC `runId`，订阅状态并显示等待／执行／取消收尾。视频保留原有的分阶段百分比与 ETA，Task 的百分比同样只对应当前阶段。
- 按钮的取消信号和 Agent 工具的信号连接到 Task；从 Task IPC 取消也会传递到编码器。进入发布／备份提交阶段后等待真实结果，不把成功提交误报成取消。
- 保留现有业务 IPC 的窗口重载／销毁取消行为；普通页面切换不取消压缩。没有新增任务中心或页面重载后的结果恢复界面。
- 应用退出先 `tasks.close()`，等待任务清理，再关闭其他业务资源与 Catalog；重复退出请求不能绕过收尾。

## 其他已接入操作

- `office-compression/in-place.ts` 的 `compressOfficeInPlace` 将内嵌媒体编码、整份文档校验、备份和原路径发布包成一个 Task，使用同样的 `compress:<realpath>` 防重。排队不创建临时目录或 Catalog 记录；发布失败标记 Task 失败并保留原有 `replacementStatus=error` 结果。Office 页面通过 `requestId` 显示排队状态并支持取消。
- `catalog/operations.ts` 的 `archiveFile`／`retryBackup`／`tagArchives` 是按钮和 Agent 的显式调度入口。归档与重试对同一个记录共用 `catalog:<id>` 防重；标签请求固定 ID 和增删差量。备份或标签失败标记 Task 失败并保留逐项结果，原有调用方仍收到诊断数据。底层 Catalog 的互斥队列继续负责数据库与恢复一致性，压缩任务中的自动归档和启动恢复直接调用 Catalog，不再次提交 Task。
- Catalog 操作在排队期间可以取消；一旦开始提交，等待整项完成，保留实际成功／失败结果。批量标签是一个业务 Task，不承诺中途回滚或立即停止 JXA 写入。
- `file-operations/operations.ts` 提供 `copyPath`／`movePath`／`createDirectory`／`trashFiles`，Agent 工具只做参数接线。路径、参数在入队前固定，系统路径保护和拒绝覆盖在实际执行时重新检查；复制／移动／建目录对同一目标使用 `file-write:<path>` 防重。这些 key 不是通用文件锁，不阻止外部程序或未接入功能修改文件。
- 复制在逐项检查时响应取消，保留可能已生成的部分副本；移动、建目录及已经开始的单个删除等待真实系统调用结束。批量清理在项目间停止，失败仍继续其他独立项目；Task 的部分结果保留完成、失败与未处理路径。Mole 的清理也复用这一入口，与 Agent 共用队列、防重和部分结果语义。

## 扫描、检测与 Mole

- `processing/operations.ts` 是图片、视频、PDF、Office 检测入口；窗口选择文件后和 Agent 探测均走队列，编码器内的自检仍用原始 Service。对同类 `realpath` 输入防重，窗口重载／关闭取消旧的检测任务。
- `duplicate-detection/operations.ts` 将一次完整 Czkawka 扫描作为一个 Task，按规范化目录防重，支持 `requestId`。部分扫描保留原报告供 UI／Agent 展示，Task 记为失败；取消等待子进程退出和报告目录清理。
- `clone-deduplication/operations.ts` 将一批明确授权的源／副本作为一个 Task；请求复制后固定路径，集合排序防重，不是跨操作文件锁。原生事务、回滚和恢复文件保留在底层。部分失败／恢复遗留记失败；取消记取消并保留逐项结果；已经全部提交的成功保持成功。调用方仍收到原有 `partial`／`cancelled` 结果，排队取消则抛出 `TaskCancelled`。
- `mole/operations.ts` 调度占用分析、三种预览及应用清单，清理复用 `trashFiles`。预览使用同一防重 key，防止 UI／Agent 同时操作 Mole 的共享清单。输出只在实际运行时流出，预览支持 `requestId`，超时从实际启动计算。部分分析／截断预览在 Task 中记失败，保留原报告；不能把部分结果解释为全量扫描完成。
- 授权弹窗仍直接调用 `authorizeMoleSystem`，完成授权后再调用预览。所有封装内都只调用底层能力，不能在 `run` 中再等待这些提交型入口，否则单并发队列会自锁。

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

`tasks.wait(id)` 等待终态快照，运行取消仍会等待实际清理，已结束任务可立即读取；不存在的任务会拒绝。单项业务可使用 `service.ts` 的 `runTask<T>(job, signal?)` 保留 Promise 调用方式：成功返回类型化结果，失败抛出 `TaskFailure`，取消抛出 `TaskCancelled`。外部信号只负责请求取消，不提前结束等待；结束后解除信号监听。

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

没有通用“提交执行函数”的 IPC。图片等业务 IPC 校验请求、完成授权和输出位置选择，再调用共用压缩入口提交 Task。UI 和 Agent 通过同一业务入口提交，避免绕过业务规则。当前所有已注册应用窗口共用任务查询与取消能力。

## 状态、进度和取消

- 状态：`queued → running → succeeded / failed / cancelled`；排队项可直接变为 `cancelled`。
- `onError: 'stop'` 的批次发生失败时，剩余排队项从 `queued` 变为 `skipped`，不调用执行函数。
- 进度：业务函数通过第二个参数上报 `{ percent?, message? }`；百分比必须为 0–100，不提供时仅展示阶段信息，不生成模拟百分比。
- 排队取消：不调用执行函数。运行取消：设置 `cancellationRequested` 并触发 `AbortSignal`，任务保持运行状态直到执行函数完成收尾，之后才启动下一项。
- 执行函数响应取消信号而拒绝，或抛出 `TaskCancelled` 时标记取消；显式 `TaskFailure` 仍标记失败。正常返回仍标记成功并保留真实结果，避免把已提交的文件操作误报成取消。
- 取消不回滚已完成的副作用；不自动重试。业务函数若忽略取消信号，队列会继续等待它结束。
- `onError` 只控制失败，单项取消仍只影响该项；有依赖关系且需中止后续工作的批次应使用 `cancelBatch`。
- Task 模块本身不根据页面生命周期取消任务；现有业务 IPC 的窗口重载／销毁仍会显式取消对应请求。应用退出会丢失内存状态。

## 关闭收尾

```ts
await tasks.close()
// Task 完成收尾后，再关闭业务资源，例如 await catalog.close()。
```

`close()` 永久停止接受新批次，取消所有排队项，通知运行项取消，并等待执行函数真正结束。重复调用返回同一个 Promise，包括变更订阅中再次调用的情况；已完成的结果保留，关闭后不能重新打开这个实例。

如果运行项忽略取消信号，`close()` 继续等待它结束；如果该项完成了提交并正常返回，保留成功结果。不会超时后强杀进程、提前关闭数据库或假报已收尾。业务函数必须等待自己启动的操作和清理工作结束，不应在自己的 `run` 内等待 `tasks.close()`。应用退出已按 Task、其他业务资源、Catalog 的顺序收尾。

## 验证

在代码项目根目录执行 `rtk proxy node scripts/check-tasks.mjs`，验证顺序执行、批次失败策略、部分结果、防重、取消收尾、关闭等待、快照和订阅等行为。

先执行 `rtk proxy pnpm run build`，再运行 `rtk proxy node scripts/check-tasks.mjs --ipc`，可额外使用真实 Electron 窗口与构建后的 preload 验证查询、订阅、取消、页面重载及窗口校验。这个基础测试只提交内存夹具。

`rtk proxy node scripts/check-compression-tasks.mjs` 使用测试目录中的生成文件及真实 Sharp／FFmpeg／qpdf／Ghostscript／Catalog，验证三类压缩、Office、独立归档、标签和文件操作共用队列，覆盖防重、参数固定、排队无副作用、排队／运行取消、执行时覆盖检查、备份／发布／标签失败后的部分结果与重试，以及提交阶段取消。`check-processing-ui.mjs` 和 `check-video-compression.mjs --ui` 验证真实页面排队提示、取消和原有结果展示。

`rtk proxy node scripts/check-scheduled-services.mjs` 验证新增检测、扫描、克隆和 Mole 的共用 FIFO、防重、固定请求、排队无副作用、逐项结果及取消收尾。文件检测／重复扫描／APFS 使用真实工具与生成文件，Mole 使用隔离 HOME 的真实子进程夹具，不扫描用户目录。
