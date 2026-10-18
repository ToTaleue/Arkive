# 归档、原件备份和标签

图片、视频和 PDF 的按钮及 Agent 压缩入口通过 `compression.ts` 共用 Task 队列和收尾流程：编码及校验成功且体积减小后，将原件移入 `~/Arkive Backup/YYYY-MM-DD/`，保留用户选择位置的压缩输出。编码失败、提交前取消、无体积收益均不移动原件；进入备份提交阶段后等待实际结果。原件备份失败单独报告，可重试，不再次编码。排队、防重、部分失败与取消语义见 [Task 模块](../../tasks/README.md)。

结果页点击“确定归档”，把输出复制到 `~/Arkive Archive/YYYY-MM-DD/`。文件名附加记录 UUID，禁止覆盖；重复点击复用同一副本。先记录计划路径，再复制、SHA-256 校验并发布。Backup 保存完整原件；Archive 保存可直接打开的压缩副本。没有定期清理。

统一“压缩”页面提供“压缩完成后归档”选项；勾选后，图片、视频、PDF 和已发布的 Office 结果沿用同一条 Catalog 归档流程，列表状态显示“已归档”或归档错误。该选项不自动添加标签，完成后可在“我的归档”中补充标签。

归档区提供默认关闭的“在原位置保留访问入口（试用）”开关。勾选后，共用 Catalog 归档流程在正式副本校验成功后调用 Node `symlink`，入口只指向 Archive，不指向 Backup。同格式沿用原路径；格式转换时保留原文件名主体、使用输出扩展名。已有普通文件、目录或其他链接一律不覆盖（包括 Office 原位发布后仍在原路径的压缩文档）；归档照常成功，`originalLink` 单独报告入口失败并可重试。保留原件及当前压缩输出的既有策略不变，本开关不负责清理这些文件，也不承诺额外空间收益。

`CatalogApi.archive(id, tags, { keepLinkAtOriginalLocation: true })`、现有 `archive_file` 及带 `archive=true` 的压缩工具共用该开关，无新增 Agent 工具。入口意图、路径及状态通过数据库 v4 迁移持久化；启动时恢复尚未完成的入口创建，已有相同软链接视为成功，失败不覆盖且保留显式重试。普通软链接不会追踪外部移动／重命名；这轮未增加归档移动、删除及链接自动维护能力。

Agent 有两种共用入口：`compress_image`／`compress_video`／`compress_pdf` 接受可选 `archive: true` 和 `tags`，在同一次调用内完成压缩、备份及归档；普通压缩省略该选项。`archive_file({ id, tags? })` 对已有压缩记录执行同一归档流程，并可核对／重试未完成的原件备份，不重新编码、不接受任意文件路径。无体积收益时保留原件原位的默认规则继续有效。

组合调用分别返回编码结果、`catalog` 备份记录与可选的 `archive` 结果。归档失败保留成功的编码结果和记录 ID，重试调用 `archive_file`，不能重新压缩已经移走的源文件。归档成功但标签失败时，通过归档资料的 `tagStatus`／`tagError` 报告。

`search_archives` 返回归档结果和预设／已有标签；`tag_archives({ ids, add?, remove? })` 支持最多 100 个资料的标签增删差量，逐项返回状态。默认 20 个通用标签由 `src/shared/contracts/catalog.ts` 的 `presetTags` 统一定义，标签选择界面和查询共用该定义；已有自定义标签继续返回，不迁移或重命名旧标签。Agent 推荐前先查询词库，优先复用同义的已有名称；通用分类与有明确依据的具体标签可以并用，没有合适词时允许建议新词，经用户授权后写入。当前只按用户指令应用标签，或根据用户授权的文件名等已知信息提出建议；没有自动描述性元数据分析、OCR 或音视频识别，也不在普通压缩时自动生成标签。用户授权一批标签方案后可一次应用。

主进程启动时在 Electron userData 的 `arkive.db` 打开 `node:sqlite`，记录源修改日期、原件／备份／输出／归档的位置和操作状态。重启恢复未完成的备份与归档；复制和校验不放在数据库事务中。编码函数本身不移动原件，产品调用方必须使用共用收尾入口。

独立推荐入口为 `tag-recommendation.ts` 的 `recommendTags(input, signal?)`，完整 Prompt 在 `tag-recommendation-prompt.ts`，输入输出类型在 `src/shared/contracts/tag-recommendation.ts`。调用方提供整理好的文件名、原路径、扁平元数据、已有词库、相关用户说明及按文件限定的纠正；函数自动合并默认词库，复用 `agent/model.ts` 的模型初始化，通过 Pi SDK 1.2.0 的 `completeSimple` 完成一次无工具请求，不创建聊天会话、不读文件、不写标签。成功返回按输入顺序排列的 `items`，每个标签含名称、依据和程序计算的 `isNew`；只建议文件尚未拥有的标签。结构错误整次返回 `error`，取消返回 `cancelled`。不自动重试或接受截断回复；当前每次最多 10 个文件，资料 JSON 最多 24,000 UTF-8 字节，每文件最多 8 个建议，60 秒超时。元数据采集、IPC 与界面推荐尚未接线，业务流程不会自动调用。输入输出示例及完整边界见 `/Users/hu1hui/Developer/arkive-doc/proposals/ai-tag-recommendation.md`。

Finder 标签通过随应用分发的 `resources/finder-tags.jxa` 和 Foundation 的 `NSURLTagNamesKey` 读写；固定系统工具调用仍经过 `src/execution/process.ts`，不拼接 shell。首次归档继承原件标签，应用编辑提交增删差量，重读当前 Finder 标签后合并。写入核对失败保留待重试差量。启动、目录事件、窗口激活和手动刷新核对 Finder 标签，包括删除；只同步归档副本，不把后续修改传播到备份或输出。

“我的归档”支持原文件名／输出文件名子串匹配、标签 AND、源修改日期和归档日期（本地日期、含起始日和结束日）、每页 50 条、打开及 Finder 定位。SQLite `lower()` 默认只保证 ASCII 大小写转换。无正文、OCR、语义搜索或文件移动／重命名同步；不压缩直接归档未开放。

记录状态可切换为“待归档压缩结果”，对应 `query({ state: 'pending' })`；默认 `archived` 保留原有查询语义。只展示已完成压缩且尚未完成归档的记录，Office 还须完成原路径发布；可直接按原记录归档或重试，无需重新压缩。Agent 的 `search_archives` 使用相同状态参数，`open_archive({ id, action: 'open' | 'reveal' })` 复用归档路径校验，不能打开未归档记录。

## 验证

```sh
rtk proxy node scripts/check-tag-recommendation.mjs
rtk proxy node scripts/check-archive-links.mjs
rtk proxy pnpm run build
rtk proxy node scripts/check-catalog.mjs
rtk proxy node scripts/check-agent.mts
rtk proxy node scripts/check-video-compression.mjs --ui
rtk proxy pnpm run lint
```

Catalog 检查使用真实 Electron、SQLite、Finder 标签、Sharp、preload 和 React 界面，仅移动 `~/Desktop/arkive-test/catalog-check-*` 下生成的夹具，保留样本及界面截图供检查。覆盖备份与标签继承、长中文文件名、保留元数据的复制分支、归档幂等、筛选、标签增删与失败重试、重开同步、模拟中断恢复、源文件变化保护和取消。

视频 UI 回归包含实际点击“确定归档”并进入归档列表。Agent SDK 检查使用本地流式模型夹具驱动实际工具调用，连接真实 SQLite、原件备份、JXA 标签与编码；覆盖压缩中归档、稍后独立归档、归档失败后按 ID 重试、批量标签和 AND 检索。Electron 的应用资源路径与回收站入口由测试适配，未调用真实模型服务。此前未签名 arm64 `.app` 已构建；包内 Electron 的 Node 模式 SQLite 重开及包内 JXA 标签读写已验证，未做签名分发或整包 GUI 验收。

同卷备份采用独占硬链接发布后移除源路径；跨卷采用 `ditto` 复制元数据、校验后移除源路径。已验证复制分支，尚未在真实第二卷或断电环境演练。未提供数据库丢失后的自动重建。SQLite 接口随 Electron 内嵌 Node 版本提供，当前运行时会提示实验性接口。

## Task 调度边界

按钮及 Agent 的独立归档、备份重试和批量标签通过 `operations.ts` 共用 Task 队列。排队期间不修改文件或记录；启动后 Catalog 的提交等待实际完成，Task 取消不回滚已开始的提交。备份／标签的部分失败保留诊断结果并标记 Task 失败。图片、视频、PDF 和 Office 自身的备份／发布，以及压缩中的自动归档仍属于同一业务 Task，直接调用 Catalog，避免嵌套排队。只读检索、刷新／后台标签同步和启动恢复不再套 Task。详见 [Task 模块](../../tasks/README.md)。
