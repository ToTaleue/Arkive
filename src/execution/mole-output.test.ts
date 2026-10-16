import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MoleOutputParser } from './mole-output'
import type { MoleOutputBlock, MoleOutputEvent } from '../shared/contracts/mole'

const sample = [
  'Clean Your Mac',
  'Dry Run Mode, Preview only, no deletions',
  '',
  '\u001b[35m➤ User essentials\u001b[0m',
  '  → User app cache · 20 items, 3.75GB dry',
  '  ◎ Trash · skipped, grant Full Disk Access to your terminal',
  '',
  '➤ App caches',
  '  → Media analysis temp files · 2 items, 7.5MB dry',
  '',
  '➤ Browsers',
  '  → Chrome cache · 1.63GB dry',
  '',
  '======================================================================',
  'Dry run complete - no changes made',
  'Potential space: 4.70GB | Items: 778 | Categories: 7',
  '======================================================================',
  ''
].join('\r\n')

function parse(chunks: string[], partial = false): MoleOutputEvent[] {
  const events: MoleOutputEvent[] = []
  const parser = new MoleOutputParser('stdout', (event) => events.push(event))
  for (const chunk of chunks) parser.push(chunk)
  parser.finish(partial)
  return events
}

function blocks(events: MoleOutputEvent[]): MoleOutputBlock[] {
  return events.flatMap((event) => (event.type === 'block' ? [event.block] : []))
}

void test('realistic Mole output survives arbitrary chunk splits, ANSI and CRLF', () => {
  const expected = parse([sample])
  assert.deepEqual(
    parse(Array.from({ length: sample.length }, (_, i) => sample.slice(i, i + 1))),
    expected
  )
  for (let split = 0; split <= sample.length; split++) {
    assert.deepEqual(parse([sample.slice(0, split), sample.slice(split)]), expected)
  }
  const output = blocks(expected)
  assert.deepEqual(
    output.map((block) => block.title),
    ['运行日志', 'User essentials', 'App caches', 'Browsers', '运行摘要']
  )
  assert.match(output[1].text, /Trash · skipped/)
  assert.match(output[4].text, /Potential space: 4.70GB/)
  assert.ok(output.every((block) => !block.partial && !block.text.includes('\u001b')))
})

void test('a chapter is delivered before process exit, when the next chapter begins', () => {
  const events: MoleOutputEvent[] = []
  const parser = new MoleOutputParser('stdout', (event) => events.push(event))
  parser.push('➤ App caches\ncache result\n')
  assert.equal(blocks(events).length, 0)
  parser.push('➤ Newly added category\n')
  assert.equal(blocks(events)[0].text, 'cache result')
  assert.deepEqual(events.at(-1), { type: 'stage', title: 'Newly added category' })
  parser.push('new result without trailing newline')
  parser.finish(false)
  assert.equal(blocks(events)[1].title, 'Newly added category')
  assert.equal(blocks(events)[1].text, 'new result without trailing newline')
})

void test('unknown or missing chapter markers fall back to log batches without losing lines', () => {
  const events: MoleOutputEvent[] = []
  const parser = new MoleOutputParser('stdout', (event) => events.push(event))
  const lines = Array.from({ length: 25 }, (_, i) => `log ${String(i)}`)
  parser.push(lines.slice(0, 24).join('\n') + '\n')
  assert.equal(blocks(events).length, 2)
  parser.push(lines[24])
  parser.finish(false)
  const output = blocks(events)
  assert.equal(output.map((block) => block.text).join('\n'), lines.join('\n'))
  assert.ok(output.every((block) => block.kind === 'log'))
})

void test('abnormal exit preserves the last fragment and marks it partial', () => {
  const output = blocks(parse(['➤ Browsers\npartial cache res'], true))
  assert.equal(output[0].text, 'partial cache res')
  assert.equal(output[0].partial, true)
  assert.deepEqual(parse(['']), [])
})

void test('large sections and output without newlines are delivered in bounded batches', () => {
  const events: MoleOutputEvent[] = []
  const parser = new MoleOutputParser('stdout', (event) => events.push(event))
  const text = 'x'.repeat(40_000)
  parser.push(text)
  assert.equal(blocks(events).length, 2)
  parser.finish(true)
  parser.finish(true)
  const output = blocks(events)
  assert.equal(output.map((block) => block.text).join(''), text)
  assert.equal(output[2].partial, true)
  assert.equal(output[2].continued, true)
  assert.equal(new Set(output.map((block) => block.id)).size, output.length)
  const withHeading = `➤ Long section\n${text}\n➤ Next\nlast\n`
  assert.deepEqual(
    parse([withHeading]),
    parse(Array.from({ length: withHeading.length }, (_, i) => withHeading.slice(i, i + 1)))
  )
})

void test('stderr keeps its own source and cannot change the stdout scan stage', () => {
  const events: MoleOutputEvent[] = []
  const parser = new MoleOutputParser('stderr', (event) => events.push(event))
  parser.push('➤ diagnostic\npermission denied')
  parser.finish(true)
  assert.equal(events.length, 1)
  const output = blocks(events)[0]
  assert.equal(output.source, 'stderr')
  assert.equal(output.title, '错误与提示')
  assert.match(output.text, /permission denied/)
})
