import { realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type {
  DuplicateScanRequest,
  DuplicateScanResult
} from '../../../shared/contracts/duplicates'
import { runTask, TaskFailure } from '../../tasks/service'
import { scanDuplicates as scan } from './service'

export async function scanDuplicates(
  request: DuplicateScanRequest,
  signal?: AbortSignal,
  requestId?: string
): Promise<DuplicateScanResult> {
  request = structuredClone(request)
  signal?.throwIfAborted()
  if (!isAbsolute(request.directoryPath) || request.directoryPath.includes('\0'))
    throw new Error('重复检测须选择一个本地文件夹，使用绝对路径。')
  const directoryPath = await realpath(request.directoryPath)
  let result: DuplicateScanResult | undefined
  try {
    return await runTask(
      {
        title: `重复扫描：${basename(directoryPath)}`,
        key: `duplicates:${directoryPath}`,
        requestId,
        run: async (taskSignal, report) => {
          taskSignal.throwIfAborted()
          report({ message: '正在比较文件内容，查找重复项…' })
          result = await scan({ directoryPath }, taskSignal)
          if (result.status === 'partial')
            throw new TaskFailure('重复扫描不完整，请检查扫描警告。', result)
          return result
        }
      },
      signal
    )
  } catch (error) {
    // Keep the existing partial-report contract for UI and Agent consumers.
    if (error instanceof TaskFailure && result) return result
    throw error
  }
}
