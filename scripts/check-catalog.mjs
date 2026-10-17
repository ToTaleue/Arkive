// Real Electron runtime, SQLite, filesystem and Finder tags. Only generated fixtures are moved.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { symlink } from 'node:fs/promises'

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/catalog-check',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/main/modules/catalog/integration.test.ts'),
      external: ['electron', 'sharp'],
      output: { format: 'cjs', entryFileNames: 'check.cjs' }
    }
  }
})
const require = createRequire(import.meta.url)
await symlink(resolve('resources'), resolve('out/catalog-check/resources'), 'dir')
const electron = require('electron')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve('out/catalog-check/check.cjs')], {
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
