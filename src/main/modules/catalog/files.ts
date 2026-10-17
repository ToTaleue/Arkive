import { createHash } from 'node:crypto'
import { createReadStream, constants, type Stats } from 'node:fs'
import { copyFile, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { runSystemTool } from '../../../execution/process'

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export async function fileInfo(path: string): Promise<Stats> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`不是普通文件：${path}`)
  return info
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

export async function hashFile(path: string): Promise<string> {
  await fileInfo(path)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function managedDirectory(root: string, date?: string): Promise<string> {
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)) !== root) {
    throw new Error('受管理目录不能是符号链接。')
  }
  if (!date) return root
  const path = join(root, date)
  await mkdir(path, { recursive: true })
  if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Error('日期目录不能是符号链接。')
  }
  return path
}

export function dayKey(now = new Date()): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function destination(directory: string, name: string, id: string): string {
  const parsed = parse(name)
  // Reserve space for the UUID, extension and staging suffix within macOS's byte limit.
  const budget = 240 - Buffer.byteLength(`-${id}${parsed.ext}.partial`)
  let stem = ''
  for (const character of parsed.name) {
    if (Buffer.byteLength(stem + character) > budget) break
    stem += character
  }
  return join(directory, `${stem}-${id}${parsed.ext}`)
}

/** Exclusive publication. The recorded UUID owns this staging path across restarts. */
export async function copyVerified(
  source: string,
  target: string,
  hash: string,
  metadata = false
): Promise<void> {
  if (await exists(target)) {
    if ((await hashFile(target)) !== hash) throw new Error('目标已存在且内容不同，未覆盖。')
    return
  }
  const staging = `${target}.partial`
  if ((await exists(staging)) && (await hashFile(staging)) !== hash) await unlink(staging)
  if (!(await exists(staging))) {
    if (metadata) {
      // ditto carries extended attributes/resource forks when a hard link cannot cross volumes.
      const result = await runSystemTool('ditto', ['--rsrc', '--extattr', source, staging])
      if (result.exitCode !== 0 || result.signal) throw new Error(`复制原件失败：${result.stderr}`)
    } else await copyFile(source, staging, constants.COPYFILE_EXCL)
  }
  if ((await hashFile(staging)) !== hash) throw new Error('文件副本校验失败，原件未移除。')
  await syncFile(staging)
  await link(staging, target)
  await unlink(staging)
}

export async function assertManagedFile(root: string, path: string): Promise<void> {
  await managedDirectory(root)
  await managedDirectory(root, parse(dirname(path)).base)
  if ((await realpath(dirname(path))) !== dirname(path) || !path.startsWith(`${root}/`)) {
    throw new Error('文件已离开受管理目录。')
  }
  await fileInfo(path)
}
