# 图片压缩 Service

主进程调用 `service.ts` 中的 `inspectImage` 和 `compressImage`。请求和结果类型以 `src/shared/contracts/image.ts` 为准。

```ts
const result = await compressImage({
  inputPath: '/absolute/input.png',
  outputPath: '/absolute/output.webp'
})
```

- 默认通过 Sharp 输出 WebP，并按 `balanced` 预设进行有损压缩。
- `preserveFormat: true` 保持 JPEG、PNG 或 WebP 原格式；PNG 使用内置 pngquant，JPEG 和 WebP 使用 Sharp。
- `preset` 可选 `quality`、`balanced` 或 `size`，Sharp 起始编码质量分别为 92、85、80；无体积收益时按 75、60、40、20、1 中低于起始值的档位继续试压，选中首个实际变小的结果，最多 6 次。显式 `quality` 也是起始值，无收益时采用同一递减策略。
- `outputFormat: 'png'` 仅接受 PNG 输入，调用内置 pngquant。三档起始质量区间分别为 `0-95`、`0-90`、`0-85`；无收益时依次尝试较低的 `0-80`、`0-60`、`0-40`、`0-20`，最多 5 次，不设置最低画质门槛。JPEG 输出始终使用 Sharp 有损编码。
- 透明图片输出 JPEG 必须提供 `jpegBackground: '#RRGGBB'`，不默认填充白底。

Sharp 编码参数是起始设置，尚未完成真实照片的画质标定。不同工具的质量数值不能等价比较。PNG 分支暂不接受单值 `quality`。

当前为可等待完成的 Service API，返回最终结果；仅对最终候选计算 SSIMULACRA2，返回参考值（90、85、80）、最终分数和编码尝试次数。质量分数不参与采用决策，低于参考值仍采用更小的候选。评分失败时 `score`、`meetsTarget` 为 null 并记录 `error`，不阻断有效压缩结果。图片 IPC 和前端测试页已经接入，Agent 也可通过 `compress_image` 调用同一 Service。前端流程会先选定文件和输出位置，再由用户明确点击开始；只读探测可用于后续 Agent 方案生成。

## 输出与限制

只处理普通 8bit 静态位图；实际解码能力由安装的 Sharp 决定，动画、多页和 HDR 等特殊输入暂拒绝。按真实格式选择工具，不依赖输入文件扩展名。

输出目录须已存在，输出后缀须匹配格式。原件和已有目标不覆盖；结果先写私有临时目录，通过尺寸、方向、透明度、元数据和完整解码检查后，以不覆盖方式发布。采用依据是包含元数据的最终输出实际变小；若所有候选都无收益，返回其中最小的有效输出并保留原件。无体积收益仍保留候选输出供检查，返回 `status: 'no-savings'`、`savedBytes: 0`，不宣称释放磁盘空间；产品继续使用原图，Finder 定位原图，不展示候选归档入口，即使 Agent 请求合并归档也跳过归档。

不按 Documents、云盘、照片图库或微信数据库等用户目录限制输入输出；仅禁止向系统关键路径写入，并检查符号链接解析后的路径。格式与输出校验仍执行，原件不删除、不移入回收站。

元数据在已有压缩流程内处理，不新增 Tool 或 Service。保留 EXIF 拍摄信息、设备和 GPS，以及 XMP 描述与关键词；按实际转正的像素尺寸、sRGB 转换和输出格式更新 EXIF／XMP 的方向、尺寸与颜色／格式字段。JPEG 保留 IPTC；PNG 在 Sharp 归一化后由 pngquant 量化，再补回元数据块，保留量化后的调色板和透明度。XML 处理使用 `fast-xml-parser`／`fast-xml-validator` 与显式依赖的 `fast-xml-builder`，不使用已弃用的 Builder 导出。

WebP／PNG 无法承载的原始 IPTC、转换格式后无法保留的 PNG 文本块或 Photoshop 数据块，通过可选 `metadataWarnings` 返回；图片页面展示，Agent 按实际结果说明，完整信息仍在原件中。元数据损坏或应保留的内容校验失败时不发布输出。当前未接 AI 元数据分析或自动标签；现有检查不代表完成感知画质验收，也不保证所有格式都能进行原格式输出。

支持 `AbortSignal`。Sharp 原生操作可能无法立即中断，Service 等操作结束后清理临时文件，不发布已接受取消的结果；原子发布开始后视为执行完成。

## 验证

```sh
rtk proxy node scripts/check-image-compression.mts
rtk proxy pnpm run typecheck
rtk proxy pnpm run lint
```

验证脚本在 `~/Desktop/arkive-test/image-check-*` 下生成并清理样本，通过真实 Sharp、通用进程执行器及 resources 内的 pngquant 验证 WebP、JPEG 和 PNG 路径、EXIF 日期／设备／GPS、XMP 关键词与命名空间、PNG 文本、方向／尺寸／ICC 更新、IPTC 保留与格式限制报告、损坏 XMP 拒绝、最终体积、透明像素、有限尝试次数、无收益输出、取消、路径保护和并发不覆盖。不读取真实用户图片，不代表真实照片压缩收益的评测。
