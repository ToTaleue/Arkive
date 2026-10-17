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
- `preset` 可选 `quality`、`balanced` 或 `size`，目标 SSIMULACRA2 分数暂为 90、85、80；Sharp 候选质量分别为 `92 → 98`、`85 → 95`、`80 → 92`，每个预设最多尝试两个候选质量。
- `outputFormat: 'png'` 仅接受 PNG 输入，调用内置 pngquant。JPEG 输出始终使用 Sharp 有损编码，不使用 jpegoptim。
- 透明图片输出 JPEG 必须提供 `jpegBackground: '#RRGGBB'`，不默认填充白底。

Sharp 编码参数是起始设置，尚未完成真实照片的画质标定。不同工具的质量数值不能等价比较。PNG 分支暂不接受单值 `quality`。

当前为可等待完成的 Service API，返回最终结果；有损路径会返回 SSIMULACRA2 目标、最终分数和尝试次数。图片 IPC 和前端测试页已经接入，Agent 也可通过 `compress_image` 调用同一 Service。前端流程会先选定文件和输出位置，再由用户明确点击开始；只读探测可用于后续 Agent 方案生成。

## 输出与限制

只处理普通 8bit 静态位图；实际解码能力由安装的 Sharp 决定，动画、多页和 HDR 等特殊输入暂拒绝。按真实格式选择工具，不依赖输入文件扩展名。

输出目录须已存在，输出后缀须匹配格式。原件和已有目标不覆盖；结果先写私有临时目录，通过尺寸、方向、透明度和完整解码检查后，以不覆盖方式发布。压缩会丢弃 EXIF、IPTC、XMP 等元数据，并在编码前把方向和颜色空间固化到像素中。无体积收益仍保留输出，返回 `status: 'no-savings'`、`savedBytes: 0`，不宣称释放磁盘空间。

不按 Documents、云盘、照片图库或微信数据库等用户目录限制输入输出；仅禁止向系统关键路径写入，并检查符号链接解析后的路径。格式与输出校验仍执行，原件不删除、不移入回收站。

当前输出统一丢弃元数据；颜色空间和方向在像素层处理。现有检查不代表完成感知画质验收，也不保证所有格式都能进行原格式输出。

支持 `AbortSignal`。Sharp 原生操作可能无法立即中断，Service 等操作结束后清理临时文件，不发布已接受取消的结果；原子发布开始后视为执行完成。

## 验证

```sh
rtk proxy node scripts/check-image-compression.mts
rtk proxy pnpm run typecheck
rtk proxy pnpm run lint
```

验证脚本在 `out/` 下生成并清理样本，通过真实 Sharp、通用进程执行器及 resources 内的 pngquant 验证 WebP、JPEG 和 PNG 路径、透明像素、方向固化、元数据丢弃、有限尝试次数、无收益输出、取消、路径保护和并发不覆盖。不读取真实用户图片，不代表真实照片压缩收益的评测。
