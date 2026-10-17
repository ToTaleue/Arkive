import { chmod, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { assertSystemWriteAllowed } from '../../system-paths'
import { runTask, TaskFailure } from '../../tasks/service'
import type { TaskProgress } from '../../../shared/contracts/task'
import { getCatalog } from '../catalog/service'
import { hashFile, syncFile } from '../catalog/files'
import { fileTags } from '../catalog/finder-tags'
import { compressOffice } from './service'
import { prepareOfficeReplacement } from './replacement'
import type {
  OfficeCompressionRequest,
  OfficeReplacementResult
} from '../../../shared/contracts/office'

/** Explicit user-authorized product entry: backup the whole document, then publish in place. */
export async function compressOfficeInPlace(
  request: Omit<OfficeCompressionRequest, 'outputPath'>,
  signal?: AbortSignal,
  requestId?: string
): Promise<OfficeReplacementResult> {
  request = structuredClone(request)
  signal?.throwIfAborted()
  const input = await realpath(request.inputPath)
  await assertSystemWriteAllowed(input, true)
  const catalog = getCatalog()
  let completed: OfficeReplacementResult | undefined
  try {
    return await runTask(
      {
        title: `Office 压缩：${basename(input)}`,
        key: `compress:${input}`,
        requestId,
        run: async (taskSignal, report) => {
          completed = await catalog.trackCompression(() =>
            replace({ ...request, inputPath: input }, taskSignal, report)
          )
          if (completed.replacementStatus === 'error')
            throw new TaskFailure(
              completed.replacementError ?? 'Office 原路径发布失败。',
              completed
            )
          return completed
        }
      },
      signal
    )
  } catch (error) {
    // Preserve the existing recovery result while the Task records the failed publication.
    if (error instanceof TaskFailure && completed) return completed
    throw error
  }
}

async function replace(
  request: Omit<OfficeCompressionRequest, 'outputPath'>,
  signal: AbortSignal,
  report: (progress: TaskProgress) => void
): Promise<OfficeReplacementResult> {
  signal.throwIfAborted()
  const input = request.inputPath
  await assertSystemWriteAllowed(input, true)
  const catalog = getCatalog()
  const directory = await mkdtemp(join(dirname(input), '.arkive-office-replace-'))
  const output = join(directory, basename(input))
  let id: string | undefined
  let prepared = false
  try {
    const mode = (await stat(input)).mode
    id = await catalog.beginCompression(input, output)
    report({ message: '正在压缩并校验文档内嵌媒体…' })
    const result = await compressOffice(
      { ...request, inputPath: input, outputPath: output },
      signal
    )
    signal.throwIfAborted()
    if (result.status === 'no-savings') {
      catalog.repo.update(id, { compression_status: 'no-savings', backup_status: 'skipped' })
      return { ...result, replacementStatus: 'unchanged' }
    }
    await chmod(output, mode & 0o777)
    // Carry Finder tags to the current document as well as keeping them in the backup.
    await fileTags(output, catalog.repo.tags(id))
    await syncFile(output)
    const hash = await hashFile(output)
    signal.throwIfAborted()
    // Generic recovery must never observe a ready Office result without its publication plan.
    catalog.repo.db.exec('BEGIN IMMEDIATE')
    try {
      catalog.repo.update(id, {
        output_hash: hash,
        output_bytes: result.outputBytes,
        compression_status: 'ready',
        backup_status: 'pending'
      })
      prepareOfficeReplacement(catalog.repo, id)
      catalog.repo.db.exec('COMMIT')
    } catch (error) {
      catalog.repo.db.exec('ROLLBACK')
      throw error
    }
    prepared = true
    // Publication is a commit point: accepted cancellation before this point leaves the source.
    try {
      report({ message: '正在备份完整原件并发布文档…' })
      const record = await catalog.finishOfficeReplacement(id)
      return { ...result, outputPath: input, replacementStatus: 'replaced', catalog: record }
    } catch (error) {
      return {
        ...result,
        replacementStatus: 'error',
        catalog: catalog.repo.item(id),
        replacementError: error instanceof Error ? error.message : String(error)
      }
    }
  } catch (error) {
    if (id && !prepared) catalog.failCompression(id)
    throw error
  } finally {
    // A persisted plan owns its candidate until publication/recovery has completed.
    if (!prepared) await rm(directory, { recursive: true, force: true })
  }
}
