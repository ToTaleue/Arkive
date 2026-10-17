import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DuplicateTaskError, TaskManager } from './manager'
import { TaskCancelled, TaskFailure } from './outcome'
import { runTask, tasks } from './service'
import type { TaskSnapshot } from '../../shared/contracts/task'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function finished(manager: TaskManager, batchId: string): Promise<TaskSnapshot[]> {
  return new Promise((resolve) => {
    const check = (): void => {
      const snapshots = manager.list(batchId)
      if (snapshots.every((task) => task.status !== 'queued' && task.status !== 'running')) {
        unsubscribe()
        resolve(snapshots)
      }
    }
    const unsubscribe = manager.subscribe(check)
    check()
  })
}

void test('wait observes cleanup, completed snapshots and missing IDs', async () => {
  const manager = new TaskManager()
  const gate = deferred()
  const started = deferred()
  const { taskIds } = manager.submitBatch(
    [
      {
        title: 'wait fixture',
        run: async (signal) => {
          started.resolve()
          await gate.promise
          signal.throwIfAborted()
        }
      }
    ],
    { onError: 'stop' }
  )
  await started.promise
  let settled = false
  const pending = manager.wait(taskIds[0]).then((task) => {
    settled = true
    return task
  })
  manager.cancel(taskIds[0])
  await Promise.resolve()
  assert.equal(settled, false)
  gate.resolve()
  const task = await pending
  assert.equal(task.status, 'cancelled')
  assert.deepEqual(await manager.wait(task.id), task)
  await assert.rejects(manager.wait('missing'), /不存在/)
})

void test('Promise callers receive results and Task-origin cancellation without aborting their own signal', async () => {
  assert.deepEqual(
    await runTask({ title: 'typed result', run: () => Promise.resolve({ value: 42 }) }),
    {
      value: 42
    }
  )
  const gate = deferred()
  const started = deferred()
  const controller = new AbortController()
  const requestId = 'service-cancel-fixture'
  const work = runTask(
    {
      title: 'cancel by Task',
      requestId,
      run: async (signal) => {
        started.resolve()
        await gate.promise
        signal.throwIfAborted()
      }
    },
    controller.signal
  )
  await started.promise
  const task = tasks.list().find((item) => item.requestId === requestId)
  assert.ok(task)
  const rejected = assert.rejects(work, TaskCancelled)
  tasks.cancel(task.id)
  assert.equal(controller.signal.aborted, false)
  gate.resolve()
  await rejected

  const unsubscribe = tasks.subscribe(() => {
    if (tasks.list().some((item) => item.title === 'abort on submit')) controller.abort()
  })
  try {
    await assert.rejects(
      runTask(
        {
          title: 'abort on submit',
          run: () => Promise.reject(new Error('cancelled queued job ran'))
        },
        controller.signal
      ),
      TaskCancelled
    )
  } finally {
    unsubscribe()
  }
})

void test(
  'business failure retains partial results and applies the batch failure policy',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const partial = { outputPath: '/fixture/output.webp', backup: 'failed' }
    const failure = new TaskFailure('原件备份失败', partial)
    partial.backup = 'changed externally'
    const batch = manager.submitBatch(
      [
        { title: 'partial result', run: () => Promise.reject(failure) },
        { title: 'dependent', run: () => Promise.resolve('must not run') }
      ],
      { onError: 'stop' }
    )
    const [result, skipped] = await finished(manager, batch.batchId)
    assert.equal(result.status, 'failed')
    assert.equal(result.error, '原件备份失败')
    assert.deepEqual(result.result, { outputPath: '/fixture/output.webp', backup: 'failed' })
    assert.equal(skipped.status, 'skipped')
  }
)

void test(
  'explicit business cancellation retains its reason and completed work without requiring an abort signal',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const batch = manager.submitBatch(
      [
        {
          title: 'business cancelled',
          run: () => Promise.reject(new TaskCancelled('处理已取消', { completedFiles: 2 }))
        },
        { title: 'independent', run: () => Promise.resolve('ok') }
      ],
      { onError: 'stop' }
    )
    const [result, next] = await finished(manager, batch.batchId)
    assert.equal(result.status, 'cancelled')
    assert.equal(result.cancellationReason, '处理已取消')
    assert.equal(result.cancellationRequested, false)
    assert.deepEqual(result.result, { completedFiles: 2 })
    assert.equal(next.status, 'succeeded')
  }
)

void test(
  'explicit failure remains a failure when a cancellation request arrives during execution',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const started = deferred()
    const release = deferred()
    const batch = manager.submitBatch(
      [
        {
          title: 'failure after cancel',
          run: async () => {
            started.resolve()
            await release.promise
            throw new TaskFailure('提交失败', { committed: false })
          }
        },
        { title: 'dependent', run: () => Promise.resolve() }
      ],
      { onError: 'stop' }
    )
    await started.promise
    manager.cancel(batch.taskIds[0])
    release.resolve()
    const [result, skipped] = await finished(manager, batch.batchId)
    assert.equal(result.status, 'failed')
    assert.equal(result.cancellationRequested, true)
    assert.deepEqual(result.result, { committed: false })
    assert.equal(skipped.status, 'skipped')
  }
)

void test(
  'deduplication rejects the whole submission for queued, running and repeated batch keys',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const started = deferred()
    const release = deferred()
    const batch = manager.submitBatch(
      [
        {
          title: 'active',
          key: 'active',
          run: async (signal) => {
            started.resolve()
            await release.promise
            signal.throwIfAborted()
          }
        },
        { title: 'queued', key: 'queued', run: () => Promise.resolve() }
      ],
      { onError: 'continue' }
    )
    assert.throws(
      () =>
        manager.submitBatch(
          [
            { title: 'new', key: 'new', run: () => Promise.resolve() },
            { title: 'duplicate', key: 'queued', run: () => Promise.resolve() }
          ],
          { onError: 'continue' }
        ),
      (error: unknown) => {
        assert.ok(error instanceof DuplicateTaskError)
        assert.equal(error.key, 'queued')
        assert.equal(error.taskId, batch.taskIds[1])
        return true
      }
    )
    assert.throws(
      () =>
        manager.submitBatch(
          [
            { title: 'same key', key: 'same', run: () => Promise.resolve() },
            { title: 'same key again', key: 'same', run: () => Promise.resolve() }
          ],
          { onError: 'continue' }
        ),
      DuplicateTaskError
    )
    assert.throws(
      () =>
        manager.submitBatch([{ title: 'empty key', key: ' ', run: () => Promise.resolve() }], {
          onError: 'continue'
        }),
      /防重标识/
    )
    assert.equal(manager.list().length, 2)
    manager.cancel(batch.taskIds[1])
    const replacement = manager.submitBatch(
      [{ title: 'reuse cancelled key', key: 'queued', run: () => Promise.resolve('replacement') }],
      { onError: 'continue' }
    )
    await started.promise
    manager.cancel(batch.taskIds[0])
    assert.throws(
      () =>
        manager.submitBatch(
          [{ title: 'still cleaning up', key: 'active', run: () => Promise.resolve() }],
          { onError: 'continue' }
        ),
      DuplicateTaskError
    )
    release.resolve()
    await Promise.all([finished(manager, batch.batchId), finished(manager, replacement.batchId)])
    const afterCleanup = manager.submitBatch(
      [
        { title: 'reuse active key', key: 'active', run: () => Promise.resolve() },
        { title: 'reuse completed key', key: 'queued', run: () => Promise.resolve() }
      ],
      { onError: 'continue' }
    )
    assert.ok(
      (await finished(manager, afterCleanup.batchId)).every((task) => task.status === 'succeeded')
    )
  }
)

void test(
  'failed and skipped tasks release their deduplication keys',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const batch = manager.submitBatch(
      [
        { title: 'fail', key: 'fail', run: () => Promise.reject(new Error('fixture')) },
        { title: 'skip', key: 'skip', run: () => Promise.resolve() }
      ],
      { onError: 'stop' }
    )
    await finished(manager, batch.batchId)
    const retry = manager.submitBatch(
      [
        { title: 'retry failed', key: 'fail', run: () => Promise.resolve() },
        { title: 'retry skipped', key: 'skip', run: () => Promise.resolve() }
      ],
      { onError: 'continue' }
    )
    assert.ok((await finished(manager, retry.batchId)).every((task) => task.status === 'succeeded'))
  }
)

void test(
  'closing an idle queue is permanent and idempotent, including immediate queued submissions',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const pending = manager.submitBatch(
      [
        {
          title: 'never start',
          run: () => {
            throw new Error('must not run')
          }
        }
      ],
      { onError: 'continue' }
    )
    const closing = manager.close()
    assert.equal(manager.close(), closing)
    await closing
    assert.equal(manager.get(pending.taskIds[0])?.status, 'cancelled')
    assert.equal(manager.get(pending.taskIds[0])?.startedAt, undefined)
    assert.throws(
      () =>
        manager.submitBatch([{ title: 'rejected', run: () => Promise.resolve() }], {
          onError: 'continue'
        }),
      /已关闭/
    )
    const empty = new TaskManager()
    await empty.close()
    assert.deepEqual(empty.list(), [])
  }
)

void test(
  'close cancels all batches, blocks reentrant submission and waits for active cleanup',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const completed = manager.submitBatch(
      [{ title: 'already complete', run: () => Promise.resolve({ saved: true }) }],
      { onError: 'continue' }
    )
    await finished(manager, completed.batchId)
    const started = deferred()
    const release = deferred()
    let signal: AbortSignal | undefined
    let clean = false
    let calls = 0
    const running = manager.submitBatch(
      [
        {
          title: 'active',
          run: async (value) => {
            signal = value
            started.resolve()
            await release.promise
            clean = true
            value.throwIfAborted()
          }
        },
        { title: 'queued', run: () => Promise.resolve(++calls) }
      ],
      { onError: 'continue' }
    )
    const other = manager.submitBatch(
      [{ title: 'other batch', run: () => Promise.resolve(++calls) }],
      { onError: 'stop' }
    )
    await started.promise
    let closeSettled = false
    let reentrantClose: Promise<void> | undefined
    let reentrantSubmissionError: unknown
    manager.subscribe(() => {
      if (manager.list().some((task) => task.status === 'cancelled')) {
        try {
          manager.submitBatch([{ title: 'late submission', run: () => Promise.resolve() }], {
            onError: 'continue'
          })
        } catch (error) {
          reentrantSubmissionError = error
        }
        reentrantClose = manager.close()
      }
    })
    const closing = manager.close()
    void closing.then(() => {
      closeSettled = true
    })
    await Promise.resolve()
    assert.equal(signal?.aborted, true)
    assert.equal(closeSettled, false)
    assert.equal(clean, false)
    assert.equal(reentrantClose, closing)
    assert.ok(reentrantSubmissionError instanceof Error)
    assert.match(reentrantSubmissionError.message, /已关闭/)
    assert.equal(manager.get(running.taskIds[0])?.status, 'running')
    release.resolve()
    await closing
    assert.equal(clean, true)
    assert.equal(calls, 0)
    assert.ok(manager.list(running.batchId).every((task) => task.status === 'cancelled'))
    assert.equal(manager.list(other.batchId)[0].status, 'cancelled')
    assert.deepEqual(manager.list(completed.batchId)[0].result, { saved: true })
  }
)

void test(
  'close waits even when cancellation is ignored and retains a successful commit',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const started = deferred()
    const release = deferred()
    const batch = manager.submitBatch(
      [
        {
          title: 'commit',
          run: async () => {
            started.resolve()
            await release.promise
            return { committed: true }
          }
        }
      ],
      { onError: 'continue' }
    )
    await started.promise
    const closing = manager.close()
    assert.equal(manager.get(batch.taskIds[0])?.status, 'running')
    release.resolve()
    await closing
    assert.equal(manager.get(batch.taskIds[0])?.status, 'succeeded')
    assert.deepEqual(manager.get(batch.taskIds[0])?.result, { committed: true })
  }
)

void test(
  'continue policy executes remaining jobs after failure and preserves FIFO across batches',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const release = deferred()
    const started = deferred()
    const order: string[] = []
    const first = manager.submitBatch(
      [
        {
          title: 'first',
          run: async () => {
            order.push('first:start')
            started.resolve()
            await release.promise
            order.push('first:end')
            return { bytes: 12 }
          }
        },
        {
          title: 'failure',
          run: () => {
            order.push('failure')
            throw new Error('fixture failure')
          }
        },
        { title: 'continue after failure', run: () => Promise.resolve(order.push('continued')) }
      ],
      { onError: 'continue' }
    )
    assert.deepEqual(
      manager.list().map((task) => task.status),
      ['queued', 'queued', 'queued']
    )
    await started.promise
    const second = manager.submitBatch(
      [{ title: 'last', run: () => Promise.resolve(order.push('last')) }],
      { onError: 'continue' }
    )
    assert.equal(manager.list().filter((task) => task.status === 'running').length, 1)
    assert.deepEqual(order, ['first:start'])
    release.resolve()
    const [a, b] = await Promise.all([
      finished(manager, first.batchId),
      finished(manager, second.batchId)
    ])
    assert.deepEqual(order, ['first:start', 'first:end', 'failure', 'continued', 'last'])
    assert.deepEqual(
      a.map((task) => task.status),
      ['succeeded', 'failed', 'succeeded']
    )
    assert.deepEqual(a[0].result, { bytes: 12 })
    assert.equal(a[1].error, 'fixture failure')
    assert.equal(b[0].status, 'succeeded')
  }
)

void test(
  'stop policy skips only the failed batch; previous success and cancellation are preserved',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const order: string[] = []
    const batch = manager.submitBatch(
      [
        { title: 'success', run: () => Promise.resolve(order.push('success')) },
        {
          title: 'failure',
          run: () => {
            order.push('failure')
            return Promise.reject(new Error('fixture rejection'))
          }
        },
        { title: 'must not run', run: () => Promise.resolve(order.push('unexpected')) },
        { title: 'already cancelled', run: () => Promise.resolve(order.push('unexpected')) }
      ],
      { onError: 'stop' }
    )
    manager.cancel(batch.taskIds[3])
    const other = manager.submitBatch(
      [{ title: 'independent batch', run: () => Promise.resolve(order.push('independent')) }],
      { onError: 'continue' }
    )
    const [results, unaffected] = await Promise.all([
      finished(manager, batch.batchId),
      finished(manager, other.batchId)
    ])
    assert.deepEqual(order, ['success', 'failure', 'independent'])
    assert.deepEqual(
      results.map((task) => task.status),
      ['succeeded', 'failed', 'skipped', 'cancelled']
    )
    assert.equal(results[1].error, 'fixture rejection')
    assert.match(results[2].skipReason ?? '', /failure/)
    assert.equal(results[2].startedAt, undefined)
    assert.equal(results[2].cancellationRequested, false)
    assert.ok(results[2].finishedAt)
    assert.equal(manager.cancel(results[2].id), false)
    assert.equal(manager.cancelBatch(batch.batchId), 0)
    assert.equal(unaffected[0].status, 'succeeded')
  }
)

void test(
  'stop policy also handles synchronous errors and copies its submission options',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const options: { onError: 'continue' | 'stop' } = { onError: 'stop' }
    let calls = 0
    const batch = manager.submitBatch(
      [
        {
          title: 'sync failure',
          run: () => {
            throw new Error('sync fixture')
          }
        },
        { title: 'skip', run: () => Promise.resolve(++calls) }
      ],
      options
    )
    options.onError = 'continue'
    const results = await finished(manager, batch.batchId)
    assert.deepEqual(
      results.map((task) => task.status),
      ['failed', 'skipped']
    )
    assert.equal(calls, 0)
  }
)

void test(
  'queued cancellation never invokes the job; terminal and missing tasks cannot be cancelled',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    let calls = 0
    const batch = manager.submitBatch(
      [
        { title: 'skip', run: () => Promise.resolve(++calls) },
        { title: 'keep', run: () => Promise.resolve(++calls) }
      ],
      { onError: 'continue' }
    )
    assert.equal(manager.cancel(batch.taskIds[0]), true)
    assert.equal(manager.cancel(batch.taskIds[0]), false)
    const results = await finished(manager, batch.batchId)
    assert.equal(calls, 1)
    assert.deepEqual(
      results.map((task) => task.status),
      ['cancelled', 'succeeded']
    )
    assert.equal(results[0].startedAt, undefined)
    assert.equal(manager.cancel(batch.taskIds[1]), false)
    assert.equal(manager.cancel('missing'), false)
    assert.equal(manager.get('missing'), undefined)
  }
)

void test(
  'running cancellation waits for cleanup before starting the next job',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const started = deferred()
    const releaseCleanup = deferred()
    let signal: AbortSignal | undefined
    let nextStarted = false
    const batch = manager.submitBatch(
      [
        {
          title: 'cancel running',
          run: async (value) => {
            signal = value
            started.resolve()
            await releaseCleanup.promise
            value.throwIfAborted()
          }
        },
        { title: 'next', run: () => Promise.resolve((nextStarted = true)) }
      ],
      { onError: 'continue' }
    )
    await started.promise
    assert.equal(manager.cancel(batch.taskIds[0]), true)
    assert.equal(signal?.aborted, true)
    assert.equal(manager.get(batch.taskIds[0])?.status, 'running')
    assert.equal(manager.get(batch.taskIds[0])?.cancellationRequested, true)
    assert.equal(nextStarted, false)
    releaseCleanup.resolve()
    const results = await finished(manager, batch.batchId)
    assert.deepEqual(
      results.map((task) => task.status),
      ['cancelled', 'succeeded']
    )
    assert.equal(nextStarted, true)
  }
)

void test(
  'batch cancellation skips its queued work and does not cancel another batch',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const started = deferred()
    const release = deferred()
    let skippedCalls = 0
    const first = manager.submitBatch(
      [
        {
          title: 'active',
          run: async (signal) => {
            started.resolve()
            await release.promise
            signal.throwIfAborted()
          }
        },
        { title: 'skip', run: () => Promise.resolve(++skippedCalls) }
      ],
      { onError: 'continue' }
    )
    await started.promise
    const second = manager.submitBatch([{ title: 'unaffected', run: () => Promise.resolve(42) }], {
      onError: 'continue'
    })
    assert.equal(manager.cancelBatch(first.batchId), 2)
    assert.equal(manager.cancelBatch(first.batchId), 0)
    release.resolve()
    const [a, b] = await Promise.all([
      finished(manager, first.batchId),
      finished(manager, second.batchId)
    ])
    assert.deepEqual(
      a.map((task) => task.status),
      ['cancelled', 'cancelled']
    )
    assert.equal(skippedCalls, 0)
    assert.equal(b[0].result, 42)
  }
)

void test(
  'late cancellation does not discard an operation that resolves successfully',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    const started = deferred()
    const committed = deferred()
    const batch = manager.submitBatch(
      [
        {
          title: 'commit already started',
          run: async () => {
            started.resolve()
            await committed.promise
            return { committed: true }
          }
        }
      ],
      { onError: 'continue' }
    )
    await started.promise
    manager.cancel(batch.taskIds[0])
    committed.resolve()
    const [result] = await finished(manager, batch.batchId)
    assert.equal(result.status, 'succeeded')
    assert.equal(result.cancellationRequested, true)
    assert.deepEqual(result.result, { committed: true })
  }
)

void test(
  'progress and results are isolated snapshots; unsubscribe and late reports are safe',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    let changes = 0
    const unsubscribe = manager.subscribe(() => changes++)
    let lateReport: (() => void) | undefined
    const value = { nested: { count: 1 } }
    const batch = manager.submitBatch(
      [
        {
          title: 'progress',
          run: (_signal, report) => {
            const progress = { percent: 25, message: 'encoding' }
            report(progress)
            progress.percent = 99
            lateReport = () => {
              report({ percent: 100 })
            }
            return Promise.resolve(value)
          }
        }
      ],
      { onError: 'continue' }
    )
    await finished(manager, batch.batchId)
    const result = manager.get(batch.taskIds[0])
    assert.equal(result?.progress?.percent, 25)
    value.nested.count = 99
    assert.deepEqual(manager.get(batch.taskIds[0])?.result, { nested: { count: 1 } })
    result.progress.percent = 70
    assert.equal(manager.get(batch.taskIds[0])?.progress?.percent, 25)
    lateReport?.()
    assert.equal(manager.get(batch.taskIds[0])?.progress?.percent, 25)
    assert.ok(changes >= 4)
    unsubscribe()
    const before = changes
    const next = manager.submitBatch([{ title: 'next', run: () => Promise.resolve() }], {
      onError: 'continue'
    })
    await finished(manager, next.batchId)
    assert.equal(changes, before)
  }
)

void test(
  'reentrant submission and cancellation during notification keep the queue usable',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    let calls = 0
    let followUpBatchId: string | undefined
    const unsubscribe = manager.subscribe(() => {
      const active = manager
        .list()
        .find((task) => task.title === 'cancel before run' && task.status === 'running')
      if (active) manager.cancel(active.id)
      if (manager.list().some((task) => task.status === 'cancelled') && !followUpBatchId) {
        // Remove this listener before submitting to avoid recursively handling its own change.
        unsubscribe()
        followUpBatchId = manager.submitBatch(
          [{ title: 'follow-up', run: () => Promise.resolve(++calls) }],
          { onError: 'continue' }
        ).batchId
      }
    })
    const first = manager.submitBatch(
      [{ title: 'cancel before run', run: () => Promise.resolve(++calls) }],
      { onError: 'continue' }
    )
    await finished(manager, first.batchId)
    assert.ok(followUpBatchId)
    await finished(manager, followUpBatchId)
    assert.equal(calls, 1)
    assert.equal(manager.list()[0].status, 'cancelled')
    assert.equal(manager.list()[1].status, 'succeeded')
  }
)

void test(
  'invalid batches are rejected atomically; invalid progress and results fail only their task',
  { timeout: 5000 },
  async () => {
    const manager = new TaskManager()
    assert.throws(() => manager.submitBatch([], { onError: 'continue' }), /不能为空/)
    assert.throws(
      () =>
        manager.submitBatch(
          [
            { title: 'valid', run: () => Promise.resolve() },
            { title: ' ', run: () => Promise.resolve() }
          ],
          { onError: 'continue' }
        ),
      /名称/
    )
    assert.equal(manager.list().length, 0)
    const batch = manager.submitBatch(
      [
        {
          title: 'invalid progress',
          run: (_signal, report) => {
            report({ percent: Number.NaN })
            return Promise.resolve()
          }
        },
        { title: 'uncloneable result', run: () => Promise.resolve(() => undefined) },
        { title: 'still works', run: () => Promise.resolve('ok') }
      ],
      { onError: 'continue' }
    )
    const results = await finished(manager, batch.batchId)
    assert.deepEqual(
      results.map((task) => task.status),
      ['failed', 'failed', 'succeeded']
    )
    assert.equal(results[2].result, 'ok')
  }
)
