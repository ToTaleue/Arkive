// Real chat UI with a local model HTTP fixture; real business effects and isolated catalog.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'

await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/agent-ui-check-'))
const state = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/agent-ui-state-')
try {
  const osFixture = resolve(directory, 'os-fixture.mjs')
  await writeFile(
    osFixture,
    `export * from 'os'; export const homedir = () => ${JSON.stringify(state)}`
  )
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { 'node:os': osFixture } },
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve(
          process.argv.includes('--skills')
            ? 'src/main/modules/agent/skills-ui.test.ts'
            : process.argv.includes('--workflow')
              ? 'src/main/modules/agent/workflow-ui.test.ts'
              : 'src/main/modules/agent/ui.test.ts'
        ),
        external: ['electron', 'sharp'],
        output: { format: 'cjs', entryFileNames: 'check.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'check.cjs'), `--user-data-dir=${state}`], {
      env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Agent UI integration failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
