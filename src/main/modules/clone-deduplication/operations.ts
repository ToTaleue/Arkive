import { basename } from 'node:path'
import type {
  CloneDeduplicationRequest,
  CloneDeduplicationResult
} from '../../../shared/contracts/clone-deduplication'
import { resolveFilePath } from '../../system-paths'
import { runTask, TaskCancelled, TaskFailure } from '../../tasks/service'
import { cloneDuplicates as deduplicate } from './service'

/** One task owns the full clone transaction, including rollback and retained recovery files. */
export async function cloneDuplicates(
  request: CloneDeduplicationRequest,
  signal?: AbortSignal
): Promise<CloneDeduplicationResult> {
  request = structuredClone(request)
  signal?.throwIfAborted()
  const sourcePath = await resolveFilePath(request.sourcePath)
  const duplicatePaths = await Promise.all(request.duplicatePaths.map(resolveFilePath))
  let result: CloneDeduplicationResult | undefined
  try {
    return await runTask(
      {
        title: `APFS 无损去重：${basename(sourcePath)}`,
        key: `clone:${JSON.stringify([sourcePath, [...new Set(duplicatePaths)].sort()])}`,
        run: async (taskSignal, report) => {
          taskSignal.throwIfAborted()
          report({ message: '正在校验内容并进行 APFS 克隆去重…' })
          result = await deduplicate({ sourcePath, duplicatePaths }, taskSignal)
          if (result.items.some((item) => item.status === 'failed' || item.recoveryPath))
            throw new TaskFailure('APFS 去重未全部完成，请检查逐项结果及恢复路径。', result)
          if (result.status === 'cancelled')
            throw new TaskCancelled('去重已取消，已提交的结果保留。', result)
          if (result.status === 'partial')
            throw new TaskFailure('APFS 去重仍有未处理项目。', result)
          return result
        }
      },
      signal
    )
  } catch (error) {
    // Preserve partial/cancelled items for the existing product contract.
    if ((error instanceof TaskFailure || error instanceof TaskCancelled) && result) return result
    throw error
  }
}
