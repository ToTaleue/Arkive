// Build an isolated copy of the real ArchiveAction, preload and Catalog for this check.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import electron from 'electron'

await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/archive-links-check-'))
try {
  for (const [input, name] of [
    ['src/main/modules/catalog/original-link.integration.test.ts', 'check.cjs'],
    ['src/preload/index.ts', 'preload.cjs']
  ]) {
    await build({
      configFile: false,
      logLevel: 'warn',
      build: {
        ssr: true,
        target: 'node22',
        outDir: directory,
        emptyOutDir: false,
        rollupOptions: {
          input: resolve(input),
          external: ['electron', 'sharp'],
          output: { format: 'cjs', entryFileNames: name }
        }
      }
    })
  }
  const renderer = resolve(directory, 'renderer-source')
  await mkdir(renderer)
  await writeFile(
    resolve(renderer, 'index.html'),
    '<html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>'
  )
  await writeFile(
    resolve(renderer, 'main.jsx'),
    `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ArchiveAction } from ${JSON.stringify(resolve('src/renderer/src/components/ArchiveAction.tsx'))};
    import { ArchivePage } from ${JSON.stringify(resolve('src/renderer/src/components/ArchivePage.tsx'))};
    import ${JSON.stringify(resolve('src/renderer/src/assets/archive.css'))};
    const id = new URLSearchParams(location.search).get('id');
    createRoot(document.getElementById('root')).render(
      new URLSearchParams(location.search).get('view') === 'archive'
        ? React.createElement(ArchivePage)
        : React.createElement(ArchiveAction, { record: { id } })
    );
  `
  )
  await build({
    configFile: false,
    logLevel: 'warn',
    root: renderer,
    base: './',
    plugins: [react()],
    build: { outDir: resolve(directory, 'renderer'), emptyOutDir: true }
  })
  await symlink(resolve('resources'), resolve(directory, 'resources'), 'dir')
  const env = { ...process.env, ARKIVE_LINK_CHECK_BUILD: directory }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'check.cjs')], { env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) done()
      else reject(new Error(`Archive links check failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}
