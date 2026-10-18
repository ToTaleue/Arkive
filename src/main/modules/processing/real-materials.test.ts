import assert from 'node:assert/strict'
import { access, copyFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'
import sharp from 'sharp'
import { Catalog, setCatalog } from '../catalog/service'
import { hashFile } from '../catalog/files'
import { fileTags } from '../catalog/finder-tags'
import {
  compressImageAndBackup,
  compressPdfAndBackup,
  compressVideoAndBackup
} from '../catalog/compression'
import { compressOfficeInPlace } from '../office-compression/in-place'
import { inspectVideo } from '../video-compression/service'
import { tasks } from '../../tasks/service'
import { runBundledTool } from '../../../execution/process'
import { inspectPdf } from '../pdf-compression/service'
import type { CompressionRecord } from '../../../shared/contracts/catalog'

app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  await app.whenReady()
  const root = process.env.ARKIVE_ACCEPTANCE_ROOT
  assert.ok(root)
  const cases = await mkdtemp(join(root, 'materials-'))
  console.log(`Evidence: ${cases}`)
  const catalog = new Catalog({
    databasePath: join(cases, 'catalog.db'),
    backupRoot: join(cases, 'Backup'),
    archiveRoot: join(cases, 'Archive')
  })
  setCatalog(catalog)
  await catalog.start()
  const results: unknown[] = []
  const failures: string[] = []
  const originals: { path: string; hash: string }[] = []
  let index = 0
  async function run(
    source: string,
    preset: string,
    kind: 'pdf' | 'office' | 'image' | 'video'
  ): Promise<void> {
    const directory = join(cases, String(++index).padStart(2, '0'))
    await mkdir(directory)
    const input = join(directory, basename(source))
    await copyFile(source, input)
    const hash = await hashFile(source)
    originals.push({ path: source, hash })
    const started = Date.now()
    let expectedRejection = false
    if (kind === 'pdf') {
      const preflight = await runBundledTool('qpdf', ['--check', input])
      expectedRejection = preflight.exitCode !== 0
      if (!expectedRejection) {
        const { features } = await inspectPdf({ inputPath: input })
        expectedRejection =
          features.encrypted ||
          features.hasSignatures ||
          features.hasPdfA ||
          (['balanced', 'size'].includes(preset) &&
            (features.hasAnnotations || features.hasForms || features.hasAttachments))
      }
    }
    if (kind === 'image') {
      const metadata = await sharp(input).metadata()
      expectedRejection = Boolean(metadata.gainMap)
    }
    try {
      const output = join(
        directory,
        `result${kind === 'image' ? '.webp' : kind === 'video' ? '.mp4' : extname(source)}`
      )
      const before = kind === 'video' ? await inspectVideo(input) : undefined
      const result =
        kind === 'pdf'
          ? await compressPdfAndBackup({
              inputPath: input,
              outputPath: output,
              preset: preset as 'lossless' | 'deep-lossless' | 'balanced' | 'size'
            })
          : kind === 'office'
            ? await compressOfficeInPlace({ inputPath: input, preset: 'quality' })
            : kind === 'image'
              ? await compressImageAndBackup({
                  inputPath: input,
                  outputPath: output,
                  preset: 'quality'
                })
              : await compressVideoAndBackup({
                  inputPath: input,
                  outputPath: output,
                  preset: 'balanced'
                })
      assert.equal(expectedRejection, false, 'Protected input must be rejected')
      let record: CompressionRecord | undefined = result.catalog
      if (result.status === 'compressed') {
        assert.ok(record)
        assert.equal(record.backupStatus, 'ready')
        assert.equal(await hashFile(record.backupPath ?? ''), hash)
        if ('replacementStatus' in result) assert.equal(result.replacementStatus, 'replaced')
        else await assert.rejects(access(input))
        const archived = await catalog.archive(record.id, ['联调素材'])
        assert.equal(archived.tagStatus, 'synced')
        assert.ok(archived.archivePath)
        assert.equal(await hashFile(archived.archivePath), await hashFile(result.outputPath))
        assert.ok((await fileTags(archived.archivePath)).includes('联调素材'))
        record = archived
      } else {
        assert.equal(await hashFile(input), hash)
        if ('replacementStatus' in result) assert.equal(result.replacementStatus, 'unchanged')
        if (record) assert.equal(record.backupStatus, 'skipped')
      }
      const after = kind === 'video' ? await inspectVideo(result.outputPath) : undefined
      if (before && after) {
        assert.equal(after.width, before.width)
        assert.equal(after.height, before.height)
        assert.equal(after.audioCount, before.audioCount)
        assert.ok(Math.abs(after.duration - before.duration) < 0.15)
      }
      results.push({
        source,
        input,
        hash,
        kind,
        preset,
        status: result.status,
        seconds: (Date.now() - started) / 1000,
        result,
        record,
        before,
        after
      })
      console.log(`PASS ${kind} ${preset}: ${basename(source)}: ${result.status}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      assert.equal(await hashFile(input), hash)
      const expected = expectedRejection && /qpdf|结构|不支持|HDR/.test(message)
      results.push({
        source,
        input,
        hash,
        kind,
        preset,
        status: expected ? 'expected-rejection' : 'failed',
        seconds: (Date.now() - started) / 1000,
        error: message
      })
      if (!expected) failures.push(`${kind} ${basename(source)} ${preset}: ${message}`)
      console.log(
        `${expected ? 'PASS rejection' : 'FAIL'} ${kind} ${preset}: ${basename(source)}: ${message.slice(0, 180)}`
      )
    }
    await writeFile(join(cases, 'results.json'), JSON.stringify(results, null, 2))
  }
  try {
    const publicRoot = join(root, 'public-samples')
    const originalRoot = join(root, 'original-copies')
    const publicFiles = (await readdir(publicRoot)).map((name) => join(publicRoot, name))
    const originalFiles = (await readdir(originalRoot)).map((name) => join(originalRoot, name))
    const kinds = (process.env.ARKIVE_ACCEPTANCE_KINDS ?? 'pdf,office,image,video').split(',')
    if (kinds.includes('pdf'))
      for (const source of [
        ...publicFiles.filter((p) => p.endsWith('.pdf')),
        ...originalFiles.filter((p) => /^1[68] .*\.pdf$/.test(basename(p)))
      ])
        for (const preset of ['lossless', 'deep-lossless', 'balanced', 'size'])
          await run(source, preset, 'pdf')
    if (kinds.includes('office'))
      for (const source of [...publicFiles, ...originalFiles].filter((p) =>
        /\.(docx|pptx)$/.test(p)
      ))
        await run(source, 'quality', 'office')
    if (kinds.includes('image'))
      for (const source of originalFiles.filter((p) => /^(10|14|15) /.test(basename(p))))
        await run(source, 'quality', 'image')
    if (kinds.includes('video'))
      for (const source of originalFiles.filter((p) => /^(11|12|13) /.test(basename(p))))
        await run(source, 'balanced-hevc', 'video')
    for (const original of originals) assert.equal(await hashFile(original.path), original.hash)
    await writeFile(join(cases, 'source-integrity.json'), JSON.stringify(originals, null, 2))
    assert.deepEqual(failures, [])
  } finally {
    await tasks.close()
    await catalog.close()
  }
}
void check().then(
  () => {
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
