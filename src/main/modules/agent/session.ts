import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent'
import { readAgentConfig } from './config'
import { arkiveSystemPrompt } from './prompt'

export async function createChatSession(cwd: string): Promise<AgentSession> {
  const config = readAgentConfig()
  // Pi is ESM-only; preserve dynamic imports in Electron's CommonJS main bundle.
  const [sdk, ai] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai')
  ])
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false
  })
  let provider = config.provider
  if (provider === 'openai-compatible') {
    provider = 'arkive-compatible'
    modelRuntime.registerProvider(provider, {
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: ['text'],
          // Conservative integration limits; no price estimate is shown in the UI.
          contextWindow: 32_768,
          maxTokens: 4096,
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
  await modelRuntime.setRuntimeApiKey(provider, config.apiKey)

  // No discovery of project/global extensions, skills, prompts or context files.
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => arkiveSystemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
      /* No discoverable resources in this chat. */
    },
    reload: () => Promise.resolve()
  }
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    modelRuntime,
    resourceLoader,
    tools: [],
    noTools: 'all',
    thinkingLevel: 'off',
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager: sdk.SettingsManager.inMemory({
      retry: {
        enabled: false,
        provider: { timeoutMs: 60_000, maxRetries: 0 }
      },
      cacheWarming: 'off'
    })
  })
  return session
}
