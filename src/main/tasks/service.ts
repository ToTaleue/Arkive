import { TaskManager, type TaskJob } from './manager'
import { TaskCancelled, TaskFailure } from './outcome'

export { DuplicateTaskError } from './manager'
export type { TaskJob, TaskBatchOptions } from './manager'
export { TaskCancelled, TaskFailure } from './outcome'

// Business entry points share this queue.
export const tasks = new TaskManager()

/** Keep Promise-based business callers waiting for the actual outcome, not just submission. */
export async function runTask<T>(job: TaskJob<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const { taskIds } = tasks.submitBatch([job], { onError: 'stop' })
  const id = taskIds[0]
  const cancel = (): void => {
    tasks.cancel(id)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  // Submission notifications can synchronously abort the caller before the listener is installed.
  if (signal?.aborted) cancel()
  try {
    const task = await tasks.wait(id)
    // This snapshot belongs to the typed job submitted above; the manager clones its result.
    if (task.status === 'succeeded') return task.result as T
    if (task.status === 'cancelled') throw new TaskCancelled(task.cancellationReason, task.result)
    throw new TaskFailure(task.error ?? task.skipReason ?? '任务未完成。', task.result)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
