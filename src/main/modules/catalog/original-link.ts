import { lstat, readlink, realpath, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { assertSystemWriteAllowed } from '../../system-paths'
import { hasCode, hashFile } from './files'

export function originalLinkPath(original: string, output: string): string {
  // A converted file must keep its actual format, e.g. photo.png becomes photo.webp.
  const extension = extname(output)
  if (extname(original).toLowerCase() === extension.toLowerCase()) return original
  return join(dirname(original), `${basename(original, extname(original))}${extension}`)
}

/** Exclusive link creation; source replacement requires explicit move intent and equal content. */
export async function createOriginalLink(
  path: string,
  target: string,
  move = false
): Promise<void> {
  await assertSystemWriteAllowed(path)
  if ((await realpath(dirname(path))) !== dirname(path)) {
    throw new Error('原目录位置已变化，请核对后重试。')
  }
  if (move) {
    // The caller has already published and verified the formal archive. Only remove
    // the exact source content it contains; new files and foreign links stay intact.
    try {
      const before = await lstat(path)
      if (before.isFile() && !before.isSymbolicLink()) {
        if ((await hashFile(path)) !== (await hashFile(target)))
          throw new Error('原位置文件与归档内容不同，未搬移或覆盖。')
        const after = await lstat(path)
        if (
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error('原位置文件发生变化，未搬移。')
        await unlink(path)
      }
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
  }
  try {
    await symlink(target, path)
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    // A previous attempt may have created the link before recording its completion.
    if ((await lstat(path)).isSymbolicLink() && (await readlink(path)) === target) return
    throw new Error('原位置已被占用，未覆盖。')
  }
}
