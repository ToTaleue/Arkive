import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Catalog } from './service'
import { registerCatalogIpc } from './ipc'
import { cleanupBackup } from '../original-backup/cleanup'
import { exists, fileInfo, hashFile } from './files'
import { fileTags } from './finder-tags'

app.on('window-all-closed', () => {
  /* Keep the isolated runner alive through restart checks. */
})

async function check(): Promise<void> {
  await app.whenReady()
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/backup-cleanup-')
  const options = {
    databasePath: join(directory, 'arkive.db'),
    backupRoot: join(directory, 'Backup'),
    archiveRoot: join(directory, 'Archive')
  }
  let catalog = new Catalog(options)
  await catalog.start()
  let window: BrowserWindow | undefined
  const showMessageBox = dialog.showMessageBox.bind(dialog)
  const now = Date.now()
  const day = 86_400_000
  async function fixture(
    name: string,
    age: number
  ): Promise<{ id: string; backup: string; output: string }> {
    const id = randomUUID()
    const backup = join(options.backupRoot, `${name}-${id}.txt`)
    const output = join(directory, `${name}-${id}.output.txt`)
    await writeFile(backup, `full original ${id}`)
    await writeFile(output, `result ${id}`)
    const info = await fileInfo(backup)
    catalog.repo.insert({
      id,
      original_path: join(directory, `${name}.txt`),
      output_path: output,
      source_size: info.size,
      source_modified_at: now - 100 * day,
      source_dev: String(info.dev),
      source_ino: String(info.ino),
      source_hash: await hashFile(backup)
    })
    catalog.repo.update(id, {
      compression_status: 'ready',
      backup_status: 'ready',
      backup_path: backup,
      backed_up_at: now - age * day,
      output_hash: await hashFile(output),
      output_bytes: (await fileInfo(output)).size,
      inherit_tags_pending: 0
    })
    return { id, backup, output }
  }
  async function preserved(id: string): Promise<void> {
    assert.equal(catalog.get(id).backupStatus, 'ready')
    const path = catalog.get(id).backupPath
    assert.ok(path)
    assert.ok(await exists(path))
  }
  try {
    const old = await fixture('seven-day-boundary', 7)
    const middle = await fixture('three-day-boundary', 3)
    const fresh = await fixture('fresh', 0)
    assert.deepEqual(
      catalog.repo.backupCleanupCandidates(7, now).map((row) => row.id),
      [old.id]
    )
    assert.equal(catalog.repo.backupCleanupCandidates(3, now).length, 2)
    assert.equal(catalog.repo.backupCleanupCandidates(0, now).length, 3)
    assert.throws(() => catalog.prepareBackupCleanup(2), /范围/)
    // No page limit: every matching record belongs to the confirmation snapshot.
    for (let i = 0; i < 51; i++) await fixture(`pagination-${String(i)}`, 0)
    assert.equal(catalog.query({ state: 'backup' }).items.length, 50)
    assert.equal(catalog.prepareBackupCleanup(0).ids.length, 54)

    const invalid = await fixture('changed-output', 9)
    await writeFile(invalid.output, 'external edit')
    const changed = await fixture('changed-backup', 9)
    await writeFile(changed.backup, 'external replacement')
    const office = await fixture('unpublished-office', 9)
    catalog.repo.db
      .prepare(
        `INSERT INTO office_replacements (item_id,candidate_path,original_path,state) VALUES (?,?,?,'prepared')`
      )
      .run(office.id, office.output, join(directory, 'office.docx'))
    const escaped = await fixture('outside-backup', 9)
    const external = join(directory, 'outside.txt')
    await rename(escaped.backup, external)
    catalog.repo.update(escaped.id, { backup_path: external })
    const linked = await fixture('symlink-backup', 9)
    await rename(linked.backup, `${linked.backup}.original`)
    await symlink(external, linked.backup)
    const untouched = join(options.backupRoot, 'unknown-user-file.txt')
    await writeFile(untouched, 'not a registered backup')
    let called = false
    for (const sample of [invalid, changed, office, escaped, linked]) {
      await assert.rejects(
        cleanupBackup(catalog.repo, options.backupRoot, options.archiveRoot, sample.id, () => {
          called = true
          return Promise.resolve()
        })
      )
    }
    assert.equal(called, false, 'Unsafe targets never reach trash')
    assert.ok(await exists(external))
    await assert.rejects(
      cleanupBackup(catalog.repo, options.backupRoot, options.archiveRoot, fresh.id, () =>
        Promise.reject(new Error('simulated trash failure'))
      ),
      /trash failure/
    )
    await preserved(fresh.id)
    assert.equal(await readFile(fresh.backup, 'utf8'), `full original ${fresh.id}`)

    // A missing output is acceptable when an independent, verified Archive copy remains.
    const archived = await catalog.archive(old.id, ['保留标签'])
    assert.ok(archived.archivePath)
    await unlink(old.output)
    catalog.repo.update(middle.id, { inherit_tags_pending: 1 })
    await fileTags(middle.backup, ['继承标签'])

    const attach = registerCatalogIpc(catalog)
    window = new BrowserWindow({
      show: false,
      width: 1120,
      height: 900,
      webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
    })
    attach(window.webContents)
    await window.loadFile(resolve('out/renderer/index.html'))
    const contents = window.webContents
    async function waitFor(script: string): Promise<void> {
      const deadline = Date.now() + 15_000
      while (!(await contents.executeJavaScript(script))) {
        if (Date.now() > deadline) throw new Error(`UI timeout: ${script}`)
        await delay(80)
      }
    }
    await contents.executeJavaScript(
      'document.querySelector("button[aria-label=我的归档]").click()'
    )
    await waitFor('!!document.querySelector(".archive-segments")')
    await contents.executeJavaScript(
      'document.querySelectorAll(".archive-segments button")[1].click()'
    )
    await waitFor(
      'document.querySelectorAll(".archive-backup-cleanup button").length === 3 && !!document.querySelector(".archive-row")'
    )
    let confirmation = ''
    dialog.showMessageBox = (options): Promise<Electron.MessageBoxReturnValue> => {
      confirmation = 'detail' in options ? (options.detail ?? '') : ''
      return Promise.resolve({ response: 0, checkboxChecked: false })
    }
    await contents.executeJavaScript(
      'document.querySelectorAll(".archive-backup-cleanup button")[0].click()'
    )
    await waitFor('!document.querySelector(".archive-backup-cleanup button").disabled')
    assert.match(confirmation, /回收站/)
    await preserved(old.id)

    dialog.showMessageBox = (): Promise<Electron.MessageBoxReturnValue> =>
      Promise.resolve({
        response: 1,
        checkboxChecked: false
      })
    // Seven-day button moves only the old valid original through the real macOS Trash API.
    await contents.executeJavaScript(
      'document.querySelectorAll(".archive-backup-cleanup button")[0].click()'
    )
    await waitFor(
      '!document.querySelector(".archive-backup-cleanup button").disabled && document.querySelector(".archive-backup-cleanup").textContent.includes("已移入回收站 1 项")'
    )
    assert.equal(catalog.get(old.id).backupStatus, 'trashed')
    assert.ok(await exists(archived.archivePath))
    assert.deepEqual(catalog.get(old.id).tags, ['保留标签'])
    await preserved(middle.id)
    await preserved(fresh.id)
    await contents.executeJavaScript(
      'document.querySelectorAll(".archive-backup-cleanup button")[1].click()'
    )
    await waitFor(
      '!document.querySelector(".archive-backup-cleanup button").disabled && document.querySelector(".archive-backup-cleanup").textContent.includes("已移入回收站 1 项")'
    )
    assert.equal(catalog.get(middle.id).backupStatus, 'trashed')
    await catalog.retryBackup(middle.id)
    assert.equal(
      catalog.get(middle.id).backupStatus,
      'trashed',
      'Retry does not reconstruct deleted backups'
    )
    const later = await catalog.archive(middle.id, [])
    assert.ok(later.archivePath)
    assert.ok(
      later.tags.includes('继承标签'),
      'Deferred original tags survive cleaning before archiving'
    )

    // Test ALL snapshot execution with fixture-local moves so dozens of generated samples stay inspectable.
    const all = catalog.prepareBackupCleanup(0)
    assert.equal(all.ids.length, 57)
    dialog.showMessageBox = (options): Promise<Electron.MessageBoxReturnValue> => {
      confirmation = 'detail' in options ? (options.detail ?? '') : ''
      return Promise.resolve({ response: 0, checkboxChecked: false })
    }
    await contents.executeJavaScript(
      'document.querySelectorAll(".archive-backup-cleanup button")[2].click()'
    )
    await waitFor('!document.querySelector(".archive-backup-cleanup button").disabled')
    assert.match(confirmation, /57 个文件/)
    await preserved(fresh.id)
    const disposed = join(directory, 'simulated-trash')
    await mkdir(disposed)
    for (const id of all.ids) {
      if ([invalid.id, changed.id, office.id, escaped.id, linked.id].includes(id)) continue
      await cleanupBackup(catalog.repo, options.backupRoot, options.archiveRoot, id, (path) =>
        rename(path, join(disposed, id))
      )
    }
    assert.ok(await exists(untouched))
    assert.ok(await exists(fresh.output))
    assert.equal(catalog.prepareBackupCleanup(0).ids.length, 5)
    assert.ok(catalog.repo.get(old.id).backup_cleaned_at)
    await mkdir(join(directory, 'evidence'), { recursive: true })
    await writeFile(
      join(directory, 'evidence', 'backup-cleanup.png'),
      (await contents.capturePage()).toPNG()
    )
    window.destroy()
    window = undefined

    const interruptedPresent = await fixture('interrupted-present', 8)
    const interruptedMissing = await fixture('interrupted-missing', 8)
    catalog.repo.update(interruptedPresent.id, { backup_status: 'cleanup-pending' })
    catalog.repo.update(interruptedMissing.id, { backup_status: 'cleanup-pending' })
    await rename(interruptedMissing.backup, join(disposed, interruptedMissing.id))
    await catalog.close()
    catalog = new Catalog(options)
    await catalog.start()
    assert.equal(catalog.get(interruptedPresent.id).backupStatus, 'ready')
    assert.equal(catalog.get(interruptedMissing.id).backupStatus, 'cleanup-unknown')
    assert.equal(catalog.get(old.id).backupStatus, 'trashed')
    assert.equal(catalog.get(middle.id).backupStatus, 'trashed')
    await catalog.retryBackup(interruptedMissing.id)
    assert.equal(catalog.get(interruptedMissing.id).backupStatus, 'cleanup-unknown')
    console.log(
      `PASS backup cleanup: dates, >50 records, protection, real Trash, UI/IPC confirmation and cancel, partial failure, archive/tag compatibility, restart recovery. Evidence: ${directory}`
    )
  } finally {
    dialog.showMessageBox = showMessageBox
    window?.destroy()
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
