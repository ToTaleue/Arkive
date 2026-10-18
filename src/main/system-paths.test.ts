import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, toNamespacedPath } from 'node:path'
import { test } from 'node:test'
import { assertSystemWriteAllowed, resolveFilePath } from './system-paths'

void test(
  'Windows protects drive roots before any destructive operation',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = parse(process.cwd()).root
    await assert.rejects(resolveFilePath(root), /根目录受保护/)
    await assert.rejects(assertSystemWriteAllowed(root), /根目录受保护/)
    await assert.rejects(resolveFilePath('\\\\server\\share\\'), /根目录受保护/)
    await assert.rejects(resolveFilePath('\\\\.\\PhysicalDrive0'), /系统设备路径受保护/)
    await assert.rejects(
      resolveFilePath('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Windows'),
      /系统设备路径受保护/
    )
  }
)

void test(
  'Windows protects system/program directories, case variants and extended paths',
  { skip: process.platform !== 'win32' },
  async () => {
    const windows = process.env.SystemRoot ?? 'C:\\Windows'
    const directories = [
      windows,
      join(windows, 'System32'),
      ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
        (path): path is string => Boolean(path)
      )
    ]
    for (const directory of directories) {
      for (const candidate of [directory, directory.toUpperCase(), toNamespacedPath(directory)]) {
        await assert.rejects(assertSystemWriteAllowed(candidate), /系统关键路径受保护/, candidate)
        await assert.rejects(
          assertSystemWriteAllowed(candidate, true),
          /系统关键路径受保护/,
          candidate
        )
      }
    }
  }
)

void test('system protection allows user data and similarly named sibling folders', async () => {
  const root = process.env.ARKIVE_TEST_ROOT ?? join(homedir(), 'Desktop', 'arkive-test')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'system-guard-'))
  for (const name of ['Windows', 'Program Files', 'System', 'Windows-old']) {
    await assert.doesNotReject(assertSystemWriteAllowed(join(directory, name), true))
  }
})
