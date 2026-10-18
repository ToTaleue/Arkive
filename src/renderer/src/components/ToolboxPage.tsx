import { useState } from 'react'
import { AppWindow, ChartNoAxesCombined, CopyCheck, FolderCode, Package } from 'lucide-react'
import { DuplicateTool } from './DuplicateTool'
import { MoleAnalyzeTool } from './MoleAnalyzeTool'
import { MoleSelectionTool } from './MoleSelectionTool'
import '../assets/toolbox.css'
import '../assets/mole-toolbox.css'

const tools = [
  {
    id: 'analyze',
    name: '空间分析',
    engine: 'Mole Analyze',
    icon: ChartNoAxesCombined,
    description: '查看空间分布，逐层定位大文件与大目录。'
  },
  {
    id: 'purge',
    name: '项目瘦身',
    engine: 'Mole Purge',
    icon: FolderCode,
    description: '按项目整理依赖与构建产物，源码保留。'
  },
  {
    id: 'uninstall',
    name: '应用卸载',
    engine: 'Mole Uninstall',
    icon: AppWindow,
    description: '先检查应用本体，再查看关联缓存与数据。'
  },
  {
    id: 'installer',
    name: '安装包清理',
    engine: 'Mole Installer',
    icon: Package,
    description: '找出散落在各处的安装包，选择后处理。'
  },
  {
    id: 'dedup',
    name: '无损去重',
    engine: 'macOS · APFS',
    icon: CopyCheck,
    description: '重复内容共享存储，保留每份文件的位置与内容。'
  }
] as const

type Tool = 'home' | (typeof tools)[number]['id']

export function ToolboxPage({
  onInspectWithAgent
}: {
  onInspectWithAgent: (prompt: string, title: string) => void
}): React.JSX.Element {
  const [tool, setTool] = useState<Tool>('home')
  return (
    <div className="toolbox-page">
      <div className="toolbox-content">
        <nav className="toolbox-navigation" aria-label="工具切换">
          <button
            aria-current={tool === 'home' ? 'page' : undefined}
            onClick={() => {
              setTool('home')
            }}
          >
            工具箱
          </button>
          {tools.map((item) => (
            <button
              key={item.id}
              aria-current={tool === item.id ? 'page' : undefined}
              onClick={() => {
                setTool(item.id)
              }}
            >
              <item.icon size={14} />
              {item.name}
            </button>
          ))}
        </nav>
        <section hidden={tool !== 'home'} aria-label="工具箱首页">
          <header className="toolbox-heading">
            <div>
              <p className="toolbox-eyebrow">ARKIVE / 工具箱</p>
              <h1>工具箱</h1>
              <p>按需整理文件，让空间更好用。</p>
            </div>
          </header>
          <div className="toolbox-card-grid">
            {tools.map((item) => (
              <button
                className="tool-card"
                key={item.id}
                onClick={() => {
                  setTool(item.id)
                }}
              >
                <span className="tool-card-icon">
                  <item.icon size={24} />
                </span>
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <span className="tool-card-meta">
                  <span>{item.engine}</span>
                  <b>打开工具 →</b>
                </span>
              </button>
            ))}
          </div>
        </section>
        <div hidden={tool !== 'analyze'}>
          <MoleAnalyzeTool onInspectWithAgent={onInspectWithAgent} />
        </div>
        <div hidden={tool !== 'purge'}>
          <MoleSelectionTool kind="purge" active={tool === 'purge'} />
        </div>
        <div hidden={tool !== 'uninstall'}>
          <MoleSelectionTool kind="uninstall" active={tool === 'uninstall'} />
        </div>
        <div hidden={tool !== 'installer'}>
          <MoleSelectionTool kind="installer" active={tool === 'installer'} />
        </div>
        <div hidden={tool !== 'dedup'}>
          <DuplicateTool />
        </div>
      </div>
    </div>
  )
}
