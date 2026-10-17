import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { taskChannels } from '../../shared/contracts/task'
import type { TaskManager } from './manager'

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f-]{36}$/i.test(value))
    throw new Error('无效的任务或批次 ID。')
  return value
}

export function registerTasksIpc(tasks: TaskManager): (contents: WebContents) => void {
  const windows = new Set<WebContents>()

  function handle(channel: string, operation: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]): unknown => {
      if (
        !windows.has(event.sender) ||
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('无效的任务窗口。')
      return operation(...args)
    })
  }

  handle(taskChannels.list, (batchId) =>
    tasks.list(batchId === undefined ? undefined : taskId(batchId))
  )
  handle(taskChannels.get, (id) => tasks.get(taskId(id)))
  handle(taskChannels.cancel, (id) => tasks.cancel(taskId(id)))
  handle(taskChannels.cancelBatch, (batchId) => tasks.cancelBatch(taskId(batchId)))

  tasks.subscribe(() => {
    for (const contents of windows) {
      if (!contents.isDestroyed()) contents.send(taskChannels.changed)
    }
  })

  return (contents) => {
    windows.add(contents)
    contents.once('destroyed', () => {
      windows.delete(contents)
    })
  }
}
