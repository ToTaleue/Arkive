export const moleChannels = {
  dryRun: 'mole:dry-run',
  analyze: 'mole:analyze',
  installerPreview: 'mole:installer-preview',
  purgePreview: 'mole:purge-preview',
  uninstallList: 'mole:uninstall-list',
  trash: 'mole:trash',
  update: 'mole:update'
} as const

export type MoleOutputBlock = {
  id: string
  kind: 'section' | 'log' | 'summary'
  source: 'stdout' | 'stderr'
  title: string
  text: string
  /** The block was cut by an abnormal exit or the output retention limit. */
  partial: boolean
  continued: boolean
}

export type MoleOutputEvent =
  { type: 'stage'; title: string } | { type: 'block'; block: MoleOutputBlock }

export type MoleDryRunUpdate = { runId: string; event: MoleOutputEvent }

export type MoleDryRunResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  blocks: MoleOutputBlock[]
}

export type MoleCandidate = {
  path: string
  name: string
  category?: string
  source?: string
  sizeText?: string
}

export type MolePreviewResult = MoleDryRunResult & {
  kind: 'clean' | 'installer' | 'purge'
  candidates: MoleCandidate[]
}

export type MoleInstalledApp = {
  name: string
  bundleId: string
  source: string
  uninstallName: string
  path: string
  size: string
}

export type MoleTrashResult = {
  operation: 'trash' | 'permanent-delete'
  completed: string[]
  failed: { path: string; error: string }[]
  unprocessed: string[]
}

export type MoleAnalyzeResult = {
  report: unknown
  stderr: string
  stderrTruncated: boolean
}

export interface MoleApi {
  dryRun: (runId: string) => Promise<MolePreviewResult>
  analyze: (path?: string) => Promise<MoleAnalyzeResult>
  installerPreview: (runId: string) => Promise<MolePreviewResult>
  purgePreview: (runId: string) => Promise<MolePreviewResult>
  uninstallList: () => Promise<MoleInstalledApp[]>
  trash: (paths: string[]) => Promise<MoleTrashResult>
  onUpdate: (listener: (update: MoleDryRunUpdate) => void) => () => void
}
