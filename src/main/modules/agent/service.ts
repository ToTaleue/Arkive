import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type {
  AgentRequest,
  AgentResult,
  AgentRunId,
  AgentUpdate
} from '../../../shared/contracts/agent'
import { agentErrorMessage } from './config'
import { createChatSession } from './session'

type ConversationSession = { session?: AgentSession; requestId?: string; cancelled: boolean }

// One service per renderer lifetime; each conversation has an independent Pi session.
export class AgentService {
  private readonly conversations = new Map<string, ConversationSession>()
  private disposed = false
  constructor(private readonly cwd: string) {}

  // Read current state after awaits; stop/dispose and SDK callbacks can change it.
  private isStopped(conversation?: ConversationSession): boolean {
    return this.disposed || (conversation?.cancelled ?? false)
  }

  async send(request: AgentRequest, emit: (update: AgentUpdate) => void): Promise<AgentResult> {
    if (this.isStopped()) return { status: 'error', text: '', error: '会话窗口已关闭。' }
    let conversation = this.conversations.get(request.conversationId)
    if (conversation?.requestId)
      return { status: 'error', text: '', error: '当前会话仍在回复，请先停止或等待完成。' }
    if (!conversation) {
      if (this.conversations.size >= 100)
        return { status: 'error', text: '', error: '本次运行的会话数量已达上限，请重启应用。' }
      conversation = { cancelled: false }
      this.conversations.set(request.conversationId, conversation)
    }
    // Reserve before the first await, including SDK initialization.
    conversation.requestId = request.requestId
    conversation.cancelled = false
    let text = ''
    let failure: string | undefined
    let unsubscribe: (() => void) | undefined
    try {
      conversation.session ??= await createChatSession(this.cwd)
      const session = conversation.session
      if (this.isStopped(conversation)) {
        if (this.disposed) session.dispose()
        return { status: 'cancelled', text }
      }
      unsubscribe = session.subscribe((event) => {
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
          emit({
            conversationId: request.conversationId,
            requestId: request.requestId,
            text,
            tool: {
              id: event.toolCallId,
              name: event.toolName,
              status:
                event.type === 'tool_execution_start'
                  ? 'running'
                  : event.isError
                    ? 'error'
                    : 'completed'
            }
          })
        } else if (
          event.type === 'message_update' &&
          event.assistantMessageEvent.type === 'text_delta'
        ) {
          text += event.assistantMessageEvent.delta
          emit({ conversationId: request.conversationId, requestId: request.requestId, text })
        } else if (event.type === 'message_end' && event.message.role === 'assistant') {
          text = event.message.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('')
          if (event.message.stopReason === 'error')
            failure = event.message.errorMessage || '模型请求失败。'
          if (event.message.stopReason === 'aborted') conversation.cancelled = true
        }
      })
      await session.prompt(request.text, { expandPromptTemplates: false })
      await session.waitForIdle()
      if (this.isStopped(conversation)) return { status: 'cancelled', text }
      if (failure) throw new Error(failure)
      if (!text.trim()) throw new Error('模型没有返回文字，请检查模型是否支持当前接口后重试。')
      return { status: 'completed', text }
    } catch (error) {
      if (this.isStopped(conversation)) return { status: 'cancelled', text }
      return { status: 'error', text, error: await agentErrorMessage(error) }
    } finally {
      unsubscribe?.()
      conversation.requestId = undefined
    }
  }

  async stop(request: AgentRunId): Promise<void> {
    const conversation = this.conversations.get(request.conversationId)
    if (conversation?.requestId !== request.requestId) return
    conversation.cancelled = true
    await conversation.session?.abort()
  }

  dispose(): void {
    this.disposed = true
    for (const conversation of this.conversations.values()) {
      conversation.cancelled = true
      conversation.session?.dispose()
    }
    this.conversations.clear()
  }
}
