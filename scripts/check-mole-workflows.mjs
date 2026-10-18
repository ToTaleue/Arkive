// Real Pi SDK, tool definitions, Services, queue and subprocess runner.
// Mole discovery, sudo and Trash are isolated fixtures; writes stay under arkive-test.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/mole-workflows-')
const toolRoot = join(root, 'resources/tools/darwin-arm64/mole')
const calls = join(root, 'calls.jsonl')
let service, tasks, server
try {
  await mkdir(toolRoot, { recursive: true })
  await symlink(resolve('resources/skills'), join(root, 'resources/skills'), 'dir')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  await writeFile(
    join(toolRoot, 'mo'),
    String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const root = ${JSON.stringify(root)}, args = process.argv.slice(2)
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\n')
const config = JSON.parse(fs.readFileSync(path.join(root, 'preview.json')))
if (fs.existsSync(path.join(root, 'hold-process'))) { setInterval(() => {}, 1000); return }
if (args[0] === 'analyze') {
  console.log(JSON.stringify({path: args[2], scan_status: args[2].endsWith('partial') ? 'partial' : 'complete', entries: []})); return
}
if (args[0] === 'uninstall' && args[1] === '--list') {
  console.log(JSON.stringify(config.apps || [])); return
}
if (args[0] === 'installer') {
  for (const candidate of config.installer || []) console.log('Found installer: ' + candidate)
} else if (args[0] === 'purge') {
  for (const candidate of config.purge || []) console.log('[DRY RUN] ' + candidate + ', 4KB')
} else if (args[0] === 'clean' && args.length === 1) {
  if (fs.existsSync(path.join(root, 'clean-fail'))) { console.error('fixture clean failure'); process.exit(7) }
  fs.rmSync(path.join(root, 'clean-cache'), {force:true})
  fs.rmSync(path.join(root, 'clean-trash'), {force:true})
  console.log('Cleanup complete\nTracked cleanup: 4KB | Items cleaned: 2'); return
} else if (args[0] === 'clean' && args[1] === '--dry-run') {
  fs.mkdirSync(path.join(root, '.config/mole'), {recursive:true})
  fs.writeFileSync(path.join(root, '.config/mole/clean-list.txt'), '=== Fixture ===\n' + path.join(root, 'clean-cache') + ' # 4KB\n')
} else process.exit(91)
if (fs.existsSync(path.join(root, 'preview-partial'))) { console.log('x'.repeat(1100000)); return }
if (config.verbose) console.log('x'.repeat(20000))
console.log('➤ Fixture stage\nPreview complete - no changes made')
`,
    { mode: 0o755 }
  )
  await writeFile(
    join(toolRoot, 'arkive-uninstall-preview.sh'),
    String.raw`#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const root = ${JSON.stringify(root)}
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(['uninstall-preview', ...process.argv.slice(2)]) + '\n')
const doc = JSON.parse(fs.readFileSync(path.join(root, 'uninstall.json')))
process.stdout.write(doc.invalid ? 'broken' : ['arkive-uninstall-v1', ...doc.rows.flat(), ''].join('\0'))
`,
    { mode: 0o755 }
  )
  await writeFile(
    join(root, 'electron.mjs'),
    `
import { rename, readFile, mkdir, appendFile } from 'node:fs/promises'
import { join, relative, isAbsolute, basename } from 'node:path'
const root = ${JSON.stringify(root)}
export const app = {isPackaged:false, getAppPath:()=>root, getPath:()=>root}
export const shell = {async trashItem(path) {
  const rel = relative(root, path)
  if (isAbsolute(rel) || rel.startsWith('..')) throw Error('Fixture refuses host path')
  await appendFile(join(root, 'trash-calls'), path+'\\n')
  const failures = await readFile(join(root, 'trash-fail.json'), 'utf8').then(JSON.parse,()=>[])
  if (failures.includes(path)) throw Error('Fixture Trash failure')
  await mkdir(join(root,'Trash'),{recursive:true})
  await rename(path,join(root,'Trash',String(Date.now())+'-'+basename(path)))
}}
`
  )
  await writeFile(
    join(root, 'os.mjs'),
    `export * from 'os'; export const homedir=()=>${JSON.stringify(root)}`
  )
  await writeFile(
    join(root, 'process-fixture.ts'),
    `
export * from ${JSON.stringify(resolve('src/execution/process.ts'))}
import {existsSync} from 'node:fs'
export async function runSudoValidation() {return {exitCode:existsSync(${JSON.stringify(join(root, 'authorized'))})?0:1,signal:null,stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false}}
export async function runSystemTool() {throw Error('No password dialogs or host system tools in this test')}
`
  )
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: {
      alias: [
        { find: 'electron', replacement: join(root, 'electron.mjs') },
        { find: 'node:os', replacement: join(root, 'os.mjs') },
        { find: /^(?:\.\.\/)+execution\/process$/, replacement: join(root, 'process-fixture.ts') }
      ]
    },
    build: {
      ssr: true,
      target: 'node22',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          service: resolve('src/main/modules/agent/service.ts'),
          workflow: resolve('src/main/modules/mole/workflow.ts'),
          tasks: resolve('src/main/tasks/service.ts'),
          execution: resolve('src/main/modules/agent/execution.ts'),
          fixtures: resolve('src/main/modules/mole/workflow-fixtures.test.ts')
        },
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  })
  const fixture = await import(pathToFileURL(join(root, 'fixtures.mjs')).href)
  const load = fixture.loadBuilt.bind(null, root)
  const existing = fixture.exists
  const json = fixture.jsonFile.bind(null, root)
  const text = fixture.messageText
  const { AgentService } = await load('service')
  const { MoleWorkflowService } = await load('workflow')
  tasks = (await load('tasks')).tasks
  const { toolResult } = await load('execution')
  let requestNumber = 0,
    modelError
  server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const names = body.tools.map((t) => t.function.name)
      for (const name of [
        'mole_clean',
        'mole_analyze',
        'mole_purge',
        'mole_installer',
        'mole_uninstall',
        'mole_uninstall_preview'
      ])
        assert.ok(names.includes(name))
      assert.ok(!names.includes('bash'))
      const lastIndex = body.messages.findLastIndex((m) => m.role === 'user')
      const call = JSON.parse(text(body.messages[lastIndex]).slice(5))
      const result = body.messages.slice(lastIndex + 1).find((m) => m.role === 'tool')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = fixture.sendChunk.bind(null, response)
      send({ role: 'assistant', content: '' })
      if (result) {
        send({ content: text(result) })
        send({}, 'stop')
      } else {
        send({
          tool_calls: [
            {
              index: 0,
              id: 'call-' + ++requestNumber,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) }
            }
          ]
        })
        send({}, 'tool_calls')
      }
      response.end('data: [DONE]\n\n')
    } catch (error) {
      modelError = error
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  Object.assign(process.env, {
    ARKIVE_AI_PROVIDER: 'openai-compatible',
    ARKIVE_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    ARKIVE_AI_MODEL: 'local',
    ARKIVE_AI_API_KEY: 'fixture-key'
  })
  service = new AgentService(root)
  const updates = []
  const call = fixture.createToolCaller(service, updates)
  const config = { installer: [], purge: [], apps: [] }
  const configSave = json.bind(null, 'preview.json', config)
  const generated = fixture.generated.bind(null, root)
  await configSave()
  const folder = join(root, 'project ; literal')
  await mkdir(folder)
  const sub = join(folder, 'child')
  await mkdir(sub)
  assert.equal(JSON.parse(await call('mole_analyze', { path: folder })).report.path, folder)
  assert.equal(JSON.parse(await call('mole_analyze', { path: sub })).report.path, sub)
  await mkdir(join(root, 'partial'))
  assert.equal(
    JSON.parse(await call('mole_analyze', { path: join(root, 'partial') })).report.scan_status,
    'partial'
  )
  console.log('PASS Analyze: repeated paths and partial scan status through real Pi SDK')

  const a = await generated('downloads/A ; literal.dmg'),
    b = await generated('downloads/B.pkg')
  config.installer = [a, b]
  await configSave()
  const preview = JSON.parse(await call('mole_installer_preview'))
  assert.ok(preview.previewId)
  assert.equal(preview.candidates.length, 2)
  assert.ok(await existing(a))
  assert.ok(await existing(b))
  const chosen = { previewId: preview.previewId, candidateIds: [preview.candidates[0].id] }
  assert.match(await call('mole_installer', chosen, 'different-chat'), /不存在|会话/)
  const moved = JSON.parse(await call('mole_installer', chosen))
  assert.equal(moved.status, 'completed')
  assert.deepEqual(moved.completed, [a])
  assert.deepEqual(moved.retained, [b])
  assert.equal(await existing(a), false)
  assert.ok(await existing(b))
  await generated('downloads/A ; literal.dmg', 'replacement must survive retry')
  assert.deepEqual(JSON.parse(await call('mole_installer', chosen)), moved)
  assert.equal(await readFile(a, 'utf8'), 'replacement must survive retry')
  assert.match(
    await call('mole_installer', {
      previewId: preview.previewId,
      candidateIds: [preview.candidates[1].id]
    }),
    /已执行/
  )
  assert.match(await call('mole_purge', chosen), /不属于/)
  assert.match(
    await call('mole_installer', {
      ...chosen,
      candidateIds: ['00000000-0000-0000-0000-000000000000']
    }),
    /不属于/
  )
  console.log(
    'PASS Installer: selection across turns, chat isolation, idempotency and forged/consumed/wrong-kind rejection'
  )

  const workflow = new MoleWorkflowService()
  const p1 = await generated('project/node_modules/data'),
    p2 = await generated('project/dist/data')
  config.purge = [join(p1, '..'), join(p2, '..')]
  await configSave()
  const purge = await workflow.preview('purge', () => {})
  const first = purge.candidates[0]
  await rename(first.path, first.path + '-old')
  await mkdir(first.path)
  const changed = await workflow.execute(
    'purge',
    { previewId: purge.previewId, candidateIds: purge.candidates.map((c) => c.id) },
    () => {}
  )
  assert.equal(changed.status, 'failed')
  assert.equal(changed.completed.length, 0)
  assert.ok(changed.warnings.some((w) => /变化/.test(w)))
  assert.ok(await existing(config.purge[1]))
  const current = JSON.parse(await call('mole_purge_preview'))
  const purged = JSON.parse(
    await call('mole_purge', {
      previewId: current.previewId,
      candidateIds: [current.candidates[1].id]
    })
  )
  assert.equal(purged.status, 'completed')
  assert.equal(await existing(config.purge[1]), false)
  assert.ok(await existing(first.path))
  console.log(
    'PASS Purge: replacement detection before any write; only selected project artifacts removed'
  )

  const failA = await generated('partial/A.dmg'),
    failB = await generated('partial/B.dmg')
  config.installer = [failA, failB]
  await configSave()
  await json('trash-fail.json', [failB])
  const partial = await workflow.preview('installer', () => {})
  const partialResult = await workflow.execute(
    'installer',
    { previewId: partial.previewId, candidateIds: partial.candidates.map((c) => c.id) },
    () => {}
  )
  assert.equal(partialResult.status, 'partial')
  assert.deepEqual(partialResult.completed, [failA])
  assert.equal(partialResult.failed[0].path, failB)
  assert.ok(await existing(failB))
  await json('trash-fail.json', [])
  const cancelA = await generated('cancel/A.dmg'),
    cancelB = await generated('cancel/B.dmg')
  config.installer = [cancelA, cancelB]
  await configSave()
  const cancelling = await workflow.preview('installer', () => {}),
    controller = new AbortController()
  const cancelled = await workflow.execute(
    'installer',
    { previewId: cancelling.previewId, candidateIds: cancelling.candidates.map((c) => c.id) },
    (event) => {
      if (event.type === 'stage' && event.title.includes('2/2')) controller.abort()
    },
    controller.signal
  )
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(cancelled.completed, [cancelA])
  assert.ok(cancelled.unprocessed.includes(cancelB))
  assert.ok(await existing(cancelB))
  console.log(
    'PASS selected cleanup: partial failure does not permanently delete, cancellation retains first result and untouched remainder'
  )

  const app = join(root, 'Applications/Fixture App.app')
  await mkdir(join(app, 'Contents'), { recursive: true })
  await writeFile(join(app, 'Contents/Info.plist'), 'fixture metadata')
  const cache = await generated('Library/Caches/com.fixture/cache'),
    data = await generated('Library/Application Support/Fixture/settings')
  const cacheDir = join(cache, '..'),
    dataDir = join(data, '..')
  let uninstallRows = [
    ['app', app, 'com.fixture', 'policy-v1'],
    ['candidate', app, app, 'app'],
    ['candidate', app, cacheDir, 'related'],
    ['candidate', app, dataDir, 'related'],
    ['review', app, '/Library/LaunchAgents/com.fixture.plist', ''],
    ['warning', app, 'Homebrew metadata is not changed', '']
  ]
  await json('uninstall.json', { rows: uninstallRows })
  config.apps = [
    {
      name: 'Fixture App',
      bundle_id: 'com.fixture',
      source: 'App',
      uninstall_name: 'Fixture App',
      path: app,
      size: '4KB'
    }
  ]
  await configSave()
  assert.equal(JSON.parse(await call('mole_uninstall_list')).apps[0].path, app)
  const uninstall = JSON.parse(await call('mole_uninstall_preview', { appPaths: [app] }))
  assert.equal(uninstall.candidates.find((c) => c.path === dataDir).suggested, false)
  assert.equal(uninstall.candidates.find((c) => c.path === dataDir).role, 'app-data')
  assert.equal(uninstall.reviewOnly.length, 1)
  assert.equal(
    uninstall.candidates.some((c) => c.path.startsWith('/Library/')),
    false
  )
  const uninstalled = JSON.parse(
    await call('mole_uninstall', {
      previewId: uninstall.previewId,
      candidateIds: uninstall.candidates.filter((c) => c.suggested).map((c) => c.id)
    })
  )
  assert.equal(uninstalled.status, 'completed')
  assert.equal(await existing(app), false)
  assert.equal(await existing(cacheDir), false)
  assert.equal(await readFile(data, 'utf8'), 'fixture')
  assert.ok(uninstalled.retained.includes(dataDir))
  assert.ok(uninstalled.warnings.some((w) => w.includes('Hook')))
  console.log(
    'PASS Uninstall: real tool flow list → associated preview → selected removal, personal data and review-only system leftovers retained'
  )

  await mkdir(join(app, 'Contents'), { recursive: true })
  await writeFile(join(app, 'Contents/Info.plist'), 'fixture metadata')
  await mkdir(cacheDir, { recursive: true })
  await json('uninstall.json', { rows: uninstallRows })
  const shared = await workflow.previewUninstall([app])
  await json('uninstall.json', {
    rows: uninstallRows.map((row) =>
      row[0] === 'app' ? [...row.slice(0, 3), 'policy-new-sibling'] : row
    )
  })
  const guarded = await workflow.execute(
    'uninstall',
    {
      previewId: shared.previewId,
      candidateIds: shared.candidates.filter((c) => c.role === 'app').map((c) => c.id)
    },
    () => {}
  )
  assert.equal(guarded.status, 'failed')
  assert.ok(await existing(app))
  assert.ok(guarded.warnings.some((w) => /共享数据|副本/.test(w)))
  await json('uninstall.json', { invalid: true })
  await assert.rejects(workflow.previewUninstall([app]), /格式无效/)
  await assert.rejects(workflow.previewUninstall(['/System/Unknown\n.app']), /应用绝对路径/)
  console.log('PASS Uninstall guards: changed sibling policy and malformed reports refuse deletion')

  config.installer = [b]
  await configSave()
  await generated('preview-partial')
  const incomplete = await workflow.preview('installer', () => {})
  assert.equal(incomplete.previewId, undefined)
  assert.equal(incomplete.stdoutTruncated, true)
  await rm(join(root, 'preview-partial'))
  config.installer = [b]
  config.verbose = true
  await configSave()
  const excerpt = JSON.parse(await call('mole_installer_preview'))
  assert.ok(excerpt.previewId)
  assert.equal(excerpt.outputExcerpted, true)
  assert.equal(excerpt.stdoutTruncated, false)
  delete config.verbose
  await configSave()

  const protectedWorkflow = new MoleWorkflowService()
  config.installer = ['/usr/bin/true']
  await configSave()
  const protectedPlan = await protectedWorkflow.preview('installer', () => {})
  const blocked = await protectedWorkflow.execute(
    'installer',
    { previewId: protectedPlan.previewId, candidateIds: protectedPlan.candidates.map((c) => c.id) },
    () => {}
  )
  assert.equal(blocked.status, 'failed')
  assert.ok(blocked.warnings.some((w) => w.includes('系统关键路径')))
  const link = join(root, 'alias.dmg')
  await symlink(b, link)
  config.installer = [link]
  await configSave()
  const linked = await workflow.preview('installer', () => {})
  const blockedLink = await workflow.execute(
    'installer',
    { previewId: linked.previewId, candidateIds: linked.candidates.map((c) => c.id) },
    () => {}
  )
  assert.equal(blockedLink.status, 'failed')
  assert.ok(await existing(b))
  console.log(
    'PASS preview truncation and protected/symlink targets do not become successful destructive runs'
  )

  await generated('clean-cache')
  await generated('clean-trash')
  const cleanArgs = { confirmedDirectDeletionAndEmptyTrash: true }
  assert.match(await call('mole_clean', {}), /required|confirmed|invalid/i)
  const notAuthorized = JSON.parse(await call('mole_clean', cleanArgs))
  assert.equal(notAuthorized.status, 'authorization-required')
  assert.ok(await existing(join(root, 'clean-cache')))
  await generated('authorized')
  assert.equal(JSON.parse(await call('mole_authorize_system')).authorized, true)
  assert.ok(await existing(join(root, 'clean-cache')))
  const cleaned = JSON.parse(await call('mole_clean', cleanArgs))
  assert.equal(cleaned.status, 'completed')
  assert.equal(await existing(join(root, 'clean-cache')), false)
  assert.equal(await existing(join(root, 'clean-trash')), false)
  await generated('clean-fail')
  const cleanFail = JSON.parse(await call('mole_clean', cleanArgs))
  assert.equal(cleanFail.status, 'failed')
  assert.equal(
    toolResult('mole_clean', { details: cleanFail, content: [] }, false).title,
    '清理未正常完成'
  )
  await rm(join(root, 'clean-fail'))
  await generated('hold-process')
  const running = service.send(
    {
      conversationId: 'clean-cancel',
      requestId: 'clean-cancel',
      text: 'CALL ' + JSON.stringify({ name: 'mole_clean', args: cleanArgs })
    },
    (update) => {
      if (update.tool?.name === 'mole_clean' && update.tool.status === 'running')
        setTimeout(
          () => void service.stop({ conversationId: 'clean-cancel', requestId: 'clean-cancel' }),
          100
        )
    }
  )
  assert.equal((await running).status, 'cancelled')
  await rm(join(root, 'hold-process'))
  assert.ok(
    updates.some(
      (update) => update.tool?.name === 'mole_installer' && update.tool.status === 'completed'
    )
  )
  assert.ok(
    updates.some((update) =>
      update.execution?.tools.some((tool) => tool.stage?.includes('移入回收站'))
    )
  )
  if (modelError) throw modelError
  const invocationLines = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(
    invocationLines.every((args) => !args.includes('--yes') && !args.includes('--permanent'))
  )
  assert.ok(invocationLines.filter((args) => args[0] === 'clean' && args.length === 1).length >= 2)
  console.log(
    'PASS Clean: explicit tool argument, authorization gate, shared execution, failure and cancellation; all five workflows reach real Pi tool loop and result cards'
  )

  // Exercise the actual Bash bridge separately using a tiny read-only Mole discovery fixture.
  const bridge = join(root, 'bridge'),
    bridgeApp = join(root, 'Bridge App.app')
  await mkdir(join(bridge, 'bin'), { recursive: true })
  await mkdir(join(bridgeApp, 'Contents'), { recursive: true })
  await writeFile(
    join(bridgeApp, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.bridge</string></dict></plist>'
  )
  await copyFile(
    resolve('resources/tools/darwin-arm64/mole/arkive-uninstall-preview.sh'),
    join(bridge, 'preview.sh')
  )
  await writeFile(
    join(bridge, 'bin/uninstall.sh'),
    String.raw`
_batch_scan_app_details() {
  [[ "$MOLE_DRY_RUN" == 1 && "$MOLE_DELETE_MODE" == trash ]] || exit 99
  debug_log 'Sibling package receipt scan timed out (exit 124)'
  debug_log 'Unrelated debug output must not be forwarded'
  local encoded=$(printf '%s' "$HOME/Library/Caches/com.bridge" | base64 | tr -d '\n')
  app_details=("Bridge|$BRIDGE_APP|com.bridge|1|$encoded||false|false|false|||||none|identity|com.bridge|siblings|plist")
  leftover_notes=("$BRIDGE_APP|Shared leftovers kept")
}
decode_file_list() { printf '%s' "$1" | base64 --decode; }
batch_uninstall_applications() { exit 98; }
`
  )
  const nativePreview = await promisify(execFile)(
    '/bin/bash',
    [join(bridge, 'preview.sh'), bridgeApp],
    { env: { ...process.env, HOME: root, BRIDGE_APP: bridgeApp } }
  )
  const fields = nativePreview.stdout.split('\0')
  assert.equal(fields[0], 'arkive-uninstall-v1')
  assert.ok(fields.includes(join(root, 'Library/Caches/com.bridge')))
  assert.ok(fields.includes('false||none|identity|com.bridge|siblings|plist'))
  assert.match(
    nativePreview.stderr,
    /ARKIVE_MOLE_DIAGNOSTIC: Sibling package receipt scan timed out/
  )
  assert.equal(nativePreview.stderr.includes('Unrelated debug output must not be forwarded'), false)
  console.log(
    'PASS actual Bash adapter: sources discovery only, emits NUL protocol and preserves native identity/sibling policy'
  )
  // Keep Mole's actual batch discovery logic; fixture only host-wide probes.
  await writeFile(
    join(bridge, 'bin/uninstall.sh'),
    `
source ${JSON.stringify(resolve('resources/tools/darwin-arm64/mole/bin/uninstall.sh'))}
_batch_refresh_selected_app_bundle_id() { printf '%s\\n' 'com.bridge'; }
is_homebrew_available() { return 1; }
get_brew_cask_name() { return 1; }
official_uninstaller_vendor() { [[ "\${ARKIVE_FIXTURE_OFFICIAL:-0}" == 1 ]] && { echo Vendor; return 0; }; return 1; }
uninstall_live_bundle_has_other_install() {
  _MOLE_UNINSTALL_LIVE_SIBLING_FINGERPRINT="none"
  if [[ "\${ARKIVE_FIXTURE_SIBLING:-0}" == 1 ]]; then
    _MOLE_UNINSTALL_LIVE_SIBLING_FINGERPRINT="survivor"; return 0
  fi
  return 1
}
uninstall_bundle_id_has_surviving_sibling() { return 1; }
find_app_files() { printf '%s\\n' "$HOME/Library/Caches/com.bridge" "$HOME/Library/Application Support/Bridge"; }
find_app_system_files() { printf '%s\\n' '/Library/LaunchAgents/com.bridge.plist'; }
get_diagnostic_report_paths_for_app() { return 0; }
discover_login_item_helper_bundle_ids() { return 0; }
calculate_total_size() { echo 0; }
has_sensitive_data() { return 1; }
`
  )
  const nativeScan = await promisify(execFile)(
    '/bin/bash',
    [join(bridge, 'preview.sh'), bridgeApp],
    { env: { ...process.env, HOME: root } }
  )
  assert.ok(nativeScan.stdout.split('\0').includes(join(root, 'Library/Caches/com.bridge')))
  assert.ok(nativeScan.stdout.split('\0').includes('review'))
  const nativeSibling = await promisify(execFile)(
    '/bin/bash',
    [join(bridge, 'preview.sh'), bridgeApp],
    { env: { ...process.env, HOME: root, ARKIVE_FIXTURE_SIBLING: '1' } }
  )
  assert.ok(nativeSibling.stdout.includes('guard_login'))
  assert.equal(
    nativeSibling.stdout.split('\0').includes(join(root, 'Library/Caches/com.bridge')),
    false
  )
  const official = await promisify(execFile)('/bin/bash', [join(bridge, 'preview.sh'), bridgeApp], {
    env: { ...process.env, HOME: root, ARKIVE_FIXTURE_OFFICIAL: '1' }
  })
  assert.ok(official.stdout.includes('Official uninstaller required'))
  assert.equal(official.stdout.split('\0').includes('candidate'), false)
  console.log(
    'PASS actual Mole batch discovery with isolated host probes: association export, system review-only, surviving sibling protection and official uninstaller refusal'
  )
  await json('verification.json', {
    status: 'passed',
    model: 'local deterministic fixture',
    nativeSudo: false,
    nativeMoleDiscovery: false,
    nativeTrash: false,
    toolExecutions: requestNumber,
    processCalls: invocationLines.length
  })
  console.log('Evidence: ' + root)
} finally {
  service?.dispose()
  await tasks?.close()
  if (server) {
    server.closeAllConnections()
    await new Promise((done) => {
      server.close(done)
    })
  }
  await rm(join(root, 'resources'), { recursive: true, force: true })
}
