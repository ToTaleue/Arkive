# Windows 失败项修复与回归验证 — 2026-10-17

修复前报告中的 5 类问题、8 个失败检查均已转为通过。此前白色 UI 改动保留，未开展 Mac 适配或新增清理功能。

## 最终结果

执行命令：`node scripts/check-windows.mjs`，退出码 **0**。

证据目录：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep`。

| 检查 | 结果 |
| --- | --- |
| 队列、Mole 输出解析、Windows 路径保护单测 | 29 通过，0 失败 |
| 文件落盘、发布幂等、拒绝覆盖、归档路径与 junction 单测 | 5 通过，0 失败 |
| 综合功能检查 | 30 通过，0 失败，7 项受限或待实现 |
| Task IPC、Markdown、标签推荐 | 全部通过 |
| 视频进度 / ETA、ab-av1 输出解析 | 两组既有断言通过，未执行视频编码 |
| 主进程/前端类型检查、构建 | 全部通过 |
| ESLint | 0 错误，21,311 条既有 CRLF 格式警告 |
| 修改文件格式检查、git diff --check | 通过 |

## 修复内容

| 问题 | 原因与修复 | 回归结果 |
| --- | --- | --- |
| W01 系统路径保护 | 为 Windows 增加系统、程序、ProgramData、恢复和系统卷目录保护；识别盘符/UNC 根目录；标准化扩展路径，拒绝设备命名空间。macOS 继续使用原有保护列表。 | 系统目录、大小写、`\\?\` 路径、设备路径、根目录拒绝通过；用户目录及名称类似的文件夹保持可用。测试未在系统目录写入。 |
| W02 WebP EBUSY | libvips 的文件缓存保留 WebP 输入句柄。仅在 Windows 的产品 Sharp 适配器中设置 `sharp.cache({files: 0})`，保留内存和操作缓存的容量限制。 | 实际压缩、透明度/尺寸校验、前端压缩、原件备份及临时目录清理通过。测试没有自行改缓存设置。 |
| W03 fsync EPERM | Windows 刷盘要求可写句柄，原代码使用只读 `r`。Windows 改用不创建、不截断的 `r+`，其他平台继续使用 `r`；继续实际执行 sync。 | 原件完整备份、源路径移除、归档哈希/幂等、无覆盖发布通过；刷盘不改变内容和 mtime，缺失文件不会被创建。 |
| W04 归档路径 | 使用平台路径 relative/sep 判定成员关系，并在任何 mkdir 前拒绝库外路径；真实路径比较允许 Windows 大小写差异，仍拒绝 junction 别名。 | 合法 Windows 路径通过；同前缀兄弟目录和父目录别名被拒绝；拒绝外部路径时不再额外创建日期目录。 |
| W05 文件名显示 | Windows 同时识别反斜线和正斜线取文件名；其他平台仍按正斜线处理，保留 POSIX 文件名中的合法反斜线。 | 通过真实文件输入、Electron webUtils 桥接和 React 列表检查，只显示文件名；不支持文件的提示使用同一取名规则。 |

产品修改位置：

- `src/execution/sharp.ts`
- `src/main/modules/catalog/files.ts`
- `src/main/system-paths.ts`
- `src/renderer/src/components/CompressionPage.tsx`

新增回归：`src/main/system-paths.test.ts`、`src/main/modules/catalog/files.test.ts`，已接入 `scripts/check-windows.mjs`。

## WebP 与 fsync 的原因验证

独立进程对照证据：`C:\Users\steph\Desktop\arkive-test\windows-diagnosis-xGD6D3\results.json`。

| 对照条件 | 观察结果 |
| --- | --- |
| Sharp 默认缓存，完成 WebP 读取后移除临时目录 | EBUSY |
| 完成后销毁 Sharp 解码实例 | 仍为 EBUSY |
| 有界重试清理，累计约 10.8 秒 | 仍为 EBUSY |
| 缓存可保留的文件数设为 0 | 清理成功 |
| 改为 Buffer 输入 | 清理成功；未采用此方式，以免增加完整输入文件的内存占用 |
| 只读 r 句柄 fsync | EPERM |
| 读写 r+ 句柄 fsync | 成功 |

修复前重新运行原测试，确认相同 8 项失败；加入边界回归后也确认了新增断言会失败。上述修复后，全部目标用例及原有 Windows 综合用例通过。没有通过忽略清理错误或跳过刷盘来返回成功。

文件缓存配置语义见 [Sharp 官方 cache 文档](https://sharp.pixelplumbing.com/api-utility/#cache)；Windows 文件刷盘访问权要求见 [Microsoft FlushFileBuffers 文档](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)。

## 成功证据

- 汇总：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep\results.json`
- 逐项结果：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep\functional-results.json`
- 综合日志：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep\windows-functional.log`
- 系统保护/队列日志：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep\pure-logic.log`
- 文件回归日志：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep\filesystem-regressions.log`
- 前端实际压缩成功截图：`C:\Users\steph\Desktop\arkive-test\windows-WSgfep\ui-compression.png`
- 最近汇总副本：`out/windows-test-latest.json`

前端实际验证了文件选择、文件名、真实 WebP 编码、完整原件备份和完成状态。归档副本实际创建并核对哈希，重复归档使用同一副本。只读哨兵保持不变，图片临时目录无残留。

## 保留的边界

- Finder 标签仍需要 macOS；Windows 的归档复制通过，但 `tagStatus=error` 如实保留。未把文件复制成功等同于标签同步成功。
- SSIMULACRA2 等随包工具仍只支持 macOS arm64，Windows 图片质量分数仍不可用并返回相应信息。
- 大疆视频、APFS/Czkawka、Mole、真实 Finder 标签、真实模型行为、备份定期清理及 UI 最终确认等原有 7 项限制保持独立记录。
- Agent 使用真实 Pi SDK 和本地 HTTP 响应夹具；未请求真实模型服务。
- 备份验证使用同一磁盘卷内的生成样本，跨卷携带 macOS 元数据的原有 ditto 分支未扩展。
- Windows 禁用文件句柄缓存可能增加重复读取时的磁盘 I/O；编码策略、质量选择和校验规则未改变。Mac 运行效果未在本轮验证。
- 测试仅处理生成样本与独立业务库，没有扫描或修改用户的真实微信、邮件、文档或正式归档库。

重新启动开发版后即可加载新的主进程实现。复跑仍使用 `node scripts/check-windows.mjs`。
