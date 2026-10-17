import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import {
  app,
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
import { compressVideo, inspectVideo } from './service'

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
    ['quality', 'balanced', 'size'].includes(value.preset)
  )
}

async function assertAllowedPath(path: string): Promise<void> {
  const protectedPaths = [
    app.getPath('documents'),
    join(app.getPath('home'), 'Library', 'Keychains'),
    join(app.getPath('home'), 'Library', 'Mail'),
    join(app.getPath('home'), 'Library', 'Mobile Documents')
  ]
  for (const protectedPath of protectedPaths) {
    const root = await realpath(protectedPath).catch(() => protectedPath)
    const child = relative(root, path)
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) {
      throw new Error('该位置受文件保护规则限制，请选择保护目录以外的视频或输出位置。')
    }
  }
  const parts = path.toLowerCase().split(sep)
  if (
    parts.some((part) => part.endsWith('.photoslibrary') || part.endsWith('.photolibrary')) ||
    (parts.includes('com.tencent.xinwechat') && parts.includes('db_storage'))
  ) {
    throw new Error('照片图库及微信数据库受保护，不能用于视频压缩。')
  }
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
      await assertAllowedPath(path)
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
        await assertAllowedPath(input)
        await assertAllowedPath(output)
        const result = await compressVideo(
          { inputPath: input, outputPath: output, preset: request.preset },
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
