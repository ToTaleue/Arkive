# 单文件夹重复检测 Service

`scanDuplicates` 是压缩归档流程可复用的主进程接口，契约位于 `src/shared/contracts/duplicates.ts`。

```ts
const result = await scanDuplicates({ directoryPath: '/absolute/folder' }, signal)
```

- 只比较本次选中的一个文件夹及其子目录，不查询历史压缩、归档记录或其他目录。
- 通过通用执行器调用内置 Czkawka 12.0.2，按大小、预哈希、完整 BLAKE3 哈希筛选；不以名称或相似度认定重复。
- 明确使用 `-D NONE`，只读源文件。报告写入私有临时目录，结束、失败或取消后清理。
- 禁用上游缓存，不持久化本次结果；暂固定两个扫描线程。这是起始配置，不是性能评测结论。
- 包含 1 字节以上的文件；空文件无空间收益，不纳入结果。符号链接不跟随；已有硬链接沿用上游默认行为，只计一次。
- 返回按逻辑冗余体积降序排列的重复组、各文件路径、重复副本数和 `redundantBytes`。它不代表实际释放量，已有 APFS 克隆或快照会影响磁盘收益。
- 上游报告读取失败等警告时返回 `partial` 和诊断，不能将部分结果展示成完整扫描。启动、异常退出或报告无效时抛错；取消通过 `AbortSignal` 抛出。

本轮只接 Service，尚未接 IPC、归档界面或批量压缩调用。没有独立去重页面或任务队列；APFS 克隆、重复内容只压缩一次与原件处理由后续压缩归档流程接入。扫描结果是候选分组，不是文件修改授权或稳定快照；执行前仍需重新核对内容、文件状态和各路径的元数据，不能直接以第一项为“保留原件”。

## 验证

```sh
rtk proxy node scripts/check-duplicate-detection.mjs
rtk proxy pnpm run typecheck
rtk proxy pnpm run lint
```

验证脚本在 `/Users/hu1hui/Desktop/arkive-test` 下创建独立夹具，调用真实 Service、通用执行器和内置 CLI；只清理自己创建的目录。
