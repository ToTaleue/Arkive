import type {
  MoleCandidate,
  MolePreviewResult,
  MoleSelectionCandidate
} from '../../../shared/contracts/mole'

export function formatMoleSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes,
    unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}

export function candidateBytes(candidate: MoleCandidate): number | null {
  if (
    candidate.sizeBytes !== undefined &&
    Number.isFinite(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0
  )
    return candidate.sizeBytes
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|PB)\s*$/i.exec(candidate.sizeText ?? '')
  if (!match) return null
  return (
    Number(match[1]) * 1000 ** ['B', 'KB', 'MB', 'GB', 'TB', 'PB'].indexOf(match[2].toUpperCase())
  )
}

export function selectionCandidates(result: MolePreviewResult): MoleSelectionCandidate[] {
  return result.candidates.map((candidate, index) => ({
    ...candidate,
    id: candidate.id ?? `preview-only-${String(index)}`,
    suggested: Boolean(candidate.id) && 'suggested' in candidate && candidate.suggested === true
  }))
}

export type ScanStatus = 'complete' | 'partial' | 'unavailable'
export type AnalyzeEntry = {
  name: string
  path: string
  size: number | null
  isDir: boolean
  status: ScanStatus
}
export type AnalyzeReport = {
  path: string
  totalSize: number | null
  totalFiles: number | null
  status: ScanStatus
  entries: AnalyzeEntry[]
  largeFiles: AnalyzeEntry[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function measured(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function status(value: unknown): ScanStatus {
  return value === 'complete' || value === 'unavailable' ? value : 'partial'
}

/** JSON is an external tool boundary: keep unreadable or partial entries distinct from zero bytes. */
export function readAnalyzeReport(raw: unknown): AnalyzeReport {
  if (
    !record(raw) ||
    typeof raw.path !== 'string' ||
    !raw.path.startsWith('/') ||
    !Array.isArray(raw.entries)
  )
    throw new Error('Mole 分析报告格式无效。')
  const scanStatus = status(raw.scan_status)
  const entries = (items: unknown[], files = false): AnalyzeEntry[] =>
    items
      .map((item) => {
        if (
          !record(item) ||
          typeof item.path !== 'string' ||
          !item.path.startsWith('/') ||
          typeof item.name !== 'string' ||
          (!files && typeof item.is_dir !== 'boolean')
        )
          throw new Error('Mole 分析报告包含无效条目。')
        const itemStatus = status(item.scan_status ?? raw.scan_status)
        return {
          name: item.name,
          path: item.path,
          size: itemStatus === 'unavailable' ? null : measured(item.size),
          isDir: !files && item.is_dir === true,
          status: itemStatus
        }
      })
      .sort((a, b) => (b.size ?? -1) - (a.size ?? -1))
  return {
    path: raw.path,
    totalSize: scanStatus === 'unavailable' ? null : measured(raw.total_size),
    totalFiles: measured(raw.total_files),
    status: scanStatus,
    entries: entries(raw.entries),
    largeFiles: Array.isArray(raw.large_files) ? entries(raw.large_files, true) : []
  }
}
