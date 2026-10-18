import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readlink,
  lstat,
  unlink,
  symlink,
  rename
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Catalog } from './service'
import { fileTags } from './finder-tags'
import { archivePath } from './operations'
import { exists, hashFile } from './files'
import { registerCatalogIpc } from './ipc'
import { createOriginalLink } from './original-link'

async function check(): Promise<void> {
  await app.whenReady()
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/archive-links-')
  const options = {
    databasePath: join(directory, 'arkive.db'),
    archiveRoot: join(directory, 'Archive'),
    backupRoot: join(directory, 'Backup')
  }
  let catalog = new Catalog(options)
  let window: BrowserWindow | undefined
  const enabled = { keepLinkAtOriginalLocation: true }
  const outputContent = 'verified smaller result'
  async function prepare(
    name: string,
    extension = '.txt',
    outputExtension = extension
  ): Promise<{ id: string; source: string; output: string }> {
    const source = join(directory, `${name}${extension}`)
    const output = join(directory, `${name}-output${outputExtension}`)
    await writeFile(source, Buffer.alloc(4096, 'original'))
    const id = await catalog.beginCompression(source, output)
    await writeFile(output, outputContent)
    await catalog.finishCompression(id, true)
    return { id, source, output }
  }
  try {
    await catalog.start()
    const textPath = join(directory, '混合资料.txt')
    await writeFile(textPath, 'TXT 不压缩也要一起归档。')
    await fileTags(textPath, ['原标签'])
    const textHash = await hashFile(textPath)
    const textItem = await archivePath(
      catalog,
      textPath,
      ['微信练习', '混合素材'],
      new AbortController().signal,
      { moveToArchive: true }
    )
    assert.ok(textItem.archivePath)
    assert.equal(textItem.outputBytes, textItem.sourceBytes)
    assert.equal(textItem.backupStatus, 'skipped')
    assert.equal(textItem.originalLink?.status, 'ready')
    assert.equal(await readlink(textPath), textItem.archivePath)
    assert.equal(await hashFile(textItem.archivePath), textHash)
    assert.deepEqual(
      await fileTags(textItem.archivePath),
      ['原标签', '微信练习', '混合素材'].sort()
    )
    assert.equal(catalog.query({ tags: ['混合素材'] }).items[0]?.id, textItem.id)
    const directAgain = await archivePath(
      catalog,
      textPath,
      ['混合素材'],
      new AbortController().signal,
      { moveToArchive: true }
    )
    assert.equal(directAgain.id, textItem.id)
    assert.equal(catalog.query({ tags: ['混合素材'] }).total, 1)

    const unchangedPath = join(directory, '无收益文档.docx')
    await writeFile(
      unchangedPath,
      'ordinary opaque fixture; direct archiving does not parse content'
    )
    const unchangedId = await catalog.prepareFileArchive(unchangedPath)
    const copied = await catalog.archive(unchangedId, ['混合素材'])
    assert.equal(copied.originalLink, undefined)
    assert.equal((await lstat(unchangedPath)).isFile(), true)
    // Moving a changed source must retain the new content even though Archive is ready.
    await writeFile(unchangedPath, 'new user content')
    const changed = await catalog.archive(unchangedId, [], { moveToArchive: true })
    assert.equal(changed.originalLink?.status, 'error')
    assert.equal(await readFile(unchangedPath, 'utf8'), 'new user content')
    console.log(
      'PASS: Pi direct TXT archive, Finder/index tags, source links, idempotent retry, copy-only and changed-source protection'
    )
    const off = await prepare('默认关闭')
    assert.equal((await catalog.archive(off.id, [])).originalLink, undefined)
    assert.equal(await exists(off.source), false)

    const on = await prepare('中文 空格 $(literal)')
    const item = await catalog.archive(on.id, [], enabled)
    assert.ok(item.archivePath)
    assert.equal(item.originalLink?.status, 'ready')
    assert.equal(await readlink(on.source), item.archivePath)
    assert.equal(await readFile(on.source, 'utf8'), outputContent)
    assert.ok(item.backupPath)
    assert.equal((await readFile(item.backupPath)).length, 4096)
    const linkInode = (await lstat(on.source)).ino
    const again = await catalog.archive(on.id, [], enabled)
    assert.equal(again.archivePath, item.archivePath)
    assert.equal((await lstat(on.source)).ino, linkInode)
    // Removing the old backup must not break access to the formal archive.
    await unlink(item.backupPath)
    assert.equal(await readFile(on.source, 'utf8'), outputContent)
    assert.equal(await readFile(on.output, 'utf8'), outputContent)

    const conflict = await prepare('冲突')
    await writeFile(conflict.source, 'a new user file')
    const failed = await catalog.archive(conflict.id, [], enabled)
    assert.ok(failed.archivePath)
    assert.equal(failed.originalLink?.status, 'error')
    assert.match(failed.originalLink.error ?? '', /占用/)
    assert.equal(await readFile(conflict.source, 'utf8'), 'a new user file')
    await unlink(conflict.source)
    await symlink(join(directory, '不存在'), conflict.source)
    assert.equal((await catalog.archive(conflict.id, [], enabled)).originalLink?.status, 'error')
    assert.equal(await readlink(conflict.source), join(directory, '不存在'))
    await unlink(conflict.source)
    assert.equal((await catalog.archive(conflict.id, [], enabled)).originalLink?.status, 'ready')
    assert.equal(await readlink(conflict.source), failed.archivePath)

    const converted = await prepare('转换', '.png', '.webp')
    const convertedItem = await catalog.archive(converted.id, [], enabled)
    assert.equal(convertedItem.originalLink?.path, join(directory, '转换.webp'))
    assert.equal(await exists(converted.source), false)
    assert.equal(await readFile(join(directory, '转换.webp'), 'utf8'), outputContent)
    // An Office result still at its original path can be moved after Archive verifies it.
    const office = await prepare('已发布文档', '.pptx')
    await writeFile(office.source, outputContent)
    const officeItem = await catalog.archive(office.id, ['混合素材'], { moveToArchive: true })
    assert.equal(officeItem.originalLink?.status, 'ready')
    assert.equal(await readlink(office.source), officeItem.archivePath)
    assert.equal(await readFile(office.source, 'utf8'), outputContent)
    assert.ok(officeItem.backupPath)
    assert.equal((await readFile(officeItem.backupPath)).length, 4096)
    await assert.rejects(
      createOriginalLink('/System/arkive-test-link', item.archivePath),
      /系统关键路径/
    )
    console.log(
      'PASS: default off; real links to Archive; backup deletion; no overwrite, dangling-link conflict, retry, extension conversion and system-path protection'
    )

    const pending = await prepare('中断后创建')
    const pendingArchive = await catalog.archive(pending.id, [])
    catalog.repo.update(pending.id, {
      original_link_path: pending.source,
      original_link_status: 'pending'
    })
    // Also simulate a crash after symlink creation but before recording ready.
    catalog.repo.update(on.id, { original_link_status: 'pending' })
    const restartSource = join(directory, '搬移恢复.txt')
    await writeFile(restartSource, 'restart-safe complete content')
    const restartId = await catalog.prepareFileArchive(restartSource)
    await catalog.archive(restartId, ['混合素材'])
    catalog.repo.update(restartId, {
      original_link_path: restartSource,
      original_link_status: 'pending',
      original_link_replace: 1
    })
    await catalog.close()
    catalog = new Catalog(options)
    await catalog.start()
    assert.equal(await readlink(pending.source), pendingArchive.archivePath)
    assert.equal(catalog.get(pending.id).originalLink?.status, 'ready')
    assert.equal(catalog.get(on.id).originalLink?.status, 'ready')
    assert.equal((await lstat(on.source)).ino, linkInode)
    assert.equal(catalog.get(off.id).originalLink, undefined)
    assert.equal(catalog.get(restartId).originalLink?.status, 'ready')
    assert.equal(await readFile(restartSource, 'utf8'), 'restart-safe complete content')
    console.log(
      'PASS: restart recovers intent, recognizes an already-created link and preserves opt-out'
    )

    // Reconstruct a v3 schema to exercise migration with existing records.
    const preservedArchive = catalog.get(on.id).archivePath
    catalog.repo.db.exec(`ALTER TABLE catalog_items DROP COLUMN original_link_path;
      ALTER TABLE catalog_items DROP COLUMN original_link_status;
      ALTER TABLE catalog_items DROP COLUMN original_link_error;
      ALTER TABLE catalog_items DROP COLUMN original_link_replace;
      PRAGMA user_version = 3;`)
    await catalog.close()
    catalog = new Catalog(options)
    await catalog.start()
    assert.equal(catalog.repo.db.prepare('PRAGMA user_version').get()?.user_version, 5)
    assert.equal(catalog.get(on.id).archivePath, preservedArchive)
    assert.equal(catalog.get(on.id).originalLink, undefined)
    console.log('PASS: v3 → v5 migration preserves existing archives and defaults switches off')

    const build = process.env.ARKIVE_LINK_CHECK_BUILD
    assert.ok(build)
    const ui = await prepare('界面开关')
    const attach = registerCatalogIpc(catalog)
    window = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        preload: join(build, 'preload.cjs'),
        sandbox: false
      }
    })
    attach(window.webContents)
    const contents = window.webContents
    const waitFor = async (expression: string): Promise<void> => {
      const deadline = Date.now() + 15_000
      while (!(await contents.executeJavaScript(expression))) {
        assert.ok(Date.now() < deadline, `UI timeout: ${expression}`)
        await delay(50)
      }
    }
    await window.loadFile(join(build, 'renderer/index.html'), { query: { id: ui.id } })
    await waitFor('Boolean(document.querySelector(".archive-link-option input:not(:disabled)"))')
    assert.equal(
      await contents.executeJavaScript(
        'document.querySelector(".archive-link-option input").checked'
      ),
      false
    )
    await writeFile(join(directory, 'switch.png'), (await contents.capturePage()).toPNG())
    await assert.rejects(
      contents.executeJavaScript(
        `window.api.catalog.archive(${JSON.stringify(ui.id)}, [], {keepLinkAtOriginalLocation: "true"})`
      ),
      /布尔值/
    )
    assert.equal(catalog.get(ui.id).archivePath, null)
    await contents.executeJavaScript('document.querySelector(".archive-link-option input").click()')
    await contents.executeJavaScript('document.querySelector(".archive-primary").click()')
    await waitFor('document.body.textContent.includes("原位置访问入口已创建")')
    assert.equal(await readlink(ui.source), catalog.get(ui.id).archivePath)
    assert.equal(await readFile(ui.source, 'utf8'), outputContent)
    await writeFile(join(directory, 'success.png'), (await contents.capturePage()).toPNG())

    const uiConflict = await prepare('界面冲突')
    await writeFile(uiConflict.source, 'keep this file')
    await window.loadFile(join(build, 'renderer/index.html'), { query: { id: uiConflict.id } })
    await waitFor('Boolean(document.querySelector(".archive-link-option input:not(:disabled)"))')
    await contents.executeJavaScript('document.querySelector(".archive-link-option input").click()')
    await contents.executeJavaScript('document.querySelector(".archive-primary").click()')
    await waitFor('document.body.textContent.includes("重试原位置入口")')
    assert.ok(catalog.get(uiConflict.id).archivePath)
    assert.equal(await readFile(uiConflict.source, 'utf8'), 'keep this file')
    await writeFile(join(directory, 'conflict.png'), (await contents.capturePage()).toPNG())
    await rename(uiConflict.source, `${uiConflict.source}.preserved`)
    // Recovery remains accessible from the archive list after leaving the result view.
    await window.loadFile(join(build, 'renderer/index.html'), { query: { view: 'archive' } })
    await waitFor('document.querySelectorAll(".archive-file-button").length > 0')
    await contents.executeJavaScript(
      '[...document.querySelectorAll(".archive-file-button")].find(button => button.textContent.includes("界面冲突")).click()'
    )
    await waitFor('document.body.textContent.includes("重试原位置入口")')
    await contents.executeJavaScript(
      '[...document.querySelectorAll("button")].find(button => button.textContent === "重试原位置入口").click()'
    )
    await waitFor('!document.body.textContent.includes("重试原位置入口")')
    assert.equal(await readFile(uiConflict.source, 'utf8'), outputContent)
    assert.equal(await readFile(`${uiConflict.source}.preserved`, 'utf8'), 'keep this file')
    const uiArchive = catalog.get(uiConflict.id).archivePath
    assert.ok(uiArchive)
    assert.equal(await hashFile(uiConflict.output), await hashFile(uiArchive))
    console.log(
      'PASS: real React switch → preload → IPC → scheduled Catalog → filesystem; invalid option, conflict display and retry'
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
