import { cp, lstat, mkdir, rename } from 'node:fs/promises'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import { runTask, TaskCancelled, TaskFailure } from '../../tasks/service'
import type { MoleTrashResult } from '../../../shared/contracts/mole'
import { trashPaths } from './service'

interface TransferRequest {
  sourcePath: string
  destinationPath: string
  overwrite?: boolean
}
interface TransferResult {
  sourcePath: string
  destinationPath: string
  operation: 'move' | 'copy'
}

interface CopyRequest extends TransferRequest {
  recursive?: boolean
  preserveTimestamps?: boolean
  verbatimSymlinks?: boolean
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

async function requireNewDestination(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`目标已存在，未覆盖：${path}`)
}

async function transfer(
  request: CopyRequest,
  operation: 'move' | 'copy',
  signal?: AbortSignal
): Promise<TransferResult> {
  request = structuredClone(request)
  signal?.throwIfAborted()
  const sourcePath = await resolveFilePath(request.sourcePath)
  const destinationPath = await resolveFilePath(request.destinationPath)
  if (isWithin(sourcePath, destinationPath) || isWithin(destinationPath, sourcePath))
    throw new Error('源路径与目标路径不能相同或互相包含。')
  return runTask(
    {
      title: `${operation === 'move' ? '移动' : '复制'}：${basename(sourcePath)}`,
      key: `file-write:${destinationPath}`,
      run: async (taskSignal, report) => {
        taskSignal.throwIfAborted()
        // Recheck at execution time: queued work must not rely on an old destination check.
        if (operation === 'move') await assertSystemWriteAllowed(sourcePath, true)
        await assertSystemWriteAllowed(destinationPath, operation === 'move' || !!request.overwrite)
        if (!request.overwrite) await requireNewDestination(destinationPath)
        taskSignal.throwIfAborted()
        report({ message: operation === 'move' ? '正在移动文件…' : '正在复制文件…' })
        if (operation === 'move') {
          await rename(sourcePath, destinationPath)
        } else {
          try {
            await cp(sourcePath, destinationPath, {
              recursive: request.recursive ?? true,
              force: request.overwrite ?? false,
              errorOnExist: true,
              preserveTimestamps: request.preserveTimestamps ?? false,
              verbatimSymlinks: request.verbatimSymlinks ?? false,
              filter: async (_source, destination) => {
                taskSignal.throwIfAborted()
                await assertSystemWriteAllowed(destination)
                return true
              }
            })
          } catch (error) {
            const partial = { sourcePath, destinationPath, operation, partialCopyPossible: true }
            if (taskSignal.aborted)
              throw new TaskCancelled('复制已取消，目标可能保留部分副本。', partial)
            throw new TaskFailure(error instanceof Error ? error.message : String(error), partial)
          }
        }
        return { sourcePath, destinationPath, operation }
      }
    },
    signal
  )
}

export function movePath(request: TransferRequest, signal?: AbortSignal): Promise<TransferResult> {
  return transfer(request, 'move', signal)
}

export function copyPath(request: CopyRequest, signal?: AbortSignal): Promise<TransferResult> {
  return transfer(request, 'copy', signal)
}

export async function createDirectory(
  request: { path: string; recursive?: boolean; mode?: number },
  signal?: AbortSignal
): Promise<{ path: string; operation: 'mkdir' }> {
  request = structuredClone(request)
  signal?.throwIfAborted()
  const path = await resolveFilePath(request.path)
  return runTask(
    {
      title: `创建目录：${basename(path)}`,
      key: `file-write:${path}`,
      run: async (taskSignal) => {
        taskSignal.throwIfAborted()
        await assertSystemWriteAllowed(path)
        taskSignal.throwIfAborted()
        await mkdir(path, { recursive: request.recursive ?? true, mode: request.mode })
        return { path, operation: 'mkdir' }
      }
    },
    signal
  )
}

/** Agent scheduling entry; Mole keeps its existing direct trashPaths integration. */
export async function trashFiles(
  paths: readonly string[],
  signal?: AbortSignal,
  permanent = false
): Promise<MoleTrashResult> {
  paths = [...paths]
  signal?.throwIfAborted()
  if (!paths.length) throw new Error('至少需要一个待处理路径。')
  const resolved: string[] = []
  for (const path of paths) resolved.push(await resolveFilePath(path))
  return runTask(
    {
      title: permanent ? '永久删除文件' : '移入回收站',
      key: `trash:${JSON.stringify([...resolved].sort())}`,
      run: async (taskSignal, report) => {
        const result: MoleTrashResult = {
          operation: permanent ? 'permanent-delete' : 'trash',
          completed: [],
          failed: [],
          unprocessed: [...paths]
        }
        for (let index = 0; index < resolved.length; index++) {
          try {
            taskSignal.throwIfAborted()
            report({ message: `正在处理 ${String(index + 1)} / ${String(resolved.length)}…` })
            await trashPaths([resolved[index]], taskSignal, permanent)
            result.completed.push(paths[index])
          } catch (error) {
            if (taskSignal.aborted)
              throw new TaskCancelled('清理已取消，已完成的操作保留。', result)
            result.failed.push({
              path: paths[index],
              error: error instanceof Error ? error.message : String(error)
            })
          }
          result.unprocessed = paths.slice(index + 1)
        }
        if (result.failed.length)
          throw new TaskFailure(`清理未全部完成：${JSON.stringify(result)}`, result)
        return result
      }
    },
    signal
  )
}
