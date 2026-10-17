// Run with: rtk proxy node scripts/check-tasks.mjs
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import { spawn } from 'node:child_process'
import electron from 'electron'

const testRoot = '/Users/hu1hui/Desktop/arkive-test'
await mkdir(testRoot, { recursive: true })
const directory = await mkdtemp(resolve(testRoot, 'tasks-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve('src/main/tasks/manager.test.ts'),
        output: { format: 'es', entryFileNames: 'checks.mjs' }
      }
    }
  })
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--test', resolve(directory, 'checks.mjs')], {
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Task checks failed: ${code ?? signal}`))
    })
  })
  // Build the app first to test the actual preload: pnpm run build.
  if (process.argv.includes('--ipc')) {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: true,
        target: 'node22',
        outDir: directory,
        emptyOutDir: false,
        rollupOptions: {
          input: resolve('src/main/tasks/ipc.test.ts'),
          external: ['electron'],
          output: { format: 'cjs', entryFileNames: 'ipc.cjs' }
        }
      }
    })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await new Promise((done, reject) => {
      const child = spawn(electron, [resolve(directory, 'ipc.cjs')], { env, stdio: 'inherit' })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        if (code === 0 && !signal) done()
        else reject(new Error(`Task IPC check failed: ${code ?? signal}`))
      })
    })
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
