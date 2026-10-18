import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { runTask } from '../../tasks/service'
import { inspectImage as image } from '../image-compression/service'
import { inspectVideo as video } from '../video-compression/service'
import { inspectPdf as pdf } from '../pdf-compression/service'
import { inspectOffice as office } from '../office-compression/service'

/** Product inspection entry points. Encoders keep using the raw inspections internally. */
async function inspect<T>(
  kind: string,
  inputPath: string,
  work: (path: string, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted()
  const path = await realpath(inputPath)
  return runTask(
    {
      title: `${kind} 探测：${basename(path)}`,
      key: `inspect:${kind}:${path}`,
      run: async (taskSignal, report) => {
        taskSignal.throwIfAborted()
        report({ message: `正在检测 ${kind}…` })
        const result = await work(path, taskSignal)
        taskSignal.throwIfAborted()
        return result
      }
    },
    signal
  )
}

export function inspectImage(
  request: Parameters<typeof image>[0],
  signal?: AbortSignal
): ReturnType<typeof image> {
  return inspect(
    '图片',
    request.inputPath,
    (path, active) => image({ inputPath: path }, active),
    signal
  )
}
export function inspectVideo(path: string, signal?: AbortSignal): ReturnType<typeof video> {
  return inspect('视频', path, video, signal)
}
export function inspectPdf(
  request: Parameters<typeof pdf>[0],
  signal?: AbortSignal
): ReturnType<typeof pdf> {
  return inspect(
    'PDF',
    request.inputPath,
    (path, active) => pdf({ inputPath: path }, active),
    signal
  )
}
export function inspectOffice(path: string, signal?: AbortSignal): ReturnType<typeof office> {
  return inspect('Office', path, office, signal)
}
