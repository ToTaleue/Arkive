// Real Pi SDK + local streaming HTTP fixture; no external key or network needed.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { build } from 'vite'
import type { AgentService as Service } from '../src/main/modules/agent/service'
import type { AgentResult, AgentUpdate } from '../src/shared/contracts/agent'
import type { Catalog as CatalogService } from '../src/main/modules/catalog/service'
import type { OfficeReplacementResult } from '../src/shared/contracts/office'

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
  'mole_authorize_system',
  'mole_analyze',
  'mole_installer_preview',
  'mole_purge_preview',
  'mole_uninstall_list',
  'compress_image',
  'compress_video',
  'inspect_office',
  'compress_office',
  'move',
  'copy',
  'mkdir',
  'trash',
  'compress_pdf',
  'archive_file',
  'search_archives',
  'tag_archives',
  'inspect_image',
  'inspect_video',
  'inspect_pdf',
  'scan_duplicates',
  'clone_duplicates',
  'open_archive'
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
const osFixture = resolve(buildDir, 'os-fixture.mjs')
await writeFile(
  osFixture,
  `export * from 'os'; export const homedir = () => ${JSON.stringify(workspaceDir)}`
)
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
      'Only the selected Pi tools and Arkive tools may be sent'
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
          assert.match(text, /Mole clean 预览失败/)
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
    console.error('Local model fixture failed', error)
    if (!response.headersSent) response.writeHead(500)
    response.end('fixture failed')
  }
}

let service: Service | undefined
let catalog: CatalogService | undefined
let taskQueue: typeof import('../src/main/tasks/service').tasks | undefined
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
const cleaning = JSON.stringify(args) === JSON.stringify(['clean', '--dry-run'])
const installing = JSON.stringify(args) === JSON.stringify(['installer', '--dry-run', '--debug'])
const purging = JSON.stringify(args) === JSON.stringify(['purge', '--dry-run', '--debug'])
const listing = JSON.stringify(args) === JSON.stringify(['uninstall', '--list'])
if (!analyzing && !cleaning && !installing && !purging && !listing) process.exit(99)
const mode = fs.readFileSync(${JSON.stringify(moleModeFile)}, 'utf8')
fs.writeFileSync(${JSON.stringify(moleStartedFile)}, 'started')
if (mode === 'slow') {
  setTimeout(() => process.exit(0), 60000)
} else if (mode === 'fail') {
  process.stderr.write('fixture failure\\n')
  process.exitCode = 7
} else if (analyzing) {
  if (mode === 'truncated') process.stdout.write('x'.repeat(4_194_305))
  else if (mode === 'invalid') process.stdout.write('not json')
  else process.stdout.write(JSON.stringify({path: args[2], scan_status: mode === 'partial' ? 'partial' : 'complete', total_size: 1234, entries: []}))
} else if (installing) {
  process.stdout.write('Dry run complete\\n')
  process.stderr.write('Found installer:   * /tmp/arkive-installer-fixture/Test.dmg\\n')
} else if (purging) {
  process.stdout.write('→ DRY RUN MODE, No project artifacts will be removed\\n')
  process.stdout.write('✓ [DRY RUN] ~/Developer/fixture-project/node_modules, 42MB\\n')
  process.stdout.write('✓ [DRY RUN] ~/Developer/fixture-project/target, 128MB\\n')
} else if (listing) {
  process.stdout.write(JSON.stringify([{name:'Fixture App',bundle_id:'com.example.fixture',source:'App',uninstall_name:'Fixture App',path:'/Applications/Fixture App.app',size:'12MB'}]))
} else {
  process.stdout.write('Mole preview fixture\\n')
  process.stderr.write('fixture warning\\n')
}
`,
    { mode: 0o755 }
  )
  for (const name of [
    'ffmpeg',
    'ffprobe',
    'ab-av1',
    'gs',
    'qpdf',
    'pngquant',
    'ssimulacra2',
    'czkawka_cli',
    'arkive-apfs-dedupe'
  ]) {
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
export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(buildDir)}, getPath: () => ${JSON.stringify(resolve(workspaceDir, 'user-data'))} }
export const shell = { openPath: async () => '', showItemInFolder: () => {}, trashItem: async (path) => {
  if (path.endsWith('trash-failure.txt')) throw new Error('simulated recycle-bin failure')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(${JSON.stringify(resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))}, [${JSON.stringify(electronTrashRunner)}, path], { env, timeout: 20000 })
} }`
  )
  await symlink(
    resolve('resources/finder-tags.jxa'),
    resolve(buildDir, 'resources/finder-tags.jxa')
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
    resolve: {
      alias: [
        { find: 'electron', replacement: resolve(buildDir, 'electron-fixture.mjs') },
        { find: 'node:os', replacement: osFixture }
      ]
    },
    build: {
      ssr: true,
      target: 'node22',
      outDir: buildDir,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          service: resolve('src/main/modules/agent/service.ts'),
          contracts: resolve('src/shared/contracts/agent.ts'),
          config: resolve('src/main/modules/agent/config.ts'),
          catalog: resolve('src/main/modules/catalog/service.ts'),
          tasks: resolve('src/main/tasks/service.ts'),
          officeFixtures: resolve('src/main/modules/office-compression/fixtures.test.ts')
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
  const { Catalog, setCatalog } = (await import(
    pathToFileURL(resolve(buildDir, 'catalog.mjs')).href
  )) as typeof import('../src/main/modules/catalog/service')
  const { fixture: officeFixture } = (await import(
    pathToFileURL(resolve(buildDir, 'officeFixtures.mjs')).href
  )) as typeof import('../src/main/modules/office-compression/fixtures.test')
  const { tasks } = (await import(
    pathToFileURL(resolve(buildDir, 'tasks.mjs')).href
  )) as typeof import('../src/main/tasks/service')
  taskQueue = tasks
  catalog = new Catalog({
    databasePath: resolve(workspaceDir, 'catalog.db'),
    archiveRoot: resolve(workspaceDir, 'Archive'),
    backupRoot: resolve(workspaceDir, 'Backup')
  })
  setCatalog(catalog)
  await catalog.start()
  const currentCatalog = catalog
  async function checkPreservedOriginal(
    source: string,
    output: string,
    bytes: Buffer
  ): Promise<string> {
    const row = currentCatalog.repo.db
      .prepare('SELECT id FROM catalog_items WHERE output_path = ? ORDER BY rowid DESC LIMIT 1')
      .get(output)
    assert.ok(row)
    const record = currentCatalog.get(String(row.id))
    assert.notEqual(record.backupStatus, 'error', record.backupError ?? '')
    const keptPath = record.backupStatus === 'ready' ? record.backupPath : source
    assert.ok(keptPath)
    assert.deepEqual(await readFile(keptPath), bytes)
    if (keptPath !== source) {
      await assert.rejects(access(source))
      // Restore only this generated fixture for subsequent codec variations.
      await copyFile(keptPath, source)
    }
    return record.id
  }
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

  await writeFile(moleModeFile, 'success')
  const installerPreview = await callTool('mole_installer_preview', {})
  assert.ok(installerPreview.includes('Test.dmg'))
  assert.deepEqual(JSON.parse(await readFile(moleArgumentsFile, 'utf8')), [
    'installer',
    '--dry-run',
    '--debug'
  ])
  const purgePreview = await callTool('mole_purge_preview', {})
  assert.ok(purgePreview.includes('fixture-project/node_modules'))
  assert.ok(purgePreview.includes('42MB'))
  assert.deepEqual(JSON.parse(await readFile(moleArgumentsFile, 'utf8')), [
    'purge',
    '--dry-run',
    '--debug'
  ])
  const uninstallList = await callTool('mole_uninstall_list', {})
  assert.ok(uninstallList.includes('Fixture App'))
  assert.deepEqual(JSON.parse(await readFile(moleArgumentsFile, 'utf8')), ['uninstall', '--list'])

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

  const pdfPostScript = resolve(workspaceDir, 'source.ps')
  await writeFile(
    pdfPostScript,
    '%!PS-Adobe-3.0\n/Helvetica findfont 18 scalefont setfont\n72 720 moveto (Arkive Agent PDF fixture) show\nshowpage\n'
  )
  const pdfInput = resolve(workspaceDir, 'source.pdf')
  await promisify(execFile)(resolve('resources/tools/darwin-arm64/gs'), [
    '-dBATCH',
    '-dNOPAUSE',
    '-sDEVICE=pdfwrite',
    `-sOutputFile=${pdfInput}`,
    pdfPostScript
  ])
  const pdfBytes = await readFile(pdfInput)
  assert.match(await callTool('inspect_pdf', { inputPath: pdfInput }), /"pageCount":1/)
  assert.deepEqual(await readFile(pdfInput), pdfBytes)
  const deepPdfOutput = resolve(workspaceDir, 'compressed-deep-lossless.pdf')
  const deepPdfResult = await callTool('compress_pdf', {
    inputPath: pdfInput,
    outputPath: deepPdfOutput,
    preset: 'deep-lossless'
  })
  assert.ok(deepPdfResult.includes('"preset":"deep-lossless"'), deepPdfResult)
  await access(deepPdfOutput)
  await checkPreservedOriginal(pdfInput, deepPdfOutput, pdfBytes)
  const pdfOutput = resolve(workspaceDir, 'compressed.pdf')
  let releaseTaskQueue!: () => void
  const queueHold = new Promise<void>((done) => {
    releaseTaskQueue = done
  })
  const queueBlocker = tasks.submitBatch(
    [{ title: 'hold Agent PDF queue', run: () => queueHold }],
    { onError: 'stop' }
  )
  let pdfToolCompleted = false
  const pdfPending = callTool('compress_pdf', {
    inputPath: pdfInput,
    outputPath: pdfOutput,
    preset: 'lossless',
    archive: true,
    tags: ['参考']
  }).then((result) => {
    pdfToolCompleted = true
    return result
  })
  try {
    const deadline = Date.now() + 10_000
    while (
      !tasks
        .list()
        .some((task) => task.title === 'PDF 压缩：source.pdf' && task.status === 'queued')
    ) {
      assert.ok(Date.now() < deadline, 'Agent PDF tool did not join the shared queue')
      await delay(20)
    }
    assert.equal(pdfToolCompleted, false, 'Agent must await the actual result, not a task ID')
    await assert.rejects(access(pdfOutput))
  } finally {
    releaseTaskQueue()
    await tasks.wait(queueBlocker.taskIds[0])
  }
  const pdfResult = await pdfPending
  assert.ok(pdfResult.includes('"outputBytes":'), pdfResult)
  await access(pdfOutput)
  const pdfId = await checkPreservedOriginal(pdfInput, pdfOutput, pdfBytes)
  assert.ok(currentCatalog.get(pdfId).archivePath)
  assert.ok(pdfResult.includes('"archive":{"status":"ready"'), pdfResult)
  assert.match(
    await callTool('compress_pdf', {
      inputPath: pdfInput,
      outputPath: pdfOutput,
      preset: 'lossless'
    }),
    /已存在/
  )

  const imageInput = resolve(workspaceDir, 'image with spaces.png')
  await sharp({ create: { width: 96, height: 64, channels: 4, background: '#00998880' } })
    .png({ compressionLevel: 0 })
    .toFile(imageInput)
  const imageBytes = await readFile(imageInput)
  const cancelHold = new Promise<void>((done) => {
    releaseTaskQueue = done
  })
  const cancelBlocker = tasks.submitBatch(
    [{ title: 'hold Agent cancellation queue', run: () => cancelHold }],
    { onError: 'stop' }
  )
  const cancelledImageOutput = resolve(workspaceDir, 'cancelled-image.webp')
  const queuedAgent = send(
    'agent-task-cancel',
    'agent-task-cancel',
    `CALL ${JSON.stringify({ name: 'compress_image', arguments: { inputPath: imageInput, outputPath: cancelledImageOutput } })}`
  )
  try {
    const deadline = Date.now() + 10_000
    while (
      !tasks
        .list()
        .some(
          (task) => task.title === '图片压缩：image with spaces.png' && task.status === 'queued'
        )
    ) {
      assert.ok(Date.now() < deadline, 'Agent image tool did not join the shared queue')
      await delay(20)
    }
    await currentService.stop({
      conversationId: 'agent-task-cancel',
      requestId: 'agent-task-cancel'
    })
    assert.equal((await queuedAgent).status, 'cancelled')
    assert.equal(
      tasks.list().find((task) => task.title === '图片压缩：image with spaces.png')?.status,
      'cancelled'
    )
    await assert.rejects(access(cancelledImageOutput))
    assert.deepEqual(await readFile(imageInput), imageBytes)
  } finally {
    releaseTaskQueue()
    await tasks.wait(cancelBlocker.taskIds[0])
  }
  assert.match(await callTool('inspect_image', { inputPath: imageInput }), /"width":96/)
  assert.deepEqual(await readFile(imageInput), imageBytes)
  const imageOutput = resolve(workspaceDir, 'compressed.webp')
  const unavailableBackup = `${currentCatalog.backupRoot}.offline`
  await rename(currentCatalog.backupRoot, unavailableBackup)
  await writeFile(currentCatalog.backupRoot, 'simulate an unavailable backup root')
  assert.ok(
    (await callTool('compress_image', { inputPath: imageInput, outputPath: imageOutput })).includes(
      '"outputFormat":"webp"'
    )
  )
  assert.equal((await sharp(imageOutput).metadata()).format, 'webp')
  const pendingImage = currentCatalog.repo.db
    .prepare('SELECT id FROM catalog_items WHERE output_path = ?')
    .get(imageOutput)
  assert.ok(pendingImage)
  const imageId = String(pendingImage.id)
  assert.equal(currentCatalog.get(imageId).backupStatus, 'error')
  const failedImageTask = tasks
    .list()
    .find((task) => task.status === 'failed' && task.key?.endsWith('/image with spaces.png'))
  assert.ok(failedImageTask)
  assert.equal(JSON.stringify(failedImageTask.result).includes(imageId), true)
  assert.deepEqual(await readFile(imageInput), imageBytes, 'Backup failure preserves the source')
  assert.equal(currentCatalog.get(imageId).archivePath, null, 'Compression alone does not archive')
  assert.ok((await callTool('search_archives', { state: 'pending' })).includes(imageId))
  assert.match(await callTool('open_archive', { id: imageId, action: 'reveal' }), /归档|不存在|未/)
  await rm(currentCatalog.backupRoot)
  await rename(unavailableBackup, currentCatalog.backupRoot)
  assert.ok(
    (await callTool('archive_file', { id: imageId, tags: ['旅行'] })).includes('"archivePath":')
  )
  await checkPreservedOriginal(imageInput, imageOutput, imageBytes)
  assert.equal(
    currentCatalog.get(imageId).backupStatus,
    'ready',
    'Standalone archive retries backup first'
  )
  const imageArchivePath = currentCatalog.get(imageId).archivePath
  await callTool('archive_file', { id: imageId })
  assert.equal(currentCatalog.get(imageId).archivePath, imageArchivePath)
  assert.ok(!(await callTool('search_archives', { state: 'pending' })).includes(imageId))
  assert.ok(
    (await callTool('open_archive', { id: imageId, action: 'reveal' })).includes(
      imageArchivePath ?? 'missing'
    )
  )
  assert.match(
    await callTool('open_archive', { id: imageId, action: 'open' }),
    /"status":"requested"/
  )
  await callTool('tag_archives', { ids: [imageId, pdfId], add: ['公共标签'] })
  assert.equal(currentCatalog.query({ tags: ['公共标签'] }).total, 2)
  const search = await callTool('search_archives', { tags: ['公共标签', '旅行'] })
  assert.ok(search.includes(imageId))
  assert.ok(!search.includes(pdfId), 'Multiple tag filters are AND')
  assert.ok(search.includes('演唱会'), 'Search exposes preset labels for future AI tagging')
  await callTool('tag_archives', { ids: [imageId], add: ['素材'], remove: ['旅行'] })
  assert.ok(!currentCatalog.get(imageId).tags.includes('旅行'))
  assert.ok(currentCatalog.get(imageId).tags.includes('素材'))
  assert.match(await callTool('archive_file', { id: '/tmp/not-a-record' }), /id|pattern|invalid/i)
  const invalidOutput = resolve(workspaceDir, 'tags-without-archive.webp')
  assert.match(
    await callTool('compress_image', {
      inputPath: imageInput,
      outputPath: invalidOutput,
      tags: ['旅行']
    }),
    /archive=true/
  )
  await assert.rejects(access(invalidOutput))
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
  await checkPreservedOriginal(imageInput, jpegOutput, imageBytes)
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
  assert.match(await callTool('inspect_video', { inputPath: videoInput }), /"width":320/)
  assert.deepEqual(await readFile(videoInput), videoBytes)
  const unavailableArchive = `${currentCatalog.archiveRoot}.offline`
  await rename(currentCatalog.archiveRoot, unavailableArchive)
  await writeFile(currentCatalog.archiveRoot, 'simulate an unavailable archive root')
  const videoResult = await callTool('compress_video', {
    inputPath: videoInput,
    outputPath: videoOutput,
    preset: 'size',
    archive: true,
    tags: ['演唱会']
  })
  assert.ok(videoResult.includes('"outputBytes":'), videoResult)
  await access(videoOutput)
  const videoId = await checkPreservedOriginal(videoInput, videoOutput, videoBytes)
  assert.ok(videoResult.includes('"archive":{"status":"error"'), videoResult)
  assert.equal(currentCatalog.get(videoId).archivePath, null)
  await rm(currentCatalog.archiveRoot)
  await rename(unavailableArchive, currentCatalog.archiveRoot)
  await callTool('archive_file', { id: videoId, tags: ['演唱会'] })
  assert.ok(
    currentCatalog.get(videoId).archivePath,
    'Retry archives the existing output without encoding again'
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
  await checkPreservedOriginal(videoInput, resolve(libraryDirectory, 'output.mp4'), videoBytes)
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
    /compatibility|additional|暂不支持/i
  )
  await assert.rejects(access(resolve(workspaceDir, 'h264.mp4')))
  assert.deepEqual(await readFile(videoInput), videoBytes, 'Rejected H.264 preserves source')

  // Drive the registered tools through Pi, then verify full-document side effects.
  const officePng = await sharp({
    create: { width: 256, height: 256, channels: 4, background: '#00998880' }
  })
    .png({ compressionLevel: 0 })
    .toBuffer()
  for (const format of ['docx', 'pptx'] as const) {
    const inputPath = resolve(workspaceDir, `office with spaces.${format}`)
    await officeFixture(inputPath, format, [officePng], { video: Buffer.from('invalid video') })
    const original = await readFile(inputPath)
    const inspected = await callTool('inspect_office', { inputPath })
    assert.ok(inspected.includes(`"format":"${format}"`), inspected)
    assert.ok(inspected.includes('"embeddedImages":1'), inspected)
    assert.ok(inspected.includes('"embeddedVideos":1'), inspected)
    assert.deepEqual(await readFile(inputPath), original, 'Inspection is read-only')
    assert.match(
      await callTool('compress_office', { inputPath, preset: 'invalid' }),
      /preset|invalid|literal/i
    )
    assert.deepEqual(await readFile(inputPath), original, 'Invalid parameters preserve source')
    assert.match(
      await callTool('compress_office', {
        inputPath,
        outputPath: resolve(workspaceDir, 'unexpected.docx')
      }),
      /outputPath|additional|unexpected/i
    )
    assert.deepEqual(await readFile(inputPath), original, 'Unexpected output paths are rejected')
    const replaced = JSON.parse(
      await callTool('compress_office', { inputPath, preset: 'quality' })
    ) as OfficeReplacementResult
    assert.equal(replaced.status, 'compressed')
    assert.equal(replaced.replacementStatus, 'replaced', replaced.replacementError)
    assert.equal(replaced.outputPath, inputPath)
    assert.ok(replaced.savedBytes > 0)
    assert.ok(replaced.media.some((part) => part.status === 'compressed'))
    assert.ok(
      replaced.media.some((part) => part.part.endsWith('.mp4') && part.status === 'skipped')
    )
    assert.equal(replaced.catalog?.backupStatus, 'ready')
    assert.ok(replaced.catalog?.backupPath)
    assert.deepEqual(await readFile(replaced.catalog.backupPath), original)
    const current = await readFile(inputPath)
    assert.notDeepEqual(current, original)
    assert.equal(current.length, replaced.outputBytes)
    assert.equal(currentCatalog.get(replaced.catalog.id).outputPath, inputPath)
    assert.equal(currentCatalog.get(replaced.catalog.id).archivePath, null)
    await callTool('archive_file', { id: replaced.catalog.id, tags: ['参考'] })
    const archived = currentCatalog.get(replaced.catalog.id)
    assert.ok(archived.archivePath)
    assert.deepEqual(await readFile(archived.archivePath), current)
  }
  const officeEmpty = resolve(workspaceDir, 'office-no-savings.docx')
  await officeFixture(officeEmpty, 'docx', [])
  const officeEmptyBytes = await readFile(officeEmpty)
  assert.match(
    await callTool('compress_office', { inputPath: officeEmpty }),
    /"replacementStatus":"unchanged"/
  )
  assert.deepEqual(await readFile(officeEmpty), officeEmptyBytes)
  assert.match(await callTool('compress_office', { inputPath: 'relative.docx' }), /绝对路径/)
  assert.match(
    await callTool('compress_office', { inputPath: '/System/office.docx' }),
    /系统关键路径受保护/
  )
  const officeFailure = resolve(workspaceDir, 'office-backup-failure.pptx')
  await officeFixture(officeFailure, 'pptx', [officePng])
  const officeFailureBytes = await readFile(officeFailure)
  await rename(currentCatalog.backupRoot, unavailableBackup)
  await writeFile(currentCatalog.backupRoot, 'simulate unavailable Office backup root')
  const officeFailed = JSON.parse(
    await callTool('compress_office', { inputPath: officeFailure })
  ) as OfficeReplacementResult
  assert.equal(officeFailed.status, 'compressed')
  assert.equal(officeFailed.replacementStatus, 'error')
  assert.ok(officeFailed.replacementError)
  assert.equal(officeFailed.catalog?.backupStatus, 'error')
  assert.deepEqual(await readFile(officeFailure), officeFailureBytes)
  const duplicatesDirectory = resolve(workspaceDir, 'duplicates')
  await mkdir(duplicatesDirectory)
  await writeFile(resolve(duplicatesDirectory, 'a.txt'), 'duplicate content')
  await writeFile(resolve(duplicatesDirectory, 'b.txt'), 'duplicate content')
  assert.match(
    await callTool('scan_duplicates', { directoryPath: duplicatesDirectory }),
    /"duplicateFileCount":1/
  )
  assert.deepEqual(await readdir(duplicatesDirectory), ['a.txt', 'b.txt'])
  const cloned = await callTool('clone_duplicates', {
    sourcePath: resolve(duplicatesDirectory, 'a.txt'),
    duplicatePaths: [resolve(duplicatesDirectory, 'b.txt')]
  })
  assert.match(cloned, /"status":"deduplicated"/)
  assert.match(cloned, /"diskSpaceReclaimedBytes":null/)
  assert.deepEqual(await readdir(duplicatesDirectory), ['a.txt', 'b.txt'])
  assert.equal(await readFile(resolve(duplicatesDirectory, 'b.txt'), 'utf8'), 'duplicate content')
  await writeFile(resolve(duplicatesDirectory, 'b.txt'), 'independent modification')
  assert.equal(await readFile(resolve(duplicatesDirectory, 'a.txt'), 'utf8'), 'duplicate content')
  assert.match(
    await callTool('clone_duplicates', {
      sourcePath: resolve(duplicatesDirectory, 'a.txt'),
      duplicatePaths: ['/System/test.txt']
    }),
    /系统关键路径受保护/
  )
  assert.match(await callTool('scan_duplicates', { directoryPath: '/' }), /根目录受保护/)
  assert.match(await callTool('inspect_pdf', { inputPath: imageInput }), /PDF|pdf/)
  assert.ok(
    updates.some(
      (update) => update.tool?.name === 'inspect_pdf' && update.tool.status === 'completed'
    )
  )
  assert.ok(
    updates.some(
      (update) => update.tool?.name === 'scan_duplicates' && update.tool.status === 'error'
    )
  )
  await rm(currentCatalog.backupRoot)
  await rename(unavailableBackup, currentCatalog.backupRoot)
  console.log(
    'PASS: Pi Office discovery, read-only inspection, in-place replacement/backup/archive, skipped video, no-savings, invalid parameters and publication failure reporting'
  )
  console.log(
    'PASS: Agent compression shares the Task queue, awaits real results, propagates cancellation and retains partial business failures'
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
  const configuredBase = process.env.ARKIVE_AI_BASE_URL
  process.env.ARKIVE_AI_BASE_URL = 'https://arkive-test-does-not-exist.invalid/v1'
  const dnsFailure = await send('dns-failure', 'dns-failure', '你好')
  assert.ok(dnsFailure.status === 'error')
  assert.match(dnsFailure.error, /解析|DNS/)
  process.env.ARKIVE_AI_BASE_URL = configuredBase
  delete process.env.ARKIVE_AI_API_KEY
  assert.equal(agentStatus().configured, false)
  assert.equal((await send('missing-key', 'no-key', '你好')).status, 'error')
  currentService.dispose()
  assert.equal((await send('a', 'closed', '你好')).status, 'error')
  if (serverFailure) throw serverFailure
  console.log(
    'PASS: Pi tool parameters, actual image/video/PDF compression and original backup, optional combined archive, standalone archive/retry, batch Finder tags, preset labels and AND search; Mole previews, native file operations, streaming, isolation, cancellation and key redaction.'
  )
} finally {
  service?.dispose()
  await taskQueue?.close()
  await catalog?.close()
  server.closeAllConnections()
  await new Promise<void>((done) => {
    server.close(() => {
      done()
    })
  })
  await rm(buildDir, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
}
