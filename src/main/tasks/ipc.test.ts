import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { tasks } from './service'
import { registerTasksIpc } from './ipc'

async function check(): Promise<void> {
  await app.whenReady()
  const attach = registerTasksIpc(tasks)
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  attach(window.webContents)
  const evaluate = (expression: string): Promise<unknown> =>
    window.webContents.executeJavaScript(expression)
  await window.loadURL('data:text/html,<title>Task IPC check</title>')
  assert.deepEqual(await evaluate('window.api.tasks.list()'), [])
  assert.equal(await evaluate('typeof window.api.tasks.submitBatch'), 'undefined')
  await evaluate(`
    globalThis.taskChanges = 0
    globalThis.unsubscribeTasks = window.api.tasks.onChanged(() => { globalThis.taskChanges++ })
    undefined
  `)

  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let start!: () => void
  const started = new Promise<void>((done) => {
    start = done
  })
  let skippedCalls = 0
  const batch = tasks.submitBatch(
    [
      {
        title: 'running IPC fixture',
        run: async (signal, report) => {
          report({ percent: 10, message: 'fixture' })
          start()
          await gate
          signal.throwIfAborted()
        }
      },
      { title: 'queued IPC fixture', run: () => Promise.resolve(++skippedCalls) }
    ],
    { onError: 'continue' }
  )
  await started
  assert.deepEqual(
    await evaluate(
      `window.api.tasks.list('${batch.batchId}').then(items => items.map(item => item.status))`
    ),
    ['running', 'queued']
  )
  assert.deepEqual(
    await evaluate(`window.api.tasks.get('${batch.taskIds[0]}').then(item => item.progress)`),
    { percent: 10, message: 'fixture' }
  )
  assert.equal(await evaluate(`window.api.tasks.cancel('${batch.taskIds[1]}')`), true)
  assert.equal(await evaluate(`window.api.tasks.cancelBatch('${batch.batchId}')`), 1)
  const finished = new Promise<void>((done) => {
    const unsubscribe = tasks.subscribe(() => {
      if (tasks.list(batch.batchId).every((task) => task.status === 'cancelled')) {
        unsubscribe()
        done()
      }
    })
  })
  release()
  await finished
  assert.equal(skippedCalls, 0)
  assert.deepEqual(
    await evaluate(`window.api.tasks.list().then(items => items.map(item => item.status))`),
    ['cancelled', 'cancelled']
  )
  assert.equal(await evaluate('globalThis.taskChanges > 0'), true)
  assert.equal(await evaluate(`window.api.tasks.get('bad-id').then(() => false, () => true)`), true)
  assert.equal(
    await evaluate(`window.api.tasks.get('00000000-0000-0000-0000-000000000000')`),
    undefined
  )
  const changesBefore = await evaluate('globalThis.unsubscribeTasks(); globalThis.taskChanges')
  const pending = tasks.submitBatch(
    [{ title: 'cancel immediately', run: () => Promise.resolve() }],
    { onError: 'continue' }
  )
  tasks.cancelBatch(pending.batchId)
  assert.equal(await evaluate('globalThis.taskChanges'), changesBefore)

  // Reloading a renderer only removes its listener; the main-process queue remains.
  const reloaded = new Promise<void>((done) => {
    window.webContents.once('did-finish-load', () => {
      done()
    })
  })
  window.reload()
  await reloaded
  assert.equal(await evaluate('window.api.tasks.list().then(items => items.length)'), 3)

  const unregistered = new BrowserWindow({
    show: false,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  await unregistered.loadURL('data:text/html,<title>Unregistered task window</title>')
  const rejected: unknown = await unregistered.webContents.executeJavaScript(
    'window.api.tasks.list().then(() => false, () => true)'
  )
  assert.equal(rejected, true)
  unregistered.destroy()
  window.destroy()
  console.log(
    'PASS: real preload / task IPC query, notifications, cancellation, reload and window validation'
  )
}

// Bound a broken IPC check without leaving a hidden Electron process running.
const timeout = setTimeout(() => {
  app.exit(1)
}, 15_000)
void check().then(
  () => {
    clearTimeout(timeout)
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
)
