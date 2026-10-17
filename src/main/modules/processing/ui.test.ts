import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, stat, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { registerImageCompressionIpc } from '../image-compression/ipc'
import sharp from 'sharp'
import { registerProcessingIpc } from './ipc'
import { Catalog, setCatalog } from '../catalog/service'
import { registerCatalogIpc } from '../catalog/ipc'
import { registerTasksIpc } from '../../tasks/ipc'
import { tasks } from '../../tasks/service'
import { fixture } from '../office-compression/fixtures.test'
import { runBundledTool } from '../../../execution/process'
import { hashFile } from '../catalog/files'
import { fileTags } from '../catalog/finder-tags'

app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  await app.whenReady()
  const packagedResources = process.env.ARKIVE_PACKAGED_RESOURCES
  if (packagedResources) {
    // Only this check process redirects resource resolution; production paths remain untouched.
    Object.defineProperty(app, 'isPackaged', { value: true })
    Object.defineProperty(process, 'resourcesPath', { value: packagedResources })
  }
  const built = packagedResources ? join(packagedResources, 'app.asar', 'out') : resolve('out')
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/integration-ui-')
  const options = {
    databasePath: join(directory, 'catalog.db'),
    backupRoot: join(directory, 'Backup'),
    archiveRoot: join(directory, 'Archive')
  }
  const catalog = new Catalog(options)
  setCatalog(catalog)
  await catalog.start()
  const pdf = join(directory, '测试 PDF with spaces.pdf')
  const ps = join(directory, 'fixture.ps')
  await writeFile(
    ps,
    '%!PS\n/Helvetica findfont 18 scalefont setfont\n72 720 moveto (Generated PDF integration fixture) show\nshowpage\n'
  )
  const made = await runBundledTool('ghostscript', [
    '-dBATCH',
    '-dNOPAUSE',
    '-sDEVICE=pdfwrite',
    `-sOutputFile=${pdf}`,
    ps
  ])
  assert.equal(made.exitCode, 0, made.stderr)
  let choice = pdf
  const output = join(directory, 'result.pdf')
  let savePath = output
  let cancelOpen = false
  let cancelSave = false
  let saveCalls = 0
  const originalOpen = dialog.showOpenDialog.bind(dialog)
  const originalSave = dialog.showSaveDialog.bind(dialog)
  dialog.showOpenDialog = () => {
    return Promise.resolve({ canceled: cancelOpen, filePaths: cancelOpen ? [] : [choice] })
  }
  dialog.showSaveDialog = () => {
    saveCalls++
    return Promise.resolve({ canceled: cancelSave, filePath: cancelSave ? '' : savePath })
  }
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { preload: join(built, 'preload/index.js'), sandbox: false }
  })
  const errors: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason))
  window.webContents.on('preload-error', (_event, path, error) => {
    errors.push(`Preload failed: ${path}: ${error.message}`)
  })
  registerProcessingIpc()(window.webContents)
  registerCatalogIpc(catalog)(window.webContents)
  registerImageCompressionIpc()(window.webContents)
  registerTasksIpc(tasks)(window.webContents)
  ipcMain.handle('agent:status', () => ({ configured: false, model: '' }))
  const evaluate = async (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression)
  async function wait(expression: string, timeout = 90_000): Promise<void> {
    const until = Date.now() + timeout
    while (!(await evaluate(expression))) {
      assert.ok(
        Date.now() < until,
        `Timeout: ${expression}\n${String(await evaluate('document.body.innerText'))}`
      )
      await delay(70)
    }
  }
  async function click(text: string, scope = '#documents-page'): Promise<void> {
    await evaluate(
      `(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw Error('Button unavailable: ' + ${JSON.stringify(text)}); b.click(); })()`
    )
  }
  async function select(): Promise<void> {
    await evaluate("document.querySelector('.document-select').click()")
    await wait("!document.querySelector('.document-select').disabled")
  }
  try {
    await window.loadFile(join(built, 'renderer/index.html'))
    assert.equal(
      await evaluate('typeof window.api?.processing?.select'),
      'function',
      errors.join('\n')
    )
    await evaluate('document.querySelector(\'[aria-label="文档压缩与重复检测"]\').click()')
    await wait("!document.querySelector('#documents-page').hidden")
    if (process.env.ARKIVE_NATIVE_UI_CHECK === '1') {
      dialog.showOpenDialog = originalOpen
      dialog.showSaveDialog = originalSave
      window.show()
      console.log(`NATIVE UI READY: ${pdf}`)
      const deadline = Date.now() + 240_000
      while (catalog.query({}).total !== 1) {
        assert.ok(Date.now() < deadline, 'Native UI check timed out before archive')
        await delay(200)
      }
      const item = catalog.query({}).items[0]
      assert.ok(item.archivePath)
      assert.equal((await runBundledTool('qpdf', ['--check', item.archivePath])).exitCode, 0)
      await writeFile(
        join(directory, 'native-dialog.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      console.log(
        `PASS: native macOS open/save dialogs → real PDF compression → archive. Evidence: ${directory}`
      )
      return
    }
    cancelOpen = true
    await select()
    assert.equal(await evaluate("document.querySelector('.document-selected') === null"), true)
    cancelOpen = false
    await select()
    assert.ok(
      String(await evaluate("document.querySelector('.document-selected').innerText")).includes(
        '1 页'
      )
    )
    await evaluate(
      "const preset=document.querySelector('[aria-label=\"文档压缩档位\"]'); preset.value='deep-lossless'; preset.dispatchEvent(new Event('change',{bubbles:true}))"
    )
    assert.equal(
      await evaluate('document.querySelector(\'[aria-label="文档压缩档位"]\')?.value'),
      'deep-lossless'
    )
    cancelSave = true
    await click('开始文档压缩')
    await wait("document.querySelector('#documents-page').innerText.includes('已取消')")
    await assert.rejects(stat(output))
    cancelSave = false
    let releaseQueue!: () => void
    const hold = new Promise<void>((done) => {
      releaseQueue = done
    })
    const blocker = tasks.submitBatch([{ title: 'hold PDF UI queue', run: () => hold }], {
      onError: 'stop'
    })
    try {
      await click('开始文档压缩')
      await wait("document.querySelector('.document-running')?.innerText.includes('已加入队列')")
      assert.equal(catalog.query({ state: 'pending' }).total, 0)
      await assert.rejects(stat(output))
      const queued = tasks.list().find((task) => task.status === 'queued' && task.requestId)
      assert.ok(queued)
      await evaluate(`window.api.tasks.cancel('${queued.id}')`)
      await wait(
        "document.querySelector('#documents-page').innerText.includes('已取消') && !document.querySelector('.document-select').disabled"
      )
      assert.equal(tasks.get(queued.id)?.status, 'cancelled')
    } finally {
      releaseQueue()
      await tasks.wait(blocker.taskIds[0])
    }
    await click('开始文档压缩')
    // A second click while running must not encode twice.
    await evaluate(
      "[...document.querySelectorAll('#documents-page button')].find(b => b.textContent === '开始文档压缩').click()"
    )
    await wait('document.querySelector(\'[aria-label="文档压缩结果"]\') !== null')
    assert.equal(saveCalls, 3)
    assert.equal((await runBundledTool('qpdf', ['--check', output])).exitCode, 0)
    const pending = catalog.query({ state: 'pending' })
    assert.equal(pending.total, 1)
    let releaseArchive!: () => void
    const archiveHold = new Promise<void>((done) => {
      releaseArchive = done
    })
    const archiveBlocker = tasks.submitBatch(
      [{ title: 'hold archive UI queue', run: () => archiveHold }],
      { onError: 'stop' }
    )
    try {
      await click('确定归档')
      await wait(
        `window.api.tasks.list().then(items => items.some(item => item.key === 'catalog:${pending.items[0].id}' && item.status === 'queued'))`
      )
      assert.equal(catalog.get(pending.items[0].id).archivePath, null)
      releaseArchive()
      await wait("document.querySelector('#documents-page').innerText.includes('已归档：')")
    } finally {
      releaseArchive()
      await tasks.wait(archiveBlocker.taskIds[0])
    }
    assert.equal(catalog.query({}).total, 1)
    assert.equal(catalog.query({ state: 'pending' }).total, 0)
    await writeFile(join(directory, 'pdf.png'), (await window.webContents.capturePage()).toPNG())
    // Existing output is refused by the actual Service and does not alter its bytes.
    const bytes = await readFile(output)
    if (pending.items[0].backupPath) await copyFile(pending.items[0].backupPath, pdf)
    await select()
    await click('开始文档压缩')
    await wait("document.querySelector('#documents-page [role=alert]') !== null")
    assert.deepEqual(await readFile(output), bytes)
    await click('Word / PowerPoint')
    const image = await sharp({
      create: { width: 1000, height: 700, channels: 3, background: '#80a090' }
    })
      .png()
      .toBuffer()
    for (const format of ['docx', 'pptx'] as const) {
      choice = join(directory, `中文 Office ${format}.${format}`)
      await fixture(choice, format, [image])
      const before = await hashFile(choice)
      await select()
      assert.equal(
        await evaluate(
          "[...document.querySelectorAll('#documents-page button')].find(b => b.textContent === '开始文档压缩').disabled"
        ),
        true
      )
      // IPC also requires explicit replacement confirmation.
      await assert.rejects(
        window.webContents.executeJavaScript(
          `(async()=>{const selected=await window.api.processing.selectPath('office',${JSON.stringify(choice)});return window.api.processing.compress({runId:'unconfirmed',fileId:selected.id,preset:'quality',replaceConfirmed:false})})()`
        ),
        /确认/
      )
      await select()
      await evaluate("document.querySelector('.document-confirm input').click()")
      if (format === 'docx') {
        let releaseOffice!: () => void
        const officeHold = new Promise<void>((done) => {
          releaseOffice = done
        })
        const officeBlocker = tasks.submitBatch(
          [{ title: 'hold Office UI queue', run: () => officeHold }],
          { onError: 'stop' }
        )
        try {
          await click('开始文档压缩')
          await wait(
            "document.querySelector('.document-running')?.innerText.includes('已加入队列')"
          )
          assert.equal(await hashFile(choice), before)
          const queued = tasks
            .list()
            .find((task) => task.status === 'queued' && task.key === `compress:${choice}`)
          assert.ok(queued)
          await evaluate(`window.api.tasks.cancel('${queued.id}')`)
          await wait(
            "document.querySelector('#documents-page').innerText.includes('已取消') && !document.querySelector('.document-select').disabled"
          )
          assert.equal(await hashFile(choice), before)
        } finally {
          releaseOffice()
          await tasks.wait(officeBlocker.taskIds[0])
        }
      }
      await click('开始文档压缩')
      await wait(
        "document.querySelector('[aria-label=\"文档压缩结果\"]')?.innerText.includes('replaced')"
      )
      assert.notEqual(await hashFile(choice), before)
      const page = catalog.query({ state: 'pending' })
      const item = page.items.find((row) => row.originalName.endsWith(`.${format}`))
      assert.ok(item?.backupPath)
      assert.equal(await hashFile(item.backupPath), before)
      assert.equal(item.outputPath, choice)
      await click('确定归档')
      await wait("document.querySelector('#documents-page').innerText.includes('已归档：')")
    }
    await writeFile(join(directory, 'office.png'), (await window.webContents.capturePage()).toPNG())
    choice = join(directory, 'empty.docx')
    await fixture(choice, 'docx', [])
    const emptyHash = await hashFile(choice)
    await select()
    await evaluate("document.querySelector('.document-confirm input').click()")
    await click('开始文档压缩')
    await wait(
      "document.querySelector('[aria-label=\"文档压缩结果\"]')?.innerText.includes('unchanged')"
    )
    assert.equal(await hashFile(choice), emptyHash)
    choice = join(directory, 'duplicates')
    await mkdir(choice)
    await writeFile(join(choice, 'a.txt'), 'generated duplicate content')
    await writeFile(join(choice, 'b.txt'), 'generated duplicate content')
    const originalHash = await hashFile(join(choice, 'a.txt'))
    await click('选择检测文件夹')
    await wait("!document.querySelector('.document-select').disabled")
    await click('检测重复文件')
    await wait(
      "document.querySelector('[aria-label=\"文件夹重复检测\"]').innerText.includes('1 组')"
    )
    assert.equal(await hashFile(join(choice, 'a.txt')), originalHash)
    assert.equal(await hashFile(join(choice, 'b.txt')), originalHash)
    const cancelled = await evaluate(
      `(async () => { const work = window.api.processing.duplicates('cancel-scan',${JSON.stringify(choice)}); await window.api.processing.cancel('cancel-scan'); return await work; })()`
    )
    assert.deepEqual(cancelled, { status: 'cancelled' })
    window.setSize(800, 700)
    await writeFile(join(directory, 'narrow.png'), (await window.webContents.capturePage()).toPNG())
    // Create a ready, unarchived record and find it through the actual frontend selector.
    const extra = join(directory, 'later-source.txt'),
      extraOutput = join(directory, 'later-result.txt')
    await writeFile(extra, 'source')
    await writeFile(extraOutput, 'result')
    const extraId = await catalog.beginCompression(extra, extraOutput)
    await catalog.finishCompression(extraId, false)
    await evaluate(
      "document.querySelector('[aria-label=\"我的归档\"]').click(); const s = document.querySelector('[aria-label=\"归档记录状态\"]'); s.value='pending'; s.dispatchEvent(new Event('change',{bubbles:true}));"
    )
    await wait("document.querySelector('#archive-page').innerText.includes('later-result.txt')")
    await click('确定归档', '#archive-page')
    await wait("!document.querySelector('#archive-page').innerText.includes('later-result.txt')")
    assert.ok(catalog.get(extraId).archivePath)
    await catalog.editTags([extraId], ['UI 标签'], [])
    assert.deepEqual(await fileTags(catalog.get(extraId).archivePath ?? ''), ['UI 标签'])
    await catalog.refresh()
    assert.equal(catalog.query({ tags: ['UI 标签'] }).total, 1)
    // Use a Chromium-backed File, not a synthetic File with a forged path property.
    const dragImage = join(directory, 'native-drop.png')
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#90b080' } })
      .png({ compressionLevel: 0 })
      .toFile(dragImage)
    const imageHash = await hashFile(dragImage)
    await evaluate(
      "document.querySelector('[aria-label=\"图片压缩\"]').click(); const input=document.createElement('input'); input.type='file'; input.id='native-drop-fixture'; document.body.append(input)"
    )
    window.webContents.debugger.attach('1.3')
    const dom = (await window.webContents.debugger.sendCommand('DOM.getDocument')) as {
      root: { nodeId: number }
    }
    const inputNode = (await window.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: dom.root.nodeId,
      selector: '#native-drop-fixture'
    })) as { nodeId: number }
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: [dragImage]
    })
    assert.equal(
      await evaluate("document.querySelector('#native-drop-fixture').files[0].path"),
      undefined
    )
    assert.equal(
      await evaluate(
        "window.api.processing.localFilePath(document.querySelector('#native-drop-fixture').files[0])"
      ),
      dragImage
    )
    await evaluate(
      "const data = new DataTransfer(); data.items.add(document.querySelector('#native-drop-fixture').files[0]); document.querySelector('.image-drop-zone').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));"
    )
    await wait(
      "document.querySelector('.image-selected-file')?.innerText.includes('native-drop.png')",
      3000
    )
    savePath = join(directory, 'native-drop-result.webp')
    const imageHold = new Promise<void>((done) => {
      releaseQueue = done
    })
    const imageBlocker = tasks.submitBatch(
      [{ title: 'hold image UI queue', run: () => imageHold }],
      { onError: 'stop' }
    )
    try {
      await click('开始压缩', '.image-page')
      await wait("document.querySelector('.image-page').innerText.includes('已加入队列')")
      await assert.rejects(stat(savePath))
    } finally {
      releaseQueue()
      await tasks.wait(imageBlocker.taskIds[0])
    }
    await wait("document.querySelector('.image-page .image-result') !== null")
    assert.equal((await sharp(savePath).metadata()).format, 'webp')
    const imageItem = catalog
      .query({ state: 'pending' })
      .items.find((item) => item.originalName === 'native-drop.png')
    assert.ok(imageItem?.backupPath)
    assert.equal(await hashFile(imageItem.backupPath), imageHash)
    await assert.rejects(stat(dragImage))
    await click('确定归档', '.image-page')
    await wait("document.querySelector('.image-page').innerText.includes('已归档：')")
    assert.equal(
      await hashFile(catalog.get(imageItem.id).archivePath ?? ''),
      await hashFile(savePath)
    )
    await writeFile(join(directory, 'image.png'), (await window.webContents.capturePage()).toPNG())
    // The document drop uses the same real File bridge, including Unicode and spaces.
    await evaluate('document.querySelector(\'[aria-label="文档压缩与重复检测"]\').click()')
    await click('PDF')
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: [pdf]
    })
    await evaluate(
      "(()=>{const data=new DataTransfer();data.items.add(document.querySelector('#native-drop-fixture').files[0]);document.querySelector('.document-select').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));})()"
    )
    await wait(
      "document.querySelector('.document-selected')?.innerText.includes('测试 PDF with spaces.pdf')"
    )
    window.webContents.debugger.detach()
    await evaluate("document.querySelector('#native-drop-fixture').remove()")
    choice = pdf
    await evaluate("document.querySelector('.document-select').focus()")
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await wait("!document.querySelector('.document-select').disabled")
    assert.deepEqual(errors, [])
    console.log(
      `PASS: image/PDF/Office real UI compression, dialog cancellation, keyboard selection, native image/document drag, no-overwrite, original hashes, backup/archive, duplicate scan/cancel, pending result UI, Finder tags. Evidence: ${directory}`
    )
  } finally {
    dialog.showOpenDialog = originalOpen
    dialog.showSaveDialog = originalSave
    window.destroy()
    await tasks.close()
    await catalog.close()
  }
  // Reopen persisted database after all UI work, without regenerating records.
  const reopened = new Catalog(options)
  await reopened.start()
  assert.equal(reopened.query({}).total, 5)
  await reopened.close()
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
