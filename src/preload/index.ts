import { catalogChannels, type ArchiveItem, type CatalogPage } from '../shared/contracts/catalog'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  processingChannels,
  type SelectedDocument,
  type ProcessingOutcome,
  type DocumentResult
} from '../shared/contracts/processing'
import type { DuplicateScanResult } from '../shared/contracts/duplicates'
import { electronAPI } from '@electron-toolkit/preload'
import type {} from './index.d'
import { taskChannels, type TaskSnapshot } from '../shared/contracts/task'
import {
  agentChannels,
  type AgentUpdate,
  type ArkiveApi,
  type AgentStatus,
  type AgentResult
} from '../shared/contracts/agent'
import {
  moleChannels,
  type MoleAnalyzeResult,
  type MoleInstalledApp,
  type MoleAuthorizationResult,
  type MolePreviewResult,
  type MoleTrashResult,
  type MoleDryRunUpdate
} from '../shared/contracts/mole'
import {
  videoChannels,
  type SelectedVideo,
  type VideoCompressionOutcome,
  type VideoCompressionUpdate
} from '../shared/contracts/video'
import {
  imageChannels,
  type ImageCompressionOutcome,
  type SelectedImage
} from '../shared/contracts/image'

// Custom APIs for renderer
const api: ArkiveApi = {
  tasks: {
    list: (batchId) => ipcRenderer.invoke(taskChannels.list, batchId) as Promise<TaskSnapshot[]>,
    get: (id) => ipcRenderer.invoke(taskChannels.get, id) as Promise<TaskSnapshot | undefined>,
    cancel: (id) => ipcRenderer.invoke(taskChannels.cancel, id) as Promise<boolean>,
    cancelBatch: (batchId) =>
      ipcRenderer.invoke(taskChannels.cancelBatch, batchId) as Promise<number>,
    onChanged: (listener) => {
      const handler = (): void => {
        listener()
      }
      ipcRenderer.on(taskChannels.changed, handler)
      return () => {
        ipcRenderer.removeListener(taskChannels.changed, handler)
      }
    }
  },
  processing: {
    select: (kind) =>
      ipcRenderer.invoke(processingChannels.select, kind) as Promise<SelectedDocument | null>,
    selectPath: (kind, path) =>
      ipcRenderer.invoke(processingChannels.selectPath, kind, path) as Promise<SelectedDocument>,
    compress: (request) =>
      ipcRenderer.invoke(processingChannels.compress, request) as Promise<
        ProcessingOutcome<DocumentResult>
      >,
    selectFolder: () =>
      ipcRenderer.invoke(processingChannels.selectFolder) as Promise<string | null>,
    duplicates: (id, path) =>
      ipcRenderer.invoke(processingChannels.duplicates, id, path) as Promise<
        ProcessingOutcome<DuplicateScanResult>
      >,
    clone: (id, request) =>
      ipcRenderer.invoke(processingChannels.clone, id, request) as Promise<
        ProcessingOutcome<
          import('../shared/contracts/clone-deduplication').CloneDeduplicationResult
        >
      >,
    cancel: (id) => ipcRenderer.invoke(processingChannels.cancel, id) as Promise<void>,
    reveal: () => ipcRenderer.invoke(processingChannels.reveal) as Promise<void>,
    localFilePath: (file) => webUtils.getPathForFile(file)
  },
  catalog: {
    archive: (id, tags, options) =>
      ipcRenderer.invoke(catalogChannels.archive, id, tags, options) as Promise<ArchiveItem>,
    query: (query) => ipcRenderer.invoke(catalogChannels.query, query) as Promise<CatalogPage>,
    get: (id) => ipcRenderer.invoke(catalogChannels.get, id) as Promise<ArchiveItem>,
    tags: (ids, add, remove) =>
      ipcRenderer.invoke(catalogChannels.tags, ids, add, remove) as Promise<void>,
    refresh: () => ipcRenderer.invoke(catalogChannels.refresh) as Promise<void>,
    retryBackup: (id) =>
      ipcRenderer.invoke(catalogChannels.retryBackup, id) as Promise<ArchiveItem>,
    open: (id, target) => ipcRenderer.invoke(catalogChannels.open, id, target) as Promise<void>,
    reveal: (id, target) => ipcRenderer.invoke(catalogChannels.reveal, id, target) as Promise<void>,
    onChanged: (listener) => {
      const handler = (): void => {
        listener()
      }
      ipcRenderer.on(catalogChannels.changed, handler)
      return () => {
        ipcRenderer.removeListener(catalogChannels.changed, handler)
      }
    }
  },
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
    selectPath: (inputPath) =>
      ipcRenderer.invoke(videoChannels.selectPath, inputPath) as Promise<SelectedVideo>,
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
  image: {
    select: () => ipcRenderer.invoke(imageChannels.select) as Promise<SelectedImage | null>,
    selectPath: (inputPath) =>
      ipcRenderer.invoke(imageChannels.selectPath, inputPath) as Promise<SelectedImage>,
    compress: (request) =>
      ipcRenderer.invoke(imageChannels.compress, request) as Promise<ImageCompressionOutcome>,
    cancel: (runId) => ipcRenderer.invoke(imageChannels.cancel, runId) as Promise<void>,
    reveal: () => ipcRenderer.invoke(imageChannels.reveal) as Promise<void>
  },
  mole: {
    dryRun: (runId) => ipcRenderer.invoke(moleChannels.dryRun, runId) as Promise<MolePreviewResult>,
    analyze: (path) => ipcRenderer.invoke(moleChannels.analyze, path) as Promise<MoleAnalyzeResult>,
    installerPreview: (runId) =>
      ipcRenderer.invoke(moleChannels.installerPreview, runId) as Promise<MolePreviewResult>,
    purgePreview: (runId) =>
      ipcRenderer.invoke(moleChannels.purgePreview, runId) as Promise<MolePreviewResult>,
    authorize: () => ipcRenderer.invoke(moleChannels.authorize) as Promise<MoleAuthorizationResult>,
    uninstallList: () =>
      ipcRenderer.invoke(moleChannels.uninstallList) as Promise<MoleInstalledApp[]>,
    trash: (paths) => ipcRenderer.invoke(moleChannels.trash, paths) as Promise<MoleTrashResult>,
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
