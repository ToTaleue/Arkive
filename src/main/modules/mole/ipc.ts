import { ipcMain } from 'electron'
import { moleChannels, type MoleDryRunUpdate } from '../../../shared/contracts/mole'
import {
  listMoleApps,
  analyzeMole,
  runMoleDryRun,
  runMoleInstallerPreview,
  runMolePurgePreview,
  trashMolePaths
} from './service'

export function registerMoleIpc(): void {
  let running = false
  ipcMain.handle(moleChannels.analyze, async (event, path: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      (path !== undefined && typeof path !== 'string')
    )
      throw new Error('无效的 Mole 分析请求。')
    return analyzeMole(path)
  })
  ipcMain.handle(moleChannels.dryRun, async (event, runId: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      typeof runId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)
    ) {
      throw new Error('无效的 Mole 运行请求。')
    }
    if (running) throw new Error('Mole 正在运行，请等待本次预览结束。')
    running = true
    const frame = event.senderFrame
    try {
      return await runMoleDryRun((output) => {
        // Do not forward a previous page's output to a reloaded renderer.
        if (!event.sender.isDestroyed() && event.sender.mainFrame === frame) {
          const update: MoleDryRunUpdate = { runId, event: output }
          event.sender.send(moleChannels.update, update)
        }
      })
    } finally {
      running = false
    }
  })
  ipcMain.handle(moleChannels.installerPreview, async (event, runId: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      typeof runId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)
    ) {
      throw new Error('无效的 Mole 安装包预览请求。')
    }
    if (running) throw new Error('Mole 正在运行，请等待本次预览结束。')
    running = true
    const frame = event.senderFrame
    try {
      return await runMoleInstallerPreview((output) => {
        if (!event.sender.isDestroyed() && event.sender.mainFrame === frame) {
          const update: MoleDryRunUpdate = { runId, event: output }
          event.sender.send(moleChannels.update, update)
        }
      })
    } finally {
      running = false
    }
  })
  ipcMain.handle(moleChannels.purgePreview, async (event, runId: unknown) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      typeof runId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)
    ) {
      throw new Error('无效的 Mole 开发产物预览请求。')
    }
    if (running) throw new Error('Mole 正在运行，请等待本次预览结束。')
    running = true
    const frame = event.senderFrame
    try {
      return await runMolePurgePreview((output) => {
        if (!event.sender.isDestroyed() && event.sender.mainFrame === frame) {
          const update: MoleDryRunUpdate = { runId, event: output }
          event.sender.send(moleChannels.update, update)
        }
      })
    } finally {
      running = false
    }
  })
  ipcMain.handle(moleChannels.uninstallList, async (event) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('无效的 Mole 应用清单请求。')
    return listMoleApps()
  })
  ipcMain.handle(moleChannels.trash, async (event, paths: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !Array.isArray(paths))
      throw new Error('无效的 Mole 回收站请求。')
    if (
      paths.length === 0 ||
      paths.length > 100 ||
      paths.some((path) => typeof path !== 'string' || !path.startsWith('/'))
    ) {
      throw new Error('Mole 回收站请求包含无效路径。')
    }
    return trashMolePaths(paths)
  })
}
