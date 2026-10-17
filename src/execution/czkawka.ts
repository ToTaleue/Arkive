import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { DuplicateFile, DuplicateGroup } from '../shared/contracts/duplicates'

function invalidReport(): never {
  throw new Error('重复检测结果格式无效，请重新扫描。')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

/** Parse the HASH-mode JSON emitted by the bundled Czkawka 12.0.2. */
export function parseDuplicateReport(value: unknown, directoryPath: string): DuplicateGroup[] {
  if (!isRecord(value)) invalidReport()
  const groups: DuplicateGroup[] = []
  const paths = new Set<string>()
  for (const [sizeKey, candidates] of Object.entries(value)) {
    const sizeBytes = Number(sizeKey)
    if (!isInteger(sizeBytes, 1) || String(sizeBytes) !== sizeKey || !Array.isArray(candidates)) {
      invalidReport()
    }
    for (const candidate of candidates) {
      if (!Array.isArray(candidate) || candidate.length < 2) invalidReport()
      let hash: string | undefined
      const files: DuplicateFile[] = []
      for (const entry of candidate) {
        if (
          !isRecord(entry) ||
          typeof entry.path !== 'string' ||
          !isAbsolute(entry.path) ||
          entry.path.includes('\0') ||
          resolve(entry.path) !== entry.path ||
          entry.size !== sizeBytes ||
          typeof entry.hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.hash) ||
          !isInteger(entry.modified_date, 0) ||
          !Number.isSafeInteger(entry.modified_date * 1000)
        ) {
          invalidReport()
        }
        const relativePath = relative(directoryPath, entry.path)
        if (
          !relativePath ||
          isAbsolute(relativePath) ||
          relativePath === '..' ||
          relativePath.startsWith(`..${sep}`) ||
          paths.has(entry.path) ||
          (hash !== undefined && hash !== entry.hash)
        ) {
          invalidReport()
        }
        paths.add(entry.path)
        hash = entry.hash
        files.push({
          path: entry.path,
          relativePath,
          modifiedAtMs: entry.modified_date * 1000
        })
      }
      if (!hash) invalidReport()
      files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
      groups.push({ hash, sizeBytes, files })
    }
  }
  return groups.sort(
    (a, b) =>
      b.sizeBytes * (b.files.length - 1) - a.sizeBytes * (a.files.length - 1) ||
      a.files[0].path.localeCompare(b.files[0].path, 'en')
  )
}
