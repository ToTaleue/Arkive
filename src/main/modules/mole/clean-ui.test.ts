import assert from 'node:assert/strict'
import { readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerMoleIpc } from './ipc'
import { tasks } from '../../tasks/service'
import { registerTasksIpc } from '../../tasks/ipc'
import { runMoleClean } from './operations'

app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  const root = process.env.ARKIVE_CLEAN_FIXTURE
  if (!root?.startsWith('/Users/hu1hui/Desktop/arkive-test/clean-ui-'))
    throw new Error('Missing isolated Clean fixture directory')
  assert.ok(root)
  await mkdir(join(root, 'electron-user-data'), { recursive: true })
  app.setPath('userData', join(root, 'electron-user-data'))
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  registerMoleIpc()
  registerTasksIpc(tasks)(window.webContents)
  ipcMain.handle('agent:status', () => ({ configured: false, model: '' }))
  // Other mounted pages request their data even while hidden.
  ipcMain.handle('catalog:query', () => ({ items: [], total: 0, tags: [] }))
  const errors: string[] = []
  window.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message))
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error('Renderer:', event.message)
  })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason))
  const evaluate = async (code: string): Promise<unknown> => {
    try {
      return await window.webContents.executeJavaScript(code)
    } catch (error) {
      throw new Error(`Renderer evaluation failed: ${code}`, { cause: error })
    }
  }
  async function until(expression: string): Promise<void> {
    const deadline = Date.now() + 10_000
    while (!(await evaluate(expression))) {
      assert.ok(
        Date.now() < deadline,
        `Timeout: ${expression}\n${String(await evaluate('document.body.innerText'))}`
      )
      await delay(40)
    }
  }
  async function click(text: string): Promise<void> {
    await evaluate(
      `(() => { const button = [...document.querySelectorAll('#clean-page button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw Error('Unavailable button: ' + ${JSON.stringify(text)}); button.click(); })()`
    )
  }
  const callText = async (): Promise<string> =>
    readFile(join(root, 'calls'), 'utf8').catch(() => '')
  const seed = async (): Promise<void> => {
    await writeFile(join(root, 'cache'), 'generated cache')
    await writeFile(join(root, 'trash-item'), 'generated trash')
  }
  const screenshot = async (name: string): Promise<void> => {
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    await evaluate(
      'document.getAnimations().filter(a => a instanceof CSSTransition).forEach(a => a.finish())'
    )
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
    await writeFile(join(root, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await seed()
    await window.loadFile(resolve('out/renderer/index.html'))
    await evaluate('document.querySelector(\'[aria-label="清理"]\').click()')
    await until("!document.querySelector('#clean-page').hidden")
    await screenshot('clean-initial')
    assert.equal(
      await evaluate("document.querySelectorAll('#clean-page input[type=checkbox]').length"),
      0
    )
    const denied = await evaluate("window.api.mole.clean('unauthorized-test', 'clean')")
    assert.equal((denied as { status: string }).status, 'authorization-required')
    assert.equal(await callText(), '', 'Unauthorized clean must not start Mole')

    await writeFile(join(root, 'hold'), '')
    await click('预览清理')
    await until("document.querySelector('#clean-page').innerText.includes('User app cache')")
    assert.equal(await evaluate("document.querySelector('.clean-result-space') === null"), true)
    assert.equal(await readFile(join(root, 'cache'), 'utf8'), 'generated cache')
    await screenshot('clean-preview-streaming')
    // Navigating away must not drop the subscription or the running output.
    await evaluate('document.querySelector(\'[aria-label="工具箱"]\').click()')
    await rm(join(root, 'hold'))
    await evaluate('document.querySelector(\'[aria-label="清理"]\').click()')
    await until("document.querySelector('#clean-page').innerText.includes('预览完成，未执行删除')")
    assert.equal(
      await evaluate("document.querySelector('.clean-hero-copy h2').textContent"),
      '预览清理已完成'
    )
    assert.equal(
      await evaluate("document.querySelector('.clean-result-value').textContent"),
      '5 KB'
    )
    assert.equal(await readFile(join(root, 'trash-item'), 'utf8'), 'generated trash')
    assert.match(await callText(), /\["clean","--dry-run"\]/)
    await screenshot('clean-preview')

    await writeFile(join(root, 'cancel-dialog'), '')
    await click('授权管理员权限')
    await until("document.querySelector('#clean-page').innerText.includes('管理员授权已取消')")
    assert.equal((await callText()).trim().split('\n').length, 1)
    await rm(join(root, 'cancel-dialog'))
    await click('授权管理员权限')
    await until(
      "document.querySelector('#clean-page .clean-primary').textContent.includes('开始清理')"
    )
    assert.equal(
      (await callText()).trim().split('\n').length,
      1,
      'Authorization must not auto-clean'
    )
    assert.ok(
      String(await evaluate("document.querySelector('.clean-delete-notice').innerText")).includes(
        '默认清空回收站已有内容'
      )
    )
    await screenshot('clean-authorized')

    // An expired authorization is rejected again after queueing, before spawn.
    let release!: () => void
    const hold = new Promise<void>((done) => {
      release = done
    })
    const blocker = tasks.submitBatch([{ title: 'Hold Clean queue', run: () => hold }], {
      onError: 'stop'
    })
    try {
      await click('开始清理')
      await until("document.querySelector('.clean-run-status').textContent.includes('已加入队列')")
      await rm(join(root, 'authorized'))
      release()
      await until("document.querySelector('#clean-page').innerText.includes('管理员授权已失效')")
      assert.equal((await callText()).trim().split('\n').length, 1)
    } finally {
      release()
      await tasks.wait(blocker.taskIds[0])
    }
    await click('授权管理员权限')
    await until(
      "document.querySelector('#clean-page .clean-primary').textContent.includes('开始清理')"
    )
    await click('开始清理')
    await until("document.querySelector('.clean-run-status').textContent === '清理完成'")
    assert.equal(
      await evaluate("document.querySelector('.clean-hero-copy h2').textContent"),
      '清理已完成'
    )
    assert.equal(
      await evaluate("document.querySelector('.clean-result-value').textContent"),
      '4 KB'
    )
    await assert.rejects(stat(join(root, 'cache')))
    await assert.rejects(stat(join(root, 'trash-item')))
    assert.equal((await callText()).trim().split('\n').length, 2)
    await screenshot('clean-completed')
    await evaluate('document.querySelector(\'[title="夜间模式"]\').click()')
    await screenshot('clean-night')
    window.setSize(620, 850)
    await screenshot('clean-narrow')
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    window.setSize(1280, 1000)

    // Summary measurements stay distinct from per-item logs and free-space changes.
    for (const sample of [
      {
        mode: 'preview',
        summary: 'Dry run complete - no changes made\nPotential space: At least 1.25GB | Items: 2',
        value: '至少1.25 GB'
      },
      {
        mode: 'preview',
        summary:
          'Dry run complete - no changes made\nNo significant reclaimable space detected, system already clean.\nFree space: 223.5GB',
        value: '0 B'
      },
      {
        mode: 'clean',
        summary:
          'Cleanup complete\nTracked cleanup: At least 2MB | Items cleaned: 2\nFree space: 223.5GB (+9KB)',
        value: '至少2 MB'
      },
      {
        mode: 'clean',
        summary:
          'Cleanup complete\nTracked cleanup: Partially measured | Items cleaned: 2\nFree space: 223.5GB (+9KB)',
        value: '容量未完整统计'
      },
      {
        mode: 'clean',
        summary: 'Cleanup complete\nFree space: 223.5GB (+9KB)',
        value: '容量未提供'
      },
      {
        mode: 'clean',
        summary:
          'Cleanup complete\nSystem was already clean; no additional space freed.\nFree space: 223.5GB (+9KB)',
        value: '0 B'
      }
    ]) {
      await writeFile(join(root, 'summary'), sample.summary)
      await click(sample.mode === 'preview' ? '预览清理' : '开始清理')
      await until("!document.querySelector('.clean-primary').disabled")
      assert.equal(
        await evaluate("document.querySelector('.clean-result-value')?.textContent"),
        sample.value
      )
    }
    await rm(join(root, 'summary'))

    await seed()
    await writeFile(join(root, 'fail'), '')
    await click('开始清理')
    await until("document.querySelector('.clean-run-status').textContent.includes('未正常完成')")
    assert.equal(await evaluate("document.querySelector('.clean-result-space') === null"), true)
    assert.ok(
      String(await evaluate("document.querySelector('.clean-output').innerText")).includes(
        'fixture permission denied'
      )
    )
    assert.equal(await readFile(join(root, 'cache'), 'utf8'), 'generated cache')
    await rm(join(root, 'fail'))
    await writeFile(join(root, 'hold'), '')
    await click('开始清理')
    await until("document.querySelector('#clean-page').innerText.includes('User app cache')")
    await click('停止')
    await until("document.querySelector('.clean-run-status').textContent.includes('清理已停止')")
    assert.equal(await evaluate("document.querySelector('.clean-result-space') === null"), true)
    await rm(join(root, 'hold'))
    assert.equal(await readFile(join(root, 'cache'), 'utf8'), 'generated cache')
    // Timeout is a failure even when an interrupted process has already emitted success-like lines.
    await writeFile(join(root, 'hold'), '')
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    try {
      AbortSignal.timeout = () => originalTimeout(500)
      const timedOut = await runMoleClean('preview', () => {})
      assert.equal(timedOut.status, 'failed')
      assert.equal(timedOut.output?.interrupted, true)
    } finally {
      AbortSignal.timeout = originalTimeout
      await rm(join(root, 'hold'))
    }
    // The shared queue and process group can be reused after cancellation.
    const recovered = await runMoleClean('preview', () => {})
    assert.equal(recovered.status, 'completed')
    assert.deepEqual(errors, [])
    console.log(
      'PASS: real Clean UI/preload/IPC/Task/process: preview preserves files, live logs before exit, navigation, authorization cancellation, no auto-clean, queued sudo expiry blocks spawn, exact clean args and fixture deletion, hero preview/clean capacities, partial/zero/missing summaries, no stale success on failure/cancellation, recovery, day/night/narrow layout'
    )
  } finally {
    window.destroy()
    await tasks.close()
  }
}
void check().then(
  () => {
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
