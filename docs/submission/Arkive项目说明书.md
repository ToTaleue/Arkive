# Arkive 项目说明

Techathon 2026 参赛说明文档  2026 年 10 月 17 日

## 一 项目概况与团队

Arkive 是面向存量文件的桌面压缩与归档应用，优先支持 Apple 芯片 Mac。项目帮助用户处理不常用但仍有价值的视频、图片和文档：生成可用的压缩结果，保留完整原件，并把需要长期保存的结果整理为可检索的归档。用户既可通过界面操作，也可通过 Agent 调用已有业务工具。

本说明书供 Techathon 2026 资格审核和项目评审使用，涵盖项目功能、自主设计、技术实现、部署与验证，以及第三方来源和原创版权声明。文中分别标明已有实现、待联测和规划能力，不把尚未验证的效果作为实测成果。

| 项目字段 | 内容 |
| --- | --- |
| 项目名称 | Arkive |
| 文档日期 | 2026 年 10 月 17 日 |
| 软件版本 | 1.0.0  项目 package.json 标识 |
| 产品定位 | 面向存量文件的本地压缩与归档工作空间 |

### 成员与分工

| 成员 | 主要分工 |
| --- | --- |
| 葛俊辉 | 后端开发  负责业务服务与本地处理能力编写 |
| 方子硕 | UI 与测试  负责界面设计实现和测试验证 |

### 代码与材料

代码仓库：[ToTaleue/Arkive](https://github.com/ToTaleue/Arkive)。
本说明与展示 PPT 是配套附件。提交前核对远端附件、评委访问权限与正式入口；核心实现、部署步骤和测试证据见后文。

## 二 功能与使用流程

| 功能 | 当前设计与实现 | 状态与范围 |
| --- | --- | --- |
| 图片压缩 | 使用 Sharp 和 pngquant，检查方向、尺寸、透明度与元数据，采用有效且更小的输出。 | 已有实现<br>Windows 样本回归 |
| 视频与 PDF | 视频结合 FFmpeg 和 ab-av1 选参；PDF 使用 Ghostscript 与 qpdf。 | 已有入口<br>素材分别验收 |
| Office 文档 | 处理普通 DOCX 和 PPTX 包内媒体，校验整份文档，完整备份后在原路径发布。 | 已有实现<br>复杂文档待标定 |
| 备份与归档 | Backup 保存完整原件；Archive 保存压缩副本。支持文件名、标签和日期查询。 | 已有实现<br>Finder 标签需 Mac |
| 重复文件处理 | 只读哈希检测重复组；APFS 克隆替换保留路径与独立修改能力。 | 已有服务与工具<br>同卷 Mac 专项 |
| Agent 与工具箱 | Pi SDK 对话、业务工具调用、Mole 分析与预览，以及授权后的文件操作。 | 已有接线<br>真实模型待联测 |
| 后续场景 | AI 标签建议已有独立 Service；冷数据报告与微信可读附件专用流程待集成。 | 联动待接入<br>专用场景属规划 |

### 普通媒体处理流程

- 选择文件、处理档位和输出位置，主动开始压缩。
- 编码与文件校验通过且体积减小时，将完整原件移入 Backup；失败、提交前取消或无收益时不移动原件。
- 按需归档压缩结果，复制后做 SHA-256 校验再发布；随后可添加标签、检索并打开归档副本。

Office 使用完整原件备份后原位替换的单独流程。APFS 去重也与普通备份分开：验证后移除旧存储副本，不另保留一份完整旧备份。备份与额外副本仍占磁盘，文件体积差额不等于实际释放空间。

## 三 技术方案与自主设计

### 架构与模块

交互层使用 Electron、React、TypeScript 与 assistant-ui。预加载层向界面提供明确的 IPC 契约，Agent 在主进程中通过 Pi SDK 调用受限的业务工具。界面与 Agent 复用同一组业务操作，避免两套互不一致的压缩和归档规则。

Task FIFO 对已接入的业务操作进行串行调度，提供防重复提交、状态查询、取消与退出收尾。队列只保留在进程内，不是持久化任务历史。Catalog 使用 node:sqlite 记录文件路径及备份、归档等状态，并恢复未完成的发布事务。

执行层通过固定的本地工具入口调用随包二进制，传递原始参数而不拼接任意 shell。APFS 去重 helper 使用 fclonefileat 和原子交换，配合逐字节比较、元数据核验及异常恢复。

### 自主设计与集成改良

- 统一界面与 Agent 的业务入口，将编码、校验、原件处理和按需归档组织为同一业务流程。
- 区分完整原件、压缩输出和归档副本，持久化记录状态，支持按记录重试、拒绝覆盖和部分失败反馈。
- 为 APFS 重复内容设计明确路径授权、克隆替换、逐项核验及保留恢复数据的事务流程。
- 设计压缩、归档和 Agent 工作空间，提供文件级状态、错误提示、主题切换与可检索的归档体验。

### 数据与操作边界

本地文件处理不等于所有请求离线。模型服务可能接收对话、工具结果及用户授权提供的文件信息；密钥仅由主进程读取，不在前端公开。Agent 的授权策略主要由系统提示约束，并非所有工具都具有统一的程序强制确认层，也不构成文件系统沙箱。

删除类操作应按已展示并获得授权的路径执行，常规清理采用回收站；底层也有需明确授权的永久删除能力。APFS 的旧存储副本移除遵循专门的事务语义。项目不承诺处理微信加密数据库或加密图片，不承诺零风险、固定压缩率或固定磁盘收益。

核心核验位置：src/main/tasks、src/main/modules/catalog、src/main/modules/agent、src/main/modules/clone-deduplication、src/execution，以及 src/renderer/src。

## 四 部署与复现

完整测试基线为 Apple 芯片 Mac、macOS 15 或更新系统，以及原生 arm64 Node.js 24。随包资源仅有 darwin-arm64；qpdf 的最低系统标记为 macOS 15。APFS helper 自身要求 macOS 13 及以上，并且源文件与副本位于同一 APFS 卷。Windows 可用于已有界面与部分业务验证，不能代替完整 Mac 验收。

### 获取源码与开发运行

```sh
git clone --branch feat/agent-and-service \
  https://github.com/ToTaleue/arkive-demo.git
cd arkive-demo
git checkout b2e91b0907966762fe5017f502e68f486c5fd3a2
node scripts/prepare-macos-test.mjs
npx --yes pnpm@10.34.7 install --frozen-lockfile
npx --yes pnpm@10.34.7 run build
npx --yes pnpm@10.34.7 run dev
```

预检会适配当前账户的测试路径、恢复工具执行权限并检查版本；它会修改仓库中的测试文件，不执行 Mole 清理。测试样本统一放在当前用户的 ~/Desktop/arkive-test。原开发环境中的 /Users/hu1hui/Desktop/arkive-test 不应直接照搬到他人账户。

### 模型配置

本次展示选定的模型为 Deepseek V4.1 Flash。API 服务商、接口实际使用的模型 ID 与 BASE_URL 随演示配置记录；模型已选定不等于真实模型端到端联测已通过。项目没有随包模型权重。复制 .env.example 为 .env.local，填写主进程配置并重启：

```sh
ARKIVE_AI_PROVIDER=openai-compatible
ARKIVE_AI_BASE_URL=https://服务商地址/v1
ARKIVE_AI_MODEL=实际模型ID
ARKIVE_AI_API_KEY=本人API密钥
```

兼容接口需支持流式 Chat Completions；BASE_URL 填 API 根地址，不附加 /chat/completions。不得提交密钥。打包版不自动读取开发用 .env.local，应在启动时提供运行环境变量；当前没有面向终端用户的凭据配置界面。

### 构建演示包

```sh
npx --yes pnpm@10.34.7 run build
npx --yes pnpm@10.34.7 exec electron-builder --mac --arm64
```

构建结果以 dist 中实际输出为准。当前配置 notarize 为 false，appId 和更新地址仍含模板信息，不能把产物认定为已完成签名、公证与生产分发。详细测试顺序见 docs/macos-install-test.md。

## 五 验证结果与现场演示

以下结果引用 docs/windows-fix-verification-2026-10-17.md，属于 2026 年 10 月 17 日的 Windows 回归记录；本说明书编制不代表重跑全部产品测试，也不将本地 HTTP 模型夹具等同于真实模型验收。

| 检查集合 | 已有结果 | 边界 |
| --- | --- | --- |
| 队列 解析与路径保护 | 29 项通过 | Windows 生成样本 |
| 文件系统回归 | 5 项通过 | 落盘 幂等 拒绝覆盖等 |
| 综合功能检查 | 30 项通过 0 失败 | 7 项受限或待实现单独记录 |
| 类型检查 构建与 ESLint | 通过 0 错误 | 仍有既有 CRLF 格式警告 |

实际覆盖包括生成样本的 WebP 压缩、完整原件备份、归档副本哈希与重复归档幂等、路径保护及界面文件名显示。Mac 原生工具、Finder 标签、真实模型行为、复杂素材与跨平台显示仍需对应环境验收。

### 复现检查入口

```sh
npx --yes pnpm@10.34.7 run typecheck
node scripts/check-tasks.mjs --ipc
node scripts/check-agent.mts
node scripts/check-processing-ui.mjs
```

后两项使用隔离生成样本与本地模型响应夹具，不需要真实 API 密钥。按模块扩展测试命令见项目 README 与各模块 README；真实模型测试 check-agent-live.mjs 应在配置服务后单独运行。

## 六 第三方来源与模型数据说明

应用使用 Electron、React、TypeScript、assistant-ui、Pi SDK、Sharp、Lucide、Markdown 及 XML 和 ZIP 处理库。直接依赖的名称、锁定版本、许可证与上游来源完整列于配套《第三方来源与依赖说明》；锁文件中的 930 个包版本另附 CSV 清单。许可字段来源于本地包元数据或对应版本的 npm 注册元数据，不等于已完成再分发审查。

| 随包工具 | 清单版本 | 清单许可 |
| --- | --- | --- |
| FFmpeg | 9.0.2 | GPL-3.0-or-later |
| FFprobe | 9.0.2 | GPL-3.0-or-later |
| ab-av1 | 0.11.7 | MIT |
| Mole | 1.59.1 | GPL-3.0-only |
| Czkawka CLI | 12.0.2 | MIT |
| qpdf | 12.4.2 | Apache-2.0 |
| pngquant | 3.0.3 | GPL-3.0-or-later |
| SSIMULACRA2 | 0.5.2 | BSD-2-Clause |
| Ghostscript | 10.09.0 预发布 | AGPL-3.0-or-later |

工具来源、SHA-256、下载地址与许可文件位置以 resources/tools/darwin-arm64/manifest.json 为准。APFS helper 是项目内 native/apfs-dedupe.c 编译的第一方工具，不属于上述第三方工具列表。

Ghostscript 当前是经 Clop 固定提交取得的预发布构建，构建来源与随包声明仍需补齐；pngquant 的二进制来源与再分发材料也保留待核验标记。项目根目录目前没有统一的 LICENSE，不能把第三方的 MIT 等许可自动视为整个应用的对外许可。

### 模型 API 与数据集

展示模型为 Deepseek V4.1 Flash。API 服务商、准确模型 ID、公开来源链接与实际测试结果随演示配置和实测记录补充。应用提供可配置的服务接口，不宣称训练或微调自有基础模型。Pi SDK 属于框架依赖，不等于所调用的模型；模型选型与真实模型联测状态分别记录。

本材料未申报训练数据集。已有回归主要使用程序生成的图片、文档、目录样本和本地 HTTP 响应夹具。若正式演示采用 DJI 原片或其他第三方素材，应附素材来源与使用授权；不能因支持处理某种素材就声称拥有其版权。展示文稿与文档使用 AI 工具辅助编辑，功能事实以源码和验证材料为准。

## 七 原创版权声明与交付对应

以下声明供队伍成员审阅并签署，签名栏留待本人确认，不构成已经完成的电子签署。

我们作为 Arkive 项目参赛成员，确认本队提交的自主成果包括产品与交互设计、业务流程编排、文件状态管理、原件与结果保护、APFS 去重事务及相关集成代码和测试工作。本队不将第三方编解码器、框架、模型或素材声称为自行发明或独占拥有。

本队承诺提交材料如实反映项目来源、实现状态和验证范围，不抄袭、剽窃他人成果，不把已知未完成的功能写成已实测通过。对引用、集成或参考的第三方组件、模型和素材，按照本说明与附件列明来源，并保留原作者署名、许可证及相关权利声明。

本队自主编写部分的权利与第三方组件的原有权利分别保留。本声明不改变第三方的授权条件，也不替代对外发布前的来源与许可核对。


## 配套附件

- [第三方来源与依赖说明](第三方来源与依赖说明.md)
- [第三方依赖完整清单](第三方依赖完整清单.csv)
- [随包工具来源清单](随包工具来源清单.json)
