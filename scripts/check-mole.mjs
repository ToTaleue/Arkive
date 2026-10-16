// Run with: rtk proxy node scripts/check-mole.mjs
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

await mkdir('out', { recursive: true })
const buildDir = await mkdtemp(resolve('out/mole-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      target: 'node22',
      outDir: buildDir,
      rollupOptions: {
        input: resolve('src/execution/mole-output.test.ts'),
        output: { format: 'es', entryFileNames: 'checks.mjs' }
      }
    }
  })
  await import(pathToFileURL(resolve(buildDir, 'checks.mjs')).href)
} finally {
  await rm(buildDir, { recursive: true, force: true })
}
