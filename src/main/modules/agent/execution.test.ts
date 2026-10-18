import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { executionFallback, toolResult } from './execution.ts'

void test('native file tools expose useful result facts', () => {
  const grep = toolResult(
    'grep',
    { content: [{ type: 'text', text: 'report.md:8:found\n[1 match limit reached]' }] },
    false
  )
  assert.equal(grep.title, '已完成')
  assert.match(grep.summary, /1.*匹配/)
  assert.match(grep.summary, /上限|截断/)

  const none = toolResult('grep', { content: [{ type: 'text', text: 'No matches found' }] }, false)
  assert.match(none.summary, /无匹配/)

  const read = toolResult(
    'read',
    {
      content: [
        {
          type: 'text',
          text: '# title\n\n日期\n\n## 测量条件\n\n[52 more lines in file. Use offset=6 to continue.]'
        }
      ]
    },
    false
  )
  assert.match(read.summary, /返回 5 行/)
  assert.match(read.summary, /offset/)

  const pagedRead = toolResult(
    'read',
    {
      content: [
        {
          type: 'text',
          text: '\n日期：2026-10-16。\n\n\n[53 more lines in file. Use offset=5 to continue.]'
        }
      ]
    },
    false
  )
  assert.match(pagedRead.summary, /返回 3 行/)
})

void test('inspect_pdf summaries preserve warning state and page count', () => {
  const result = toolResult(
    'inspect_pdf',
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ pageCount: 38, warnings: ['WARNING: object has offset 0'] })
        }
      ],
      details: { pageCount: 38, warnings: ['WARNING: object has offset 0'] }
    },
    false
  )
  assert.equal(result.title, 'PDF 探测完成（有警告）')
  assert.match(result.summary, /38 页/)
  assert.match(result.summary, /1 条结构警告/)
})

void test('inspect_video summaries include audio codecs and discarded contents', () => {
  const result = toolResult(
    'inspect_video',
    {
      content: [{ type: 'text', text: '{}' }],
      details: {
        sizeBytes: 4_459_702,
        width: 3840,
        height: 2160,
        duration: 28.98,
        codec: 'hevc',
        bitDepth: 10,
        audioCount: 1,
        audioCodecs: ['aac'],
        removedContents: ['DJI 附加数据', '时间码', '封面／缩略图']
      }
    },
    false
  )
  assert.equal(result.title, '视频探测完成')
  assert.match(result.summary, /4\.25 MB/)
  assert.match(result.summary, /aac/)
  assert.match(result.summary, /DJI 附加数据/)
})

void test('a failed model summary still has a local execution summary', () => {
  const summary = executionFallback({
    phase: 'summary-error',
    error: '模型未返回完整总结。',
    tools: [
      {
        id: '1',
        name: 'grep',
        status: 'completed',
        result: { title: 'grep 已完成', summary: '未找到匹配内容。' }
      },
      {
        id: '2',
        name: 'read',
        status: 'error',
        result: { title: '工具执行失败', summary: '请查看错误详情。' }
      }
    ]
  })
  assert.match(summary, /2.*工具/)
  assert.match(summary, /grep/)
  assert.match(summary, /read/)
  assert.match(summary, /未找到匹配|失败/)
})
