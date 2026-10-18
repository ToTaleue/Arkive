import { link, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { assertSystemWriteAllowed } from '../../system-paths'
import { scoreImagePair } from '../../../execution/ssimulacra2'
import {
  encodeImage,
  outputXmp,
  readImageMetadata,
  validateImage,
  writeQualityImage,
  writeQuantizationInput
} from '../../../execution/sharp'
import { runBundledTool } from '../../../execution/process'
import type {
  ImageCompressionRequest,
  ImageCompressionResult,
  ImageCompressionPreset,
  ImageInspection,
  ImageOutputFormat
} from '../../../shared/contracts/image'

export type {
  ImageCompressionRequest,
  ImageCompressionResult,
  ImageCompressionPreset,
  ImageInspection
} from '../../../shared/contracts/image'

type ImageMetadata = Awaited<ReturnType<typeof readImageMetadata>>

// Scores are advisory. Start with the preset's encoding quality and lower it only when
// the candidate does not save bytes; score only the final selected output.
const targetScore: Record<ImageCompressionPreset, number> = {
  quality: 90,
  balanced: 85,
  size: 80
}
const startingQuality: Record<ImageCompressionPreset, number> = {
  quality: 92,
  balanced: 85,
  size: 80
}
const startingPngQuality: Record<ImageCompressionPreset, number> = {
  quality: 95,
  balanced: 90,
  size: 85
}
const outputExtensions = { webp: ['.webp'], jpeg: ['.jpg', '.jpeg'], png: ['.png'] }
const supportedInputs = ['jpeg', 'png', 'webp', 'tiff', 'gif', 'heif']

async function inspectInput(
  inputPath: string,
  signal?: AbortSignal
): Promise<{
  info: ImageInspection
  metadata: ImageMetadata
}> {
  signal?.throwIfAborted()
  if (typeof inputPath !== 'string' || !isAbsolute(inputPath)) {
    throw new Error('输入须为本地绝对路径。')
  }
  const input = await realpath(inputPath)
  const inputStat = await stat(input)
  if (!inputStat.isFile()) throw new Error('输入须为普通图片文件。')
  const metadata = await readImageMetadata(input)
  if (
    !supportedInputs.includes(metadata.format) ||
    (metadata.pages ?? 1) !== 1 ||
    metadata.depth !== 'uchar' ||
    metadata.gainMap ||
    (metadata.subifds ?? 0) > 0 ||
    metadata.width <= 0 ||
    metadata.height <= 0
  ) {
    throw new Error('当前仅支持普通 8bit 静态位图；动画、多页、HDR 和其他特殊图片尚待验证。')
  }
  signal?.throwIfAborted()
  return {
    info: {
      inputPath: input,
      format: metadata.format,
      originalBytes: inputStat.size,
      width: metadata.width,
      height: metadata.height,
      hasAlpha: metadata.hasAlpha
    },
    metadata
  }
}

/** Read-only main-process API, reusable by UI and Agent proposal tools. */
export async function inspectImage(
  request: { inputPath: string },
  signal?: AbortSignal
): Promise<ImageInspection> {
  return (await inspectInput(request.inputPath, signal)).info
}

function preserveFormat(request: ImageCompressionRequest): boolean {
  if (request.preserveFormat !== undefined && typeof request.preserveFormat !== 'boolean') {
    throw new Error('原格式输出选项须为布尔值。')
  }
  return request.preserveFormat ?? false
}

function selectOutput(request: ImageCompressionRequest, inputFormat: string): ImageOutputFormat {
  const keepOriginalFormat = preserveFormat(request)
  if (keepOriginalFormat && request.outputFormat !== undefined) {
    throw new Error('原格式输出不能与指定输出格式同时使用。')
  }
  const format: unknown = keepOriginalFormat ? inputFormat : (request.outputFormat ?? 'webp')
  if (format !== 'webp' && format !== 'jpeg' && format !== 'png') {
    throw new Error('原格式输出目前仅支持 JPEG、PNG 和 WebP 输入。')
  }
  if (
    request.quality !== undefined &&
    (!Number.isInteger(request.quality) || request.quality < 1 || request.quality > 100)
  ) {
    throw new Error('质量须为 1–100 的整数。')
  }
  if (format === 'png' && request.quality !== undefined) {
    throw new Error('PNG 使用 pngquant 默认参数，不接受跨编码器的单值质量参数。')
  }
  if (request.preset !== undefined && !['quality', 'balanced', 'size'].includes(request.preset)) {
    throw new Error('图片压缩预设无效。')
  }
  if (
    request.jpegBackground !== undefined &&
    (format !== 'jpeg' || !/^#[\da-f]{6}$/i.test(request.jpegBackground))
  ) {
    throw new Error('JPEG 背景色须为 #RRGGBB，且仅用于 JPEG 输出。')
  }
  return format
}

type Candidate = number | string | undefined

// pngquant's macOS reader drops ancillary chunks. Restore normalized metadata without
// re-encoding its indexed pixels or restoring the old palette/transparency information.
const pngMetadataChunks = new Set([
  'eXIf',
  'iCCP',
  'sRGB',
  'gAMA',
  'cHRM',
  'pHYs',
  'iTXt',
  'tEXt',
  'zTXt',
  'tIME'
])

function pngChunks(data: Buffer): { type: string; bytes: Buffer }[] {
  const chunks: { type: string; bytes: Buffer }[] = []
  for (let offset = 8; offset < data.length;) {
    if (offset + 12 > data.length) throw new Error('PNG 元数据块不完整。')
    const end = offset + data.readUInt32BE(offset) + 12
    if (end > data.length) throw new Error('PNG 元数据块不完整。')
    chunks.push({
      type: data.toString('ascii', offset + 4, offset + 8),
      bytes: data.subarray(offset, end)
    })
    offset = end
  }
  return chunks
}

async function restorePngMetadata(input: string, output: string): Promise<void> {
  const [source, candidate] = await Promise.all([readFile(input), readFile(output)])
  const metadata = pngChunks(source).filter(({ type }) => pngMetadataChunks.has(type))
  const chunks = pngChunks(candidate).filter(({ type }) => !pngMetadataChunks.has(type))
  const header = chunks.shift()
  if (header?.type !== 'IHDR') throw new Error('PNG 文件头无效。')
  await writeFile(
    output,
    Buffer.concat([
      candidate.subarray(0, 8),
      header.bytes,
      ...metadata.map(({ bytes }) => bytes),
      ...chunks.map(({ bytes }) => bytes)
    ])
  )
}

function candidatesFor(
  tool: 'sharp' | 'pngquant',
  request: ImageCompressionRequest,
  preset: ImageCompressionPreset
): Candidate[] {
  if (tool === 'pngquant') {
    const start = startingPngQuality[preset]
    return [start, ...[80, 60, 40, 20].filter((quality) => quality < start)].map(
      (quality) => `0-${String(quality)}`
    )
  }
  const start = request.quality ?? startingQuality[preset]
  return [start, ...[75, 60, 40, 20, 1].filter((quality) => quality < start)]
}

function qualityNumber(candidate: Candidate): number | undefined {
  return typeof candidate === 'number' ? candidate : undefined
}

async function encodeCandidate(
  tool: 'sharp' | 'pngquant',
  inputPath: string,
  outputPath: string,
  format: ImageOutputFormat,
  candidate: Candidate,
  jpegBackground: string | undefined,
  signal?: AbortSignal
): Promise<boolean> {
  if (tool === 'sharp') {
    await encodeImage(
      inputPath,
      outputPath,
      { format: format === 'jpeg' ? 'jpeg' : 'webp', quality: candidate as number, jpegBackground },
      signal
    )
    return true
  }

  const args = ['--quality', String(candidate), '--output', outputPath, '--', inputPath]
  signal?.throwIfAborted()
  const result = await runBundledTool(tool, args, { signal })
  if (result.exitCode === 99) return false
  if (result.exitCode !== 0 || result.signal) {
    throw new Error(
      `${tool} 压缩失败（退出码 ${String(result.exitCode)}）：${(result.stderr || result.stdout).slice(-4096)}`
    )
  }
  await restorePngMetadata(inputPath, outputPath)
  return true
}

async function scoreCandidate(
  outputPath: string,
  metricSource: string,
  outputHasAlpha: boolean,
  temporaryDirectory: string,
  index: number,
  signal?: AbortSignal
): Promise<number> {
  const distorted = join(temporaryDirectory, `metric-distorted-${String(index)}.png`)
  await writeQualityImage(outputPath, distorted, { hasAlpha: outputHasAlpha }, signal)
  return scoreImagePair(metricSource, distorted, signal)
}

function checkOutputImage(
  before: ImageMetadata,
  after: ImageMetadata,
  format: ImageOutputFormat
): void {
  const orientation = before.orientation ?? 1
  const expectedWidth = orientation >= 5 && orientation <= 8 ? before.height : before.width
  const expectedHeight = orientation >= 5 && orientation <= 8 ? before.width : before.height
  if (
    after.format !== format ||
    after.width !== expectedWidth ||
    after.height !== expectedHeight ||
    (after.orientation !== undefined && after.orientation !== 1) ||
    (after.pages ?? 1) !== 1
  ) {
    throw new Error('输出图片的格式、尺寸、透明通道或方向检查未通过。')
  }
  if ((before.exif && !after.exif) || (before.icc && !after.icc)) {
    throw new Error('输出图片丢失 EXIF 或颜色配置，未发布结果。')
  }
  const expectedXmp = outputXmp(before, format)
  if (expectedXmp !== undefined && after.xmp?.toString('utf8') !== expectedXmp) {
    throw new Error('输出图片的 XMP 元数据校验未通过。')
  }
  if (format === 'jpeg' && before.iptc && !before.iptc.equals(after.iptc ?? Buffer.alloc(0))) {
    throw new Error('输出图片的 IPTC 元数据校验未通过。')
  }
  if (
    format === 'png' &&
    before.comments?.some(
      (comment) =>
        !after.comments?.some(
          (item) => item.keyword === comment.keyword && item.text === comment.text
        )
    )
  )
    throw new Error('输出图片丢失 PNG 文本元数据，未发布结果。')
}

/**
 * User-confirmed main-process execution API. Does not register an Agent tool or create a task queue.
 * Writes only a new, validated copy, preserving metadata and updating normalized pixel fields.
 * Lossy candidates are
 * selected by byte savings. SSIMULACRA2 describes the final output; its reference score is
 * never a publication gate. If no candidate is smaller, publish the smallest valid candidate
 * as no-savings so product callers retain the original.
 */
export async function compressImage(
  request: ImageCompressionRequest,
  signal?: AbortSignal
): Promise<ImageCompressionResult> {
  signal?.throwIfAborted()
  const { info, metadata: before } = await inspectInput(request.inputPath, signal)
  const format = selectOutput(request, before.format)
  if (
    typeof request.outputPath !== 'string' ||
    !isAbsolute(request.outputPath) ||
    !outputExtensions[format].includes(extname(request.outputPath).toLowerCase())
  ) {
    throw new Error('输出须为本地绝对路径，扩展名须与输出格式一致。')
  }
  await assertSystemWriteAllowed(request.outputPath)
  const directory = await realpath(dirname(request.outputPath))
  const outputPath = join(directory, basename(request.outputPath))
  const existing = await lstat(outputPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing) throw new Error('输出路径已存在，不覆盖原件或已有文件。')

  if (format === 'png' && info.format !== 'png') {
    throw new Error('PNG 输出仅接受 PNG 输入。')
  }
  if (format === 'jpeg' && info.hasAlpha && !request.jpegBackground) {
    throw new Error('透明图片输出 JPEG 时须明确背景色，不自动填充白底。')
  }
  const tool = format === 'png' ? 'pngquant' : 'sharp'
  const preset = request.preset ?? 'balanced'
  const target = targetScore[preset]
  const candidates = candidatesFor(tool, request, preset)
  // Validate the original before tools can repair or partially decode a damaged input.
  await validateImage(info.inputPath, signal)
  signal?.throwIfAborted()
  const temporaryDirectory = await mkdtemp(join(directory, '.arkive-image-'))
  try {
    let encodingInput = info.inputPath
    if (tool === 'pngquant') {
      encodingInput = join(temporaryDirectory, 'quantization-input.png')
      await writeQuantizationInput(info.inputPath, encodingInput, before, signal)
    }
    const metricSource = join(temporaryDirectory, 'metric-source.png')
    let selectedOutput: string | undefined
    let selectedQuality: number | undefined
    let selectedBytes = Infinity
    let attempts = 0
    let outputHasAlpha = false

    for (const [index, candidate] of candidates.entries()) {
      signal?.throwIfAborted()
      const candidatePath = join(temporaryDirectory, `candidate-${String(index)}.${format}`)
      const encoded = await encodeCandidate(
        tool,
        encodingInput,
        candidatePath,
        format,
        candidate,
        request.jpegBackground,
        signal
      )
      attempts += 1
      if (!encoded) continue

      const after = await readImageMetadata(candidatePath)
      checkOutputImage(before, after, format)
      if (format !== 'jpeg' && before.hasAlpha && !after.hasAlpha) {
        const inputStats = await validateImage(info.inputPath, signal)
        if (!inputStats.isOpaque) throw new Error('输出丢失透明度，已拒绝发布输出。')
      }
      await validateImage(candidatePath, signal)
      const candidateStat = await stat(candidatePath)
      if (candidateStat.size === 0) throw new Error('压缩输出为空。')

      if (candidateStat.size < selectedBytes) {
        selectedOutput = candidatePath
        selectedQuality = qualityNumber(candidate)
        outputHasAlpha = after.hasAlpha
        selectedBytes = candidateStat.size
      }
      if (candidateStat.size < info.originalBytes) break
    }

    if (!selectedOutput) {
      throw new Error('没有生成可用的压缩输出，请检查输入格式或图片内容。')
    }
    let selectedScore: number | null = null
    let scoreError: string | undefined
    try {
      await writeQualityImage(
        info.inputPath,
        metricSource,
        {
          hasAlpha: info.hasAlpha && format !== 'jpeg',
          flattenBackground: info.hasAlpha && format === 'jpeg' ? request.jpegBackground : undefined
        },
        signal
      )
      selectedScore = await scoreCandidate(
        selectedOutput,
        metricSource,
        outputHasAlpha,
        temporaryDirectory,
        0,
        signal
      )
    } catch (error) {
      signal?.throwIfAborted()
      scoreError = error instanceof Error ? error.message : String(error)
    }
    const outputStat = await stat(selectedOutput)
    if (outputStat.size === 0) throw new Error('压缩输出为空。')
    signal?.throwIfAborted()
    // Atomic no-overwrite publication, even if a competing request created the target meanwhile.
    await link(selectedOutput, outputPath)
    const metadataWarnings: string[] = []
    if (format !== 'jpeg' && before.iptc)
      metadataWarnings.push(
        `${format.toUpperCase()} 输出不支持保留原始 IPTC 数据；完整信息保留在原件中。`
      )
    if (format !== 'png' && before.comments?.length)
      metadataWarnings.push('输出格式不支持保留原始 PNG 文本块；完整信息保留在原件中。')
    if (before.tifftagPhotoshop && format !== 'jpeg')
      metadataWarnings.push('输出格式不支持保留原始 Photoshop 数据块；完整信息保留在原件中。')
    return {
      status: outputStat.size < info.originalBytes ? 'compressed' : 'no-savings',
      inputPath: info.inputPath,
      outputPath,
      originalBytes: info.originalBytes,
      outputBytes: outputStat.size,
      savedBytes: Math.max(0, info.originalBytes - outputStat.size),
      outputFormat: format,
      tool,
      ...(metadataWarnings.length ? { metadataWarnings } : {}),
      ...(selectedQuality === undefined ? {} : { quality: selectedQuality }),
      qualityAnalysis: {
        metric: 'ssimulacra2',
        targetScore: target,
        score: selectedScore,
        attempts,
        meetsTarget: selectedScore === null ? null : selectedScore >= target,
        ...(scoreError ? { error: scoreError } : {})
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
