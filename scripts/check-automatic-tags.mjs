// Real compression, metadata collection, Pi request and Finder tag write.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { symlink } from 'node:fs/promises'
import { resolve } from 'node:path'

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/automatic-tags-check',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/main/modules/catalog/automatic-tags.test.ts'),
      external: ['electron', 'sharp', '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'],
      output: { format: 'cjs', entryFileNames: 'check.cjs' }
    }
  }
})
await symlink(resolve('resources'), resolve('out/automatic-tags-check/resources'), 'dir')
const require = createRequire(import.meta.url)
const electron = require('electron')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve('out/automatic-tags-check/check.cjs')], {
  stdio: 'inherit',
  env: environment
})
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('close', (code) => {
  process.exitCode = code ?? 1
})
