# 文件操作

`operations.ts` 是 Agent 和 Mole 清理的 Task 入口，提供复制、移动／重命名、建目录、回收站／永久删除，复用共用 FIFO 队列。授权和工具参数规则保持在 Agent 层，系统路径保护、拒绝覆盖和具体执行留在本模块。请求在入队前固定，实际执行时重新检查目标；排队取消不会操作文件。

复制逐项检查取消，已复制内容可能保留；不自动清理目标。移动与建目录等待系统调用实际完成。清理在项目间接受取消，独立项目失败继续，Task 保存完成、失败和未处理路径；已经完成的删除不回滚。永久删除仍要求明确授权。仅在原有授权范围内执行，不增加任意 shell。

`service.ts` 的 `trashPaths` 是 Task 内部逐项调用的底层入口；Mole 的 `operations.ts` 复用 `trashFiles`，避免两套删除调度。查询、打开／定位以及直接复用的 Pi 上游工具不接入本模块。防重 key 只保护已接入的同目标提交，不是文件锁。

`rtk proxy node scripts/check-compression-tasks.mjs` 使用生成夹具验证跨业务排队、固定请求、取消、拒绝覆盖及清理的部分结果；`rtk proxy node scripts/check-agent.mts` 验证真实 Agent 工具接线和已有文件操作行为。
