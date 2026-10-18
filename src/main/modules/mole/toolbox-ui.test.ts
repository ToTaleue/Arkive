import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerMoleIpc } from './ipc'
import { tasks } from '../../tasks/service'
import { registerTasksIpc } from '../../tasks/ipc'

app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  const root = process.env.ARKIVE_TOOLBOX_FIXTURE ?? ''
  if (!root.startsWith('/Users/hu1hui/Desktop/arkive-test/mole-toolbox-ui-'))
    throw Error('Missing isolated fixture directory')
  const json = (name: string, value: unknown): Promise<void> =>
    writeFile(join(root, name), JSON.stringify(value))
  const generated = async (name: string, text = 'fixture'): Promise<string> => {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
    return path
  }
  const exists = (path: string): Promise<boolean> =>
    access(path).then(
      () => true,
      () => false
    )
  async function heldProcess(): Promise<number> {
    const deadline = Date.now() + 10000
    while (!(await exists(join(root, 'hold-started')))) {
      assert.ok(Date.now() < deadline, 'Held Mole process did not start')
      await delay(40)
    }
    return Number(await readFile(join(root, 'hold-started'), 'utf8'))
  }
  const a = await generated('Downloads/Arkive.dmg', 'a'.repeat(4000))
  const b = await generated('Downloads/Editor.pkg', 'b'.repeat(6000))
  const p1 = join(await generated('Projects/client/site/node_modules/data'), '..')
  const p2 = join(await generated('Projects/server/site/dist/data'), '..')
  const p3 = join(await generated('Projects/client/site/dist/data'), '..')
  const p4 = join(await generated('Projects/unknown/node_modules/data'), '..')
  const appPath = join(await generated('Applications/Fixture App.app/Contents/Info.plist'), '../..')
  const cache = join(await generated('Library/Caches/com.fixture/data'), '..')
  const data = join(await generated('Library/Application Support/Fixture/settings'), '..')
  const config = {
    installer: [a, b],
    purge: [p4, p2, p1, p3],
    purgeSizes: { [p1]: '600KB', [p2]: '1MB', [p3]: '800KB', [p4]: 'unknown' },
    apps: [
      {
        name: 'Fixture App',
        bundle_id: 'com.fixture',
        source: 'App',
        uninstall_name: 'Fixture App',
        path: appPath,
        size: '4KB'
      }
    ]
  }
  await json('config.json', config)
  await json('uninstall.json', [
    ['app', appPath, 'com.fixture', 'policy-v1'],
    ['candidate', appPath, appPath, 'app'],
    ['candidate', appPath, cache, 'related'],
    ['candidate', appPath, data, 'related'],
    ['review', appPath, '/Library/LaunchAgents/com.fixture.plist', ''],
    ['warning', appPath, 'Package-manager metadata is retained', '']
  ])
  await json('uninstall-diagnostics.json', [])
  await mkdir(join(root, 'electron-user-data'), { recursive: true })
  app.setPath('userData', join(root, 'electron-user-data'))
  await app.whenReady()
  registerMoleIpc()
  ipcMain.handle('agent:status', () => ({ configured: false, model: '' }))
  ipcMain.handle('catalog:query', () => ({ items: [], total: 0, tags: [] }))
  ipcMain.handle('processing:select-folder', () => root)
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  registerTasksIpc(tasks)(window.webContents)
  const errors: string[] = []
  window.webContents.on('preload-error', (_event, _path, error) => {
    errors.push(error.message)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    errors.push(details.reason)
  })
  const evaluate = (code: string): Promise<unknown> => window.webContents.executeJavaScript(code)
  const section = (name: string): string =>
    `document.querySelector('.mole-tool-page[aria-label=${JSON.stringify(name)}]')`
  async function until(expression: string): Promise<void> {
    const deadline = Date.now() + 12000
    while (!(await evaluate(expression))) {
      assert.ok(
        Date.now() < deadline,
        `Timeout: ${expression}\n${String(await evaluate('document.body.innerText'))}`
      )
      await delay(40)
    }
  }
  async function click(name: string, scope = 'document'): Promise<void> {
    await evaluate(
      `(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(name)});if(!b||b.disabled)throw Error('Unavailable button: '+${JSON.stringify(name)});b.click()})()`
    )
  }
  const navigate = (name: string): Promise<void> =>
    click(name, `document.querySelector('.toolbox-navigation')`)
  const text = (name: string): Promise<unknown> => evaluate(`${section(name)}.innerText`)
  const choose = (name: string, path: string): Promise<unknown> =>
    evaluate(
      `${section(name)}.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(`选择 ${path}`))}+']').click()`
    )
  async function screenshot(name: string): Promise<void> {
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    await evaluate(
      'document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())'
    )
    await evaluate('new Promise(r=>requestAnimationFrame(r))')
    await writeFile(join(root, `${name}.png`), (await window.webContents.capturePage()).toPNG())
  }
  try {
    await window.loadFile(resolve('out/renderer/index.html'))
    await evaluate('document.querySelector(\'[aria-label="工具箱"]\').click()')
    await until("document.querySelectorAll('.toolbox-card-grid .tool-card').length === 5")
    await screenshot('toolbox-home')
    await navigate('空间分析')
    await click('选择文件夹', section('空间分析'))
    await until(`${section('空间分析')}.innerText.includes('分析已完成')`)
    assert.equal(
      await evaluate(
        `${section('空间分析')}.querySelector('.mole-analysis-name button').textContent`
      ),
      'Projects'
    )
    assert.match(String(await text('空间分析')), /未知/)
    await screenshot('analyze-complete')
    await click('Projects', section('空间分析'))
    await until(`${section('空间分析')}.innerText.includes('此位置没有报告子项')`)
    await evaluate(
      `${section('空间分析')}.querySelectorAll('.mole-tool-breadcrumb button')[${String(root.split('/').filter(Boolean).length)}].click()`
    )
    await until(`${section('空间分析')}.querySelectorAll('.mole-analysis-row').length === 3`)
    await click('大文件', section('空间分析'))
    await until(`${section('空间分析')}.querySelectorAll('.mole-analysis-row').length === 1`)
    await writeFile(join(root, 'partial'), '')
    await click('重新分析', section('空间分析'))
    await until(`${section('空间分析')}.innerText.includes('分析结果不完整')`)
    assert.match(String(await text('空间分析')), /至少 9.00 MB/)
    await rm(join(root, 'partial'))
    await writeFile(join(root, 'hold'), '')
    await click('重新分析', section('空间分析'))
    await until(`${section('空间分析')}.querySelector('.mole-tool-running') !== null`)
    const heldPid = await heldProcess()
    await click('停止', section('空间分析'))
    await until(`${section('空间分析')}.innerText.includes('操作已停止')`)
    assert.throws(() => process.kill(heldPid, 0), /ESRCH/)
    await rm(join(root, 'hold-started'))
    await rm(join(root, 'hold'))
    await click('选择文件夹', section('空间分析'))
    await until(`${section('空间分析')}.innerText.includes('分析已完成')`)
    console.log(
      'PASS Analyze: real IPC report, sorting, unknown sizes, drilldown, breadcrumb, large files, partial scan, cancellation and recovery'
    )

    await navigate('项目瘦身')
    await click('开始扫描', section('项目瘦身'))
    await until(`${section('项目瘦身')}.innerText.includes('预览已完成')`)
    assert.equal(
      await evaluate(`${section('项目瘦身')}.querySelectorAll('input:checked').length`),
      0
    )
    assert.equal(
      await evaluate(`${section('项目瘦身')}.querySelectorAll('.mole-project').length`),
      3
    )
    assert.deepEqual(
      await evaluate(
        `[...${section('项目瘦身')}.querySelectorAll('.mole-project')].map(group => [...group.querySelectorAll('.mole-candidate-row label small:first-of-type')].map(path => path.textContent))`
      ),
      [[p3, p1], [p2], [p4]],
      'Projects must sort by total known size descending, artifacts by size descending, unknown sizes last'
    )
    await choose('项目瘦身', p1)
    await click('移入回收站…', section('项目瘦身'))
    assert.ok(await exists(p1), 'Review step must not move files')
    await screenshot('purge-confirm')
    await click('确认移入回收站', section('项目瘦身'))
    await until(`${section('项目瘦身')}.innerText.includes('处理已完成')`)
    assert.equal(await exists(p1), false)
    assert.ok(await exists(p2))
    assert.ok(await exists(p3))
    assert.ok(await exists(p4))
    assert.equal(
      await evaluate(
        `${section('项目瘦身')}.querySelector('.mole-tool-measure strong').textContent`
      ),
      '1 项'
    )
    console.log(
      'PASS Purge: projects and artifacts sorted by size, unknown sizes last, separate full paths, no auto-selection, explicit review and only selected artifact moved'
    )

    await navigate('安装包清理')
    await click('开始扫描', section('安装包清理'))
    await until(`${section('安装包清理')}.innerText.includes('预览已完成')`)
    assert.equal(
      await evaluate(`${section('安装包清理')}.querySelectorAll('input:checked').length`),
      2
    )
    assert.match(String(await text('安装包清理')), /10.0 KB/)
    await navigate('空间分析')
    assert.match(String(await text('空间分析')), /分析已完成/)
    await navigate('安装包清理')
    assert.equal(
      await evaluate(`${section('安装包清理')}.querySelectorAll('input:checked').length`),
      2
    )
    await json('trash-fail.json', [b])
    await click('移入回收站…', section('安装包清理'))
    await click('确认移入回收站', section('安装包清理'))
    await until(`${section('安装包清理')}.innerText.includes('部分项目未完成')`)
    assert.equal(await exists(a), false)
    assert.ok(await exists(b))
    assert.equal(
      await evaluate(
        `${section('安装包清理')}.querySelector('.mole-tool-measure strong').textContent`
      ),
      '1 项'
    )
    assert.match(String(await text('安装包清理')), /Fixture Trash failure/)
    await screenshot('installer-partial')
    console.log(
      'PASS Installer: real file sizes, preserved selection across navigation, partial failure feedback and untouched failed file'
    )

    await navigate('应用卸载')
    await until(`${section('应用卸载')}.querySelectorAll('.mole-app').length === 1`)
    await click('检查关联文件', section('应用卸载'))
    await until(`${section('应用卸载')}.innerText.includes('预览已完成')`)
    assert.equal(
      await evaluate(
        `${section('应用卸载')}.querySelectorAll('input[type=checkbox]:checked').length`
      ),
      2
    )
    assert.equal(
      await evaluate(`${section('应用卸载')}.querySelectorAll('input[type=checkbox]').length`),
      3
    )
    assert.match(String(await text('应用卸载')), /仅供审阅的残留/)
    assert.equal(
      await evaluate(`${section('应用卸载')}.querySelectorAll('.mole-tool-warning').length`),
      1
    )
    await screenshot('uninstall-preview')
    await evaluate('document.querySelector(\'[title="夜间模式"]\').click()')
    await screenshot('uninstall-night')
    window.setSize(620, 850)
    await screenshot('uninstall-narrow')
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    window.setSize(1280, 1000)
    await click('确认卸载…', section('应用卸载'))
    await click('确认移入回收站', section('应用卸载'))
    await until(`${section('应用卸载')}.innerText.includes('处理已完成')`)
    assert.equal(
      await evaluate(`${section('应用卸载')}.querySelectorAll('.mole-tool-warning').length`),
      1,
      'Only the unique actionable warning should remain; ordinary guidance and preview/result duplicates are not extra warnings'
    )
    await screenshot('uninstall-completed')
    assert.equal(await exists(appPath), false)
    assert.equal(await exists(cache), false)
    assert.equal(await readFile(join(data, 'settings'), 'utf8'), 'fixture')
    console.log(
      'PASS Uninstall: real app list and association bridge, personal data unchecked, system leftovers read-only, selected app/cache moved and settings retained'
    )

    // A narrowed native plan is a separate scenario: only the app may be moved.
    await generated('Applications/Fixture App.app/Contents/Info.plist')
    await json('uninstall.json', [
      ['app', appPath, 'com.fixture', 'policy-narrowed'],
      ['candidate', appPath, appPath, 'app'],
      ['warning', '', `${appPath}|Shared leftovers kept (some paths unreadable)`, '']
    ])
    const unreadable = join(root, 'Applications/Unreadable Fixture')
    await json('uninstall-diagnostics.json', [
      'Sibling package receipt scan timed out (exit 124)',
      `Sibling application listing failed (exit 1): ${root}/Applications: find: ${unreadable}: Permission denied`
    ])
    await click('检查关联文件', section('应用卸载'))
    await until(`${section('应用卸载')}.innerText.includes('预览已完成')`)
    assert.match(String(await text('应用卸载')), /安装收据检查超时/)
    await evaluate(`${section('应用卸载')}.querySelector('.mole-inspection-details').open = true`)
    assert.match(String(await text('应用卸载')), /Permission denied/)
    assert.ok(String(await text('应用卸载')).includes(unreadable))
    await click('确认卸载…', section('应用卸载'))
    await click('确认移入回收站', section('应用卸载'))
    await until(`${section('应用卸载')}.innerText.includes('处理已完成')`)
    assert.equal(
      await evaluate(`${section('应用卸载')}.querySelectorAll('.mole-tool-warning').length`),
      1
    )
    assert.equal(
      await evaluate(
        `${section('应用卸载')}.querySelectorAll('.mole-inspection-details pre').length`
      ),
      2,
      'Native diagnostic causes and exact paths survive execution without duplication'
    )
    await evaluate(
      `${section('应用卸载')}.querySelector('.mole-inspection-details').scrollIntoView({block:'center'})`
    )
    await screenshot('uninstall-diagnostics')
    console.log(
      'PASS Uninstall notices: one warning, normal guidance, concrete causes and exact paths in expandable details'
    )

    await navigate('安装包清理')
    await writeFile(join(root, 'truncated'), '')
    await click('重新扫描', section('安装包清理'))
    await until(`${section('安装包清理')}.innerText.includes('预览结果不完整')`)
    assert.equal(
      await evaluate(`${section('安装包清理')}.querySelectorAll('input:checked').length`),
      0
    )
    assert.equal(
      await evaluate(
        `${section('安装包清理')}.querySelector('.mole-selection-footer button').disabled`
      ),
      true
    )
    await rm(join(root, 'truncated'))
    await writeFile(join(root, 'fail'), '')
    await click('重新扫描', section('安装包清理'))
    await until(`${section('安装包清理')}.querySelector('.mole-tool-error') !== null`)
    assert.equal(
      await evaluate(`${section('安装包清理')}.querySelector('.mole-tool-hero') === null`),
      true
    )
    await rm(join(root, 'fail'))

    // Plans are scoped to the main frame that received them, never transferable across windows or reloads.
    const plan = (await evaluate(
      "window.api.mole.toolboxPreview('scope-preview','installer')"
    )) as { previewId: string; candidates: { id: string }[] }
    const request = { previewId: plan.previewId, candidateIds: [plan.candidates[1].id] }
    const other = new BrowserWindow({
      show: false,
      webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
    })
    try {
      await other.loadFile(resolve('out/renderer/index.html'))
      await assert.rejects(
        other.webContents.executeJavaScript(
          `window.api.mole.executeSelection('scope-other','installer',${JSON.stringify(request)})`
        ),
        /不存在|会话/
      )
    } finally {
      other.destroy()
    }
    await writeFile(join(root, 'hold'), '')
    await evaluate(
      "void window.api.mole.toolboxPreview('navigation-cancel','installer').catch(()=>{})"
    )
    const navigationPid = await heldProcess()
    await window.loadFile(resolve('out/renderer/index.html'))
    await until('Boolean(window.api?.mole)')
    const deadline = Date.now() + 5000
    const processAlive = (): boolean => {
      try {
        process.kill(navigationPid, 0)
        return true
      } catch {
        return false
      }
    }
    while (processAlive()) {
      assert.ok(Date.now() < deadline, 'Navigation left an active Mole process')
      await delay(40)
    }
    await rm(join(root, 'hold'))
    await rm(join(root, 'hold-started'))
    await assert.rejects(
      evaluate(
        `window.api.mole.executeSelection('scope-reload','installer',${JSON.stringify(request)})`
      ),
      /不存在|会话/
    )
    assert.ok(await exists(b))
    assert.deepEqual(errors, [])
    await json('verification.json', {
      status: 'passed',
      realRenderer: true,
      realIpc: true,
      realWorkflow: true,
      realTaskQueue: true,
      nativeMole: false,
      nativeTrash: false
    })
    console.log(
      'PASS incomplete preview disabled, scan failure visible, preview isolation across windows/reloads, day/night and narrow layout'
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
