# 图片压缩 Service

主进程调用 `service.ts` 中的 `inspectImage` 和 `compressImage`。请求和结果类型以 `src/shared/contracts/image.ts` 为准。

```ts
const result = await compressImage({
  inputPath: '/absolute/input.png',
  outputPath: '/absolute/output.webp'
})
```

- 默认通过 Sharp 输出 WebP，起始质量为 80。
- `outputFormat: 'png'` 仅接受 PNG 输入，调用内置 pngquant，使用其默认量化参数。
- JPEG 输入、`outputFormat: 'jpeg'` 时调用内置 jpegoptim。省略 `quality` 使用默认无损优化；显式传入时作为 `--max` 质量上限。
- `compatibility: true` 输出 JPEG：JPEG 输入仍用 jpegoptim，其他输入通过 Sharp 转换。与显式 PNG／WebP 输出冲突时拒绝请求。
- 透明图片输出 JPEG 必须提供 `jpegBackground: '#RRGGBB'`，不默认填充白底。

Sharp 编码参数是起始设置，尚未完成真实照片的画质标定。不同工具的质量数值不能等价比较。PNG 分支暂不接受单值 `quality`。

当前为可等待完成的 Service API，返回最终结果；尚未接入图片 IPC、任务队列或 Agent 工具。执行入口应由用户确认后的业务流程调用。只读探测可用于后续 Agent 方案生成。

## 输出与限制

只处理普通 8bit 静态位图；实际解码能力由安装的 Sharp 决定，动画、多页和 HDR 等特殊输入暂拒绝。按真实格式选择工具，不依赖输入文件扩展名。

输出目录须已存在，输出后缀须匹配格式。原件和已有目标不覆盖；结果先写私有临时目录，通过尺寸、方向、透明度、元数据和完整解码检查后，以不覆盖方式发布。无体积收益仍保留输出，返回 `status: 'no-savings'`、`savedBytes: 0`，不宣称释放磁盘空间。

不按 Documents、云盘、照片图库或微信数据库等用户目录限制输入输出；仅禁止向系统关键路径写入，并检查符号链接解析后的路径。格式与输出校验仍执行，原件不删除、不移入回收站。

Sharp 显式保留元数据；EXIF 允许编码器重新序列化。内置 macOS pngquant 可能移除元数据：若检测到丢失 EXIF、ICC、XMP 等信息，则拒绝发布，不绕过检查。现有检查不代表完成感知画质验收，也不保证所有格式的私有元数据可迁移。

支持 `AbortSignal`。Sharp 原生操作可能无法立即中断，Service 等操作结束后清理临时文件，不发布已接受取消的结果；原子发布开始后视为执行完成。

## 验证

```sh
rtk proxy node scripts/check-image-compression.mts
rtk proxy pnpm run typecheck
rtk proxy pnpm run lint
```

验证脚本在 `out/` 下生成并清理样本，通过真实 Sharp、通用进程执行器及 resources 内的 pngquant／jpegoptim 验证四条策略、透明像素、JPEG 无损像素一致性、元数据、无收益输出、取消、路径保护和并发不覆盖。不读取真实用户图片，不代表真实照片压缩收益的评测。

内置 jpegoptim 是预发布构建，`--nofix` 与有损 `--max` 组合在有效样本上触发警告并退出失败。因此 Service 先用 Sharp 严格解码输入，再运行 jpegoptim，并独立验证输出，不使用该组合。
