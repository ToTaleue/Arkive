import type { ArchiveItem, ArchiveOptions } from '../../../shared/contracts/catalog'
import { runTask, TaskFailure } from '../../tasks/service'
import { normalizeTags } from './finder-tags'
import { recommendArchiveTags } from './automatic-tags'
import type { Catalog } from './service'

/** Schedule explicit product operations; compression follow-ups use Catalog directly. */
async function schedule<T>(
  title: string,
  key: string,
  work: () => Promise<T>,
  failure: (result: T) => string | undefined,
  signal?: AbortSignal
): Promise<T> {
  let completed: T | undefined
  try {
    return await runTask(
      {
        title,
        key,
        run: async (taskSignal, report) => {
          taskSignal.throwIfAborted()
          report({ message: title + '…' })
          taskSignal.throwIfAborted()
          // Catalog commits are not interruptible. Keep waiting for the real outcome.
          completed = await work()
          const error = failure(completed)
          if (error) throw new TaskFailure(error, completed)
          return completed
        }
      },
      signal
    )
  } catch (error) {
    // Callers still need per-record recovery and tag diagnostics, as before scheduling.
    if (error instanceof TaskFailure && completed !== undefined) return completed
    throw error
  }
}

export function archiveFile(
  catalog: Catalog,
  id: string,
  tags: string[] = [],
  signal?: AbortSignal,
  options: ArchiveOptions = {}
): Promise<ArchiveItem> {
  if (options.autoTag !== undefined && typeof options.autoTag !== 'boolean')
    throw new Error('自动打标选项必须为布尔值。')
  const chosen = normalizeTags(tags)
  options = structuredClone(options)
  return schedule(
    '正在归档文件',
    `catalog:${id}`,
    async () => {
      const row = catalog.repo.get(id)
      const automaticTags =
        options.autoTag === false || row.archive_status === 'ready'
          ? undefined
          : await recommendArchiveTags(catalog, id, row.original_path, signal)
      const recommendedTags = automaticTags?.status === 'ready' ? automaticTags.tags : []
      const item = await catalog.archive(
        id,
        normalizeTags([...chosen, ...recommendedTags]),
        options
      )
      return automaticTags ? { ...item, automaticTags } : item
    },
    (item) =>
      item.tagStatus === 'error'
        ? (item.tagError ?? '归档完成，但标签同步失败。')
        : item.originalLink?.status === 'error'
          ? (item.originalLink.error ?? '归档完成，但原位置入口未创建。')
          : undefined,
    signal
  )
}

/** Direct archiving shares publication, tags, task reporting and restart recovery. */
export function archivePath(
  catalog: Catalog,
  inputPath: string,
  tags: string[] = [],
  signal?: AbortSignal,
  options: ArchiveOptions = {}
): Promise<ArchiveItem> {
  signal?.throwIfAborted()
  if (options.autoTag !== undefined && typeof options.autoTag !== 'boolean')
    throw new Error('自动打标选项必须为布尔值。')
  return catalog
    .prepareFileArchive(inputPath)
    .then((id) => archiveFile(catalog, id, tags, signal, options))
}

export function retryBackup(
  catalog: Catalog,
  id: string,
  signal?: AbortSignal
): Promise<ArchiveItem> {
  return schedule(
    '正在重试原件备份',
    `catalog:${id}`,
    () => catalog.retryBackup(id),
    (item) => (item.backupStatus === 'error' ? (item.backupError ?? '原件备份失败。') : undefined),
    signal
  )
}

export function tagArchives(
  catalog: Catalog,
  ids: string[],
  add: string[] = [],
  remove: string[] = [],
  signal?: AbortSignal
): Promise<{ items: ArchiveItem[] }> {
  if (!ids.length || ids.length > 100) throw new Error('请选择最多 100 个文件。')
  const selected = [...new Set(ids)]
  const additions = normalizeTags(add)
  const removals = normalizeTags(remove)
  return schedule(
    '正在修改归档标签',
    `catalog-tags:${[...selected].sort().join(',')}`,
    async () => {
      await catalog.editTags(selected, additions, removals)
      return { items: selected.map((id) => catalog.get(id)) }
    },
    ({ items }) => {
      const failed = items.filter((item) => item.tagStatus === 'error')
      return failed.length ? `${String(failed.length)} 项标签同步失败，请检查逐项结果。` : undefined
    },
    signal
  )
}
