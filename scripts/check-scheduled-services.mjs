// Real Task queue, file probes, Czkawka and APFS helper; isolated Mole subprocess fixture.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/scheduled-services-')
const fixtureTools = join(directory, 'resources/tools/darwin-arm64')
try {
  await mkdir(join(fixtureTools, 'mole'), { recursive: true })
  for (const tool of ['ffprobe', 'ffmpeg', 'gs', 'qpdf', 'czkawka_cli', 'arkive-apfs-dedupe']) {
    await symlink(resolve('resources/tools/darwin-arm64', tool), join(fixtureTools, tool))
  }
  const mole = String.raw`#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const root = ${JSON.stringify(directory)}
const args = process.argv.slice(2)
appendFileSync(join(root, 'mole-calls'), JSON.stringify(args) + '\n')
if (existsSync(join(root, 'hold-mole-descendant'))) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
  writeFileSync(join(root, 'mole-descendant-pid'), String(child.pid))
} else if (existsSync(join(root, 'hold-mole'))) {
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
} else if (args[0] === 'analyze') {
  console.log(JSON.stringify({ scan_status: args[2].endsWith('partial') ? 'partial' : 'complete', path: args[2] }))
} else if (args[0] === 'uninstall') {
  console.log(JSON.stringify([{ name: 'Fixture', bundle_id: 'fixture', source: 'App', uninstall_name: 'Fixture', path: '/fixture.app', size: '1MB' }]))
} else {
  if (args[0] === 'clean') {
    mkdirSync(join(root, '.config/mole'), { recursive: true })
    writeFileSync(join(root, '.config/mole/clean-list.txt'), '=== Fixtures ===\n' + join(root, 'cache') + ' # 1MB\n')
  }
  if (args[0] === 'installer') console.log('Found installer: ' + join(root, 'fixture.dmg'))
  if (args[0] === 'purge') console.log('[DRY RUN] ' + join(root, 'node_modules') + ', 1MB')
  console.log('➤ Fixture preview\nFixture complete')
}
`
  await writeFile(join(fixtureTools, 'mole/mo'), mole, { mode: 0o755 })
  const electronFixture = join(directory, 'electron.mjs')
  await writeFile(
    electronFixture,
    `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(directory)}, getPath: () => ${JSON.stringify(join(directory, 'recovery'))} }
export const shell = { trashItem: () => { throw new Error('Unexpected real trash operation') } }`
  )
  const osFixture = join(directory, 'os.mjs')
  await writeFile(
    osFixture,
    `export * from 'os'; export const homedir = () => ${JSON.stringify(directory)}`
  )
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: 'electron', replacement: electronFixture },
        { find: 'node:os', replacement: osFixture }
      ]
    },
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve('src/main/tasks/scheduled-services.test.ts'),
        external: ['sharp'],
        output: { format: 'es', entryFileNames: 'checks.mjs' }
      }
    }
  })
  const { checkScheduledServices } = await import(pathToFileURL(join(directory, 'checks.mjs')).href)
  await checkScheduledServices(directory)
} finally {
  await rm(directory, { recursive: true, force: true })
}
