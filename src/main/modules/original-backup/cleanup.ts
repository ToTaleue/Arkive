import { shell } from 'electron'
import { assertSystemWriteAllowed } from '../../system-paths'
import type { CatalogRepository } from '../catalog/repository'
import { assertManagedFile, exists, fileInfo, hashFile } from '../catalog/files'
import { fileTags, normalizeTags } from '../catalog/finder-tags'

/** Called under Catalog's lock. No directory-wide deletion and no permanent-delete fallback. */
export async function cleanupBackup(
  repo: CatalogRepository,
  backupRoot: string,
  archiveRoot: string,
  id: string,
  trash: (path: string) => Promise<void> = (path) => shell.trashItem(path)
): Promise<number> {
  const row = repo.get(id)
  if (row.backup_status !== 'ready' || !row.backup_path) throw new Error('备份状态已变化，未清理。')
  const path = row.backup_path
  await assertSystemWriteAllowed(path, true)
  await assertManagedFile(backupRoot, path)
  const before = await fileInfo(path)
  if ((await hashFile(path)) !== row.source_hash) throw new Error('备份内容已改变，未清理。')
  if (row.compression_status !== 'ready' || !row.output_hash)
    throw new Error('压缩结果尚未就绪，未清理。')
  const office = repo.db.prepare('SELECT state FROM office_replacements WHERE item_id = ?').get(id)
  if (office && office.state !== 'replaced') throw new Error('Office 原路径发布未完成，未清理。')
  let validOutput = false
  // An output moved into Archive may now be a link; the managed archive is checked separately.
  try {
    validOutput = (await hashFile(row.output_path)) === row.output_hash
  } catch {
    /* Try the independent archive copy. */
  }
  if (!validOutput && row.archive_status === 'ready' && row.archive_path) {
    try {
      await assertManagedFile(archiveRoot, row.archive_path)
      validOutput = (await hashFile(row.archive_path)) === row.output_hash
    } catch {
      /* Report an unavailable result below. */
    }
  }
  if (!validOutput) throw new Error('压缩结果和归档副本缺失或已改变，未清理。')
  // Preserve the last metadata source before removing it, including deferred tag inheritance.
  if (row.inherit_tags_pending) {
    const inherited = await fileTags(path)
    repo.setTags(id, normalizeTags([...repo.tags(id), ...inherited]))
    const pending = normalizeTags(JSON.parse(row.pending_add) as unknown)
    repo.update(id, {
      inherit_tags_pending: 0,
      pending_add: JSON.stringify(normalizeTags([...pending, ...inherited]))
    })
  }
  await assertManagedFile(backupRoot, path)
  await assertSystemWriteAllowed(path, true)
  const after = await fileInfo(path)
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error('核对期间备份发生变化，未清理。')
  repo.update(id, { backup_status: 'cleanup-pending', backup_error: null })
  try {
    await trash(path)
    if (await exists(path)) throw new Error('回收站操作后备份仍在原位，请检查。')
    repo.update(id, { backup_status: 'trashed', backup_cleaned_at: Date.now(), backup_error: null })
  } catch (error) {
    // A rejected OS operation can have moved the file. Do not assume success or recreate it.
    await recoverPendingCleanup(repo, id)
    throw error
  }
  return before.size
}

export async function recoverPendingCleanup(repo: CatalogRepository, id: string): Promise<void> {
  const row = repo.get(id)
  if (row.backup_status !== 'cleanup-pending') return
  let present = false
  try {
    present = Boolean(row.backup_path && (await exists(row.backup_path)))
  } catch {
    /* Unknown. */
  }
  repo.update(id, {
    backup_status: present ? 'ready' : 'cleanup-unknown',
    backup_error: present
      ? '上次清理未完成，原件仍在；可重新清理。'
      : '清理结果待核对：备份不在原位，未确认移入回收站。'
  })
}
