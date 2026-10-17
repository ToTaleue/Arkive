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
  videoChannels,
  type SelectedVideo,
  type VideoCompressionOutcome,
  type VideoCompressionUpdate,
  type VideoStartRequest
} from '../../../shared/contracts/video'
import { assertSystemWriteAllowed } from '../../system-paths'
import { inspectVideo } from './service'
import { compressVideoAndBackup as compressVideo } from '../catalog/compression'

interface WindowState {
  selection?: SelectedVideo
  selecting: boolean
  running?: { id: string; controller: AbortController }
  outputPath?: string
}

function isStartRequest(value: unknown): value is VideoStartRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runId' in value &&
    typeof value.runId === 'string' &&
    /^[\w-]{1,100}$/.test(value.runId) &&
    'fileId' in value &&
    typeof value.fileId === 'string' &&
    'preset' in value &&
    typeof value.preset === 'string' &&
    ['quality', 'balanced', 'size'].includes(value.preset) &&
    (!('compatibility' in value) || typeof value.compatibility === 'boolean')
  )
}

export function registerVideoCompressionIpc(): (contents: WebContents) => void {
  const windows = new Map<number, WindowState>()
  function getWindow(event: IpcMainInvokeEvent): { state: WindowState; window: BrowserWindow } {
    const state = windows.get(event.sender.id)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!state || !window || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('无效的视频压缩窗口。')
    }
    return { state, window }
  }

  ipcMain.handle(videoChannels.select, async (event): Promise<SelectedVideo | null> => {
    const { state, window } = getWindow(event)
    if (state.running || state.selecting) throw new Error('请等待当前操作完成。')
    state.selecting = true
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: '选择要压缩的视频',
        buttonLabel: '选择视频',
        properties: ['openFile'],
        filters: [
          { name: '视频', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (selected.canceled || !selected.filePaths[0] || windows.get(event.sender.id) !== state)
        return null
      const path = await realpath(selected.filePaths[0])
      const info = await stat(path)
      if (!info.isFile()) throw new Error('请选择普通视频文件。')
      const inspection = await inspectVideo(path)
      if (windows.get(event.sender.id) !== state) return null
      state.selection = {
        id: randomUUID(),
        name: basename(path),
        path,
        sizeBytes: info.size,
        ...inspection
      }
      state.outputPath = undefined
      return state.selection
    } finally {
      state.selecting = false
    }
  })

  ipcMain.handle(
    videoChannels.compress,
    async (event, request: unknown): Promise<VideoCompressionOutcome> => {
      const { state, window } = getWindow(event)
      if (!isStartRequest(request)) throw new Error('无效的视频压缩请求。')
      if (state.running || state.selecting) throw new Error('请等待当前操作完成。')
      const selected = state.selection
      if (!selected || selected.id !== request.fileId) throw new Error('请重新选择视频。')
      const controller = new AbortController()
      state.running = { id: request.runId, controller }
      const frame = event.senderFrame
      try {
        const destination = await dialog.showSaveDialog(window, {
          title: '选择压缩视频的保存位置',
          buttonLabel: '开始压缩',
          defaultPath: join(dirname(selected.path), `${parse(selected.name).name}-compressed.mp4`),
          filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
        })
        if (destination.canceled || !destination.filePath || controller.signal.aborted)
          return { status: 'cancelled' }
        const input = await realpath(selected.path)
        const output = join(
          await realpath(dirname(destination.filePath)),
          basename(destination.filePath)
        )
        await assertSystemWriteAllowed(output)
        const result = await compressVideo(
          {
            inputPath: input,
            outputPath: output,
            preset: request.preset,
            compatibility: request.compatibility
          },
          controller.signal,
          (progress) => {
            if (
              !event.sender.isDestroyed() &&
              event.sender.mainFrame === frame &&
              windows.get(event.sender.id) === state
            ) {
              const update: VideoCompressionUpdate = { runId: request.runId, ...progress }
              event.sender.send(videoChannels.update, update)
            }
          }
        )
        state.outputPath = result.outputPath
        return { status: 'completed', result }
      } catch (error) {
        if (controller.signal.aborted) return { status: 'cancelled' }
        return {
          status: 'error',
          error: error instanceof Error ? error.message : '视频压缩失败，请重试。'
        }
      } finally {
        state.running = undefined
      }
    }
  )

  ipcMain.handle(videoChannels.cancel, (event, runId: unknown) => {
    const { state } = getWindow(event)
    if (typeof runId === 'string' && state.running?.id === runId) state.running.controller.abort()
  })
  ipcMain.handle(videoChannels.reveal, async (event) => {
    const { state } = getWindow(event)
    if (!state.outputPath) throw new Error('还没有压缩结果。')
    await stat(state.outputPath)
    shell.showItemInFolder(state.outputPath)
  })

  return (contents) => {
    const reset = (): void => {
      windows.get(contents.id)?.running?.controller.abort()
      windows.set(contents.id, { selecting: false })
    }
    reset()
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) reset()
    })
    contents.on('render-process-gone', reset)
    contents.once('destroyed', () => {
      windows.get(contents.id)?.running?.controller.abort()
      windows.delete(contents.id)
    })
  }
}
