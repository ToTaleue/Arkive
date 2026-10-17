# APFS 无损去重 Service 与 Agent Tool

`cloneDuplicates(request, signal?)` 是主进程业务入口；`clone_duplicates` 是 Agent 对同一入口的封装。现有 `scan_duplicates` 继续只读扫描。本轮没有增加去重按钮、整盘自动执行或批量压缩联动。

```ts
import { cloneDuplicates } from './service'

// 调用方先展示明确路径和处理方式，并取得用户对这一批的授权。
const result = await cloneDuplicates({
  sourcePath: '/absolute/folder/original.pdf',
  duplicatePaths: ['/absolute/folder/copy.pdf']
}, signal)
```

每次明确指定一个源和 1–100 个副本，不自动选择扫描结果第一项为源。所有路径先通过系统路径保护，再逐项处理；不设置用户目录黑名单。源文件不替换，成功项保留原来的副本路径，使用独立 inode 共享 APFS 存储，后续修改互不影响。

## 替换与恢复

固定原生工具 `native/apfs-dedupe.c` 通过 `src/execution/process.ts` 调用，使用 `fclonefileat`，没有普通复制降级。工具随现有 `resources/tools/darwin-arm64` 打包，无需用户安装编译器。当前支持 macOS arm64、macOS 13+，源和副本必须在同一个 APFS 卷上。

1. 在副本旁建立私有 `.arkive-dedupe-*` 事务目录，移除继承的 ACL 并持有目录锁；在应用 userData 的 `clone-deduplication` 中持久化索引及所属进程 ID。存活的原生 helper 即使尚未写入 state，也会阻止另一进程清理其准备副本。
2. 从打开的源文件描述符创建克隆快照，与副本逐字节比较；复制并核验副本自己的权限、所有者、ACL、扩展属性（含 Finder 标签和资源叉）、创建与修改时间，清除源独有的扩展属性。
3. 再核对内容、元数据、inode 和文件状态，通过 `RENAME_SWAP` 原子交换副本与克隆；原路径始终存在。交换后再次验证，才移除旧存储副本。inode 和 ctime 会变化，读取也可能按卷设置更新访问时间。
4. 成功后清理事务目录和索引。应用启动及下一次操作前恢复遗留事务：未交换则撤销准备；已交换且两份仍一致则恢复旧 inode；若文件又有变化或状态不明确，保留两个版本与恢复路径，阻止继续去重，不能递归删除事务目录。

去重授权包含校验后移除旧存储副本；不另外保留一份完整旧备份，也不将它移入回收站，否则可能继续占用原来的空间。此行为与普通媒体压缩后的 Arkive Backup 流程分开，不写入 Catalog 或自动归档。

只处理普通、非空文件；硬链接、符号链接、带文件标志（包括不可变、压缩、dataless 等）的文件、不支持的元数据或跨卷情况均拒绝，保留原因。已经属于同一克隆家族的相同内容保守跳过，避免重复记收益；这不证明家族中的所有数据块仍完全共享。原生文件锁和状态核验可以拦截部分并发修改，不能保证与不遵守锁的外部写入者绝对隔离；不承诺零风险，也未验收正在被外部应用持续写入的文件。

同一恢复根目录的 Service 实例共用串行执行；另一个仍存活的应用进程拥有的事务不自动恢复。退出时停止接收调用并等待已有工作收尾。取消在文件和准备／提交阶段之间生效，不强杀正在验证或交换的原生进程；已提交项保留。

## 结果判定

- `items` 逐项返回 `deduplicated`、`skipped`、`failed`、`cancelled` 或 `unprocessed`；总状态为 `completed`、`partial` 或 `cancelled`，不能仅凭工具调用返回就声称全部成功。
- `recoveryPath` 表示保留了需要核对的事务数据；报告路径和原因，不调用 `trash` 清掉它。恢复失败详情还保留在 userData 的 JSON 索引中。
- `logicalBytesShared` 仅为本次成功处理的逻辑内容大小，不包含已跳过项。`diskSpaceReclaimedBytes` 固定为 `null`：未测得可归因于本次操作的实际释放量，快照、原有共享块和同时发生的磁盘活动都会影响它。
- 当前没有持久化任务历史或共享 TaskManager 接线；持久化文件只用于异常恢复。真实模型自主选工具与授权判断仍需另行验收。

## 验证与重建

```sh
rtk proxy node scripts/build-apfs-dedupe.mjs
rtk proxy node scripts/check-clone-deduplication.mjs
rtk proxy node scripts/check-clone-deduplication.mjs --agent
rtk proxy node scripts/check-duplicate-detection.mjs
rtk proxy pnpm run typecheck
rtk proxy pnpm run lint
```

构建脚本使用系统 Clang 并更新工具 manifest 中的二进制哈希；原生代码以 `-Wall -Wextra -Werror` 编译。测试只在 `/Users/hu1hui/Desktop/arkive-test` 中生成文件，验证真实克隆 ID、独立修改、元数据、路径保护、取消、重复执行和恢复。交换后中断测试使用同一源码生成带测试屏障的临时程序，实际 SIGKILL 后由新 Service 实例恢复；正式工具没有该屏障。Agent 检查用本地固定响应 HTTP 模型驱动真实 Pi SDK 和业务，不代表真实模型授权理解已通过。
