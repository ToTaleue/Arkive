import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  processingChannels,
  type DocumentKind,
  type DocumentResult,
  type DocumentStart,
  type ProcessingOutcome,
  type SelectedDocument
} from '../../../shared/contracts/processing'
import type { DuplicateScanResult } from '../../../shared/contracts/duplicates'
import { inspectPdf } from '../pdf-compression/service'
import { inspectOffice } from '../office-compression/service'
import { compressOfficeInPlace } from '../office-compression/in-place'
import { compressPdfAndBackup } from '../catalog/compression'
import { TaskCancelled, TaskFailure } from '../../tasks/service'
import { scanDuplicates } from '../duplicate-detection/service'

type State = {
  selecting: boolean
  selected?: SelectedDocument
  running?: { id: string; controller: AbortController }
  output?: string
}
function runId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
}
function kind(value: unknown): DocumentKind {
  if (value !== 'pdf' && value !== 'office') throw new Error('请选择 PDF 或 Office 文档。')
  return value
}
function start(value: unknown): DocumentStart {
  if (!value || typeof value !== 'object') throw new Error('无效的文档请求。')
  const request = value as Record<string, unknown>
  if (
    !runId(request.runId) ||
    !runId(request.fileId) ||
    !['lossless', 'quality', 'balanced', 'size'].includes(String(request.preset)) ||
    (request.replaceConfirmed !== undefined && typeof request.replaceConfirmed !== 'boolean')
  )
    throw new Error('无效的文档参数。')
  return {
    runId: request.runId,
    fileId: request.fileId,
    preset: request.preset as DocumentStart['preset'],
    replaceConfirmed: request.replaceConfirmed
  }
}

/** Window-scoped selection and cancellation; all file work stays in existing Services. */
export function registerProcessingIpc(): (contents: WebContents) => void {
  const windows = new Map<number, State>()
  function current(event: IpcMainInvokeEvent): { state: State; window: BrowserWindow } {
    const state = windows.get(event.sender.id)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!state || !window || event.senderFrame !== event.sender.mainFrame)
      throw new Error('无效的处理窗口。')
    return { state, window }
  }
  function available(state: State): void {
    if (state.selecting || state.running) throw new Error('请等待当前操作完成。')
  }
  async function selectPath(
    state: State,
    type: DocumentKind,
    path: unknown
  ): Promise<SelectedDocument> {
    if (typeof path !== 'string' || !path) throw new Error('请选择本地文档。')
    const input = await realpath(path)
    const base = { id: randomUUID(), path: input, name: basename(input) }
    const selected: SelectedDocument =
      type === 'pdf'
        ? { ...base, kind: type, inspection: await inspectPdf({ inputPath: input }) }
        : { ...base, kind: type, inspection: await inspectOffice(input) }
    state.selected = selected
    return selected
  }
  ipcMain.handle(processingChannels.select, async (event, value: unknown) => {
    const { state, window } = current(event)
    available(state)
    const type = kind(value)
    state.selecting = true
    try {
      const picked = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [
          {
            name: type === 'pdf' ? 'PDF' : 'Office',
            extensions: type === 'pdf' ? ['pdf'] : ['docx', 'pptx']
          }
        ]
      })
      if (picked.canceled || !picked.filePaths[0] || windows.get(event.sender.id) !== state)
        return null
      return await selectPath(state, type, picked.filePaths[0])
    } finally {
      state.selecting = false
    }
  })
  ipcMain.handle(processingChannels.selectPath, async (event, value: unknown, path: unknown) => {
    const { state } = current(event)
    available(state)
    state.selecting = true
    try {
      return await selectPath(state, kind(value), path)
    } finally {
      state.selecting = false
    }
  })
  ipcMain.handle(
    processingChannels.compress,
    async (event, value: unknown): Promise<ProcessingOutcome<DocumentResult>> => {
      const { state, window } = current(event)
      available(state)
      const request = start(value)
      const selected = state.selected
      if (!selected || selected.id !== request.fileId) throw new Error('请重新选择文档。')
      if (selected.kind === 'pdf' && request.preset === 'quality')
        throw new Error('PDF 不支持此档位。')
      if (
        selected.kind === 'office' &&
        (request.preset === 'lossless' || request.replaceConfirmed !== true)
      )
        throw new Error('请确认原路径替换和完整原件备份。')
      const controller = new AbortController()
      state.running = { id: request.runId, controller }
      try {
        let result: DocumentResult
        if (selected.kind === 'pdf') {
          const destination = await dialog.showSaveDialog(window, {
            defaultPath: join(
              dirname(selected.path),
              `${parse(selected.name).name}-compressed.pdf`
            ),
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          })
          if (destination.canceled || !destination.filePath || controller.signal.aborted)
            return { status: 'cancelled' }
          // preset was checked above; keep the narrowed branch explicit.
          const preset =
            request.preset === 'lossless'
              ? 'lossless'
              : request.preset === 'size'
                ? 'size'
                : 'balanced'
          result = {
            kind: 'pdf',
            value: await compressPdfAndBackup(
              { inputPath: selected.path, outputPath: destination.filePath, preset },
              controller.signal,
              request.runId
            )
          }
        } else {
          const preset =
            request.preset === 'size'
              ? 'size'
              : request.preset === 'balanced'
                ? 'balanced'
                : 'quality'
          result = {
            kind: 'office',
            value: await compressOfficeInPlace(
              { inputPath: selected.path, preset },
              controller.signal
            )
          }
        }
        // A commit that finished after a cancellation request remains a completed operation.
        if (result.kind === 'pdf' || result.value.replacementStatus !== 'error')
          state.output = result.value.outputPath
        state.selected = undefined
        return { status: 'completed', result }
      } catch (error) {
        if (
          error instanceof TaskCancelled ||
          (controller.signal.aborted && !(error instanceof TaskFailure))
        )
          return { status: 'cancelled' }
        return { status: 'error', error: error instanceof Error ? error.message : String(error) }
      } finally {
        state.running = undefined
      }
    }
  )
  ipcMain.handle(processingChannels.selectFolder, async (event) => {
    const { state, window } = current(event)
    available(state)
    state.selecting = true
    try {
      const picked = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    } finally {
      state.selecting = false
    }
  })
  ipcMain.handle(
    processingChannels.duplicates,
    async (event, id: unknown, path: unknown): Promise<ProcessingOutcome<DuplicateScanResult>> => {
      const { state } = current(event)
      available(state)
      if (!runId(id) || typeof path !== 'string') throw new Error('无效的扫描请求。')
      const controller = new AbortController()
      state.running = { id, controller }
      try {
        return {
          status: 'completed',
          result: await scanDuplicates({ directoryPath: path }, controller.signal)
        }
      } catch (error) {
        if (controller.signal.aborted) return { status: 'cancelled' }
        return { status: 'error', error: error instanceof Error ? error.message : String(error) }
      } finally {
        state.running = undefined
      }
    }
  )
  ipcMain.handle(processingChannels.cancel, (event, id: unknown) => {
    const { state } = current(event)
    if (runId(id) && state.running?.id === id) state.running.controller.abort()
  })
  ipcMain.handle(processingChannels.reveal, async (event) => {
    const { state } = current(event)
    if (!state.output) throw new Error('还没有可定位的文档结果。')
    await stat(state.output)
    shell.showItemInFolder(state.output)
  })
  return (contents) => {
    const reset = (): void => {
      windows.get(contents.id)?.running?.controller.abort()
      windows.set(contents.id, { selecting: false })
    }
    reset()
    contents.on('did-start-navigation', (_event, _url, _inPlace, main) => {
      if (main) reset()
    })
    contents.on('render-process-gone', reset)
    contents.once('destroyed', () => {
      windows.get(contents.id)?.running?.controller.abort()
      windows.delete(contents.id)
    })
  }
}
