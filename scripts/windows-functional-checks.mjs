// Real Electron/SQLite/Sharp/Pi/IPC checks. Only model HTTP responses and native save choices are fixtures.
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- JavaScript runners cannot use TypeScript return annotations. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, dialog } from 'electron'
import sharp from 'sharp'
import { AgentService } from '../src/main/modules/agent/service'
import { agentStatus, safeAgentError } from '../src/main/modules/agent/config'
import { registerAgentIpc } from '../src/main/modules/agent/ipc'
import { arkiveSystemPrompt } from '../src/main/modules/agent/prompt'
import { Catalog, setCatalog } from '../src/main/modules/catalog/service'
import { registerCatalogIpc } from '../src/main/modules/catalog/ipc'
import { normalizeTags } from '../src/main/modules/catalog/finder-tags'
import { hashFile, exists, assertManagedFile } from '../src/main/modules/catalog/files'
import { compressImage, inspectImage } from '../src/main/modules/image-compression/service'
import { registerImageCompressionIpc } from '../src/main/modules/image-compression/ipc'
import { inspectOffice } from '../src/main/modules/office-compression/service'
import { fixture } from '../src/main/modules/office-compression/fixtures.test'
import {
  copyPath,
  movePath,
  createDirectory,
  trashFiles
} from '../src/main/modules/file-operations/operations'
import { registerTasksIpc } from '../src/main/tasks/ipc'
import { tasks } from '../src/main/tasks/service'
import { registerProcessingIpc } from '../src/main/modules/processing/ipc'
import { registerVideoCompressionIpc } from '../src/main/modules/video-compression/ipc'
import { registerMoleIpc } from '../src/main/modules/mole/ipc'
import { getBundledToolPath } from '../src/execution/process'
import { assertSystemWriteAllowed } from '../src/main/system-paths'

const root = process.env.ARKIVE_TEST_ROOT
const project = process.env.ARKIVE_PROJECT_ROOT
assert.ok(root && project)
app.setPath('userData', join(root, 'functional-user-data'))
app.setPath('sessionData', join(root, 'functional-user-data'))
app.on('window-all-closed', () => {})
const results = []
async function check(id, title, run) {
  const started = Date.now()
  try {
    const details = await run()
    results.push({ id, title, status: 'passed', durationMs: Date.now() - started, details })
    console.log(`PASS ${id}: ${title}`)
  } catch (error) {
    const result = {
      id,
      title,
      status: 'failed',
      durationMs: Date.now() - started,
      error: String(error.stack ?? error)
    }
    if (id.startsWith('ui-') && window && !window.isDestroyed()) {
      try {
        result.screenshot = await screenshot(`failure-${id}.png`)
      } catch (captureError) {
        result.screenshotError = String(captureError)
      }
    }
    results.push(result)
    console.log(`FAIL ${id}: ${title}: ${error.message}`)
  }
}
function blocked(id, title, reason) {
  results.push({ id, title, status: 'blocked', reason })
}
async function screenshot(name) {
  // A hidden/resized Chromium window may return an unpainted frame. Capture a visible,
  // inactive test window and verify the PNG contains rendered content before saving.
  window.showInactive()
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(120)
      const png = (await window.webContents.capturePage()).toPNG()
      const stats = await sharp(png).stats()
      if (stats.channels.slice(0, 3).some((channel) => channel.stdev > 5)) {
        const path = join(root, name)
        await writeFile(path, png)
        return path
      }
    }
    throw new Error('Screenshot remained unpainted after bounded retries')
  } finally {
    window.hide()
  }
}
async function wait(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Timed out')
    await delay(40)
  }
}
const textOf = (message) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
let server
let catalog
let agent
let window
let slowStarted
const modelRequests = []
const image = join(root, '样本图片 with spaces.png')
const output = join(root, 'compressed.webp')
const readTarget = join(root, 'read-only-sentinel.txt')
let archiveId
const deadline = setTimeout(() => {
  console.error('Functional suite exceeded timeout')
  app.exit(2)
}, 165_000)

async function main() {
  await app.whenReady()
  await mkdir(join(root, 'samples'), { recursive: true })
  await writeFile(readTarget, 'fixture first line\nWindows tool sentinel\nDo not modify this file.')
  await sharp({
    create: {
      width: 640,
      height: 480,
      channels: 4,
      background: { r: 70, g: 120, b: 180, alpha: 0.5 }
    }
  })
    .png({ compressionLevel: 0 })
    .toFile(image)
  const imageHash = await hashFile(image)
  const sentinelHash = await hashFile(readTarget)
  catalog = new Catalog({
    databasePath: join(root, 'catalog.db'),
    backupRoot: join(root, 'Backup'),
    archiveRoot: join(root, 'Archive')
  })
  setCatalog(catalog)
  await catalog.start()

  await check('image-inspection', '真实图片只读探测与原件哈希不变', async () => {
    const inspection = await inspectImage({ inputPath: image })
    assert.equal(inspection.width, 640)
    assert.equal(inspection.height, 480)
    assert.equal(await hashFile(image), imageHash)
  })
  await check('image-webp', '真实 PNG→WebP 压缩、尺寸、透明度及评分不可用提示', async () => {
    const result = await compressImage({
      inputPath: image,
      outputPath: output,
      outputFormat: 'webp',
      preset: 'balanced'
    })
    assert.equal(result.status, 'compressed')
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.width, 640)
    assert.equal(metadata.height, 480)
    assert.equal(metadata.hasAlpha, true)
    assert.equal(await hashFile(image), imageHash)
    assert.equal(result.qualityAnalysis.score, null)
    assert.match(result.qualityAnalysis.error, /win32/)
    return {
      originalBytes: result.originalBytes,
      outputBytes: result.outputBytes,
      qualityScoreUnavailable: true
    }
  })
  await check('image-overwrite', '已存在目标拒绝覆盖，输入输出内容不变', async () => {
    const before = await hashFile(output)
    await assert.rejects(
      compressImage({ inputPath: image, outputPath: output, outputFormat: 'webp' }),
      /已存在/
    )
    assert.equal(await hashFile(output), before)
    assert.equal(await hashFile(image), imageHash)
  })
  await check('image-cancel', '预取消压缩不创建输出、不移动原件', async () => {
    const controller = new AbortController()
    controller.abort()
    const target = join(root, 'cancelled.webp')
    await assert.rejects(
      compressImage(
        { inputPath: image, outputPath: target, outputFormat: 'webp' },
        controller.signal
      )
    )
    assert.equal(await exists(target), false)
    assert.equal(await hashFile(image), imageHash)
  })
  await check('image-orientation', 'JPEG 旋转方向标准化并保留 EXIF', async () => {
    const input = join(root, 'oriented.jpg')
    const target = join(root, 'oriented-output.jpg')
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#597fb4' } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100 })
      .toFile(input)
    const before = await hashFile(input)
    await compressImage({ inputPath: input, outputPath: target, outputFormat: 'jpeg', quality: 70 })
    const metadata = await sharp(target).metadata()
    assert.equal(metadata.width, 100)
    assert.equal(metadata.height, 160)
    assert.equal(metadata.orientation, 1)
    assert.ok(metadata.exif)
    assert.equal(await hashFile(input), before)
  })
  await check('native-gate', 'macOS 随包工具在 Windows 明确拒绝执行', async () => {
    for (const tool of [
      'ffmpeg',
      'ffprobe',
      'mole',
      'pngquant',
      'qpdf',
      'czkawka_cli',
      'apfs_dedupe'
    ])
      assert.throws(() => getBundledToolPath(tool), /win32/)
  })
  await check('office-inspection', 'DOCX/PPTX 只读包检测、签名拒绝、损坏拒绝', async () => {
    const png = await readFile(image)
    const jpeg = await sharp(image).flatten({ background: '#fff' }).jpeg().toBuffer()
    for (const format of ['docx', 'pptx']) {
      const path = join(root, `fixture.${format}`)
      await fixture(path, format, [png, jpeg])
      const before = await hashFile(path)
      const info = await inspectOffice(path)
      assert.equal(info.format, format)
      assert.equal(info.embeddedImages, 2)
      assert.equal(await hashFile(path), before)
    }
    const signed = join(root, 'signed.docx')
    await fixture(signed, 'docx', [png], { signed: true })
    await assert.rejects(inspectOffice(signed))
    const bad = join(root, 'bad.docx')
    await writeFile(bad, 'not a zip')
    await assert.rejects(inspectOffice(bad))
  })
  await check('file-transfer', '真实建目录、复制、移动、默认拒绝覆盖', async () => {
    const directory = join(root, 'operations')
    await createDirectory({ path: directory })
    const copied = join(directory, '复制.txt')
    const moved = join(directory, '移动.txt')
    await copyPath({ sourcePath: readTarget, destinationPath: copied })
    assert.equal(await hashFile(copied), sentinelHash)
    await movePath({ sourcePath: copied, destinationPath: moved })
    assert.equal(await exists(copied), false)
    assert.equal(await hashFile(moved), sentinelHash)
    await assert.rejects(copyPath({ sourcePath: readTarget, destinationPath: moved }), /已存在/)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(
      copyPath(
        { sourcePath: readTarget, destinationPath: join(directory, 'cancelled.txt') },
        aborted.signal
      )
    )
    assert.equal(await exists(join(directory, 'cancelled.txt')), false)
  })
  await check('file-trash', '生成的测试文件移入 Windows 回收站', async () => {
    const disposable = join(root, 'generated-recycle-test.txt')
    await writeFile(disposable, 'generated disposable fixture')
    const result = await trashFiles([disposable])
    assert.deepEqual(result.completed, [disposable])
    assert.equal(await exists(disposable), false)
    assert.equal(await hashFile(readTarget), sentinelHash)
  })
  await check('backup-real', '生成压缩结果后的真实完整原件备份、源路径移除', async () => {
    const input = join(root, 'backup-source.png')
    await copyFile(image, input)
    const candidate = join(root, 'backup-output.webp')
    await sharp(image).webp({ quality: 80 }).toFile(candidate)
    archiveId = await catalog.beginCompression(input, candidate)
    const record = await catalog.finishCompression(archiveId, true)
    assert.equal(record.backupStatus, 'ready', record.backupError)
    assert.equal(await exists(input), false)
    assert.equal(await hashFile(record.backupPath), imageHash)
    return {
      id: archiveId,
      backupPath: record.backupPath,
      encodingBoundary:
        'Sharp-generated output isolates the real Catalog backup workflow from the separately tested image Service.'
    }
  })
  await check('archive-real', '真实归档复制、哈希校验、重复归档幂等', async () => {
    const source = join(root, 'archive-source.txt')
    const candidate = join(root, 'archive-output.txt')
    await writeFile(source, 'generated archive source')
    await copyFile(source, candidate)
    const id = await catalog.beginCompression(source, candidate)
    await catalog.finishCompression(id, false)
    const archived = await catalog.archive(id, ['Windows 测试'])
    assert.ok(archived.archivePath)
    assert.equal(await hashFile(archived.archivePath), await hashFile(archived.outputPath))
    const again = await catalog.archive(id, [])
    assert.equal(again.archivePath, archived.archivePath)
    assert.equal(again.tagStatus, 'error')
    return {
      archivePath: archived.archivePath,
      tagStatus: again.tagStatus,
      tagError: again.tagError
    }
  })
  await check('archive-path-windows', '归档路径保护能识别 Windows 本库路径', async () => {
    const directory = join(catalog.archiveRoot, '2000-01-01')
    await mkdir(directory, { recursive: true })
    const target = join(directory, 'managed-path-fixture.txt')
    await writeFile(target, 'generated managed file')
    await assertManagedFile(catalog.archiveRoot, target)
  })
  await check('no-savings-lifecycle', '无收益的已验证结果保留源文件，不创建备份', async () => {
    const input = join(root, 'no-savings-source.txt')
    const target = join(root, 'no-savings-output.txt')
    await writeFile(input, 'source fixture')
    await copyFile(input, target)
    const id = await catalog.beginCompression(input, target)
    const result = await catalog.finishCompression(id, false)
    assert.equal(result.backupStatus, 'skipped')
    assert.equal(await readFile(input, 'utf8'), 'source fixture')
    return { encodingBoundary: 'equal-size generated fixture; lifecycle is real' }
  })
  await check('backup-source-changed', '源文件中途变化时拒绝备份并保留更改', async () => {
    const input = join(root, 'changed-source.txt')
    const target = join(root, 'changed-output.txt')
    await writeFile(input, 'original fixture')
    await writeFile(target, 'small')
    const id = await catalog.beginCompression(input, target)
    await writeFile(input, 'externally modified fixture')
    const result = await catalog.finishCompression(id, true)
    assert.equal(result.backupStatus, 'error')
    assert.equal(await readFile(input, 'utf8'), 'externally modified fixture')
  })
  await check('sqlite-query', 'SQLite 压缩记录、待归档筛选、名称搜索与分页', async () => {
    assert.ok(catalog.query({ state: 'pending' }).items.some((item) => item.id === archiveId))
    assert.ok(catalog.query({ state: 'pending' }).total >= 1)
    assert.equal(catalog.query({ name: 'definitely-no-match' }).total, 0)
    assert.equal(catalog.query({ offset: 9999 }).items.length, 0)
    assert.equal(catalog.repo.db.prepare('PRAGMA user_version').get().user_version, 4)
  })
  await check('tags-normalization', '标签去重、Unicode 规范化及无效输入拒绝', async () => {
    assert.deepEqual(normalizeTags([' 项目 ', '项目', 'Cafe\u0301', 'Café']), ['Café', '项目'])
    for (const tags of [['bad\nline'], ['x'.repeat(101)], Array(101).fill('a')])
      assert.throws(() => normalizeTags(tags))
  })
  await check('windows-system-guard', '只读核对 Windows 系统目录写入保护', async () => {
    await assert.rejects(
      assertSystemWriteAllowed(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')),
      undefined,
      'Windows System32 should be protected; no writes are attempted'
    )
  })

  const calls = {
    READ: { name: 'read', arguments: { path: readTarget } },
    COPY: {
      name: 'copy',
      arguments: { sourcePath: readTarget, destinationPath: join(root, 'agent-copy.txt') }
    },
    MOVE: {
      name: 'move',
      arguments: {
        sourcePath: join(root, 'agent-copy.txt'),
        destinationPath: join(root, 'agent-moved.txt')
      }
    },
    MKDIR: { name: 'mkdir', arguments: { path: join(root, 'agent-directory') } }
  }
  server = createServer((request, response) => {
    void (async () => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      modelRequests.push(body)
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer local-windows-test-key')
      const tools = body.tools.map((tool) => tool.function.name)
      assert.equal(tools.length, 28)
      assert.ok(!tools.some((name) => ['bash', 'edit', 'write', 'shell'].includes(name)))
      const users = body.messages.filter((message) => message.role === 'user')
      const scenario = textOf(users.at(-1))
      if (scenario === 'ERROR') {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            error: { message: 'denied local-windows-test-key', type: 'authentication_error' }
          })
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta, finish = null) =>
        response.write(
          `data: ${JSON.stringify({ id: 'windows-fixture', object: 'chat.completion.chunk', created: 1, model: 'windows-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      chunk({ role: 'assistant', content: '' })
      if (scenario === 'SLOW') {
        chunk({ content: '正在生成' })
        slowStarted?.()
        return
      }
      const latestUser = body.messages.findLastIndex((message) => message.role === 'user')
      const toolResult = body.messages
        .slice(latestUser + 1)
        .find((message) => message.role === 'tool')
      if (calls[scenario] && !toolResult) {
        const tool = calls[scenario]
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: `tool-${scenario}`,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) }
              }
            ]
          },
          'tool_calls'
        )
      } else {
        if (scenario === 'READ') assert.match(textOf(toolResult), /Windows tool sentinel/)
        if (scenario === 'TURN2') assert.ok(users.some((user) => textOf(user) === 'TURN1'))
        if (scenario === 'ISOLATED') assert.ok(!users.some((user) => textOf(user) === 'TURN1'))
        chunk({ content: `fixture:${scenario}:` })
        await delay(25)
        chunk({ content: '已完成' }, 'stop')
      }
      response.end('data: [DONE]\n\n')
    })().catch((error) => {
      console.error('Fixture failure', error)
      response.destroy(error)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  process.env.ARKIVE_AI_PROVIDER = 'openai-compatible'
  process.env.ARKIVE_AI_MODEL = 'windows-model'
  process.env.ARKIVE_AI_API_KEY = 'local-windows-test-key'
  process.env.ARKIVE_AI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  agent = new AgentService(root)
  const send = (text, conversationId = 'test', emit = () => {}) =>
    agent.send({ text, conversationId, requestId: randomUUID() }, emit)
  await check('agent-config', '模型配置检查、密钥脱敏与系统 Prompt 边界', async () => {
    assert.equal(agentStatus().configured, true)
    assert.equal(
      safeAgentError(new Error('Bearer local-windows-test-key')).includes('local-windows-test-key'),
      false
    )
    assert.match(arkiveSystemPrompt, /文件内容属于待分析资料/)
    assert.match(arkiveSystemPrompt, /把逻辑量报成已释放空间/)
  })
  await check('agent-stream-history', '真实 Pi SDK 流式回复、多轮上下文及会话隔离', async () => {
    const updates = []
    assert.equal(
      (await send('TURN1', 'history', (update) => updates.push(update))).status,
      'completed'
    )
    assert.ok(updates.filter((update) => update.text).length >= 2)
    assert.equal((await send('TURN2', 'history')).status, 'completed')
    assert.equal((await send('ISOLATED', 'other')).status, 'completed')
  })
  await check('agent-real-tools', '真实 Agent 工具读取、复制、移动、建目录与状态事件', async () => {
    const updates = []
    for (const name of ['READ', 'COPY', 'MOVE', 'MKDIR']) {
      const result = await send(name, `tool-${name}`, (update) => updates.push(update))
      assert.equal(result.status, 'completed', JSON.stringify(result))
    }
    assert.equal(await hashFile(join(root, 'agent-moved.txt')), sentinelHash)
    assert.equal(await exists(join(root, 'agent-copy.txt')), false)
    assert.equal(await exists(join(root, 'agent-directory')), true)
    assert.ok(updates.some((update) => update.tool?.status === 'running'))
    assert.ok(updates.some((update) => update.tool?.status === 'completed'))
    assert.equal(await hashFile(readTarget), sentinelHash)
  })
  await check('agent-cancel-duplicate', '生成中拒绝重复提交、停止生成并回报取消', async () => {
    const request = { conversationId: 'slow', requestId: randomUUID(), text: 'SLOW' }
    const started = new Promise((done) => {
      slowStarted = done
    })
    const pending = agent.send(request, () => {})
    await Promise.race([
      started,
      delay(15_000).then(() => {
        throw new Error('slow request not started')
      })
    ])
    assert.equal((await send('TURN1', 'slow')).status, 'error')
    await agent.stop(request)
    assert.equal((await pending).status, 'cancelled')
  })
  await check('agent-provider-error', '模型 HTTP 失败如实报错且不泄露密钥', async () => {
    const result = await send('ERROR', 'error')
    assert.equal(result.status, 'error')
    assert.equal(result.error.includes('local-windows-test-key'), false)
  })

  window = new BrowserWindow({
    show: false,
    width: 1120,
    height: 800,
    webPreferences: {
      preload: resolve(project, 'out/preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  const uiErrors = []
  window.webContents.on('preload-error', (_event, _path, error) => uiErrors.push(error.message))
  window.webContents.on('render-process-gone', (_event, details) => uiErrors.push(details.reason))
  registerAgentIpc(root)(window.webContents)
  registerCatalogIpc(catalog)(window.webContents)
  registerTasksIpc(tasks)(window.webContents)
  registerImageCompressionIpc()(window.webContents)
  registerProcessingIpc()(window.webContents)
  registerVideoCompressionIpc()(window.webContents)
  registerMoleIpc()
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  await window.loadFile(join(project, 'out/renderer/index.html'))
  await wait(() => evaluate("Boolean(document.querySelector('.composer-input'))"))
  await check('ui-navigation-theme', '真实前端四页面、主题切换、侧栏及 800px 布局', async () => {
    for (const [label, selector] of [
      ['压缩', '#compression-page'],
      ['我的归档', '#archive-page'],
      ['工具箱', '#toolbox-page']
    ]) {
      await evaluate(`document.querySelector('[aria-label="${label}"]').click()`)
      await wait(() => evaluate(`!document.querySelector('${selector}').hidden`))
    }
    await evaluate('document.querySelector(\'[title="夜间模式"]\').click()')
    await wait(() => evaluate("document.documentElement.dataset.theme==='night'"))
    await evaluate('document.querySelector(\'[title="日间模式"]\').click()')
    await wait(() => evaluate("document.documentElement.dataset.theme==='day'"))
    assert.equal(
      await evaluate(
        "getComputedStyle(document.documentElement).getPropertyValue('--page').trim()"
      ),
      '#ffffff'
    )
    for (const width of [800, 1120]) {
      window.setContentSize(width, 760)
      await delay(100)
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    }
    await evaluate('document.querySelector(\'[aria-label="Agent"]\').click()')
    await wait(() => evaluate("!document.querySelector('.chat-main').hidden"))
    await evaluate('document.querySelector(\'[aria-label="收起会话列表"]\').click()')
    await wait(() => evaluate("!document.querySelector('#conversation-sidebar')"))
    await evaluate('document.querySelector(\'[aria-label="展开会话列表"]\').click()')
    await wait(() => evaluate("Boolean(document.querySelector('#conversation-sidebar'))"))
    assert.deepEqual(uiErrors, [])
    await screenshot('ui-chat-white.png')
  })
  await check('ui-agent-send', '真实输入框→preload→IPC→Pi→流式消息渲染', async () => {
    await wait(() => evaluate("!document.querySelector('.composer-input').disabled"))
    await evaluate("document.querySelector('.composer-input').focus()")
    await window.webContents.insertText('UI_STREAM')
    await wait(() => evaluate("!document.querySelector('.send-button').disabled"))
    await evaluate("document.querySelector('.send-button').click()")
    await wait(() => evaluate("document.body.innerText.includes('fixture:UI_STREAM:已完成')"))
  })
  await check('ui-agent-stop', '真实聊天界面的停止按钮取消正在生成的回复', async () => {
    await wait(() => evaluate("!document.querySelector('.composer-input').disabled"))
    await evaluate("document.querySelector('.composer-input').focus()")
    await window.webContents.insertText('SLOW')
    await wait(() => evaluate("!document.querySelector('.send-button').disabled"))
    await evaluate("document.querySelector('.send-button').click()")
    await wait(() => evaluate('Boolean(document.querySelector(\'[aria-label="停止生成"]\'))'))
    await evaluate('document.querySelector(\'[aria-label="停止生成"]\').click()')
    await wait(() => evaluate('!document.querySelector(\'[aria-label="停止生成"]\')'))
    assert.equal(await evaluate("document.querySelector('.composer-input').disabled"), false)
  })
  await check('ui-reduced-motion', '减少动态效果偏好能关闭按钮过渡动画', async () => {
    window.webContents.debugger.attach('1.3')
    try {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
      assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true)
      const durations = await evaluate(
        "getComputedStyle(document.querySelector('.rail-button')).transitionDuration"
      )
      assert.ok(durations.split(',').every((value) => parseFloat(value) <= 0.001))
    } finally {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      window.webContents.debugger.detach()
    }
  })
  await evaluate('document.querySelector(\'[aria-label="压缩"]\').click()')
  await wait(() => evaluate("!document.querySelector('#compression-page').hidden"))
  window.webContents.debugger.attach('1.3')
  const document = await window.webContents.debugger.sendCommand('DOM.getDocument')
  const input = await window.webContents.debugger.sendCommand('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: '#compression-page input[type=file]:not([webkitdirectory])'
  })
  await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
    nodeId: input.nodeId,
    files: [image]
  })
  window.webContents.debugger.detach()
  await wait(() => evaluate("document.querySelectorAll('.compression-row').length===1"))
  await check('ui-windows-filename', 'Windows 文件选择后显示文件名而不是完整路径', async () => {
    assert.equal(
      await evaluate("document.querySelector('.compression-file strong').textContent"),
      basename(image)
    )
  })
  await check('ui-compress-real', '真实前端文件选择→图片压缩→原件备份', async () => {
    dialog.showSaveDialog = () =>
      Promise.resolve({ canceled: false, filePath: join(root, 'ui-compressed.webp') })
    await evaluate("document.querySelector('.compression-confirm input').click()")
    await evaluate("document.querySelector('.compression-primary').click()")
    await wait(
      () =>
        evaluate(
          "Boolean(document.querySelector('.compression-status.done, .compression-status.error'))"
        ),
      30_000
    )
    assert.equal(
      await evaluate("document.querySelector('.compression-status').classList.contains('done')"),
      true,
      String(await evaluate("document.querySelector('.compression-status').textContent"))
    )
    assert.equal(await exists(image), false)
    assert.equal(await exists(join(root, 'ui-compressed.webp')), true)
    assert.equal(
      await evaluate(
        "document.querySelector('.compression-status').textContent.includes('已归档')"
      ),
      true
    )
    const archived = catalog
      .query({ state: 'archived' })
      .items.find((item) => item.outputPath === join(root, 'ui-compressed.webp'))
    assert.ok(archived?.archivePath)
    assert.equal(await exists(archived.archivePath), true)
    await screenshot('ui-compression.png')
  })
  await check('sqlite-restart', '关闭并重开数据库后压缩记录和失败恢复状态保留', async () => {
    const options = {
      databasePath: join(root, 'catalog.db'),
      backupRoot: catalog.backupRoot,
      archiveRoot: catalog.archiveRoot
    }
    const before = catalog.get(archiveId)
    await catalog.close()
    catalog = new Catalog(options)
    setCatalog(catalog)
    await catalog.start()
    assert.equal(catalog.get(archiveId).outputPath, before.outputPath)
    assert.equal(catalog.get(archiveId).backupStatus, before.backupStatus)
    assert.equal(catalog.get(archiveId).backupError, before.backupError)
  })
  await check('fixture-isolation', '只读哨兵未改写，无遗留图片临时目录', async () => {
    assert.equal(await hashFile(readTarget), sentinelHash)
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('.arkive-image-')))
  })
  blocked(
    'live-model',
    '真实模型决策/授权/提示注入行为',
    '未配置模型/API Key；本地响应夹具不能验证模型判断质量。'
  )
  blocked(
    'dji-video',
    '大疆真实视频压缩与画质验收',
    '未提供大疆样本，随包 FFmpeg/ab-av1/SSIMULACRA2 仅支持 macOS arm64。'
  )
  blocked(
    'wechat-dedup',
    '微信目录真实重复扫描与 APFS 无损去重',
    '随包 Czkawka/APFS helper 为 macOS arm64；没有访问用户微信数据。'
  )
  blocked(
    'mail-mole',
    '邮件 App 清理、大文件夹分析及系统提权',
    'Mole/Bash/JXA/系统授权仅支持 macOS；未扫描或清理真实邮件。'
  )
  blocked(
    'finder-tags',
    'Finder 标签写入/重读/双向同步',
    'Windows 没有 Finder/JXA，实际调用保留 tagStatus=error。'
  )
  blocked(
    'automatic-cleanup',
    '压缩后备份自动定期清理',
    '当前未实现定期清理策略，需先确认保留时长和清理规则。'
  )
  blocked(
    'ui-signoff',
    '最终 UI 风格确认及 macOS 原生动效验收',
    '最终风格由用户确认；Windows 不能替代 macOS 字体、标题栏与材质验收。'
  )
}

void main()
  .catch((error) => {
    results.push({
      id: 'suite-fatal',
      title: 'Functional suite setup',
      status: 'failed',
      error: String(error.stack ?? error)
    })
    console.error(error)
  })
  .finally(async () => {
    clearTimeout(deadline)
    agent?.dispose()
    window?.destroy()
    await tasks.close()
    await catalog?.close().catch(() => {})
    if (server) {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    }
    await writeFile(join(root, 'model-requests.json'), JSON.stringify(modelRequests, null, 2))
    await writeFile(join(root, 'functional-results.json'), JSON.stringify(results, null, 2))
    console.log(
      `Functional checks: ${results.filter((result) => result.status === 'passed').length} passed, ${results.filter((result) => result.status === 'failed').length} failed, ${results.filter((result) => result.status === 'blocked').length} blocked`
    )
    app.exit(results.some((result) => result.status === 'failed') ? 1 : 0)
  })
