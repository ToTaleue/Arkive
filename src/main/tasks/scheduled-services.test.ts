import assert from 'node:assert/strict'
import { writePdfFixture } from '../modules/pdf-compression/test-fixture'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import type { TaskSnapshot } from '../../shared/contracts/task'
import { runBundledTool } from '../../execution/process'
import { tasks, DuplicateTaskError, TaskCancelled } from './service'
import {
  inspectImage,
  inspectOffice,
  inspectPdf,
  inspectVideo
} from '../modules/processing/operations'
import { scanDuplicates } from '../modules/duplicate-detection/operations'
import { cloneDuplicates } from '../modules/clone-deduplication/operations'
import { closeCloneDeduplication } from '../modules/clone-deduplication/service'
import {
  analyzeMole,
  listMoleApps,
  runMoleDryRun,
  runMoleInstallerPreview,
  runMolePurgePreview,
  trashMolePaths
} from '../modules/mole/operations'
import { trashFiles } from '../modules/file-operations/operations'
import { fixture } from '../modules/office-compression/fixtures.test'

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Scheduled service timed out')
    await delay(5)
  }
}
function hold(): { id: string; release: () => void } {
  let release!: () => void
  const pending = new Promise<void>((done) => {
    release = done
  })
  const { taskIds } = tasks.submitBatch([{ title: 'Hold shared queue', run: () => pending }], {
    onError: 'stop'
  })
  return { id: taskIds[0], release }
}
function latest(key: string): TaskSnapshot {
  const task = tasks
    .list()
    .reverse()
    .find((entry) => entry.key === key)
  assert.ok(task, `Missing task: ${key}`)
  return task
}

function killFixtureProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

export async function checkScheduledServices(root: string): Promise<void> {
  const files = join(root, 'files')
  await mkdir(files)
  const source = join(files, 'a.bin'),
    target = join(files, 'b.bin')
  await writeFile(source, 'identical generated clone fixture')
  await writeFile(target, 'identical generated clone fixture')
  const png = join(root, 'image.png')
  const media = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#8090a0' }
  })
    .png()
    .toBuffer()
  await writeFile(png, media)
  const office = join(root, 'document.docx')
  await fixture(office, 'docx', [media])
  const pdf = join(root, 'document.pdf'),
    video = join(root, 'video.mp4')
  await writePdfFixture(pdf, 'Task probe fixture')
  assert.equal(
    (
      await runBundledTool('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:s=64x64:r=24',
        '-t',
        '0.2',
        '-c:v',
        'libx264',
        video
      ])
    ).exitCode,
    0
  )
  const alias = join(root, 'alias')
  await symlink(files, alias, 'dir')
  const config = join(root, '.config/mole')
  await mkdir(config, { recursive: true })
  const cleanList = join(config, 'clean-list.txt')
  await writeFile(cleanList, 'sentinel')
  const cloneKey = `clone:${JSON.stringify([source, [target]])}`
  const blocker = hold()
  const pending: Promise<unknown>[] = []
  const keys: string[] = []
  const starts: string[] = []
  const unsubscribe = tasks.subscribe(() => {
    const active = tasks
      .list()
      .find((entry) => entry.status === 'running' && entry.key && keys.includes(entry.key))
    if (active?.key && !starts.includes(active.key)) starts.push(active.key)
  })
  async function queue(key: string, work: () => Promise<unknown>): Promise<void> {
    keys.push(key)
    pending.push(work())
    await until(() => tasks.list().some((entry) => entry.key === key && entry.status === 'queued'))
  }
  try {
    await queue(`inspect:图片:${png}`, () => inspectImage({ inputPath: png }))
    await queue(`inspect:视频:${video}`, () => inspectVideo(video))
    await queue(`inspect:PDF:${pdf}`, () => inspectPdf({ inputPath: pdf }))
    await queue(`inspect:Office:${office}`, () => inspectOffice(office))
    const scanRequest = { directoryPath: files }
    await queue(`duplicates:${files}`, () => scanDuplicates(scanRequest, undefined, 'scan-request'))
    scanRequest.directoryPath = '/missing-mutated'
    await assert.rejects(scanDuplicates({ directoryPath: alias }), DuplicateTaskError)
    const cloneRequest = { sourcePath: source, duplicatePaths: [target] }
    await queue(cloneKey, () => cloneDuplicates(cloneRequest))
    cloneRequest.duplicatePaths[0] = '/missing-mutated'
    await assert.rejects(
      cloneDuplicates({ sourcePath: join(alias, 'a.bin'), duplicatePaths: [join(alias, 'b.bin')] }),
      DuplicateTaskError
    )
    await queue(`mole-analyze:${files}`, () => analyzeMole(files))
    await queue('mole-preview', () => runMoleDryRun(() => {}, undefined, 'mole-request'))
    await assert.rejects(
      runMoleInstallerPreview(() => {}),
      DuplicateTaskError
    )
    await queue('mole-apps', () => listMoleApps())
    assert.equal(
      await readFile(cleanList, 'utf8'),
      'sentinel',
      'Queued Mole must not clear shared lists'
    )
    await assert.rejects(stat(join(root, 'mole-calls')), { code: 'ENOENT' })
    await assert.rejects(stat(join(root, 'recovery')), { code: 'ENOENT' })
    assert.deepEqual(await readdir(files), ['a.bin', 'b.bin'])
    blocker.release()
    const results = await Promise.all(pending)
    assert.equal((results[4] as { duplicateFileCount: number }).duplicateFileCount, 1)
    assert.equal((results[5] as { status: string }).status, 'completed')
    assert.deepEqual(starts, keys, 'All service types share FIFO order')
    assert.ok(keys.every((key) => latest(key).status === 'succeeded'))
    assert.equal(latest(`duplicates:${files}`).requestId, 'scan-request')
    assert.equal(latest('mole-preview').requestId, 'mole-request')
    assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'))
    console.log(
      'PASS: probes, duplicate scan, clone, Mole analysis/preview/apps share FIFO; frozen inputs, aliases, queued side effects'
    )
  } finally {
    blocker.release()
    unsubscribe()
    await Promise.allSettled(pending)
  }

  const cancelledHold = hold()
  const cleanBefore = await readFile(cleanList, 'utf8')
  const callsBefore = await readFile(join(root, 'mole-calls'), 'utf8')
  const cancelOperations = [
    () => inspectImage({ inputPath: png }),
    () => inspectVideo(video),
    () => inspectPdf({ inputPath: pdf }),
    () => inspectOffice(office),
    () => scanDuplicates({ directoryPath: files }),
    () => cloneDuplicates({ sourcePath: source, duplicatePaths: [target] }),
    () => analyzeMole(files),
    () => runMoleDryRun(() => {}),
    () => runMoleInstallerPreview(() => {}),
    () => runMolePurgePreview(() => {}),
    () => listMoleApps(),
    () => trashMolePaths([target])
  ]
  try {
    for (const work of cancelOperations) {
      const before = new Set(tasks.list().map((entry) => entry.id))
      const operation = work()
      const rejection = assert.rejects(operation, TaskCancelled)
      await until(() => tasks.list().some((entry) => !before.has(entry.id)))
      const entry = tasks.list().find((item) => !before.has(item.id))
      assert.ok(entry)
      assert.equal(entry.status, 'queued')
      if (entry.key?.startsWith('trash:'))
        await assert.rejects(trashFiles([target]), DuplicateTaskError)
      tasks.cancel(entry.id)
      await rejection
    }
    assert.equal(await readFile(cleanList, 'utf8'), cleanBefore)
    assert.equal(await readFile(join(root, 'mole-calls'), 'utf8'), callsBefore)
    assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'))
  } finally {
    cancelledHold.release()
    await tasks.wait(cancelledHold.id)
  }
  console.log(
    'PASS: queued cancellation for every new entry; Mole and Agent share deletion deduplication'
  )

  const incomplete = join(root, 'partial')
  await mkdir(incomplete)
  const analysis = await analyzeMole(incomplete)
  assert.equal((analysis.report as { scan_status: string }).scan_status, 'partial')
  assert.equal(latest(`mole-analyze:${incomplete}`).status, 'failed')
  assert.deepEqual(latest(`mole-analyze:${incomplete}`).result, analysis)
  const unreadable = join(files, 'unreadable')
  await mkdir(unreadable)
  await chmod(unreadable, 0)
  try {
    const report = await scanDuplicates({ directoryPath: files })
    assert.equal(report.status, 'partial')
    assert.equal(latest(`duplicates:${files}`).status, 'failed')
    assert.deepEqual(latest(`duplicates:${files}`).result, report)
  } finally {
    await chmod(unreadable, 0o700)
  }
  await writeFile(target, 'different bytes')
  const failedClone = await cloneDuplicates({ sourcePath: source, duplicatePaths: [target] })
  assert.equal(failedClone.status, 'partial')
  assert.equal(latest(cloneKey).status, 'failed')
  assert.deepEqual(latest(cloneKey).result, failedClone)
  assert.equal(await readFile(target, 'utf8'), 'different bytes')
  console.log(
    'PASS: partial Mole/duplicate reports and clone failure retain results while Task records failure'
  )

  const largeSource = join(root, 'cancel-source.bin')
  const largeTarget = join(root, 'cancel-target.bin')
  for (const path of [largeSource, largeTarget]) {
    const file = await open(path, 'wx')
    try {
      await file.truncate(256 * 1024 * 1024)
    } finally {
      await file.close()
    }
  }
  const inode = (await stat(largeTarget)).ino
  const cloneController = new AbortController()
  const cancellingClone = cloneDuplicates(
    { sourcePath: largeSource, duplicatePaths: [largeTarget, target] },
    cloneController.signal
  )
  const recovery = join(root, 'recovery/clone-deduplication')
  await until(async () => (await readdir(recovery)).length > 0)
  cloneController.abort()
  const cancelledClone = await cancellingClone
  assert.equal(cancelledClone.status, 'cancelled')
  assert.equal(cancelledClone.items[0].status, 'cancelled')
  assert.equal(cancelledClone.items[1].status, 'unprocessed')
  const cancelledEntry = tasks.list().findLast((entry) => entry.key?.startsWith('clone:'))
  assert.ok(cancelledEntry)
  assert.equal(cancelledEntry.status, 'cancelled')
  assert.deepEqual(cancelledEntry.result, cancelledClone)
  assert.equal((await stat(largeTarget)).ino, inode)
  assert.deepEqual(await readdir(recovery), [])
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('.arkive-dedupe-')))
  console.log(
    'PASS: active native clone cancellation retains per-item outcome, original inode and clean recovery journal'
  )

  assert.equal((await runMoleInstallerPreview(() => {})).candidates.length, 1)
  assert.equal((await runMolePurgePreview(() => {})).candidates.length, 1)
  for (const work of [runMoleDryRun, runMoleInstallerPreview, runMolePurgePreview]) {
    for (const timedOut of [false, true]) {
      await writeFile(join(root, 'hold-mole-descendant'), '')
      await rm(join(root, 'mole-descendant-pid'), { force: true })
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
      // Exercise the real production timeout path without waiting two minutes per preview.
      if (timedOut) AbortSignal.timeout = () => originalTimeout(500)
      const previewController = new AbortController()
      let previewSettled = false
      const preview = work(() => {}, previewController.signal)
      const previewRejected = assert
        .rejects(preview, timedOut ? /Mole .*预览失败/ : TaskCancelled)
        .finally(() => {
          previewSettled = true
        })
      let descendantPid: number | undefined
      try {
        await until(async () => {
          try {
            descendantPid = Number(await readFile(join(root, 'mole-descendant-pid'), 'utf8'))
            return true
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
            throw error
          }
        })
        if (!timedOut) previewController.abort()
        await Promise.race([previewRejected, delay(1500)])
        assert.ok(previewSettled, 'Mole cancellation/timeout must settle despite descendant pipes')
        assert.equal(latest('mole-preview').status, timedOut ? 'failed' : 'cancelled')
        // The same preview key and shared queue must be available again after cleanup.
        await rm(join(root, 'hold-mole-descendant'))
        assert.equal((await listMoleApps()).length, 1)
        assert.equal((await runMoleDryRun(() => {})).exitCode, 0)
      } finally {
        AbortSignal.timeout = originalTimeout
        if (descendantPid) killFixtureProcess(descendantPid)
        await previewRejected
        await rm(join(root, 'hold-mole-descendant'), { force: true })
      }
    }
  }
  console.log(
    'PASS: all three Mole previews release descendant pipes and queue on cancellation/timeout'
  )
  const callsBeforeAnalysis = (await readFile(join(root, 'mole-calls'), 'utf8'))
    .split('\n')
    .filter(Boolean).length
  await writeFile(join(root, 'hold-mole'), '')
  const controller = new AbortController()
  const active = analyzeMole(files, controller.signal)
  const rejected = assert.rejects(active, TaskCancelled)
  await until(() => latest(`mole-analyze:${files}`).status === 'running')
  await until(
    async () =>
      (await readFile(join(root, 'mole-calls'), 'utf8')).split('\n').filter(Boolean).length ===
      callsBeforeAnalysis + 1
  )
  controller.abort()
  await rejected
  assert.equal(latest(`mole-analyze:${files}`).status, 'cancelled')
  for (let attempt = 0; attempt < 20; attempt++) {
    const startedBefore = (await readFile(join(root, 'mole-calls'), 'utf8'))
      .split('\n')
      .filter(Boolean).length
    const stop = new AbortController()
    const pendingPreview = runMoleDryRun(() => {}, stop.signal)
    const cancelledPreview = assert.rejects(pendingPreview, TaskCancelled)
    await until(
      async () =>
        (await readFile(join(root, 'mole-calls'), 'utf8')).split('\n').filter(Boolean).length >
        startedBefore
    )
    stop.abort()
    await cancelledPreview
  }
  await rm(join(root, 'hold-mole'))
  assert.equal((await listMoleApps()).length, 1, 'Next task executes after real child cleanup')
  await assert.rejects(scanDuplicates({ directoryPath: '.' }), /绝对路径/)
  await closeCloneDeduplication()
  await tasks.close()
  console.log(
    'PASS: active Mole cancellation and 20 process-group exit races settle; next queued operation succeeds'
  )
}
