import { basename } from 'node:path'
import type { MoleUninstallInspection } from '../shared/contracts/mole'
import { runBundledTool } from './process'

/** Fixed read-only bridge to Mole's own discovery and sibling protection. */
export async function inspectMoleUninstall(
  appPaths: readonly string[],
  signal?: AbortSignal
): Promise<MoleUninstallInspection> {
  const timeout = AbortSignal.timeout(120_000)
  const executionSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const result = await runBundledTool('mole-uninstall-preview', appPaths, {
    signal: executionSignal,
    killTreeOnAbort: true,
    maxOutputChars: 4_194_304
  })
  executionSignal.throwIfAborted()
  if (result.exitCode !== 0 || result.signal || result.stdoutTruncated || result.stderrTruncated)
    throw new Error(`Mole 卸载关联扫描失败或不完整：${JSON.stringify(result)}`)
  const fields = result.stdout.split('\0')
  if (fields.shift() !== 'arkive-uninstall-v1' || fields.pop() !== '' || fields.length % 4)
    throw new Error('Mole 卸载预览格式无效。')
  const inspection: MoleUninstallInspection = {
    apps: [],
    candidates: [],
    reviewOnly: [],
    warnings: [],
    diagnostics: [
      ...new Set(
        result.stderr
          .split(/\r?\n/)
          .filter((line) => line.startsWith('ARKIVE_MOLE_DIAGNOSTIC: '))
          .map((line) => line.slice('ARKIVE_MOLE_DIAGNOSTIC: '.length))
      )
    ]
  }
  for (let index = 0; index < fields.length; index += 4) {
    const [kind, appPath, value, extra] = fields.slice(index, index + 4)
    if (kind === 'warning') {
      inspection.warnings.push(`${appPath ? `${appPath}: ` : ''}${value}`)
      continue
    }
    if (!appPaths.includes(appPath)) throw new Error('Mole 返回了未选择的应用。')
    if (kind === 'app') inspection.apps.push({ path: appPath, bundleId: value, policy: extra })
    else if (kind === 'candidate' && (extra === 'app' || extra === 'related')) {
      if (!value.startsWith('/')) throw new Error('Mole 返回了无效的关联路径。')
      inspection.candidates.push({ path: value, name: basename(value), appPath, role: extra })
    } else if (kind === 'review' && value.startsWith('/'))
      inspection.reviewOnly.push({ appPath, path: value })
    else throw new Error('Mole 卸载预览包含未知记录。')
  }
  if (
    new Set(inspection.apps.map((app) => app.path)).size !== inspection.apps.length ||
    inspection.candidates.some(
      (candidate) => !inspection.apps.some((app) => app.path === candidate.appPath)
    )
  )
    throw new Error('Mole 卸载预览的应用关联不一致。')
  return inspection
}
