import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { openDatabase } from '../../storage/database'
import { assertSystemWriteAllowed } from '../../system-paths'
import { backupOriginal } from '../original-backup/service'
import {
  commitOfficeReplacement,
  recoverOfficeReplacements
} from '../office-compression/replacement'
import { CatalogRepository } from './repository'
import { fileTags, normalizeTags } from './finder-tags'
import {
  assertManagedFile,
  copyVerified,
  dayKey,
  destination,
  fileInfo,
  hashFile,
  managedDirectory
} from './files'
import type {
  ArchiveItem,
  CatalogQuery,
  CompressionRecord
} from '../../../shared/contracts/catalog'

export interface CatalogOptions {
  databasePath: string
  archiveRoot?: string
  backupRoot?: string
}

export class Catalog {
  readonly repo: CatalogRepository
  readonly archiveRoot: string
  readonly backupRoot: string
  private queue: Promise<unknown> = Promise.resolve()
  private watcher?: FSWatcher
  private timer?: ReturnType<typeof setTimeout>
  private refreshPending = false
  private closing = false
  private stopping = false
  private activeCompressions = new Set<Promise<unknown>>()
  private listeners = new Set<() => void>()

  constructor(options: CatalogOptions) {
    this.repo = new CatalogRepository(openDatabase(options.databasePath))
    this.archiveRoot = options.archiveRoot ?? join(homedir(), 'Arkive Archive')
    this.backupRoot = options.backupRoot ?? join(homedir(), 'Arkive Backup')
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('应用正在关闭。'))
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  async start(): Promise<void> {
    await managedDirectory(this.archiveRoot)
    await managedDirectory(this.backupRoot)
    await this.exclusive(async () => {
      await recoverOfficeReplacements(this.repo, this.backupRoot)
      for (const id of this.repo.recoveryIds()) {
        await backupOriginal(this.repo, id, this.backupRoot)
        if (this.repo.get(id).archive_status === 'copying') {
          try {
            await this.archiveFile(id)
          } catch {
            /* Recorded path is retained for an explicit retry. */
          }
        }
      }
    })
    await this.refresh()
    try {
      this.watcher = watch(this.archiveRoot, { recursive: true }, () => {
        this.scheduleRefresh()
      })
      this.watcher.on('error', (error) => {
        console.error('Archive watcher failed', error)
      })
    } catch (error) {
      console.error('Archive watcher unavailable; focus and manual refresh remain enabled', error)
    }
  }

  scheduleRefresh(): void {
    if (this.stopping || this.closing || this.refreshPending) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.refreshPending = true
      void this.refresh()
        .catch((error: unknown) => {
          console.error('Tag refresh failed', error)
        })
        .finally(() => {
          this.refreshPending = false
        })
    }, 800)
  }

  trackCompression<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('应用正在关闭。'))
    const pending = work()
    this.activeCompressions.add(pending)
    void pending
      .finally(() => {
        this.activeCompressions.delete(pending)
      })
      .catch(() => undefined)
    return pending
  }

  async close(): Promise<void> {
    this.stopping = true
    clearTimeout(this.timer)
    this.watcher?.close()
    await Promise.allSettled([...this.activeCompressions])
    this.closing = true
    await this.queue
    this.repo.db.close()
  }

  async beginCompression(inputPath: string, outputPath: string): Promise<string> {
    const original = await realpath(inputPath)
    await assertSystemWriteAllowed(original, true)
    const info = await fileInfo(original)
    const sourceHash = await hashFile(original)
    const after = await fileInfo(original)
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ino !== after.ino) {
      throw new Error('读取期间源文件发生变化，请重试。')
    }
    const id = randomUUID()
    this.repo.insert({
      id,
      original_path: original,
      output_path: outputPath,
      source_size: info.size,
      source_modified_at: info.mtimeMs,
      source_dev: String(info.dev),
      source_ino: String(info.ino),
      source_hash: sourceHash
    })
    try {
      this.repo.setTags(id, await fileTags(original))
    } catch (error) {
      this.repo.update(id, { tag_error: String(error) })
    }
    return id
  }

  failCompression(id: string): void {
    this.repo.update(id, { compression_status: 'failed' })
  }

  finishCompression(id: string, hasSavings: boolean): Promise<CompressionRecord> {
    return this.exclusive(async () => {
      const row = this.repo.get(id)
      const info = await fileInfo(row.output_path)
      const hash = await hashFile(row.output_path)
      this.repo.update(id, {
        compression_status: 'ready',
        output_hash: hash,
        output_bytes: info.size,
        backup_status: hasSavings ? 'pending' : 'skipped'
      })
      if (hasSavings) await backupOriginal(this.repo, id, this.backupRoot)
      this.changed()
      return this.repo.item(id)
    })
  }

  retryBackup(id: string): Promise<ArchiveItem> {
    return this.exclusive(async () => {
      const row = this.repo.get(id)
      if (row.compression_status !== 'ready') throw new Error('压缩结果尚未就绪。')
      await backupOriginal(this.repo, id, this.backupRoot)
      this.changed()
      return this.repo.item(id)
    })
  }

  finishOfficeReplacement(id: string): Promise<CompressionRecord> {
    return this.exclusive(async () => {
      await commitOfficeReplacement(this.repo, this.backupRoot, id)
      this.changed()
      return this.repo.item(id)
    })
  }

  get(id: string): ArchiveItem {
    return this.repo.item(id)
  }
  query(query: CatalogQuery): ReturnType<CatalogRepository['query']> {
    return this.repo.query(query)
  }

  private async archiveFile(id: string): Promise<void> {
    const row = this.repo.get(id)
    if (row.archive_status === 'ready') return
    if (row.compression_status !== 'ready' || !row.output_hash)
      throw new Error('压缩结果尚未校验完成。')
    if (row.backup_status !== 'ready' && row.backup_status !== 'skipped')
      throw new Error('请先重试完成原件备份。')
    const directory = await managedDirectory(
      this.archiveRoot,
      row.archive_path ? basename(dirname(row.archive_path)) : dayKey()
    )
    const target = row.archive_path ?? destination(directory, basename(row.output_path), id)
    this.repo.update(id, { archive_path: target, archive_status: 'copying' })
    await copyVerified(row.output_path, target, row.output_hash)
    this.repo.update(id, { archive_status: 'ready', archived_at: Date.now() })
  }

  archive(id: string, tags: string[]): Promise<ArchiveItem> {
    const chosen = normalizeTags(tags)
    return this.exclusive(async () => {
      const before = this.repo.get(id)
      if (
        before.compression_status === 'ready' &&
        (before.backup_status === 'pending' || before.backup_status === 'error')
      ) {
        await backupOriginal(this.repo, id, this.backupRoot)
      }
      // Store intended labels before copying, so an interrupted archive can finish on restart.
      if (before.archive_status === 'none') {
        this.repo.update(id, {
          pending_add: JSON.stringify(normalizeTags([...this.repo.tags(id), ...chosen]))
        })
      } else if (chosen.length) this.queueTagEdit(id, chosen, [])
      await this.archiveFile(id)
      await this.syncTags(id)
      this.changed()
      return this.repo.item(id)
    })
  }

  private queueTagEdit(id: string, add: string[], remove: string[]): void {
    const row = this.repo.get(id)
    const pendingAdd = normalizeTags(JSON.parse(row.pending_add) as unknown).filter(
      (tag) => !remove.includes(tag)
    )
    const pendingRemove = normalizeTags(JSON.parse(row.pending_remove) as unknown).filter(
      (tag) => !add.includes(tag)
    )
    this.repo.update(id, {
      pending_add: JSON.stringify(normalizeTags([...pendingAdd, ...add])),
      pending_remove: JSON.stringify(normalizeTags([...pendingRemove, ...remove])),
      tag_status: 'pending'
    })
  }

  private async syncTags(id: string): Promise<void> {
    const row = this.repo.get(id)
    if (row.archive_status !== 'ready' || !row.archive_path) return
    try {
      await assertManagedFile(this.archiveRoot, row.archive_path)
      let current = await fileTags(row.archive_path)
      let add = normalizeTags(JSON.parse(row.pending_add) as unknown)
      if (row.inherit_tags_pending) {
        // A failed initial read must remain retryable after the original has moved.
        const inherited = await fileTags(row.backup_path ?? row.original_path)
        add = normalizeTags([...inherited, ...add])
        this.repo.update(id, { pending_add: JSON.stringify(add) })
      }
      const remove = normalizeTags(JSON.parse(row.pending_remove) as unknown)
      if (add.length || remove.length) {
        const desired = normalizeTags([...current.filter((tag) => !remove.includes(tag)), ...add])
        current = await fileTags(row.archive_path, desired)
        if (JSON.stringify(current) !== JSON.stringify(desired))
          throw new Error('标签写入后核对失败。')
      }
      this.repo.setTags(id, current)
      this.repo.update(id, {
        tag_status: 'synced',
        tag_error: null,
        inherit_tags_pending: 0,
        pending_add: '[]',
        pending_remove: '[]'
      })
    } catch (error) {
      this.repo.update(id, {
        tag_status: 'error',
        tag_error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  editTags(ids: string[], add: string[], remove: string[]): Promise<void> {
    const additions = normalizeTags(add)
    const removals = normalizeTags(remove)
    return this.exclusive(async () => {
      // Validate the entire batch before editing any member.
      for (const id of ids)
        if (this.repo.get(id).archive_status !== 'ready') throw new Error('请选择已归档资料。')
      for (const id of ids) {
        this.queueTagEdit(id, additions, removals)
        await this.syncTags(id)
      }
      this.changed()
    })
  }

  refresh(): Promise<void> {
    return this.exclusive(async () => {
      for (const id of this.repo.archivedIds()) await this.syncTags(id)
      this.changed()
    })
  }

  async archivePath(id: string): Promise<string> {
    const row = this.repo.get(id)
    if (row.archive_status !== 'ready' || !row.archive_path) throw new Error('文件尚未归档。')
    await assertManagedFile(this.archiveRoot, row.archive_path)
    return row.archive_path
  }
}

let catalog: Catalog | undefined
export function setCatalog(value: Catalog): void {
  catalog = value
}
export function getCatalog(): Catalog {
  if (!catalog) throw new Error('归档数据库尚未初始化，请重启应用。')
  return catalog
}
