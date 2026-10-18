// Prepare this source checkout for testing under the current Mac account.
/* eslint @typescript-eslint/explicit-function-return-type: "off" -- JavaScript setup script. */
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(
    '完整测试需要原生 arm64 Node.js 和 Apple 芯片 Mac；当前为 ' +
      process.platform +
      '-' +
      process.arch
  )
}
const version = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' })
if (version.status !== 0 || Number(version.stdout.trim().split('.')[0]) < 15) {
  throw new Error(
    '当前随包 qpdf 的 Mach-O 最低系统版本为 macOS 15；请使用 macOS 15 或更新系统做完整测试。'
  )
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = join(homedir(), 'Desktop', 'arkive-test')
await mkdir(testRoot, { recursive: true })
const oldRoot = '/Users/hu1hui/Desktop/arkive-test'
const changed = []
async function adaptTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await adaptTests(path)
    else if (
      (entry.name.endsWith('.test.ts') || /^check-.*\.(mjs|mts)$/.test(entry.name)) &&
      !entry.name.includes('windows')
    ) {
      const before = await readFile(path, 'utf8')
      const after = before.replaceAll(oldRoot, testRoot)
      if (after !== before) {
        await writeFile(path, after)
        changed.push(path.slice(project.length + 1))
      }
    }
  }
}
await adaptTests(join(project, 'scripts'))
await adaptTests(join(project, 'src'))
const toolsRoot = join(project, 'resources/tools/darwin-arm64')
const manifest = JSON.parse(await readFile(join(toolsRoot, 'manifest.json'), 'utf8'))
for (const executable of [
  ...manifest.tools.map((tool) => tool.executable),
  'mole/mole',
  'mole/bin/analyze-go',
  'mole/bin/status-go'
]) {
  await chmod(join(toolsRoot, executable), 0o755)
}
try {
  await copyFile(
    join(project, '.env.example'),
    join(project, '.env.local'),
    constants.COPYFILE_EXCL
  )
} catch (error) {
  if (error.code !== 'EEXIST') throw error
}
console.log(`macOS ${version.stdout.trim()}, Node ${process.version}, ${process.arch}`)
console.log(`测试样本目录：${testRoot}`)
console.log(`适配了 ${changed.length} 个测试文件中的旧用户名路径；未修改产品服务。`)
const failures = []
for (const [name, flag] of [
  ['ffmpeg', '-version'],
  ['ffprobe', '-version'],
  ['ab-av1', '--version'],
  ['czkawka_cli', '--version'],
  ['qpdf/bin/qpdf', '--version'],
  ['--version'],
  ['pngquant', '--version'],
  ['arkive-apfs-dedupe', '--version']
]) {
  const result = spawnSync(join(toolsRoot, name), [flag], { encoding: 'utf8', timeout: 15_000 })
  if (result.status !== 0) {
    failures.push(name)
    console.error(`FAIL ${name}: ${(result.error?.message ?? result.stderr ?? '').slice(-1200)}`)
  } else console.log(`OK ${name}: ${(result.stdout || result.stderr).split('\n')[0]}`)
}
const shell = spawnSync('/bin/bash', ['-n', join(toolsRoot, 'mole/mo')], { encoding: 'utf8' })
if (shell.status !== 0) failures.push('mole shell syntax')
console.log('Mole 仅做脚本语法和执行权限预检；未运行扫描、清理或管理员授权。')
await writeFile(
  join(testRoot, 'macos-preflight.json'),
  JSON.stringify(
    {
      time: new Date().toISOString(),
      project,
      testRoot,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      macOS: version.stdout.trim(),
      adaptedTestFiles: changed,
      failedTools: failures
    },
    null,
    2
  )
)
if (failures.length)
  throw new Error('工具预检失败：' + failures.join(', ') + '。先处理这些错误，再运行集成测试。')
console.log('预检通过。可继续安装依赖、构建和测试，操作步骤见 docs/macos-install-test.md。')
