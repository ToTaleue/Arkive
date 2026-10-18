// Run the real bundled qpdf through the PDF Service in Electron.
// Run with: rtk proxy node scripts/check-pdf-compression.mjs
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'
import { build } from 'vite'

await mkdir('out', { recursive: true })
const buildDirectory = await mkdtemp(resolve('out/pdf-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      target: 'node22',
      outDir: buildDirectory,
      rollupOptions: {
        input: resolve('src/main/modules/pdf-compression/service.test.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'checks.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(buildDirectory, 'resources'), 'dir')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolveCheck, reject) => {
    const child = spawn(electron, [resolve(buildDirectory, 'checks.cjs')], {
      env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolveCheck()
      else reject(new Error(`PDF checks failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(buildDirectory, { recursive: true, force: true })
}
