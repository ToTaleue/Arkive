// Real Pi SDK request and response validation against a local HTTP fixture.
import { build } from 'vite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/tag-recommendation-check',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/main/modules/catalog/tag-recommendation.test.ts'),
      external: ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai'],
      output: { format: 'es', entryFileNames: 'check.mjs' }
    }
  }
})
await import(pathToFileURL(resolve('out/tag-recommendation-check/check.mjs')).href)
