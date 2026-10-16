import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { app } from 'electron'

export type BundledTool = 'ffmpeg' | 'ffprobe' | 'mole'
export type ToolProcess = ChildProcessByStdio<null, Readable, Readable>

export interface ToolProcessOptions {
  cwd?: string
  signal?: AbortSignal
}

const toolFiles: Record<BundledTool, string> = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  mole: 'mole/mo'
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
