// Run the real bundled FFmpeg through the Service in Electron on a Mac with VideoToolbox.
// Run with: rtk proxy node scripts/check-video-compression.mjs
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { build } from 'vite'

await mkdir('out', { recursive: true })
const buildDirectory = await mkdtemp(resolve('out/video-check-'))
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: true,
      target: 'node22',
      outDir: buildDirectory,
      rollupOptions: {
        input: resolve(
          process.argv.includes('--ui')
            ? 'src/main/modules/video-compression/ui.test.ts'
            : process.argv.includes('--dji')
              ? 'src/main/modules/video-compression/dji.test.ts'
              : 'src/main/modules/video-compression/service.test.ts'
        ),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'checks.cjs' }
      }
    }
  })
  // Optionally test the tools copied into a built .app, without an installed toolchain.
  const toolsOption = process.argv.indexOf('--packaged-tools')
  if (toolsOption !== -1) {
    const toolsPath = process.argv[toolsOption + 1]
    if (!toolsPath || toolsPath.startsWith('--')) throw new Error('--packaged-tools needs a path')
    const toolsDirectory = join(buildDirectory, 'resources', 'tools')
    await mkdir(toolsDirectory, { recursive: true })
    await symlink(resolve(toolsPath), join(toolsDirectory, 'darwin-arm64'), 'dir')
  } else {
    // Electron treats the entry directory as app.getAppPath(); reuse actual bundled tools.
    await symlink(resolve('resources'), resolve(buildDirectory, 'resources'), 'dir')
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolveCheck, reject) => {
    const child = spawn(electron, [resolve(buildDirectory, 'checks.cjs')], {
      env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0 && !signal) resolveCheck()
      else reject(new Error(`Video checks failed: ${code ?? signal}`))
    })
  })
} finally {
  await rm(buildDirectory, { recursive: true, force: true })
}
