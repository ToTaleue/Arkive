// Reproducible first-party helper; no compiler is needed on end users' machines.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The bundled helper build currently supports macOS arm64 only.')
}
const executable = 'resources/tools/darwin-arm64/arkive-apfs-dedupe'
execFileSync(
  '/usr/bin/clang',
  [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-O2',
    '-arch',
    'arm64',
    '-mmacosx-version-min=13.0',
    'native/apfs-dedupe.c',
    '-o',
    executable
  ],
  { stdio: 'inherit' }
)
execFileSync(resolve(executable), ['--version'], { stdio: 'inherit' })
const manifestPath = 'resources/tools/darwin-arm64/manifest.json'
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const tool = {
  name: 'apfs_dedupe',
  version: '1',
  executable: 'arkive-apfs-dedupe',
  source: 'native/apfs-dedupe.c',
  buildScript: 'scripts/build-apfs-dedupe.mjs',
  binarySha256: createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  architecture: 'arm64',
  minimumMacOSFromMachO: '13.0',
  notes:
    'First-party fixed helper; APFS fclonefileat, metadata verification, atomic exchange and recovery. Links only system libraries. No ordinary-copy fallback.'
}
const index = manifest.tools.findIndex((entry) => entry.name === tool.name)
if (index < 0) manifest.tools.push(tool)
else manifest.tools[index] = tool
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
