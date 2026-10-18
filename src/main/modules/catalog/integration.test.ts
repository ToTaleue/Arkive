import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  lstat,
  link,
  copyFile,
  rename,
  utimes
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { Catalog, setCatalog } from './service'
import { fileTags } from './finder-tags'
import { exists, hashFile, destination, dayKey, managedDirectory, copyVerified } from './files'
import { compressImageAndBackup } from './compression'
import { registerCatalogIpc } from './ipc'

async function check(): Promise<void> {
  await app.whenReady()
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/catalog-check-')
  const options = {
    databasePath: join(directory, 'data', 'arkive.db'),
    archiveRoot: join(directory, 'Archive'),
    backupRoot: join(directory, 'Backup')
  }
  let catalog = new Catalog(options)
  setCatalog(catalog)
  await catalog.start()
  let window: BrowserWindow | undefined
  const original = Buffer.alloc(4096, 'original')
  async function prepare(name: string): Promise<{ id: string; source: string; output: string }> {
    const source = join(directory, `${name}.txt`)
    const output = join(directory, `${name}-compressed.txt`)
    await writeFile(source, original)
    await utimes(source, new Date('2024-03-12T10:00:00Z'), new Date('2024-03-12T10:00:00Z'))
    await fileTags(source, ['已有标签', '引号"与空格 $(literal)'])
    const id = await catalog.beginCompression(source, output)
    await writeFile(output, 'validated smaller result')
    return { id, source, output }
  }
  try {
    const first = await prepare('演唱会 一')
    const sourceHash = await hashFile(first.source)
    const metadataCopy = destination(directory, `${'长'.repeat(80)}.txt`, first.id)
    await copyVerified(first.source, metadataCopy, sourceHash, true)
    assert.equal(await hashFile(metadataCopy), sourceHash)
    assert.deepEqual(await fileTags(metadataCopy), await fileTags(first.source))
    assert.ok(Buffer.byteLength(metadataCopy.split('/').at(-1) ?? '') < 255)
    const record = await catalog.finishCompression(first.id, true)
    assert.equal(record.backupStatus, 'ready')
    assert.ok(record.backupPath)
    assert.equal(await exists(first.source), false)
    assert.equal(await hashFile(record.backupPath), sourceHash)
    assert.deepEqual(
      await fileTags(record.backupPath),
      ['已有标签', '引号"与空格 $(literal)'].sort()
    )
    assert.equal(await exists(first.output), true)
    const archived = await catalog.archive(first.id, ['旅行', '素材'])
    assert.ok(archived.archivePath)
    assert.deepEqual(await readFile(archived.archivePath), await readFile(first.output))
    assert.equal(archived.sourceModifiedAt, new Date('2024-03-12T10:00:00Z').getTime())
    assert.deepEqual((await catalog.archive(first.id, [])).archivePath, archived.archivePath)
    assert.equal(catalog.query({ tags: ['旅行', '素材'] }).total, 1)
    assert.equal(catalog.query({ name: '演唱会 一' }).total, 1)
    assert.equal(catalog.query({ name: '旅行' }).total, 1, 'Search also matches tags')
    assert.equal(catalog.query({ kind: 'document' }).total, 1)
    assert.equal(catalog.query({ kind: 'image' }).total, 0)
    const backupView = catalog.query({ state: 'backup' })
    assert.equal(backupView.total, 1, 'Archived records retain their original backups')
    assert.equal(backupView.items[0].sourceBytes, original.length)
    assert.ok(backupView.items[0].backedUpAt)
    assert.equal(await catalog.filePath(first.id, 'backup'), record.backupPath)
    assert.equal(await hashFile(await catalog.filePath(first.id, 'backup')), sourceHash)
    assert.equal(catalog.query({ state: 'backup', archivedFrom: Date.now() + 60_000 }).total, 0)

    assert.equal(
      catalog.query({ name: 'catalog-check-' }).total,
      0,
      'Search matches filenames, not directory names'
    )
    assert.equal(
      catalog.query({
        modifiedFrom: Date.parse('2024-03-12'),
        modifiedTo: Date.parse('2024-03-13')
      }).total,
      1
    )
    assert.equal(catalog.query({ modifiedFrom: Date.parse('2025-01-01') }).total, 0)
    console.log(
      'PASS: real SQLite, backup movement and metadata, copy archive, idempotency, names/dates/AND search'
    )

    await fileTags(archived.archivePath, ['Finder 新标签'])
    await catalog.refresh()
    assert.deepEqual(catalog.get(first.id).tags, ['Finder 新标签'])
    assert.equal(catalog.query({ tags: ['旅行'] }).total, 0, 'Finder deletion is not resurrected')
    await catalog.editTags([first.id], ['人工'], ['Finder 新标签'])
    assert.deepEqual(await fileTags(archived.archivePath), ['人工'])
    assert.deepEqual(
      await fileTags(record.backupPath),
      ['已有标签', '引号"与空格 $(literal)'].sort(),
      'Archive edits do not modify backups'
    )
    const away = `${archived.archivePath}.away`
    await rename(archived.archivePath, away)
    await catalog.editTags([first.id], ['重试标签'], [])
    assert.equal(catalog.get(first.id).tagStatus, 'error')
    await rename(away, archived.archivePath)
    await catalog.refresh()
    assert.ok((await fileTags(archived.archivePath)).includes('重试标签'))
    const second = await prepare('未减小')
    await catalog.finishCompression(second.id, false)
    assert.equal(catalog.get(second.id).backupStatus, 'skipped')
    assert.equal(await exists(second.source), true)
    await rename(second.source, `${second.source}.away`)
    const pendingInheritance = await catalog.archive(second.id, ['旅行'])
    assert.ok(pendingInheritance.archivePath, 'Tag failure does not discard a completed archive')
    assert.equal(pendingInheritance.tagStatus, 'error')
    await rename(`${second.source}.away`, second.source)
    await catalog.refresh()
    assert.equal(catalog.get(second.id).tagStatus, 'synced')
    assert.ok(catalog.get(second.id).tags.includes('已有标签'))
    await catalog.editTags([first.id, second.id], ['公共'], [])
    assert.equal(catalog.query({ tags: ['公共'] }).total, 2)
    assert.equal(catalog.query({ tags: ['公共', '旅行'] }).total, 1)
    console.log(
      'PASS: real Finder tag add/delete, isolated backup tags, pending retry, batch AND filtering'
    )

    const changed = await prepare('被修改原件')
    await writeFile(changed.source, Buffer.alloc(4096, 'changed'))
    const failed = await catalog.finishCompression(changed.id, true)
    assert.equal(failed.backupStatus, 'error')
    assert.equal(await exists(changed.source), true)
    await assert.rejects(catalog.archive(changed.id, []), /备份/)
    console.log('PASS: changed original is preserved; incomplete backup blocks archive')

    const interrupted = await prepare('中断备份')
    const backupDirectory = await managedDirectory(options.backupRoot, dayKey())
    const plannedBackup = destination(backupDirectory, '中断备份.txt', interrupted.id)
    catalog.repo.update(interrupted.id, {
      compression_status: 'ready',
      output_hash: await hashFile(interrupted.output),
      output_bytes: (await lstat(interrupted.output)).size,
      backup_path: plannedBackup
    })
    await link(interrupted.source, plannedBackup)
    await catalog.close()
    catalog = new Catalog(options)
    setCatalog(catalog)
    await catalog.start()
    assert.equal(await exists(interrupted.source), false)
    assert.equal(catalog.get(interrupted.id).backupStatus, 'ready')
    assert.equal(await hashFile(plannedBackup), sourceHash)
    await fileTags(archived.archivePath, ['关闭期间修改'])
    await catalog.close()
    catalog = new Catalog(options)
    setCatalog(catalog)
    await catalog.start()
    assert.deepEqual(catalog.get(first.id).tags, ['关闭期间修改'])
    assert.equal(catalog.query({}).total, 2)
    const archiveDirectory = await managedDirectory(options.archiveRoot, dayKey())
    const plannedArchive = destination(archiveDirectory, '中断归档.txt', interrupted.id)
    catalog.repo.update(interrupted.id, { archive_status: 'copying', archive_path: plannedArchive })
    await copyFile(interrupted.output, plannedArchive)
    await catalog.close()
    catalog = new Catalog(options)
    setCatalog(catalog)
    await catalog.start()
    assert.equal(catalog.get(interrupted.id).archivePath, plannedArchive)
    assert.equal(catalog.query({}).total, 3)
    console.log(
      'PASS: restart persistence, interrupted backup/archive recovery, offline Finder modifications'
    )

    const image = join(directory, '真实图片.png')
    const imageOutput = join(directory, '真实图片.webp')
    const pixels = Buffer.alloc(256 * 256 * 3)
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 200)) % 256
    await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toFile(image)
    const imageHash = await hashFile(image)
    const result = await compressImageAndBackup({
      inputPath: image,
      outputPath: imageOutput,
      archive: true,
      tags: ['真实压缩']
    })
    assert.equal(result.status, 'compressed')
    assert.ok(result.catalog.backupPath)
    assert.equal(await hashFile(result.catalog.backupPath), imageHash)
    assert.equal(await exists(image), false)
    assert.equal(result.archive?.status, 'ready')
    assert.ok(catalog.get(result.catalog.id).archivePath)
    assert.ok(catalog.get(result.catalog.id).tags.includes('真实压缩'))
    const cancelledSource = join(directory, '取消.png')
    await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } })
      .png()
      .toFile(cancelledSource)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      compressImageAndBackup(
        { inputPath: cancelledSource, outputPath: join(directory, '取消.webp') },
        controller.signal
      ),
      { name: 'AbortError' }
    )
    assert.equal(await exists(cancelledSource), true)
    console.log(
      'PASS: real Sharp + quality analysis → shared backup lifecycle → archive; cancellation preserves source'
    )

    const attach = registerCatalogIpc(catalog)
    window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 760,
      webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
    })
    attach(window.webContents)
    await window.loadFile(resolve('out/renderer/index.html'))
    const contents = window.webContents
    await contents.executeJavaScript(
      'document.querySelector("button[aria-label=我的归档]").click()'
    )
    const deadline = Date.now() + 10_000
    while (
      !(await contents.executeJavaScript('document.querySelectorAll(".archive-row").length === 4'))
    ) {
      assert.ok(Date.now() < deadline, 'Archive renderer did not load real query results')
      await delay(50)
    }
    await assert.rejects(contents.executeJavaScript('window.api.catalog.archive("invalid",[])'))
    await assert.rejects(contents.executeJavaScript('window.api.catalog.query({tags:[42]})'))
    assert.equal(
      await contents.executeJavaScript('document.querySelector("#archive-page").hidden'),
      false
    )
    await contents.executeJavaScript(`document.querySelector('[title="日间模式"]').click()`)
    assert.equal(
      await contents.executeJavaScript(
        'getComputedStyle(document.documentElement).getPropertyValue("--surface").trim()'
      ),
      '#ffffff'
    )
    assert.equal(
      await contents.executeJavaScript('document.querySelector("#archive-tag-filters").hidden'),
      true
    )
    await contents.executeJavaScript(
      'document.querySelector("[aria-controls=archive-tag-filters]").click()'
    )
    assert.equal(
      await contents.executeJavaScript('document.querySelector("#archive-tag-filters").hidden'),
      false
    )
    const expandedHeight = Number(
      await contents.executeJavaScript(
        'document.querySelector(".archive-discovery").getBoundingClientRect().height'
      )
    )
    await contents.executeJavaScript('document.querySelector(".archive-density-toggle").click()')
    assert.ok(
      (await contents.executeJavaScript(
        'document.querySelector(".archive-discovery").getBoundingClientRect().height'
      )) < expandedHeight
    )
    assert.ok(
      await contents.executeJavaScript(
        'document.querySelector(".archive-search input").getClientRects().length > 0'
      )
    )
    await contents.executeJavaScript(
      'document.querySelector("[aria-controls=archive-tag-filters]").click()'
    )
    await delay(100)
    await writeFile(join(directory, 'archive-preview.png'), (await contents.capturePage()).toPNG())
    await contents.executeJavaScript(`document.querySelector('.archive-file-button').click()`)
    assert.equal(
      await contents.executeJavaScript('document.querySelector(".archive-detail-dialog").open'),
      true
    )
    await contents.executeJavaScript(
      `document.querySelector('[aria-label="关闭文件详情"]').click()`
    )
    await contents.executeJavaScript(`document.querySelector('[title="夜间模式"]').click()`)
    assert.equal(
      await contents.executeJavaScript(
        'getComputedStyle(document.documentElement).getPropertyValue("--surface").trim()'
      ),
      '#1b2023'
    )
    await delay(100)
    await writeFile(join(directory, 'archive-night.png'), (await contents.capturePage()).toPNG())
    await contents.executeJavaScript(
      `[...document.querySelectorAll('.archive-segments button')].find(b => b.textContent === '备份').click()`
    )
    const backupDeadline = Date.now() + 10_000
    while (
      !(await contents.executeJavaScript(
        'document.querySelector(".archive-list-head").textContent.includes("原件备份") && document.querySelectorAll(".archive-row").length > 0'
      ))
    ) {
      assert.ok(Date.now() < backupDeadline, 'Backup view did not load')
      await delay(50)
    }
    await assert.rejects(
      contents.executeJavaScript(`window.api.catalog.open(${JSON.stringify(first.id)}, 'invalid')`),
      /无效的文件位置/
    )
    await contents.executeJavaScript(`document.querySelector('[title="日间模式"]').click()`)
    window.setSize(800, 700)
    await delay(100)
    assert.ok(
      await contents.executeJavaScript(
        'document.querySelector(".archive-table-scroll").scrollWidth > 0'
      )
    )
    await writeFile(join(directory, 'archive-narrow.png'), (await contents.capturePage()).toPNG())
    await contents.executeJavaScript(
      `[...document.querySelectorAll('.archive-segments button')].find(b => b.textContent === '已归档').click()`
    )
    await contents.executeJavaScript(
      `const typeFilter = document.querySelector('[aria-label="文件类型"]'); typeFilter.value = 'image'; typeFilter.dispatchEvent(new Event('change', { bubbles: true }))`
    )
    const typeDeadline = Date.now() + 10_000
    while (
      !(await contents.executeJavaScript(
        'document.querySelectorAll(".archive-row").length === 1 && document.querySelector(".archive-file-button").textContent.includes("真实图片")'
      ))
    ) {
      assert.ok(Date.now() < typeDeadline, 'File type filter did not return the real image')
      await delay(50)
    }
    console.log('PASS: file type query and narrow archive window')
    console.log(
      'PASS: day/night themes, collapsible overview and tags, real file detail and original backup view'
    )

    console.log(
      'PASS: actual Electron main → preload → renderer archive list, navigation and invalid IPC rejection'
    )
    console.log(`Artifacts: ${directory}`)
  } finally {
    window?.destroy()
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
