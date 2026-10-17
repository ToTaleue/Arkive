import { copyFile, link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertSystemWriteAllowed } from '../../system-paths'
import { encodeImage, readImageMetadata, validateImage } from '../../../execution/sharp'
import { runBundledTool } from '../../../execution/process'
import type {
  ImageCompressionRequest,
  ImageCompressionResult,
  ImageInspection,
  ImageOutputFormat
} from '../../../shared/contracts/image'

export type {
  ImageCompressionRequest,
  ImageCompressionResult,
  ImageInspection
} from '../../../shared/contracts/image'

type ImageMetadata = Awaited<ReturnType<typeof readImageMetadata>>

// Starting values from Sharp, not calibrated perceptual quality scores.
const defaultQuality = 80
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

function selectOutput(request: ImageCompressionRequest): ImageOutputFormat {
  if (request.compatibility !== undefined && typeof request.compatibility !== 'boolean') {
    throw new Error('兼容性选项须为布尔值。')
  }
  if (request.compatibility && request.outputFormat && request.outputFormat !== 'jpeg') {
    throw new Error('兼容性要求输出 JPEG，与指定输出格式冲突。')
  }
  const format: unknown = request.compatibility ? 'jpeg' : (request.outputFormat ?? 'webp')
  if (format !== 'webp' && format !== 'jpeg' && format !== 'png') {
    throw new Error('不支持的输出格式。')
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
  if (
    request.jpegBackground !== undefined &&
    (format !== 'jpeg' || !/^#[\da-f]{6}$/i.test(request.jpegBackground))
  ) {
    throw new Error('JPEG 背景色须为 #RRGGBB，且仅用于 JPEG 输出。')
  }
  return format
}

function checkOutputMetadata(
  before: ImageMetadata,
  after: ImageMetadata,
  format: ImageOutputFormat
): void {
  if (
    after.format !== format ||
    after.width !== before.width ||
    after.height !== before.height ||
    (after.pages ?? 1) !== 1 ||
    (after.orientation ?? 1) !== (before.orientation ?? 1)
  ) {
    throw new Error('输出图片的格式、尺寸、透明通道或方向检查未通过。')
  }
  // EXIF is reserialised by Sharp/libvips (e.g. dimension tags), so byte equality is not valid.
  if (before.exif && !after.exif) throw new Error('工具未保留 EXIF 元数据，已拒绝发布输出。')
  for (const field of ['icc', 'xmp', 'iptc', 'tifftagPhotoshop', 'comments'] as const) {
    if (before[field] && !isDeepStrictEqual(before[field], after[field])) {
      throw new Error(`工具未完整保留 ${field} 元数据，已拒绝发布输出并保留原件。`)
    }
  }
}

/**
 * User-confirmed main-process execution API. Does not register an Agent tool or create a task queue.
 * Writes only a new, validated copy. Decoding/metadata checks do not certify perceptual quality.
 * JPEG→JPEG defaults to jpegoptim lossless; other encoders use their starting defaults.
 */
export async function compressImage(
  request: ImageCompressionRequest,
  signal?: AbortSignal
): Promise<ImageCompressionResult> {
  signal?.throwIfAborted()
  const format = selectOutput(request)
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

  const { info, metadata: before } = await inspectInput(request.inputPath, signal)
  if (format === 'png' && info.format !== 'png') {
    throw new Error('PNG 保持格式策略仅接受 PNG 输入。')
  }
  if (format === 'jpeg' && info.hasAlpha && !request.jpegBackground) {
    throw new Error('透明图片输出 JPEG 时须明确背景色，不自动填充白底。')
  }
  const tool =
    format === 'png'
      ? 'pngquant'
      : format === 'jpeg' && info.format === 'jpeg'
        ? 'jpegoptim'
        : 'sharp'
  const quality = tool === 'sharp' ? (request.quality ?? defaultQuality) : request.quality
  // Validate the original before tools can repair or partially decode a damaged input.
  await validateImage(info.inputPath, signal)
  signal?.throwIfAborted()
  const temporaryDirectory = await mkdtemp(join(directory, '.arkive-image-'))
  const temporaryOutput = join(temporaryDirectory, `compressed.${format}`)
  try {
    if (tool === 'sharp') {
      if (format === 'png') throw new Error('PNG 输出须使用 pngquant。')
      await encodeImage(
        info.inputPath,
        temporaryOutput,
        { format, quality: quality ?? defaultQuality, jpegBackground: request.jpegBackground },
        signal
      )
    } else {
      let args: string[]
      if (tool === 'jpegoptim') {
        // jpegoptim overwrites its input. Operate on our private copy, including no-savings cases.
        await copyFile(info.inputPath, temporaryOutput)
        // This bundled beta emits a spurious warning with --nofix + --max on valid JPEGs.
        // Input decoding is checked above, and the output is independently decoded below.
        args = ['--keep-all', '--save-extra']
        if (quality !== undefined) args.push(`--max=${String(quality)}`)
        args.push('--', temporaryOutput)
      } else {
        args = ['--output', temporaryOutput, '--', info.inputPath]
      }
      signal?.throwIfAborted()
      const result = await runBundledTool(tool, args, { signal })
      if (result.exitCode !== 0 || result.signal) {
        throw new Error(
          `${tool} 压缩失败（退出码 ${String(result.exitCode)}）：${(result.stderr || result.stdout).slice(-4096)}`
        )
      }
    }
    signal?.throwIfAborted()
    const after = await readImageMetadata(temporaryOutput)
    checkOutputMetadata(before, after, format)
    if (format !== 'jpeg' && before.hasAlpha && !after.hasAlpha) {
      const inputStats = await validateImage(info.inputPath, signal)
      if (!inputStats.isOpaque) throw new Error('输出丢失透明度，已拒绝发布输出。')
    }
    await validateImage(temporaryOutput, signal)
    const outputStat = await stat(temporaryOutput)
    if (outputStat.size === 0) throw new Error('压缩输出为空。')
    signal?.throwIfAborted()
    // Atomic no-overwrite publication, even if a competing request created the target meanwhile.
    await link(temporaryOutput, outputPath)
    return {
      status: outputStat.size < info.originalBytes ? 'compressed' : 'no-savings',
      inputPath: info.inputPath,
      outputPath,
      originalBytes: info.originalBytes,
      outputBytes: outputStat.size,
      savedBytes: Math.max(0, info.originalBytes - outputStat.size),
      outputFormat: format,
      tool,
      ...(quality === undefined ? {} : { quality })
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
