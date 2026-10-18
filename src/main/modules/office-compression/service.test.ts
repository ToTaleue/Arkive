import assert from 'node:assert/strict'
import { app } from 'electron'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { Catalog, setCatalog } from '../catalog/service'
import { exists, hashFile } from '../catalog/files'
import { fileTags } from '../catalog/finder-tags'
import { backupOriginal } from '../original-backup/service'
import { readOfficePackage } from './package'
import { compressOffice, inspectOffice } from './service'
import { compressOfficeInPlace } from './in-place'
import { prepareOfficeReplacement } from './replacement'
import { fixture } from './fixtures.test'
import { checkOfficeVideos } from './video.test'

async function check(): Promise<void> {
  await app.whenReady()
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/office-check-')
  const options = {
    databasePath: join(directory, 'data', 'arkive.db'),
    archiveRoot: join(directory, 'Archive'),
    backupRoot: join(directory, 'Backup')
  }
  let catalog = new Catalog(options)
  setCatalog(catalog)
  await catalog.start()
  const path = (name: string): string => join(directory, name)
  const raw = Buffer.alloc(256 * 256 * 4)
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4
      raw[offset] = Math.floor(x / 16) * 16
      raw[offset + 1] = Math.floor(y / 16) * 16
      raw[offset + 2] = (x + y) % 256
      raw[offset + 3] = x < 64 ? 0 : 255
    }
  const image = (): Sharp => sharp(raw, { raw: { width: 256, height: 256, channels: 4 } })
  const png = await image().png({ compressionLevel: 0 }).toBuffer()
  const jpeg = await image().flatten({ background: '#ffffff' }).jpeg({ quality: 100 }).toBuffer()
  try {
    for (const format of ['docx', 'pptx'] as const) {
      const input = path(`sample.${format}`)
      const output = path(`sample.compressed.${format}`)
      await fixture(input, format, [png, jpeg], { thumbnail: jpeg })
      const originalHash = await hashFile(input)
      const inspection = await inspectOffice(input)
      assert.equal(inspection.format, format)
      assert.equal(inspection.embeddedImages, 2)
      const result = await compressOffice({ inputPath: input, outputPath: output })
      assert.equal(result.status, 'compressed')
      assert.ok(result.media.some((item) => item.status === 'compressed'))
      assert.ok(
        result.media.some((item) => item.part.endsWith('.gif') && item.status === 'skipped')
      )
      assert.equal(await hashFile(input), originalHash)
      const beforeDirectory = await mkdtemp(path('before-'))
      const afterDirectory = await mkdtemp(path('after-'))
      const before = await readOfficePackage(input, beforeDirectory)
      const after = await readOfficePackage(output, afterDirectory)
      assert.deepEqual(
        after.parts.map((part) => part.name),
        before.parts.map((part) => part.name)
      )
      for (const part of before.parts) {
        if (result.media.some((item) => item.part === part.name && item.status === 'compressed'))
          continue
        assert.equal(
          after.parts.find((item) => item.name === part.name)?.hash,
          part.hash,
          part.name
        )
      }
      const compressedPng = after.parts.find((part) => part.name.endsWith('/image0.png'))
      assert.ok(compressedPng)
      const pixel = await sharp(compressedPng.path).raw().toBuffer()
      assert.equal(pixel[3], 0, 'Transparent embedded PNG retains transparency')
      await assert.rejects(compressOffice({ inputPath: input, outputPath: input }), /不覆盖/)
      await assert.rejects(compressOffice({ inputPath: input, outputPath: output }), /不覆盖/)
    }
    console.log(
      'PASS: DOCX/PPTX real JPEG/PNG compression, alpha, external links untouched, XML/objects preserved, no overwrite'
    )

    const noise = Buffer.alloc(128 * 128 * 3)
    let seed = 42
    for (let index = 0; index < noise.length; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      noise[index] = seed >>> 24
    }
    const noisyPng = await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } })
      .png()
      .toBuffer()
    for (const format of ['docx', 'pptx'] as const) {
      const input = path(`below-reference.${format}`)
      await fixture(input, format, [noisyPng])
      // WeChat exports can be read-only. Tag writes must preserve this mode.
      await chmod(input, 0o444)
      const originalHash = await hashFile(input)
      const result = await compressOfficeInPlace({ inputPath: input, preset: 'quality' })
      assert.equal(result.replacementStatus, 'replaced', result.replacementError)
      assert.ok(result.outputBytes < result.originalBytes)
      const media = result.media.find((item) => item.part.endsWith('/image0.png'))
      assert.ok(media)
      assert.equal(media.status, 'compressed')
      assert.equal(media.qualityAnalysis?.meetsTarget, false)
      assert.ok(media.outputBytes < media.originalBytes)
      const after = await readOfficePackage(input, await mkdtemp(path('below-reference-after-')))
      const imagePart = after.parts.find((part) => part.name === media.part)
      assert.ok(imagePart)
      assert.notDeepEqual(await readFile(imagePart.path), noisyPng)
      assert.ok(result.catalog?.backupPath)
      assert.equal(await hashFile(result.catalog.backupPath), originalHash)
      assert.equal((await stat(input)).mode & 0o777, 0o444)
      assert.equal((await stat(result.catalog.backupPath)).mode & 0o777, 0o444)
      const archived = await catalog.archive(result.catalog.id, ['只读文档'])
      assert.equal(archived.tagStatus, 'synced', archived.tagError ?? undefined)
      assert.ok(archived.archivePath)
      assert.deepEqual(await fileTags(archived.archivePath), ['只读文档'])
      assert.equal((await stat(archived.archivePath)).mode & 0o777, 0o444)
    }
    console.log(
      'PASS: DOCX/PPTX replace below-reference images when smaller, with whole-document backups'
    )

    const empty = path('no-media.docx')
    await fixture(empty, 'docx', [])
    const emptyHash = await hashFile(empty)
    const noSavings = await compressOfficeInPlace({ inputPath: empty })
    assert.equal(noSavings.replacementStatus, 'unchanged')
    assert.equal(await hashFile(empty), emptyHash)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      compressOffice({ inputPath: empty, outputPath: path('cancelled.docx') }, controller.signal)
    )
    assert.equal(await exists(path('cancelled.docx')), false)
    for (const [name, badOptions] of [
      ['missing', { missingTarget: true }],
      ['signed', { signed: true }],
      ['duplicate', { duplicate: true }]
    ] as const) {
      const bad = path(`${name}.docx`)
      await fixture(bad, 'docx', [], badOptions)
      await assert.rejects(inspectOffice(bad))
    }
    const damaged = path('crc-damaged.docx')
    await copyFile(empty, damaged)
    const bytes = await readFile(damaged)
    const offset = bytes.indexOf(Buffer.from('Arkive 中文内容'))
    assert.ok(offset >= 0)
    bytes[offset] = 0x42
    await writeFile(damaged, bytes)
    await assert.rejects(inspectOffice(damaged), /校验失败/)
    console.log(
      'PASS: no-savings/cancellation preserve source; broken relationships, signatures, duplicates and CRC damage rejected'
    )

    const inPlace = path('replace.docx')
    await fixture(inPlace, 'docx', [png, jpeg])
    await fileTags(inPlace, ['Office 测试'])
    const originalHash = await hashFile(inPlace)
    const replacement = await compressOfficeInPlace({ inputPath: inPlace })
    assert.equal(replacement.replacementStatus, 'replaced', replacement.replacementError)
    assert.equal(replacement.outputPath, inPlace)
    assert.ok(replacement.catalog?.backupPath)
    assert.equal(await hashFile(replacement.catalog.backupPath), originalHash)
    assert.notEqual(await hashFile(inPlace), originalHash)
    assert.deepEqual(await fileTags(inPlace), ['Office 测试'])
    assert.equal(catalog.get(replacement.catalog.id).outputPath, inPlace)
    const archived = await catalog.archive(replacement.catalog.id, ['Office 测试'])
    assert.ok(archived.archivePath)
    assert.equal(await hashFile(archived.archivePath), await hashFile(inPlace))
    console.log(
      'PASS: whole-document backup, original-path publication, Finder tags, final-path index and archive'
    )

    async function pending(
      name: string
    ): Promise<{ id: string; input: string; output: string; hash: string }> {
      const input = path(`${name}.pptx`)
      await fixture(input, 'pptx', [png, jpeg])
      const staging = await mkdtemp(path('.arkive-office-replace-'))
      const output = join(staging, basename(input))
      const id = await catalog.beginCompression(input, output)
      const hash = await hashFile(input)
      const encoded = await compressOffice({ inputPath: input, outputPath: output })
      assert.equal(encoded.status, 'compressed')
      catalog.repo.update(id, {
        output_hash: await hashFile(output),
        output_bytes: encoded.outputBytes,
        compression_status: 'ready'
      })
      prepareOfficeReplacement(catalog.repo, id)
      return { id, input, output, hash }
    }
    const beforeBackup = await pending('restart-before-backup')
    const afterBackup = await pending('restart-after-backup')
    await backupOriginal(catalog.repo, afterBackup.id, options.backupRoot)
    assert.equal(await exists(afterBackup.input), false)
    const afterPublication = await pending('restart-after-publication')
    await backupOriginal(catalog.repo, afterPublication.id, options.backupRoot)
    await link(afterPublication.output, afterPublication.input)
    const rollback = await pending('restore-missing-original')
    await backupOriginal(catalog.repo, rollback.id, options.backupRoot)
    await writeFile(rollback.output, 'damaged candidate')
    const conflict = await pending('external-edit')
    await writeFile(conflict.input, 'external edit must survive')
    await catalog.close()
    catalog = new Catalog(options)
    setCatalog(catalog)
    await catalog.start()
    for (const item of [beforeBackup, afterBackup, afterPublication]) {
      assert.equal(catalog.get(item.id).outputPath, item.input)
      assert.notEqual(await hashFile(item.input), item.hash)
      assert.equal(await exists(item.output), false)
      const record = catalog.get(item.id)
      assert.ok(record.backupPath)
      assert.equal(await hashFile(record.backupPath), item.hash)
    }
    assert.equal(await hashFile(rollback.input), rollback.hash)
    assert.equal(catalog.repo.get(rollback.id).compression_status, 'failed')
    assert.equal(await readFile(conflict.input, 'utf8'), 'external edit must survive')
    assert.equal(catalog.repo.get(conflict.id).compression_status, 'failed')
    assert.ok(
      !(await readdir(directory)).some(
        (name) => name.startsWith('.arkive-office-') && !name.startsWith('.arkive-office-replace-')
      )
    )
    console.log(
      'PASS: restart before/after backup/publication, restore missing source, preserve external edit, isolate failed plans'
    )
    await checkOfficeVideos(directory)

    // Reconstruct v2 before testing the upgrade with existing catalog records.
    catalog.repo.db.exec(`DROP TABLE office_replacements;
      ALTER TABLE catalog_items DROP COLUMN original_link_path;
      ALTER TABLE catalog_items DROP COLUMN original_link_status;
      ALTER TABLE catalog_items DROP COLUMN original_link_error;
      PRAGMA user_version = 2;`)
    await catalog.close()
    catalog = new Catalog(options)
    setCatalog(catalog)
    await catalog.start()
    assert.equal(catalog.repo.db.prepare('PRAGMA user_version').get()?.user_version, 4)
    assert.equal(catalog.get(replacement.catalog.id).outputPath, inPlace)
    assert.ok(catalog.get(replacement.catalog.id).archivePath)
    console.log('PASS: v2 database upgrade preserves existing compression/archive records')

    // Optional real Office-generated sample for native open/display acceptance.
    const sample = process.env.ARKIVE_OFFICE_SAMPLE
    if (sample) {
      const input = path('native.replaced.pptx')
      await copyFile(sample, input)
      const sampleHash = await hashFile(sample)
      const result = await compressOfficeInPlace({ inputPath: input })
      assert.equal(result.replacementStatus, 'replaced', result.replacementError)
      assert.equal(result.outputPath, input)
      assert.ok(result.catalog?.backupPath)
      assert.equal(await hashFile(result.catalog.backupPath), sampleHash)
      assert.equal(await hashFile(sample), sampleHash)
      console.log(`PASS: copied external PPTX sample replaced with whole-document backup: ${input}`)
      console.log(
        JSON.stringify({
          originalBytes: result.originalBytes,
          outputBytes: result.outputBytes,
          media: result.media
        })
      )
    }
    console.log(`Office fixtures retained: ${directory}`)
  } finally {
    await catalog.close()
  }
}

void check()
  .then(() => {
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
