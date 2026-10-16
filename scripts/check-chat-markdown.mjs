// Run with: rtk proxy node scripts/check-chat-markdown.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'vite'

await mkdir('out', { recursive: true })
const buildDir = await mkdtemp(resolve('out/chat-markdown-check-'))
const previousWindow = globalThis.window
globalThis.window = {}

try {
  await build({
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    build: {
      ssr: true,
      target: 'node22',
      outDir: buildDir,
      rollupOptions: {
        input: resolve('src/renderer/src/components/ChatPanel.tsx'),
        output: { format: 'es', entryFileNames: 'chat.mjs' }
      }
    }
  })
  const { ChatPanel } = await import(pathToFileURL(resolve(buildDir, 'chat.mjs')).href)
  const markdown = [
    '## 归档方案',
    '',
    '**保留原件**，使用 `archive.zip`。',
    '',
    '- 第一步',
    '- 第二步',
    '',
    '> 先校验结果',
    '',
    '| 文件 | 大小 |',
    '| --- | --- |',
    '| 视频 | 12 MB |',
    '',
    '- [x] 已检查',
    '',
    '~~旧方案~~',
    '',
    '```ts',
    'const keepOriginal = true',
    '```',
    '',
    '[文档](https://example.com/docs)',
    '',
    '[危险链接](javascript:alert%281%29)',
    '',
    '[本地文件](file:///tmp/example.txt)',
    '',
    '[相对路径](./example.txt)',
    '',
    '<script>alert(1)</script>'
  ].join('\n')

  // Replay cumulative text snapshots, including an unfinished code fence.
  const snapshots = [
    markdown,
    '## 归档',
    '## 归档方案\n\n**保留',
    '```ts\nconst keepOriginal = true'
  ]
  const rendered = snapshots.map((text) =>
    renderToStaticMarkup(
      createElement(ChatPanel, {
        conversation: {
          id: 'markdown-check',
          title: 'Markdown 检查',
          example: true,
          messages: [
            { id: 'user', role: 'user', content: '**原样保留用户输入**' },
            { id: 'assistant', role: 'assistant', content: text }
          ]
        },
        status: null,
        onAppend: assert.fail,
        onUpdate: assert.fail
      })
    )
  )

  const [html] = rendered
  assert.match(html, /<h2>归档方案<\/h2>/)
  assert.match(html, /<strong>保留原件<\/strong>/)
  assert.match(html, /<code>archive\.zip<\/code>/)
  assert.match(html, /<ul>\s*<li>第一步<\/li>/)
  assert.match(html, /<blockquote>/)
  assert.match(html, /<table>/)
  assert.match(html, /type="checkbox"[^>]*checked=""/)
  assert.match(html, /<del>旧方案<\/del>/)
  assert.match(html, /<pre><code class="language-ts">const keepOriginal = true/)
  assert.match(html, /<a[^>]*href="https:\/\/example\.com\/docs"[^>]*target="_blank"/)
  assert.doesNotMatch(html, /href="(?:javascript:|file:|\.\/)/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /\*\*原样保留用户输入\*\*/)

  assert.match(rendered[1], /<h2>归档<\/h2>/)
  assert.match(rendered[2], /<h2>归档方案<\/h2>/)
  assert.match(rendered[3], /<pre><code/)
  console.log(
    'Chat Markdown checks passed: message integration, GFM, links, HTML and partial replies.'
  )
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  await rm(buildDir, { recursive: true, force: true })
}
