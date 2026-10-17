import assert from 'node:assert/strict'
import type { VideoCompressionProgress } from '../../../shared/contracts/video'
import { createProgressReader } from './progress'

export function checkProgressEstimates(): void {
  const updates: VideoCompressionProgress[] = []
  let clock = 0
  const read = createProgressReader(
    'encoding',
    100,
    (update) => updates.push(update),
    undefined,
    () => clock
  )
  const report = (seconds: string, milliseconds: number): VideoCompressionProgress => {
    clock = milliseconds
    read(`out_time_us=${seconds}`)
    read('progress=continue')
    const latest = updates.at(-1)
    assert.ok(latest)
    return latest
  }
  assert.equal(report('1000000', 500).remainingSeconds, null)
  const measured = report('10000000', 2000)
  assert.equal(measured.percent, 10)
  assert.equal(measured.remainingSeconds, 18)
  const slower = report('20000000', 10000)
  assert.equal(slower.remainingSeconds, 40)
  assert.equal(report('-1000000', 11000).percent, 20)
  assert.equal(report('N/A', 12000).percent, 20)
  assert.equal(report('1e999', 13000).percent, 20)
  const final = report('110000000', 14000)
  assert.equal(final.percent, 99)
  assert.equal(final.remainingSeconds, null)
  read('progress=end')
  assert.ok(updates.every((update) => update.percent !== 100))
  const validating: VideoCompressionProgress[] = []
  createProgressReader(
    'validating',
    100,
    (update) => validating.push(update),
    undefined,
    () => clock
  )
  assert.deepEqual(validating[0], {
    stage: 'validating',
    percent: 0,
    elapsedSeconds: 0,
    remainingSeconds: null
  })
  const byFrames: VideoCompressionProgress[] = []
  const readFrames = createProgressReader(
    'encoding',
    100,
    (update) => byFrames.push(update),
    1000,
    () => clock
  )
  clock += 2000
  readFrames('frame=100')
  readFrames('out_time_us=0')
  readFrames('progress=continue')
  assert.equal(byFrames.at(-1)?.percent, 10)
  assert.equal(byFrames.at(-1)?.remainingSeconds, 18)
  console.log(
    'PASS: measured ETA adapts to speed; startup/invalid timestamps/stage reset/final flush handled'
  )
}
