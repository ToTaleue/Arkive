import { spawnBundledTool, type ToolProcess, type ToolProcessOptions } from './process'

export function spawnFfprobe(args: readonly string[], options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('ffprobe', args, options)
}
