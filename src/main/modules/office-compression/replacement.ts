import { basename, dirname } from 'node:path'
import { link, rmdir, unlink } from 'node:fs/promises'
import { assertSystemWriteAllowed } from '../../system-paths'
import { CatalogRepository } from '../catalog/repository'
import { backupOriginal } from '../original-backup/service'
import { copyVerified, exists, hashFile, hasCode, syncFile } from '../catalog/files'

/** Persisted publication is separate from backup: a restart must finish both steps. */
export function prepareOfficeReplacement(repo: CatalogRepository, id: string): void {
  const row = repo.get(id)
  repo.db
    .prepare(
      `INSERT INTO office_replacements
    (item_id, candidate_path, original_path) VALUES (?, ?, ?)`
    )
    .run(id, row.output_path, row.original_path)
}

async function cleanCandidate(candidate: string, original: string): Promise<void> {
  const directory = dirname(candidate)
  if (
    dirname(directory) !== dirname(original) ||
    !basename(directory).startsWith('.arkive-office-replace-')
  )
    return
  if (await exists(candidate)) await unlink(candidate)
  // Never recursively delete a persisted path; an unexpected file is left for inspection.
  await rmdir(directory).catch(() => undefined)
}

/** Called under Catalog's operation lock, including during startup recovery. */
export async function commitOfficeReplacement(
  repo: CatalogRepository,
  backupRoot: string,
  id: string
): Promise<void> {
  const plan = repo.db.prepare('SELECT * FROM office_replacements WHERE item_id = ?').get(id)
  if (!plan || typeof plan.candidate_path !== 'string' || typeof plan.original_path !== 'string') {
    throw new Error('Office 替换记录缺失。')
  }
  const candidate = plan.candidate_path
  const original = plan.original_path
  if (plan.state === 'replaced') {
    await cleanCandidate(candidate, original).catch(() => undefined)
    return
  }
  try {
    await assertSystemWriteAllowed(original, true)
    let row = repo.get(id)
    if (!row.output_hash || (await hashFile(candidate)) !== row.output_hash) {
      throw new Error('已校验的 Office 候选缺失或已改变，未替换。')
    }
    const alreadyPublished =
      (await exists(original)) && (await hashFile(original)) === row.output_hash
    if (!alreadyPublished) {
      if (row.backup_status === 'ready') {
        if (await exists(original)) throw new Error('原路径被其他文件占用，未覆盖。')
      } else {
        await backupOriginal(repo, id, backupRoot)
        row = repo.get(id)
        if (row.backup_status !== 'ready')
          throw new Error(row.backup_error ?? 'Office 原件备份未完成。')
      }
      repo.db
        .prepare(
          "UPDATE office_replacements SET state = 'backed-up', error = NULL WHERE item_id = ?"
        )
        .run(id)
      // The candidate and original reside on the same volume. Never overwrite an external edit.
      await link(candidate, original)
      await syncFile(original)
    }
    row = repo.get(id)
    if (!row.backup_path || (await hashFile(row.backup_path)) !== row.source_hash) {
      throw new Error('Office 原件备份未通过校验。')
    }
    if ((await hashFile(original)) !== row.output_hash) throw new Error('Office 发布校验失败。')
    repo.db.exec('BEGIN IMMEDIATE')
    try {
      repo.update(id, { output_path: original, compression_status: 'ready' })
      repo.db
        .prepare('UPDATE catalog_items SET output_name = ? WHERE id = ?')
        .run(basename(original), id)
      repo.db
        .prepare(
          "UPDATE office_replacements SET state = 'replaced', error = NULL WHERE item_id = ?"
        )
        .run(id)
      repo.db.exec('COMMIT')
    } catch (error) {
      repo.db.exec('ROLLBACK')
      throw error
    }
    await cleanCandidate(candidate, original).catch(() => undefined)
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    const row = repo.get(id)
    // Restore only an absent pathname. An external replacement is never overwritten.
    try {
      if (
        !(await exists(original)) &&
        row.backup_path &&
        (await hashFile(row.backup_path)) === row.source_hash
      ) {
        try {
          await link(row.backup_path, original)
        } catch (restoreError) {
          if (!hasCode(restoreError, 'EXDEV')) throw restoreError
          await copyVerified(row.backup_path, original, row.source_hash, true)
        }
        await syncFile(original)
      }
    } catch (restoreError) {
      message += `；原路径恢复未完成：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
    }
    repo.update(id, { compression_status: 'failed' })
    repo.db
      .prepare("UPDATE office_replacements SET state = 'error', error = ? WHERE item_id = ?")
      .run(message, id)
    throw new Error(message)
  }
}

export async function recoverOfficeReplacements(
  repo: CatalogRepository,
  backupRoot: string
): Promise<void> {
  const rows = repo.db
    .prepare(
      "SELECT item_id FROM office_replacements WHERE state IN ('prepared', 'backed-up', 'replaced')"
    )
    .all()
  for (const row of rows) {
    if (typeof row.item_id !== 'string') continue
    // A failed plan is recorded and isolated; other documents can still recover/start normally.
    await commitOfficeReplacement(repo, backupRoot, row.item_id).catch(() => undefined)
  }
}
