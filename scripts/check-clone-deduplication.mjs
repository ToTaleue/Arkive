import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const fixtureRoot = '/Users/hu1hui/Desktop/arkive-test'
await mkdir(fixtureRoot, { recursive: true })
const directory = await mkdtemp(join(fixtureRoot, 'clone-build-'))
try {
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
  const electronFixture = join(directory, 'electron-fixture.mjs')
  await writeFile(
    electronFixture,
    `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(process.cwd())}, getPath: () => ${JSON.stringify(directory)} }
const unexpected = () => { throw new Error('Unexpected Electron shell operation in clone check') }
export const shell = { openPath: unexpected, showItemInFolder: unexpected, trashItem: unexpected }`
  )
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { electron: electronFixture } },
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(
          `src/main/modules/clone-deduplication/${process.argv.includes('--agent') ? 'agent' : 'service'}.test.ts`
        ),
        output: { format: 'es', entryFileNames: 'checks.mjs' }
      }
    }
  })
  const checks = await import(pathToFileURL(join(directory, 'checks.mjs')).href)
  if (process.argv.includes('--agent')) await checks.checkCloneAgent()
  else await checks.checkCloneDeduplication()
} finally {
  await rm(directory, { recursive: true, force: true })
}
