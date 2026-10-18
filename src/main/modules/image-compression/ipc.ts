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
  imageChannels,
  type ImageCompressionOutcome,
  type ImageStartRequest,
  type SelectedImage
} from '../../../shared/contracts/image'
import { assertSystemWriteAllowed } from '../../system-paths'
import { inspectImage } from '../processing/operations'
import { compressImageAndBackup as compressImage } from '../catalog/compression'
import { TaskCancelled, TaskFailure } from '../../tasks/service'

interface WindowState {
  selection?: SelectedImage
  selecting: boolean
  inspection?: AbortController
  running?: { id: string; controller: AbortController }
  outputPath?: string
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
}

function isStartRequest(value: unknown): value is ImageStartRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return (
    isRunId(request.runId) &&
    typeof request.fileId === 'string' &&
    /^[\w-]{1,100}$/.test(request.fileId) &&
    (request.archive === undefined || typeof request.archive === 'boolean') &&
    (request.outputFormat === undefined ||
      (typeof request.outputFormat === 'string' &&
        ['webp', 'jpeg', 'png'].includes(request.outputFormat))) &&
    (request.preserveFormat === undefined || typeof request.preserveFormat === 'boolean') &&
    (request.preset === undefined ||
      (typeof request.preset === 'string' &&
        ['quality', 'balanced', 'size'].includes(request.preset))) &&
    (request.quality === undefined ||
      (typeof request.quality === 'number' &&
        Number.isInteger(request.quality) &&
        request.quality >= 1 &&
        request.quality <= 100)) &&
    (request.jpegBackground === undefined ||
      (typeof request.jpegBackground === 'string' && /^#[\da-f]{6}$/i.test(request.jpegBackground)))
  )
}

function preserveFormat(request: ImageStartRequest): boolean {
  return request.preserveFormat ?? false
}

function outputFormat(
  request: ImageStartRequest,
  selected: SelectedImage
): 'webp' | 'jpeg' | 'png' {
  if (preserveFormat(request)) {
    if (selected.format === 'jpeg' || selected.format === 'png' || selected.format === 'webp') {
      return selected.format
    }
    throw new Error('原格式输出目前仅支持 JPEG、PNG 和 WebP 输入。')
  }
  return request.outputFormat ?? 'webp'
}

export function registerImageCompressionIpc(): (contents: WebContents) => void {
  const windows = new Map<number, WindowState>()

  function getWindow(event: IpcMainInvokeEvent): { state: WindowState; window: BrowserWindow } {
    const state = windows.get(event.sender.id)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!state || !window || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('无效的图片压缩窗口。')
    }
    return { state, window }
  }

  async function selectPath(state: WindowState, inputPath: string): Promise<SelectedImage> {
    if (!inputPath) throw new Error('请选择图片文件。')
    const controller = new AbortController()
    state.inspection = controller
    try {
      const path = await realpath(inputPath)
      const info = await stat(path)
      if (!info.isFile()) throw new Error('请选择普通图片文件。')
      const inspection = await inspectImage({ inputPath: path }, controller.signal)
      controller.signal.throwIfAborted()
      const selected: SelectedImage = {
        id: randomUUID(),
        name: basename(path),
        path: inspection.inputPath,
        sizeBytes: info.size,
        ...inspection
      }
      state.selection = selected
      state.outputPath = undefined
      return selected
    } finally {
      state.inspection = undefined
    }
  }

  ipcMain.handle(imageChannels.select, async (event): Promise<SelectedImage | null> => {
    const { state, window } = getWindow(event)
    if (state.running || state.selecting) throw new Error('请等待当前操作完成。')
    state.selecting = true
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: '选择要压缩的图片',
        buttonLabel: '选择图片',
        properties: ['openFile'],
        filters: [
          {
            name: '图片',
            extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'heic', 'heif']
          },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (selected.canceled || !selected.filePaths[0] || windows.get(event.sender.id) !== state)
        return null
      return await selectPath(state, selected.filePaths[0])
    } finally {
      state.selecting = false
    }
  })

  ipcMain.handle(
    imageChannels.selectPath,
    async (event, inputPath: unknown): Promise<SelectedImage> => {
      const { state } = getWindow(event)
      if (state.running || state.selecting) throw new Error('请等待当前操作完成。')
      if (typeof inputPath !== 'string') throw new Error('拖入的文件路径无效。')
      state.selecting = true
      try {
        return await selectPath(state, inputPath)
      } finally {
        state.selecting = false
      }
    }
  )

  ipcMain.handle(
    imageChannels.compress,
    async (event, request: unknown): Promise<ImageCompressionOutcome> => {
      const { state, window } = getWindow(event)
      if (!isStartRequest(request)) throw new Error('无效的图片压缩请求。')
      if (state.running || state.selecting) throw new Error('请等待当前操作完成。')
      const selected = state.selection
      if (!selected || selected.id !== request.fileId) throw new Error('请重新选择图片。')
      if (preserveFormat(request) && request.outputFormat) {
        throw new Error('原格式输出不能与指定输出格式同时使用。')
      }
      const format = outputFormat(request, selected)
      const extension = format === 'jpeg' ? '.jpg' : `.${format}`
      const controller = new AbortController()
      state.running = { id: request.runId, controller }
      try {
        const destination = await dialog.showSaveDialog(window, {
          title: '选择压缩图片的保存位置',
          buttonLabel: '开始压缩',
          defaultPath: join(
            dirname(selected.path),
            `${parse(selected.name).name}-compressed${extension}`
          ),
          filters: [
            {
              name: format === 'jpeg' ? 'JPEG 图片' : `${format.toUpperCase()} 图片`,
              extensions: [extension.slice(1)]
            }
          ]
        })
        if (destination.canceled || !destination.filePath || controller.signal.aborted)
          return { status: 'cancelled' }
        const output = join(
          await realpath(dirname(destination.filePath)),
          basename(destination.filePath)
        )
        await assertSystemWriteAllowed(output)
        const result = await compressImage(
          {
            inputPath: selected.path,
            outputPath: output,
            ...(request.archive ? { archive: true } : {}),
            ...(request.outputFormat === undefined ? {} : { outputFormat: request.outputFormat }),
            ...(request.preserveFormat === undefined
              ? {}
              : { preserveFormat: request.preserveFormat }),
            ...(request.preset === undefined ? {} : { preset: request.preset }),
            ...(request.quality === undefined ? {} : { quality: request.quality }),
            ...(request.jpegBackground === undefined
              ? {}
              : { jpegBackground: request.jpegBackground })
          },
          controller.signal,
          request.runId
        )
        state.outputPath = result.status === 'compressed' ? result.outputPath : result.inputPath
        return { status: 'completed', result }
      } catch (error) {
        if (
          error instanceof TaskCancelled ||
          (controller.signal.aborted && !(error instanceof TaskFailure))
        )
          return { status: 'cancelled' }
        return {
          status: 'error',
          error: error instanceof Error ? error.message : '图片压缩失败，请重试。'
        }
      } finally {
        state.running = undefined
      }
    }
  )

  ipcMain.handle(imageChannels.cancel, (event, runId: unknown) => {
    const { state } = getWindow(event)
    if (isRunId(runId) && state.running?.id === runId) state.running.controller.abort()
  })

  ipcMain.handle(imageChannels.reveal, async (event) => {
    const { state } = getWindow(event)
    if (!state.outputPath) throw new Error('还没有压缩结果。')
    await stat(state.outputPath)
    shell.showItemInFolder(state.outputPath)
  })

  return (contents) => {
    const reset = (): void => {
      windows.get(contents.id)?.inspection?.abort()
      windows.get(contents.id)?.running?.controller.abort()
      windows.set(contents.id, { selecting: false })
    }
    reset()
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) reset()
    })
    contents.on('render-process-gone', reset)
    contents.once('destroyed', () => {
      windows.get(contents.id)?.inspection?.abort()
      windows.get(contents.id)?.running?.controller.abort()
      windows.delete(contents.id)
    })
  }
}
