import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, parse } from 'node:path'
import { parseDuplicateReport } from '../../../execution/czkawka'
import { runBundledTool } from '../../../execution/process'
import type {
  DuplicateScanRequest,
  DuplicateScanResult
} from '../../../shared/contracts/duplicates'

/** Read-only analysis for one compression/archive operation. No historical lookup or file changes. */
export async function scanDuplicates(
  request: DuplicateScanRequest,
  signal?: AbortSignal
): Promise<DuplicateScanResult> {
  signal?.throwIfAborted()
  if (
    typeof request.directoryPath !== 'string' ||
    !isAbsolute(request.directoryPath) ||
    request.directoryPath.includes('\0')
  ) {
    throw new Error('重复检测须选择一个本地文件夹，使用绝对路径。')
  }
  const directoryPath = await realpath(request.directoryPath)
  if (directoryPath === parse(directoryPath).root) {
    throw new Error('根目录受保护，不能整体处理。')
  }
  if (!(await stat(directoryPath)).isDirectory()) throw new Error('重复检测须选择文件夹。')
  signal?.throwIfAborted()
  const temporary = await mkdtemp(join(tmpdir(), 'arkive-duplicates-'))
  try {
    const reportPath = join(temporary, 'duplicates.json')
    const output = await runBundledTool(
      'czkawka_cli',
      [
        'dup',
        '-d',
        directoryPath,
        '-s',
        'HASH',
        '-t',
        'BLAKE3',
        '-D',
        'NONE',
        '-m',
        '1',
        '-H',
        '-W',
        '-N',
        '-T',
        '2',
        '-C',
        reportPath
      ],
      { signal, maxOutputChars: 65_536 }
    )
    signal?.throwIfAborted()
    if (output.exitCode !== 0 || output.signal !== null) {
      throw new Error(
        `重复检测失败（${String(output.signal ?? output.exitCode ?? '未知退出状态')}）：${output.stderr || output.stdout}`
      )
    }
    // The report is separate from bounded stdout: large results must never be silently truncated.
    const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'))
    const groups = parseDuplicateReport(report, directoryPath)
    let duplicateFileCount = 0
    let redundantBytes = 0
    for (const group of groups) {
      duplicateFileCount += group.files.length - 1
      redundantBytes += group.sizeBytes * (group.files.length - 1)
    }
    if (!Number.isSafeInteger(redundantBytes)) throw new Error('重复文件体积超出可精确统计范围。')
    const warnings = [output.stdout.trim(), output.stderr.trim()].filter(Boolean)
    if (output.stdoutTruncated || output.stderrTruncated) {
      warnings.push('检测诊断信息过长，已截断；请勿将本次结果视为完整扫描。')
    }
    signal?.throwIfAborted()
    return {
      status: warnings.length ? 'partial' : 'completed',
      directoryPath,
      groups,
      duplicateFileCount,
      redundantBytes,
      warnings
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
