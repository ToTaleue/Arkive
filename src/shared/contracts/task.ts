export const taskChannels = {
  list: 'tasks:list',
  get: 'tasks:get',
  cancel: 'tasks:cancel',
  cancelBatch: 'tasks:cancel-batch',
  changed: 'tasks:changed'
} as const

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped'

export interface TaskProgress {
  percent?: number
  message?: string
}

export interface TaskSnapshot {
  id: string
  batchId: string
  title: string
  /** Optional correlation with an existing UI / IPC request. */
  requestId?: string
  key?: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  cancellationRequested: boolean
  cancellationReason?: string
  progress?: TaskProgress
  result?: unknown
  error?: string
  skipReason?: string
}

export interface TaskBatch {
  batchId: string
  taskIds: string[]
}

// Submission belongs to business IPC handlers: functions never cross the IPC boundary.
export interface TasksApi {
  list: (batchId?: string) => Promise<TaskSnapshot[]>
  get: (id: string) => Promise<TaskSnapshot | undefined>
  cancel: (id: string) => Promise<boolean>
  cancelBatch: (batchId: string) => Promise<number>
  onChanged: (listener: () => void) => () => void
}
