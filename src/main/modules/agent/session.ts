import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent'
import { createConfiguredModel } from './model'
import { arkiveSystemPrompt } from './prompt'
import { createArkiveTools } from './tools'
import { loadBuiltInSkills } from './skills'

export async function createChatSession(cwd: string): Promise<AgentSession> {
  const [{ modelRuntime, model }, sdk] = await Promise.all([
    createConfiguredModel(),
    import('@earendil-works/pi-coding-agent')
  ])

  const skills = await loadBuiltInSkills(cwd)
  // Only bundled skills; no project/global resources or extensions are discovered.
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => skills,
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
  const customTools = await createArkiveTools(cwd)
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    modelRuntime,
    resourceLoader,
    tools: ['read', 'grep', 'find', 'ls', ...customTools.map((tool) => tool.name)],
    customTools,
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
