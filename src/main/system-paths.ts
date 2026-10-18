import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

// Only operating-system paths are protected; user data directories are unrestricted.
const macSystemRoots = [
  '/System',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/usr/lib',
  '/usr/libexec',
  '/private/etc'
]

function windowsSystemRoots(): string[] {
  const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const volume = parse(windows).root
  return [
    windows,
    process.env.ProgramFiles ?? join(volume, 'Program Files'),
    process.env['ProgramFiles(x86)'] ?? join(volume, 'Program Files (x86)'),
    process.env.ProgramData ?? join(volume, 'ProgramData'),
    join(volume, 'Recovery'),
    join(volume, 'System Volume Information'),
    join(volume, '$Recycle.Bin')
  ]
}

const systemRoots = process.platform === 'win32' ? windowsSystemRoots() : macSystemRoots

function filesystemPath(path: string): string {
  if (process.platform !== 'win32') return path
  if (path.startsWith('\\\\.\\')) throw new Error('系统设备路径受保护，不能处理。')
  if (!path.startsWith('\\\\?\\')) return path
  const plain = path.slice(4)
  if (plain.toUpperCase().startsWith('UNC\\')) return `\\\\${plain.slice(4)}`
  if (/^[a-z]:\\/i.test(plain)) return plain
  throw new Error('系统设备路径受保护，不能处理。')
}

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
  path = filesystemPath(path)
  if (!isAbsolute(path)) throw new Error('文件操作须使用本地绝对路径。')
  const absolute = resolve(path)
  if (absolute === parse(absolute).root) throw new Error('根目录受保护，不能整体处理。')
  const target = join(await resolveAncestors(dirname(absolute)), basename(absolute))
  if (target === parse(target).root) throw new Error('根目录受保护，不能整体处理。')
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
        candidate === parse(candidate).root ||
        systemRoots.some(
          (root) => isWithin(root, candidate) || (includeAncestors && isWithin(candidate, root))
        )
    )
  ) {
    throw new Error('系统关键路径受保护，禁止写入、移动或删除。')
  }
}
