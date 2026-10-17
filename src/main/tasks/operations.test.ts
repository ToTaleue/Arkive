import assert from 'node:assert/strict'
import type { TaskSnapshot } from '../../shared/contracts/task'
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { tasks, DuplicateTaskError, TaskCancelled, TaskFailure } from './service'
import type { Catalog } from '../modules/catalog/service'
import { exists, hashFile } from '../modules/catalog/files'
import { archiveFile, retryBackup, tagArchives } from '../modules/catalog/operations'
import { compressOfficeInPlace } from '../modules/office-compression/in-place'
import { fixture } from '../modules/office-compression/fixtures.test'
import {
  copyPath,
  movePath,
  createDirectory,
  trashFiles
} from '../modules/file-operations/operations'

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Operation task transition timed out')
    await delay(10)
  }
}

export async function checkScheduledOperations(catalog: Catalog, root: string): Promise<void> {
  const directory = join(root, 'scheduled-operations')
  await mkdir(directory)
  const path = (name: string): string => join(directory, name)
  const latest = (key: string): TaskSnapshot => {
    const task = tasks
      .list()
      .reverse()
      .find((item) => item.key === key)
    assert.ok(task, `Missing operation task ${key}`)
    return task
  }
  const hold = (): { release: () => void; id: string } => {
    let release!: () => void
    const promise = new Promise<void>((done) => {
      release = done
    })
    const batch = tasks.submitBatch([{ title: 'hold operation queue', run: () => promise }], {
      onError: 'stop'
    })
    return { release, id: batch.taskIds[0] }
  }
  async function ready(name: string, savings = false): Promise<string> {
    const input = path(`${name}.original.txt`)
    const output = path(`${name}.output.txt`)
    await writeFile(input, `original generated fixture ${name}`)
    await writeFile(output, `output ${name}`)
    const id = await catalog.beginCompression(input, output)
    await catalog.finishCompression(id, savings)
    return id
  }
  const media = await sharp({
    create: { width: 256, height: 256, channels: 3, background: '#8090a0' }
  })
    .png({ compressionLevel: 0 })
    .toBuffer()
  const office = path('queued.docx')
  await fixture(office, 'docx', [media])
  const officeHash = await hashFile(office)
  const alias = path('alias.docx')
  await symlink(office, alias)
  const archiveId = await ready('archive')
  const taggedId = await ready('tags')
  await catalog.archive(taggedId, [])
  const copySource = path('copy-source.txt')
  const copied = path('copied.txt')
  const moved = path('moved.txt')
  const deleted = path('delete.txt')
  await writeFile(copySource, 'copy bytes')
  await writeFile(deleted, 'delete fixture')

  const blocker = hold()
  const pending: Promise<unknown>[] = []
  const keys: string[] = []
  const started: string[] = []
  const unsubscribe = tasks.subscribe(() => {
    const task = tasks
      .list()
      .find((item) => item.status === 'running' && item.key && keys.includes(item.key))
    if (task?.key && !started.includes(task.key)) started.push(task.key)
  })
  async function queue(key: string, work: () => Promise<unknown>): Promise<void> {
    keys.push(key)
    pending.push(work())
    await waitFor(() => tasks.list().some((task) => task.key === key && task.status === 'queued'))
  }
  try {
    const request = { inputPath: office, preset: 'quality' as const }
    await queue(`compress:${office}`, () => compressOfficeInPlace(request))
    request.inputPath = path('mutated.docx')
    await assert.rejects(compressOfficeInPlace({ inputPath: alias }), DuplicateTaskError)
    const tags = ['queued-tag']
    await queue(`catalog:${archiveId}`, () => archiveFile(catalog, archiveId, tags))
    tags.push('not-authorized')
    await assert.rejects(retryBackup(catalog, archiveId), DuplicateTaskError)
    const add = ['batch-tag']
    await queue(`catalog-tags:${taggedId}`, () => tagArchives(catalog, [taggedId], add))
    add.push('not-authorized')
    const copyRequest = { sourcePath: copySource, destinationPath: copied }
    await queue(`file-write:${copied}`, () => copyPath(copyRequest))
    copyRequest.destinationPath = path('mutated.txt')
    await assert.rejects(
      copyPath({ sourcePath: copySource, destinationPath: copied }),
      DuplicateTaskError
    )
    await queue(`file-write:${moved}`, () =>
      movePath({ sourcePath: copied, destinationPath: moved })
    )
    await queue(`file-write:${path('created')}`, () => createDirectory({ path: path('created') }))
    await queue(`trash:${JSON.stringify([deleted])}`, () => trashFiles([deleted], undefined, true))
    assert.ok(keys.every((key) => latest(key).status === 'queued'))
    assert.equal(await hashFile(office), officeHash)
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith('.arkive-office-replace-')),
      false
    )
    assert.equal(catalog.get(archiveId).archivePath, null)
    assert.equal(await exists(copied), false)
    assert.equal(await exists(moved), false)
    assert.equal(await exists(path('created')), false)
    assert.equal(await exists(deleted), true)
    blocker.release()
    const results = await Promise.all(pending)
    assert.deepEqual(started, keys)
    assert.ok(keys.every((key) => latest(key).status === 'succeeded'))
    const result = results[0] as Awaited<ReturnType<typeof compressOfficeInPlace>>
    assert.equal(result.replacementStatus, 'replaced', result.replacementError)
    assert.ok(result.catalog?.backupPath)
    assert.equal(await hashFile(result.catalog.backupPath), officeHash)
    assert.deepEqual(catalog.get(archiveId).tags, ['queued-tag'])
    assert.deepEqual(catalog.get(taggedId).tags, ['batch-tag'])
    assert.equal(await readFile(moved, 'utf8'), 'copy bytes')
    assert.equal(await exists(copied), false)
    assert.equal(await exists(path('mutated.txt')), false)
    assert.equal(await exists(path('created')), true)
    assert.equal(await exists(deleted), false)
  } finally {
    blocker.release()
    unsubscribe()
    await Promise.allSettled(pending)
  }
  console.log(
    'PASS: Office, archive, tags and native file operations share FIFO; no queued side effects, canonical deduplication and fixed requests'
  )

  const cancelledOffice = path('cancelled.docx')
  await fixture(cancelledOffice, 'docx', [])
  const cancelledHash = await hashFile(cancelledOffice)
  const cancelId = await ready('cancel-archive')
  const retained = path('retained.txt')
  await writeFile(retained, 'keep this fixture')
  const paused = hold()
  try {
    const cases: (() => Promise<unknown>)[] = [
      () => compressOfficeInPlace({ inputPath: cancelledOffice }),
      () => archiveFile(catalog, cancelId),
      () => tagArchives(catalog, [taggedId], ['cancelled-tag']),
      () => copyPath({ sourcePath: copySource, destinationPath: path('cancelled-copy.txt') }),
      () => movePath({ sourcePath: retained, destinationPath: path('cancelled-move.txt') }),
      () => createDirectory({ path: path('cancelled-directory') }),
      () => trashFiles([retained], undefined, true)
    ]
    for (const work of cases) {
      const count = tasks.list().length
      const pending = work()
      const rejected = assert.rejects(pending, TaskCancelled)
      await waitFor(() => tasks.list().length > count)
      const task = tasks.list().at(-1)
      assert.ok(task)
      assert.equal(task.status, 'queued')
      tasks.cancel(task.id)
      await rejected
    }
    assert.equal(await hashFile(cancelledOffice), cancelledHash)
    assert.equal(catalog.get(cancelId).archivePath, null)
    assert.deepEqual(catalog.get(taggedId).tags, ['batch-tag'])
    assert.equal(await readFile(retained, 'utf8'), 'keep this fixture')
    for (const name of ['cancelled-copy.txt', 'cancelled-move.txt', 'cancelled-directory'])
      assert.equal(await exists(path(name)), false)

    const destination = path('externally-created.txt')
    const work = copyPath({ sourcePath: copySource, destinationPath: destination })
    const rejected = assert.rejects(work, /目标已存在/)
    await waitFor(() => tasks.list().some((task) => task.key === `file-write:${destination}`))
    await writeFile(destination, 'external content must survive')
    paused.release()
    await rejected
    assert.equal(await readFile(destination, 'utf8'), 'external content must survive')
  } finally {
    paused.release()
    await tasks.wait(paused.id)
  }
  console.log(
    'PASS: queued cancellation leaves Office, Catalog and native paths untouched; destination is rechecked when execution starts'
  )

  // Cancel before Office encoding and after its publication commit point.
  const active = path('active-cancel.docx')
  await fixture(active, 'docx', [media])
  const activeHash = await hashFile(active)
  const stopEncoding = tasks.subscribe(() => {
    const task = tasks.list().find((item) => item.requestId === 'office-active-cancel')
    if (task?.progress?.message === '正在压缩并校验文档内嵌媒体…' && !task.cancellationRequested)
      tasks.cancel(task.id)
  })
  try {
    await assert.rejects(
      compressOfficeInPlace({ inputPath: active }, undefined, 'office-active-cancel'),
      TaskCancelled
    )
    assert.equal(await hashFile(active), activeHash)
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith('.arkive-office-replace-')),
      false
    )
  } finally {
    stopEncoding()
  }
  const stopLate = tasks.subscribe(() => {
    const task = tasks.list().find((item) => item.requestId === 'office-late-cancel')
    if (task?.progress?.message === '正在备份完整原件并发布文档…' && !task.cancellationRequested)
      tasks.cancel(task.id)
  })
  try {
    const result = await compressOfficeInPlace(
      { inputPath: active },
      undefined,
      'office-late-cancel'
    )
    assert.equal(result.replacementStatus, 'replaced', result.replacementError)
    const task = latest(`compress:${active}`)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.cancellationRequested, true)
  } finally {
    stopLate()
  }

  const failedOffice = path('backup-failure.docx')
  await fixture(failedOffice, 'docx', [media])
  const failedHash = await hashFile(failedOffice)
  await rename(catalog.backupRoot, catalog.backupRoot + '.saved')
  await writeFile(catalog.backupRoot, 'generated backup root failure')
  let retryId: string
  try {
    const result = await compressOfficeInPlace({ inputPath: failedOffice })
    assert.equal(result.replacementStatus, 'error')
    assert.equal(latest(`compress:${failedOffice}`).status, 'failed')
    assert.deepEqual(latest(`compress:${failedOffice}`).result, result)
    assert.equal(await hashFile(failedOffice), failedHash)
    retryId = await ready('backup-retry', true)
    const retried = await retryBackup(catalog, retryId)
    assert.equal(retried.backupStatus, 'error')
    assert.equal(latest(`catalog:${retryId}`).status, 'failed')
    assert.deepEqual(latest(`catalog:${retryId}`).result, retried)
  } finally {
    await rm(catalog.backupRoot)
    await rename(catalog.backupRoot + '.saved', catalog.backupRoot)
  }
  assert.equal((await retryBackup(catalog, retryId)).backupStatus, 'ready')
  const archivedPath = catalog.get(taggedId).archivePath
  assert.ok(archivedPath)
  await rename(archivedPath, archivedPath + '.saved')
  try {
    const partial = await tagArchives(catalog, [taggedId], ['retry-tag'])
    assert.equal(partial.items[0].tagStatus, 'error')
    assert.equal(latest(`catalog-tags:${taggedId}`).status, 'failed')
    assert.deepEqual(latest(`catalog-tags:${taggedId}`).result, partial)
  } finally {
    await rename(archivedPath + '.saved', archivedPath)
  }
  assert.equal((await tagArchives(catalog, [taggedId], ['retry-tag'])).items[0].tagStatus, 'synced')

  const first = path('delete-first.txt')
  const second = path('delete-second.txt')
  await writeFile(first, 'first fixture')
  await writeFile(second, 'second fixture')
  const deleteKey = `trash:${JSON.stringify([first, second].sort())}`
  const stopDelete = tasks.subscribe(() => {
    const task = tasks.list().find((item) => item.key === deleteKey)
    if (task?.progress?.message === '正在处理 2 / 2…' && !task.cancellationRequested)
      tasks.cancel(task.id)
  })
  try {
    await assert.rejects(trashFiles([first, second], undefined, true), TaskCancelled)
    assert.equal(await exists(first), false)
    assert.equal(await exists(second), true)
    const result = latest(deleteKey).result as { completed: string[]; unprocessed: string[] }
    assert.deepEqual(result.completed, [first])
    assert.deepEqual(result.unprocessed, [second])
  } finally {
    stopDelete()
  }
  const missing = path('missing.txt')
  await assert.rejects(trashFiles([missing, second], undefined, true), TaskFailure)
  const failedDelete = latest(`trash:${JSON.stringify([missing, second].sort())}`)
  const result = failedDelete.result as { completed: string[]; failed: { path: string }[] }
  assert.equal(failedDelete.status, 'failed')
  assert.deepEqual(result.completed, [second])
  assert.equal(result.failed[0].path, missing)
  console.log(
    'PASS: Office cancellation cleanup and commit outcomes, backup/tag retries and deletion partial results are reflected accurately in Task'
  )
}
