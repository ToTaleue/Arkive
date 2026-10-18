// Uses the configured model and generated fixtures only; never loads the production catalog.
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'

await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/agent-live-check-'))
const state = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/agent-live-state-')
try {
  const osFixture = resolve(directory, 'os-fixture.mjs')
  await writeFile(
    osFixture,
    `export * from 'os'; export const homedir = () => ${JSON.stringify(state)}`
  )
  const aliases = { 'node:os': osFixture }
  if (process.argv.includes('--authorization-fixture')) {
    const childProcessFixture = resolve(directory, 'child-process-fixture.mjs')
    await writeFile(
      childProcessFixture,
      `export * from 'child_process'
import { spawn as realSpawn } from 'child_process'
export function spawn(file, args, options) {
  if (file === '/usr/bin/sudo') {
    if (!args.includes('-n')) throw new Error('Password authorization must not run in this fixture')
    return realSpawn(process.execPath, ['-e', 'process.exit(0)'], {
      ...options,
      env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1' }
    })
  }
  if (file.endsWith('/mole/mo')) throw new Error('Authorization-only fixture must not start a Mole scan')
  if (file === '/usr/bin/osascript' || file === 'osascript') throw new Error('Native dialogs must not run in this fixture')
  return realSpawn(file, args, options)
}`
    )
    aliases['node:child_process'] = childProcessFixture
  }
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: aliases },
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      rollupOptions: {
        input: resolve(
          process.argv.includes('--extended')
            ? 'src/main/modules/agent/live-extended.test.ts'
            : 'src/main/modules/agent/live.test.ts'
        ),
        external: ['electron', 'sharp'],
        output: { format: 'cjs', entryFileNames: 'check.cjs' }
      }
    }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  const env = { ...process.env }
  if (process.argv.includes('--authorization-fixture')) env.ARKIVE_AGENT_AUTHORIZATION_FIXTURE = '1'
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'check.cjs'), `--user-data-dir=${state}`], {
      env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Live Agent integration failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
