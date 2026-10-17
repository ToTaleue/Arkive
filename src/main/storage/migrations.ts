import type { DatabaseSync } from 'node:sqlite'

export function migrateDatabase(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (version > 2) throw new Error('数据库版本高于当前应用，请使用更新版本的 Arkive。')
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY, original_path TEXT NOT NULL, output_path TEXT NOT NULL,
      original_name TEXT NOT NULL, output_name TEXT NOT NULL,
      source_size INTEGER NOT NULL, source_modified_at REAL NOT NULL,
      source_dev TEXT NOT NULL, source_ino TEXT NOT NULL, source_hash TEXT NOT NULL,
      output_hash TEXT, output_bytes INTEGER NOT NULL DEFAULT 0,
      compression_status TEXT NOT NULL DEFAULT 'pending', backup_path TEXT,
      backup_status TEXT NOT NULL DEFAULT 'pending', backup_error TEXT, backed_up_at INTEGER,
      archive_path TEXT, archive_status TEXT NOT NULL DEFAULT 'none', archived_at INTEGER,
      tag_status TEXT NOT NULL DEFAULT 'pending', tag_error TEXT,
      pending_add TEXT NOT NULL DEFAULT '[]', pending_remove TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS catalog_tags (name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS catalog_item_tags (
      item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
      tag TEXT NOT NULL REFERENCES catalog_tags(name), PRIMARY KEY (item_id, tag)
    );
    CREATE INDEX IF NOT EXISTS catalog_archive_date ON catalog_items(archive_status, archived_at);
    CREATE INDEX IF NOT EXISTS catalog_modified_date ON catalog_items(source_modified_at);
    CREATE INDEX IF NOT EXISTS catalog_tag_items ON catalog_item_tags(tag, item_id);
    COMMIT;
  `)
  if (version < 2) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE catalog_items ADD COLUMN inherit_tags_pending INTEGER NOT NULL DEFAULT 1;
      UPDATE catalog_items SET inherit_tags_pending = 0 WHERE archive_status = 'ready';
      PRAGMA user_version = 2;
      COMMIT;`)
  }
}
