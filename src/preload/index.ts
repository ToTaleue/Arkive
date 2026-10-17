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
import {
  moleChannels,
  type MoleDryRunResult,
  type MoleDryRunUpdate
} from '../shared/contracts/mole'
import {
  videoChannels,
  type SelectedVideo,
  type VideoCompressionOutcome,
  type VideoCompressionUpdate
} from '../shared/contracts/video'

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
  },
  video: {
    select: () => ipcRenderer.invoke(videoChannels.select) as Promise<SelectedVideo | null>,
    compress: (request) =>
      ipcRenderer.invoke(videoChannels.compress, request) as Promise<VideoCompressionOutcome>,
    cancel: (runId) => ipcRenderer.invoke(videoChannels.cancel, runId) as Promise<void>,
    reveal: () => ipcRenderer.invoke(videoChannels.reveal) as Promise<void>,
    onUpdate: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, update: VideoCompressionUpdate): void => {
        listener(update)
      }
      ipcRenderer.on(videoChannels.update, handler)
      return () => {
        ipcRenderer.removeListener(videoChannels.update, handler)
      }
    }
  },
  mole: {
    dryRun: (runId) => ipcRenderer.invoke(moleChannels.dryRun, runId) as Promise<MoleDryRunResult>,
    onUpdate: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, update: MoleDryRunUpdate): void => {
        listener(update)
      }
      ipcRenderer.on(moleChannels.update, handler)
      return () => {
        ipcRenderer.removeListener(moleChannels.update, handler)
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
