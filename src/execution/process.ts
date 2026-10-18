import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { app } from 'electron'

const toolFiles = {
  'ab-av1': 'ab-av1',
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  mole: 'mole/mo',
  'mole-uninstall-preview': 'mole/arkive-uninstall-preview.sh',
  pngquant: 'pngquant',
  qpdf: 'qpdf/bin/qpdf',
  czkawka_cli: 'czkawka_cli',
  apfs_dedupe: 'arkive-apfs-dedupe',
  ssimulacra2: 'ssimulacra2'
} as const

export type BundledTool = keyof typeof toolFiles
export type ToolProcess = ChildProcessByStdio<null, Readable, Readable>

export interface ToolProcessOptions {
  cwd?: string
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Put an orchestrator and its subprocesses in a private group; cancel the whole group. */
  killTreeOnAbort?: boolean
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
  const { killTreeOnAbort = false, ...spawnOptions } = options
  // Signal the process group before Node's signal handler terminates its leader.
  // On macOS, killing the group after its leader exits can race with group teardown (EPERM).
  const treeController = killTreeOnAbort && options.signal ? new AbortController() : undefined
  const child = spawn(getBundledToolPath(tool), args, {
    ...spawnOptions,
    signal: treeController?.signal ?? options.signal,
    detached: killTreeOnAbort,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (treeController && options.signal) {
    const abort = (): void => {
      try {
        // The task owns all temporary files. Kill descendants too before their pipes close
        // and the caller removes that directory, even if the parent already received SIGTERM.
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          child.emit('error', error)
        }
      } finally {
        treeController.abort(options.signal?.reason)
      }
    }
    options.signal.addEventListener('abort', abort, { once: true })
    child.once('close', () => options.signal?.removeEventListener('abort', abort))
    if (options.signal.aborted) queueMicrotask(abort)
  }
  return child
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
  return collectProcess(child, maxOutputChars)
}

function collectProcess(child: ToolProcess, maxOutputChars: number): Promise<ToolRunResult> {
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

/** Only fixed macOS executables needed by the catalog; never invokes a shell. */
export function runSystemTool(
  tool: 'osascript' | 'ditto',
  args: readonly string[]
): Promise<ToolRunResult> {
  if (process.platform !== 'darwin') throw new Error('Finder 标签和原件备份仅支持 macOS。')
  const child = spawn(`/usr/bin/${tool}`, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  return collectProcess(child, 65_536)
}

/** Validate the current user's sudo session without exposing credentials to a renderer. */
export function runSudoValidation(password?: string): Promise<ToolRunResult> {
  if (process.platform !== 'darwin') throw new Error('系统管理员授权仅支持 macOS。')
  const withPassword = password !== undefined
  // A status check must not keep an otherwise idle authorization alive.
  const child = spawn('/usr/bin/sudo', withPassword ? ['-S', '-p', '', '-v'] : ['-n', 'true'], {
    shell: false,
    stdio: [withPassword ? 'pipe' : 'ignore', 'ignore', 'pipe']
  })
  if (withPassword) {
    if (!child.stdin) throw new Error('无法打开 sudo 授权输入。')
    const secret = Buffer.from(`${password}\n`, 'utf8')
    child.stdin.write(secret)
    secret.fill(0)
    child.stdin.end()
  }
  return new Promise((resolve, reject) => {
    let stderr = ''
    let processError: Error | undefined
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk.slice(0, 65_536 - stderr.length)
    })
    child.once('error', (error) => {
      processError = error
    })
    child.once('close', (exitCode, signal) => {
      if (processError) reject(processError)
      else
        resolve({
          exitCode,
          signal,
          stdout: '',
          stderr,
          stdoutTruncated: false,
          stderrTruncated: false
        })
    })
  })
}
