import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Only operating-system paths are protected; user data directories are unrestricted.
const systemRoots = [
  '/System',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/libexec',
  '/private/etc'
]

function isWithin(root: string, path: string): boolean {
  const child = relative(root.toLowerCase(), path.toLowerCase())
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

async function resolveAncestors(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT') ||
      dirname(path) === path
    ) {
      throw error
    }
    return join(await resolveAncestors(dirname(path)), basename(path))
  }
}

/** Resolve parents while keeping the leaf itself for rename/rm of symlinks. */
export async function resolveFilePath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('文件操作须使用本地绝对路径。')
  const absolute = resolve(path)
  const target = join(await resolveAncestors(dirname(absolute)), basename(absolute))
  if (target === sep) throw new Error('根目录受保护，不能整体处理。')
  return target
}

/** Guard writes/removals, including symlink aliases and destructive ancestor operations. */
export async function assertSystemWriteAllowed(
  path: string,
  includeAncestors = false
): Promise<void> {
  const target = await resolveFilePath(path)
  const candidates = [resolve(path), target, await resolveAncestors(target)]
  if (
    candidates.some(
      (candidate) =>
        candidate === sep ||
        systemRoots.some(
          (root) => isWithin(root, candidate) || (includeAncestors && isWithin(candidate, root))
        )
    )
  ) {
    throw new Error('系统关键路径受保护，禁止写入、移动或删除。')
  }
}
