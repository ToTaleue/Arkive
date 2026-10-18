export interface CompressionRecord {
  id: string
  backupStatus: 'pending' | 'ready' | 'skipped' | 'error'
  backupPath: string | null
  backupError: string | null
}

export interface ArchiveOptions {
  /** Opt-in: create an entry in the original folder pointing to the verified archive. */
  keepLinkAtOriginalLocation?: boolean
}

export interface CompressionFollowUp extends ArchiveOptions {
  /** Only set when the user has also requested archiving. Backup is always part of compression. */
  archive?: boolean
  tags?: string[]
}

export type ArchiveAttempt =
  { status: 'ready'; item: ArchiveItem } | { status: 'error'; error: string }

export interface CompressionLifecycleResult {
  catalog: CompressionRecord
  archive?: ArchiveAttempt
}

export interface ArchiveItem extends CompressionRecord {
  name: string
  originalName: string
  archivePath: string | null
  outputPath: string
  sourceModifiedAt: number
  archivedAt: number | null
  outputBytes: number
  sourceBytes?: number
  backedUpAt?: number | null
  tags: string[]
  tagStatus: 'synced' | 'pending' | 'error'
  tagError: string | null
  originalLink?: {
    path: string
    status: 'pending' | 'ready' | 'error'
    error: string | null
  }
}

export interface CatalogQuery {
  state?: 'archived' | 'pending' | 'backup'
  name?: string
  kind?: 'video' | 'image' | 'document'
  tags?: string[]
  modifiedFrom?: number
  modifiedTo?: number
  archivedFrom?: number
  archivedTo?: number
  offset?: number
}

export interface CatalogPage {
  items: ArchiveItem[]
  total: number
  tags: string[]
}
export const presetTags = [
  '工作',
  '学习',
  '生活',
  '家庭',
  '旅行',
  '出差',
  '活动',
  '演唱会',
  '项目',
  '会议',
  '课程',
  '设计',
  '财务',
  '合同',
  '证件',
  '票据',
  '素材',
  '参考',
  '交付',
  '收藏'
]
export const catalogChannels = {
  archive: 'catalog:archive',
  query: 'catalog:query',
  get: 'catalog:get',
  tags: 'catalog:tags',
  refresh: 'catalog:refresh',
  retryBackup: 'catalog:retry-backup',
  open: 'catalog:open',
  reveal: 'catalog:reveal',
  changed: 'catalog:changed'
} as const

export interface CatalogApi {
  archive: (id: string, tags: string[], options?: ArchiveOptions) => Promise<ArchiveItem>
  query: (query: CatalogQuery) => Promise<CatalogPage>
  get: (id: string) => Promise<ArchiveItem>
  tags: (ids: string[], add: string[], remove: string[]) => Promise<void>
  refresh: () => Promise<void>
  retryBackup: (id: string) => Promise<ArchiveItem>
  open: (id: string, target?: 'archive' | 'backup') => Promise<void>
  reveal: (id: string, target?: 'archive' | 'backup') => Promise<void>
  onChanged: (listener: () => void) => () => void
}
