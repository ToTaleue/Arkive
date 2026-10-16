import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {} from './index.d'
import {
  agentChannels,
  type AgentUpdate,
  type ArkiveApi,
  type AgentStatus,
  type AgentResult
} from '../shared/contracts/agent'

// Custom APIs for renderer
const api: ArkiveApi = {
  agent: {
    status: () => ipcRenderer.invoke(agentChannels.status) as Promise<AgentStatus>,
    send: (request) => ipcRenderer.invoke(agentChannels.send, request) as Promise<AgentResult>,
    stop: (request) => ipcRenderer.invoke(agentChannels.stop, request) as Promise<void>,
    onUpdate: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, update: AgentUpdate): void => {
        listener(update)
      }
      ipcRenderer.on(agentChannels.update, handler)
      return () => {
        ipcRenderer.removeListener(agentChannels.update, handler)
      }
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
