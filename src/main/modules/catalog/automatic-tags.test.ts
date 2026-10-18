import assert from 'node:assert/strict'
import { writePdfFixture } from '../pdf-compression/test-fixture'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { app } from 'electron'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { fileTags } from './finder-tags'
import { compressImageAndBackup, compressPdfAndBackup } from './compression'
import { tasks } from '../../tasks/service'
import { archiveFile, archivePath } from './operations'
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
  let recommendationRequests = 0
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    recommendationRequests += 1
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
    if (metadata.extension === 'pdf') assert.equal(metadata.pageCount, 1)
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
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
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
    // Metadata probes run inside the active compression task. They must not enqueue
    // another job behind that same task in the single-worker queue.
    const pdf = join(directory, 'queued-metadata.pdf')
    await writePdfFixture(pdf, 'Queued metadata')
    const deadline = AbortSignal.timeout(5_000)
    let waitingTasks: string[] = []
    deadline.addEventListener(
      'abort',
      () => {
        waitingTasks = tasks
          .list()
          .filter((task) => ['running', 'queued'].includes(task.status))
          .map((task) => `${task.status}: ${task.title}`)
      },
      { once: true }
    )
    const pdfResult = await compressPdfAndBackup(
      {
        inputPath: pdf,
        outputPath: join(directory, 'queued-metadata-result.pdf'),
        preset: 'lossless',
        archive: true
      },
      deadline
    )
    assert.equal(
      pdfResult.automaticTags?.status,
      'ready',
      `PDF metadata must not deadlock the task queue: ${waitingTasks.join('; ')}`
    )
    assert.equal(pdfResult.archive?.status, 'ready')
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
    assert.equal(recommendationRequests, 3, 'default archive flows still request AI tags')
    console.log(
      'PASS: compression and later archive both call AI metadata tagging and write the recommendation'
    )

    // Exercise opt-out on copies of real downloaded files, with an AI endpoint that
    // would otherwise add “旅行”. Check both the database and actual Finder tags.
    const realImage = '/Users/hu1hui/Desktop/arkive-test/real-download-jpg-lossless.jpg'
    const realDocument = '/Users/hu1hui/Desktop/arkive-test/downloaded-sample-with-images.docx'
    const sourceImage = await readFile(realImage)
    const sourceDocument = await readFile(realDocument)
    const requestsBeforeOptOut = recommendationRequests
    const documentCopy = join(directory, 'no-auto-tags.docx')
    await copyFile(realDocument, documentCopy)
    await fileTags(documentCopy, ['收藏'])
    const direct = await archivePath(catalog, documentCopy, [], undefined, { autoTag: false })
    assert.equal(direct.automaticTags, undefined)
    assert.equal(direct.tagStatus, 'synced')
    assert.deepEqual(direct.tags, ['收藏'])
    assert.ok(direct.archivePath)
    assert.deepEqual(await fileTags(direct.archivePath), ['收藏'])
    assert.deepEqual(await readFile(direct.archivePath), sourceDocument)

    const laterCopy = join(directory, 'later-no-auto-tags.jpg')
    await copyFile(realImage, laterCopy)
    await fileTags(laterCopy, ['收藏'])
    const laterOptOut = await compressImageAndBackup({
      inputPath: laterCopy,
      outputPath: join(directory, 'later-no-auto-tags.webp')
    })
    assert.equal(laterOptOut.status, 'compressed')
    const withoutAutomaticTags = await archiveFile(
      catalog,
      laterOptOut.catalog.id,
      ['交付'],
      undefined,
      { autoTag: false }
    )
    assert.equal(withoutAutomaticTags.automaticTags, undefined)
    assert.equal(withoutAutomaticTags.tagStatus, 'synced')
    assert.deepEqual(withoutAutomaticTags.tags, ['交付', '收藏'])
    assert.ok(withoutAutomaticTags.archivePath)
    assert.deepEqual(await fileTags(withoutAutomaticTags.archivePath), ['交付', '收藏'])

    const combinedCopy = join(directory, 'combined-no-auto-tags.jpg')
    await copyFile(realImage, combinedCopy)
    await fileTags(combinedCopy, ['收藏'])
    const combinedOptOut = await compressImageAndBackup({
      inputPath: combinedCopy,
      outputPath: join(directory, 'combined-no-auto-tags.webp'),
      archive: true,
      autoTag: false,
      tags: ['交付']
    })
    assert.equal(combinedOptOut.status, 'compressed')
    assert.equal(combinedOptOut.automaticTags, undefined)
    assert.ok(combinedOptOut.archive?.status === 'ready')
    assert.deepEqual(combinedOptOut.archive.item.tags, ['交付', '收藏'])
    assert.equal(combinedOptOut.archive.item.tagStatus, 'synced')
    assert.ok(combinedOptOut.archive.item.archivePath)
    assert.deepEqual(await fileTags(combinedOptOut.archive.item.archivePath), ['交付', '收藏'])
    assert.equal(recommendationRequests, requestsBeforeOptOut, 'opt-out must not call the AI')
    assert.deepEqual(await readFile(realImage), sourceImage)
    assert.deepEqual(await readFile(realDocument), sourceDocument)
    console.log(
      'PASS: autoTag=false skips AI in direct, later and combined archives; preserves inherited and explicit Finder tags; downloaded originals unchanged'
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

void check().then(
  () => {
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
