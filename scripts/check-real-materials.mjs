// Run against an isolated acceptance directory containing original-copies/ and public-samples/.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'

const root = process.env.ARKIVE_ACCEPTANCE_ROOT
if (!root || !root.startsWith('/'))
  throw new Error('Set ARKIVE_ACCEPTANCE_ROOT to an isolated run directory')
await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/real-materials-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve('src/main/modules/processing/real-materials.test.ts'),
        external: ['electron', 'sharp'],
        output: { format: 'cjs', entryFileNames: 'check.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(
      electron,
      [resolve(directory, 'check.cjs'), `--user-data-dir=${resolve(root, 'electron-state')}`],
      { env, stdio: 'inherit' }
    )
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Real materials failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
