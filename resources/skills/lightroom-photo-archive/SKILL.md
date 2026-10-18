---
name: lightroom-photo-archive
description: 整理 Lightroom 等软件导出的本地照片，检查 JPEG 等受支持图片、保持格式压缩、备份完整原件、按活动标签归档与找回；适用于毕业照、旅行照或项目照片导出目录。
---

# Lightroom 导出照片压缩归档

处理用户选定的导出照片，不需要接入 Lightroom。执行前读取[共用工具契约](../references/arkive-tools.md)，按实际工具结果处理授权、备份、归档与失败续做。

## 确定目录与目标

区分只检查、压缩、压缩并归档及查找已有照片。找回请求直接检索，不重新压缩。

Lightroom 导出位置由用户设置，没有通用默认目录；优先使用对话中已给出的目录或文件夹名称，已知桌面目录可先只读定位，不重复询问已提供的路径。没有位置线索时请用户选择导出目录。仅枚举用户选定范围，不自动扫描 Lightroom Catalog、RAW 原片或照片图库；这不是图库级清理功能。

使用 `ls`／`find` 列候选，逐项 `inspect_image({ inputPath })` 检查格式、尺寸和大小。普通 8bit 静态图片按探测结果处理；RAW、HDR、多页、动画或工具拒绝的特殊文件保留并说明原因，不按扩展名强行转换。

## 提出方案

JPEG 导出照片默认建议 `preset: "quality"`、`preserveFormat: true`，新的输出路径沿用 `.jpg`／`.jpeg`，例如独立输出目录内的 `原名-arkive.jpg`。不同时传 `outputFormat`。PNG／WebP 可保持各自格式，其他格式按共用契约选择。父目录不存在时，在已授权方案内用 `mkdir` 创建。

说明 JPEG 重新编码属于有损处理；Lightroom 已压缩过也可能有进一步收益，不能保证压缩率、肉眼无差别或适合大幅印刷。工具不会主动缩小尺寸，会校正方向并更新受影响的元数据；查看实际 `metadataWarnings`，不能保证全部拍摄、版权或 Lightroom 编辑信息均保留。完整输入保存在 Backup，不代表备份了 Lightroom Catalog 或 RAW。

写操作方案列出输入范围、输出位置、档位、原件处理和标签。压缩有收益且校验成功后，输入文件会移到 `~/Arkive Backup/YYYY-MM-DD/`；导出文件夹中的原路径不再保留。用户需要导出目录保持原样时，先在获授权的测试／工作目录建立副本，再处理副本。仅要求看看时停在检查与建议。

用户确认整批方案即可继续，不逐张重复询问。可先试一至三张代表照片供用户验看；若约定先看效果再决定整批，则到此停下，不能把样本测试视作整批授权。

## 压缩、归档与检查

逐项调用 `compress_image`，压缩并归档的参数形状如下；将示例替换为本次实际路径和已授权标签：

```json
{
  "inputPath": "/absolute/exports/照片01.jpg",
  "outputPath": "/absolute/results/照片01-arkive.jpg",
  "preset": "quality",
  "preserveFormat": true,
  "archive": true,
  "tags": ["毕业照"]
}
```

只压缩时省略 `archive` 和 `tags`。已压缩结果在用户稍后授权归档时，使用 `archive_file({ id: catalog.id, tags })`，不重新编码。

核对 `status`、字节数、`outputFormat`、`metadataWarnings`、`qualityAnalysis` 及 Backup／Archive／标签状态。SSIMULACRA2 是参考，分数不等于人像肤色、细节或印刷效果通过验收；不因参考分低自行重跑其他档位。`no-savings` 时原件不移动、图片不自动归档，不宣称压缩成功，也不为完成场景自行删除、强制转 WebP 或补做未经授权的归档。失败按共用契约及记录 ID 续做。

标签先查已有词库，依据用户提供的活动、地点和文件名线索建议；不能从人像推断姓名。目录日期只作为命名线索，不擅自认定是 EXIF 拍摄日期。组合归档可能返回自动标签结果，失败与实际归档结果分别报告。

## 交付与找回

列出成功、无收益、不支持、失败和未处理数量，以及前后体积、输出、原件备份、归档 ID、标签和待验看项。文件体积减少不等于实际释放磁盘空间，副本和备份仍占空间；不默认清空 Backup 或导出目录。

按活动、标签或文件名使用 `search_archives` 找回；用户要求时通过 `open_archive` 打开或定位，系统打开请求不代表用户已验看画质。
