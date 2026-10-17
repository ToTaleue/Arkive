import assert from 'node:assert/strict'
import { app } from 'electron'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { runBundledTool } from '../../../execution/process'
import { tasks, DuplicateTaskError, TaskCancelled } from '../../tasks/service'
import { Catalog, setCatalog } from './service'
import { exists, hashFile } from './files'
import { compressImageAndBackup, compressPdfAndBackup, compressVideoAndBackup } from './compression'
import type { TaskSnapshot } from '../../../shared/contracts/task'
import { checkScheduledOperations } from '../../tasks/operations.test'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'Task transition timed out')
    await delay(10)
  }
}

async function check(): Promise<void> {
  await app.whenReady()
  const root = '/Users/hu1hui/Desktop/arkive-test'
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'compression-tasks-'))
  const catalog = new Catalog({
    databasePath: join(directory, 'catalog.db'),
    backupRoot: join(directory, 'Backup'),
    archiveRoot: join(directory, 'Archive')
  })
  setCatalog(catalog)
  await catalog.start()
  const releases: (() => void)[] = []
  const file = (name: string): string => join(directory, name)
  const image = async (name: string): Promise<string> => {
    const path = file(name)
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#90b080' } })
      .png({ compressionLevel: 0 })
      .toFile(path)
    return path
  }
  const snapshot = (requestId: string): TaskSnapshot => {
    const task = tasks.list().find((item) => item.requestId === requestId)
    assert.ok(task, `Missing task ${requestId}`)
    return task
  }
  try {
    const input = await image('image.png')
    const originalHash = await hashFile(input)
    const pdf = file('input.pdf')
    const ps = file('input.ps')
    await writeFile(
      ps,
      '%!PS\n/Helvetica findfont 18 scalefont setfont\n72 720 moveto (Generated task fixture) show\nshowpage\n'
    )
    assert.equal(
      (
        await runBundledTool('ghostscript', [
          '-dBATCH',
          '-dNOPAUSE',
          '-sDEVICE=pdfwrite',
          `-sOutputFile=${pdf}`,
          ps
        ])
      ).exitCode,
      0
    )
    const video = file('input.mov')
    assert.equal(
      (
        await runBundledTool('ffmpeg', [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x240:rate=24:duration=1',
          '-c:v',
          'mpeg4',
          '-q:v',
          '2',
          video
        ])
      ).exitCode,
      0
    )

    const gate = deferred()
    releases.push(gate.resolve)
    const blocker = tasks.submitBatch(
      [{ title: 'hold real compression queue', run: () => gate.promise }],
      { onError: 'stop' }
    )
    const started: string[] = []
    const unsubscribe = tasks.subscribe(() => {
      for (const task of tasks.list()) {
        if (task.status === 'running' && task.requestId && !started.includes(task.requestId))
          started.push(task.requestId)
      }
    })
    const request = { inputPath: input, outputPath: file('image.webp') }
    const imageWork = compressImageAndBackup(request, undefined, 'image')
    await waitFor(() => tasks.list().some((task) => task.requestId === 'image'))
    request.outputPath = file('mutated.webp')
    const pdfWork = compressPdfAndBackup(
      { inputPath: pdf, outputPath: file('result.pdf') },
      undefined,
      'pdf'
    )
    await waitFor(() => tasks.list().some((task) => task.requestId === 'pdf'))
    const videoWork = compressVideoAndBackup(
      { inputPath: video, outputPath: file('result.mp4') },
      undefined,
      undefined,
      'video'
    )
    await waitFor(() => tasks.list().some((task) => task.requestId === 'video'))
    const alias = file('alias.png')
    await symlink(input, alias)
    await assert.rejects(
      compressImageAndBackup({ inputPath: alias, outputPath: file('duplicate.webp') }),
      DuplicateTaskError
    )
    assert.deepEqual(
      ['image', 'pdf', 'video'].map((id) => snapshot(id).status),
      ['queued', 'queued', 'queued']
    )
    assert.equal(await exists(file('image.webp')), false)
    assert.equal(
      catalog.query({ state: 'pending' }).total,
      0,
      'Queued work must not create database records'
    )
    gate.resolve()
    await tasks.wait(blocker.taskIds[0])
    const [imageResult, pdfResult, videoResult] = await Promise.all([imageWork, pdfWork, videoWork])
    unsubscribe()
    assert.deepEqual(started, ['image', 'pdf', 'video'])
    const imageFinished = snapshot('image').finishedAt
    const pdfStarted = snapshot('pdf').startedAt
    const pdfFinished = snapshot('pdf').finishedAt
    const videoStarted = snapshot('video').startedAt
    assert.ok(
      imageFinished !== undefined && pdfStarted !== undefined && pdfStarted >= imageFinished
    )
    assert.ok(
      pdfFinished !== undefined && videoStarted !== undefined && videoStarted >= pdfFinished
    )
    assert.deepEqual(
      ['image', 'pdf', 'video'].map((id) => snapshot(id).status),
      ['succeeded', 'succeeded', 'succeeded']
    )
    assert.equal(imageResult.outputPath, file('image.webp'))
    assert.equal(await exists(file('mutated.webp')), false)
    assert.equal(imageResult.catalog.backupStatus, 'ready')
    assert.equal(await hashFile(imageResult.catalog.backupPath ?? ''), originalHash)
    assert.equal((await runBundledTool('qpdf', ['--check', pdfResult.outputPath])).exitCode, 0)
    assert.ok((await stat(videoResult.outputPath)).size > 0)
    console.log(
      'PASS: image/PDF/video use one real FIFO queue, preserve typed results, canonical deduplication and immutable requests'
    )

    const cancelledInput = await image('queued-cancel.png')
    const pause = deferred()
    releases.push(pause.resolve)
    const held = tasks.submitBatch(
      [{ title: 'hold cancellation queue', run: () => pause.promise }],
      { onError: 'stop' }
    )
    const queued = compressImageAndBackup(
      { inputPath: cancelledInput, outputPath: file('cancelled.webp') },
      undefined,
      'queued-cancel'
    )
    const rejected = assert.rejects(queued, TaskCancelled)
    await waitFor(() => tasks.list().some((task) => task.requestId === 'queued-cancel'))
    tasks.cancel(snapshot('queued-cancel').id)
    await rejected
    assert.equal(await exists(file('cancelled.webp')), false)
    assert.equal(await exists(cancelledInput), true)
    pause.resolve()
    await tasks.wait(held.taskIds[0])

    if (videoResult.catalog.backupPath) await copyFile(videoResult.catalog.backupPath, video)
    const activeVideo = compressVideoAndBackup(
      { inputPath: video, outputPath: file('cancelled.mp4') },
      undefined,
      () => {
        tasks.cancel(snapshot('active-cancel').id)
      },
      'active-cancel'
    )
    await assert.rejects(activeVideo, TaskCancelled)
    assert.equal(snapshot('active-cancel').status, 'cancelled')
    assert.equal(await exists(file('cancelled.mp4')), false)
    assert.equal(await exists(video), true)
    console.log(
      'PASS: queued and running Task-origin cancellation reaches actual business work and retains originals'
    )

    const partialInput = await image('backup-failure.png')
    await rename(catalog.backupRoot, file('Backup.saved'))
    await writeFile(catalog.backupRoot, 'generated filesystem fault')
    const partial = await compressImageAndBackup(
      { inputPath: partialInput, outputPath: file('partial.webp') },
      undefined,
      'partial'
    )
    assert.equal(partial.catalog.backupStatus, 'error')
    assert.equal(snapshot('partial').status, 'failed')
    assert.deepEqual(snapshot('partial').result, partial)
    assert.equal(await exists(partialInput), true)
    assert.ok((await stat(partial.outputPath)).size > 0)
    await rm(catalog.backupRoot)
    await rename(file('Backup.saved'), catalog.backupRoot)
    await catalog.retryBackup(partial.catalog.id)
    assert.ok(catalog.get(partial.catalog.id).backupPath)

    const committedInput = await image('late-cancel.png')
    const cancelLate = tasks.subscribe(() => {
      const task = tasks.list().find((item) => item.requestId === 'late-cancel')
      if (task?.progress?.message === '正在处理原件备份…' && !task.cancellationRequested)
        tasks.cancel(task.id)
    })
    const committed = await compressImageAndBackup(
      { inputPath: committedInput, outputPath: file('committed.webp') },
      undefined,
      'late-cancel'
    )
    cancelLate()
    assert.equal(committed.catalog.backupStatus, 'ready')
    assert.equal(snapshot('late-cancel').status, 'succeeded')
    assert.equal(snapshot('late-cancel').cancellationRequested, true)
    console.log(
      'PASS: real backup failure retains recoverable partial results; late cancellation preserves successful commits'
    )
    await checkScheduledOperations(catalog, directory)
  } finally {
    for (const release of releases) release()
    await tasks.close()
    await catalog.close()
  }
  console.log(`Compression task fixtures: ${directory}`)
}

const timeout = setTimeout(() => {
  app.exit(1)
}, 180_000)
void check().then(
  () => {
    clearTimeout(timeout)
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
