import { compressImage } from '../image-compression/service'
import { compressPdf } from '../pdf-compression/service'
import { compressVideo } from '../video-compression/service'
import { getCatalog } from './service'
import { normalizeTags } from './finder-tags'
import type {
  ArchiveAttempt,
  CompressionFollowUp,
  CompressionLifecycleResult
} from '../../../shared/contracts/catalog'
import type {
  ImageCompressionRequest,
  ImageCompressionResult
} from '../../../shared/contracts/image'
import type {
  VideoCompressionRequest,
  VideoCompressionResult,
  VideoCompressionProgress
} from '../../../shared/contracts/video'
import type { PdfCompressionRequest, PdfCompressionResult } from '../../../shared/contracts/pdf'

/** Encoding remains independently testable; every product entry uses this shared lifecycle. */
async function complete<T extends { status: 'compressed' | 'no-savings' }>(
  inputPath: string,
  outputPath: string,
  work: () => Promise<T>,
  followUp: CompressionFollowUp
): Promise<T & CompressionLifecycleResult> {
  if (followUp.archive !== undefined && typeof followUp.archive !== 'boolean')
    throw new Error('归档选项必须为布尔值。')
  const tags = normalizeTags(followUp.tags ?? [])
  if (tags.length && !followUp.archive) throw new Error('归档标签需与 archive=true 一起使用。')
  const catalog = getCatalog()
  return catalog.trackCompression(async () => {
    const id = await catalog.beginCompression(inputPath, outputPath)
    let result: T
    try {
      result = await work()
    } catch (error) {
      catalog.failCompression(id)
      throw error
    }
    const record = await catalog.finishCompression(id, result.status === 'compressed')
    let archive: ArchiveAttempt | undefined
    if (followUp.archive) {
      try {
        if (record.backupStatus === 'error')
          throw new Error(record.backupError ?? '原件备份未完成。')
        archive = { status: 'ready', item: await catalog.archive(id, tags) }
      } catch (error) {
        // Encoding has succeeded. Return its ID and paths so archiving can be retried alone.
        archive = { status: 'error', error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { ...result, catalog: record, ...(archive ? { archive } : {}) }
  })
}

export function compressImageAndBackup(
  request: ImageCompressionRequest & CompressionFollowUp,
  signal?: AbortSignal
): Promise<ImageCompressionResult & CompressionLifecycleResult> {
  return complete(
    request.inputPath,
    request.outputPath,
    () => compressImage(request, signal),
    request
  )
}

export function compressVideoAndBackup(
  request: VideoCompressionRequest & CompressionFollowUp,
  signal?: AbortSignal,
  report?: (update: VideoCompressionProgress) => void
): Promise<VideoCompressionResult & CompressionLifecycleResult> {
  return complete(
    request.inputPath,
    request.outputPath,
    () => compressVideo(request, signal, report),
    request
  )
}

export function compressPdfAndBackup(
  request: PdfCompressionRequest & CompressionFollowUp,
  signal?: AbortSignal
): Promise<PdfCompressionResult & CompressionLifecycleResult> {
  return complete(
    request.inputPath,
    request.outputPath,
    () => compressPdf(request, signal),
    request
  )
}
