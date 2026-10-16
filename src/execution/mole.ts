import { spawnBundledTool, type ToolProcess, type ToolProcessOptions } from './process'

/** JSON mode avoids Mole's interactive disk browser and its delete actions. */
export function spawnMoleAnalysis(directory: string, options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('mole', ['analyze', '--json', directory], options)
}

export function spawnMoleStatus(options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('mole', ['status', '--json'], options)
}

/** Preview Mole's cleanup plan without changing any files. */
export function spawnMoleCleanDryRun(options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('mole', ['clean', '--dry-run'], options)
}
