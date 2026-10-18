// Deterministic model boundary; real renderer, IPC, SDK skill expansion and read tool.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { registerAgentIpc } from './ipc'
import { Catalog, setCatalog } from '../catalog/service'
import { registerCatalogIpc } from '../catalog/ipc'
import { registerMoleIpc } from '../mole/ipc'
import { agentSkills } from '../../../shared/agent-skills'

type Message = { role: string; content: string | { type: string; text?: string }[] }
function textOf(message: Message): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => part.text ?? '').join('')
}
app.on('window-all-closed', () => {})
async function check(): Promise<void> {
  await app.whenReady()
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/agent-skills-')
  await mkdir(join(directory, '.pi/skills/untrusted'), { recursive: true })
  await writeFile(
    join(directory, '.pi/skills/untrusted/SKILL.md'),
    '---\nname: untrusted\ndescription: UNTRUSTED_DISCOVERY_MARKER\n---\nUntrusted skill'
  )
  const seen = new Set<string>()
  let requests = 0
  let fixtureFailure: Error | undefined
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let raw = ''
        for await (const chunk of request) raw += String(chunk)
        const body = JSON.parse(raw) as {
          messages: Message[]
          tools: { function: { name: string } }[]
        }
        requests++
        assert.ok(
          !body.tools.some((tool) => ['bash', 'write', 'edit'].includes(tool.function.name))
        )
        const system = body.messages
          .filter((message) => message.role === 'system')
          .map(textOf)
          .join('')
        for (const skill of agentSkills) assert.ok(system.includes(`<name>${skill.name}</name>`))
        assert.ok(!system.includes('UNTRUSTED_DISCOVERY_MARKER'))
        assert.ok(!system.includes('mail-attachment-archive'))
        const user = body.messages.filter((message) => message.role === 'user').at(-1)
        assert.ok(user)
        const text = textOf(user)
        let delta: unknown
        let finish = 'stop'
        if (text === 'NATURAL_SKILL_DISCOVERY') {
          assert.ok(!system.includes('## 检查视频并提出方案'), 'Skill bodies stay lazy')
          delta = { content: '三个场景入口可用。' }
          seen.add('natural')
        } else {
          const match = /<skill name="([^"]+)" location="([^"]+)">/.exec(text)
          assert.ok(match, 'Shortcut must expand before reaching the model')
          const skill = agentSkills.find((item) => item.name === match[1])
          assert.ok(skill)
          assert.ok(!text.includes('---\nname:'), 'SDK strips frontmatter')
          if (skill.command === '/wechat') {
            assert.match(text, /独立图片始终跳过并保留原位/)
            assert.ok(text.endsWith('SKILLS_WECHAT\n只检查，不处理文件。'))
          }
          if (skill.command === '/photos') {
            assert.match(text, /preserveFormat/)
            assert.match(text, /Lightroom 导出位置由用户设置，没有通用默认目录/)
          }
          const reference = resolve(match[2], '../../references/arkive-tools.md')
          assert.match(await readFile(reference, 'utf8'), /共用工具契约/)
          const toolResult = body.messages.filter((message) => message.role === 'tool').at(-1)
          if (!toolResult) {
            delta = {
              tool_calls: [
                {
                  index: 0,
                  id: 'read-contract',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ path: reference })
                  }
                }
              ]
            }
            finish = 'tool_calls'
          } else {
            assert.match(textOf(toolResult), /共用工具契约/)
            delta = { content: `${skill.title}已加载；仅检查，未修改业务文件。` }
            seen.add(skill.name)
          }
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const [part, reason] of [
          [{ role: 'assistant', content: '' }, null],
          [delta, null],
          [{}, finish]
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: 'skills',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'skills-model',
              choices: [{ index: 0, delta: part, finish_reason: reason }]
            })}\n\n`
          )
        }
        response.end('data: [DONE]\n\n')
      } catch (error) {
        fixtureFailure = error instanceof Error ? error : new Error(String(error))
        response.destroy()
      }
    })()
  })
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  Object.assign(process.env, {
    ARKIVE_AI_PROVIDER: 'openai-compatible',
    ARKIVE_AI_BASE_URL: `http://127.0.0.1:${String(address.port)}/v1`,
    ARKIVE_AI_MODEL: 'skills-model',
    ARKIVE_AI_API_KEY: 'local-skills-key'
  })
  const catalog = new Catalog({
    databasePath: join(directory, 'catalog.db'),
    backupRoot: join(directory, 'Backup'),
    archiveRoot: join(directory, 'Archive')
  })
  setCatalog(catalog)
  await catalog.start()
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: { preload: resolve('out/preload/index.js'), sandbox: false }
  })
  registerAgentIpc(directory)(window.webContents)
  registerCatalogIpc(catalog)(window.webContents)
  registerMoleIpc()
  const evaluate = async <T>(expression: string): Promise<T> => {
    try {
      return (await window.webContents.executeJavaScript(expression)) as T
    } catch (error) {
      throw new Error(`Renderer check failed: ${expression}`, { cause: error })
    }
  }
  const scope = '.conversation-view:not([hidden])'
  const input = `${scope} [aria-label="输入消息"]`
  async function wait(expression: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!(await evaluate<boolean>(expression))) {
      if (fixtureFailure) throw fixtureFailure
      assert.ok(Date.now() < deadline, `Timeout: ${expression}`)
      await delay(30)
    }
  }
  async function type(text: string): Promise<void> {
    await wait(`document.querySelector('${input}')?.disabled===false`)
    await evaluate(
      `(()=>{const e=document.querySelector('${input}');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
  }
  async function key(key: string): Promise<void> {
    await evaluate(
      `document.querySelector('${input}').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`
    )
  }
  async function send(): Promise<void> {
    await evaluate(`document.querySelector('${scope} [aria-label="发送消息"]').click()`)
    await wait(`document.querySelector('${input}').value===''`)
    await wait(`document.querySelector('${scope} [aria-label="停止生成"]')===null`)
    if (fixtureFailure) throw fixtureFailure
  }
  async function fresh(): Promise<void> {
    await evaluate("document.querySelector('.new-conversation').click()")
    await wait(`document.querySelector('${input}')?.disabled===false`)
  }
  try {
    await window.loadFile(resolve('out/renderer/index.html'))
    await type('/')
    await wait(`document.querySelectorAll('${scope} [role="option"]').length===3`)
    await evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
    await writeFile(
      join(directory, 'skill-menu.png'),
      (await window.webContents.capturePage()).toPNG()
    )
    await key('ArrowDown')
    await key('Enter')
    await wait(`document.querySelector('${input}').value==='/wechat '`)
    assert.equal(requests, 0, 'Choosing a skill must not send or authorize operations')
    await type('/wechat SKILLS_WECHAT\n只检查，不处理文件。')
    await send()
    await wait(
      `document.querySelector('${scope} .message-list').innerText.includes('微信文件归档已加载')`
    )
    await fresh()
    await type('/ph')
    await wait(`document.querySelectorAll('${scope} [role="option"]').length===1`)
    await evaluate(`document.querySelector('${scope} [role="option"]').click()`)
    await wait(`document.querySelector('${input}').value==='/photos '`)
    await send()
    await fresh()
    await type('/concert 只检查演唱会录像。')
    await send()
    await fresh()
    // Native Pi command, including a newline between command and arguments.
    await type('/skill:concert-video-archive\n只检查大疆录像。')
    await send()
    await fresh()
    await type('/')
    await key('Escape')
    await wait(`document.querySelector('${scope} [role="listbox"]')===null`)
    await type('NATURAL_SKILL_DISCOVERY')
    await send()
    assert.deepEqual(
      [...seen].sort(),
      ['natural', ...agentSkills.map((skill) => skill.name)].sort()
    )
    assert.equal(catalog.query({}).items.length, 0)
    console.log(
      `PASS: slash menu keyboard/click/filter/Escape, three aliases + native Pi command, multiline/bare command, SDK expansion, lazy discovery, shared-reference read and local skill exclusion. Local HTTP fixture; no live model/scenario acceptance. Evidence: ${directory}`
    )
  } finally {
    window.destroy()
    await catalog.close()
    server.closeAllConnections()
    await new Promise<void>((done) => {
      server.close(() => {
        done()
      })
    })
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
