import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike
} from '@assistant-ui/react'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Film,
  FolderArchive,
  Image,
  MessageSquare,
  ShieldCheck,
  Square
} from 'lucide-react'
import { type Conversation, type PreviewMessage } from '../chat-preview'
import { useRef } from 'react'
import { useAgentChat } from './useAgentChat'
import { MessageMarkdown } from './MessageMarkdown'
import type { AgentStatus } from '../../../shared/contracts/agent'

const suggestions = [
  {
    icon: Film,
    title: '把旧视频压小一点',
    description: '保留回忆，也留出空间',
    prompt: '我想把一些旧视频压小一点，同时保留原件。'
  },
  {
    icon: FolderArchive,
    title: '整理我的旧资料',
    description: '让每份文件都有自己的位置',
    prompt: '帮我想一想，旧项目资料应该怎样归档？'
  },
  {
    icon: Image,
    title: '聊聊照片压缩',
    description: '在画质和大小之间找到平衡',
    prompt: '我想压缩照片，但不希望明显损失画质。'
  },
  {
    icon: MessageSquare,
    title: '从微信文件开始',
    description: '给积累的文件做一次整理',
    prompt: '我想整理微信里积累的文件，之后还能方便找到。'
  }
]

function convertMessage(message: PreviewMessage): ThreadMessageLike {
  return { id: message.id, role: message.role, content: [{ type: 'text', text: message.content }] }
}

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="message user-message">
      <div className="user-message-content">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="message assistant-message">
      <div className="assistant-identity">
        <Archive size={16} />
        <span>Arkive</span>
      </div>
      <div className="assistant-message-content">
        <MessagePrimitive.Parts components={{ Text: MessageMarkdown }} />
      </div>
    </MessagePrimitive.Root>
  )
}

type ChatPanelProps = {
  conversation: Conversation
  status: AgentStatus | null
  onAppend: (id: string, messages: PreviewMessage[]) => void
  onUpdate: (id: string, message: PreviewMessage) => void
}

export function ChatPanel({
  conversation,
  status,
  onAppend,
  onUpdate
}: ChatPanelProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { isRunning, error, notice, send, stop } = useAgentChat({
    conversation,
    status,
    onAppend,
    onUpdate
  })
  const runtime = useExternalStoreRuntime({
    messages: conversation.messages,
    convertMessage,
    isRunning,
    isDisabled: conversation.example || !status?.configured,
    onNew: send,
    onCancel: stop
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport">
          {conversation.messages.length === 0 && (
            <div className="welcome-screen">
              <div className="welcome-symbol">
                <Archive size={34} strokeWidth={1.3} />
              </div>
              <div className="welcome-eyebrow">A LITTLE LESS, A LITTLE MORE.</div>
              <h2>把空间，留给更重要的事。</h2>
              <p>压缩、整理、归档。先从你想做的开始聊起。</p>
              <div className="suggestion-grid">
                {suggestions.map(({ icon: Icon, title, description, prompt }) => (
                  <button
                    key={title}
                    className="suggestion-card"
                    onClick={() => {
                      runtime.thread.composer.setText(prompt)
                      inputRef.current?.focus()
                    }}
                  >
                    <Icon size={19} strokeWidth={1.5} />
                    <span>
                      <strong>{title}</strong>
                      <small>{description}</small>
                    </span>
                    <ArrowUpRight size={15} className="suggestion-arrow" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="message-list" role="log" aria-label="对话消息" aria-live="polite">
            <ThreadPrimitive.Messages>
              {({ message }) => {
                if (message.role === 'user') return <UserMessage />
                if (message.role === 'assistant') return <AssistantMessage />
                return null
              }}
            </ThreadPrimitive.Messages>
          </div>
        </ThreadPrimitive.Viewport>
        <div className="composer-area">
          {isRunning && (
            <p className="chat-notice" role="status">
              Arkive 正在回复…
            </p>
          )}
          {!isRunning && notice && (
            <p className="chat-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          {!conversation.example && status?.error && (
            <p className="chat-error" role="alert">
              {status.error}
            </p>
          )}
          <ThreadPrimitive.ScrollToBottom
            className="scroll-to-bottom"
            aria-label="滚动到最新消息"
            title="滚动到最新消息"
          >
            <ArrowDown size={17} />
          </ThreadPrimitive.ScrollToBottom>
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              ref={inputRef}
              className="composer-input"
              placeholder="告诉 Arkive，你想整理什么？"
              aria-label="输入消息"
              rows={2}
              maxLength={32_000}
              disabled={isRunning || conversation.example || !status?.configured}
              submitMode="enter"
            />
            <div className="composer-toolbar">
              <span className="composer-mode">
                <ShieldCheck size={14} />
                {conversation.example ? '示例对话 · 只读' : 'Pi 对话'}
              </span>
              <div className="composer-actions">
                <span className="composer-shortcut">Enter 发送 · Shift + Enter 换行</span>
                {isRunning ? (
                  <ComposerPrimitive.Cancel
                    className="send-button"
                    aria-label="停止生成"
                    title="停止生成"
                  >
                    <Square size={14} />
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send
                    className="send-button"
                    aria-label="发送消息"
                    title="发送消息"
                  >
                    <ArrowUp size={18} />
                  </ComposerPrimitive.Send>
                )}
              </div>
            </div>
          </ComposerPrimitive.Root>
          <p className="composer-caption">
            {conversation.example
              ? '示例内容不发送给模型，请新建对话开始聊天'
              : status?.configured
                ? `${status.model} · 支持文件工具和 Mole 清理预览 · 消息及工具结果发送至所配置的模型服务`
                : '填写 .env.local 后重启 Electron 即可开始对话'}
          </p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}
