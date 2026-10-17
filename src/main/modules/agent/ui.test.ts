// The model HTTP boundary is deterministic; UI, SDK, IPC, tools and files are real.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import sharp from 'sharp'
import { registerAgentIpc } from './ipc'
import { Catalog, setCatalog } from '../catalog/service'
import { registerCatalogIpc } from '../catalog/ipc'
import { registerMoleIpc } from '../mole/ipc'
import { hashFile } from '../catalog/files'
import type { AgentUpdate } from '../../../shared/contracts/agent'

type Message = { role: string; content: string | { type: string; text?: string }[] }
function textOf(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('')
}
app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  await app.whenReady()
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/agent-ui-')
  const image = join(directory, 'UI 生成图片.png'),
    output = join(directory, 'result.webp'),
    broken = join(directory, 'broken.pdf')
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#90ab80' } })
    .png({ compressionLevel: 0 })
    .toFile(image)
  const sourceHash = await hashFile(image)
  await writeFile(broken, 'generated invalid PDF')
  let fixtureFailure: Error | undefined
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk))
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: Message[]
        tools: { function: { name: string } }[]
      }
      assert.equal(body.tools.length, 28)
      assert.ok(!body.tools.some((t) => ['bash', 'write', 'edit'].includes(t.function.name)))
      const user = body.messages.filter((m) => m.role === 'user').at(-1)
      assert.ok(user)
      const scenario = textOf(user)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      function chunk(delta: unknown, finishReason: string | null = null): void {
        response.write(
          `data: ${JSON.stringify({ id: 'ui-fixture', object: 'chat.completion.chunk', created: 1, model: 'ui-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
        )
      }
      chunk({ role: 'assistant', content: '' })
      if (scenario === 'UI_SLOW') {
        chunk({ content: '正在解释压缩原理…' })
        // Leave this response open until the SDK aborts it.
        return
      }
      const result = body.messages.filter((m) => m.role === 'tool').at(-1)
      if (result) {
        if (scenario === 'UI_COMPRESS_AUTH')
          assert.match(textOf(result), /"archive":\{"status":"ready"/)
        if (scenario === 'UI_BAD_PDF') assert.match(textOf(result), /PDF/)
        chunk({
          content:
            scenario === 'UI_BAD_PDF'
              ? 'PDF 探测失败，未修改文件。'
              : '压缩、备份、归档及标签已完成。'
        })
        chunk({}, 'stop')
      } else if (scenario === 'UI_COMPRESS_AUTH' || scenario === 'UI_BAD_PDF') {
        const name = scenario === 'UI_COMPRESS_AUTH' ? 'compress_image' : 'inspect_pdf'
        const args =
          scenario === 'UI_COMPRESS_AUTH'
            ? { inputPath: image, outputPath: output, archive: true, tags: ['UI 联调'] }
            : { inputPath: broken }
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `tool-${scenario}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        })
        chunk({}, 'tool_calls')
      } else {
        chunk({ content: '可以继续。' })
        chunk({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
    } catch (error) {
      fixtureFailure = error instanceof Error ? error : new Error('Model HTTP fixture failed')
      response.destroy()
    }
  }
  const server = createServer((req, res) => {
    void respond(req, res)
  })
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${String(address.port)}/v1`
  Object.assign(process.env, {
    ARKIVE_AI_PROVIDER: 'openai-compatible',
    ARKIVE_AI_BASE_URL: base,
    ARKIVE_AI_MODEL: 'ui-model',
    ARKIVE_AI_API_KEY: 'ui-local-key'
  })
  const catalog = new Catalog({
    databasePath: join(directory, 'catalog.db'),
    backupRoot: join(directory, 'Backup'),
    archiveRoot: join(directory, 'Archive')
  })
  setCatalog(catalog)
  await catalog.start()
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  registerAgentIpc(directory)(window.webContents)
  registerCatalogIpc(catalog)(window.webContents)
  registerMoleIpc()
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  const evaluate = async <T>(expression: string): Promise<T> => {
    try {
      const result: unknown = await window.webContents.executeJavaScript(expression)
      return result as T
    } catch (error) {
      throw new Error(`Renderer check failed: ${expression}; console: ${errors.join('\n')}`, {
        cause: error
      })
    }
  }
  const scope = '.conversation-view:not([hidden])'
  async function wait(expression: string): Promise<void> {
    const deadline = Date.now() + 45_000
    while (!(await evaluate<boolean>(expression))) {
      assert.ok(
        Date.now() < deadline,
        `Timeout: ${expression}\n${await evaluate<string>('document.body.innerText')}`
      )
      await delay(50)
    }
  }
  async function send(text: string): Promise<void> {
    await wait(`!document.querySelector('${scope} [aria-label="输入消息"]').disabled`)
    await evaluate(
      `(()=>{const e=document.querySelector('${scope} [aria-label="输入消息"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
    await wait(`!document.querySelector('${scope} [aria-label="发送消息"]').disabled`)
    await evaluate(`document.querySelector('${scope} [aria-label="发送消息"]').click()`)
    await wait(
      `document.querySelector('${scope} .message-list').innerText.includes(${JSON.stringify(text)}) && document.querySelector('${scope} [aria-label="输入消息"]').value===''`
    )
  }
  async function complete(): Promise<void> {
    await wait(`document.querySelector('${scope} [aria-label="停止生成"]')===null`)
  }
  async function fresh(): Promise<void> {
    await evaluate('document.querySelector(\'[aria-label="新对话"]\').click()')
  }
  try {
    await window.loadFile(resolve('out/renderer/index.html'))
    await evaluate(
      'window.integrationEvents=[];window.api.agent.onUpdate(e=>window.integrationEvents.push(e));true'
    )
    await send('UI_COMPRESS_AUTH')
    await complete()
    const item = catalog.query({ tags: ['UI 联调'] }).items[0]
    assert.ok(item.archivePath)
    assert.equal(await hashFile(item.backupPath ?? ''), sourceHash)
    assert.equal(await hashFile(item.archivePath), await hashFile(output))
    await assert.rejects(access(image))
    await evaluate(`document.querySelector('${scope} .chat-tool-activity').open=true`)
    assert.equal(
      await evaluate<boolean>(
        `document.querySelector('${scope} [aria-label="工具执行状态"]').innerText.includes('compress_image')`
      ),
      true
    )
    assert.equal(
      await evaluate<boolean>(`document.querySelector('${scope} [data-status="running"]')===null`),
      true
    )
    const events = await evaluate<AgentUpdate[]>('window.integrationEvents')
    assert.ok(events.some((e) => e.tool?.status === 'running'))
    assert.ok(events.some((e) => e.tool?.status === 'completed'))
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
    )
    await writeFile(
      join(directory, 'tool-success.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    // Agent changes must immediately appear through the existing catalog UI.
    await evaluate('document.querySelector(\'[aria-label="我的归档"]\').click()')
    await wait("document.querySelector('#archive-page').innerText.includes('UI 生成图片.png')")
    await evaluate('document.querySelector(\'[aria-label="新对话"]\').click()')
    await send('UI_BAD_PDF')
    await complete()
    await evaluate(`document.querySelector('${scope} .chat-tool-activity').open=true`)
    await wait(
      `document.querySelector('${scope} [data-status="error"]')?.innerText.includes('inspect_pdf')`
    )
    assert.equal(await readFile(broken, 'utf8'), 'generated invalid PDF')
    await fresh()
    await send('UI_SLOW')
    await wait(`document.querySelector('${scope} .message-list').innerText.includes('正在解释')`)
    await evaluate(`document.querySelector('${scope} [aria-label="停止生成"]').click()`)
    await complete()
    await wait(`document.querySelector('${scope} .chat-notice')?.innerText.includes('不会回滚')`)
    await send('UI_RETRY')
    await complete()
    await wait(`document.querySelector('${scope} .message-list').innerText.includes('可以继续')`)
    // Same real SDK DNS failure as the live-model environment, shown in the actual UI.
    process.env.ARKIVE_AI_BASE_URL = 'https://arkive-ui-test.invalid/v1'
    await fresh()
    await send('UI_DNS')
    await complete()
    await wait(`document.querySelector('${scope} .chat-error')?.innerText.includes('DNS')`)
    assert.ok(
      !(await evaluate<boolean>(
        `document.querySelector('${scope} .chat-error').innerText.includes('ui-local-key')`
      ))
    )
    await writeFile(
      join(directory, 'dns-error.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    // Replace only the external Mole process with generated output. Never scan user directories.
    const oldGetAppPath = app.getAppPath.bind(app)
    const moleRoot = join(directory, 'mole-fixture')
    const moleExecutable = join(moleRoot, 'resources/tools/darwin-arm64/mole/mo')
    const calls = join(directory, 'mole-calls.txt')
    await mkdir(join(moleExecutable, '..'), { recursive: true })
    const moleScript = (exit: number): string =>
      `#!/bin/sh\n[ "$1" = clean ] && [ "$2" = --dry-run ] || exit 9\nprintf 'run\\n' >> '${calls}'\nprintf '➤ System caches\\nGenerated first chapter\\n'\nsleep 1\nprintf '➤ Application caches\\nGenerated second chapter\\n'\nsleep 1\nexit ${String(exit)}\n`
    try {
      app.getAppPath = () => moleRoot
      await writeFile(moleExecutable, moleScript(0), { mode: 0o755 })
      const cleanButton = '.mole-tabs button:first-child'
      await evaluate(`document.querySelector('${cleanButton}').click()`)
      await wait(`document.querySelector('${cleanButton}').disabled`)
      await evaluate(`document.querySelector('${cleanButton}').click()`)
      await wait(
        "document.querySelector('.mole-demo').innerText.includes('Generated first chapter')"
      )
      assert.equal(
        await evaluate<boolean>(`document.querySelector('${cleanButton}').disabled`),
        true
      )
      await wait("document.querySelector('.mole-demo-result')?.innerText.includes('未执行清理')")
      assert.equal(await readFile(calls, 'utf8'), 'run\n')
      assert.equal(
        await evaluate<number>("document.querySelectorAll('.mole-output-block').length"),
        2
      )
      await writeFile(moleExecutable, moleScript(2), { mode: 0o755 })
      await evaluate(`document.querySelector('${cleanButton}').click()`)
      await wait("document.querySelector('.mole-demo-error')?.innerText.includes('预览失败')")
      assert.equal(await readFile(calls, 'utf8'), 'run\nrun\n')
      assert.equal(
        await evaluate<boolean>(
          "document.querySelector('.mole-output').innerText.includes('内容可能不完整')"
        ),
        true
      )
      await evaluate("document.querySelector('.mole-demo-error').scrollIntoView({block:'center'})")
      await evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
      )
      await writeFile(
        join(directory, 'mole-partial.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      const installer = join(directory, 'generated-installer.dmg')
      const purge = join(directory, 'generated-project/node_modules')
      const fixtureApp = join(directory, 'Generated Fixture.app')
      await writeFile(installer, 'disposable generated installer')
      await mkdir(purge, { recursive: true })
      await writeFile(join(purge, 'generated.txt'), 'disposable build output')
      await mkdir(fixtureApp)
      const config = join(homedir(), '.config/mole')
      await mkdir(config, { recursive: true })
      await writeFile(
        moleExecutable,
        `#!/bin/sh
case "$1" in
clean) printf '=== Fixture ===\\n${installer} # 1KB\\n' > '${join(config, 'clean-list.txt')}'; printf '➤ Fixture\\npreview only\\n';;
analyze) printf '{"scan_status":"complete","entries":[]}';;
installer) [ ! -e '${installer}' ] || printf 'Found installer: ${installer}\\n';;
purge) [ ! -d '${purge}' ] || printf '✓ [DRY RUN] ${purge}, 1KB\\n';;
uninstall) if [ -d '${fixtureApp}' ]; then printf '%s' '${JSON.stringify([{ name: 'Generated Fixture', bundle_id: 'dev.arkive.fixture', source: 'App', uninstall_name: 'Generated Fixture', path: fixtureApp, size: '1KB' }])}'; else printf '[]'; fi;;
*) exit 9;;
esac
exit 0
`,
        { mode: 0o755 }
      )
      await evaluate(`document.querySelector('${cleanButton}').click()`)
      await wait('document.querySelector(\'[aria-label="Mole 候选清单"] input\')!==null')
      await access(installer)
      const candidate = '[aria-label="Mole 候选清单"]'
      assert.equal(
        await evaluate<boolean>(`document.querySelector('${candidate} button').disabled`),
        true
      )
      await evaluate("document.querySelector('.mole-tabs button:nth-child(3)').click()")
      await wait(
        "document.querySelector('.mole-demo-result')?.innerText.includes('安装包预览已结束')"
      )
      await evaluate(`document.querySelector('${candidate} input').click()`)
      await evaluate(`document.querySelector('${candidate} button').click()`)
      await wait(
        "document.querySelector('.mole-demo-result')?.innerText.includes('已移入回收站 1 项')"
      )
      await assert.rejects(access(installer))
      await access(purge)
      await access(fixtureApp)
      await wait("!document.querySelector('.mole-tabs button:nth-child(4)').disabled")
      await evaluate("document.querySelector('.mole-tabs button:nth-child(4)').click()")
      await wait(`document.querySelector('${candidate} input')!==null`)
      assert.ok(
        await evaluate<boolean>(
          "document.querySelector('.mole-demo-note').innerText.includes('联网')"
        )
      )
      await evaluate(`document.querySelector('${candidate} input').click()`)
      await evaluate(`document.querySelector('${candidate} button').click()`)
      await wait(`document.querySelector('${candidate}')===null`)
      await assert.rejects(access(purge))
      await access(fixtureApp)
      await wait("!document.querySelector('.mole-tabs button:nth-child(5)').disabled")
      await evaluate("document.querySelector('.mole-tabs button:nth-child(5)').click()")
      const apps = '[aria-label="已安装应用清单"]'
      await wait(`document.querySelector('${apps} input')!==null`)
      await evaluate(`document.querySelector('${apps} input').click()`)
      await evaluate(`document.querySelector('${apps} button').click()`)
      await wait(`document.querySelector('${apps}')===null`)
      await assert.rejects(access(fixtureApp))
      await wait("!document.querySelector('.mole-tabs button:nth-child(2)').disabled")
      await evaluate("document.querySelector('.mole-tabs button:nth-child(2)').click()")
      await wait("document.querySelector('.mole-analyze-output')?.innerText.includes('complete')")
      await writeFile(
        join(directory, 'mole-candidates.png'),
        (await window.webContents.capturePage()).toPNG()
      )
    } finally {
      app.getAppPath = oldGetAppPath
    }
    assert.deepEqual(errors, [])
    if (fixtureFailure) throw fixtureFailure
    console.log(
      `PASS: real chat UI → SDK → 28-tool registration → compression/backup/archive/tags, cross-page catalog, tool success/error, stop/retry, DNS error; Mole UI streaming, double-click guard and partial exit (synthetic process). Evidence: ${directory}`
    )
  } finally {
    window.destroy()
    await catalog.close()
    server.closeAllConnections()
    await new Promise<void>((done) => {
      server.close(() => {
        done()
      })
    })
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
