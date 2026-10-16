import { ipcMain } from 'electron'
import { moleChannels, type MoleDryRunUpdate } from '../../../shared/contracts/mole'
import { runMoleDryRun } from './service'

export function registerMoleIpc(): void {
  let running = false
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
}
