import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import type { MoleOutputEvent, MolePreviewResult } from '../../../shared/contracts/mole'
import { runTask, TaskFailure } from '../../tasks/service'
import { trashFiles } from '../file-operations/operations'
import {
  analyzeMole as analyze,
  listMoleApps as listApps,
  runMoleDryRun as clean,
  runMoleInstallerPreview as installer,
  runMolePurgePreview as purge
} from './service'

/** Preview processes share Mole's mutable lists; all product callers use this queue. */
async function preview(
  kind: MolePreviewResult['kind'],
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal,
  requestId?: string
): Promise<MolePreviewResult> {
  const titles = {
    clean: 'Mole 清理预览',
    installer: 'Mole 安装包预览',
    purge: 'Mole 开发产物预览'
  }
  const work = { clean, installer, purge }[kind]
  let result: MolePreviewResult | undefined
  try {
    return await runTask(
      {
        title: titles[kind],
        key: 'mole-preview',
        requestId,
        run: async (taskSignal, report) => {
          taskSignal.throwIfAborted()
          report({ message: `正在执行${titles[kind]}…` })
          result = await work((event) => {
            if (event.type === 'stage') report({ message: event.title })
            onUpdate(event)
          }, taskSignal)
          taskSignal.throwIfAborted()
          if (
            result.stdoutTruncated ||
            result.stderrTruncated ||
            result.blocks.some((block) => block.partial)
          )
            throw new TaskFailure('Mole 预览输出不完整，请检查诊断信息。', result)
          return result
        }
      },
      signal
    )
  } catch (error) {
    if (error instanceof TaskFailure && result) return result
    throw error
  }
}

export function runMoleDryRun(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal,
  requestId?: string
): Promise<MolePreviewResult> {
  return preview('clean', onUpdate, signal, requestId)
}
export function runMoleInstallerPreview(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal,
  requestId?: string
): Promise<MolePreviewResult> {
  return preview('installer', onUpdate, signal, requestId)
}
export function runMolePurgePreview(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal,
  requestId?: string
): Promise<MolePreviewResult> {
  return preview('purge', onUpdate, signal, requestId)
}

export async function analyzeMole(
  path = homedir(),
  signal?: AbortSignal
): ReturnType<typeof analyze> {
  signal?.throwIfAborted()
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Mole 分析路径必须是绝对路径。')
  path = await realpath(path)
  let result: Awaited<ReturnType<typeof analyze>> | undefined
  try {
    return await runTask(
      {
        title: `Mole 占用分析：${basename(path)}`,
        key: `mole-analyze:${path}`,
        run: async (taskSignal, report) => {
          taskSignal.throwIfAborted()
          report({ message: '正在分析磁盘占用…' })
          result = await analyze(path, taskSignal)
          taskSignal.throwIfAborted()
          const reportData = result.report
          if (
            result.stderrTruncated ||
            (reportData !== null &&
              typeof reportData === 'object' &&
              'scan_status' in reportData &&
              reportData.scan_status !== 'complete')
          )
            throw new TaskFailure('Mole 占用分析不完整，请检查 scan_status 和诊断信息。', result)
          return result
        }
      },
      signal
    )
  } catch (error) {
    if (error instanceof TaskFailure && result) return result
    throw error
  }
}

export function listMoleApps(signal?: AbortSignal): ReturnType<typeof listApps> {
  return runTask(
    {
      title: 'Mole 应用清单',
      key: 'mole-apps',
      run: async (taskSignal, report) => {
        taskSignal.throwIfAborted()
        report({ message: '正在读取已安装应用清单…' })
        const result = await listApps(taskSignal)
        taskSignal.throwIfAborted()
        return result
      }
    },
    signal
  )
}

// Share the same deletion task and partial-result semantics as the Agent file tool.
export const trashMolePaths = trashFiles
