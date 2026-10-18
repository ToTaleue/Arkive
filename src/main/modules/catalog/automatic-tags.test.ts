import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { app } from 'electron'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { fileTags } from './finder-tags'
import { compressImageAndBackup } from './compression'
import { archiveFile } from './operations'
import { Catalog, setCatalog } from './service'

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes: unknown = chunk
    if (!Buffer.isBuffer(bytes)) throw new Error('request body must be bytes')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
}

function send(response: ServerResponse, payload: string): void {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`)
  response.write(
    'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
  )
  response.end('data: [DONE]\n\n')
}

async function check(): Promise<void> {
  await app.whenReady()
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = await body(request)
    const messages = input.messages as { role: string; content: string }[]
    const payload = JSON.parse(messages[1].content) as {
      files: { fileId: string; metadata?: Record<string, unknown> }[]
    }
    assert.equal(payload.files.length, 1)
    const metadata = payload.files[0].metadata
    assert.ok(metadata)
    assert.ok(metadata.extension)
    assert.ok(metadata.sizeBytes)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    send(
      response,
      JSON.stringify({
        items: [
          {
            fileId: payload.files[0].fileId,
            tags: [{ name: '旅行', reason: '文件名与目录元数据表明是旅行素材' }]
          }
        ]
      })
    )
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => response.destroy(error as Error))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const previous = {
    provider: process.env.ARKIVE_AI_PROVIDER,
    model: process.env.ARKIVE_AI_MODEL,
    key: process.env.ARKIVE_AI_API_KEY,
    baseUrl: process.env.ARKIVE_AI_BASE_URL
  }
  process.env.ARKIVE_AI_PROVIDER = 'openai-compatible'
  process.env.ARKIVE_AI_MODEL = 'automatic-tags-test-model'
  process.env.ARKIVE_AI_API_KEY = 'automatic-tags-test-key'
  process.env.ARKIVE_AI_BASE_URL = `http://127.0.0.1:${String(address.port)}/v1`
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/automatic-tags-')
  const catalog = new Catalog({
    databasePath: join(directory, 'catalog.db'),
    backupRoot: join(directory, 'Backup'),
    archiveRoot: join(directory, 'Archive')
  })
  setCatalog(catalog)
  await catalog.start()
  try {
    const input = join(directory, '旅行-京都.png')
    const output = join(directory, '旅行-京都.webp')
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#b0c0d0' } })
      .png({ compressionLevel: 0 })
      .toFile(input)
    const result = await compressImageAndBackup({
      inputPath: input,
      outputPath: output,
      archive: true
    })
    assert.deepEqual(result.automaticTags, { status: 'ready', tags: ['旅行'] })
    assert.ok(result.archive && result.archive.status === 'ready')
    assert.ok(catalog.get(result.catalog.id).tags.includes('旅行'))
    assert.ok(result.archive.item.archivePath)
    assert.ok((await fileTags(result.archive.item.archivePath)).includes('旅行'))
    const laterInput = join(directory, '后续归档.png')
    const laterOutput = join(directory, '后续归档.webp')
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#c0d0e0' } })
      .png({ compressionLevel: 0 })
      .toFile(laterInput)
    const later = await compressImageAndBackup({
      inputPath: laterInput,
      outputPath: laterOutput
    })
    const laterArchived = await archiveFile(catalog, later.catalog.id)
    assert.equal(laterArchived.automaticTags?.status, 'ready')
    assert.ok(laterArchived.tags.includes('旅行'))
    console.log(
      'PASS: compression and later archive both call AI metadata tagging and write the recommendation'
    )
  } finally {
    await catalog.close()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    await rm(directory, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      ARKIVE_AI_PROVIDER: previous.provider,
      ARKIVE_AI_MODEL: previous.model,
      ARKIVE_AI_API_KEY: previous.key,
      ARKIVE_AI_BASE_URL: previous.baseUrl
    })) {
      process.env[key] = value
    }
  }
}

void check().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
