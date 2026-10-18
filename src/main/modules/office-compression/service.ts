import { link, mkdtemp, realpath, rm, stat, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertSystemWriteAllowed } from '../../system-paths'
import { exists, hashFile } from '../catalog/files'
import { compressImage, inspectImage } from '../image-compression/service'
import { compressVideo, inspectVideo } from '../video-compression/service'
import { readOfficePackage, writeOfficePackage, type OfficePart } from './package'
import type {
  OfficeCompressionRequest,
  OfficeCompressionResult,
  OfficeInspection,
  OfficeMediaResult
} from '../../../shared/contracts/office'

function supportedImage(part: OfficePart): boolean {
  return (
    (part.contentType === 'image/jpeg' && /\.jpe?g$/i.test(part.name)) ||
    (part.contentType === 'image/png' && /\.png$/i.test(part.name))
  )
}

function media(part: OfficePart): boolean {
  return /^(image|video|audio)\//.test(part.contentType)
}

function supportedVideo(part: OfficePart): boolean {
  // Keep the package part name/content type and every relationship/timing XML unchanged.
  return part.contentType === 'video/mp4' && extname(part.name).toLowerCase() === '.mp4'
}

async function inputFile(inputPath: string): Promise<string> {
  if (!isAbsolute(inputPath) || !['.docx', '.pptx'].includes(extname(inputPath).toLowerCase())) {
    throw new Error('输入须为 DOCX／PPTX 的本地绝对路径。')
  }
  const path = await realpath(inputPath)
  if (!(await stat(path)).isFile()) throw new Error('输入须为普通 Office 文件。')
  return path
}

export async function inspectOffice(
  inputPath: string,
  signal?: AbortSignal
): Promise<OfficeInspection> {
  signal?.throwIfAborted()
  const input = await inputFile(inputPath)
  const directory = await mkdtemp(join(tmpdir(), 'arkive-office-inspect-'))
  try {
    const document = await readOfficePackage(input, directory, signal)
    return {
      inputPath: input,
      format: document.format,
      originalBytes: (await stat(input)).size,
      embeddedImages: document.parts.filter(supportedImage).length,
      embeddedVideos: document.parts.filter(supportedVideo).length,
      otherMedia: document.parts.filter(
        (part) => media(part) && !supportedImage(part) && !supportedVideo(part)
      ).length
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Pure encoding entry. No backup, catalog registration or replacement of user files. */
export async function compressOffice(
  request: OfficeCompressionRequest,
  signal?: AbortSignal
): Promise<OfficeCompressionResult> {
  signal?.throwIfAborted()
  const input = await inputFile(request.inputPath)
  if (
    !isAbsolute(request.outputPath) ||
    extname(request.outputPath).toLowerCase() !== extname(input).toLowerCase()
  ) {
    throw new Error('Office 输出须为相同文档格式的本地绝对路径。')
  }
  if (request.preset !== undefined && !['quality', 'balanced', 'size'].includes(request.preset))
    throw new Error('Office 压缩预设无效。')
  await assertSystemWriteAllowed(request.outputPath)
  const output = join(await realpath(dirname(request.outputPath)), basename(request.outputPath))
  if (await exists(output)) throw new Error('输出路径已存在，不覆盖原件或已有文件。')
  const originalBytes = (await stat(input)).size
  const sourceHash = await hashFile(input)
  const directory = await mkdtemp(join(dirname(output), '.arkive-office-'))
  try {
    const partsDirectory = join(directory, 'input')
    await mkdir(partsDirectory)
    const document = await readOfficePackage(input, partsDirectory, signal)
    const replacements = new Map<string, string>()
    const results: OfficeMediaResult[] = []
    for (const [index, part] of document.parts.entries()) {
      signal?.throwIfAborted()
      if (!media(part)) continue
      const result: OfficeMediaResult = {
        part: part.name,
        status: 'skipped',
        originalBytes: part.bytes,
        outputBytes: part.bytes
      }
      if (!supportedImage(part) && !supportedVideo(part)) {
        result.reason = '当前 Office 链路仅压缩嵌入的 JPEG／PNG／MP4，其他媒体保留原样。'
        results.push(result)
        continue
      }
      try {
        if (supportedVideo(part)) {
          const inspection = await inspectVideo(part.path, signal)
          if (inspection.removedContents.length > 0) {
            throw new Error(
              `为保留文档视频的完整内容，跳过含${inspection.removedContents.join('、')}的视频。`
            )
          }
          const candidate = join(directory, `video-${String(index)}.mp4`)
          const encoded = await compressVideo(
            {
              inputPath: part.path,
              outputPath: candidate,
              compatibility: true,
              preset: request.preset ?? 'quality'
            },
            signal
          )
          if (
            encoded.videoCodec !== 'h264' ||
            encoded.bitDepth !== 8 ||
            encoded.qualityAnalysis.sampleVmaf < encoded.qualityAnalysis.targetVmaf
          )
            result.reason = '视频兼容格式或抽样质量未达标，保留原媒体。'
          else if (encoded.status !== 'compressed') result.reason = '媒体体积未减少，保留原媒体。'
          else {
            replacements.set(part.name, candidate)
            result.status = 'compressed'
            result.outputBytes = encoded.outputBytes
          }
          results.push(result)
          continue
        }
        const inspection = await inspectImage({ inputPath: part.path }, signal)
        if (
          !['jpeg', 'png'].includes(inspection.format) ||
          inspection.format !== (part.contentType === 'image/png' ? 'png' : 'jpeg')
        ) {
          throw new Error('图片实际格式与 Office 内容类型不一致。')
        }
        // Media services work on private candidates; never call their user-file backup wrappers.
        const candidate = join(directory, `image-${String(index)}${extname(part.name)}`)
        const encoded = await compressImage(
          {
            inputPath: part.path,
            outputPath: candidate,
            preserveFormat: true,
            preset: request.preset ?? 'quality'
          },
          signal
        )
        result.qualityAnalysis = encoded.qualityAnalysis
        if (encoded.status !== 'compressed') result.reason = '媒体体积未减少，保留原媒体。'
        else {
          replacements.set(part.name, candidate)
          result.status = 'compressed'
          result.outputBytes = encoded.outputBytes
        }
      } catch (error) {
        signal?.throwIfAborted()
        result.reason = error instanceof Error ? error.message : String(error)
      }
      results.push(result)
    }
    const staged = join(directory, `result.${document.format}`)
    await writeOfficePackage(document, replacements, staged, signal)
    const checkDirectory = join(directory, 'validated')
    await mkdir(checkDirectory)
    const checked = await readOfficePackage(staged, checkDirectory, signal)
    if (checked.parts.length !== document.parts.length)
      throw new Error('Office 封装后的文件数量不一致。')
    const hashes = new Map(checked.parts.map((part) => [part.name, part.hash]))
    for (const part of document.parts) {
      const expected = replacements.get(part.name)
      if (hashes.get(part.name) !== (expected ? await hashFile(expected) : part.hash)) {
        throw new Error(`Office 封装后的内容不一致：${part.name}`)
      }
    }
    if ((await hashFile(input)) !== sourceHash)
      throw new Error('处理期间源文档发生变化，未发布结果。')
    signal?.throwIfAborted()
    const outputBytes = (await stat(staged)).size
    // No-savings is a result, not permission to rewrite a document through ZIP recompression.
    if (replacements.size === 0 || outputBytes >= originalBytes) {
      return {
        status: 'no-savings',
        inputPath: input,
        outputPath: input,
        format: document.format,
        originalBytes,
        outputBytes: originalBytes,
        savedBytes: 0,
        media: results
      }
    }
    await link(staged, output)
    return {
      status: 'compressed',
      inputPath: input,
      outputPath: output,
      format: document.format,
      originalBytes,
      outputBytes,
      savedBytes: originalBytes - outputBytes,
      media: results
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
