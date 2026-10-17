import { TaskManager } from './manager'

export { DuplicateTaskError } from './manager'
export type { TaskJob, TaskBatchOptions } from './manager'
export { TaskCancelled, TaskFailure } from './outcome'

// Business entry points share this queue. No existing operation submits work yet.
export const tasks = new TaskManager()
