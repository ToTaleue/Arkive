// Real renderer/preload/IPC/Services. Only native dialog choices are fixture responses.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'

await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/processing-ui-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve('src/main/modules/processing/ui.test.ts'),
        external: ['electron', 'sharp'],
        output: { format: 'cjs', entryFileNames: 'check.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'check.cjs')], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Processing UI failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
