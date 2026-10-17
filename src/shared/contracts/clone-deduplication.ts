export interface CloneDeduplicationRequest {
  /** Explicitly selected source; never automatically treats the first scan result as canonical. */
  sourcePath: string
  /** Approved paths whose byte-identical contents may be replaced with APFS clones. */
  duplicatePaths: string[]
}

export interface CloneDeduplicationItem {
  path: string
  status: 'deduplicated' | 'skipped' | 'failed' | 'cancelled' | 'unprocessed'
  reason?: string
  /** Logical content shared, not measured disk reclamation. */
  logicalBytesShared?: number
  /** Preserved transaction files needing recovery; never silently remove these. */
  recoveryPath?: string
}

export interface CloneDeduplicationResult {
  status: 'completed' | 'partial' | 'cancelled'
  sourcePath: string
  items: CloneDeduplicationItem[]
  logicalBytesShared: number
  /** No reliable attribution to this operation; snapshots and unrelated I/O affect free space. */
  diskSpaceReclaimedBytes: null
}

export interface CloneRecoveryResult {
  recovered: string[]
  failed: { journalPath: string; error: string }[]
}
