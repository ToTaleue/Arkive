import { useCompressionTask, compressionTaskMessage } from './hooks/useCompressionTask'
import { ArchivePage } from './components/ArchivePage'
import { DocumentCompressionPage } from './components/DocumentCompressionPage'
import './assets/archive.css'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  Shrink,
  Moon,
  Sun,
  X,
  Wrench
} from 'lucide-react'
import { ChatPanel } from './components/ChatPanel'
import { VideoCompressionPage } from './components/VideoCompressionPage'
import { ImageCompressionPage } from './components/ImageCompressionPage'
import { ToolboxPage } from './components/ToolboxPage'
import { CompressionPage } from './components/CompressionPage'
import { initialConversations, type Conversation, type PreviewMessage } from './chat-preview'
import type { AgentStatus } from '../../shared/contracts/agent'
import type {
  MoleCandidate,
  MoleInstalledApp,
  MoleOutputBlock,
  MolePreviewResult
} from '../../shared/contracts/mole'

function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<
    'chat' | 'compression' | 'video' | 'image' | 'documents' | 'archive' | 'toolbox'
  >('chat')
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 680)
  const [rightOpen, setRightOpen] = useState(false)
  const [theme, setTheme] = useState<'day' | 'night'>(() => {
    const saved = window.localStorage.getItem('arkive-theme')
    return saved === 'night' ? 'night' : 'day'
  })
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations)
  const [activeId, setActiveId] = useState('welcome')
  const [moleRunning, setMoleRunning] = useState(false)
  const [moleResult, setMoleResult] = useState<MolePreviewResult | null>(null)
  const [moleMode, setMoleMode] = useState<
    'clean' | 'installer' | 'purge' | 'uninstall' | 'analyze'
  >('clean')
  const [moleApps, setMoleApps] = useState<MoleInstalledApp[]>([])
  const [moleSelectedPaths, setMoleSelectedPaths] = useState<string[]>([])
  const [moleAnalyzeResult, setMoleAnalyzeResult] = useState<unknown>(null)
  const [moleActionMessage, setMoleActionMessage] = useState<string | null>(null)
  const [moleAuthorization, setMoleAuthorization] = useState<
    'unknown' | 'authorizing' | 'authorized'
  >('unknown')
  const [moleError, setMoleError] = useState<string | null>(null)
  const [moleBlocks, setMoleBlocks] = useState<MoleOutputBlock[]>([])
  const [moleStage, setMoleStage] = useState<string | null>(null)
  const moleRunId = useRef<string | null>(null)
  const [moleTaskRequestId, setMoleTaskRequestId] = useState<string | null>(null)
  const moleTask = useCompressionTask(moleTaskRequestId)
  const moleAvailable = Boolean(window.api?.mole && Object.hasOwn(window.api.mole, 'onUpdate'))
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
  useEffect(() => {
    const mole = window.api?.mole
    // Renderer HMR can run ahead of a restarted preload during development.
    if (!mole || !Object.hasOwn(mole, 'onUpdate')) return
    const unsubscribe = mole.onUpdate((update) => {
      if (update.runId !== moleRunId.current) return
      if (update.event.type === 'stage') {
        setMoleStage(update.event.title)
      } else {
        const { block } = update.event
        setMoleBlocks((current) => [...current, block])
      }
    })
    return () => {
      unsubscribe()
      moleRunId.current = null
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('arkive-theme', theme)
  }, [theme])

  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  if (!activeConversation) throw new Error('Active conversation is missing')

  function newConversation(): void {
    setActivePage('chat')
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

  async function runMoleDryRun(): Promise<void> {
    const mole = window.api?.mole
    if (!mole || !moleAvailable || moleRunId.current) return
    const runId = crypto.randomUUID()
    moleRunId.current = runId
    setMoleTaskRequestId(runId)
    setMoleRunning(true)
    setMoleResult(null)
    setMoleError(null)
    setMoleBlocks([])
    setMoleStage(null)
    setMoleMode('clean')
    setMoleSelectedPaths([])
    try {
      const result = await mole.dryRun(runId)
      // The final snapshot also reconciles updates that arrived near process close.
      setMoleBlocks(result.blocks)
      setMoleResult(result)
    } catch (error) {
      setMoleError(error instanceof Error ? error.message : 'Mole dry run 调用失败。')
    } finally {
      moleRunId.current = null
      setMoleTaskRequestId(null)
      setMoleStage(null)
      setMoleRunning(false)
    }
  }

  async function authorizeMoleSystem(): Promise<void> {
    const mole = window.api?.mole
    if (!mole || moleAuthorization === 'authorizing') return
    setMoleAuthorization('authorizing')
    setMoleError(null)
    setMoleActionMessage(null)
    try {
      const result = await mole.authorize()
      setMoleAuthorization(result.authorized ? 'authorized' : 'unknown')
      setMoleActionMessage('系统级权限已授权，正在重新生成 Clean 预览。')
      await runMoleDryRun()
    } catch (error) {
      setMoleAuthorization('unknown')
      setMoleError(error instanceof Error ? error.message : '系统级权限授权失败。')
    }
  }

  async function runMoleInstallerPreview(): Promise<void> {
    const mole = window.api?.mole
    if (!mole || !moleAvailable || moleRunId.current) return
    const runId = crypto.randomUUID()
    moleRunId.current = runId
    setMoleTaskRequestId(runId)
    setMoleRunning(true)
    setMoleResult(null)
    setMoleError(null)
    setMoleBlocks([])
    setMoleStage(null)
    setMoleMode('installer')
    setMoleSelectedPaths([])
    try {
      const result = await mole.installerPreview(runId)
      setMoleBlocks(result.blocks)
      setMoleResult(result)
    } catch (error) {
      setMoleError(error instanceof Error ? error.message : 'Mole 安装包预览调用失败。')
    } finally {
      moleRunId.current = null
      setMoleTaskRequestId(null)
      setMoleStage(null)
      setMoleRunning(false)
    }
  }

  async function loadMoleApps(): Promise<void> {
    const mole = window.api?.mole
    if (!mole) return
    setMoleMode('uninstall')
    setMoleError(null)
    setMoleActionMessage(null)
    setMoleSelectedPaths([])
    try {
      setMoleApps(await mole.uninstallList())
    } catch (error) {
      setMoleError(error instanceof Error ? error.message : 'Mole 应用清单调用失败。')
    }
  }

  async function runMolePurgePreview(): Promise<void> {
    const mole = window.api?.mole
    if (!mole || !moleAvailable || moleRunId.current) return
    const runId = crypto.randomUUID()
    moleRunId.current = runId
    setMoleTaskRequestId(runId)
    setMoleRunning(true)
    setMoleResult(null)
    setMoleError(null)
    setMoleBlocks([])
    setMoleStage(null)
    setMoleMode('purge')
    setMoleSelectedPaths([])
    try {
      const result = await mole.purgePreview(runId)
      setMoleBlocks(result.blocks)
      setMoleResult(result)
    } catch (error) {
      setMoleError(error instanceof Error ? error.message : 'Mole 开发产物预览调用失败。')
    } finally {
      moleRunId.current = null
      setMoleTaskRequestId(null)
      setMoleStage(null)
      setMoleRunning(false)
    }
  }

  async function runMoleAnalyze(): Promise<void> {
    const mole = window.api?.mole
    if (!mole) return
    setMoleMode('analyze')
    setMoleError(null)
    setMoleActionMessage(null)
    try {
      setMoleAnalyzeResult((await mole.analyze()).report)
    } catch (error) {
      setMoleError(error instanceof Error ? error.message : 'Mole 占用分析调用失败。')
    }
  }

  function toggleMolePath(path: string): void {
    setMoleSelectedPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
    )
  }

  async function trashSelectedMolePaths(): Promise<void> {
    const mole = window.api?.mole
    if (!mole || moleSelectedPaths.length === 0) return
    setMoleError(null)
    setMoleActionMessage(null)
    try {
      const result = await mole.trash(moleSelectedPaths)
      setMoleSelectedPaths([])
      setMoleActionMessage(`已移入回收站 ${String(result.completed.length)} 项。`)
      if (moleMode === 'clean') await runMoleDryRun()
      if (moleMode === 'installer') await runMoleInstallerPreview()
      if (moleMode === 'purge') await runMolePurgePreview()
      if (moleMode === 'uninstall') await loadMoleApps()
    } catch (error) {
      setMoleError(error instanceof Error ? error.message : '移入回收站失败。')
    }
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
          <span className="muted">
            {activePage === 'documents'
              ? '文档压缩与重复检测'
              : activePage === 'compression'
                ? '压缩'
                : activePage === 'toolbox'
                  ? '工具箱'
                  : activePage === 'archive'
                    ? '我的归档'
                    : activePage === 'video'
                      ? '视频压缩'
                      : activePage === 'image'
                        ? '图片压缩'
                        : '工作空间'}
          </span>
        </div>
        <span className="preview-badge">
          <span />
          {activePage === 'documents'
            ? '本地文档处理'
            : activePage === 'compression'
              ? '本地压缩'
              : activePage === 'toolbox'
                ? '本地文件工具'
                : activePage === 'video'
                  ? '本地视频处理'
                  : activePage === 'image'
                    ? '本地图片处理'
                    : agentStatus?.configured
                      ? 'Pi 对话'
                      : '待配置模型'}
        </span>
        <div className="theme-switcher" aria-label="日间与夜间主题">
          <button
            type="button"
            className={theme === 'day' ? 'active' : ''}
            aria-pressed={theme === 'day'}
            title="日间模式"
            onClick={() => {
              setTheme('day')
            }}
          >
            <Sun size={13} />
            <span>日间</span>
          </button>
          <button
            type="button"
            className={theme === 'night' ? 'active' : ''}
            aria-pressed={theme === 'night'}
            title="夜间模式"
            onClick={() => {
              setTheme('night')
            }}
          >
            <Moon size={13} />
            <span>夜间</span>
          </button>
        </div>
      </header>
      <div className="workspace">
        <nav className="icon-rail" aria-label="主导航">
          <button
            className="brand-mark"
            title="Agent"
            aria-label="Agent"
            aria-current={activePage === 'chat' ? 'page' : undefined}
            onClick={() => {
              setActivePage('chat')
            }}
          >
            <Archive size={23} strokeWidth={1.6} />
          </button>
          <div className="rail-divider" />
          <button
            className={`rail-button ${activePage === 'compression' ? 'active' : ''}`}
            title="压缩"
            aria-label="压缩"
            aria-controls="compression-page"
            aria-current={activePage === 'compression' ? 'page' : undefined}
            onClick={() => {
              setActivePage('compression')
            }}
          >
            <Shrink size={21} strokeWidth={1.6} />
          </button>
          <button
            hidden
            type="button"
            aria-label="视频压缩"
            onClick={() => {
              setActivePage('video')
            }}
          />
          <button
            hidden
            type="button"
            aria-label="图片压缩"
            onClick={() => {
              setActivePage('image')
            }}
          />
          <button
            className={`rail-button ${activePage === 'archive' ? 'active' : ''}`}
            title="我的归档"
            aria-label="我的归档"
            aria-current={activePage === 'archive' ? 'page' : undefined}
            onClick={() => {
              setActivePage('archive')
            }}
          >
            <Archive size={21} strokeWidth={1.6} />
          </button>
          <button
            className={`rail-button ${activePage === 'toolbox' ? 'active' : ''}`}
            title="工具箱"
            aria-label="工具箱"
            aria-current={activePage === 'toolbox' ? 'page' : undefined}
            onClick={() => {
              setActivePage('toolbox')
            }}
          >
            <Wrench size={21} strokeWidth={1.6} />
          </button>
          <div className="rail-bottom">
            <span className="profile-mark" title="本地工作空间">
              H
            </span>
          </div>
        </nav>
        {activePage === 'chat' && leftOpen && (
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
        <main className="chat-main" hidden={activePage !== 'chat'}>
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
        <main id="video-compression-page" className="video-main" hidden={activePage !== 'video'}>
          <VideoCompressionPage />
        </main>
        <main id="image-compression-page" className="image-main" hidden={activePage !== 'image'}>
          <ImageCompressionPage />
        </main>
        <main className="archive-main" id="archive-page" hidden={activePage !== 'archive'}>
          <ArchivePage />
        </main>
        <main className="documents-main" id="documents-page" hidden={activePage !== 'documents'}>
          <DocumentCompressionPage />
        </main>
        <main
          className="compression-main"
          id="compression-page"
          hidden={activePage !== 'compression'}
        >
          <CompressionPage />
        </main>
        <main className="toolbox-main" id="toolbox-page" hidden={activePage !== 'toolbox'}>
          <ToolboxPage />
        </main>
        {activePage === 'chat' && rightOpen && (
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
                  当前已接入 Pi 文件工具<small>支持文件操作与压缩；归档可在压缩结果页完成</small>
                </p>
              </div>
              <section className="mole-demo">
                <div className="section-eyebrow">Mole 受控操作</div>
                <h3>先预览，再选择处理</h3>
                <p>Agent 和按钮都先拿到候选清单；移入回收站只处理你勾选并确认的项目。</p>
                <div className="mole-authorization">
                  <button
                    className="mole-action-button"
                    onClick={() => void authorizeMoleSystem()}
                    disabled={!moleAvailable || moleAuthorization === 'authorizing'}
                  >
                    {moleAuthorization === 'authorizing'
                      ? '等待系统授权…'
                      : moleAuthorization === 'authorized'
                        ? '已授权系统级清理'
                        : '授权系统级清理'}
                  </button>
                  <small>只在需要检查系统缓存时授权；密码由 macOS 原生对话框处理。</small>
                </div>
                <div className="mole-tabs" role="tablist" aria-label="Mole 功能">
                  <button
                    className={moleMode === 'clean' ? 'active' : ''}
                    onClick={() => void runMoleDryRun()}
                    disabled={moleRunning || !moleAvailable}
                  >
                    Clean
                  </button>
                  <button
                    className={moleMode === 'analyze' ? 'active' : ''}
                    onClick={() => void runMoleAnalyze()}
                    disabled={moleRunning || !moleAvailable}
                  >
                    Analyze
                  </button>
                  <button
                    className={moleMode === 'installer' ? 'active' : ''}
                    onClick={() => void runMoleInstallerPreview()}
                    disabled={moleRunning || !moleAvailable}
                  >
                    Installer
                  </button>
                  <button
                    className={moleMode === 'purge' ? 'active' : ''}
                    onClick={() => void runMolePurgePreview()}
                    disabled={moleRunning || !moleAvailable}
                  >
                    Purge
                  </button>
                  <button
                    className={moleMode === 'uninstall' ? 'active' : ''}
                    onClick={() => void loadMoleApps()}
                    disabled={moleRunning || !moleAvailable}
                  >
                    Uninstall
                  </button>
                </div>
                {window.api?.mole && !moleAvailable && <p>请重启 Electron，以加载分段预览功能。</p>}
                {moleRunning && (
                  <p role="status">
                    {compressionTaskMessage(moleTask) ??
                      (moleStage ? `当前阶段：${moleStage}` : '任务已提交，等待执行…')}
                    {` · 已收到 ${String(moleBlocks.length)} 段`}
                  </p>
                )}
                {moleError && <p className="mole-demo-error">{moleError}</p>}
                {moleActionMessage && <p className="mole-demo-result">{moleActionMessage}</p>}
                {moleMode === 'analyze' && Boolean(moleAnalyzeResult) && (
                  <pre className="mole-analyze-output">
                    {JSON.stringify(moleAnalyzeResult, null, 2)}
                  </pre>
                )}
                {moleResult && (
                  <p className="mole-demo-result" role="status">
                    {moleResult.kind === 'clean'
                      ? 'Clean 预览已结束，未执行清理。'
                      : moleResult.kind === 'installer'
                        ? '安装包预览已结束，未执行清理。'
                        : '开发产物预览已结束，未执行清理。'}
                  </p>
                )}
                {(moleResult?.stdoutTruncated || moleResult?.stderrTruncated) && (
                  <p className="mole-demo-error">输出较长，已达到保留上限，以下为部分日志。</p>
                )}
                {moleBlocks.length > 0 && (
                  <div className="mole-output" aria-label="Mole 分段输出">
                    {moleBlocks.map((block) => (
                      <details key={block.id} className="mole-output-block" open>
                        <summary>
                          {block.title}
                          {block.continued && '（续）'}
                          {block.partial && ' · 内容可能不完整'}
                        </summary>
                        <pre>{block.text}</pre>
                      </details>
                    ))}
                  </div>
                )}
                {moleResult && moleResult.candidates.length > 0 && (
                  <div className="mole-candidates" aria-label="Mole 候选清单">
                    {moleResult.candidates.map((candidate: MoleCandidate) => (
                      <label key={candidate.path} className="mole-candidate">
                        <input
                          type="checkbox"
                          checked={moleSelectedPaths.includes(candidate.path)}
                          onChange={() => {
                            toggleMolePath(candidate.path)
                          }}
                        />
                        <span>
                          <strong>{candidate.name}</strong>
                          <small>{candidate.path}</small>
                        </span>
                        <em>
                          {candidate.sizeText ?? candidate.source ?? candidate.category ?? ''}
                        </em>
                      </label>
                    ))}
                    {moleMode === 'purge' && (
                      <p className="mole-demo-note">
                        这些目录通常可由项目重新生成，但可能需要联网重新安装依赖或重新构建；清理前请单独确认。
                      </p>
                    )}
                    <button
                      className="mole-action-button"
                      onClick={() => void trashSelectedMolePaths()}
                      disabled={moleSelectedPaths.length === 0}
                    >
                      将已选项目移入回收站（{String(moleSelectedPaths.length)}）
                    </button>
                  </div>
                )}
                {moleMode === 'uninstall' && moleApps.length > 0 && (
                  <div className="mole-candidates" aria-label="已安装应用清单">
                    {moleApps.map((app: MoleInstalledApp) => (
                      <label key={`${app.path}:${app.bundleId}`} className="mole-candidate">
                        <input
                          type="checkbox"
                          checked={moleSelectedPaths.includes(app.path)}
                          onChange={() => {
                            toggleMolePath(app.path)
                          }}
                        />
                        <span>
                          <strong>{app.name}</strong>
                          <small>{app.path}</small>
                        </span>
                        <em>{app.size}</em>
                      </label>
                    ))}
                    <button
                      className="mole-action-button"
                      onClick={() => void trashSelectedMolePaths()}
                      disabled={moleSelectedPaths.length === 0}
                    >
                      将选中 App 移入回收站（{String(moleSelectedPaths.length)}）
                    </button>
                    <p className="mole-demo-note">
                      移除 App 后可回到 Clean 预览关联残留；个人数据不会由此按钮自动删除。
                    </p>
                  </div>
                )}
              </section>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

export default App
