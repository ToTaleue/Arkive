import { ipcMain, type WebContents } from 'electron'
import {
  agentChannels,
  isAgentRequest,
  isAgentSummaryRequest,
  isAgentRunId,
  type AgentResult
} from '../../../shared/contracts/agent'
import { agentStatus } from './config'
import { AgentService } from './service'

export function registerAgentIpc(cwd: string): (contents: WebContents) => void {
  const services = new Map<number, AgentService>()
  ipcMain.handle(agentChannels.status, (event) => {
    if (!services.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame)
      throw new Error('无效的窗口。')
    return agentStatus()
  })
  ipcMain.handle(agentChannels.send, (event, request: unknown): Promise<AgentResult> => {
    const service = services.get(event.sender.id)
    if (!service || event.senderFrame !== event.sender.mainFrame || !isAgentRequest(request)) {
      return Promise.resolve({
        status: 'error',
        text: '',
        error: '消息无效，文字长度需为 1–32000 字符。'
      })
    }
    return service.send(request, (update) => {
      if (!event.sender.isDestroyed()) event.sender.send(agentChannels.update, update)
    })
  })
  ipcMain.handle(agentChannels.stop, async (event, request: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || !isAgentRunId(request)) return
    await services.get(event.sender.id)?.stop(request)
  })
  ipcMain.handle(agentChannels.retrySummary, (event, request: unknown): Promise<AgentResult> => {
    const service = services.get(event.sender.id)
    if (!service || event.senderFrame !== event.sender.mainFrame || !isAgentSummaryRequest(request))
      return Promise.resolve({ status: 'error', text: '', error: '总结重试请求无效。' })
    return service.retrySummary(request, (update) => {
      if (!event.sender.isDestroyed()) event.sender.send(agentChannels.update, update)
    })
  })
  return (contents) => {
    const reset = (): void => {
      services.get(contents.id)?.dispose()
      services.set(contents.id, new AgentService(cwd))
    }
    reset()
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) reset()
    })
    contents.once('destroyed', () => {
      services.get(contents.id)?.dispose()
      services.delete(contents.id)
    })
    contents.on('render-process-gone', reset)
  }
}
