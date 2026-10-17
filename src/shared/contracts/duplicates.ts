export interface DuplicateScanRequest {
  /** One local folder; subfolders are included. */
  directoryPath: string
}

export interface DuplicateFile {
  path: string
  relativePath: string
  /** Scan-time metadata, not proof that the file is still unchanged. */
  modifiedAtMs: number
}

export interface DuplicateGroup {
  hash: string
  sizeBytes: number
  files: DuplicateFile[]
}

export interface DuplicateScanResult {
  status: 'completed' | 'partial'
  directoryPath: string
  groups: DuplicateGroup[]
  /** Extra copies beyond one file per group; existing hard-link aliases are excluded. */
  duplicateFileCount: number
  /** Logical redundant content, not measured disk savings or guaranteed reclaimable space. */
  redundantBytes: number
  /** Tool diagnostics; partial scans must not be presented as finding all duplicates. */
  warnings: string[]
}
