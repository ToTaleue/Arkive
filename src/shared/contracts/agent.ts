import type { MoleApi } from './mole'
import type { VideoApi } from './video'

export const agentChannels = {
  status: 'agent:status',
  send: 'agent:send',
  stop: 'agent:stop',
  update: 'agent:update'
} as const

export type AgentRequest = { conversationId: string; requestId: string; text: string }
export type AgentRunId = Pick<AgentRequest, 'conversationId' | 'requestId'>
export type AgentUpdate = AgentRunId & { text: string }
export type AgentResult =
  | { status: 'completed' | 'cancelled'; text: string }
  | { status: 'error'; text: string; error: string }
export type AgentStatus = { configured: boolean; model: string; error?: string }

export interface AgentApi {
  status: () => Promise<AgentStatus>
  send: (request: AgentRequest) => Promise<AgentResult>
  stop: (request: AgentRunId) => Promise<void>
  onUpdate: (listener: (update: AgentUpdate) => void) => () => void
}
export interface ArkiveApi {
  agent: AgentApi
  mole: MoleApi
  video: VideoApi
}

export function isAgentRunId(value: unknown): value is AgentRunId {
  if (!value || typeof value !== 'object') return false
  return (
    'conversationId' in value &&
    typeof value.conversationId === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.conversationId) &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.requestId)
  )
}
export function isAgentRequest(value: unknown): value is AgentRequest {
  return (
    isAgentRunId(value) &&
    'text' in value &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= 32_000
  )
}
