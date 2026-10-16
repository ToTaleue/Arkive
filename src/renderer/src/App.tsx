import { useCallback, useEffect, useState } from 'react'
import {
  Archive,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Plus,
  ShieldCheck,
  SquarePen,
  X
} from 'lucide-react'
import { ChatPanel } from './components/ChatPanel'
import { initialConversations, type Conversation, type PreviewMessage } from './chat-preview'
import type { AgentStatus } from '../../shared/contracts/agent'

function App(): React.JSX.Element {
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 680)
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 960)
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [activeId, setActiveId] = useState('welcome')
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(() =>
    window.api?.agent
      ? null
      : { configured: false, model: '', error: '请在 Electron 桌面应用中使用真实对话。' }
  )
  useEffect(() => {
    let active = true
    const agent = window.api?.agent
    if (!agent) return
    agent
      .status()
      .then((status) => {
        if (active) setAgentStatus(status)
      })
      .catch(() => {
        if (active)
          setAgentStatus({ configured: false, model: '', error: '无法读取模型配置，请重启应用。' })
      })
    return () => {
      active = false
    }
  }, [])
  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  if (!activeConversation) throw new Error('Active conversation is missing')

  function newConversation(): void {
    const emptyConversation = conversations.find(
      (conversation) => conversation.messages.length === 0
    )
    if (emptyConversation) {
      setActiveId(emptyConversation.id)
      return
    }
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title: '新对话',
      messages: [],
      example: false
    }
    setConversations((current) => [conversation, ...current])
    setActiveId(conversation.id)
  }

  const appendMessages = useCallback((id: string, messages: PreviewMessage[]): void => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id
          ? {
              ...conversation,
              title:
                conversation.messages.length === 0
                  ? messages[0].content.slice(0, 24)
                  : conversation.title,
              messages: [...conversation.messages, ...messages]
            }
          : conversation
      )
    )
  }, [])

  const updateMessage = useCallback((id: string, message: PreviewMessage): void => {
    setConversations((current) =>
      current.map((conversation) => {
        if (conversation.id !== id) return conversation
        const exists = conversation.messages.some((item) => item.id === message.id)
        return {
          ...conversation,
          messages: exists
            ? conversation.messages.map((item) => (item.id === message.id ? message : item))
            : [...conversation.messages, message]
        }
      })
    )
  }, [])

  return (
    <div className="app-shell">
      <header className="window-bar">
        <div className="window-controls-space" />
        <div className="window-breadcrumb">
          <Archive size={15} />
          <span>Arkive</span>
          <ChevronRight size={13} />
          <span className="muted">工作空间</span>
        </div>
        <span className="preview-badge">
          <span />
          {agentStatus?.configured ? 'Pi 对话' : '待配置模型'}
        </span>
      </header>
      <div className="workspace">
        <nav className="icon-rail" aria-label="主导航">
          <button
            className="brand-mark"
            title="新对话"
            aria-label="新对话"
            onClick={newConversation}
          >
            <Archive size={23} strokeWidth={1.6} />
          </button>
          <div className="rail-divider" />
          <button
            className={`rail-button ${leftOpen ? 'active' : ''}`}
            title="切换会话列表"
            aria-label="切换会话列表"
            aria-controls="conversation-sidebar"
            aria-expanded={leftOpen}
            onClick={() => {
              setLeftOpen(!leftOpen)
            }}
          >
            <MessageSquare size={21} strokeWidth={1.6} />
          </button>
          <button
            className={`rail-button ${rightOpen ? 'active' : ''}`}
            title="切换工作区"
            aria-label="切换工作区"
            aria-controls="details-sidebar"
            aria-expanded={rightOpen}
            onClick={() => {
              setRightOpen(!rightOpen)
            }}
          >
            <FolderOpen size={21} strokeWidth={1.6} />
          </button>
          <div className="rail-bottom">
            <span className="profile-mark" title="本地工作空间">
              H
            </span>
          </div>
        </nav>
        {leftOpen && (
          <aside id="conversation-sidebar" className="conversation-sidebar" aria-label="会话列表">
            <div className="sidebar-heading">
              <h1>Arkive</h1>
              <button
                className="icon-button"
                title="收起会话列表"
                aria-label="收起会话列表"
                onClick={() => {
                  setLeftOpen(false)
                }}
              >
                <PanelLeft size={18} />
              </button>
            </div>
            <button className="new-conversation" onClick={newConversation}>
              <SquarePen size={17} />
              新对话<kbd>＋</kbd>
            </button>
            <div className="conversation-groups">
              {[false, true].map((example) => (
                <section key={String(example)} className="conversation-group">
                  <h2>{example ? '示例对话' : '今天'}</h2>
                  {conversations
                    .filter((conversation) => conversation.example === example)
                    .map((conversation) => (
                      <button
                        key={conversation.id}
                        className={`conversation-item ${activeId === conversation.id ? 'selected' : ''}`}
                        aria-current={activeId === conversation.id ? 'page' : undefined}
                        onClick={() => {
                          setActiveId(conversation.id)
                        }}
                        title={conversation.title}
                      >
                        <MessageSquare size={15} />
                        <span>{conversation.title}</span>
                        {activeId === conversation.id && <span className="selected-dot" />}
                      </button>
                    ))}
                </section>
              ))}
            </div>
            <div className="sidebar-footer">
              <span className="status-dot" />
              <span>会话仅保留在本次运行中</span>
            </div>
          </aside>
        )}
        <main className="chat-main">
          <header className="chat-header">
            <div className="chat-title">
              {!leftOpen && (
                <button
                  className="icon-button"
                  title="展开会话列表"
                  aria-label="展开会话列表"
                  onClick={() => {
                    setLeftOpen(true)
                  }}
                >
                  <PanelLeft size={18} />
                </button>
              )}
              <span>{activeConversation.title}</span>
            </div>
            <button
              className={`icon-button ${rightOpen ? 'is-on' : ''}`}
              title={rightOpen ? '收起工作区' : '展开工作区'}
              aria-label={rightOpen ? '收起工作区' : '展开工作区'}
              aria-expanded={rightOpen}
              aria-controls="details-sidebar"
              onClick={() => {
                setRightOpen(!rightOpen)
              }}
            >
              <PanelRight size={18} />
            </button>
          </header>
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className="conversation-view"
              hidden={conversation.id !== activeId}
            >
              <ChatPanel
                conversation={conversation}
                status={agentStatus}
                onAppend={appendMessages}
                onUpdate={updateMessage}
              />
            </div>
          ))}
        </main>
        {rightOpen && (
          <aside id="details-sidebar" className="details-sidebar" aria-label="工作区">
            <header className="details-header">
              <span>
                <Folder size={16} />
                工作区
              </span>
              <button
                className="icon-button"
                title="关闭工作区"
                aria-label="关闭工作区"
                onClick={() => {
                  setRightOpen(false)
                }}
              >
                <X size={17} />
              </button>
            </header>
            <div className="details-content">
              <div className="section-eyebrow">当前会话</div>
              <h2>{activeConversation.title}</h2>
              <div className="empty-files">
                <div className="folder-illustration">
                  <FolderOpen size={30} strokeWidth={1.3} />
                  <span>
                    <Plus size={12} />
                  </span>
                </div>
                <h3>还没有添加文件</h3>
                <p>之后可在这里查看待处理文件、归档方案和任务进度。</p>
              </div>
              <section className="workflow-guide">
                <div className="section-eyebrow">从想法到归档</div>
                <div>
                  <span>01</span>
                  <p>
                    描述你的整理需求<small>在对话中说说想处理什么</small>
                  </p>
                </div>
                <div>
                  <span>02</span>
                  <p>
                    一起确认处理方案<small>选择文件与原件保留方式</small>
                  </p>
                </div>
                <div>
                  <span>03</span>
                  <p>
                    查看进度与归档结果<small>校验完成后再处理原件</small>
                  </p>
                </div>
              </section>
              <div className="preview-note">
                <ShieldCheck size={17} />
                <p>
                  当前已接入 Pi 对话<small>文件处理功能尚未接入</small>
                </p>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

export default App
