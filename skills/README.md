# Arkive 业务场景 Skills

本目录集中保存 Arkive 内置 Agent 的三个业务场景 Skill，供后续接入应用。每个场景使用独立的 `SKILL.md`，共用一份工具契约，避免重复维护压缩、备份与归档规则。

| Skill                                                       | 适用需求                                                | 当前能力组合                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| [concert-video-archive](concert-video-archive/SKILL.md)     | 大疆 Pocket、演唱会等珍贵录像太大，希望压缩后保留、找回 | 视频探测、HEVC 压缩、原件备份、标签归档与检索                              |
| [wechat-file-archive](wechat-file-archive/SKILL.md)         | 微信可读文件积累，需要分类整理、去重、压缩归档          | 文件枚举、格式探测、重复检测、按文件压缩、归档；按需 APFS 去重或回收站处理 |
| [mail-attachment-archive](mail-attachment-archive/SKILL.md) | 毕业或项目结束，整理某个阶段的本地邮件附件              | 已导出附件检查、按格式压缩、标签归档、检索；按需清理独立附件副本           |

## 目录与使用方式

```text
skills/
├── README.md
├── references/
│   └── arkive-tools.md
├── concert-video-archive/
│   └── SKILL.md
├── wechat-file-archive/
│   └── SKILL.md
└── mail-attachment-archive/
    └── SKILL.md
```

根据请求选择一个场景入口，再读取该入口指向的[共用工具契约](references/arkive-tools.md)。相对路径以文档所在目录为基准。迁移时保留整个目录结构，共用引用不是可独立安装的第四个 Skill。

这些文件是应用业务指令，不放入面向开发助手的 `.agents/skills/`。本次只新增文档；`src/main/modules/agent/session.ts` 的 `getSkills()` 仍返回空数组，应用暂时不会自动发现或执行它们。后续加载接线需要显式注册这三个入口，并保留引用文件的可读取路径。

Skill 的发现或用户提到某个场景，只用于选择流程，不等于授权修改文件。执行时沿用真实用户已经给出的授权；同一批方案已获授权时直接继续，只有范围、处理方式或影响发生变化时才补充确认。授权仍主要由 Agent 指令判断，文档不构成程序级沙箱或审批机制。

## 与当前实现的对应关系

本版依据 2026-10-17 当前源码编写。工具名、参数和结果以运行时实际注册的工具为准；更新接口时同步维护共用契约及涉及的场景分支。

- [工具注册与参数](../src/main/modules/agent/tools.ts)、[系统 Prompt](../src/main/modules/agent/prompt.ts)、[会话资源加载](../src/main/modules/agent/session.ts)。
- [压缩与备份收尾](../src/main/modules/catalog/compression.ts)、[Catalog 实现](../src/main/modules/catalog/service.ts)、[归档与标签说明](../src/main/modules/catalog/README.md)。
- [视频检查与编码](../src/main/modules/video-compression/service.ts)、[Office 原位发布](../src/main/modules/office-compression/in-place.ts)。
- [重复检测](../src/main/modules/duplicate-detection/README.md)、[APFS 去重](../src/main/modules/clone-deduplication/README.md)、[文件操作](../src/main/modules/file-operations/README.md)。

## 接入后的验收案例

下表是待执行的行为验收标准，不代表已用真实模型或真实业务资料通过验证。文件操作测试仅使用 `~/Desktop/arkive-test` 中自行生成的样本；项目记录的 Mac 路径为 `/Users/hu1hui/Desktop/arkive-test`，Windows 对应 `C:\Users\steph\Desktop\arkive-test`。

| 请求或情况                               | 应有行为                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| “先看这段演唱会录像，别压缩”             | 仅探测并提出方案，不编码、归档或创建目录                                |
| 视频包含 DJI 数据、字幕或时间码          | 根据 `removedContents` 说明损失；完整原件备份纳入执行方案               |
| 用户要求 HDR 或 H.264 输出               | 如实说明当前限制，保留文件，不自行转成另一种已拒绝的处理方式            |
| “整理这个微信导出目录”                   | 范围限定在该目录；按格式检查，不根据目录名推断整个微信均可清理          |
| 微信数据库或未知加密文件                 | 列为保留／未支持项，不尝试解密、压缩归档或连带清理                      |
| “归档大学期间的邮件附件”但未提供导出目录 | 先获得范围或已导出的附件，不将文件修改时间当作邮件收发时间              |
| 压缩返回 `no-savings`                    | 报告无体积收益；核对实际归档与 `backupStatus=skipped`，不谎称已节省空间 |
| 压缩成功但归档失败                       | 保留记录 ID，按 ID 重试归档，不重新编码已经移走的输入                   |
| DOCX／PPTX 压缩候选成功但发布失败        | 根据 `replacementStatus` 判失败，保留恢复线索，不宣称文档替换或归档完成 |
| 重复扫描不完整、清理部分失败或用户取消   | 分别报告已完成、失败和未处理项目；不回滚已提交文件，不扩展清理范围      |
| “找回之前归档的文件”                     | 检索现有记录；用户要求打开或定位时按 ID 操作，不重新压缩                |

文档结构校验不能替代上述运行验证。macOS 编码、Finder 标签、APFS 和真实 Mail／微信使用效果需要在对应环境另行验收。
