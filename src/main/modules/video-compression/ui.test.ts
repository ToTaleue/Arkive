// Real renderer + preload + IPC + FFmpeg. Only the native dialogs use fixture responses.
// Build the app first, then: rtk proxy node scripts/check-video-compression.mjs --ui
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog } from 'electron'
import { runBundledTool } from '../../../execution/process'
import { registerVideoCompressionIpc } from './ipc'

async function check(): Promise<void> {
  await app.whenReady()
  const directory = await mkdtemp(join(tmpdir(), 'arkive-video-ui-'))
  const source = join(directory, 'sample.mov')
  let selectedPath = source
  let outputPath = join(directory, 'compressed.mp4')
  let cancelOpen = true
  let cancelSave = true
  const originalOpen = dialog.showOpenDialog.bind(dialog)
  const originalSave = dialog.showSaveDialog.bind(dialog)
  dialog.showOpenDialog = () =>
    Promise.resolve({
      canceled: cancelOpen,
      filePaths: cancelOpen ? [] : [selectedPath]
    })
  dialog.showSaveDialog = () =>
    Promise.resolve({
      canceled: cancelSave,
      filePath: cancelSave ? '' : outputPath
    })
  const attach = registerVideoCompressionIpc()
  const window = new BrowserWindow({
    width: 1280,
    height: 1000,
    show: false,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  attach(window.webContents)
  async function evaluate(expression: string): Promise<unknown> {
    const value: unknown = await window.webContents.executeJavaScript(expression)
    return value
  }
  async function waitFor(expression: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!(await evaluate(expression))) {
      assert.ok(
        Date.now() < deadline,
        `Timed out: ${expression}\n${String(await evaluate('document.body.innerText'))}`
      )
      await delay(20)
    }
  }
  async function click(selector: string): Promise<void> {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function fixture(path: string, duration: number): Promise<void> {
    const result = await runBundledTool('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=640x480:rate=30:duration=${String(duration)}`,
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      path
    ])
    assert.equal(result.exitCode, 0, result.stderr)
  }
  try {
    await fixture(source, 3)
    const hash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex')
    await window.loadFile(resolve('out/renderer/index.html'))
    await waitFor('Boolean(document.querySelector("button[aria-label=视频压缩]"))')
    await click('button[aria-label="视频压缩"]')
    await waitFor('!document.querySelector("#video-compression-page").hidden')
    assert.equal(await evaluate('document.querySelector(".video-primary-button").disabled'), true)
    await click('.video-file-picker')
    await waitFor('!document.querySelector(".video-file-picker").disabled')
    assert.equal(await evaluate('Boolean(document.querySelector(".video-selected-file"))'), false)
    cancelOpen = false
    await click('.video-file-picker')
    await waitFor('Boolean(document.querySelector(".video-selected-file"))')
    assert.equal(
      await evaluate('document.querySelector(".video-selected-file strong").textContent'),
      'sample.mov'
    )
    assert.equal(await evaluate('document.querySelector("input[value=balanced]").checked'), true)
    await delay(100)
    await writeFile(
      resolve('out/video-compression-preview.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    console.log(
      'PASS: left navigation opens the page; cancelled picker, real file selection and default preset'
    )

    await click('.video-primary-button')
    await waitFor('document.querySelector(".video-feedback")?.textContent.includes("已取消")')
    await assert.rejects(stat(outputPath), { code: 'ENOENT' })
    cancelSave = false
    await click('.video-primary-button')
    await waitFor('Boolean(document.querySelector(".video-result"))')
    assert.ok((await stat(outputPath)).size > 0)
    assert.equal(await evaluate('document.querySelector(".video-primary-button").disabled'), false)
    assert.equal(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
      hash
    )
    console.log(
      'PASS: save cancellation and full UI → preload → IPC → real compression → result flow'
    )

    await assert.rejects(
      evaluate(
        'window.api.video.compress({runId:"invalid",fileId:"not-selected",preset:"balanced"})'
      )
    )
    // An undefined cancellation request must not dereference an absent task.
    await evaluate('window.api.video.cancel(undefined)')
    const invalid = join(directory, 'invalid.mp4')
    await writeFile(invalid, 'not a video')
    selectedPath = invalid
    outputPath = join(directory, 'invalid-output.mp4')
    await click('.video-selected-file button')
    await waitFor(
      'document.querySelector(".video-selected-file strong").textContent === "invalid.mp4"'
    )
    await click('.video-primary-button')
    await waitFor('Boolean(document.querySelector(".video-error[role=alert]"))')
    assert.equal(await evaluate('document.querySelector(".video-primary-button").disabled'), false)
    await assert.rejects(stat(outputPath), { code: 'ENOENT' })
    console.log(
      'PASS: forged selection rejected and invalid media errors shown with retry available'
    )

    const long = join(directory, 'long.mov')
    await fixture(long, 30)
    selectedPath = long
    outputPath = join(directory, 'cancelled.mp4')
    await click('.video-selected-file button')
    await waitFor(
      'document.querySelector(".video-selected-file strong").textContent === "long.mov"'
    )
    await click('.video-primary-button')
    await waitFor('document.querySelector(".video-running")?.textContent.includes("正在压缩视频")')
    await click('button[aria-label="切换会话列表"]')
    await click('button[aria-label="视频压缩"]')
    await click('.video-running button')
    await waitFor('document.querySelector(".video-feedback")?.textContent.includes("已取消")')
    await assert.rejects(stat(outputPath), { code: 'ENOENT' })
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.arkive-video-')))
    console.log(
      'PASS: navigation retains the running task; UI cancellation removes temporary output'
    )
  } finally {
    window.destroy()
    dialog.showOpenDialog = originalOpen
    dialog.showSaveDialog = originalSave
    await rm(directory, { recursive: true, force: true })
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
