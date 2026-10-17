import assert from 'node:assert/strict'
import { parseAbAv1SearchResult } from './ab-av1'

export function checkAbAv1Results(): void {
  const done = {
    type: 'crf-search-done',
    crf: 52,
    vmaf: 95.3,
    predicted_encode_size: 123456,
    predicted_encode_seconds: 20
  }
  assert.deepEqual(
    parseAbAv1SearchResult(
      `${JSON.stringify({ ...done, type: 'sample-encode-done', crf: 80 })}\n${JSON.stringify(done)}\n`
    ),
    { quality: 52, sampleVmaf: 95.3, predictedVideoBytes: 123456, predictedEncodingSeconds: 20 }
  )
  for (const event of [
    { ...done, type: 'sample-encode-done' },
    { type: 'crf-search-error', message: 'Failed to find a suitable crf' },
    { ...done, crf: 101 },
    { ...done, vmaf: null },
    { ...done, predicted_encode_size: -1 },
    { ...done, predicted_encode_seconds: '20' }
  ]) {
    assert.throws(() => parseAbAv1SearchResult(JSON.stringify(event)))
  }
  assert.throws(() => parseAbAv1SearchResult('{truncated'))
  console.log(
    'PASS: ab-av1 terminal JSON validation rejects intermediate, failed and invalid results'
  )
}
