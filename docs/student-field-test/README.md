# 大学生实地测试记录

本目录保留[场景测试计划](student-user-field-tests.md)与[历史素材清单](sample-manifest.json)。素材曾被收集不代表实地测试已通过；执行结果另记到 `../measurements/`。

2026-10-18 清理了仓库中的原始测试素材：ZIP 母本分片、课程 PDF、小组 PPTX、JPG、PNG、Illustrator 文件及 MP4 原片，同时移除了分片恢复脚本和对应的 Git LFS 规则。素材清单中的路径、大小、校验和与 `storage` 字段记录清理前的状态，不表示文件仍随当前仓库提供；`git lfs pull` 无法在当前版本补齐这些样本。

## 后续测试

另行准备有权使用的样本，放在 `~/Desktop/arkive-test` 下的独立测试目录。项目指定的 Mac 基准路径为 `/Users/hu1hui/Desktop/arkive-test`，不要将测试原件重新提交到源码仓库。

历史素材用途如下，具体测试步骤见场景测试计划：

- `00-originals/`：完整素材 ZIP 母本，处理前另取测试副本。
- `01-course-pdf/`：PDF 结构、阅读效果与压缩收益测试。
- `02-group-ppt/`：含媒体的小组展示 PPTX，原路径替换、备份与归档测试。
- `03-club-images/`：JPG、PNG 与 AI 文件；AI 属于不支持压缩项，不代表软件能解析 Illustrator 内容。
- `04-concert-video/`：MP4 原片，先由实际工具探测兼容性，再测试编码、备份及归档。

微信、邮件任务可另复制样本布置，不能将模拟附件集合的结果当成真实微信／Mail 集成验收。历史素材未提供独立 DOCX，Word 专项测试仍需另准备普通含图文档。
