import { loadEnvFile } from 'node:process'
import { join } from 'node:path'
import type { AgentStatus } from '../../../shared/contracts/agent'

export type AgentConfig = { provider: string; model: string; apiKey: string; baseUrl?: string }

// Runtime main-process configuration. Never use VITE_ / MAIN_VITE_ for secrets.
export function loadAgentEnvironment(appPath: string, packaged: boolean): void {
  if (packaged) return
  try {
    loadEnvFile(join(appPath, '.env.local'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new Error('无法读取 .env.local，请检查文件格式和读取权限。')
    }
  }
}

export function readAgentConfig(): AgentConfig {
  const provider = process.env.ARKIVE_AI_PROVIDER?.trim() || 'openai-compatible'
  const model = process.env.ARKIVE_AI_MODEL?.trim()
  const apiKey = process.env.ARKIVE_AI_API_KEY?.trim()
  const baseUrl = process.env.ARKIVE_AI_BASE_URL?.trim()
  if (!apiKey || !model) {
    throw new Error(
      '请在项目根目录 .env.local 中填写 ARKIVE_AI_API_KEY 和 ARKIVE_AI_MODEL，然后重启应用。'
    )
  }
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new Error('OpenAI 兼容接口还需要配置 ARKIVE_AI_BASE_URL（通常以 /v1 结尾）。')
  }
  if (baseUrl) {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      throw new Error('ARKIVE_AI_BASE_URL 必须是有效的 HTTP(S) 地址。')
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('ARKIVE_AI_BASE_URL 应为不含凭据、查询参数或片段的 HTTP(S) 地址。')
    }
  }
  return { provider, model, apiKey, baseUrl }
}

export function agentStatus(): AgentStatus {
  try {
    const { provider, model } = readAgentConfig()
    return { configured: true, model: `${provider} / ${model}` }
  } catch (error) {
    return {
      configured: false,
      model: '',
      error: error instanceof Error ? error.message : '模型配置无效。'
    }
  }
}

export function safeAgentError(error: unknown): string {
  let message = error instanceof Error ? error.message : '模型请求失败，请检查配置或网络后重试。'
  const key = process.env.ARKIVE_AI_API_KEY?.trim()
  if (key) message = message.split(key).join('[已隐藏密钥]')
  return message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 1000)
}
