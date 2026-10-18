import type { CatalogApi } from './catalog'
import type { MoleApi } from './mole'
import type { VideoApi } from './video'
import type { ImageApi } from './image'
import type { ProcessingApi } from './processing'
import type { TasksApi } from './task'

export const agentChannels = {
  status: 'agent:status',
  send: 'agent:send',
  retrySummary: 'agent:retry-summary',
  stop: 'agent:stop',
  update: 'agent:update'
} as const

export type AgentRequest = { conversationId: string; requestId: string; text: string }
export type AgentRunId = Pick<AgentRequest, 'conversationId' | 'requestId'>
export type AgentSummaryRequest = AgentRunId & { sourceRequestId: string }
export type AgentToolActivity = {
  id: string
  name: string
  status: 'running' | 'completed' | 'error' | 'stopped'
  stage?: string
  logs?: string[]
  result?: { title: string; summary: string; details?: string }
}
export type AgentExecution = {
  phase:
    | 'responding'
    | 'executing'
    | 'summarizing'
    | 'completed'
    | 'summary-error'
    | 'cancelled'
    | 'error'
  tools: AgentToolActivity[]
  error?: string
}
export type AgentUpdate = AgentRunId & {
  text: string
  tool?: AgentToolActivity
  execution?: AgentExecution
}
export type AgentResult = (
  | { status: 'completed' | 'cancelled'; text: string }
  | { status: 'error'; text: string; error: string }
) & { execution?: AgentExecution }
export type AgentStatus = { configured: boolean; model: string; error?: string }

export interface AgentApi {
  status: () => Promise<AgentStatus>
  send: (request: AgentRequest) => Promise<AgentResult>
  retrySummary: (request: AgentSummaryRequest) => Promise<AgentResult>
  stop: (request: AgentRunId) => Promise<void>
  onUpdate: (listener: (update: AgentUpdate) => void) => () => void
}
export interface ArkiveApi {
  tasks: TasksApi
  processing: ProcessingApi
  catalog: CatalogApi
  agent: AgentApi
  mole: MoleApi
  video: VideoApi
  image: ImageApi
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

export function isAgentSummaryRequest(value: unknown): value is AgentSummaryRequest {
  return (
    isAgentRunId(value) &&
    'sourceRequestId' in value &&
    typeof value.sourceRequestId === 'string' &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(value.sourceRequestId)
  )
}
