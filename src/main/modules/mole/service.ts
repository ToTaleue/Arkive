import { spawnMoleCleanDryRun } from '../../../execution/mole'
import { MoleOutputParser } from '../../../execution/mole-output'
import type {
  MoleDryRunResult,
  MoleOutputBlock,
  MoleOutputEvent
} from '../../../shared/contracts/mole'

const maxOutputChars = 1_048_576

export async function runMoleDryRun(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal
): Promise<MoleDryRunResult> {
  const timeout = AbortSignal.timeout(120_000)
  const child = spawnMoleCleanDryRun({
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  const blocks: MoleOutputBlock[] = []
  const emit = (event: MoleOutputEvent): void => {
    if (event.type === 'block') blocks.push(event.block)
    onUpdate(event)
  }
  const stdoutParser = new MoleOutputParser('stdout', emit)
  const stderrParser = new MoleOutputParser('stderr', emit)
  console.log('[Mole] clean dry run started, pid:', child.pid)

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let processError: Error | undefined

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const retained = chunk.slice(0, maxOutputChars - stdout.length)
      stdoutTruncated ||= retained.length < chunk.length
      stdout += retained
      stdoutParser.push(retained)
      console.log('[Mole][stdout]', chunk.trimEnd())
    })
    child.stderr.on('data', (chunk: string) => {
      const retained = chunk.slice(0, maxOutputChars - stderr.length)
      stderrTruncated ||= retained.length < chunk.length
      stderr += retained
      stderrParser.push(retained)
      console.error('[Mole][stderr]', chunk.trimEnd())
    })
    child.once('error', (error) => {
      processError = error
    })
    child.once('close', (exitCode, signal) => {
      const partial = Boolean(processError) || exitCode !== 0 || signal !== null
      stdoutParser.finish(partial || stdoutTruncated)
      stderrParser.finish(partial || stderrTruncated)
      if (processError) {
        console.error('[Mole] clean dry run failed', processError)
        reject(processError)
        return
      }
      console.log('[Mole] clean dry run finished, exit:', exitCode, 'signal:', signal)
      resolve({ exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated, blocks })
    })
  })
}
