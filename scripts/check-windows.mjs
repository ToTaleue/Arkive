// Windows-only acceptance checks. All generated data is isolated under Desktop/arkive-test.
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- JavaScript runners cannot use TypeScript return annotations. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'

if (process.platform !== 'win32') throw new Error('Run this acceptance entry on Windows.')
const project = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const base = join(homedir(), 'Desktop', 'arkive-test')
await mkdir(base, { recursive: true })
const root = await mkdtemp(join(base, 'windows-'))
await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction')
const environment = { ...process.env, ARKIVE_TEST_ROOT: root, ARKIVE_PROJECT_ROOT: project }
for (const key of Object.keys(environment)) {
  if (key.startsWith('ARKIVE_AI_') || key === 'ELECTRON_RUN_AS_NODE') delete environment[key]
}
const suites = []
console.log(`Windows test artifacts: ${root}`)

async function command(name, executable, args, timeout = 120_000) {
  const started = Date.now()
  let output = ''
  let timedOut = false
  const code = await new Promise((done) => {
    const child = spawn(executable, args, {
      cwd: project,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', (error) => {
      output += error.stack
      clearTimeout(timer)
      done(1)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      done(exitCode ?? 1)
    })
  })
  const log = join(root, `${name}.log`)
  await writeFile(log, output)
  const result = {
    name,
    status: code === 0 && !timedOut ? 'passed' : 'failed',
    code,
    timedOut,
    durationMs: Date.now() - started,
    log
  }
  suites.push(result)
  console.log(`${result.status.toUpperCase()}: ${name} (${result.durationMs}ms)`)
  if (code !== 0) console.log(output.slice(-3500))
  return result
}

async function bundle(name, input, format = 'es', transform) {
  const directory = join(root, name)
  await build({
    configFile: false,
    logLevel: 'warn',
    plugins: transform ? [{ name: 'isolated-windows-test-paths', transform }] : [],
    build: {
      ssr: true,
      emptyOutDir: false,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input,
        external: ['electron', 'sharp', '@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'],
        output: {
          format,
          entryFileNames: format === 'cjs' ? 'check.cjs' : 'check.mjs',
          inlineDynamicImports: true
        }
      }
    }
  })
  return join(directory, format === 'cjs' ? 'check.cjs' : 'check.mjs')
}

const typescript = join(project, 'node_modules/typescript/bin/tsc')
await Promise.all([
  command('typecheck-node', process.execPath, [
    typescript,
    '--noEmit',
    '-p',
    'tsconfig.node.json',
    '--composite',
    'false'
  ]),
  command('typecheck-web', process.execPath, [
    typescript,
    '--noEmit',
    '-p',
    'tsconfig.web.json',
    '--composite',
    'false'
  ]),
  command('lint', process.execPath, [
    join(project, 'node_modules/eslint/bin/eslint.js'),
    '--cache',
    '.',
    '--format',
    'json',
    '--output-file',
    join(root, 'lint.json')
  ])
])
const built = await command('build', process.execPath, [
  join(project, 'node_modules/electron-vite/bin/electron-vite.js'),
  'build'
])

const entry = join(root, 'pure-entry.mjs')
const source = (name) => JSON.stringify(join(project, name).replaceAll('\\', '/'))
await writeFile(
  entry,
  [
    `import ${source('src/main/tasks/manager.test.ts')}`,
    `import ${source('src/main/system-paths.test.ts')}`,
    `import ${source('src/execution/mole-output.test.ts')}`,
    `import { checkAbAv1Results } from ${source('src/execution/ab-av1.test.ts')}`,
    `import { checkProgressEstimates } from ${source('src/main/modules/video-compression/progress.test.ts')}`,
    'checkAbAv1Results(); checkProgressEstimates();'
  ].join('\n')
)
await command('pure-logic', process.execPath, ['--test', await bundle('pure', entry)])

await command('filesystem-regressions', process.execPath, [
  '--test',
  await bundle('filesystem', join(project, 'src/main/modules/catalog/files.test.ts'), 'cjs')
])

const tagEntry = await bundle(
  'tags',
  join(project, 'src/main/modules/catalog/tag-recommendation.test.ts'),
  'es',
  (code, id) =>
    id.endsWith('tag-recommendation.test.ts')
      ? code.replaceAll('/Users/hu1hui/Desktop/arkive-test', root.replaceAll('\\', '/'))
      : undefined
)
await command('tag-recommendation', process.execPath, [tagEntry])

let markdown = await readFile(join(project, 'scripts/check-chat-markdown.mjs'), 'utf8')
markdown = markdown
  .replace(
    "await mkdir('out', { recursive: true })",
    `await mkdir(${JSON.stringify(root)}, { recursive: true })`
  )
  .replace(
    "resolve('out/chat-markdown-check-')",
    `resolve(${JSON.stringify(join(root, 'markdown-'))})`
  )
const markdownEntry = join(root, 'markdown-runner.mjs')
await writeFile(markdownEntry, markdown)
await command('chat-markdown', process.execPath, [markdownEntry])

if (built.status === 'passed') {
  const ipc = await bundle('ipc', join(project, 'src/main/tasks/ipc.test.ts'), 'cjs', (code, id) =>
    id.endsWith('/tasks/ipc.test.ts')
      ? code.replace(
          'await app.whenReady()',
          `app.setPath('userData', ${JSON.stringify(join(root, 'ipc-user-data'))}); await app.whenReady()`
        )
      : undefined
  )
  await command('task-ipc', require('electron'), [ipc])
  await command(
    'windows-functional',
    require('electron'),
    [await bundle('functional', join(project, 'scripts/windows-functional-checks.mjs'), 'cjs')],
    180_000
  )
}
const lint = JSON.parse(await readFile(join(root, 'lint.json'), 'utf8'))
const lintSummary = { errors: 0, warnings: 0, rules: {} }
for (const file of lint) {
  lintSummary.errors += file.errorCount
  lintSummary.warnings += file.warningCount
  for (const message of file.messages) {
    const rule = message.ruleId ?? 'parser'
    lintSummary.rules[rule] = (lintSummary.rules[rule] ?? 0) + 1
  }
}
let checks = []
try {
  checks = JSON.parse(await readFile(join(root, 'functional-results.json'), 'utf8'))
} catch {
  /* Suite failure is retained. */
}
const report = {
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  createdAt: new Date().toISOString(),
  project,
  artifacts: root,
  suites,
  lint: lintSummary,
  checks
}
await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2))
const latest = join(project, 'out/windows-test-latest.json')
await mkdir(dirname(latest), { recursive: true })
await writeFile(latest, JSON.stringify(report, null, 2))
console.log(`Report: ${join(root, 'results.json')}`)
console.log(
  JSON.stringify({
    suites: suites.map(({ name, status }) => ({ name, status })),
    functional: Object.fromEntries(
      ['passed', 'failed', 'blocked'].map((status) => [
        status,
        checks.filter((c) => c.status === status).length
      ])
    ),
    lint: lintSummary
  })
)
if (
  suites.some((suite) => suite.status === 'failed') ||
  checks.some((check) => check.status === 'failed')
)
  process.exitCode = 1
