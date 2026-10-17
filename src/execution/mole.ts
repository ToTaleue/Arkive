import {
  runBundledTool,
  spawnBundledTool,
  type ToolProcess,
  type ToolProcessOptions,
  type ToolRunResult
} from './process'

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

/** Installer preview is deliberately dry-run and debug-enabled so the adapter can recover full paths. */
export function spawnMoleInstallerDryRun(options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('mole', ['installer', '--dry-run', '--debug'], options)
}

/** Preview rebuildable project artifacts without invoking Mole's destructive confirmation. */
export function spawnMolePurgeDryRun(options?: ToolProcessOptions): ToolProcess {
  return spawnBundledTool('mole', ['purge', '--dry-run', '--debug'], options)
}

export function spawnMoleUninstallList(signal?: AbortSignal): Promise<ToolRunResult> {
  return runBundledTool('mole', ['uninstall', '--list'], {
    signal,
    maxOutputChars: 4_194_304
  })
}
