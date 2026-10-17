import { link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { assertSystemWriteAllowed } from '../../system-paths'
import { scoreImagePair } from '../../../execution/ssimulacra2'
import {
  encodeImage,
  readImageMetadata,
  validateImage,
  writeQualityImage
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

// Start from conservative qualities and allow at most one fallback. Each candidate requires
// a full encode and SSIMULACRA2 pass, so a long quality ladder would make large photos slow.
const targetScore: Record<ImageCompressionPreset, number> = {
  quality: 90,
  balanced: 85,
  size: 80
}
const sharpQualityCandidates: Record<ImageCompressionPreset, number[]> = {
  quality: [92, 98],
  balanced: [85, 95],
  size: [80, 92]
}
const pngquantQualityCandidates: Record<ImageCompressionPreset, string[]> = {
  quality: ['80-95', '90-100'],
  balanced: ['75-90', '85-100'],
  size: ['65-85', '80-95']
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

function candidatesFor(
  tool: 'sharp' | 'pngquant',
  request: ImageCompressionRequest,
  preset: ImageCompressionPreset
): Candidate[] {
  if (request.quality !== undefined) return [request.quality]
  if (tool === 'pngquant') return pngquantQualityCandidates[preset]
  return sharpQualityCandidates[preset]
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
    (after.pages ?? 1) !== 1
  ) {
    throw new Error('输出图片的格式、尺寸、透明通道或方向检查未通过。')
  }
}

/**
 * User-confirmed main-process execution API. Does not register an Agent tool or create a task queue.
 * Writes only a new, validated copy. Metadata is intentionally discarded. Lossy candidates are
 * evaluated from the original input and the least aggressive candidate meeting the selected
 * SSIMULACRA2 target is published.
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
    const metricSource = join(temporaryDirectory, 'metric-source.png')
    await writeQualityImage(
      info.inputPath,
      metricSource,
      {
        hasAlpha: info.hasAlpha && format !== 'jpeg',
        flattenBackground: info.hasAlpha && format === 'jpeg' ? request.jpegBackground : undefined
      },
      signal
    )
    let selectedOutput: string | undefined
    let selectedQuality: number | undefined
    let selectedScore = 0
    let attempts = 0
    let outputHasAlpha = false

    for (const [index, candidate] of candidates.entries()) {
      signal?.throwIfAborted()
      const candidatePath = join(temporaryDirectory, `candidate-${String(index)}.${format}`)
      const encoded = await encodeCandidate(
        tool,
        info.inputPath,
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

      selectedOutput = candidatePath
      selectedQuality = qualityNumber(candidate)
      outputHasAlpha = after.hasAlpha
      selectedScore = await scoreCandidate(
        candidatePath,
        metricSource,
        outputHasAlpha,
        temporaryDirectory,
        index,
        signal
      )
      if (selectedScore >= target || candidates.length === 1) break
    }

    if (!selectedOutput) {
      throw new Error('没有生成可用的压缩输出，请提高输入质量或检查图片内容。')
    }
    const outputStat = await stat(selectedOutput)
    if (outputStat.size === 0) throw new Error('压缩输出为空。')
    signal?.throwIfAborted()
    // Atomic no-overwrite publication, even if a competing request created the target meanwhile.
    await link(selectedOutput, outputPath)
    return {
      status: outputStat.size < info.originalBytes ? 'compressed' : 'no-savings',
      inputPath: info.inputPath,
      outputPath,
      originalBytes: info.originalBytes,
      outputBytes: outputStat.size,
      savedBytes: Math.max(0, info.originalBytes - outputStat.size),
      outputFormat: format,
      tool,
      ...(selectedQuality === undefined ? {} : { quality: selectedQuality }),
      qualityAnalysis: {
        metric: 'ssimulacra2',
        targetScore: target,
        score: selectedScore,
        attempts,
        meetsTarget: selectedScore >= target
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
