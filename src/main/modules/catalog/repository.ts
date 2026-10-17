import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { basename } from 'node:path'
import { presetTags, type ArchiveItem, type CatalogQuery } from '../../../shared/contracts/catalog'

export interface CatalogRow {
  id: string
  original_path: string
  output_path: string
  source_size: number
  source_modified_at: number
  source_dev: string
  source_ino: string
  source_hash: string
  output_hash: string | null
  output_bytes: number
  compression_status: string
  backup_path: string | null
  backup_status: ArchiveItem['backupStatus']
  backup_error: string | null
  backed_up_at: number | null
  archive_path: string | null
  archive_status: string
  archived_at: number | null
  tag_status: ArchiveItem['tagStatus']
  tag_error: string | null
  inherit_tags_pending: number
  pending_add: string
  pending_remove: string
}

export class CatalogRepository {
  constructor(readonly db: DatabaseSync) {}

  insert(
    row: Pick<
      CatalogRow,
      | 'id'
      | 'original_path'
      | 'output_path'
      | 'source_size'
      | 'source_modified_at'
      | 'source_dev'
      | 'source_ino'
      | 'source_hash'
    >
  ): void {
    this.db
      .prepare(
        `INSERT INTO catalog_items
      (id, original_path, output_path, original_name, output_name, source_size, source_modified_at, source_dev, source_ino, source_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.original_path,
        row.output_path,
        basename(row.original_path),
        basename(row.output_path),
        row.source_size,
        row.source_modified_at,
        row.source_dev,
        row.source_ino,
        row.source_hash
      )
  }

  get(id: string): CatalogRow {
    const row = this.db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id)
    if (!row) throw new Error('未找到文件记录。')
    return row as unknown as CatalogRow
  }

  update(id: string, patch: Partial<Omit<CatalogRow, 'id'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[]
    if (!keys.length) return
    this.db
      .prepare(
        `UPDATE catalog_items SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`
      )
      .run(...keys.map((key) => patch[key] ?? null), id)
  }

  tags(id: string): string[] {
    return this.db
      .prepare('SELECT tag FROM catalog_item_tags WHERE item_id = ? ORDER BY tag')
      .all(id)
      .map((row) => String(row.tag))
  }

  setTags(id: string, tags: string[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM catalog_item_tags WHERE item_id = ?').run(id)
      for (const tag of tags) {
        this.db.prepare('INSERT OR IGNORE INTO catalog_tags(name) VALUES (?)').run(tag)
        this.db.prepare('INSERT INTO catalog_item_tags(item_id, tag) VALUES (?, ?)').run(id, tag)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  item(id: string): ArchiveItem {
    const row = this.get(id)
    return {
      id,
      name: basename(row.archive_path ?? row.output_path),
      originalName: basename(row.original_path),
      outputPath: row.output_path,
      archivePath: row.archive_status === 'ready' ? row.archive_path : null,
      sourceModifiedAt: row.source_modified_at,
      archivedAt: row.archived_at,
      outputBytes: row.output_bytes,
      backupPath: row.backup_path,
      backupStatus: row.backup_status,
      backupError: row.backup_error,
      tags: this.tags(id),
      tagStatus: row.tag_status,
      tagError: row.tag_error
    }
  }

  allTags(): string[] {
    return [
      ...new Set([
        ...presetTags,
        ...this.db
          .prepare('SELECT name FROM catalog_tags ORDER BY name')
          .all()
          .map((row) => String(row.name))
      ])
    ]
  }

  query(query: CatalogQuery): { items: ArchiveItem[]; total: number; tags: string[] } {
    // Unpublished Office candidates must never be exposed as ordinary ready outputs.
    const conditions =
      query.state === 'pending'
        ? [
            "compression_status = 'ready'",
            "archive_status != 'ready'",
            "NOT EXISTS (SELECT 1 FROM office_replacements o WHERE o.item_id = catalog_items.id AND o.state != 'replaced')"
          ]
        : ["archive_status = 'ready'"]
    const values: SQLInputValue[] = []
    if (query.name) {
      conditions.push(
        '(instr(lower(output_name), lower(?)) > 0 OR instr(lower(original_name), lower(?)) > 0)'
      )
      values.push(query.name, query.name)
    }
    for (const [key, column, sign] of [
      ['modifiedFrom', 'source_modified_at', '>='],
      ['modifiedTo', 'source_modified_at', '<'],
      ['archivedFrom', 'archived_at', '>='],
      ['archivedTo', 'archived_at', '<']
    ] as const) {
      const value = query[key]
      if (value !== undefined) {
        conditions.push(`${column} ${sign} ?`)
        values.push(value)
      }
    }
    if (query.tags?.length) {
      conditions.push(`(SELECT COUNT(*) FROM catalog_item_tags t WHERE t.item_id = catalog_items.id
        AND t.tag IN (${query.tags.map(() => '?').join(',')})) = ?`)
      values.push(...query.tags, query.tags.length)
    }
    const where = conditions.join(' AND ')
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS total FROM catalog_items WHERE ${where}`).get(...values)
        ?.total
    )
    const ids = this.db
      .prepare(
        `SELECT id FROM catalog_items WHERE ${where} ORDER BY archived_at DESC, id LIMIT 50 OFFSET ?`
      )
      .all(...values, query.offset ?? 0)
    return { items: ids.map((row) => this.item(String(row.id))), total, tags: this.allTags() }
  }

  recoveryIds(): string[] {
    return this.db
      .prepare(
        `SELECT id FROM catalog_items WHERE compression_status = 'ready'
      AND ((backup_status IN ('pending', 'error') AND NOT EXISTS
        (SELECT 1 FROM office_replacements o WHERE o.item_id = catalog_items.id))
        OR archive_status = 'copying')`
      )
      .all()
      .map((row) => String(row.id))
  }

  archivedIds(): string[] {
    return this.db
      .prepare("SELECT id FROM catalog_items WHERE archive_status = 'ready'")
      .all()
      .map((row) => String(row.id))
  }
}
