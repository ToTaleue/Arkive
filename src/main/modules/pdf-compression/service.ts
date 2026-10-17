import { createReadStream } from 'node:fs'
import { link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { runBundledTool } from '../../../execution/process'
import type {
  PdfCompressionPreset,
  PdfCompressionRequest,
  PdfCompressionResult,
  PdfFeatures,
  PdfInspection
} from '../../../shared/contracts/pdf'
import { assertSystemWriteAllowed } from '../../system-paths'

export type {
  PdfCompressionPreset,
  PdfCompressionRequest,
  PdfCompressionResult,
  PdfInspection
} from '../../../shared/contracts/pdf'

const qpdfJsonOutputLimit = 8 * 1024 * 1024

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNestedEntry(
  value: unknown,
  predicate: (key: string, nested: unknown) => boolean
): boolean {
  if (Array.isArray(value)) return value.some((item) => hasNestedEntry(item, predicate))
  if (!isRecord(value)) return false
  return Object.entries(value).some(
    ([key, nested]) => predicate(key, nested) || hasNestedEntry(nested, predicate)
  )
}

async function containsAsciiMarker(path: string, markers: readonly string[]): Promise<boolean> {
  const stream = createReadStream(path)
  let carry = ''
  try {
    for await (const chunk of stream) {
      const bytes: unknown = chunk
      if (!Buffer.isBuffer(bytes)) throw new Error('读取 PDF 时收到非字节数据。')
      const text = carry + bytes.toString('latin1')
      if (markers.some((marker) => text.includes(marker))) return true
      carry = text.slice(-Math.max(...markers.map((marker) => marker.length)))
    }
    return false
  } finally {
    stream.destroy()
  }
}

async function runQpdfJson(inputPath: string, signal?: AbortSignal): Promise<JsonRecord> {
  const result = await runBundledTool('qpdf', ['--json', inputPath], {
    signal,
    killTreeOnAbort: true,
    maxOutputChars: qpdfJsonOutputLimit
  })
  if (result.exitCode !== 0 || result.signal) {
    const details = (result.stderr || result.stdout).slice(-4096)
    throw new Error(`无法读取 PDF 结构：${details || 'qpdf 处理失败。'}`)
  }
  if (result.stdoutTruncated) throw new Error('PDF 结构报告过大，未生成压缩输出。')
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error('PDF 结构报告格式无效，未生成压缩输出。')
  }
  if (!isRecord(parsed)) throw new Error('PDF 结构报告格式无效，未生成压缩输出。')
  return parsed
}

async function checkQpdf(inputPath: string, signal?: AbortSignal): Promise<void> {
  const result = await runBundledTool('qpdf', ['--check', inputPath], {
    signal,
    killTreeOnAbort: true,
    maxOutputChars: 64 * 1024
  })
  if (result.exitCode !== 0 || result.signal) {
    const details = (result.stderr || result.stdout).slice(-4096)
    throw new Error(`PDF 结构检查失败：${details || 'qpdf 检查失败。'}`)
  }
}

function extractFeatures(document: JsonRecord, hasPdfA: boolean): PdfFeatures {
  const encrypt = isRecord(document.encrypt) ? document.encrypt : undefined
  const acroform = isRecord(document.acroform) ? document.acroform : undefined
  const attachments = isRecord(document.attachments) ? document.attachments : undefined
  const fields = acroform?.fields
  const hasForms =
    acroform?.hasacroform === true ||
    (Array.isArray(fields) && fields.length > 0) ||
    hasNestedEntry(document, (key) => key === '/AcroForm')
  const hasSignatures = hasNestedEntry(
    document,
    (key, value) => (key === '/FT' && value === '/Sig') || (key === '/Type' && value === '/Sig')
  )
  const hasAnnotations = hasNestedEntry(
    document,
    (key, value) =>
      key === '/Annots' || (key === 'annotations' && Array.isArray(value) && value.length > 0)
  )
  const hasAttachments =
    (attachments !== undefined && Object.keys(attachments).length > 0) ||
    hasNestedEntry(
      document,
      (key) => key === '/EmbeddedFiles' || key === '/Filespec' || key === '/AF'
    )
  const hasOutlines =
    (Array.isArray(document.outlines) && document.outlines.length > 0) ||
    hasNestedEntry(document, (key) => key === '/Outlines')
  const encrypted = encrypt?.encrypted === true
  return {
    encrypted,
    hasForms,
    hasSignatures,
    hasAnnotations,
    hasAttachments,
    hasOutlines,
    hasPdfA
  }
}

async function inspectInput(inputPath: string, signal?: AbortSignal): Promise<PdfInspection> {
  signal?.throwIfAborted()
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error('输入须为本地绝对路径。')
  }
  const input = await realpath(inputPath)
  const inputStat = await stat(input)
  if (!inputStat.isFile()) throw new Error('输入须为普通 PDF 文件。')
  if (extname(input).toLowerCase() !== '.pdf') throw new Error('输入文件扩展名须为 .pdf。')
  if (await containsAsciiMarker(input, ['/Encrypt'])) {
    throw new Error('当前不处理加密 PDF；请提供未加密副本。')
  }
  await checkQpdf(input, signal)
  const document = await runQpdfJson(input, signal)
  const encrypt = isRecord(document.encrypt) ? document.encrypt : undefined
  if (encrypt?.encrypted === true) throw new Error('当前不处理加密 PDF；请提供未加密副本。')
  const pages = document.pages
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('PDF 没有可处理的页面。')
  const hasPdfA =
    hasNestedEntry(document, (key) => key === '/OutputIntents') ||
    (await containsAsciiMarker(input, ['pdfaid:part', 'pdfaid:conformance', 'GTS_PDFA']))
  return {
    inputPath: input,
    originalBytes: inputStat.size,
    pageCount: pages.length,
    features: extractFeatures(document, hasPdfA)
  }
}

function blockedFeatures(features: PdfFeatures, preset: PdfCompressionPreset): string[] {
  const blocked: string[] = []
  if (features.hasSignatures) blocked.push('数字签名')
  if (features.hasPdfA) blocked.push('PDF/A')
  if (preset !== 'lossless') {
    if (features.hasForms) blocked.push('表单')
    if (features.hasAnnotations) blocked.push('批注')
    if (features.hasAttachments) blocked.push('附件')
  }
  return blocked
}

function featuresEqual(before: PdfFeatures, after: PdfFeatures): boolean {
  return (
    before.encrypted === after.encrypted &&
    before.hasForms === after.hasForms &&
    before.hasSignatures === after.hasSignatures &&
    before.hasAnnotations === after.hasAnnotations &&
    before.hasAttachments === after.hasAttachments &&
    before.hasOutlines === after.hasOutlines &&
    before.hasPdfA === after.hasPdfA
  )
}

async function runCompression(
  preset: PdfCompressionPreset,
  inputPath: string,
  outputPath: string,
  signal?: AbortSignal
): Promise<'qpdf' | 'ghostscript'> {
  if (preset === 'lossless') {
    const result = await runBundledTool(
      'qpdf',
      [
        '--object-streams=generate',
        '--compress-streams=y',
        '--recompress-flate',
        inputPath,
        outputPath
      ],
      { signal, killTreeOnAbort: true, maxOutputChars: 64 * 1024 }
    )
    if (result.exitCode !== 0 || result.signal) {
      const details = (result.stderr || result.stdout).slice(-4096)
      throw new Error(`qpdf 无损优化失败：${details || 'qpdf 处理失败。'}`)
    }
    return 'qpdf'
  }
  const settings = preset === 'size' ? '/screen' : '/ebook'
  const result = await runBundledTool(
    'ghostscript',
    [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-dQUIET',
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.7',
      `-dPDFSETTINGS=${settings}`,
      `-sOutputFile=${outputPath}`,
      inputPath
    ],
    { signal, killTreeOnAbort: true, maxOutputChars: 64 * 1024 }
  )
  if (result.exitCode !== 0 || result.signal) {
    const details = (result.stderr || result.stdout).slice(-4096)
    throw new Error(`Ghostscript PDF 压缩失败：${details || 'Ghostscript 处理失败。'}`)
  }
  return 'ghostscript'
}

/** Read-only main-process API used by UI proposals and Agent planning. */
export async function inspectPdf(request: { inputPath: string }): Promise<PdfInspection> {
  return inspectInput(request.inputPath)
}

/** Generate a validated PDF copy. The source and existing targets are never overwritten. */
export async function compressPdf(
  request: PdfCompressionRequest,
  signal?: AbortSignal
): Promise<PdfCompressionResult> {
  signal?.throwIfAborted()
  const preset = request.preset ?? 'balanced'
  if (!['lossless', 'balanced', 'size'].includes(preset)) throw new Error('未知的 PDF 压缩档位。')
  if (
    typeof request.outputPath !== 'string' ||
    !isAbsolute(request.outputPath) ||
    extname(request.outputPath).toLowerCase() !== '.pdf'
  ) {
    throw new Error('输出须为本地绝对路径，扩展名须为 .pdf。')
  }
  await assertSystemWriteAllowed(request.outputPath)
  const { inputPath, originalBytes, pageCount, features } = await inspectInput(
    request.inputPath,
    signal
  )
  const blocked = blockedFeatures(features, preset)
  if (blocked.length > 0) {
    throw new Error(`当前 PDF 包含暂不支持安全重写的内容：${blocked.join('、')}。`)
  }
  const outputDirectory = await realpath(dirname(request.outputPath))
  const outputPath = join(outputDirectory, basename(request.outputPath))
  const existing = await lstat(outputPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing) throw new Error('输出路径已存在，不覆盖原件或已有文件。')

  const temporaryDirectory = await mkdtemp(join(outputDirectory, '.arkive-pdf-'))
  const temporaryOutput = join(temporaryDirectory, 'compressed.pdf')
  try {
    const tool = await runCompression(preset, inputPath, temporaryOutput, signal)
    signal?.throwIfAborted()
    const outputStat = await stat(temporaryOutput)
    if (!outputStat.isFile() || outputStat.size === 0) throw new Error('PDF 压缩输出为空。')
    await checkQpdf(temporaryOutput, signal)
    const outputInspection = await inspectInput(temporaryOutput, signal)
    const pageCountPreserved = outputInspection.pageCount === pageCount
    const featuresPreserved = featuresEqual(features, outputInspection.features)
    if (!pageCountPreserved || !featuresPreserved) {
      throw new Error('压缩输出未保留页面数量或 PDF 特征，已拒绝发布输出。')
    }
    signal?.throwIfAborted()
    await link(temporaryOutput, outputPath)
    return {
      status: outputStat.size < originalBytes ? 'compressed' : 'no-savings',
      inputPath,
      outputPath,
      inputBytes: originalBytes,
      outputBytes: outputStat.size,
      savedBytes: Math.max(0, originalBytes - outputStat.size),
      preset,
      tool,
      validation: {
        qpdfCheck: true,
        pageCountPreserved,
        featuresPreserved
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
