import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { compatibleModelLimits } from './limits.ts'

void test('DeepSeek V4.1 Flash uses its published context and output limits', () => {
  assert.deepEqual(compatibleModelLimits('DeepSeek-V4.1-Flash-1017'), {
    contextWindow: 1_000_000,
    maxTokens: 384_000
  })
  assert.deepEqual(compatibleModelLimits('workflow-model'), {
    contextWindow: 32_768,
    maxTokens: 4096
  })
})
