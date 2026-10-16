export const moleChannels = {
  dryRun: 'mole:dry-run',
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

export interface MoleApi {
  dryRun: (runId: string) => Promise<MoleDryRunResult>
  onUpdate: (listener: (update: MoleDryRunUpdate) => void) => () => void
}
