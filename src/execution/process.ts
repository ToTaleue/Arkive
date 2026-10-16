import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { app } from 'electron'

const toolFiles = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  mole: 'mole/mo',
  pngquant: 'pngquant',
  jpegoptim: 'jpegoptim',
  ghostscript: 'gs',
  qpdf: 'qpdf/bin/qpdf',
  czkawka_cli: 'czkawka_cli'
} as const

export type BundledTool = keyof typeof toolFiles
export type ToolProcess = ChildProcessByStdio<null, Readable, Readable>

export interface ToolProcessOptions {
  cwd?: string
  signal?: AbortSignal
}

export interface ToolRunOptions extends ToolProcessOptions {
  /** Maximum retained UTF-16 code units per output stream; excess is drained and discarded. */
  maxOutputChars?: number
}

export interface ToolRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export function getBundledToolPath(tool: BundledTool): string {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`Bundled tools do not support ${process.platform}-${process.arch}`)
  }

  const root = app.isPackaged
    ? join(process.resourcesPath, 'tools')
    : join(app.getAppPath(), 'resources', 'tools', 'darwin-arm64')
  const executable = join(root, toolFiles[tool])
  accessSync(executable, constants.X_OK)
  return executable
}

/** Main-process API. The caller must handle error/close and consume both output streams. */
export function spawnBundledTool(
  tool: BundledTool,
  args: readonly string[],
  options: ToolProcessOptions = {}
): ToolProcess {
  return spawn(getBundledToolPath(tool), args, {
    ...options,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Text-output convenience API. Resolves after close, including nonzero exits.
 * Path errors reject immediately; process errors and cancellation reject after close.
 * Exit success is not output validation.
 * Use spawnBundledTool for streaming or binary output.
 */
export async function runBundledTool(
  tool: BundledTool,
  args: readonly string[],
  options: ToolRunOptions = {}
): Promise<ToolRunResult> {
  const { maxOutputChars = 1_048_576, ...processOptions } = options
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 0) {
    throw new RangeError('maxOutputChars must be a non-negative safe integer')
  }

  const child = spawnBundledTool(tool, args, processOptions)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let processError: Error | undefined

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const remaining = maxOutputChars - stdout.length
      stdoutTruncated ||= chunk.length > remaining
      stdout += chunk.slice(0, remaining)
    })
    child.stderr.on('data', (chunk: string) => {
      const remaining = maxOutputChars - stderr.length
      stderrTruncated ||= chunk.length > remaining
      stderr += chunk.slice(0, remaining)
    })
    child.on('error', (error) => {
      processError = error
    })
    child.on('close', (exitCode, signal) => {
      if (processError) {
        reject(processError)
      } else {
        resolve({ exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated })
      }
    })
  })
}
