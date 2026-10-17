import { shell } from 'electron'
import { rm } from 'node:fs/promises'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import type { MoleTrashResult } from '../../../shared/contracts/mole'

/** Shared destructive file operation used by UI and Agent tools. */
export async function trashPaths(
  paths: readonly string[],
  signal?: AbortSignal,
  permanent = false
): Promise<MoleTrashResult> {
  if (paths.length === 0) throw new Error('至少需要一个待处理路径。')
  const completed: string[] = []
  const failed: { path: string; error: string }[] = []

  for (const requestedPath of paths) {
    try {
      signal?.throwIfAborted()
      const path = await resolveFilePath(requestedPath)
      await assertSystemWriteAllowed(path, true)
      signal?.throwIfAborted()
      if (permanent) await rm(path, { recursive: true })
      else await shell.trashItem(path)
      completed.push(requestedPath)
    } catch (error) {
      failed.push({
        path: requestedPath,
        error: error instanceof Error ? error.message : String(error)
      })
      if (signal?.aborted) break
    }
  }

  const result: MoleTrashResult = {
    operation: permanent ? 'permanent-delete' : 'trash',
    completed,
    failed,
    unprocessed: paths.slice(completed.length + failed.length)
  }
  if (failed.length > 0) throw new Error(`清理未全部完成：${JSON.stringify(result)}`)
  return result
}
