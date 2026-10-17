// Run: rtk proxy node scripts/check-duplicate-detection.mjs
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const fixtureRoot = '/Users/hu1hui/Desktop/arkive-test'
await mkdir(fixtureRoot, { recursive: true })
const directory = await mkdtemp(join(fixtureRoot, 'duplicate-build-'))
try {
  // Adapt only Electron app paths. The Service, executor, and bundled Czkawka are real.
  const electronFixture = join(directory, 'electron-fixture.mjs')
  await writeFile(
    electronFixture,
    `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(process.cwd())} }`
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
        input: resolve('src/main/modules/duplicate-detection/service.test.ts'),
        output: { format: 'es', entryFileNames: 'checks.mjs' }
      }
    }
  })
  const { checkDuplicateDetection } = await import(
    pathToFileURL(join(directory, 'checks.mjs')).href
  )
  await checkDuplicateDetection()
} finally {
  await rm(directory, { recursive: true, force: true })
}
