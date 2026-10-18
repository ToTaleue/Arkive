import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import { readAgentConfig } from './config'
import { compatibleModelLimits } from './limits'

/** Shared model setup for chat sessions and bounded, tool-free inference. */
export async function createConfiguredModel(
  signal?: AbortSignal
): Promise<{ modelRuntime: ModelRuntime; model: Model<Api> }> {
  signal?.throwIfAborted()
  const config = readAgentConfig()
  // Pi is ESM-only; preserve dynamic imports in Electron's CommonJS main bundle.
  const [sdk, ai] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai')
  ])
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    signal
  })
  let provider = config.provider
  if (provider === 'openai-compatible') {
    provider = 'arkive-compatible'
    const limits = compatibleModelLimits(config.model)
    modelRuntime.registerProvider(provider, {
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: ['text'],
          // No price estimate is shown in the UI. Keep the declared limits aligned with
          // DeepSeek V4.1 Flash so long tool runs do not get truncated by Pi's catalog.
          contextWindow: limits.contextWindow,
          maxTokens: limits.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens'
          }
        }
      ]
    })
  } else if (config.baseUrl) {
    modelRuntime.registerProvider(provider, { baseUrl: config.baseUrl })
  }
  const model = modelRuntime.getModel(provider, config.model)
  if (!model) throw new Error('Pi 未找到配置的 provider / model，请核对 .env.local 中的模型标识。')
  await modelRuntime.setRuntimeApiKey(provider, config.apiKey, { signal })
  signal?.throwIfAborted()
  return { modelRuntime, model }
}
