import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { CloneDeduplicationService } from './service'
import { fileTags } from '../catalog/finder-tags'

const fixtureRoot = '/Users/hu1hui/Desktop/arkive-test'
const executable = resolve('resources/tools/darwin-arm64/arkive-apfs-dedupe')
function native(operation: string, source: string, target: string, transaction?: string): string {
  return execFileSync(
    executable,
    [operation, source, target, ...(transaction ? [transaction] : [])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}
function cloneIds(
  source: string,
  target: string
): { sourceCloneId: string; targetCloneId: string } {
  return JSON.parse(native('inspect', source, target)) as {
    sourceCloneId: string
    targetCloneId: string
  }
}

export async function checkCloneDeduplication(): Promise<void> {
  const directory = await mkdtemp(join(fixtureRoot, 'clone-check-'))
  const root = join(directory, 'recovery')
  const service = new CloneDeduplicationService(root)
  const source = join(directory, '源 $ [原件].bin'),
    target = join(directory, '副本, 一.bin')
  const bytes = randomBytes(4 * 1024 * 1024)
  try {
    await writeFile(source, bytes)
    await writeFile(target, bytes)
    await fileTags(source, ['源标签'])
    await fileTags(target, ['副本标签', '保留'])
    execFileSync('/usr/bin/xattr', [
      '-w',
      'com.arkive.fixture',
      'different source attribute',
      source
    ])
    execFileSync('/usr/bin/xattr', ['-w', 'com.arkive.fixture', 'target own attribute', target])
    execFileSync('/usr/bin/xattr', ['-w', 'com.arkive.source-only', 'do not inherit', source])
    execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.ResourceFork', '010203040506', target])
    execFileSync('/bin/chmod', [
      '+a',
      'everyone allow read,readattr,readextattr,readsecurity',
      target
    ])
    await chmod(source, 0o400)
    await chmod(target, 0o640)
    await utimes(target, new Date('2024-01-02T00:00:00Z'), new Date('2024-02-03T00:00:00Z'))
    const before = await stat(target)
    const acl = execFileSync('/bin/ls', ['-le', target], { encoding: 'utf8' }).split('\n').slice(1)
    const result = await service.deduplicate({ sourcePath: source, duplicatePaths: [target] })
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(result.items[0].status, 'deduplicated', JSON.stringify(result))
    assert.equal(result.logicalBytesShared, bytes.length)
    assert.equal(result.diskSpaceReclaimedBytes, null)
    assert.deepEqual(await readFile(source), bytes)
    assert.deepEqual(await readFile(target), bytes)
    const after = await stat(target)
    assert.notEqual(before.ino, after.ino)
    assert.equal(after.mode, before.mode)
    assert.equal(after.uid, before.uid)
    assert.equal(after.gid, before.gid)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(after.birthtimeMs, before.birthtimeMs)
    assert.deepEqual(
      execFileSync('/bin/ls', ['-le', target], { encoding: 'utf8' }).split('\n').slice(1),
      acl
    )
    assert.deepEqual(await fileTags(target), ['保留', '副本标签'])
    assert.throws(() =>
      execFileSync('/usr/bin/xattr', ['-p', 'com.arkive.source-only', target], { stdio: 'pipe' })
    )
    assert.equal(
      execFileSync('/usr/bin/xattr', ['-p', 'com.arkive.fixture', target], {
        encoding: 'utf8'
      }).trim(),
      'target own attribute'
    )
    assert.equal(
      execFileSync('/usr/bin/xattr', ['-px', 'com.apple.ResourceFork', target], {
        encoding: 'utf8'
      }).replace(/\s/g, ''),
      '010203040506'
    )
    const ids = cloneIds(source, target)
    assert.notEqual(ids.sourceCloneId, '0')
    assert.equal(
      ids.sourceCloneId,
      ids.targetCloneId,
      'Real APFS clones, not ordinary copies or hard links'
    )
    assert.notEqual((await stat(source)).ino, after.ino)
    assert.deepEqual(await readdir(root), [])
    const repeated = await service.deduplicate({ sourcePath: source, duplicatePaths: [target] })
    assert.equal(repeated.items[0].status, 'skipped')
    assert.equal(repeated.logicalBytesShared, 0)
    await writeFile(target, 'independent target edit')
    assert.deepEqual(await readFile(source), bytes)
    await chmod(source, 0o600)
    await writeFile(source, 'independent source edit')
    assert.equal(await readFile(target, 'utf8'), 'independent target edit')
    console.log(
      'PASS: real APFS clone IDs, independent writes, per-path mode/owner/timestamps/ACL/Finder tags/xattrs/resource fork; idempotence'
    )

    await writeFile(source, 'abcdef')
    await writeFile(target, 'abcxef')
    const hard = join(directory, 'hard'),
      alias = join(directory, 'alias')
    await link(target, hard)
    await symlink(source, alias)
    const partial = await service.deduplicate({
      sourcePath: source,
      duplicatePaths: [target, alias, source]
    })
    assert.equal(partial.status, 'partial')
    assert.equal(partial.items[0].status, 'failed')
    assert.equal(partial.items[1].status, 'failed')
    assert.equal(partial.items[2].status, 'skipped')
    assert.equal(await readFile(target, 'utf8'), 'abcxef')
    await rm(hard)
    const mismatch = await service.deduplicate({ sourcePath: source, duplicatePaths: [target] })
    assert.match(mismatch.items[0].reason ?? '', /contents differ/)
    assert.equal(await readFile(target, 'utf8'), 'abcxef')
    await assert.rejects(
      service.deduplicate({ sourcePath: source, duplicatePaths: ['/System/not-a-file'] }),
      /系统关键路径/
    )
    await assert.rejects(
      service.deduplicate({ sourcePath: '.', duplicatePaths: [target] }),
      /绝对路径/
    )
    await assert.rejects(service.deduplicate({ sourcePath: source, duplicatePaths: [] }), /1–100/)
    await assert.rejects(
      service.deduplicate({ sourcePath: source, duplicatePaths: [target] }, AbortSignal.abort()),
      { name: 'AbortError' }
    )
    assert.deepEqual(await readdir(root), [])
    console.log(
      'PASS: hard links/symlinks, different content, system paths, invalid scope and pre-abort leave files intact'
    )

    await writeFile(target, 'abcdef')
    const tx = await mkdtemp(join(directory, '.arkive-dedupe-'))
    native('prepare', source, target, tx)
    await writeFile(target, 'a changed after prepare')
    assert.throws(() => native('commit', source, target, tx), /Command failed/)
    native('recover', source, target, tx)
    assert.equal(await readFile(target, 'utf8'), 'a changed after prepare')
    await rm(tx, { recursive: true })
    console.log(
      'PASS: content changed after preparation is rejected and original current data retained'
    )

    await writeFile(target, 'abcdef')
    const replacedPath = await mkdtemp(join(directory, '.arkive-dedupe-'))
    native('prepare', source, target, replacedPath)
    const displaced = join(directory, 'displaced-original')
    await rename(target, displaced)
    await symlink(source, target)
    assert.throws(() => native('commit', source, target, replacedPath))
    assert.equal(await readFile(displaced, 'utf8'), 'abcdef')
    assert.equal(await readFile(source, 'utf8'), 'abcdef')
    await rm(target)
    await rename(displaced, target)
    native('recover', source, target, replacedPath)
    await rm(replacedPath, { recursive: true })
    console.log('PASS: destination replaced by symlink after preparation cannot redirect the write')

    async function journal(transactionPath: string, ownerPid = process.pid): Promise<string> {
      const path = join(root, `${randomUUID()}.json`)
      await writeFile(path, JSON.stringify({ targetPath: target, transactionPath, ownerPid }))
      return path
    }
    await writeFile(target, 'abcdef')
    const interrupted = await mkdtemp(join(directory, '.arkive-dedupe-'))
    native('prepare', source, target, interrupted)
    const oldInode = (await stat(target)).ino
    const ownershipJournal = await journal(interrupted, process.ppid)
    // Another service instance represents a fresh process reading the persisted journal.
    const restarted = new CloneDeduplicationService(root)
    assert.equal((await restarted.recoverPending()).failed.length, 1)
    assert.equal((await stat(target)).ino, oldInode)
    assert.ok((await readdir(interrupted)).includes('candidate'))
    await writeFile(
      ownershipJournal,
      JSON.stringify({ targetPath: target, transactionPath: interrupted, ownerPid: process.pid })
    )
    assert.deepEqual((await restarted.recoverPending()).failed, [])
    assert.equal((await stat(target)).ino, oldInode)
    assert.deepEqual(await readdir(root), [])
    assert.equal(await readFile(target, 'utf8'), 'abcdef')
    console.log(
      'PASS: live owner recovery refused; persisted preparation recovered on a new Service instance without replacement'
    )

    // Native commit has no rename gap. Emulate process death immediately after its exchange
    // using a tiny test-only executable compiled from the same source with a barrier.
    const nativeSource = await readFile(resolve('native/apfs-dedupe.c'), 'utf8')
    const preparingSource = join(directory, 'preparing.c')
    const preparingBinary = join(directory, 'preparing')
    await writeFile(
      preparingSource,
      nativeSource.replace(
        'int initial = open_regular(transaction, "candidate");',
        'raise(SIGSTOP); int initial = open_regular(transaction, "candidate");'
      )
    )
    execFileSync('/usr/bin/clang', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-O2',
      preparingSource,
      '-o',
      preparingBinary
    ])
    const preparing = await mkdtemp(join(directory, '.arkive-dedupe-'))
    const preparingChild = spawn(preparingBinary, ['prepare', source, target, preparing], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const preparingExited = once(preparingChild, 'close')
    try {
      for (let i = 0; i < 200 && !(await readdir(preparing)).includes('candidate'); i++) {
        await new Promise<void>((done) => {
          setTimeout(done, 10)
        })
      }
      assert.deepEqual(await readdir(preparing), ['candidate'])
      assert.throws(() => native('recover', source, target, preparing), /file is busy/)
      assert.deepEqual(await readdir(preparing), ['candidate'])
      assert.equal((await stat(target)).ino, oldInode)
    } finally {
      preparingChild.kill('SIGKILL')
      await preparingExited
    }
    native('recover', source, target, preparing)
    assert.deepEqual(await readdir(preparing), [])
    await rmdir(preparing)
    console.log(
      'PASS: surviving helper blocks recovery before journal creation; after SIGKILL only its private clone is removed'
    )

    const hookSource = join(directory, 'interrupt.c'),
      hookBinary = join(directory, 'interrupt')
    await writeFile(
      hookSource,
      nativeSource.replace(
        'sync_directory(target_dir); sync_directory(transaction);',
        'sync_directory(target_dir); sync_directory(transaction); raise(SIGSTOP);'
      )
    )
    execFileSync('/usr/bin/clang', [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-O2',
      hookSource,
      '-o',
      hookBinary
    ])
    const swapped = await mkdtemp(join(directory, '.arkive-dedupe-'))
    native('prepare', source, target, swapped)
    await journal(swapped)
    async function interruptCommit(transaction: string): Promise<void> {
      const child = spawn(hookBinary, ['commit', source, target, transaction], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const exited = once(child, 'close')
      try {
        assert.ok(child.pid)
        // Poll actual exchange, then kill only this generated fixture process.
        for (let i = 0; i < 200 && (await stat(target)).ino === oldInode; i++) {
          await new Promise<void>((done) => {
            setTimeout(done, 10)
          })
        }
        assert.notEqual((await stat(target)).ino, oldInode)
      } finally {
        child.kill('SIGKILL')
        await exited
      }
    }
    await interruptCommit(swapped)
    assert.deepEqual((await restarted.recoverPending()).failed, [])
    assert.equal((await stat(target)).ino, oldInode)
    assert.equal(await readFile(target, 'utf8'), 'abcdef')
    console.log(
      'PASS: actual helper SIGKILL after atomic exchange; restart restores the original inode and content'
    )

    // If someone edits the published clone after interruption, preserve both versions.
    const conflict = await mkdtemp(join(directory, '.arkive-dedupe-'))
    native('prepare', source, target, conflict)
    await journal(conflict)
    await interruptCommit(conflict)
    await writeFile(target, 'user edits after interrupted replacement')
    const recovery = await restarted.recoverPending()
    assert.equal(recovery.failed.length, 1)
    assert.equal(await readFile(target, 'utf8'), 'user edits after interrupted replacement')
    assert.equal(await readFile(join(conflict, 'candidate'), 'utf8'), 'abcdef')
    await assert.rejects(
      restarted.deduplicate({ sourcePath: source, duplicatePaths: [target] }),
      /未解决的恢复记录/
    )
    console.log(
      'PASS: conflicting post-crash edits preserve both versions and block further deduplication'
    )
    await restarted.close()

    const independent = new CloneDeduplicationService(join(directory, 'independent-recovery'))
    const a = join(directory, 'concurrent-a'),
      b = join(directory, 'concurrent-b')
    await writeFile(a, bytes)
    await writeFile(b, bytes)
    const sameRequest = { sourcePath: a, duplicatePaths: [b] }
    const concurrentService = new CloneDeduplicationService(join(directory, 'independent-recovery'))
    const outcomes = await Promise.all([
      independent.deduplicate(sameRequest),
      concurrentService.deduplicate(sameRequest)
    ])
    assert.equal(outcomes[0].items[0].status, 'deduplicated', JSON.stringify(outcomes))
    assert.equal(outcomes[1].items[0].status, 'skipped')
    await concurrentService.close()
    // Source ACL must not leak into a target that originally had no ACL.
    const withoutAcl = join(directory, 'target-without-acl')
    await writeFile(withoutAcl, 'abcdef')
    const plainAcl = execFileSync('/bin/ls', ['-le', withoutAcl], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
    const aclSource = join(directory, 'acl-source')
    await writeFile(aclSource, 'abcdef')
    execFileSync('/bin/chmod', [
      '+a',
      'everyone allow read,readattr,readextattr,readsecurity',
      aclSource
    ])
    const aclResult = await independent.deduplicate({
      sourcePath: aclSource,
      duplicatePaths: [withoutAcl]
    })
    assert.equal(aclResult.items[0].status, 'deduplicated', JSON.stringify(aclResult))
    assert.deepEqual(
      execFileSync('/bin/ls', ['-le', withoutAcl], { encoding: 'utf8' }).split('\n').slice(1),
      plainAcl
    )

    const largeSource = join(directory, 'cancel-source'),
      largeTarget = join(directory, 'cancel-target')
    for (const path of [largeSource, largeTarget]) {
      const file = await open(path, 'wx')
      try {
        await file.truncate(256 * 1024 * 1024)
      } finally {
        await file.close()
      }
    }
    const largeInode = (await stat(largeTarget)).ino
    const controller = new AbortController()
    const pending = independent.deduplicate(
      { sourcePath: largeSource, duplicatePaths: [largeTarget, b] },
      controller.signal
    )
    // Wait for this operation's journal; it must be running before cancellation.
    for (
      let i = 0;
      i < 500 && !(await readdir(join(directory, 'independent-recovery'))).length;
      i++
    ) {
      await new Promise<void>((done) => {
        setTimeout(done, 1)
      })
    }
    controller.abort()
    const cancelled = await pending
    assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled))
    assert.equal(cancelled.items[0].status, 'cancelled')
    assert.equal(cancelled.items[1].status, 'unprocessed')
    assert.equal((await stat(largeTarget)).ino, largeInode)
    assert.deepEqual(await readdir(join(directory, 'independent-recovery')), [])
    console.log(
      'PASS: source-only metadata excluded, absent destination ACL preserved, active cancellation leaves original and cleans transaction'
    )
    await independent.close()
    await assert.rejects(independent.deduplicate(sameRequest), /关闭/)
    console.log(
      'PASS: concurrent submissions serialized, repeated apply does not recount savings, closed service rejects work'
    )
  } finally {
    await service.close()
    // Only generated fixtures, including intentionally preserved crash-recovery examples.
    await chmod(source, 0o600).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}
