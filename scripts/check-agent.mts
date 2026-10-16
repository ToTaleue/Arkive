// Real Pi SDK + local streaming HTTP fixture; no external key or network needed.
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'vite'
import type { AgentService as Service } from '../src/main/modules/agent/service'
import type { AgentResult, AgentUpdate } from '../src/shared/contracts/agent'

type FixtureMessage = { role: string; content: string | { type: string; text?: string }[] }
type FixtureRequest = {
  stream: boolean
  tools?: { function: { name: string } }[]
  messages: FixtureMessage[]
}
type FixtureDelta = {
  role?: string
  content?: string
  tool_calls?: {
    index: number
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}
const enabledTools = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'mole_clean_preview']
const toolFile = 'agent-tool-check.txt'
const toolCalls = [
  { name: 'write', arguments: { path: toolFile, content: 'before-tool-edit\n' } },
  {
    name: 'edit',
    arguments: {
      path: toolFile,
      edits: [{ oldText: 'before-tool-edit', newText: 'after-tool-edit' }]
    }
  },
  { name: 'read', arguments: { path: toolFile } },
  { name: 'ls', arguments: { path: '.' } },
  { name: 'find', arguments: { pattern: toolFile, path: '.' } },
  { name: 'grep', arguments: { pattern: 'after-tool-edit', path: toolFile } }
]
function messageText(message: FixtureMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
}

await mkdir('out', { recursive: true })
const buildDir = await mkdtemp(resolve('out/agent-check-'))
const moleModeFile = resolve(buildDir, 'mole-mode')
const moleStartedFile = resolve(buildDir, 'mole-started')
const moleArgumentsFile = resolve(buildDir, 'mole-arguments.json')
const requests: FixtureRequest[] = []
let serverFailure: unknown
const server = createServer((request, response) => {
  void handleRequest(request, response)
})
async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer local-test-key')
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      assert.ok(Buffer.isBuffer(chunk))
      chunks.push(chunk)
    }
    // The fixture consumes our Pi SDK's Chat Completions request shape.
    const body = JSON.parse(Buffer.concat(chunks).toString()) as FixtureRequest
    requests.push(body)
    assert.equal(body.stream, true)
    assert.deepEqual(
      body.tools?.map((tool) => tool.function.name).sort(),
      [...enabledTools].sort(),
      'Only the six filesystem tools and Mole preview may be sent'
    )
    const users = body.messages
      .filter((message) => message.role === 'user')
      .map((message) => ({
        ...message,
        content: messageText(message)
      }))
    const last = users.at(-1)?.content
    if (last === 'FAIL') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { message: 'invalid local-test-key', type: 'authentication_error' }
        })
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta: FixtureDelta, finishReason: string | null = null): void => {
      response.write(
        `data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
      )
    }
    send({ role: 'assistant', content: '' })
    if (last?.startsWith('MOLE')) {
      const result = body.messages.find((message) => message.role === 'tool')
      if (!result) {
        send({
          tool_calls: [
            {
              index: 0,
              id: 'mole-preview-check',
              type: 'function',
              function: { name: 'mole_clean_preview', arguments: '{}' }
            }
          ]
        })
        send({}, 'tool_calls')
      } else {
        const text = messageText(result)
        if (last === 'MOLE_FAIL') {
          assert.match(text, /Mole 清理预览失败/)
          assert.ok(text.includes('"exitCode":7'))
          assert.ok(text.includes('fixture failure'))
          send({ content: '预览失败，不能声称已清理' })
        } else {
          assert.ok(text.includes('"dryRun":true'))
          assert.ok(text.includes('"exitCode":0'))
          assert.ok(text.includes('Mole preview fixture'))
          assert.ok(text.includes('fixture warning'))
          send({ content: '清理预览完成，尚未释放空间' })
        }
        send({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
      return
    }
    if (last === 'TOOLS') {
      const results = body.messages.filter((message) => message.role === 'tool')
      const call = toolCalls[results.length]
      if (call) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `tool-check-${results.length}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }
          ]
        })
        send({}, 'tool_calls')
      } else {
        assert.equal(results.length, toolCalls.length)
        assert.match(messageText(results[0]), /Successfully wrote/)
        assert.match(messageText(results[1]), /Successfully replaced/)
        assert.match(messageText(results[2]), /after-tool-edit/)
        assert.ok(messageText(results[3]).includes(toolFile), 'ls finds the created file')
        assert.ok(messageText(results[4]).includes(toolFile), 'find locates the created file')
        assert.match(messageText(results[5]), /after-tool-edit/)
        send({ content: '工具验证完成' })
        send({}, 'stop')
      }
      response.end('data: [DONE]\n\n')
      return
    }
    if (last === 'SLOW') {
      send({ content: '部分回复' })
      const timer = setTimeout(() => {
        send({}, 'stop')
        response.end('data: [DONE]\n\n')
      }, 10_000)
      response.on('close', () => clearTimeout(timer))
      return
    }
    const answer = `用户轮次=${users.length}；首条=${users[0]?.content}`
    send({ content: answer.slice(0, 5) })
    send({ content: answer.slice(5) })
    send({}, 'stop')
    response.end('data: [DONE]\n\n')
  } catch (error) {
    serverFailure = error
    response.writeHead(500)
    response.end('fixture failed')
  }
}

let service: Service | undefined
try {
  // Exercise the real process/adapter/service/tool chain without scanning the user's Mac.
  const moleDir = resolve(buildDir, 'resources/tools/darwin-arm64/mole')
  await mkdir(moleDir, { recursive: true })
  await writeFile(
    resolve(moleDir, 'mo'),
    `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(moleArgumentsFile)}, JSON.stringify(args))
if (JSON.stringify(args) !== JSON.stringify(['clean', '--dry-run'])) process.exit(99)
const mode = fs.readFileSync(${JSON.stringify(moleModeFile)}, 'utf8')
fs.writeFileSync(${JSON.stringify(moleStartedFile)}, 'started')
if (mode === 'slow') {
  setTimeout(() => process.exit(0), 60000)
} else if (mode === 'fail') {
  process.stderr.write('fixture failure\\n')
  process.exitCode = 7
} else {
  process.stdout.write('Mole preview fixture\\n')
  process.stderr.write('fixture warning\\n')
}
`,
    { mode: 0o755 }
  )
  await writeFile(
    resolve(buildDir, 'electron-fixture.mjs'),
    `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(buildDir)} }`
  )
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  Object.assign(process.env, {
    ARKIVE_AI_PROVIDER: 'openai-compatible',
    ARKIVE_AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    ARKIVE_AI_MODEL: 'local-model',
    ARKIVE_AI_API_KEY: 'local-test-key'
  })
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { electron: resolve(buildDir, 'electron-fixture.mjs') } },
    build: {
      ssr: true,
      target: 'node22',
      outDir: buildDir,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          service: resolve('src/main/modules/agent/service.ts'),
          contracts: resolve('src/shared/contracts/agent.ts'),
          config: resolve('src/main/modules/agent/config.ts')
        },
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  })
  const { AgentService } = (await import(
    pathToFileURL(resolve(buildDir, 'service.mjs')).href
  )) as typeof import('../src/main/modules/agent/service')
  const { isAgentRequest } = (await import(
    pathToFileURL(resolve(buildDir, 'contracts.mjs')).href
  )) as typeof import('../src/shared/contracts/agent')
  const { agentStatus } = (await import(
    pathToFileURL(resolve(buildDir, 'config.mjs')).href
  )) as typeof import('../src/main/modules/agent/config')
  assert.equal(isAgentRequest({ conversationId: 'a', requestId: 'a1', text: 'hello' }), true)
  assert.equal(isAgentRequest({ conversationId: '../bad', requestId: 'a1', text: 'hello' }), false)
  assert.equal(isAgentRequest({ conversationId: 'a', requestId: 'a1', text: ' '.repeat(2) }), false)
  assert.equal(
    isAgentRequest({ conversationId: 'a', requestId: 'a1', text: 'x'.repeat(32_001) }),
    false
  )
  assert.equal(JSON.stringify(agentStatus()).includes('local-test-key'), false)
  const currentService = new AgentService(buildDir)
  service = currentService
  const updates: AgentUpdate[] = []
  const send = (conversationId: string, requestId: string, text: string): Promise<AgentResult> =>
    currentService.send({ conversationId, requestId, text }, (update) => {
      updates.push(update)
    })
  assert.deepEqual(await send('a', 'a1', '记住：松果'), {
    status: 'completed',
    text: '用户轮次=1；首条=记住：松果'
  })
  assert.deepEqual(await send('a', 'a2', '我刚才说了什么？'), {
    status: 'completed',
    text: '用户轮次=2；首条=记住：松果'
  })
  const second = requests[1].messages
  assert.ok(
    second.some(
      (message) => message.role === 'assistant' && messageText(message).includes('用户轮次=1')
    ),
    'Previous assistant reply is sent in the next model request'
  )
  assert.deepEqual(await send('b', 'b1', '独立会话'), {
    status: 'completed',
    text: '用户轮次=1；首条=独立会话'
  })
  assert.equal(updates.filter((update) => update.requestId === 'a1').length, 2)

  assert.deepEqual(await send('tools', 'tools1', 'TOOLS'), {
    status: 'completed',
    text: '工具验证完成'
  })
  assert.equal(await readFile(resolve(buildDir, toolFile), 'utf8'), 'after-tool-edit\n')

  await writeFile(moleModeFile, 'success')
  assert.deepEqual(await send('mole', 'mole1', 'MOLE'), {
    status: 'completed',
    text: '清理预览完成，尚未释放空间'
  })
  assert.equal(await readFile(moleArgumentsFile, 'utf8'), '["clean","--dry-run"]')
  await writeFile(moleModeFile, 'fail')
  assert.deepEqual(await send('mole-failure', 'mole2', 'MOLE_FAIL'), {
    status: 'completed',
    text: '预览失败，不能声称已清理'
  })
  await rm(moleStartedFile)
  await writeFile(moleModeFile, 'slow')
  const molePending = send('mole-cancel', 'mole3', 'MOLE_CANCEL')
  let moleStarted = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await access(moleStartedFile)
      moleStarted = true
      break
    } catch {
      await delay(20)
    }
  }
  assert.ok(moleStarted, 'Mole fixture process started before cancellation')
  await currentService.stop({ conversationId: 'mole-cancel', requestId: 'mole3' })
  assert.equal((await molePending).status, 'cancelled')

  const slow = currentService.send(
    { conversationId: 'a', requestId: 'slow', text: 'SLOW' },
    (update) => {
      updates.push(update)
      if (update.text) void currentService.stop({ conversationId: 'a', requestId: 'slow' })
    }
  )
  const duplicate = await send('a', 'duplicate', '不要重复发送')
  assert.equal(duplicate.status, 'error')
  assert.equal((await slow).status, 'cancelled')
  assert.equal((await send('a', 'after-stop', '继续')).status, 'completed')

  const failed = await send('a', 'failed', 'FAIL')
  assert.ok(failed.status === 'error')
  assert.equal(failed.error.includes('local-test-key'), false)
  assert.equal((await send('a', 'after-failure', '再次继续')).status, 'completed')

  const pending = send('new', 'early-stop', '未开始就取消')
  await currentService.stop({ conversationId: 'new', requestId: 'early-stop' })
  assert.equal((await pending).status, 'cancelled')
  delete process.env.ARKIVE_AI_API_KEY
  assert.equal(agentStatus().configured, false)
  assert.equal((await send('missing-key', 'no-key', '你好')).status, 'error')
  currentService.dispose()
  assert.equal((await send('a', 'closed', '你好')).status, 'error')
  if (serverFailure) throw serverFailure
  console.log(
    'PASS: Tool allowlist, real filesystem tools, Mole preview process arguments/results/failure/cancellation, Pi streaming, multi-turn history, conversation isolation, duplicate sends, cancellation, recovery, missing key, validation and key redaction.'
  )
} finally {
  service?.dispose()
  server.closeAllConnections()
  await new Promise<void>((done) => {
    server.close(() => {
      done()
    })
  })
  await rm(buildDir, { recursive: true, force: true })
}
