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
  Slash,
  Square
} from 'lucide-react'
import { type Conversation, type PreviewMessage } from '../chat-preview'
import { useEffect, useRef, useState } from 'react'
import { useAgentChat } from './useAgentChat'
import { MessageMarkdown } from './MessageMarkdown'
import { AgentExecutionDetails, AgentExecutionError } from './AgentExecutionDetails'
import type { AgentStatus } from '../../../shared/contracts/agent'
import { agentSkills } from '../../../shared/agent-skills'

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

function AssistantMessage({
  message,
  retryDisabled,
  onRetry
}: {
  message?: PreviewMessage
  retryDisabled: boolean
  onRetry: () => void
}): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="message assistant-message">
      <div className="assistant-identity">
        <Archive size={16} />
        <span>Arkive</span>
      </div>
      {message?.execution && <AgentExecutionDetails execution={message.execution} />}
      <div className="assistant-message-content">
        <MessagePrimitive.Parts components={{ Text: MessageMarkdown }} />
      </div>
      {message?.execution && (
        <AgentExecutionError
          execution={message.execution}
          retryDisabled={retryDisabled}
          onRetry={onRetry}
        />
      )}
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
  const [skillQuery, setSkillQuery] = useState('')
  const [skillIndex, setSkillIndex] = useState(0)
  const { isRunning, error, notice, send, retrySummary, stop } = useAgentChat({
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
  const initialPromptSent = useRef(false)
  useEffect(() => {
    const prompt = conversation.initialPrompt
    if (!prompt || initialPromptSent.current || conversation.example || !status) return
    if (conversation.messages.length > 0) return
    if (!status.configured) {
      runtime.thread.composer.setText(prompt)
      return
    }
    initialPromptSent.current = true
    runtime.thread.composer.setText('')
    runtime.thread.append(prompt)
  }, [
    conversation.initialPrompt,
    conversation.example,
    conversation.messages.length,
    status,
    runtime
  ])
  const skillChoices =
    !isRunning && !conversation.example && status?.configured && /^\/\S*$/.test(skillQuery)
      ? agentSkills.filter(
          (skill) =>
            skill.command.startsWith(skillQuery) || `/skill:${skill.name}`.startsWith(skillQuery)
        )
      : []
  const selectedSkill = skillChoices.length > 0 ? skillChoices[skillIndex] : undefined
  function selectSkill(command: string): void {
    runtime.thread.composer.setText(`${command} `)
    setSkillQuery('')
    inputRef.current?.focus()
  }

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
                      setSkillQuery('')
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
                if (message.role === 'assistant')
                  return (
                    <AssistantMessage
                      message={conversation.messages.find((item) => item.id === message.id)}
                      retryDisabled={isRunning || !status?.configured}
                      onRetry={() => void retrySummary(message.id)}
                    />
                  )
                return null
              }}
            </ThreadPrimitive.Messages>
          </div>
        </ThreadPrimitive.Viewport>
        <div className="composer-area">
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
            {skillChoices.length > 0 && (
              <div
                className="skill-commands"
                id={`skills-${conversation.id}`}
                role="listbox"
                aria-label="场景快捷指令"
              >
                {skillChoices.map((skill) => (
                  <button
                    type="button"
                    role="option"
                    id={`skill-${conversation.id}-${skill.name}`}
                    aria-selected={selectedSkill?.name === skill.name}
                    key={skill.name}
                    onMouseDown={(event) => {
                      event.preventDefault()
                    }}
                    onClick={() => {
                      selectSkill(skill.command)
                    }}
                  >
                    <strong>
                      {skill.title}
                      <code>{skill.command}</code>
                    </strong>
                    <small>{skill.description}</small>
                  </button>
                ))}
              </div>
            )}
            <ComposerPrimitive.Input
              ref={inputRef}
              className="composer-input"
              placeholder="告诉 Arkive，你想整理什么？输入 / 选择场景"
              aria-label="输入消息"
              aria-controls={skillChoices.length ? `skills-${conversation.id}` : undefined}
              aria-expanded={skillChoices.length > 0}
              aria-activedescendant={
                selectedSkill ? `skill-${conversation.id}-${selectedSkill.name}` : undefined
              }
              onChange={(event) => {
                setSkillQuery(event.target.value)
                setSkillIndex(0)
              }}
              onKeyDown={(event) => {
                if (!selectedSkill || event.nativeEvent.isComposing) return
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const step = event.key === 'ArrowDown' ? 1 : -1
                  setSkillIndex(
                    (index) => (index + step + skillChoices.length) % skillChoices.length
                  )
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setSkillQuery('')
                } else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  selectSkill(selectedSkill.command)
                }
              }}
              rows={2}
              maxLength={32_000}
              disabled={isRunning || conversation.example || !status?.configured}
              submitMode="enter"
            />
            <div className="composer-toolbar">
              <span className="composer-mode">
                <ShieldCheck size={14} />
                {conversation.example ? '示例对话 · 只读' : 'Pi 对话'}
                {!conversation.example && (
                  <button
                    type="button"
                    className="skill-toggle"
                    aria-label="选择场景 Skill"
                    title="输入 / 选择场景"
                    disabled={isRunning || !status?.configured}
                    onClick={() => {
                      runtime.thread.composer.setText('/')
                      setSkillQuery('/')
                      setSkillIndex(0)
                      inputRef.current?.focus()
                    }}
                  >
                    <Slash size={12} /> 场景
                  </button>
                )}
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
