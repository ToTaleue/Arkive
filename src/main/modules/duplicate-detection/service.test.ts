import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseDuplicateReport } from '../../../execution/czkawka'
import { scanDuplicates } from './service'

const fixtureRoot = '/Users/hu1hui/Desktop/arkive-test'

function checkReports(): void {
  const root = '/folder'
  const entry = (path: string): object => ({
    path,
    hash: 'a'.repeat(64),
    modified_date: 1,
    size: 3
  })
  const good = { '3': [[entry('/folder/a'), entry('/folder/b')]] }
  assert.equal(parseDuplicateReport(good, root)[0].files[0].modifiedAtMs, 1000)
  for (const bad of [
    null,
    [],
    { '3': [[entry('/folder/a')]] },
    { '3': [[entry('/folder/a'), entry('/folder-other/b')]] },
    { '3': [[entry('/folder/a'), entry('/folder/../outside')]] },
    { '3': [[entry('/folder/a'), entry('/folder/a')]] },
    { '3': [[entry('/folder/a'), { ...entry('/folder/b'), hash: 'b'.repeat(64) }]] },
    { '3': [[entry('/folder/a'), { ...entry('/folder/b'), size: 4 }]] },
    { '3': [[entry('/folder/a'), { ...entry('/folder/b'), modified_date: NaN }]] },
    { '03': [[entry('/folder/a'), entry('/folder/b')]] }
  ]) {
    assert.throws(() => parseDuplicateReport(bad, root), /结果格式无效/)
  }
}

export async function checkDuplicateDetection(): Promise<void> {
  checkReports()
  const directory = await mkdtemp(join(fixtureRoot, 'duplicate-check-'))
  try {
    const source = join(directory, '文件夹, $ [test]')
    const nested = join(source, 'nested')
    const outside = join(directory, 'outside')
    await mkdir(nested, { recursive: true })
    await mkdir(outside)
    const original = Buffer.alloc(16_384, 'a')
    const different = Buffer.from(original)
    different.fill('b', 4096, 8192)
    const fixtures = new Map([
      [join(source, 'first.bin'), original],
      [join(nested, 'renamed.bin'), original],
      [join(source, 'different-middle.bin'), different],
      [join(source, 'small.txt'), Buffer.from('abc')],
      [join(nested, 'small-copy.txt'), Buffer.from('abc')],
      [join(source, 'zero'), Buffer.alloc(0)],
      [join(nested, 'zero'), Buffer.alloc(0)],
      [join(outside, 'outside.bin'), original]
    ])
    for (const [path, contents] of fixtures) await writeFile(path, contents)
    await symlink(outside, join(source, 'external-directory'), 'dir')
    await symlink(join(outside, 'outside.bin'), join(source, 'external-file'))
    await symlink(source, join(nested, 'cycle'), 'dir')
    await link(join(source, 'first.bin'), join(source, 'existing-hard-link.bin'))
    const beforeNames = await readdir(source)
    const hashes = await Promise.all(
      [...fixtures.keys()].map(async (path) =>
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      )
    )
    const result = await scanDuplicates({ directoryPath: source })
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.warnings, [])
    assert.equal(result.directoryPath, await realpath(source))
    assert.equal(result.groups.length, 2)
    assert.equal(result.duplicateFileCount, 2)
    assert.equal(result.redundantBytes, original.length + 3)
    assert.deepEqual(
      result.groups.map((group) => group.sizeBytes),
      [original.length, 3]
    )
    const large = result.groups[0]
    assert.equal(large.files.length, 2, 'Existing hard-link aliases are counted only once')
    assert.equal(
      new Set(await Promise.all(large.files.map(async (file) => (await stat(file.path)).ino))).size,
      2
    )
    assert.ok(large.files.some((file) => file.relativePath === 'nested/renamed.bin'))
    assert.ok(
      result.groups
        .flatMap((group) => group.files)
        .every((file) => !/external|cycle|outside|different-middle/.test(file.relativePath)),
      'No symlink traversal, outside-folder matches, or prehash-only false positives'
    )
    assert.deepEqual(await readdir(source), beforeNames)
    assert.deepEqual(
      await Promise.all(
        [...fixtures.keys()].map(async (path) =>
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex')
        )
      ),
      hashes,
      'Scan must preserve every source and outside fixture'
    )
    await symlink(source, join(directory, 'selected-alias'), 'dir')
    const alias = await scanDuplicates({ directoryPath: join(directory, 'selected-alias') })
    assert.deepEqual(alias, result)
    console.log(
      'PASS: nested duplicates, small files, full hashes, hard links, symlinks, unchanged sources'
    )

    const unique = join(directory, 'unique')
    await mkdir(unique)
    await writeFile(join(unique, 'one.txt'), 'one')
    await writeFile(join(unique, 'two.txt'), 'two')
    const [repeated, noDuplicates] = await Promise.all([
      scanDuplicates({ directoryPath: source }),
      scanDuplicates({ directoryPath: unique })
    ])
    assert.deepEqual(repeated, result)
    assert.equal(noDuplicates.status, 'completed')
    assert.deepEqual(noDuplicates.groups, [])
    assert.equal(noDuplicates.redundantBytes, 0)
    assert.equal(noDuplicates.duplicateFileCount, 0)
    const empty = join(directory, 'empty')
    await mkdir(empty)
    assert.deepEqual((await scanDuplicates({ directoryPath: empty })).groups, [])
    await assert.rejects(scanDuplicates({ directoryPath: '.' }), /绝对路径/)
    await assert.rejects(scanDuplicates({ directoryPath: '/' }), /根目录/)
    await assert.rejects(scanDuplicates({ directoryPath: join(source, 'small.txt') }), /文件夹/)
    await assert.rejects(scanDuplicates({ directoryPath: join(directory, 'missing') }), {
      code: 'ENOENT'
    })
    console.log('PASS: concurrent isolated scans, empty/unique folders, invalid inputs and reports')

    const unreadable = join(source, 'unreadable')
    await mkdir(unreadable)
    await writeFile(join(unreadable, 'copy.txt'), 'abc')
    await chmod(unreadable, 0)
    try {
      const partial = await scanDuplicates({ directoryPath: source })
      assert.equal(partial.status, 'partial')
      assert.ok(partial.warnings.join('\n').includes('Permission denied'))
      assert.equal(partial.groups.length, 2)
    } finally {
      await chmod(unreadable, 0o700)
    }
    console.log('PASS: unreadable subfolder is reported as partial, not a complete scan')

    await assert.rejects(scanDuplicates({ directoryPath: source }, AbortSignal.abort()), {
      name: 'AbortError'
    })
    const largeDirectory = join(directory, 'cancellation')
    await mkdir(largeDirectory)
    // Sparse, generated files force full hashing without copying real user data.
    for (const name of ['a.bin', 'b.bin']) {
      const file = await open(join(largeDirectory, name), 'wx')
      try {
        await file.truncate(512 * 1024 * 1024)
      } finally {
        await file.close()
      }
    }
    const controller = new AbortController()
    const cancelled = scanDuplicates({ directoryPath: largeDirectory }, controller.signal)
    const rejection = assert.rejects(cancelled, { name: 'AbortError' })
    let pid: number | undefined
    let temporary: string | undefined
    const deadline = Date.now() + 5000
    try {
      while (!pid) {
        const line = execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' })
          .split('\n')
          .find((line) => line.includes('czkawka_cli dup') && line.includes(largeDirectory))
        if (line) {
          pid = Number(line.trim().split(/\s+/)[0])
          const reportPath = line.split(' -C ')[1]?.trim()
          assert.ok(reportPath)
          temporary = dirname(reportPath)
        } else {
          assert.ok(Date.now() < deadline, 'Timed out waiting for the real scan process')
          await delay(5)
        }
      }
    } finally {
      controller.abort()
      await rejection
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.ok(temporary)
    await assert.rejects(stat(temporary), { code: 'ENOENT' })
    assert.deepEqual(await readdir(largeDirectory), ['a.bin', 'b.bin'])
    console.log(
      'PASS: active cancellation stops the real CLI, removes its report directory, preserves sources'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
