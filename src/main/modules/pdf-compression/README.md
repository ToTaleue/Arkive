# PDF 压缩 Service

主进程调用 `service.ts` 中的 `inspectPdf` 和 `compressPdf`。文档压缩页面通过 `processing` IPC、Agent 通过业务工具调用 `catalog/compression.ts`，共用同一个 Service、归档索引和备份生命周期。页面支持原生文件选择、Finder 拖入、检查、四档压缩、输出选择、取消和后续归档；Agent 的 `inspect_pdf` 只读探测。

```ts
const result = await compressPdf({
  inputPath: '/absolute/input.pdf',
  outputPath: '/absolute/output.pdf',
  preset: 'balanced'
})
```

- `lossless` 使用 qpdf 生成对象流并重压缩 Flate 流。
- `deep-lossless` 在 `lossless` 基础上使用 Flate 压缩等级 9；仍然无损，但更慢，体积收益需按样本验证。
- `balanced` 使用 Ghostscript `pdfwrite` 的 `/ebook` 预设。
- `size` 使用 Ghostscript `pdfwrite` 的 `/screen` 预设。
- 输出始终写入同目录临时文件，通过 qpdf 结构检查、页数检查和特征检查后，以不覆盖方式发布。
- 原件内容会保留；通过共用归档入口执行且有体积收益时，原件会在校验后备份到 Arkive Backup。输出没有体积收益时仍发布并返回 `status: 'no-savings'`。
- 加密 PDF、数字签名和 PDF/A 暂不处理；`balanced` 与 `size` 暂不处理表单、批注和附件。
- 支持 `AbortSignal`，取消后清理临时目录，不发布未完成输出。

验证：

```sh
rtk proxy node scripts/check-pdf-compression.mjs
rtk proxy node scripts/check-processing-ui.mjs
```

Ghostscript 当前随包工具是预发布 AGPL 构建，正式分发前仍需完成版本、来源和授权审核；qpdf 的版本和校验信息见 `resources/tools/darwin-arm64/manifest.json`。
