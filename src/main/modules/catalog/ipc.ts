import { BrowserWindow, ipcMain, shell, type WebContents } from 'electron'
import {
  catalogChannels,
  type ArchiveOptions,
  type CatalogQuery
} from '../../../shared/contracts/catalog'
import { normalizeTags } from './finder-tags'
import type { Catalog } from './service'
import { archiveFile, retryBackup, tagArchives } from './operations'

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f-]{36}$/i.test(value))
    throw new Error('无效的资料 ID。')
  return value
}

function query(value: unknown): CatalogQuery {
  if (!value || typeof value !== 'object') throw new Error('无效的检索条件。')
  const request = value as Record<string, unknown>
  const result: CatalogQuery = {}
  if (request.state !== undefined) {
    if (request.state !== 'archived' && request.state !== 'pending' && request.state !== 'backup')
      throw new Error('无效的归档状态。')
    result.state = request.state
  }
  if (request.kind !== undefined) {
    if (request.kind !== 'video' && request.kind !== 'image' && request.kind !== 'document')
      throw new Error('无效的文件类型。')
    result.kind = request.kind
  }
  if (request.name !== undefined) {
    if (typeof request.name !== 'string' || request.name.length > 500)
      throw new Error('搜索文本过长。')
    result.name = request.name.trim()
  }
  if (request.tags !== undefined) result.tags = normalizeTags(request.tags)
  for (const field of [
    'modifiedFrom',
    'modifiedTo',
    'archivedFrom',
    'archivedTo',
    'offset'
  ] as const) {
    const number = request[field]
    if (number !== undefined) {
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
        throw new Error('日期或分页条件无效。')
      result[field] = number
    }
  }
  return result
}

function archiveOptions(value: unknown): ArchiveOptions {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('无效的归档选项。')
  const request = value as Record<string, unknown>
  if (request.autoTag !== undefined && typeof request.autoTag !== 'boolean')
    throw new Error('自动打标选项必须为布尔值。')
  if (
    request.keepLinkAtOriginalLocation !== undefined &&
    typeof request.keepLinkAtOriginalLocation !== 'boolean'
  )
    throw new Error('原位置入口选项必须为布尔值。')
  if (request.moveToArchive !== undefined && typeof request.moveToArchive !== 'boolean')
    throw new Error('搬入归档选项必须为布尔值。')
  return {
    autoTag: request.autoTag,
    keepLinkAtOriginalLocation: request.keepLinkAtOriginalLocation,
    moveToArchive: request.moveToArchive
  }
}

export function registerCatalogIpc(catalog: Catalog): (contents: WebContents) => void {
  const windows = new Set<WebContents>()
  function handle(channel: string, operation: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args: unknown[]): unknown => {
      if (
        !windows.has(event.sender) ||
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('无效的归档窗口。')
      return operation(...args)
    })
  }
  handle(catalogChannels.query, (request) => catalog.query(query(request)))
  handle(catalogChannels.get, (value) => catalog.get(id(value)))
  handle(catalogChannels.archive, (value, tags, options) =>
    archiveFile(catalog, id(value), normalizeTags(tags), undefined, archiveOptions(options))
  )
  handle(catalogChannels.retryBackup, (value) => retryBackup(catalog, id(value)))
  handle(catalogChannels.tags, (values, add, remove) => {
    if (!Array.isArray(values) || values.length === 0 || values.length > 100)
      throw new Error('请选择最多 100 个文件。')
    return tagArchives(catalog, values.map(id), normalizeTags(add), normalizeTags(remove)).then(
      () => undefined
    )
  })
  handle(catalogChannels.refresh, () => catalog.refresh())
  function target(value: unknown): 'archive' | 'backup' {
    if (value === undefined || value === 'archive') return 'archive'
    if (value === 'backup') return 'backup'
    throw new Error('无效的文件位置。')
  }
  handle(catalogChannels.open, async (value, location) => {
    const error = await shell.openPath(await catalog.filePath(id(value), target(location)))
    if (error) throw new Error(error)
  })
  handle(catalogChannels.reveal, async (value, location) => {
    shell.showItemInFolder(await catalog.filePath(id(value), target(location)))
  })
  catalog.subscribe(() => {
    for (const contents of windows)
      if (!contents.isDestroyed()) contents.send(catalogChannels.changed)
  })
  return (contents) => {
    windows.add(contents)
    contents.once('destroyed', () => {
      windows.delete(contents)
    })
  }
}
