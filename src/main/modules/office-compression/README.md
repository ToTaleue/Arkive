# Office 嵌入媒体压缩

本模块负责普通 `.docx`／`.pptx` 的包读取、媒体筛选、回填校验和原路径发布。JPEG／PNG 复用图片 Service 的原格式编码与感知质量判断；包内 MP4 复用视频 Service 的 H.264 兼容压缩。未支持的媒体保留原样并返回跳过原因。

## 入口与职责

- `service.ts`：`inspectOffice(inputPath, signal?)` 探测格式和媒体数量；`compressOffice(request, signal?)` 只生成新的完整文档，不登记或处理原件。输出须为不存在的绝对路径，后缀与输入相同。
- `in-place.ts`：`compressOfficeInPlace({ inputPath, preset? }, signal?)` 是用户授权后的业务入口。整份旧文档复用 Catalog／Original Backup，备份完成后把结果发布回原路径，并让 Catalog 指向最终文档。
- `package.ts`：内部 ZIP／OOXML 读写与校验。不把拆包文件暴露给界面，不调用媒体的备份包装入口。
- `replacement.ts`：内部持久化发布状态。Catalog 启动时恢复备份前、备份后及发布后尚未完成的任务，独立失败不会阻断其他资料恢复。
- 共享结果契约：`src/shared/contracts/office.ts`。
- Agent Tools：`inspect_office({ inputPath })` 只读探测；`compress_office({ inputPath, preset? })` 直接调用原路径替换入口，不接受 `outputPath`、`archive` 或 `tags`。已授权归档时，在 `replacementStatus=replaced` 后将 `catalog.id` 交给 `archive_file`，归档最终文档。工具的对话授权规则由 Agent 提示词落实。

```ts
import { compressOfficeInPlace } from './in-place'

const result = await compressOfficeInPlace(
  { inputPath: '/absolute/path/deck.pptx', preset: 'quality' },
  signal
)
// 展示 replacementStatus、media、大小和 catalog 中的备份位置。
// replacementStatus === 'error' 时不能把候选压缩成功当成替换成功。
```

## 发布条件与保留行为

图片保持 JPEG／PNG 格式，默认 `quality` 预设。仅接受质量达标且实际变小的候选；失败、未达标、无收益的媒体保持原字节。正文、关系 XML 和未处理对象也保持原字节，外链不访问。

视频仅筛选后缀 `.mp4` 且内容类型为 `video/mp4` 的包内条目，编码为 MP4／H.264 8bit，AAC 音轨直接复制。默认 `quality` 预设，沿用视频 Service 的自适应选参和抽样 VMAF 98 目标，再校验输出属性及完整解码；质量分数是抽样指标，不等于所有画面视觉无损。回填保留原条目名称、内容类型、媒体关系和播放时间 XML。[微软推荐的 PowerPoint 视频格式](https://support.microsoft.com/en-us/powerpoint/video-and-audio-file-formats-supported-in-powerpoint)也是 MP4／H.264／AAC，具体文档仍需原生播放验收。

含字幕、章节、封面、时间码或其他会被现有视频 Service 移除的附加内容时，Office 保留原视频。非 AAC 音轨、HDR、旋转及其他现有编码器不支持的输入也跳过；不转换 MOV／WMV 等容器，不处理嵌套 OLE 对象。`embeddedVideos` 表示 MP4 候选数量，不保证每份候选均可压缩。

回填后重新读取整个包，校验 CRC、XML 语法、内容类型、内部关系目标，以及每个条目的预期哈希。只有媒体被接受且完整文档变小才发布。`no-savings` 不产生输出副本，`outputPath` 指向输入，原路径业务入口返回 `unchanged`。

原路径发布前再次检查源文件，复用完整原件的备份和标签能力；已被外部修改的源文件不覆盖。发布失败时只恢复缺失的原路径，不覆盖其他文件。发布计划持久化前接受取消并清理临时文件；之后进入提交阶段，完成发布或记录可诊断的失败，不在备份与发布之间接受取消。

备份目录采用 Catalog 当前配置，与 Archive 分开；归档复制最终原路径上的压缩文档。原件备份仍占磁盘空间，`savedBytes` 只表示文档大小差额。

## 当前边界

只支持普通 DOCX／PPTX；旧版 DOC／PPT、宏文档、签名文档、加密包拒绝处理。包处理上限为 20,000 个条目、展开 4 GiB、单份 XML 16 MiB。XML 当前按 UTF-8 读取，未做完整 OOXML Schema 校验。

Agent 工具入口已接入，独立 Office IPC／压缩界面仍待接入。图片沿用现有 Service 的方向固化、sRGB 转换和元数据移除策略；复杂素材、Office 版本及跨平台显示效果还需样本标定。包校验不能替代 Word／PowerPoint 的打开、编辑与播放验收。

## 已执行验证（2026-10-17）

`rtk proxy node scripts/check-office-compression.mjs` 使用真实 Electron、SQLite、Sharp、pngquant、SSIMULACRA2、FFmpeg 和 ab-av1，测试文件只写入 `/Users/hu1hui/Desktop/arkive-test`。覆盖 DOCX／PPTX 嵌入图片、透明通道、未处理内容保留、错误包拒绝、无收益、取消、整份备份、标签、归档、三个发布中断点恢复、候选损坏与外部编辑保护。

生成的压缩 DOCX 已在本机 Word 中直接打开并看到文字和两张图片。另用 python-pptx 1.0.2 生成含完整母版、版式和主题的 PPTX，通过 `ARKIVE_OFFICE_SAMPLE=/absolute/path/sample.pptx` 传给上述检查脚本；脚本复制样本后在测试目录执行原路径替换，校验完整原件备份，不修改提供的样本。图片样本压缩后在本机 PowerPoint 中直接打开，无修复提示，文字和两张图片均显示。测试中的简化 PPTX 只用于包级行为检查，不能作为原生兼容性样本。检查还覆盖已有 v2 数据库升级后保留资料和归档记录。

视频检查覆盖 DOCX／PPTX 包内 MP4 压缩、H.264／8bit 输出、AAC 数据包哈希不变、逐帧时间戳保留及所有未处理条目哈希不变；非 AAC、字幕、损坏视频、无收益和选参期间取消均保留原件。完整自动播放 PPTX 样本从 2,672,772 降至 2,321,911 字节（约 13.1%），原路径替换和备份校验通过。本机 PowerPoint 打开无修复提示，放映画面时间从 00:00:00.133 推进至 00:00:03.967，确认内嵌压缩视频实际播放。该结果仅代表生成样本；未人工验收声音、复杂文档编辑、动画、Word 视频播放或其他 Office 版本。lint、类型检查、构建及个人源码检查已通过。

`rtk proxy node scripts/check-agent.mts` 通过本地固定响应模型驱动真实 Pi SDK，覆盖两种 Office 工具注册、只读探测、DOCX／PPTX 原路径替换与完整备份、后续归档、无收益、媒体跳过、非法参数及备份失败回传 `replacementStatus=error`。未调用外部模型，不验证模型自行判断授权的能力。
