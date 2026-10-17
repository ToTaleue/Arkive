import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentService } from '../agent/service'
import { closeCloneDeduplication } from './service'
import type { CloneDeduplicationResult } from '../../../shared/contracts/clone-deduplication'
import type { DuplicateScanResult } from '../../../shared/contracts/duplicates'
import type { AgentUpdate } from '../../../shared/contracts/agent'

type Message = { role: string; content: string | { type: string; text?: string }[] }
type Request = { messages: Message[]; tools: { function: { name: string } }[] }
function textContent(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
}

export async function checkCloneAgent(): Promise<void> {
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/clone-agent-')
  const source = join(directory, 'original.bin'),
    duplicate = join(directory, 'duplicate.bin')
  const folder = join(directory, 'scan')
  const events: AgentUpdate[] = []
  let failure: Error | undefined
  const server = createServer((request, response) => {
    void respond(request, response).catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error))
      response.destroy()
    })
  })
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.url, '/v1/chat/completions')
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      assert.ok(Buffer.isBuffer(chunk))
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Request
    const names = body.tools.map((tool) => tool.function.name)
    assert.ok(names.includes('scan_duplicates') && names.includes('clone_duplicates'))
    assert.ok(!names.includes('bash') && !names.includes('write') && !names.includes('edit'))
    const lastUser = body.messages.findLast((message) => message.role === 'user')
    assert.ok(lastUser)
    const call = JSON.parse(textContent(lastUser)) as {
      name: string
      arguments: Record<string, unknown>
    }
    const last = body.messages.at(-1)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta: object, reason: string | null): void => {
      response.write(
        `data: ${JSON.stringify({
          id: 'clone-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'local-model',
          choices: [{ index: 0, delta, finish_reason: reason }]
        })}\n\n`
      )
    }
    if (last?.role === 'tool') {
      chunk({ role: 'assistant', content: textContent(last) }, null)
      chunk({}, 'stop')
    } else {
      chunk(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'clone-call',
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }
          ]
        },
        null
      )
      chunk({}, 'tool_calls')
    }
    response.end('data: [DONE]\n\n')
  }
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const previous = { ...process.env }
  Object.assign(process.env, {
    ARKIVE_AI_PROVIDER: 'openai-compatible',
    ARKIVE_AI_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
    ARKIVE_AI_MODEL: 'local-model',
    ARKIVE_AI_API_KEY: 'local-test-key'
  })
  const service = new AgentService(directory)
  let calls = 0
  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const id = `clone-${String(++calls)}`
    const result = await service.send(
      {
        conversationId: id,
        requestId: id,
        text: JSON.stringify({
          name,
          arguments: args,
          authorization:
            '这些是本次生成的测试样本，明确授权对已列出的源和副本路径执行克隆替换；保留全部路径和内容，验证后移除旧存储副本，不留完整旧备份。'
        })
      },
      (event) => events.push(event)
    )
    if (failure) throw failure
    assert.equal(result.status, 'completed', JSON.stringify(result))
    return result.text
  }
  try {
    await mkdir(folder)
    await writeFile(join(folder, 'a.txt'), 'generated scan duplicate')
    await writeFile(join(folder, 'b.txt'), 'generated scan duplicate')
    const scan = JSON.parse(
      await call('scan_duplicates', { directoryPath: folder })
    ) as DuplicateScanResult
    assert.equal(scan.duplicateFileCount, 1)
    await writeFile(source, 'generated explicit clone target')
    await writeFile(duplicate, 'generated explicit clone target')
    const result = JSON.parse(
      await call('clone_duplicates', {
        sourcePath: source,
        duplicatePaths: [duplicate]
      })
    ) as CloneDeduplicationResult
    assert.equal(result.items[0].status, 'deduplicated', JSON.stringify(result))
    assert.equal(result.diskSpaceReclaimedBytes, null)
    assert.equal(await readFile(source, 'utf8'), await readFile(duplicate, 'utf8'))
    assert.deepEqual((await readdir(directory)).sort(), ['duplicate.bin', 'original.bin', 'scan'])
    const repeated = JSON.parse(
      await call('clone_duplicates', {
        sourcePath: source,
        duplicatePaths: [duplicate]
      })
    ) as CloneDeduplicationResult
    assert.equal(repeated.items[0].status, 'skipped')
    await writeFile(duplicate, 'independent edit through retained path')
    assert.equal(await readFile(source, 'utf8'), 'generated explicit clone target')
    const mismatch = JSON.parse(
      await call('clone_duplicates', {
        sourcePath: source,
        duplicatePaths: [duplicate]
      })
    ) as CloneDeduplicationResult
    assert.equal(mismatch.status, 'partial')
    assert.equal(mismatch.items[0].status, 'failed')
    assert.match(
      await call('clone_duplicates', { sourcePath: source, duplicatePaths: ['/System/test'] }),
      /系统关键路径/
    )
    assert.match(
      await call('clone_duplicates', { sourcePath: source, duplicatePaths: [] }),
      /validation|validate|至少|1|minimum/i
    )
    assert.ok(
      events.some(
        (event) => event.tool?.name === 'clone_duplicates' && event.tool.status === 'completed'
      )
    )
    assert.ok(
      events.some(
        (event) => event.tool?.name === 'clone_duplicates' && event.tool.status === 'error'
      )
    )
    console.log(
      'PASS: local HTTP model → real Pi SDK → scan/clone tools → actual APFS files; repeated apply, independent edit, partial failure, path protection, parameter validation and tool events'
    )
  } finally {
    service.dispose()
    await closeCloneDeduplication()
    for (const key of [
      'ARKIVE_AI_PROVIDER',
      'ARKIVE_AI_BASE_URL',
      'ARKIVE_AI_MODEL',
      'ARKIVE_AI_API_KEY'
    ]) {
      if (previous[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = previous[key]
    }
    server.closeAllConnections()
    await new Promise<void>((done) => {
      server.close(() => {
        done()
      })
    })
    await rm(directory, { recursive: true, force: true })
  }
}
