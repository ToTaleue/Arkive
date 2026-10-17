// Real renderer + preload + IPC + FFmpeg. Only the native dialogs use fixture responses.
// Build the app first, then: rtk proxy node scripts/check-video-compression.mjs --ui
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog } from 'electron'
import { runBundledTool } from '../../../execution/process'
import { registerVideoCompressionIpc } from './ipc'

// Keep failures observable after cleanup destroys the last window.
app.on('window-all-closed', () => {})

async function check(): Promise<void> {
  await app.whenReady()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'arkive-video-ui-')))
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
  async function checkOriginal(expectedHash: string): Promise<void> {
    assert.equal(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
      expectedHash
    )
  }
  async function evaluate(expression: string): Promise<unknown> {
    const value: unknown = await window.webContents.executeJavaScript(expression)
    return value
  }
  async function waitFor(expression: string, timeout = 20_000): Promise<void> {
    const deadline = Date.now() + timeout
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
  async function fixture(path: string, duration: number, size = '640x480'): Promise<void> {
    const result = await runBundledTool('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=30:duration=${String(duration)}`,
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      '-timecode',
      '01:02:03:00',
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
    assert.equal(
      await evaluate('document.querySelector(".video-compatibility input").checked'),
      false
    )
    assert.equal(
      await evaluate(
        'document.querySelector("[role=note]").textContent.includes("仅保留主视频和音频")'
      ),
      true
    )
    assert.equal(
      await evaluate(
        'document.querySelector("[role=note]").textContent.includes("将移除：时间码")'
      ),
      true
    )
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
    await waitFor('document.querySelector(".video-running")?.textContent.includes("正在分析画质")')
    assert.equal(
      await evaluate('document.querySelector(".video-running progress").hasAttribute("value")'),
      false
    )
    await waitFor('Boolean(document.querySelector(".video-result"))', 120_000)
    assert.equal(
      await evaluate(
        'document.querySelector(".video-result").textContent.includes("抽样画质评分")'
      ),
      true
    )
    assert.ok((await stat(outputPath)).size > 0)
    assert.equal(await evaluate('document.querySelector(".video-primary-button").disabled'), false)
    await checkOriginal(hash)
    console.log(
      'PASS: save cancellation and full UI → preload → IPC → real compression → result flow'
    )

    outputPath = join(directory, 'compatible.mp4')
    await click('.video-compatibility input')
    await waitFor('document.querySelector(".video-format").textContent.includes("H.264")')
    assert.equal(
      await evaluate(
        'document.querySelector(".video-page").textContent.includes("10bit 原片将转为 8bit")'
      ),
      true
    )
    await click('.video-primary-button')
    await waitFor('document.querySelector(".video-running")?.textContent.includes("正在分析画质")')
    assert.equal(
      await evaluate('document.querySelector(".video-compatibility input").disabled'),
      true
    )
    await waitFor(
      'document.querySelector(".video-result")?.textContent.includes("H.264 · 8bit")',
      120_000
    )
    const compatible = await runBundledTool('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt',
      '-of',
      'json',
      outputPath
    ])
    assert.equal(compatible.exitCode, 0, compatible.stderr)
    const compatibleData: unknown = JSON.parse(compatible.stdout)
    assert.ok(
      typeof compatibleData === 'object' && compatibleData !== null && 'streams' in compatibleData
    )
    assert.deepEqual(compatibleData.streams, [{ codec_name: 'h264', pix_fmt: 'yuv420p' }])
    await checkOriginal(hash)
    await writeFile(
      resolve('out/video-compression-h264.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await click('.video-compatibility input')
    await waitFor('document.querySelector(".video-format").textContent.includes("HEVC")')
    assert.equal(
      await evaluate(
        'document.querySelector(".video-result").textContent.includes("H.264 · 8bit")'
      ),
      true
    )
    console.log(
      'PASS: H.264 option reaches real encoder through IPC; busy option locked and result retains actual codec'
    )

    await assert.rejects(
      evaluate(
        'window.api.video.compress({runId:"invalid",fileId:"not-selected",preset:"balanced",compatibility:"true"})'
      )
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
    await click('.video-selected-file button')
    await waitFor('Boolean(document.querySelector(".video-error[role=alert]"))')
    assert.equal(await evaluate('document.querySelector(".video-primary-button").disabled'), false)
    assert.equal(
      await evaluate('document.querySelector(".video-selected-file strong").textContent'),
      'sample.mov'
    )
    console.log(
      'PASS: forged selection rejected and invalid media errors shown with retry available'
    )

    const long = join(directory, 'long.mov')
    await fixture(long, 30, '1280x720')
    selectedPath = long
    outputPath = join(directory, 'cancelled.mp4')
    await click('.video-selected-file button')
    await waitFor(
      'document.querySelector(".video-selected-file strong").textContent === "long.mov"'
    )
    await click('.video-primary-button')
    await waitFor(
      'document.querySelector(".video-running")?.textContent.includes("正在压缩视频")',
      120_000
    )
    await waitFor(
      'document.querySelector(".video-progress-details")?.textContent.includes("本阶段预计还需约")'
    )
    assert.equal(
      await evaluate(
        'document.querySelector(".video-running progress").value > 0 && document.querySelector(".video-running progress").value < 100'
      ),
      true
    )
    await writeFile(
      resolve('out/video-compression-progress.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await click('button[aria-label="切换会话列表"]')
    await click('button[aria-label="视频压缩"]')
    await click('.video-running button')
    await waitFor('document.querySelector(".video-feedback")?.textContent.includes("已取消")')
    assert.equal(
      await evaluate('Boolean(document.querySelector(".video-progress-details"))'),
      false
    )
    await assert.rejects(stat(outputPath), { code: 'ENOENT' })
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.arkive-video-')))
    console.log(
      'PASS: real percentage/ETA displayed; navigation retains task; cancellation clears progress and temporary output'
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
