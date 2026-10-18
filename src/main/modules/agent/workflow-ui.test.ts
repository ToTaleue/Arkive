// Real Electron UI, IPC, Pi loop and Mole adapter; only model HTTP and Mole binary are fixtures.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerAgentIpc } from './ipc'
import { Catalog, setCatalog } from '../catalog/service'
import { registerCatalogIpc } from '../catalog/ipc'
import type { AgentResult, AgentUpdate } from '../../../shared/contracts/agent'

type Message = { role: string; content: string | { type: string; text?: string }[] }
function textOf(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : [])).join('')
}
app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  await app.whenReady()
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/agent-workflow-')
  const moleRoot = join(directory, 'mole-fixture')
  const executable = join(moleRoot, 'resources/tools/darwin-arm64/mole/mo')
  const config = join(homedir(), '.config/mole')
  const calls = join(directory, 'mole-calls.txt')
  const candidate = join(directory, 'generated-cache.txt')
  await mkdir(join(executable, '..'), { recursive: true })
  await mkdir(config, { recursive: true })
  await writeFile(candidate, 'generated fixture, must remain unchanged')
  await writeFile(
    executable,
    `#!/bin/sh
[ "$1" = clean ] && [ "$2" = --dry-run ] || exit 9
printf 'run\\n' >> '${calls}'
printf '➤ Fixture stage one\\nGenerated early output\\n'
sleep 0.3
printf '➤ Fixture stage two\\nGenerated final output\\n'
sleep 0.3
printf '=== Fixture ===\\n${candidate} # 1KB\\n' > '${join(config, 'clean-list.txt')}'
exit 0
`,
    { mode: 0o755 }
  )
  const oldGetAppPath = app.getAppPath.bind(app)
  app.getAppPath = () => moleRoot
  let fixtureFailure: Error | undefined
  let releaseSummary: (() => void) | undefined
  let retryCount = 0
  let holdRetry = false
  let retryToolCall = false
  let retriesWithoutTools = 0
  let sawRecoveredHistory = false
  const requests: unknown[] = []
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk))
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: Message[]
        tools?: { function: { name: string } }[]
      }
      requests.push(body)
      const summaryOnly = !body.tools?.length
      if (summaryOnly) {
        retriesWithoutTools++
        const summaryUser = body.messages.filter((message) => message.role === 'user').at(-1)
        assert.ok(summaryUser)
        const saved = JSON.parse(textOf(summaryUser)) as {
          results: { name: string; status: string; result: { details: string } }[]
        }
        assert.equal(saved.results[0].name, 'mole_clean_preview')
        assert.equal(saved.results[0].status, 'completed')
        assert.ok(saved.results[0].result.details.includes(candidate))
      } else assert.equal(body.tools?.length, 28)
      const lastUser = body.messages.filter((message) => message.role === 'user').at(-1)
      assert.ok(lastUser)
      const scenario = textOf(lastUser)
      const hasTool = body.messages.some((message) => message.role === 'tool')
      if (scenario === 'UI_FAIL' && hasTool) {
        response.writeHead(401, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'invalid workflow-secret-key' } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta: unknown, finishReason: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: 'workflow',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'workflow-model',
            choices: [{ index: 0, delta, finish_reason: finishReason }]
          })}\n\n`
        )
      }
      const finish = (text: string, reason = 'stop'): void => {
        if (text) chunk({ content: text })
        chunk({}, reason)
        response.end('data: [DONE]\n\n')
      }
      chunk({ role: 'assistant', content: '' })
      if (summaryOnly) {
        retryCount++
        if (retryToolCall) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'forbidden-retry-tool',
                type: 'function',
                function: {
                  name: 'mkdir',
                  arguments: JSON.stringify({ path: join(directory, 'must-not-exist') })
                }
              }
            ]
          })
          finish('', 'tool_calls')
          return
        }
        if (holdRetry) return
        finish(retryCount === 1 ? '' : '仅重述既有结果：预览完成，未删除文件。')
      } else if (scenario === 'UI_CHAT') {
        sawRecoveredHistory = body.messages.some((message) =>
          textOf(message).includes('仅重述既有结果')
        )
        finish('可以继续对话。')
      } else if (!hasTool) {
        chunk({ content: '先运行预览，再汇报结果。' })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `tool-${scenario}`,
              type: 'function',
              function: { name: 'mole_clean_preview', arguments: '{}' }
            }
          ]
        })
        finish('', 'tool_calls')
      } else if (scenario === 'UI_PREVIEW') {
        releaseSummary = () => {
          finish('最终总结：发现测试候选，没有删除文件。')
        }
      } else if (scenario === 'UI_TRUNCATED') finish('未完成的总结片段', 'length')
      else finish('')
    } catch (error) {
      fixtureFailure = error instanceof Error ? error : new Error(String(error))
      response.destroy()
    }
  }
  const server = createServer((request, response) => {
    void respond(request, response)
  })
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  Object.assign(process.env, {
    ARKIVE_AI_PROVIDER: 'openai-compatible',
    ARKIVE_AI_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
    ARKIVE_AI_MODEL: 'workflow-model',
    ARKIVE_AI_API_KEY: 'workflow-secret-key'
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
  ipcMain.handle('mole:authorization-status', () => ({ authorized: false }))
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })
  async function evaluate<T>(expression: string): Promise<T> {
    return (await window.webContents.executeJavaScript(expression)) as T
  }
  const scope = '.conversation-view:not([hidden])'
  async function wait(expression: string): Promise<void> {
    const deadline = Date.now() + 15_000
    while (!(await evaluate<boolean>(expression))) {
      if (fixtureFailure) throw fixtureFailure
      assert.ok(
        Date.now() < deadline,
        `Timeout: ${expression}\n${await evaluate<string>('document.body.innerText')}`
      )
      await delay(30)
    }
  }
  async function send(text: string): Promise<void> {
    await wait(`!document.querySelector('${scope} [aria-label="输入消息"]').disabled`)
    await evaluate(`(()=>{const input=document.querySelector('${scope} [aria-label="输入消息"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});
      input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await wait(`!document.querySelector('${scope} [aria-label="发送消息"]').disabled`)
    await evaluate(`document.querySelector('${scope} [aria-label="发送消息"]').click()`)
  }
  async function fresh(): Promise<void> {
    await evaluate("document.querySelector('.new-conversation').click()")
  }
  async function complete(): Promise<void> {
    await wait(`document.querySelector('${scope} [aria-label="停止生成"]')===null`)
  }
  async function eventList(): Promise<AgentUpdate[]> {
    return evaluate('window.integrationEvents')
  }
  try {
    await window.loadFile(resolve('out/renderer/index.html'))
    await evaluate(
      'window.integrationEvents=[];window.api.agent.onUpdate(event=>window.integrationEvents.push(event));true'
    )
    await send('UI_PREVIEW')
    await wait(
      `document.querySelector('${scope} .chat-tool-stage')?.innerText.includes('Fixture stage one')`
    )
    await wait(
      `document.querySelector('${scope} .chat-tool-log')?.innerText.includes('Generated early output')`
    )
    assert.equal(
      await evaluate<boolean>(`document.querySelector('${scope} .chat-tool-activity').open`),
      true
    )
    await wait(
      `document.querySelector('${scope} .chat-execution[data-phase="summarizing"] .chat-tool-result')?.innerText.includes('预览已完成')`
    )
    await wait('window.integrationEvents.some(e=>e.tool?.result)')
    assert.ok(releaseSummary)
    assert.equal(await readFile(calls, 'utf8'), 'run\n')
    assert.equal(
      await evaluate<boolean>(
        `document.querySelector('${scope} .assistant-message-content').innerText.includes('最终总结')`
      ),
      false
    )
    await writeFile(
      join(directory, 'result-before-summary.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    releaseSummary()
    await complete()
    await wait(
      `document.querySelector('${scope} .assistant-message-content').innerText.includes('最终总结')`
    )
    assert.equal(
      await evaluate<boolean>(`document.querySelector('${scope} .chat-tool-activity').open`),
      false
    )
    assert.equal(
      await evaluate<boolean>(
        `document.querySelector('${scope} .assistant-message-content').innerText.includes('先运行预览')`
      ),
      false
    )
    await send('UI_CHAT')
    await complete()
    assert.equal(
      await evaluate<number>(`document.querySelectorAll('${scope} .chat-tool-result').length`),
      1
    )
    await fresh()
    await send('UI_EMPTY')
    await complete()
    await wait(
      `document.querySelector('${scope} .chat-execution[data-phase="summary-error"]')!==null`
    )
    assert.equal(
      await evaluate<number>(`document.querySelectorAll('${scope} .chat-tool-result').length`),
      1
    )
    await writeFile(
      join(directory, 'summary-empty.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    const events = await eventList()
    const source = events.at(-1)
    assert.ok(source)
    const retryCountBefore = await readFile(calls, 'utf8')
    await evaluate(`document.querySelector('${scope} .chat-summary-retry button').click()`)
    await complete()
    await wait(`document.querySelector('${scope} .chat-summary-retry button')!==null`)
    assert.equal(await readFile(calls, 'utf8'), retryCountBefore)
    await evaluate(`document.querySelector('${scope} .chat-summary-retry button').click()`)
    await complete()
    await wait(
      `document.querySelector('${scope} .assistant-message-content').innerText.includes('仅重述既有结果')`
    )
    assert.equal(retriesWithoutTools, 2)
    assert.equal(await readFile(calls, 'utf8'), retryCountBefore)
    const retryEvents = (await eventList()).filter(
      (event) =>
        event.conversationId === source.conversationId && event.requestId !== source.requestId
    )
    assert.ok(retryEvents.length)
    assert.ok(retryEvents.every((event) => !event.tool))
    assert.equal(
      await evaluate<number>(`document.querySelectorAll('${scope} .assistant-message').length`),
      1
    )
    await send('UI_CHAT')
    await complete()
    assert.ok(sawRecoveredHistory, 'Recovered summary is included in subsequent model context')
    assert.equal(
      await evaluate<number>(`document.querySelectorAll('${scope} .chat-tool-result').length`),
      1
    )
    const invalid = await evaluate<AgentResult>(
      `window.api.agent.retrySummary({conversationId:${JSON.stringify(source.conversationId)},requestId:'missing-summary',sourceRequestId:'missing'})`
    )
    assert.equal(invalid.status, 'error')
    await fresh()
    await send('UI_FAIL')
    await complete()
    await wait(
      `document.querySelector('${scope} .chat-execution[data-phase="summary-error"]')!==null`
    )
    assert.equal(
      await evaluate<number>(`document.querySelectorAll('${scope} .chat-tool-result').length`),
      1
    )
    assert.ok(
      !(await evaluate<boolean>(
        `document.querySelector('${scope} .chat-summary-error').innerText.includes('workflow-secret-key')`
      ))
    )
    holdRetry = true
    await evaluate(`document.querySelector('${scope} .chat-summary-retry button').click()`)
    await wait(`document.querySelector('${scope} [aria-label="停止生成"]')!==null`)
    await evaluate(`document.querySelector('${scope} [aria-label="停止生成"]').click()`)
    await complete()
    await wait(`document.querySelector('${scope} .chat-execution[data-phase="cancelled"]')!==null`)
    assert.equal(
      await evaluate<number>(`document.querySelectorAll('${scope} .chat-tool-result').length`),
      1
    )
    await fresh()
    await send('UI_TRUNCATED')
    await complete()
    await wait(
      `document.querySelector('${scope} .chat-execution[data-phase="summary-error"]')!==null`
    )
    retryToolCall = true
    holdRetry = false
    await evaluate(`document.querySelector('${scope} .chat-summary-retry button').click()`)
    await complete()
    await wait(
      `document.querySelector('${scope} .chat-execution[data-phase="summary-error"]')!==null`
    )
    await assert.rejects(access(join(directory, 'must-not-exist')))
    assert.equal(await readFile(candidate, 'utf8'), 'generated fixture, must remain unchanged')
    assert.equal((await readFile(calls, 'utf8')).split('run\n').length - 1, 4)
    await writeFile(join(directory, 'events.json'), JSON.stringify(await eventList(), null, 2))
    await writeFile(join(directory, 'requests.json'), JSON.stringify(requests, null, 2))
    await writeFile(
      join(directory, 'summary-truncated.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    assert.deepEqual(errors, [])
    if (fixtureFailure) throw fixtureFailure
    console.log(
      `PASS: streaming progress, immediate result before summary, preamble separation, empty/error/truncated summary, summary-only retries without tool replay, retry cancellation, recovered context and retained history. Evidence: ${directory}`
    )
  } finally {
    window.destroy()
    await catalog.close()
    app.getAppPath = oldGetAppPath
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
