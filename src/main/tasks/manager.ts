import { randomUUID } from 'node:crypto'
import type { TaskBatch, TaskProgress, TaskSnapshot } from '../../shared/contracts/task'
import { TaskCancelled, TaskFailure } from './outcome'

export interface TaskJob {
  title: string
  /** Business-defined identity for an operation; reserved while queued or running. */
  key?: string
  run: (signal: AbortSignal, reportProgress: (progress: TaskProgress) => void) => Promise<unknown>
}

export interface TaskBatchOptions {
  onError: 'continue' | 'stop'
}

interface TaskEntry {
  snapshot: TaskSnapshot
  onError: TaskBatchOptions['onError']
  run?: TaskJob['run']
  controller?: AbortController
}

export class DuplicateTaskError extends Error {
  constructor(
    readonly key: string,
    readonly taskId?: string
  ) {
    super(`任务“${key}”已提交，请等待当前任务结束。`)
    this.name = 'DuplicateTaskError'
  }
}

/** One FIFO queue; each batch explicitly chooses whether to continue on failure. */
export class TaskManager {
  private readonly entries = new Map<string, TaskEntry>()
  private readonly listeners = new Set<() => void>()
  private readonly queue: TaskEntry[] = []
  private draining = false
  private closing = false
  private closePromise?: Promise<void>
  private resolveClose?: () => void

  submitBatch(jobs: readonly TaskJob[], options: TaskBatchOptions): TaskBatch {
    if (this.closing) throw new Error('任务队列已关闭，不再接受新任务。')
    if (jobs.length === 0) throw new Error('任务批次不能为空。')
    const keys = new Map<string, string | undefined>()
    for (const { snapshot } of this.entries.values()) {
      if (
        snapshot.key !== undefined &&
        (snapshot.status === 'queued' || snapshot.status === 'running')
      )
        keys.set(snapshot.key, snapshot.id)
    }
    // Validate the whole batch before publishing or scheduling any of it.
    for (const job of jobs) {
      if (!job.title.trim() || typeof job.run !== 'function')
        throw new Error('任务需要名称和执行函数。')
      if (job.key !== undefined) {
        if (!job.key.trim()) throw new Error('任务防重标识不能为空。')
        if (keys.has(job.key)) throw new DuplicateTaskError(job.key, keys.get(job.key))
        keys.set(job.key, undefined)
      }
    }
    const batchId = randomUUID()
    const taskIds = jobs.map((job) => {
      const id = randomUUID()
      const entry: TaskEntry = {
        snapshot: {
          id,
          batchId,
          title: job.title.trim(),
          ...(job.key === undefined ? {} : { key: job.key }),
          status: 'queued',
          createdAt: Date.now(),
          cancellationRequested: false
        },
        onError: options.onError,
        run: job.run
      }
      this.entries.set(id, entry)
      this.queue.push(entry)
      return id
    })
    this.emitChanged()
    queueMicrotask(() => {
      void this.drain()
    })
    return { batchId, taskIds }
  }

  list(batchId?: string): TaskSnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => batchId === undefined || entry.snapshot.batchId === batchId)
      .map((entry) => structuredClone(entry.snapshot))
  }

  get(id: string): TaskSnapshot | undefined {
    const entry = this.entries.get(id)
    return entry ? structuredClone(entry.snapshot) : undefined
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry || entry.snapshot.cancellationRequested) return false
    if (entry.snapshot.status === 'queued') {
      entry.snapshot.cancellationRequested = true
      entry.snapshot.status = 'cancelled'
      entry.snapshot.finishedAt = Date.now()
      entry.run = undefined
      this.emitChanged()
      return true
    }
    if (entry.snapshot.status !== 'running') return false
    entry.snapshot.cancellationRequested = true
    entry.controller?.abort()
    this.emitChanged()
    return true
  }

  /** Cancel queued work before signalling the active job. Completed work is kept. */
  cancelBatch(batchId: string): number {
    const entries = [...this.entries.values()].filter((entry) => entry.snapshot.batchId === batchId)
    let count = 0
    for (const entry of entries) {
      if (entry.snapshot.status === 'queued' && this.cancel(entry.snapshot.id)) count++
    }
    for (const entry of entries) {
      if (entry.snapshot.status === 'running' && this.cancel(entry.snapshot.id)) count++
    }
    return count
  }

  /** Close permanently; settle only after the active execution has finished cleanup. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve
    })
    const entries = [...this.entries.values()]
    for (const entry of entries) {
      if (entry.snapshot.status === 'queued') this.cancel(entry.snapshot.id)
    }
    this.queue.length = 0
    for (const entry of entries) {
      if (entry.snapshot.status === 'running') this.cancel(entry.snapshot.id)
    }
    if (!this.draining) this.finishClose()
    return this.closePromise
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      let entry: TaskEntry | undefined
      while ((entry = this.queue.shift())) {
        if (entry.snapshot.status !== 'queued' || !entry.run) continue
        const run = entry.run
        const current = entry
        const controller = new AbortController()
        current.controller = controller
        current.snapshot.status = 'running'
        current.snapshot.startedAt = Date.now()
        this.emitChanged()
        try {
          // A listener may cancel synchronously on the running notification.
          controller.signal.throwIfAborted()
          const result = await run(controller.signal, (progress) => {
            if (current.snapshot.status !== 'running') return
            if (
              progress.percent !== undefined &&
              (!Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100)
            )
              throw new Error('任务进度必须介于 0 到 100。')
            current.snapshot.progress = { ...progress }
            this.emitChanged()
          })
          // Results must be cloneable for snapshots / IPC. A resolved operation may
          // already have committed files, even if cancellation was requested late.
          current.snapshot.result = structuredClone(result)
          current.snapshot.status = 'succeeded'
        } catch (error) {
          if (error instanceof TaskFailure || error instanceof TaskCancelled)
            current.snapshot.result = error.result
          if (error instanceof TaskCancelled) current.snapshot.cancellationReason = error.message
          const cancelled =
            error instanceof TaskCancelled ||
            (!(error instanceof TaskFailure) && controller.signal.aborted)
          current.snapshot.status = cancelled ? 'cancelled' : 'failed'
          if (!cancelled) {
            current.snapshot.error = error instanceof Error ? error.message : String(error)
            if (current.onError === 'stop') this.skipRemainingBatch(current.snapshot)
          }
        } finally {
          current.snapshot.finishedAt = Date.now()
          current.run = undefined
          current.controller = undefined
          this.emitChanged()
        }
      }
    } finally {
      this.draining = false
      if (this.closing) this.finishClose()
    }
  }

  private finishClose(): void {
    this.resolveClose?.()
    this.resolveClose = undefined
  }

  private skipRemainingBatch(failed: TaskSnapshot): void {
    for (const entry of this.entries.values()) {
      if (entry.snapshot.batchId !== failed.batchId || entry.snapshot.status !== 'queued') continue
      entry.snapshot.status = 'skipped'
      entry.snapshot.skipReason = `同批次任务“${failed.title}”失败，本项未执行。`
      entry.snapshot.finishedAt = Date.now()
      entry.run = undefined
    }
  }

  private emitChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        // A view or subscriber must not break execution or block other subscribers.
        console.error('Task subscriber failed', error)
      }
    }
  }
}
