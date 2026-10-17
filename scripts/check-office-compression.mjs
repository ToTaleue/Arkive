// Generated Office fixtures only; real Electron, SQLite, Sharp, pngquant and SSIMULACRA2.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'
import { build } from 'vite'

await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/office-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve('src/main/modules/office-compression/service.test.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'checks.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolveCheck, reject) => {
    const child = spawn(electron, [resolve(directory, 'checks.cjs')], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolveCheck()
      else reject(new Error(`Office checks failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
