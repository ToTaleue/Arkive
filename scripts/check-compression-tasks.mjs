// Real Electron + SQLite + bundled encoders; all file operations use generated fixtures.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'

const root = '/Users/hu1hui/Desktop/arkive-test'
await mkdir(root, { recursive: true })
const directory = await mkdtemp(resolve(root, 'compression-tasks-runtime-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve('src/main/modules/catalog/compression-tasks.test.ts'),
        external: ['electron', 'sharp'],
        output: { format: 'cjs', entryFileNames: 'checks.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  await symlink(resolve('node_modules'), resolve(directory, 'node_modules'), 'dir')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'checks.cjs')], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Compression task checks failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
