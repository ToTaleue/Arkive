import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow, FolderCode, Package, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type {
  MoleInstalledApp,
  MoleOutputBlock,
  MoleSelectionCandidate,
  MoleSelectionKind,
  MoleSelectionResult,
  MoleUninstallPreview
} from '../../../shared/contracts/mole'
import { candidateBytes, formatMoleSize, selectionCandidates } from './mole-view'
import { useMoleToolRun } from './useMoleToolRun'
import { MoleToolFeedback, MoleToolHeading, MoleToolHero, MoleToolLogs } from './MoleToolShared'

type Preview = {
  id?: string
  candidates: MoleSelectionCandidate[]
  warnings: string[]
  reviewOnly: MoleUninstallPreview['reviewOnly']
  blocks?: MoleOutputBlock[]
  diagnostics?: string[]
}
const descriptions = {
  purge: { name: '项目瘦身', engine: 'Purge', description: '按项目整理依赖与构建产物，源码保留。' },
  installer: {
    name: '安装包清理',
    engine: 'Installer',
    description: '找出散落在各处的安装包，选择后处理。'
  },
  uninstall: {
    name: '应用卸载',
    engine: 'Uninstall',
    description: '先检查应用本体，再查看关联缓存与数据。'
  }
}
const roleNames = {
  app: '应用本体',
  cache: '应用缓存',
  log: '应用日志',
  'app-data': '应用数据，默认保留'
}

export function MoleSelectionTool({
  kind,
  active
}: {
  kind: MoleSelectionKind
  active: boolean
}): React.JSX.Element {
  const api = window.api?.mole
  const available = typeof api?.toolboxPreview === 'function'
  const run = useMoleToolRun()
  const startRun = run.run
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<MoleSelectionResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [apps, setApps] = useState<MoleInstalledApp[]>([])
  const [appPath, setAppPath] = useState('')
  const [search, setSearch] = useState('')
  const initialized = useRef(false)
  const description = descriptions[kind]
  const diagnostics = [
    ...new Set([...(preview?.diagnostics ?? []), ...(result?.diagnostics ?? [])])
  ]
  const warnings = [
    ...new Set(
      [...(preview?.warnings ?? []), ...(result?.warnings ?? [])]
        .filter((warning) => !warning.startsWith('仅将所选应用与关联文件移入回收站；'))
        .map((warning) =>
          warning.includes('Shared leftovers kept (some paths unreadable)') ||
          warning.includes('Shared leftovers kept (other copies unchecked)')
            ? diagnostics.some((line) => line.includes('Sibling package receipt scan timed out'))
              ? '安装收据检查超时，无法确认是否存在其他应用副本。本次仅处理应用本体，关联数据保留。'
              : '副本检查未完成，无法确认是否存在其他应用副本。本次仅处理应用本体，关联数据保留。'
            : warning
        )
    )
  ]
  const app = apps.find((item) => item.path === appPath)
  const selectedItems = preview?.candidates.filter((item) => selected.includes(item.id)) ?? []
  const knownSizes = selectedItems.map(candidateBytes)
  const sizeTotal = knownSizes.reduce<number>((total, value) => total + (value ?? 0), 0)
  const sizeUnknown = knownSizes.some((value) => value === null)
  const selectionSize = !selectedItems.length
    ? '0 B'
    : sizeUnknown
      ? sizeTotal > 0
        ? `至少 ${formatMoleSize(sizeTotal)}`
        : '容量未统计'
      : formatMoleSize(sizeTotal)

  const loadApps = useCallback(async (): Promise<void> => {
    if (!api) return
    setPreview(null)
    setResult(null)
    setSelected([])
    setConfirming(false)
    const items = await startRun((id) => api.toolboxApps(id))
    if (items) {
      setApps(items)
      setAppPath((current) =>
        items.some((item) => item.path === current) ? current : (items[0]?.path ?? '')
      )
    }
  }, [api, startRun])
  useEffect(() => {
    if (active && available && kind === 'uninstall' && !initialized.current) {
      initialized.current = true
      void loadApps()
    }
  }, [active, available, kind, loadApps])

  async function scan(): Promise<void> {
    if (!api || !available || run.busy || (kind === 'uninstall' && !app)) return
    setPreview(null)
    setResult(null)
    setSelected([])
    setConfirming(false)
    const outcome = await run.run(async (id): Promise<Preview> => {
      if (kind === 'uninstall') {
        const output = await api.uninstallPreview(id, [appPath])
        return {
          id: output.previewId,
          candidates: output.candidates,
          warnings: output.warnings,
          reviewOnly: output.reviewOnly,
          diagnostics: output.diagnostics
        }
      }
      const output = await api.toolboxPreview(id, kind)
      return {
        id: output.previewId,
        candidates: selectionCandidates(output),
        warnings: output.previewId ? [] : ['本次预览不完整，仅供查看。请重新扫描后再选择处理。'],
        reviewOnly: [],
        blocks: output.blocks
      }
    })
    if (outcome) {
      setPreview(outcome)
      setSelected(
        outcome.id
          ? outcome.candidates
              .filter((item) => item.suggested && !item.unavailableReason)
              .slice(0, 100)
              .map((item) => item.id)
          : []
      )
    }
  }
  async function execute(): Promise<void> {
    if (!api || !preview?.id || !selected.length || run.busy || result) return
    const previewId = preview.id
    setConfirming(false)
    const outcome = await run.run((id) =>
      api.executeSelection(id, kind, { previewId, candidateIds: selected })
    )
    if (outcome) setResult(outcome)
    else {
      // IPC failures may happen after a partial write; consume the UI plan and require a fresh scan.
      setPreview((current) =>
        current
          ? {
              ...current,
              id: undefined,
              warnings: [...current.warnings, '处理结果未能完整返回，请检查运行记录并重新预览。']
            }
          : null
      )
    }
  }
  function toggle(id: string): void {
    setConfirming(false)
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length < 100
          ? [...current, id]
          : current
    )
  }
  function row(item: MoleSelectionCandidate): React.JSX.Element {
    const bytes = candidateBytes(item)
    const status = result
      ? result.completed.includes(item.path)
        ? '已移入回收站'
        : result.failed.some((failure) => failure.path === item.path)
          ? '处理失败'
          : result.unprocessed.includes(item.path)
            ? '未处理'
            : '保留'
      : ''
    return (
      <div className="mole-candidate-row" key={item.id}>
        <label>
          <input
            type="checkbox"
            aria-label={`选择 ${item.path}`}
            checked={selected.includes(item.id)}
            disabled={
              run.busy ||
              Boolean(result) ||
              !preview?.id ||
              Boolean(item.unavailableReason) ||
              (!selected.includes(item.id) && selected.length >= 100)
            }
            onChange={() => {
              toggle(item.id)
            }}
          />
          <span>
            <strong>{item.name}</strong>
            <small>{item.path}</small>
            <small>
              {item.unavailableReason ??
                (item.role
                  ? roleNames[item.role]
                  : kind === 'purge'
                    ? '可重建产物 · 活动时间未提供'
                    : (item.source ?? '安装包'))}
            </small>
          </span>
        </label>
        <div className="mole-candidate-meta">
          <span className="mole-tool-size">
            {bytes === null ? (item.sizeText ?? '容量未统计') : formatMoleSize(bytes)}
          </span>
          {status && <small>{status}</small>}
          <button
            className="mole-candidate-reveal"
            disabled={run.busy}
            onClick={() => void run.reveal(item.path)}
          >
            定位
          </button>
        </div>
      </div>
    )
  }
  const groups = new Map<string, MoleSelectionCandidate[]>()
  preview?.candidates.forEach((item) => {
    const project = item.path.slice(0, item.path.lastIndexOf('/')) || '/'
    groups.set(project, [...(groups.get(project) ?? []), item])
  })
  const completedSize = result
    ? (preview?.candidates
        .filter((item) => result.completed.includes(item.path))
        .map(candidateBytes) ?? [])
    : []
  const completedBytes = completedSize.reduce<number>((total, value) => total + (value ?? 0), 0)
  const candidateList = preview && (
    <>
      {kind === 'purge' ? (
        [...groups].map(([project, items]) => (
          <section className="mole-project" key={project}>
            <header>
              <FolderCode size={17} />
              <div>
                <strong>{project.split('/').pop() || project}</strong>
                <small>{project}</small>
              </div>
            </header>
            {items.map(row)}
          </section>
        ))
      ) : (
        <section className="mole-project">{preview.candidates.map(row)}</section>
      )}
      {!preview.candidates.length && <p className="mole-tool-note">本次没有可处理的候选项目。</p>}
      {preview.reviewOnly.length > 0 && (
        <section className="mole-review-only">
          <h3>
            <ShieldCheck size={15} />
            仅供审阅的残留
          </h3>
          {preview.reviewOnly.map((item) => (
            <p key={item.path}>{item.path}</p>
          ))}
        </section>
      )}
      {kind === 'uninstall' && (
        <p className="mole-tool-note">
          <ShieldCheck size={14} />
          仅将所选文件移入回收站；不运行 Homebrew 卸载
          Hook、不卸载系统扩展、不终止应用进程。系统级残留仅供审阅。
        </p>
      )}
      {warnings.map((warning) => (
        <p className="mole-tool-warning" key={warning}>
          {warning}
        </p>
      ))}
      {kind === 'uninstall' && diagnostics.length > 0 && (
        <details className="mole-tool-logs mole-inspection-details">
          <summary>检查详情 · 原因与路径</summary>
          {diagnostics.some((line) => line.includes('Sibling package receipt scan timed out')) && (
            <p className="mole-tool-note">安装收据检查超时；这条记录没有报告具体不可读路径。</p>
          )}
          {diagnostics.map((line) => (
            <pre key={line}>{line}</pre>
          ))}
        </details>
      )}
      {result?.failed.map((failure) => (
        <p className="mole-tool-error" key={failure.path}>
          {failure.path}：{failure.error}
        </p>
      ))}
      <footer className="mole-selection-footer">
        <div>
          {result
            ? `已移入回收站 ${String(result.completed.length)} 项 · 失败 ${String(result.failed.length)} 项 · 未处理 ${String(result.unprocessed.length)} 项`
            : `已选 ${String(selected.length)} 项 · 预计文件容量 ${selectionSize}`}
          <small>
            {kind === 'purge'
              ? '恢复产物可能需要联网安装依赖或重新构建。'
              : '移入回收站后，磁盘空间可能尚未释放。'}
          </small>
        </div>
        {!result && (
          <button
            className="mole-tool-button primary"
            disabled={!preview.id || !selected.length || run.busy}
            onClick={() => {
              setConfirming(true)
            }}
          >
            <Trash2 size={14} />
            {kind === 'uninstall' ? '确认卸载…' : '移入回收站…'}
          </button>
        )}
      </footer>
      {selected.length >= 100 && !result && (
        <p className="mole-tool-note">每批最多处理 100 项，其余项目可重新预览后处理。</p>
      )}
      {confirming && !run.busy && (
        <section className="mole-selection-confirm" role="region" aria-label="确认处理所选文件">
          <h3>将以下 {selected.length} 项移入回收站？</h3>
          <p>仅处理本次选择的文件。应用数据、偏好设置等内容以以下清单为准。</p>
          <ul>
            {selectedItems.map((item) => (
              <li key={item.id}>
                {item.path}
                {item.role === 'app-data' && <strong> · 应用数据</strong>}
              </li>
            ))}
          </ul>
          <div>
            <button
              className="mole-tool-button"
              onClick={() => {
                setConfirming(false)
              }}
            >
              返回调整
            </button>
            <button className="mole-tool-button primary" onClick={() => void execute()}>
              确认移入回收站
            </button>
          </div>
        </section>
      )}
    </>
  )
  return (
    <section className="mole-tool-page" aria-label={description.name}>
      <MoleToolHeading title={description.name} engine={description.engine}>
        {description.description}
      </MoleToolHeading>
      <div className="mole-tool-scope">
        {kind === 'uninstall' ? (
          <button
            className="mole-tool-button"
            disabled={!available || run.busy}
            onClick={() => void loadApps()}
          >
            <RefreshCw size={14} />
            刷新应用清单
          </button>
        ) : (
          <>
            <span>
              {kind === 'purge'
                ? '扫描 Mole 已配置的项目目录'
                : '扫描 Downloads、Desktop 等 Mole 支持的位置'}
            </span>
            <button
              className="mole-tool-button"
              disabled={!available || run.busy}
              onClick={() => void scan()}
            >
              <RefreshCw size={14} />
              {preview ? '重新扫描' : '开始扫描'}
            </button>
          </>
        )}
      </div>
      <MoleToolFeedback run={run} />
      {result ? (
        <MoleToolHero
          warning={result.status !== 'completed'}
          title={
            result.status === 'completed'
              ? '处理已完成'
              : result.status === 'cancelled'
                ? '处理已停止'
                : '部分项目未完成'
          }
          label="已移入回收站"
          value={`${String(result.completed.length)} 项`}
        >
          {completedSize.length && completedSize.every((value) => value !== null)
            ? `已处理文件容量 ${formatMoleSize(completedBytes)} · `
            : ''}
          移入回收站不等于空间已释放，请逐项查看结果。
        </MoleToolHero>
      ) : (
        preview && (
          <MoleToolHero
            warning={!preview.id}
            title={preview.id ? '预览已完成' : '预览结果不完整'}
            label={kind === 'uninstall' ? '应用及关联文件' : '发现候选项目'}
            value={`${String(preview.candidates.length)} 项`}
          >
            本次仅预览，未执行删除。
          </MoleToolHero>
        )
      )}
      {kind === 'purge' && preview && (
        <p className="mole-tool-warning">
          当前预览未提供可靠的活动时间，构建产物默认不勾选。请确认项目近期不需要这些产物后再选择。
        </p>
      )}
      {kind === 'uninstall' ? (
        <div className="mole-uninstall-layout">
          <aside className="mole-app-list">
            <input
              aria-label="搜索应用"
              placeholder="搜索应用"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
            />
            {apps
              .filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((item) => (
                <button
                  className={`mole-app ${item.path === appPath ? 'active' : ''}`}
                  key={item.path}
                  disabled={run.busy}
                  onClick={() => {
                    setAppPath(item.path)
                    setPreview(null)
                    setResult(null)
                    setSelected([])
                    setConfirming(false)
                  }}
                >
                  <AppWindow size={24} />
                  <span>
                    {item.name}
                    <small>
                      {item.size} · {item.source}
                    </small>
                  </span>
                </button>
              ))}
            {!apps.length && !run.busy && (
              <p className="mole-tool-note">未取得可展示的应用。可刷新清单重试。</p>
            )}
          </aside>
          <div className="mole-app-detail">
            {app && (
              <>
                <h2>{app.name}</h2>
                <p className="mole-tool-note">{app.bundleId}</p>
                <p className="mole-app-path">{app.path}</p>
                <button
                  className="mole-tool-button"
                  disabled={run.busy}
                  onClick={() => void scan()}
                >
                  检查关联文件
                </button>
              </>
            )}
            {preview && (
              <p className="mole-tool-note">
                应用数据和偏好设置默认保留；勾选后才会加入本次确认清单。
                {!result && '请先退出待卸载应用。'}
              </p>
            )}
            {candidateList}
          </div>
        </div>
      ) : preview ? (
        candidateList
      ) : (
        !run.busy && (
          <div className="mole-tool-empty">
            {kind === 'purge' ? (
              <FolderCode size={38} strokeWidth={1.3} />
            ) : (
              <Package size={38} strokeWidth={1.3} />
            )}
            <h2>{kind === 'purge' ? '先看看项目能瘦身多少' : '先找出散落的安装包'}</h2>
            <p>扫描不会删除文件，完成后可逐项选择。</p>
          </div>
        )
      )}
      <MoleToolLogs
        blocks={run.busy ? run.blocks : (preview?.blocks ?? run.blocks)}
        text={result ? JSON.stringify(result, null, 2) : undefined}
      />
      {!available && (
        <p className="mole-tool-warning">请重启 Electron 桌面应用以加载工具箱功能。</p>
      )}
    </section>
  )
}
