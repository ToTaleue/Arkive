import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import type { TaskProgress } from '../../../shared/contracts/task'
import { runTask, TaskFailure } from '../../tasks/service'
import { resolveFilePath } from '../../system-paths'
import { compressImage } from '../image-compression/service'
import { compressPdf } from '../pdf-compression/service'
import { compressVideo } from '../video-compression/service'
import { getCatalog } from './service'
import { normalizeTags } from './finder-tags'
import { recommendArchiveTags } from './automatic-tags'
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

type CompressionPaths = { inputPath: string; outputPath: string }

/** Product entry points share one task; encoders remain directly usable inside Office. */
async function complete<T extends { status: 'compressed' | 'no-savings' }>(
  title: string,
  request: CompressionPaths & CompressionFollowUp,
  work: (
    signal: AbortSignal,
    report: (progress: TaskProgress) => void,
    paths: CompressionPaths
  ) => Promise<T>,
  signal?: AbortSignal,
  requestId?: string,
  archiveOnNoSavings = true
): Promise<T & CompressionLifecycleResult> {
  signal?.throwIfAborted()
  if (request.archive !== undefined && typeof request.archive !== 'boolean')
    throw new Error('归档选项必须为布尔值。')
  if (
    request.keepLinkAtOriginalLocation !== undefined &&
    typeof request.keepLinkAtOriginalLocation !== 'boolean'
  )
    throw new Error('原位置入口选项必须为布尔值。')
  if (request.keepLinkAtOriginalLocation && !request.archive)
    throw new Error('原位置入口需与 archive=true 一起使用。')
  const tags = normalizeTags(request.tags ?? [])
  if (tags.length && !request.archive) throw new Error('归档标签需与 archive=true 一起使用。')
  const catalog = getCatalog()
  const input = await realpath(request.inputPath)
  const output = await resolveFilePath(request.outputPath)
  let completed: (T & CompressionLifecycleResult) | undefined
  try {
    return await runTask(
      {
        title: `${title}：${basename(input)}`,
        key: `compress:${input}`,
        requestId,
        run: (taskSignal, report) =>
          catalog.trackCompression(async () => {
            taskSignal.throwIfAborted()
            const id = await catalog.beginCompression(input, output)
            let result: T
            try {
              report({ message: '正在压缩与校验…' })
              result = await work(taskSignal, report, { inputPath: input, outputPath: output })
            } catch (error) {
              catalog.failCompression(id)
              throw error
            }
            // Publishing / backup is a commit: a late cancel must retain its actual outcome.
            report({ message: '正在处理原件备份…' })
            const record = await catalog.finishCompression(id, result.status === 'compressed')
            let archive: ArchiveAttempt | undefined
            let automaticTags: CompressionLifecycleResult['automaticTags']
            if (request.archive && (result.status === 'compressed' || archiveOnNoSavings)) {
              report({ message: '正在读取元数据并生成归档标签…' })
              automaticTags = await recommendArchiveTags(catalog, id, input, taskSignal)
              const recommendedTags = automaticTags.status === 'ready' ? automaticTags.tags : []
              report({ message: '正在归档…' })
              try {
                if (record.backupStatus === 'error')
                  throw new Error(record.backupError ?? '原件备份未完成。')
                archive = {
                  status: 'ready',
                  item: await catalog.archive(
                    id,
                    normalizeTags([...tags, ...recommendedTags]),
                    request
                  )
                }
              } catch (error) {
                archive = {
                  status: 'error',
                  error: error instanceof Error ? error.message : String(error)
                }
              }
            }
            completed = {
              ...result,
              catalog: record,
              ...(archive ? { archive } : {}),
              ...(automaticTags ? { automaticTags } : {})
            }
            const failure =
              record.backupStatus === 'error'
                ? `压缩已完成，但原件备份失败：${record.backupError ?? '请重试备份。'}`
                : archive?.status === 'error'
                  ? `压缩已完成，但归档失败：${archive.error}`
                  : archive?.status === 'ready' && archive.item.originalLink?.status === 'error'
                    ? `归档已完成，但原位置入口未创建：${archive.item.originalLink.error ?? '请重试入口创建。'}`
                    : undefined
            if (failure) throw new TaskFailure(failure, completed)
            return completed
          })
      },
      signal
    )
  } catch (error) {
    // Existing UI and Agent callers need the full business result to offer retry / recovery.
    // The Task itself remains failed and retains the same partial result.
    if (error instanceof TaskFailure && completed) return completed
    throw error
  }
}

export function compressImageAndBackup(
  request: ImageCompressionRequest & CompressionFollowUp,
  signal?: AbortSignal,
  requestId?: string
): Promise<ImageCompressionResult & CompressionLifecycleResult> {
  request = structuredClone(request)
  return complete(
    '图片压缩',
    request,
    (taskSignal, _report, paths) => compressImage({ ...request, ...paths }, taskSignal),
    signal,
    requestId,
    false
  )
}

export function compressVideoAndBackup(
  request: VideoCompressionRequest & CompressionFollowUp,
  signal?: AbortSignal,
  report?: (update: VideoCompressionProgress) => void,
  requestId?: string
): Promise<VideoCompressionResult & CompressionLifecycleResult> {
  if (request.compatibility) {
    return Promise.reject(new Error('暂不支持 H.264 转换；视频压缩仅支持 HEVC 输出。'))
  }
  request = structuredClone(request)
  return complete(
    '视频压缩',
    request,
    (taskSignal, progress, paths) =>
      compressVideo({ ...request, ...paths }, taskSignal, (update) => {
        const labels = {
          probing: '正在读取视频信息…',
          analyzing: '正在分析画质并自动选择压缩参数…',
          encoding: '正在压缩视频…',
          validating: '正在检查并解码压缩结果…'
        }
        progress({ message: labels[update.stage], percent: update.percent ?? undefined })
        report?.(update)
      }),
    signal,
    requestId
  )
}

export function compressPdfAndBackup(
  request: PdfCompressionRequest & CompressionFollowUp,
  signal?: AbortSignal,
  requestId?: string
): Promise<PdfCompressionResult & CompressionLifecycleResult> {
  request = structuredClone(request)
  return complete(
    'PDF 压缩',
    request,
    (taskSignal, _report, paths) => compressPdf({ ...request, ...paths }, taskSignal),
    signal,
    requestId
  )
}
