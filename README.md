# Arkive

面向存量文件的本地压缩与归档工作空间。把不常用但仍有价值的视频、图片和文档压小，保留完整原件，再通过归档、标签和检索找回它们。

Arkive 使用 Electron、React 和 TypeScript 构建。界面操作与产品 Agent 共用业务服务和任务队列；文件处理在本地执行，Agent 对话和 AI 标签推荐使用用户配置的模型服务。

## 当前功能

| 功能 | 当前实现 |
| --- | --- |
| 批量压缩 | 在统一压缩页选择、拖入多个文件或文件夹，按顺序处理视频、图片、PDF 和 Office 文档；逐项展示结果并支持取消当前文件。 |
| 视频 | 使用 FFmpeg、ab-av1 和 VideoToolbox，按抽样 VMAF 自动选参，输出 HEVC，再检查输出属性及完整解码；H.264 兼容编码仅供 Office 内嵌视频使用。 |
| 图片 | 使用 Sharp／pngquant，支持 WebP 和受支持的原格式输出，按画质、平衡、体积预设生成候选；展示体积、SSIMULACRA2 参考评分及元数据保留警告。 |
| PDF | 使用 qpdf 做无损结构优化，支持 `lossless`、`deep-lossless`、`balanced`、`size` 四档；当前交付已移除 Ghostscript。 |
| Office（实验性） | 压缩普通 DOCX／PPTX 中符合条件的图片和视频，校验整份文档、备份完整原件后在原路径发布；开始前需要确认替换。 |
| 归档与检索 | 支持压缩后归档、待归档结果续做，以及通过 Agent 原样归档普通文件；按名称、标签、日期和文件类型筛选，打开或在 Finder 中定位。 |
| 标签 | 根据文件名、路径和已提取元数据推荐 AI 标签，写入 SQLite 索引和 Finder 标签；支持手工增删，Agent 归档时可关闭自动推荐。 |
| 重复文件 | 只读扫描重复组；经明确授权后，可通过界面或 Agent 执行同卷 APFS 克隆去重，保留路径和独立修改能力。 |
| 清理与工具箱 | 集成 Mole：磁盘占用分析、开发产物、安装包和应用候选审阅，以及独立的完整 Clean 页面。 |
| 原件备份管理 | 查看完整原件备份，手动选择清理 7 天前、3 天前或全部备份；核对后经原生确认移入回收站。 |
| 产品 Agent | 流式对话、工具进度与结果、总结重试、消息复制；内置演唱会录像、微信本地文件和 Lightroom 照片三个场景。 |
| 界面 | 日夜主题，以及独立的压缩、归档、清理和工具箱页面。 |

## 文件处理方式

普通图片、视频和 PDF 压缩在编码、校验成功且有体积收益后，将完整原件移入 `~/Arkive Backup/YYYY-MM-DD/`，压缩输出保留在选定位置。失败、提交前取消或无收益时不移动原件；无收益候选不作为成功压缩结果自动归档。

Office 采用单独的原路径替换流程：保存完整旧文档，再发布压缩文档。图片和视频可能采用有损编码，质量评分只供参考；复杂版式、字体、动画和内嵌媒体需要用 Word／PowerPoint 打开检查。

“压缩完成后归档”会将最终结果复制并校验到 `~/Arkive Archive/YYYY-MM-DD/`。Backup 保存完整原件，Archive 保存正式归档文件；归档失败时可按记录重试，不必重新压缩。原样归档普通文件默认复制到 Archive，保留源文件，不另建 Backup。

- **原位置入口（试用）**：可在归档后创建指向 Archive 的软链接，格式转换时使用输出扩展名；默认不覆盖已有文件。Agent 在获得明确授权后也可搬移原文件并保留链接。外部移动或重命名归档后，链接不会自动修复。
- **备份清理**：在“我的归档 → 备份”手动发起。清理前核对备份哈希，以及压缩输出或归档副本是否仍有效；冲突、失败和未完成状态会单独报告。不自动定期清理，也不在回收站失败后改为永久删除。
- **APFS 去重**：源与副本须在同一个 APFS 卷，逐项核对内容和元数据后共享底层存储。成功时移除旧存储副本，不另存一份完整旧备份；异常事务保留恢复信息。逻辑共享量不是实测磁盘释放量。

文件变小、移入 Backup、复制到 Archive 或移入回收站，都不等于已经释放了对应大小的磁盘空间。取消不会撤销已经提交的文件操作。

## 清理与工具箱的区别

工具箱中的 Purge、Installer 和 Uninstall 先生成候选，由用户审阅精确选择后移入回收站；Analyze 提供占用分析、目录钻取和大文件列表。扫描不完整、权限不足或超时会保留诊断，不能将部分结果当作完整扫描。

独立“清理”页的完整 Clean 则沿用 Mole 的直接删除和默认清空回收站行为，可能永久删除文件。系统级清理需要管理员授权，授权本身不会自动开始清理；预览不会删除文件，已发生的删除无法通过取消回滚。

详见 [Mole 模块说明](src/main/modules/mole/README.md)。

## 运行环境与快速开始

完整随包工具链面向 **Apple 芯片 Mac、macOS 15 及以上**。仓库内置的是 `darwin-arm64` 二进制；虽保留 Windows／Linux 的 Electron 打包脚本，这些平台尚不具备等价的完整本地工具链。APFS 去重和 Finder 标签依赖 macOS。

开发使用原生 arm64 Node.js 24 和 pnpm。下方命令遵循本仓库的 RTK 约定；未安装 RTK 时，可直接执行 `rtk proxy` 后面的原始命令。

```sh
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm dev
```

不使用 Agent 时，可直接操作本地功能；AI 标签推荐需要模型配置，失败会单独报告，不回滚已完成的压缩或归档。

### 配置模型

将项目根目录的 `.env.example` 复制为 `.env.local`，填入自己的配置后重启应用：

```dotenv
ARKIVE_AI_PROVIDER=openai-compatible
ARKIVE_AI_BASE_URL=https://your-provider.example/v1
ARKIVE_AI_MODEL=your-model-id
ARKIVE_AI_API_KEY=your-api-key
```

`openai-compatible` 用于实现流式 Chat Completions 的服务，`BASE_URL` 填 API 根地址，不含 `/chat/completions`。原生 Pi provider 使用对应 provider 和精确模型 ID；使用默认官方端点时留空 `BASE_URL`。

配置只由主进程读取，进程环境变量优先。`.env.local` 不应提交，不要给密钥加 `VITE_`／`MAIN_VITE_` 前缀或写入 Renderer。打包应用可使用运行时环境变量；本地打包开发还支持读取工作目录或构建项目根目录中的外部 `.env.local`，配置文件不进入安装包。目前没有面向终端用户的凭据设置界面。

### Agent 使用

新建对话后描述目标和文件路径，Enter 发送，Shift+Enter 换行。工具操作显示运行状态和业务结果；总结失败时可以重试总结，已完成的文件操作不会因此撤销。

| 快捷命令 | 场景 |
| --- | --- |
| `/concert` | 演唱会／大疆本地录像的检查、压缩、备份和归档 |
| `/wechat` | 用户指定的微信可读文件和视频；独立图片保留原位 |
| `/photos` | Lightroom 等导出的照片，默认建议保持 JPEG、画质优先 |

输入 `/` 可选择场景，补充需求后再发送；选择场景本身不代表授权修改文件。也支持原生 `/skill:<name>` 命令。详见 [内置场景说明](resources/skills/README.md)。

Agent 使用锁定的 Pi SDK 1.2.0，开放 `read`、`grep`、`find`、`ls` 和已注册的业务工具，不开放任意 shell、`edit` 或 `write`，也不自动发现项目或全局扩展、Skills 与指令文件。产品只加载 `resources/skills` 中的三个内置场景。

聊天记录与模型上下文保存在内存中，重载或重启后不保留；归档、备份及相关恢复状态保存在 SQLite 中。任务队列与任务结果同样只在当前进程内保留，不能替代持久化文件事务恢复。

### 数据边界

编码、校验、备份、归档和 SQLite 在本地执行。使用 Agent 或 AI 标签时，对话、工具结果以及用于推荐的文件名、路径和元数据可能发送到所配置的模型服务。自动标签不做图片画面识别、音视频识别、OCR 或全文分析，当前也没有语义向量检索。

Agent 的对话授权依赖产品提示和各项业务检查，部分操作另有原生确认；当前不是文件系统沙箱。微信场景不解密数据库或未知加密文件，照片场景不直接改写 Lightroom 图库。

## 构建与验证入口

```sh
# 类型检查并构建
rtk proxy pnpm run build

# macOS Apple Silicon 打包（先完成上面的构建）
rtk proxy pnpm exec electron-builder --mac --arm64
```

`build:mac` 当前直接调用 electron-vite 和 Electron Builder，不包含 `build` 脚本的类型检查步骤。随包工具复制到 `Contents/Resources/tools`，不放入 `app.asar`。当前配置关闭 notarization；打包成功不代表已经完成签名、公证、安装或生产入口验收。

以下是可手动运行的检查入口，不代表当前版本已全部执行或通过。测试生成文件使用项目约定的 `~/Desktop/arkive-test`；UI 检查前先构建，构建、打包和依赖 `out` 的检查应顺序执行。

```sh
rtk proxy pnpm run lint
rtk proxy pnpm run typecheck
rtk proxy node scripts/check-tasks.mjs
rtk proxy node scripts/check-compression-tasks.mjs
rtk proxy node scripts/check-processing-ui.mjs
rtk proxy node scripts/check-batch-compression-ui.mjs
rtk proxy node scripts/check-archive-links.mjs
rtk proxy node scripts/check-backup-cleanup.mjs
rtk proxy node scripts/check-clone-deduplication.mjs
rtk proxy node scripts/check-agent.mts
rtk proxy node scripts/check-agent-ui.mjs --skills
```

真实模型检查入口为 `scripts/check-agent-live.mjs`，需要有效配置和可达服务，可能产生模型费用。本地固定响应测试不证明真实模型能够自主正确判断授权。`scripts/check-packaged-runtime.mjs` 依赖已构建的 `dist/mac-arm64/arkive.app`。更多专项检查见各模块文档与 `scripts/`。

## 技术结构与随包组件

```text
src/renderer/       React 界面与交互
src/preload/        Renderer 与主进程的受限 IPC 桥接
src/shared/         请求、结果和事件契约
src/main/modules/   压缩、归档、标签、去重、清理和 Agent 业务
src/main/tasks/     共用 FIFO 任务队列、取消和防重复提交
src/main/storage/   SQLite 数据库与迁移
src/execution/      固定工具定位、进程执行和输出解析
resources/skills/   产品 Agent 的内置场景
resources/tools/    macOS arm64 随包工具及来源清单
native/             APFS 克隆去重 helper 源码
```

随包组件包括 FFmpeg／FFprobe、ab-av1、Mole、Czkawka、qpdf、pngquant、SSIMULACRA2 和 Arkive APFS helper。Sharp 作为 Node 库直接使用。版本、校验值、来源和许可证以 [工具 manifest](resources/tools/darwin-arm64/manifest.json) 和交付材料为准；当前不包含 Ghostscript。

产品入口通过业务服务选择工具、校验结果和保护文件；通用进程执行器不向 Renderer 或 Agent 暴露任意命令执行接口。

## 交付材料与详细说明

- [项目说明书](docs/最后提交说明文档/Arkive项目说明书.md)：产品定位、成员分工、功能与使用范围。
- [技术文档](docs/最后提交说明文档/Arkive技术文档.md)：架构、压缩策略、恢复与运行方式。
- [第三方来源与依赖说明](docs/最后提交说明文档/第三方来源与依赖说明.md)：组件来源、许可及待核验事项。
- [第三方依赖清单](docs/最后提交说明文档/第三方依赖完整清单.csv)与[随包工具清单](docs/最后提交说明文档/随包工具来源清单.json)。
- [演示材料](docs/presentation/README.md)与[实测记录说明](docs/measurements/Arkive展示实测清单.md)。
- 模块文档：[图片](src/main/modules/image-compression/README.md)、[PDF](src/main/modules/pdf-compression/README.md)、[Office](src/main/modules/office-compression/README.md)、[归档](src/main/modules/catalog/README.md)、[重复检测](src/main/modules/duplicate-detection/README.md)、[APFS 去重](src/main/modules/clone-deduplication/README.md)、[任务队列](src/main/tasks/README.md)。
