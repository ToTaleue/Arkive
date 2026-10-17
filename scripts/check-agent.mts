// Real Pi SDK + local streaming HTTP fixture; no external key or network needed.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
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
const enabledTools = [
  'read',
  'grep',
  'find',
  'ls',
  'mole_clean_preview',
  'mole_analyze',
  'compress_image',
  'compress_video',
  'move',
  'copy',
  'mkdir',
  'trash',
  'compress_pdf'
]
const toolFile = 'agent-tool-check.txt'
const toolCalls = [
  { name: 'read', arguments: { path: toolFile, offset: 2, limit: 1 } },
  { name: 'ls', arguments: { path: '.', limit: 100 } },
  { name: 'find', arguments: { pattern: toolFile, path: '.', limit: 100 } },
  {
    name: 'grep',
    arguments: {
      pattern: 'AFTER-TOOL-EDIT',
      path: toolFile,
      ignoreCase: true,
      literal: true,
      context: 1,
      limit: 10
    }
  }
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
await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
const workspaceDir = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/agent-tools-')
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
      'Only the selected Pi tools, Arkive tools and explicit placeholders may be sent'
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
    if (last?.startsWith('CALL ')) {
      const call = JSON.parse(last.slice(5)) as { name: string; arguments: Record<string, unknown> }
      const result = body.messages.find((message) => message.role === 'tool')
      if (result) {
        send({ content: messageText(result) })
        send({}, 'stop')
      } else {
        send({
          tool_calls: [
            {
              index: 0,
              id: 'single-tool-check',
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            }
          ]
        })
        send({}, 'tool_calls')
      }
      response.end('data: [DONE]\n\n')
      return
    }
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
        assert.match(messageText(results[0]), /after-tool-edit/)
        assert.doesNotMatch(messageText(results[0]), /first-line/)
        assert.ok(messageText(results[1]).includes(toolFile), 'ls finds the fixture file')
        assert.ok(messageText(results[2]).includes(toolFile), 'find locates the fixture file')
        assert.match(messageText(results[3]), /after-tool-edit/)
        assert.match(messageText(results[3]), /first-line/)
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
const analyzing = args[0] === 'analyze' && args[1] === '--json' && args.length === 3
if (!analyzing && JSON.stringify(args) !== JSON.stringify(['clean', '--dry-run'])) process.exit(99)
const mode = fs.readFileSync(${JSON.stringify(moleModeFile)}, 'utf8')
fs.writeFileSync(${JSON.stringify(moleStartedFile)}, 'started')
if (mode === 'slow') {
  setTimeout(() => process.exit(0), 60000)
} else if (mode === 'fail') {
  process.stderr.write('fixture failure\\n')
  process.exitCode = 7
} else if (analyzing) {
  if (mode === 'truncated') process.stdout.write('x'.repeat(1100000))
  else if (mode === 'invalid') process.stdout.write('not json')
  else process.stdout.write(JSON.stringify({path: args[2], scan_status: mode === 'partial' ? 'partial' : 'complete', total_size: 1234, entries: []}))
} else {
  process.stdout.write('Mole preview fixture\\n')
  process.stderr.write('fixture warning\\n')
}
`,
    { mode: 0o755 }
  )
  for (const name of ['ffmpeg', 'ffprobe', 'ab-av1']) {
    await symlink(
      resolve('resources/tools/darwin-arm64', name),
      resolve(buildDir, 'resources/tools/darwin-arm64', name)
    )
  }
  const electronTrashRunner = resolve(buildDir, 'trash-runner.cjs')
  await writeFile(
    electronTrashRunner,
    `const { app, shell } = require('electron')
app.whenReady().then(async () => {
  try { await shell.trashItem(process.argv[2]); app.exit(0) }
  catch (error) { console.error(error); app.exit(1) }
})`
  )
  await writeFile(
    resolve(buildDir, 'electron-fixture.mjs'),
    `import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(buildDir)} }
export const shell = { trashItem: async (path) => {
  if (path.endsWith('trash-failure.txt')) throw new Error('simulated recycle-bin failure')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(${JSON.stringify(resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))}, [${JSON.stringify(electronTrashRunner)}, path], { env, timeout: 20000 })
} }`
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
  const currentService = new AgentService(workspaceDir)
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

  await writeFile(resolve(workspaceDir, toolFile), 'first-line\nafter-tool-edit\nlast-line\n')
  assert.deepEqual(await send('tools', 'tools1', 'TOOLS'), {
    status: 'completed',
    text: '工具验证完成'
  })
  assert.equal(
    await readFile(resolve(workspaceDir, toolFile), 'utf8'),
    'first-line\nafter-tool-edit\nlast-line\n'
  )

  let callNumber = 0
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    id = `call-${++callNumber}`
  ): Promise<string> => {
    const result = await send(id, id, `CALL ${JSON.stringify({ name, arguments: args })}`)
    assert.equal(result.status, 'completed', JSON.stringify(result))
    return result.text
  }
  await writeFile(moleModeFile, 'success')
  const project = resolve(workspaceDir, 'project with spaces;literal')
  await mkdir(project)
  const analysis = await callTool('mole_analyze', { path: project })
  assert.ok(analysis.includes('"total_size":1234'))
  assert.ok(analysis.includes('"scan_status":"complete"'))
  assert.deepEqual(JSON.parse(await readFile(moleArgumentsFile, 'utf8')), [
    'analyze',
    '--json',
    project
  ])
  await callTool('mole_analyze', {})
  assert.deepEqual(JSON.parse(await readFile(moleArgumentsFile, 'utf8')), [
    'analyze',
    '--json',
    workspaceDir
  ])
  await writeFile(moleModeFile, 'partial')
  assert.ok((await callTool('mole_analyze', { path: project })).includes('"scan_status":"partial"'))
  await writeFile(moleModeFile, 'fail')
  assert.match(await callTool('mole_analyze', { path: project }), /Mole 占用分析失败/)
  await writeFile(moleModeFile, 'invalid')
  assert.match(await callTool('mole_analyze', { path: project }), /JSON/)
  await writeFile(moleModeFile, 'truncated')
  assert.match(await callTool('mole_analyze', { path: project }), /报告超出输出容量/)

  const directory = resolve(workspaceDir, 'new directory;literal', 'nested')
  await callTool('mkdir', { path: directory, mode: 0o700 })
  await access(directory)
  const copied = resolve(directory, 'copied.txt')
  const moved = resolve(directory, 'moved.txt')
  assert.match(
    await callTool('copy', {
      sourcePath: resolve(workspaceDir, toolFile),
      destinationPath: copied
    }),
    /"operation":"copy"/
  )
  assert.equal(
    await readFile(copied, 'utf8'),
    await readFile(resolve(workspaceDir, toolFile), 'utf8')
  )
  await callTool('move', { sourcePath: copied, destinationPath: moved })
  await assert.rejects(access(copied))
  await access(moved)
  await writeFile(copied, 'keep destination')
  assert.match(await callTool('copy', { sourcePath: moved, destinationPath: copied }), /目标已存在/)
  assert.match(await callTool('move', { sourcePath: moved, destinationPath: copied }), /目标已存在/)
  assert.equal(await readFile(copied, 'utf8'), 'keep destination')
  await callTool('copy', {
    sourcePath: moved,
    destinationPath: copied,
    overwrite: true,
    preserveTimestamps: true
  })
  assert.equal(await readFile(copied, 'utf8'), await readFile(moved, 'utf8'))
  await writeFile(copied, 'replace me')
  await callTool('move', { sourcePath: moved, destinationPath: copied, overwrite: true })
  await assert.rejects(access(moved))
  assert.notEqual(await readFile(copied, 'utf8'), 'replace me')
  const copiedDirectory = resolve(workspaceDir, 'directory copy')
  await callTool('copy', { sourcePath: directory, destinationPath: copiedDirectory })
  await access(resolve(copiedDirectory, 'copied.txt'))
  await callTool('trash', { paths: [copiedDirectory], permanent: true })
  await assert.rejects(access(copiedDirectory))

  // The recycle-bin branch calls a real Electron subprocess and the real macOS API.
  const recycled = resolve(workspaceDir, `arkive-agent-trash-${Date.now()}.txt`)
  await writeFile(recycled, 'generated Arkive tool test sample')
  assert.match(await callTool('trash', { paths: [recycled] }), /"operation":"trash"/)
  await assert.rejects(access(recycled))
  const trashFailure = resolve(workspaceDir, 'trash-failure.txt')
  const deleted = resolve(workspaceDir, 'delete permanently.txt')
  await writeFile(trashFailure, 'keep when recycle bin fails')
  await writeFile(deleted, 'delete test sample')
  const partialDelete = await callTool('trash', {
    paths: [deleted, resolve(workspaceDir, 'missing'), trashFailure],
    permanent: true
  })
  assert.match(partialDelete, /清理未全部完成/)
  assert.ok(partialDelete.includes(deleted))
  await assert.rejects(access(deleted))
  await writeFile(trashFailure, 'keep when recycle bin fails')
  assert.match(await callTool('trash', { paths: [trashFailure] }), /simulated recycle-bin failure/)
  assert.equal(await readFile(trashFailure, 'utf8'), 'keep when recycle bin fails')

  const userDirectory = resolve(workspaceDir, 'ordinary-user-data')
  const library = resolve(userDirectory, 'sample.photoslibrary')
  await mkdir(library, { recursive: true })
  const sentinel = resolve(library, 'keep.txt')
  await writeFile(sentinel, 'user data')
  const userDirectoryCopy = resolve(workspaceDir, 'user-data-copy')
  assert.match(
    await callTool('copy', {
      sourcePath: userDirectory,
      destinationPath: userDirectoryCopy
    }),
    /"operation":"copy"/
  )
  assert.equal(
    await readFile(resolve(userDirectoryCopy, 'sample.photoslibrary', 'keep.txt'), 'utf8'),
    'user data'
  )
  const userDirectoryLink = resolve(workspaceDir, 'library-link')
  await symlink(library, userDirectoryLink)
  assert.match(
    await callTool('mkdir', { path: resolve(userDirectoryLink, 'new') }),
    /"operation":"mkdir"/
  )
  await access(resolve(library, 'new'))
  await callTool('trash', { paths: [userDirectoryLink], permanent: true })
  await assert.rejects(access(userDirectoryLink))
  assert.equal(
    await readFile(sentinel, 'utf8'),
    'user data',
    'Deleting a symlink preserves its target'
  )
  await callTool('trash', { paths: [userDirectory], permanent: true })
  await assert.rejects(access(userDirectory))

  // Guard rejections happen before any system file is changed.
  assert.match(await callTool('trash', { paths: ['/'], permanent: true }), /根目录受保护/)
  assert.match(await callTool('trash', { paths: ['/usr'], permanent: true }), /系统关键路径受保护/)
  assert.match(
    await callTool('move', {
      sourcePath: '/bin/sh',
      destinationPath: resolve(workspaceDir, 'must-not-move-sh')
    }),
    /系统关键路径受保护/
  )
  assert.match(
    await callTool('copy', {
      sourcePath: sentinel,
      destinationPath: '/System/arkive-test-must-not-create'
    }),
    /系统关键路径受保护/
  )
  const systemLink = resolve(workspaceDir, 'system-link')
  await symlink('/System', systemLink)
  assert.match(
    await callTool('mkdir', { path: resolve(systemLink, 'arkive-test-must-not-create') }),
    /系统关键路径受保护/
  )
  assert.match(
    await callTool('trash', { paths: [systemLink], permanent: true }),
    /系统关键路径受保护/
  )
  assert.match(await callTool('mkdir', { path: 'relative' }), /绝对路径/)

  assert.match(
    await callTool('compress_pdf', {
      inputPath: resolve(workspaceDir, toolFile),
      outputPath: resolve(workspaceDir, 'output.pdf')
    }),
    /NOT_IMPLEMENTED/
  )
  await assert.rejects(access(resolve(workspaceDir, 'output.pdf')))

  const imageInput = resolve(workspaceDir, 'image with spaces.png')
  await sharp({ create: { width: 96, height: 64, channels: 4, background: '#00998880' } })
    .png()
    .toFile(imageInput)
  const imageBytes = await readFile(imageInput)
  const imageOutput = resolve(workspaceDir, 'compressed.webp')
  assert.ok(
    (await callTool('compress_image', { inputPath: imageInput, outputPath: imageOutput })).includes(
      '"outputFormat":"webp"'
    )
  )
  assert.equal((await sharp(imageOutput).metadata()).format, 'webp')
  const jpegOutput = resolve(workspaceDir, 'compatible.jpg')
  await callTool('compress_image', {
    inputPath: imageInput,
    outputPath: jpegOutput,
    outputFormat: 'jpeg',
    compatibility: true,
    quality: 72,
    jpegBackground: '#ffffff'
  })
  assert.equal((await sharp(jpegOutput).metadata()).format, 'jpeg')
  assert.match(
    await callTool('compress_image', { inputPath: imageInput, outputPath: imageOutput }),
    /已存在/
  )
  assert.deepEqual(
    await readFile(imageInput),
    imageBytes,
    'Agent image compression preserves source bytes'
  )

  const videoInput = resolve(workspaceDir, 'source video.mov')
  const videoOutput = resolve(workspaceDir, 'compressed.mp4')
  await promisify(execFile)(resolve('resources/tools/darwin-arm64/ffmpeg'), [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30:duration=1',
    '-c:v',
    'mpeg4',
    '-q:v',
    '2',
    videoInput
  ])
  const videoBytes = await readFile(videoInput)
  const videoResult = await callTool('compress_video', {
    inputPath: videoInput,
    outputPath: videoOutput,
    preset: 'size',
    compatibility: false
  })
  assert.ok(videoResult.includes('"outputBytes":'), videoResult)
  await access(videoOutput)
  assert.deepEqual(
    await readFile(videoInput),
    videoBytes,
    'Agent video compression preserves source bytes'
  )
  const libraryDirectory = resolve(workspaceDir, 'ordinary.photoslibrary')
  await mkdir(libraryDirectory)
  const libraryInput = resolve(libraryDirectory, 'source.mov')
  await symlink(videoInput, libraryInput)
  const libraryLink = resolve(workspaceDir, 'output-link')
  await symlink(libraryDirectory, libraryLink, 'dir')
  const libraryVideoResult = await callTool('compress_video', {
    inputPath: libraryInput,
    outputPath: resolve(libraryLink, 'output.mp4'),
    preset: 'size'
  })
  assert.ok(libraryVideoResult.includes('"outputBytes":'), libraryVideoResult)
  await access(resolve(libraryDirectory, 'output.mp4'))
  assert.deepEqual((await readdir(libraryDirectory)).sort(), ['output.mp4', 'source.mov'])
  assert.match(
    await callTool('compress_video', {
      inputPath: videoInput,
      outputPath: '/System/arkive-test-must-not-create.mp4'
    }),
    /系统关键路径受保护/
  )
  assert.match(
    await callTool('compress_video', {
      inputPath: videoInput,
      outputPath: resolve(workspaceDir, 'h264.mp4'),
      preset: 'quality',
      compatibility: true
    }),
    /H.264/
  )

  await writeFile(moleModeFile, 'slow')
  await rm(moleStartedFile)
  const analysisPending = send(
    'analyze-cancel',
    'analyze-cancel',
    `CALL ${JSON.stringify({ name: 'mole_analyze', arguments: { path: project } })}`
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      await access(moleStartedFile).then(
        () => true,
        () => false
      )
    )
      break
    await delay(20)
  }
  await access(moleStartedFile)
  await currentService.stop({ conversationId: 'analyze-cancel', requestId: 'analyze-cancel' })
  assert.equal((await analysisPending).status, 'cancelled')

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
    'PASS: Pi tool parameters, Mole analysis/preview arguments/results/partial/failure/cancellation, real Agent image/video compression and source preservation, native file operations, real Electron recycle bin, permanent deletion, failure/no-fallback and critical system path protection without user-directory blacklists, PDF placeholder without side effects, streaming, history, isolation, recovery and key redaction.'
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
  await rm(workspaceDir, { recursive: true, force: true })
}
