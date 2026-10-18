# Mole 业务入口

UI 和 Agent 统一从 `operations.ts` 调用占用分析、清理预览、安装包预览、开发产物预览、应用清单及回收站操作。它们与压缩、归档、去重共用 Task FIFO；`service.ts` 保留工具调用和解析，产品调用方不直接启动工具。

预览共用 `mole-preview` 防重 key，排队不清空 Mole 的共享清单、不启动子进程、不发日志；开始运行后转发真实阶段和分段输出，第三个可选参数 `requestId` 用于 UI 关联。取消和退出等待子进程关闭；120 秒预览超时从实际启动计算。占用分析按规范化目录防重，应用清单单独防重。

不完整的 `scan_status`、截断日志和部分输出块在 Task 中记失败并保留结果；调用方仍收到原报告以展示警告。回收站直接复用 `file-operations/operations.ts` 的 `trashFiles`，保留独立项目失败继续和取消后的部分结果。

`authorizeMoleSystem` 保持直接调用，授权弹窗不占队列，授权完成后再提交预览。原有用户授权、系统路径保护和禁止任意 shell 的约束保持有效。

运行 `rtk proxy node scripts/check-scheduled-services.mjs` 验证调度和取消（隔离 HOME 的 Mole 子进程夹具），`rtk proxy node scripts/check-agent.mts` 验证真实 Pi SDK 工具接线。
