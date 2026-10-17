import { useEffect, useRef, useState } from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type { Conversation, PreviewMessage } from '../chat-preview'
import type { AgentRunId, AgentStatus, AgentToolActivity } from '../../../shared/contracts/agent'

type ChatOptions = {
  conversation: Conversation
  status: AgentStatus | null
  onAppend: (id: string, messages: PreviewMessage[]) => void
  onUpdate: (id: string, message: PreviewMessage) => void
}

export function useAgentChat({ conversation, status, onAppend, onUpdate }: ChatOptions): {
  isRunning: boolean
  error: string | null
  notice: string | null
  activities: AgentToolActivity[]
  send: (message: AppendMessage) => Promise<void>
  stop: () => Promise<void>
} {
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [activities, setActivities] = useState<AgentToolActivity[]>([])
  const run = useRef<AgentRunId | null>(null)
  const agent = window.api?.agent

  useEffect(() => {
    if (!agent || conversation.example) return
    return agent.onUpdate((update) => {
      if (update.conversationId !== conversation.id || update.requestId !== run.current?.requestId)
        return
      if (update.tool) {
        const tool = update.tool
        setActivities((previous) =>
          [...previous.filter((item) => item.id !== tool.id), tool].slice(-30)
        )
      }
      onUpdate(conversation.id, { id: update.requestId, role: 'assistant', content: update.text })
    })
  }, [agent, conversation.id, conversation.example, onUpdate])

  async function send(message: AppendMessage): Promise<void> {
    if (!agent || !status?.configured || conversation.example || run.current) return
    const textParts: string[] = []
    for (const part of message.content) {
      if (part.type === 'text') textParts.push(part.text)
    }
    const text = textParts.join('\n').trim()
    if (!text) return
    const request = { conversationId: conversation.id, requestId: crypto.randomUUID(), text }
    run.current = request
    setError(null)
    setNotice(null)
    setActivities([])
    setIsRunning(true)
    onAppend(conversation.id, [{ id: crypto.randomUUID(), role: 'user', content: text }])
    try {
      const result = await agent.send(request)
      if (result.text)
        onUpdate(conversation.id, {
          id: request.requestId,
          role: 'assistant',
          content: result.text
        })
      if (result.status === 'error') setError(result.error)
      if (result.status === 'cancelled')
        setNotice('已停止生成；已完成的文件操作不会回滚，可以继续发送消息。')
    } catch {
      setError('与主进程的连接中断，请重启应用后重试。')
    } finally {
      run.current = null
      setIsRunning(false)
      setActivities((previous) =>
        previous.map((item) => (item.status === 'running' ? { ...item, status: 'stopped' } : item))
      )
    }
  }

  async function stop(): Promise<void> {
    if (!agent || !run.current) return
    try {
      await agent.stop(run.current)
    } catch {
      setError('停止请求失败，请重试。')
    }
  }

  return { isRunning, error, notice, activities, send, stop }
}
