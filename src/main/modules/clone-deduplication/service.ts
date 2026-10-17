import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { runBundledTool } from '../../../execution/process'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import type {
  CloneDeduplicationItem,
  CloneDeduplicationRequest,
  CloneDeduplicationResult,
  CloneRecoveryResult
} from '../../../shared/contracts/clone-deduplication'

type Transaction = { targetPath: string; transactionPath: string }
type HelperResult = {
  status: 'prepared' | 'skipped' | 'deduplicated' | 'recovered'
  sizeBytes?: number
}
// Different Service instances must not recover one another's active transactions.
const queues = new Map<string, Promise<void>>()

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function absolutePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error('APFS 去重须使用本地文件的绝对路径。')
  }
}
async function helper(
  operation: 'prepare' | 'commit' | 'recover',
  source: string,
  transaction: Transaction
): Promise<HelperResult> {
  // Do not kill a helper during an exchange. Cancellation is observed between commands/items.
  const result = await runBundledTool(
    'apfs_dedupe',
    [operation, source, transaction.targetPath, transaction.transactionPath],
    { maxOutputChars: 8192 }
  )
  if (result.exitCode !== 0 || result.signal || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(
      `APFS 去重${operation}失败：${result.stderr || result.stdout || String(result.signal)}`
    )
  }
  const value: unknown = JSON.parse(result.stdout)
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    throw new Error('APFS 去重工具返回无效结果。')
  }
  const { status } = value
  if (!['prepared', 'skipped', 'deduplicated', 'recovered'].includes(String(status))) {
    throw new Error('APFS 去重工具返回未知状态。')
  }
  if (status === 'prepared' || status === 'deduplicated') {
    if (
      !('sizeBytes' in value) ||
      typeof value.sizeBytes !== 'number' ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 1
    ) {
      throw new Error('APFS 去重工具返回无效文件大小。')
    }
    return { status, sizeBytes: value.sizeBytes }
  }
  if (status === 'skipped' || status === 'recovered') return { status }
  throw new Error('APFS 去重工具返回无效状态。')
}

/** Main-process business API. Call only for paths explicitly authorized for clone replacement. */
export class CloneDeduplicationService {
  private pending: Promise<void> = Promise.resolve()
  private closing = false

  constructor(private readonly recoveryRoot: string) {
    absolutePath(recoveryRoot)
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('APFS 去重服务正在关闭。'))
    const pending = (queues.get(this.recoveryRoot) ?? Promise.resolve()).then(run)
    this.pending = pending.then(
      () => {},
      () => {}
    )
    queues.set(this.recoveryRoot, this.pending)
    const settled = this.pending
    void settled.then(() => {
      if (queues.get(this.recoveryRoot) === settled) queues.delete(this.recoveryRoot)
    })
    return pending
  }

  close(): Promise<void> {
    this.closing = true
    return this.pending
  }

  private async removeTransaction(journalPath: string, transaction: Transaction): Promise<void> {
    // Only the native helper may remove transaction files. Never recursively remove a backup.
    await rmdir(transaction.transactionPath)
    await unlink(journalPath)
  }

  private async recover(): Promise<CloneRecoveryResult> {
    await mkdir(this.recoveryRoot, { recursive: true, mode: 0o700 })
    const result: CloneRecoveryResult = { recovered: [], failed: [] }
    for (const name of await readdir(this.recoveryRoot)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const journalPath = join(this.recoveryRoot, name)
      try {
        const value: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
        if (
          typeof value !== 'object' ||
          value === null ||
          !('targetPath' in value) ||
          !('transactionPath' in value) ||
          !('ownerPid' in value) ||
          typeof value.ownerPid !== 'number' ||
          !Number.isSafeInteger(value.ownerPid) ||
          value.ownerPid < 1
        ) {
          throw new Error('无效的 APFS 恢复记录，保留全部文件。')
        }
        absolutePath(value.targetPath)
        absolutePath(value.transactionPath)
        if (value.ownerPid !== process.pid) {
          try {
            process.kill(value.ownerPid, 0)
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
            // The owning app is gone. Native file locks still protect a surviving helper.
            await this.recoverTransaction(
              journalPath,
              value.targetPath,
              value.transactionPath,
              result
            )
            continue
          }
          throw new Error('另一个 Arkive 进程仍持有此去重事务，未执行恢复。')
        }
        await this.recoverTransaction(journalPath, value.targetPath, value.transactionPath, result)
      } catch (error) {
        result.failed.push({ journalPath, error: message(error) })
      }
    }
    return result
  }

  private async recoverTransaction(
    journalPath: string,
    targetPath: string,
    transactionPath: string,
    result: CloneRecoveryResult
  ): Promise<void> {
    const transaction: Transaction = {
      targetPath,
      transactionPath
    }
    if (
      dirname(transaction.transactionPath) !== dirname(transaction.targetPath) ||
      !basename(transaction.transactionPath).startsWith('.arkive-dedupe-')
    ) {
      throw new Error('APFS 恢复目录不匹配，保留全部文件。')
    }
    await assertSystemWriteAllowed(transaction.targetPath)
    try {
      const outcome = await helper('recover', transaction.targetPath, transaction)
      if (outcome.status !== 'recovered') throw new Error('APFS 恢复未完成。')
      await this.removeTransaction(journalPath, transaction)
    } catch (error) {
      // rmdir may have succeeded just before interruption; no transaction means no retained inode.
      if (
        await readdir(transaction.transactionPath).then(
          () => false,
          (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT'
        )
      ) {
        await unlink(journalPath)
      } else throw error
    }
    result.recovered.push(transaction.targetPath)
  }

  recoverPending(): Promise<CloneRecoveryResult> {
    return this.enqueue(() => this.recover())
  }

  deduplicate(
    request: CloneDeduplicationRequest,
    signal?: AbortSignal
  ): Promise<CloneDeduplicationResult> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      absolutePath(request.sourcePath)
      if (
        !Array.isArray(request.duplicatePaths) ||
        request.duplicatePaths.length < 1 ||
        request.duplicatePaths.length > 100
      )
        throw new Error('每次须明确指定 1–100 个重复副本路径。')
      const sourcePath = await resolveFilePath(request.sourcePath)
      await assertSystemWriteAllowed(sourcePath)
      const paths: string[] = []
      // Validate the entire requested scope before any write.
      for (const path of request.duplicatePaths) {
        absolutePath(path)
        const resolved = await resolveFilePath(path)
        await assertSystemWriteAllowed(resolved)
        paths.push(resolved)
      }
      const recovery = await this.recover()
      if (recovery.failed.length)
        throw new Error(`APFS 去重有未解决的恢复记录：${JSON.stringify(recovery)}`)
      const items: CloneDeduplicationItem[] = []
      const seen = new Set([sourcePath])
      let stop = false
      for (const path of paths) {
        if (signal?.aborted || stop) {
          items.push({ path, status: 'unprocessed', reason: stop ? '前一项需要恢复' : '已取消' })
          continue
        }
        if (seen.has(path)) {
          items.push({ path, status: 'skipped', reason: '源文件或重复指定的路径' })
          continue
        }
        seen.add(path)
        let journalPath: string | undefined
        let transaction: Transaction | undefined
        try {
          const transactionPath = await mkdtemp(join(dirname(path), '.arkive-dedupe-'))
          transaction = { targetPath: path, transactionPath }
          journalPath = join(this.recoveryRoot, `${randomUUID()}.json`)
          const journal = await open(journalPath, 'wx', 0o600)
          try {
            await journal.writeFile(JSON.stringify({ ...transaction, ownerPid: process.pid }))
            await journal.sync()
          } finally {
            await journal.close()
          }
          const root = await open(this.recoveryRoot, 'r')
          try {
            await root.sync()
          } finally {
            await root.close()
          }
          signal?.throwIfAborted()
          const prepared = await helper('prepare', sourcePath, transaction)
          if (prepared.status === 'skipped') {
            await this.removeTransaction(journalPath, transaction)
            items.push({
              path,
              status: 'skipped',
              reason: '已在同一 APFS 克隆家族中，不重复计算收益'
            })
            continue
          }
          if (prepared.status !== 'prepared') throw new Error('APFS 克隆准备未完成。')
          signal?.throwIfAborted()
          const outcome = await helper('commit', sourcePath, transaction)
          if (outcome.status !== 'deduplicated') throw new Error('APFS 克隆提交未完成。')
          // Publication has committed. Preserve the success even if cancellation arrived meanwhile.
          items.push({ path, status: 'deduplicated', logicalBytesShared: outcome.sizeBytes })
          await this.removeTransaction(journalPath, transaction)
        } catch (error) {
          let recoveryPath: string | undefined
          if (transaction && journalPath) {
            try {
              await helper('recover', sourcePath, transaction)
              await this.removeTransaction(journalPath, transaction)
            } catch {
              recoveryPath = transaction.transactionPath
              stop = true
            }
          }
          const committed = items.find(
            (item) => item.path === path && item.status === 'deduplicated'
          )
          if (committed) {
            committed.reason = `去重已提交，但事务清理需要核对：${message(error)}`
            committed.recoveryPath = recoveryPath
          } else
            items.push({
              path,
              status:
                signal?.aborted && error === signal.reason && !recoveryPath
                  ? 'cancelled'
                  : 'failed',
              reason: message(error),
              recoveryPath
            })
        }
      }
      return {
        status:
          signal?.aborted &&
          items.some((item) => item.status === 'cancelled' || item.status === 'unprocessed')
            ? 'cancelled'
            : items.some(
                  (item) =>
                    item.status === 'failed' || item.status === 'unprocessed' || item.recoveryPath
                )
              ? 'partial'
              : 'completed',
        sourcePath,
        items,
        logicalBytesShared: items.reduce(
          (total, item) => total + (item.logicalBytesShared ?? 0),
          0
        ),
        diskSpaceReclaimedBytes: null
      }
    })
  }
}

let service: CloneDeduplicationService | undefined
function current(): CloneDeduplicationService {
  service ??= new CloneDeduplicationService(join(app.getPath('userData'), 'clone-deduplication'))
  return service
}
export function cloneDuplicates(
  request: CloneDeduplicationRequest,
  signal?: AbortSignal
): Promise<CloneDeduplicationResult> {
  return current().deduplicate(request, signal)
}
export function recoverCloneDeduplication(): Promise<CloneRecoveryResult> {
  return current().recoverPending()
}
export function closeCloneDeduplication(): Promise<void> {
  return service?.close() ?? Promise.resolve()
}
