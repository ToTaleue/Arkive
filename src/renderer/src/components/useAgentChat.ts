import { useEffect, useRef, useState } from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type { Conversation, PreviewMessage } from '../chat-preview'
import type {
  AgentExecution,
  AgentResult,
  AgentRunId,
  AgentStatus
} from '../../../shared/contracts/agent'

type ChatOptions = {
  conversation: Conversation
  status: AgentStatus | null
  onAppend: (id: string, messages: PreviewMessage[]) => void
  onUpdate: (id: string, message: PreviewMessage) => void
}
type ActiveRun = AgentRunId & { message: PreviewMessage }

function settledExecution(result: AgentResult, previous?: AgentExecution): AgentExecution {
  if (result.execution) return result.execution
  const tools = (previous?.tools ?? []).map((tool) =>
    tool.status === 'running' ? { ...tool, status: 'stopped' as const } : tool
  )
  if (result.status === 'error')
    return {
      phase: tools.length > 0 ? 'summary-error' : 'error',
      tools,
      error: result.error
    }
  return { phase: result.status, tools }
}

export function useAgentChat({ conversation, status, onAppend, onUpdate }: ChatOptions): {
  isRunning: boolean
  error: string | null
  notice: string | null
  send: (message: AppendMessage) => Promise<void>
  retrySummary: (messageId: string) => Promise<void>
  stop: () => Promise<void>
} {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const run = useRef<ActiveRun | null>(null)
  const agent = window.api?.agent

  useEffect(() => {
    if (!agent || conversation.example) return
    return agent.onUpdate((update) => {
      const active = run.current
      if (update.conversationId !== conversation.id || update.requestId !== active?.requestId)
        return
      let execution = update.execution ?? active.message.execution
      if (!update.execution && update.tool) {
        const tool = update.tool
        execution = {
          phase: tool.status === 'running' ? 'executing' : 'summarizing',
          tools: [...(execution?.tools ?? []).filter((item) => item.id !== tool.id), tool]
        }
      }
      active.message = { ...active.message, content: update.text, execution }
      onUpdate(conversation.id, active.message)
    })
  }, [agent, conversation.id, conversation.example, onUpdate])

  async function complete(active: ActiveRun, invoke: () => Promise<AgentResult>): Promise<void> {
    try {
      const result = await invoke()
      active.message = {
        ...active.message,
        content: result.text,
        execution: settledExecution(result, active.message.execution)
      }
      onUpdate(conversation.id, active.message)
      if (result.status === 'cancelled')
        setNotice('已停止生成；已完成的文件操作不会回滚，可以继续发送消息。')
    } catch {
      const execution = settledExecution(
        {
          status: 'error',
          text: active.message.content,
          error: '与主进程的连接中断，请重启应用后重试。'
        },
        active.message.execution
      )
      active.message = { ...active.message, execution }
      onUpdate(conversation.id, active.message)
    } finally {
      if (run.current === active) run.current = null
      setIsRunning(false)
    }
  }

  function begin(request: AgentRunId, message: PreviewMessage): ActiveRun {
    const active = { ...request, message }
    run.current = active
    setError(null)
    setNotice(null)
    setIsRunning(true)
    onUpdate(conversation.id, message)
    return active
  }

  async function send(message: AppendMessage): Promise<void> {
    if (!agent || !status?.configured || conversation.example || run.current) return
    const textParts: string[] = []
    for (const part of message.content) {
      if (part.type === 'text') textParts.push(part.text)
    }
    const text = textParts.join('\n').trim()
    if (!text) return
    const request = { conversationId: conversation.id, requestId: crypto.randomUUID(), text }
    onAppend(conversation.id, [{ id: crypto.randomUUID(), role: 'user', content: text }])
    const active = begin(request, {
      id: request.requestId,
      role: 'assistant',
      content: '',
      sourceRequestId: request.requestId,
      execution: { phase: 'responding', tools: [] }
    })
    await complete(active, () => agent.send(request))
  }

  async function retrySummary(messageId: string): Promise<void> {
    if (!agent || !status?.configured || conversation.example || run.current) return
    const message = conversation.messages.find((item) => item.id === messageId)
    if (!message?.sourceRequestId || message.execution?.phase !== 'summary-error') return
    const request = {
      conversationId: conversation.id,
      requestId: crypto.randomUUID(),
      sourceRequestId: message.sourceRequestId
    }
    const active = begin(request, {
      ...message,
      content: '',
      execution: { phase: 'summarizing', tools: message.execution.tools }
    })
    await complete(active, () => agent.retrySummary(request))
  }

  async function stop(): Promise<void> {
    if (!agent || !run.current) return
    try {
      await agent.stop({
        conversationId: run.current.conversationId,
        requestId: run.current.requestId
      })
    } catch {
      setError('停止请求失败，请重试。')
    }
  }

  return { isRunning, error, notice, send, retrySummary, stop }
}
