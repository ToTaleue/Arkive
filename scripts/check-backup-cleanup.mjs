// Isolated Electron + SQLite + real Trash + built preload/React UI, using generated samples only.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'

await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
const state = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/backup-cleanup-state-')
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/backup-cleanup-check',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/main/modules/catalog/backup-cleanup.integration.test.ts'),
      external: ['electron', 'sharp'],
      output: { format: 'cjs', entryFileNames: 'check.cjs' }
    }
  }
})
await symlink(resolve('resources'), resolve('out/backup-cleanup-check/resources'), 'dir')
const require = createRequire(import.meta.url)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(
  require('electron'),
  [resolve('out/backup-cleanup-check/check.cjs'), `--user-data-dir=${state}`],
  { stdio: 'inherit', env: environment }
)
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('close', (code) => {
  process.exitCode = code ?? 1
})
