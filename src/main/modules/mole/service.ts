import { readFile, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import {
  spawnMoleCleanDryRun,
  spawnMoleInstallerDryRun,
  spawnMolePurgeDryRun,
  spawnMoleUninstallList
} from '../../../execution/mole'
import { runBundledTool } from '../../../execution/process'
import type { ToolProcess } from '../../../execution/process'
import { MoleOutputParser } from '../../../execution/mole-output'
import { trashPaths } from '../file-operations/service'
import type {
  MoleCandidate,
  MoleDryRunResult,
  MoleInstalledApp,
  MoleOutputBlock,
  MoleOutputEvent,
  MolePreviewResult,
  MoleAnalyzeResult,
  MoleTrashResult
} from '../../../shared/contracts/mole'

const maxOutputChars = 1_048_576
type MoleRunKind = MolePreviewResult['kind']

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  }
}

function parseCleanList(text: string): MoleCandidate[] {
  let category: string | undefined
  const candidates: MoleCandidate[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const heading = /^===\s+(.+?)\s+===$/.exec(line)
    if (heading) {
      category = heading[1]
      continue
    }
    if (!line || line.startsWith('#')) continue
    const match = /^(.*?)\s+#\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const path = match[1].trim()
    if (!path.startsWith('/') || seen.has(path)) continue
    seen.add(path)
    candidates.push({ path, name: basename(path), category, sizeText: match[2] })
  }
  return candidates
}

function installerSource(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.includes('/Downloads')) return 'Downloads'
  if (normalized.includes('/Desktop')) return 'Desktop'
  if (normalized.includes('/Homebrew')) return 'Homebrew'
  if (normalized.includes('/CloudDocs')) return 'iCloud'
  if (normalized.includes('/Mail Downloads')) return 'Mail'
  if (normalized.includes('/Telegram')) return 'Telegram'
  return basename(dirname(path)) || '其他位置'
}

function parseInstallerCandidates(stdout: string, stderr: string): MoleCandidate[] {
  const candidates: MoleCandidate[] = []
  const seen = new Set<string>()
  for (const rawLine of `${stderr}\n${stdout}`.split(/\r?\n/)) {
    const line = stripVTControlCharacters(rawLine)
    const match = /Found installer:\s+\*?\s*(\/.*)\s*$/.exec(line)
    if (!match) continue
    const path = match[1].trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    candidates.push({ path, name: basename(path), source: installerSource(path) })
  }
  return candidates
}

function expandHomePath(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function parsePurgeCandidates(stdout: string, stderr: string): MoleCandidate[] {
  const candidates: MoleCandidate[] = []
  const seen = new Set<string>()
  for (const rawLine of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = stripVTControlCharacters(rawLine)
    const match = /\[DRY RUN\]\s+(~?\/.*?),\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const path = expandHomePath(match[1].trim())
    if (!path.startsWith('/') || seen.has(path)) continue
    seen.add(path)
    candidates.push({
      path,
      name: basename(path),
      category: '可重建开发产物',
      sizeText: match[2].trim(),
      source: basename(dirname(path)) || '项目'
    })
  }
  return candidates
}

async function runMolePreview(
  kind: MoleRunKind,
  spawn: (options: { signal?: AbortSignal }) => ToolProcess,
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal
): Promise<MolePreviewResult> {
  const timeout = AbortSignal.timeout(120_000)
  const child = spawn({ signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  const blocks: MoleOutputBlock[] = []
  const emit = (event: MoleOutputEvent): void => {
    if (event.type === 'block') blocks.push(event.block)
    onUpdate(event)
  }
  const stdoutParser = new MoleOutputParser('stdout', emit)
  const stderrParser = new MoleOutputParser('stderr', emit)

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
    })
    child.stderr.on('data', (chunk: string) => {
      const retained = chunk.slice(0, maxOutputChars - stderr.length)
      stderrTruncated ||= retained.length < chunk.length
      stderr += retained
      stderrParser.push(retained)
    })
    child.once('error', (error) => {
      processError = error
    })
    child.once('close', (exitCode, childSignal) => {
      const partial = Boolean(processError) || exitCode !== 0 || childSignal !== null
      stdoutParser.finish(partial || stdoutTruncated)
      stderrParser.finish(partial || stderrTruncated)
      if (processError) {
        reject(processError)
        return
      }
      const base: MoleDryRunResult = {
        exitCode,
        signal: childSignal,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        blocks
      }
      if (exitCode !== 0 || childSignal) {
        reject(new Error(`Mole ${kind} 预览失败：${JSON.stringify(base)}`))
        return
      }
      resolve({ ...base, kind, candidates: [] })
    })
  })
}

export async function runMoleDryRun(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal
): Promise<MolePreviewResult> {
  const listPath = join(homedir(), '.config', 'mole', 'clean-list.txt')
  try {
    await unlink(listPath)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const result = await runMolePreview('clean', spawnMoleCleanDryRun, onUpdate, signal)
  const listText = await readOptionalFile(listPath)
  return { ...result, candidates: parseCleanList(listText) }
}

export async function runMoleInstallerPreview(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal
): Promise<MolePreviewResult> {
  const result = await runMolePreview('installer', spawnMoleInstallerDryRun, onUpdate, signal)
  return { ...result, candidates: parseInstallerCandidates(result.stdout, result.stderr) }
}

export async function runMolePurgePreview(
  onUpdate: (event: MoleOutputEvent) => void,
  signal?: AbortSignal
): Promise<MolePreviewResult> {
  const result = await runMolePreview('purge', spawnMolePurgeDryRun, onUpdate, signal)
  return { ...result, candidates: parsePurgeCandidates(result.stdout, result.stderr) }
}

export async function analyzeMole(path?: string, signal?: AbortSignal): Promise<MoleAnalyzeResult> {
  const target = path ?? homedir()
  if (!target.startsWith('/')) throw new Error('Mole 分析路径必须是绝对路径。')
  const result = await runBundledTool('mole', ['analyze', '--json', target], {
    signal,
    maxOutputChars: 4_194_304
  })
  if (result.exitCode !== 0 || result.signal)
    throw new Error(`Mole 占用分析失败：${JSON.stringify(result)}`)
  if (result.stdoutTruncated) throw new Error('Mole 分析报告超出输出容量，结果不完整。')
  return {
    report: JSON.parse(result.stdout),
    stderr: result.stderr,
    stderrTruncated: result.stderrTruncated
  }
}

export async function listMoleApps(signal?: AbortSignal): Promise<MoleInstalledApp[]> {
  const result = await spawnMoleUninstallList(signal)
  if (result.exitCode !== 0 || result.signal) {
    throw new Error(`Mole 应用清单失败：${JSON.stringify(result)}`)
  }
  if (result.stdoutTruncated) throw new Error('Mole 应用清单超出输出容量，结果不完整。')
  const raw: unknown = JSON.parse(result.stdout)
  if (!Array.isArray(raw)) throw new Error('Mole 应用清单格式无效。')
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Mole 应用清单包含无效项目。')
    const row = item as Record<string, unknown>
    const fields = ['name', 'bundle_id', 'source', 'uninstall_name', 'path', 'size']
    if (fields.some((key) => typeof row[key] !== 'string'))
      throw new Error('Mole 应用清单缺少必要字段。')
    return {
      name: row.name as string,
      bundleId: row.bundle_id as string,
      source: row.source as string,
      uninstallName: row.uninstall_name as string,
      path: row.path as string,
      size: row.size as string
    }
  })
}

export function trashMolePaths(
  paths: readonly string[],
  signal?: AbortSignal
): Promise<MoleTrashResult> {
  return trashPaths(paths, signal)
}
