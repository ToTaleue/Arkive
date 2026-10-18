# Mole 业务入口

UI 和 Agent 统一从 `operations.ts` 调用占用分析、清理预览、安装包预览、开发产物预览、应用清单及回收站操作。它们与压缩、归档、去重共用 Task FIFO；`service.ts` 保留工具调用和解析，产品调用方不直接启动工具。

独立“清理”页面通过 `runMoleClean` 使用 `preview`／`clean` 两种模式，分别运行 `clean --dry-run`／`clean`，与既有预览共用防重 key。真实 Clean 仅在页面提供，不新增 Agent 工具；主进程在出队后检查 sudo，有效才启动。原生密码授权不自动清理，状态检查不延长闲置 sudo 会话。以普通用户运行 Mole，由 Mole 采用 sudo 处理系统级步骤。

此页面直接保留 Mole 的自动删除行为，常驻提示直接删除及默认清空回收站、无法从回收站恢复，不插入候选勾选或 Arkive 回收站流程。逐行输出按 Mole 分类展示，支持失败／取消后保留日志，切换页面不丢失运行。真实清理最长 30 分钟，预览仍为 120 秒；取消关闭整个子进程组，已发生的删除无法回滚。旧工作区中的 Clean 入口改为打开清理页，其他 Mole 工具保留。

预览共用 `mole-preview` 防重 key，排队不清空 Mole 的共享清单、不启动子进程、不发日志；开始运行后转发真实阶段和分段输出，第三个可选参数 `requestId` 用于 UI 关联。取消和退出等待子进程关闭；120 秒预览超时从实际启动计算。占用分析按规范化目录防重，应用清单单独防重。

不完整的 `scan_status`、截断日志和部分输出块在 Task 中记失败并保留结果；调用方仍收到原报告以展示警告。回收站直接复用 `file-operations/operations.ts` 的 `trashFiles`，保留独立项目失败继续和取消后的部分结果。

`authorizeMoleSystem` 保持直接调用，授权弹窗不占队列，授权完成后再提交预览。原有用户授权、系统路径保护和禁止任意 shell 的约束保持有效。

运行 `rtk proxy node scripts/check-scheduled-services.mjs` 验证调度和取消（隔离 HOME 的 Mole 子进程夹具），`rtk proxy node scripts/check-agent.mts` 验证真实 Pi SDK 工具接线。

运行 `rtk proxy pnpm run build` 后执行 `rtk proxy node scripts/check-clean-ui.mjs`，通过真实 Renderer／Preload／IPC／Task／进程执行器验证清理页。仅 sudo、密码对话框和 Mole 使用夹具；夹具只删除专用测试目录生成的文件，不调用真实 Mole、不访问真实回收站。原生密码交互及真实系统清理需要人工验收。
