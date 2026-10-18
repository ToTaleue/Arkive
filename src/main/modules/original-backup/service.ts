import { basename, dirname } from 'node:path'
import { link, unlink } from 'node:fs/promises'
import { assertSystemWriteAllowed } from '../../system-paths'
import { CatalogRepository, type CatalogRow } from '../catalog/repository'
import {
  copyVerified,
  dayKey,
  destination,
  exists,
  fileInfo,
  hashFile,
  hasCode,
  managedDirectory,
  syncFile
} from '../catalog/files'

async function requireOriginal(row: CatalogRow): Promise<void> {
  const info = await fileInfo(row.original_path)
  if (
    String(info.dev) !== row.source_dev ||
    String(info.ino) !== row.source_ino ||
    info.size !== row.source_size ||
    info.mtimeMs !== row.source_modified_at ||
    (await hashFile(row.original_path)) !== row.source_hash
  ) {
    throw new Error('压缩期间原件已改变，未移动；请检查原文件。')
  }
}

export async function backupOriginal(
  repo: CatalogRepository,
  id: string,
  root: string
): Promise<void> {
  let row = repo.get(id)
  if (row.backup_status !== 'pending' && row.backup_status !== 'error') return
  try {
    await assertSystemWriteAllowed(row.original_path, true)
    const directory = await managedDirectory(
      root,
      row.backup_path ? basename(dirname(row.backup_path)) : dayKey()
    )
    const target = row.backup_path ?? destination(directory, basename(row.original_path), id)
    repo.update(id, { backup_path: target, backup_status: 'pending', backup_error: null })
    row = repo.get(id)
    // Recheck the output on a restart/retry before removing any source pathname.
    if (!row.output_hash || (await hashFile(row.output_path)) !== row.output_hash) {
      throw new Error('压缩结果缺失或已改变，原件未移动。')
    }
    if (!(await exists(target))) {
      await requireOriginal(row)
      try {
        await link(row.original_path, target)
      } catch (error) {
        if (!hasCode(error, 'EXDEV')) throw error
        await copyVerified(row.original_path, target, row.source_hash, true)
      }
    }
    if ((await hashFile(target)) !== row.source_hash) throw new Error('备份校验失败，原件未移除。')
    await syncFile(target)
    if (await exists(row.original_path)) {
      await requireOriginal(row)
      await unlink(row.original_path)
    }
    repo.update(id, { backup_status: 'ready', backup_error: null, backed_up_at: Date.now() })
  } catch (error) {
    repo.update(id, {
      backup_status: 'error',
      backup_error: error instanceof Error ? error.message : String(error)
    })
  }
}
