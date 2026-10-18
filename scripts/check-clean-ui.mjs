// Real renderer/preload/IPC/queue/process runner. Only sudo, password dialog and Mole are fixtures.
// Never runs the bundled Mole or accesses the real Trash.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import electron from 'electron'

const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/clean-ui-')
try {
  await mkdir(join(directory, 'resources/tools/darwin-arm64/mole'), { recursive: true })
  await writeFile(
    join(directory, 'resources/tools/darwin-arm64/mole/mo'),
    String.raw`#!${process.execPath}
const { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const root = ${JSON.stringify(directory)}
const args = process.argv.slice(2)
if (args[0] !== 'clean' || args.some(arg => !['clean', '--dry-run'].includes(arg))) process.exit(90)
appendFileSync(join(root, 'calls'), JSON.stringify(args) + '\n')
const preview = args.includes('--dry-run')
console.log('Clean Your Mac\n' + (preview ? 'Dry Run Mode, Preview only, no deletions' : 'Admin access already available'))
console.log('\x1b[35m➤ User essentials\x1b[0m')
console.log(preview ? '  → User app cache · 1 item, 4KB dry' : '  ✓ User app cache · 1 item, 4KB')
function finish() {
  if (existsSync(join(root, 'fail'))) {
    console.error('Failed: fixture permission denied')
    process.exit(7)
  }
  if (!preview) {
    // The only deletion targets are generated fixture files, never host paths.
    rmSync(join(root, 'cache'), { force: true })
    rmSync(join(root, 'trash-item'), { force: true })
  }
  console.log('  ◎ pnpm cache · skipped (pnpm busy)\n➤ Browsers\n  ✓ Chrome cache · 1KB')
  console.log('======================================================================')
  const summary = join(root, 'summary')
  console.log(existsSync(summary) ? readFileSync(summary, 'utf8') : preview ? 'Dry run complete - no changes made\nPotential space: \x1b[32m5KB\x1b[0m | Items: 2' : 'Cleanup complete\nTracked cleanup: 4KB | Items cleaned: 2\nFree space: 223.5GB (+9KB)')
  console.log('======================================================================')
}
if (existsSync(join(root, 'hold'))) {
  const interval = setInterval(() => {
    if (!existsSync(join(root, 'hold'))) { clearInterval(interval); finish() }
  }, 50)
} else finish()
`,
    { mode: 0o755 }
  )
  const processFixture = join(directory, 'process-fixture.ts')
  await writeFile(
    processFixture,
    `
export * from ${JSON.stringify(resolve('src/execution/process.ts'))}
import { existsSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = ${JSON.stringify(directory)}
const result = (ok: boolean, stdout = '') => ({ exitCode: ok ? 0 : 1, signal: null, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false })
export async function runSudoValidation(password?: string) {
  if (password) writeFileSync(join(root, 'authorized'), '')
  return result(existsSync(join(root, 'authorized')))
}
export async function runSystemTool(tool: string) {
  if (tool !== 'osascript') throw Error('Unexpected system tool')
  appendFileSync(join(root, 'dialogs'), 'dialog\\n')
  return result(!existsSync(join(root, 'cancel-dialog')), 'fixture-password\\n')
}
`
  )
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: [{ find: /^(?:\.\.\/)+execution\/process$/, replacement: processFixture }] },
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve('src/main/modules/mole/clean-ui.test.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'check.cjs' }
      }
    }
  })
  const env = { ...process.env, ARKIVE_CLEAN_FIXTURE: directory }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [join(directory, 'check.cjs')], { env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? done() : reject(new Error(`Clean UI failed: ${code}`))
    )
  })
  console.log(`Clean UI screenshots: ${directory}`)
} finally {
  // Keep screenshots for review; fixture executables cannot be confused with a deliverable.
  await rm(join(directory, 'resources'), { recursive: true, force: true })
}
