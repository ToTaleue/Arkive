# 大学生实地测试素材

本目录包含用户准备的原始测试材料及[场景测试计划](student-user-field-tests.md)。材料已收集，不代表实地测试已通过；执行结果另记到 `../measurements/`。

## 下载完整素材

大 PPT、视频、Illustrator 文件和 ZIP 母本分片使用 Git LFS。安装 Git LFS 后，在仓库根目录运行：

```sh
git lfs install --local
git lfs pull
python docs/student-field-test/restore-large-samples.py
```

部分 Mac 环境使用 `python3`。恢复脚本只使用 Python 3.11+ 标准库，不需要安装额外包。

`00-originals/地上设计888.zip` 大于 3 GB，按 512 MiB 分片保存为相邻的 `.part-001` 等文件。脚本按清单校验每片及完整文件的 SHA-256，然后在原位置恢复 ZIP；已存在且一致的原文件直接保留，内容不同则停止，不覆盖。完整 ZIP 在 Git 中忽略，分片保留在 LFS。

仅检查分片而不生成完整 ZIP：

```sh
python docs/student-field-test/restore-large-samples.py --verify-only
```

[sample-manifest.json](sample-manifest.json) 记录各原始样本的相对路径、字节数、SHA-256 与存储方式。原样本全量约 5.3 GiB；恢复完整 ZIP 后，本地还会同时保留其分片。Git LFS 本地对象也会占用磁盘。

GitHub 普通 Git 文件上限为 100 MiB，Git LFS 的单文件上限随账户方案而异，因此本目录保留原始测试内容并对超大母本分片。参考：[普通 Git 文件限制](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)、[Git LFS 文件限制](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)。

## 素材用途

- `00-originals/`：完整素材 ZIP 母本，处理前另取测试副本。
- `01-course-pdf/`：PDF 结构、阅读效果与压缩收益测试。
- `02-group-ppt/`：含媒体的小组展示 PPTX，原路径替换、备份与归档测试。
- `03-club-images/`：JPG、PNG 与 AI 文件；AI 属于不支持压缩项，不代表软件能解析 Illustrator 内容。
- `04-concert-video/`：MP4 原片，先由实际工具探测兼容性，再测试编码、备份及归档。

微信、邮件任务可从这些母本另复制布置，不能将模拟附件集合的结果当成真实微信／Mail 集成验收。当前文件夹未提供独立 DOCX，Word 专项测试仍需另准备普通含图文档。
