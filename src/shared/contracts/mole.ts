export const moleChannels = {
  dryRun: 'mole:dry-run',
  clean: 'mole:clean',
  authorizationStatus: 'mole:authorization-status',
  analyze: 'mole:analyze',
  installerPreview: 'mole:installer-preview',
  purgePreview: 'mole:purge-preview',
  authorize: 'mole:authorize',
  uninstallList: 'mole:uninstall-list',
  trash: 'mole:trash',
  update: 'mole:update'
} as const

export const moleToolboxChannels = {
  analyze: 'mole:toolbox-analyze',
  apps: 'mole:toolbox-apps',
  preview: 'mole:toolbox-preview',
  uninstallPreview: 'mole:toolbox-uninstall-preview',
  execute: 'mole:toolbox-execute',
  cancel: 'mole:toolbox-cancel',
  reveal: 'mole:toolbox-reveal'
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
  /** Cancellation/timeout can interrupt descendants after the parent has already exited. */
  interrupted?: boolean
}

export type MoleCleanMode = 'preview' | 'clean'

export type MoleCleanResult = {
  mode: MoleCleanMode
  status: 'completed' | 'failed' | 'cancelled' | 'authorization-required'
  output?: MoleDryRunResult
  message?: string
}

export type MoleCandidate = {
  id?: string
  path: string
  name: string
  category?: string
  source?: string
  sizeText?: string
  sizeBytes?: number
}

export type MolePreviewResult = MoleDryRunResult & {
  previewId?: string
  kind: 'clean' | 'installer' | 'purge'
  candidates: MoleCandidate[]
}

export type MoleSelectionKind = 'installer' | 'purge' | 'uninstall'

export type MoleSelectionCandidate = MoleCandidate & {
  id: string
  appPath?: string
  role?: 'app' | 'cache' | 'log' | 'app-data'
  suggested: boolean
  unavailableReason?: string
}

export type MoleUninstallInspection = {
  apps: { path: string; bundleId: string; policy: string }[]
  candidates: (MoleCandidate & { appPath: string; role: 'app' | 'related' })[]
  reviewOnly: { appPath: string; path: string }[]
  warnings: string[]
  /** Native sibling-check causes, including exact paths when Mole reports them. */
  diagnostics?: string[]
}

export type MoleUninstallPreview = {
  previewId: string
  dryRun: true
  apps: { path: string; bundleId: string }[]
  candidates: MoleSelectionCandidate[]
  reviewOnly: { appPath: string; path: string }[]
  warnings: string[]
  diagnostics?: string[]
}

export type MoleSelectionResult = MoleTrashResult & {
  kind: MoleSelectionKind
  previewId: string
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  retained: string[]
  warnings: string[]
  diagnostics?: string[]
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

export type MoleAuthorizationResult = {
  authorized: boolean
  method: 'cached' | 'password-dialog'
}

export interface MoleApi {
  toolboxAnalyze: (runId: string, path?: string) => Promise<MoleAnalyzeResult>
  toolboxApps: (runId: string) => Promise<MoleInstalledApp[]>
  toolboxPreview: (runId: string, kind: 'installer' | 'purge') => Promise<MolePreviewResult>
  uninstallPreview: (runId: string, appPaths: string[]) => Promise<MoleUninstallPreview>
  executeSelection: (
    runId: string,
    kind: MoleSelectionKind,
    request: { previewId: string; candidateIds: string[] }
  ) => Promise<MoleSelectionResult>
  cancel: (runId: string) => Promise<void>
  reveal: (path: string) => Promise<void>
  clean: (runId: string, mode: MoleCleanMode) => Promise<MoleCleanResult>
  authorizationStatus: () => Promise<{ authorized: boolean }>
  dryRun: (runId: string) => Promise<MolePreviewResult>
  analyze: (path?: string) => Promise<MoleAnalyzeResult>
  installerPreview: (runId: string) => Promise<MolePreviewResult>
  purgePreview: (runId: string) => Promise<MolePreviewResult>
  authorize: () => Promise<MoleAuthorizationResult>
  uninstallList: () => Promise<MoleInstalledApp[]>
  trash: (paths: string[]) => Promise<MoleTrashResult>
  onUpdate: (listener: (update: MoleDryRunUpdate) => void) => () => void
}
