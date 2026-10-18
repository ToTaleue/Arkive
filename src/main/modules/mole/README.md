# Mole 业务入口

UI 和 Agent 统一从 `operations.ts` 调用占用分析、清理预览、安装包预览、开发产物预览、应用清单及回收站操作。它们与压缩、归档、去重共用 Task FIFO；`service.ts` 保留工具调用和解析，产品调用方不直接启动工具。

独立“清理”页面通过 `runMoleClean` 使用 `preview`／`clean` 两种模式，分别运行 `clean --dry-run`／`clean`，与既有预览共用防重 key。完整 Clean 的 Agent 入口与页面共用 Service；主进程在出队后检查 sudo，有效才启动。原生密码授权不自动清理，状态检查不延长闲置 sudo 会话。以普通用户运行 Mole，由 Mole 采用 sudo 处理系统级步骤。

此页面直接保留 Mole 的自动删除行为，常驻提示直接删除及默认清空回收站、无法从回收站恢复，不插入候选勾选或 Arkive 回收站流程。逐行输出按 Mole 分类展示，支持失败／取消后保留日志，切换页面不丢失运行。真实清理最长 30 分钟，预览仍为 120 秒；取消关闭整个子进程组，已发生的删除无法回滚。旧工作区中的 Clean 入口改为打开清理页，其他 Mole 工具保留。

预览共用 `mole-preview` 防重 key，排队不清空 Mole 的共享清单、不启动子进程、不发日志；开始运行后转发真实阶段和分段输出，第三个可选参数 `requestId` 用于 UI 关联。取消和退出等待子进程关闭；120 秒预览超时从实际启动计算。占用分析按规范化目录防重，应用清单单独防重。

不完整的 `scan_status`、截断日志和部分输出块在 Task 中记失败并保留结果；调用方仍收到原报告以展示警告。回收站直接复用 `file-operations/operations.ts` 的 `trashFiles`，保留独立项目失败继续和取消后的部分结果。

`authorizeMoleSystem` 保持直接调用，授权弹窗不占队列，授权完成后再提交预览。原有用户授权、系统路径保护和禁止任意 shell 的约束保持有效。

运行 `rtk proxy node scripts/check-scheduled-services.mjs` 验证调度和取消（隔离 HOME 的 Mole 子进程夹具），`rtk proxy node scripts/check-agent.mts` 验证真实 Pi SDK 工具接线。

运行 `rtk proxy pnpm run build` 后执行 `rtk proxy node scripts/check-clean-ui.mjs`，通过真实 Renderer／Preload／IPC／Task／进程执行器验证清理页。仅 sudo、密码对话框和 Mole 使用夹具；夹具只删除专用测试目录生成的文件，不调用真实 Mole、不访问真实回收站。原生密码交互及真实系统清理需要人工验收。

## 工具箱

工具箱的 Analyze、Purge、Uninstall、Installer 经 `toolbox-ipc.ts` 使用上述业务入口。Analyze 展示 JSON、目录钻取与大文件；其余三项通过 `MoleWorkflowService` 保存候选、审阅精确选择，再移入回收站。窗口独立拥有方案和 AbortController，刷新／导航／退出会取消运行并丢弃旧方案。页面切换则保留运行、结果和选择。

所有执行使用预览 ID 和候选 ID，不接受 Renderer 传入任意删除路径。与 Agent 共用身份复查、系统路径保护、共享副本保护、单次方案消费及部分结果。未知的项目活动时间不推算，Purge 默认不勾选；应用数据默认保留。安装包普通文件的容量来自 lstat，目录容量未提供时显示未知；移动到回收站不宣称已释放空间。

运行 `rtk proxy node scripts/check-mole-toolbox-ui.mjs` 验证真实 Renderer／Preload／IPC／Workflow／Task／进程链路。Mole 发现和回收站使用隔离夹具，只操作 `arkive-test` 中生成的文件。覆盖扫描／目录钻取／未知容量、确认前无写入、逐项选择、个人数据保留、部分失败、停止恢复、跨窗口方案隔离、刷新取消，以及日夜主题和窄窗口截图。真实应用卸载和主机扫描不在此自动测试中执行。

2026-10-18 另经原生桌面操作，在独立 Electron 验收窗口、隔离 HOME 和生成文件上验证随项目真实 Mole 与 macOS 回收站：Analyze 钻取及大文件正常，Purge／Installer 只移动选中项，Uninstall 只移动测试 App 本体；应用清单停止后刷新恢复，切换工具保留后台操作和结果。Mole 副本检查不完整，缓存与个人设置保留，未绕过保护。后续两次只读复现定位为安装收据扫描超时（124）；上游 `some paths unreadable` 同样用于该情况，不代表已发现拒绝访问路径。证据为 `/Users/hu1hui/Desktop/arkive-test/mole-native-ui-mC23pW/native-verification.json` 和同目录 `uninstall-diagnosis.json`；未运行真实完整 Clean、sudo 授权或卸载用户应用，也不代表完整生产入口／Agent 验收。

只读 Bash 适配将副本检查的原因以 `ARKIVE_MOLE_DIAGNOSTIC:` 写入 stderr，`execution/mole-uninstall.ts` 读取为可选 `diagnostics`，随预览和执行结果传递。只保留相关原生诊断，不启用持久化 debug 日志、不修改上游脚本、扫描范围、时限或保护判定；原生诊断没有具体路径时不编造路径。工具箱合并预览／结果的相同警告，固定说明为普通文字，原因和原生路径放在可展开的检查详情。
