import { spawnBundledTool, type ToolProcess, type ToolProcessOptions } from './process'

export function spawnFfmpeg(args: readonly string[], options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('ffmpeg', ['-nostdin', ...args], options)
}
