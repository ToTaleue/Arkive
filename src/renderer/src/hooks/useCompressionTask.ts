import { useEffect, useState } from 'react'
import type { TaskSnapshot } from '../../../shared/contracts/task'

/** Correlate an existing compression request with its main-process task. */
export function useCompressionTask(requestId: string | null): TaskSnapshot | null {
  const [task, setTask] = useState<TaskSnapshot | null>(null)
  useEffect(() => {
    if (!requestId || !window.api?.tasks) return
    const api = window.api.tasks
    let disposed = false
    let revision = 0
    const refresh = (): void => {
      const current = ++revision
      void api.list().then(
        (items) => {
          if (!disposed && current === revision)
            setTask(items.find((item) => item.requestId === requestId) ?? null)
        },
        (error: unknown) => {
          if (!disposed) console.error('Failed to read compression task', error)
        }
      )
    }
    const unsubscribe = api.onChanged(refresh)
    refresh()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [requestId])
  return task?.requestId === requestId ? task : null
}

export function compressionTaskMessage(task: TaskSnapshot | null): string | undefined {
  if (!task || (task.status !== 'queued' && task.status !== 'running')) return undefined
  if (task.cancellationRequested) return '已请求取消，正在等待当前操作收尾…'
  if (task.status === 'queued') return '已加入队列，等待前面的任务完成…'
  return task.progress?.message
}
