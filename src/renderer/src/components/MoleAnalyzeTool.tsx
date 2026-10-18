import { useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { readAnalyzeReport, formatMoleSize, type AnalyzeReport } from './mole-view'
import { useMoleToolRun } from './useMoleToolRun'
import { MoleToolFeedback, MoleToolHeading, MoleToolHero, MoleToolLogs } from './MoleToolShared'

export function MoleAnalyzeTool(): React.JSX.Element {
  const api = window.api?.mole
  const available = Boolean(api?.toolboxAnalyze)
  const run = useMoleToolRun()
  const [report, setReport] = useState<AnalyzeReport | null>(null)
  const [view, setView] = useState<'folders' | 'large'>('folders')
  const [diagnostics, setDiagnostics] = useState('')
  async function analyze(path?: string): Promise<void> {
    if (!api || !available || run.busy) return
    setReport(null)
    setDiagnostics('')
    const result = await run.run(async (id) => {
      const output = await api.toolboxAnalyze(id, path)
      return {
        report: readAnalyzeReport(output.report),
        diagnostics: `${output.stderr}${output.stderrTruncated ? '\n诊断输出已截断。' : ''}`
      }
    })
    if (result) {
      setReport(result.report)
      setDiagnostics(result.diagnostics)
    }
  }
  async function chooseFolder(): Promise<void> {
    const path = await window.api?.processing.selectFolder()
    if (path) await analyze(path)
  }
  const entries = report ? (view === 'folders' ? report.entries : report.largeFiles) : []
  const maxSize = entries.reduce((largest, entry) => Math.max(largest, entry.size ?? 0), 1)
  const parts = report?.path.split('/').filter(Boolean) ?? []
  return (
    <section className="mole-tool-page" aria-label="空间分析">
      <MoleToolHeading title="空间分析" engine="Analyze">
        查看空间分布，逐层定位大文件与大目录。
      </MoleToolHeading>
      <div className="mole-tool-scope">
        <button
          className="mole-tool-button"
          disabled={!available || run.busy}
          onClick={() => void chooseFolder()}
        >
          <FolderOpen size={15} />
          选择文件夹
        </button>
        <button
          className="mole-tool-button"
          disabled={!available || run.busy}
          onClick={() => void analyze(report?.path)}
        >
          <RefreshCw size={14} />
          {report ? '重新分析' : '分析用户目录'}
        </button>
      </div>
      <MoleToolFeedback run={run} />
      {!report && !run.busy && (
        <div className="mole-tool-empty">
          <FolderOpen size={38} strokeWidth={1.3} />
          <h2>先选一个分析位置</h2>
          <p>只读分析，不会自动删除文件。</p>
        </div>
      )}
      {report && (
        <>
          <MoleToolHero
            warning={report.status !== 'complete'}
            title={report.status === 'complete' ? '分析已完成' : '分析结果不完整'}
            label="当前已统计"
            value={
              report.totalSize === null
                ? '容量未知'
                : `${report.status === 'partial' ? '至少 ' : ''}${formatMoleSize(report.totalSize)}`
            }
          >
            {report.totalFiles === null
              ? '文件数量未提供'
              : `已统计 ${report.totalFiles.toLocaleString()} 个文件`}{' '}
            · 只读查看
          </MoleToolHero>
          {report.status !== 'complete' && (
            <p className="mole-tool-warning">
              部分目录未能完整读取；已统计容量不代表全部占用，未知容量不等于零。
            </p>
          )}
          <nav className="mole-tool-breadcrumb" aria-label="分析路径">
            <button disabled={run.busy} onClick={() => void analyze('/')}>
              /
            </button>
            {parts.map((part, index) => (
              <span key={index}>
                <ChevronRight size={12} />
                <button
                  disabled={run.busy}
                  onClick={() => void analyze(`/${parts.slice(0, index + 1).join('/')}`)}
                >
                  {part}
                </button>
              </span>
            ))}
          </nav>
          <div className="mole-tool-view-switch" role="group" aria-label="分析视图">
            <button
              aria-pressed={view === 'folders'}
              onClick={() => {
                setView('folders')
              }}
            >
              目录占用
            </button>
            <button
              aria-pressed={view === 'large'}
              onClick={() => {
                setView('large')
              }}
            >
              大文件
            </button>
          </div>
          <div className="mole-analysis-list">
            {entries.map((entry) => (
              <div className="mole-analysis-row" key={entry.path}>
                {entry.isDir ? <Folder size={17} /> : <File size={17} />}
                <div className="mole-analysis-name">
                  {entry.isDir ? (
                    <button disabled={run.busy} onClick={() => void analyze(entry.path)}>
                      {entry.name}
                    </button>
                  ) : (
                    <strong>{entry.name}</strong>
                  )}
                  <small>{entry.path}</small>
                </div>
                <div className="mole-analysis-bar" aria-hidden="true">
                  {entry.size !== null && (
                    <span
                      style={{ width: `${String(Math.max(1, (entry.size / maxSize) * 100))}%` }}
                    />
                  )}
                </div>
                <span className="mole-tool-size">
                  {entry.size === null
                    ? '未知'
                    : `${entry.status === 'partial' ? '至少 ' : ''}${formatMoleSize(entry.size)}`}
                </span>
                <button
                  className="mole-tool-button mole-reveal"
                  disabled={run.busy}
                  onClick={() => void run.reveal(entry.path)}
                >
                  定位
                </button>
              </div>
            ))}
            {!entries.length && (
              <p className="mole-tool-note">
                {report.status === 'complete'
                  ? view === 'large'
                    ? '此位置没有报告大文件。'
                    : '此位置没有报告子项。'
                  : '扫描不完整，暂未取得可展示的条目。'}
              </p>
            )}
          </div>
          <p className="mole-tool-note">大文件只表示占用较大，由你决定后续处理。</p>
        </>
      )}
      <MoleToolLogs text={diagnostics} />
      {!available && (
        <p className="mole-tool-warning">请重启 Electron 桌面应用以加载工具箱功能。</p>
      )}
    </section>
  )
}
