import { app } from 'electron'
import { join } from 'node:path'
import { chmod, stat } from 'node:fs/promises'
import { runSystemTool } from '../../../execution/process'

export function normalizeTags(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (tag: unknown) =>
        typeof tag !== 'string' ||
        tag.length > 100 ||
        /[\r\n]/u.test(tag) ||
        tag.includes(String.fromCharCode(0))
    )
  ) {
    throw new Error('标签须为最多 100 个、每个不超过 100 字的文本。')
  }
  return [
    ...new Set((value as string[]).map((tag) => tag.normalize('NFC').trim()).filter(Boolean))
  ].sort()
}

export async function fileTags(path: string, tags?: string[]): Promise<string[]> {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'finder-tags.jxa')
    : join(app.getAppPath(), 'resources', 'finder-tags.jxa')
  const mode = tags === undefined ? undefined : (await stat(path)).mode & 0o7777
  const restoreMode = mode !== undefined && (mode & 0o200) === 0
  // macOS refuses tag writes on read-only files, including generated Office
  // candidates and archive copies. Preserve the original permission bits.
  if (restoreMode) await chmod(path, mode | 0o200)
  try {
    const result = await runSystemTool('osascript', [
      '-l',
      'JavaScript',
      script,
      JSON.stringify({ path, ...(tags === undefined ? {} : { tags }) })
    ])
    if (result.exitCode !== 0 || result.signal || result.stdoutTruncated) {
      throw new Error(`Finder 标签操作失败：${result.stderr.slice(-2000)}`)
    }
    return normalizeTags(JSON.parse(result.stdout) as unknown)
  } finally {
    if (restoreMode) await chmod(path, mode)
  }
}
