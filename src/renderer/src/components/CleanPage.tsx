import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BrushCleaning,
  Check,
  CircleAlert,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Play,
  ShieldCheck,
  Square,
  Trash2
} from 'lucide-react'
import type {
  MoleCleanMode,
  MoleCleanResult,
  MoleOutputBlock
} from '../../../shared/contracts/mole'
import { compressionTaskMessage, useCompressionTask } from '../hooks/useCompressionTask'
import '../assets/clean.css'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logTone(line: string): string {
  if (/\b(error|failed|failure|denied)\b|[✗✘]/i.test(line)) return 'error'
  if (/\b(skipped|warning|partial|unavailable)\b|[◎⚠]/i.test(line)) return 'warning'
  if (/^\s*[✓✔]/.test(line)) return 'success'
  return 'neutral'
}

function cleanSpace(result: MoleCleanResult): {
  value: string
  atLeast: boolean
  measured: boolean
} {
  // Use only Mole's final summary, never individual log sizes or the disk's free-space delta.
  const summary =
    result.output?.blocks
      .filter((block) => block.source === 'stdout' && block.kind === 'summary')
      .map((block) => block.text)
      .join('\n') ?? ''
  const pattern =
    result.mode === 'preview'
      ? /^\s*Potential space:\s*(At least\s+)?(\d+(?:\.\d+)?\s*[KMGTPE]?B)(?=\s*(?:\||$))/im
      : /^\s*Tracked cleanup:\s*(At least\s+)?(\d+(?:\.\d+)?\s*[KMGTPE]?B)(?=\s*(?:\||$))/im
  const match = pattern.exec(summary)
  if (match) {
    return {
      value: match[2].replace(/\s*([KMGTPE]?B)$/i, ' $1'),
      atLeast: Boolean(match[1]),
      measured: true
    }
  }
  const empty =
    result.mode === 'preview'
      ? /No (?:significant|additional) reclaimable space detected[.,]/i.test(summary)
      : /(?:System was already clean; no additional space freed|No additional space freed)\./i.test(
          summary
        )
  if (empty) return { value: '0 B', atLeast: false, measured: true }
  return {
    value: /Tracked cleanup:\s*Partially measured/i.test(summary) ? '容量未完整统计' : '容量未提供',
    atLeast: false,
    measured: false
  }
}

export function CleanPage(): React.JSX.Element {
  const api = window.api?.mole
  const available = Boolean(api && Object.hasOwn(api, 'clean'))
  const [authorization, setAuthorization] = useState<'unknown' | 'authorizing' | 'authorized'>(
    'unknown'
  )
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<MoleCleanMode>('preview')
  const [blocks, setBlocks] = useState<MoleOutputBlock[]>([])
  const [stage, setStage] = useState('')
  const [result, setResult] = useState<MoleCleanResult | null>(null)
  const [error, setError] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const runId = useRef<string | null>(null)
  const actionInFlight = useRef(false)
  const task = useCompressionTask(requestId)
  const authorizing = authorization === 'authorizing'
  const authorized = authorization === 'authorized'
  const disabled = !available || busy || authorizing

  useEffect(() => {
    if (!api || !available || busy || authorizing) return
    let disposed = false
    let revision = 0
    const refresh = (): void => {
      const current = ++revision
      void api.authorizationStatus().then(
        (status) => {
          if (!disposed && current === revision && !actionInFlight.current)
            setAuthorization(status.authorized ? 'authorized' : 'unknown')
        },
        () => {
          if (!disposed && current === revision && !actionInFlight.current)
            setAuthorization('unknown')
        }
      )
    }
    refresh()
    const interval = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [api, available, busy, authorizing])

  useEffect(() => {
    if (!api || !available) return
    return api.onUpdate((update) => {
      if (update.runId !== runId.current) return
      if (update.event.type === 'stage') setStage(update.event.title)
      else {
        const block = update.event.block
        setBlocks((current) => [...current, block])
      }
    })
  }, [api, available])

  const sections = useMemo(() => {
    const grouped: MoleOutputBlock[] = []
    for (const block of blocks) {
      const previous = grouped.at(-1)
      if (
        previous &&
        block.continued &&
        previous.title === block.title &&
        previous.source === block.source
      ) {
        previous.text += `\n${block.text}`
        previous.partial ||= block.partial
      } else grouped.push({ ...block })
    }
    return grouped
  }, [blocks])

  async function authorize(): Promise<void> {
    if (!api || disabled || actionInFlight.current) return
    actionInFlight.current = true
    setAuthorization('authorizing')
    setError('')
    try {
      const status = await api.authorize()
      setAuthorization(status.authorized ? 'authorized' : 'unknown')
    } catch (failure) {
      setAuthorization('unknown')
      setError(message(failure))
    } finally {
      actionInFlight.current = false
    }
  }

  async function run(nextMode: MoleCleanMode): Promise<void> {
    if (!api || disabled || actionInFlight.current) return
    actionInFlight.current = true
    const id = crypto.randomUUID()
    runId.current = id
    setRequestId(id)
    setMode(nextMode)
    setBusy(true)
    setError('')
    setResult(null)
    setBlocks([])
    setStage('')
    try {
      const outcome = await api.clean(id, nextMode)
      if (outcome.output) setBlocks(outcome.output.blocks)
      if (outcome.status === 'authorization-required') setAuthorization('unknown')
      setResult(outcome)
    } catch (failure) {
      setError(message(failure))
    } finally {
      runId.current = null
      actionInFlight.current = false
      setBusy(false)
    }
  }

  async function stop(): Promise<void> {
    if (!task || !window.api?.tasks) return
    try {
      await window.api.tasks.cancel(task.id)
    } catch (failure) {
      setError(message(failure))
    }
  }

  const completed = result?.status === 'completed'
  const space = completed ? cleanSpace(result) : null
  const statusText = busy
    ? compressionTaskMessage(task) || stage || '任务已提交，等待执行…'
    : completed
      ? mode === 'preview'
        ? '预览完成，未执行删除'
        : '清理完成'
      : result?.message || (error ? '运行未完成，请查看错误信息' : '准备就绪')

  return (
    <div className="clean-page">
      <div className="clean-content">
        <header className="clean-heading">
          <div>
            <p className="clean-eyebrow">ARKIVE / 清理</p>
            <h1>清理</h1>
            <p>释放被缓存、日志和临时文件占用的空间。</p>
          </div>
          <span className="clean-engine">
            <BrushCleaning size={14} /> Mole Clean
          </span>
        </header>

        <section className="clean-controls" aria-label="清理操作">
          <div className="clean-control-top">
            <span className="clean-hero-icon">
              {completed ? (
                <Check size={30} strokeWidth={1.5} />
              ) : (
                <BrushCleaning size={30} strokeWidth={1.5} />
              )}
            </span>
            <div className="clean-hero-copy" role="status" aria-live="polite">
              <h2>
                {completed
                  ? mode === 'preview'
                    ? '预览清理已完成'
                    : '清理已完成'
                  : busy
                    ? mode === 'preview'
                      ? '正在预览清理…'
                      : '正在清理…'
                    : authorized
                      ? '可以开始清理了'
                      : '先看看，有多少空间可以释放'}
              </h2>
              {space && (
                <div className="clean-result-space">
                  <span>{mode === 'preview' ? '可清理空间' : '本次已清理'}</span>
                  <strong className={`clean-result-value ${space.measured ? '' : 'unavailable'}`}>
                    {space.atLeast && <small>至少</small>}
                    {space.value}
                  </strong>
                </div>
              )}
              <p>
                {space
                  ? `${mode === 'preview' ? '本次仅预览，未删除任何文件。' : '本次清理已结束。'}${space.atLeast || !space.measured ? '容量未完整统计，详情见下方运行记录。' : '详细处理记录可在下方查看。'}`
                  : authorized
                    ? '按 Mole 规则自动清理，运行过程将在下方实时展示。'
                    : '预览不会删除文件。授权管理员权限后，可以开始真实清理。'}
              </p>
            </div>
          </div>
          <div className="clean-action-row">
            <div className={`clean-authorization ${authorized ? 'authorized' : ''}`} role="status">
              {authorizing ? (
                <LoaderCircle size={15} className="clean-spin" />
              ) : authorized ? (
                <ShieldCheck size={15} />
              ) : (
                <LockKeyhole size={15} />
              )}
              <span>
                {authorizing
                  ? '等待系统授权…'
                  : authorized
                    ? '管理员权限已授权'
                    : '管理员权限未授权'}
              </span>
            </div>
            <div className="clean-buttons">
              {!authorized && (
                <button
                  className="clean-secondary"
                  disabled={disabled}
                  onClick={() => void authorize()}
                >
                  <LockKeyhole size={14} />
                  {authorizing ? '等待授权…' : '授权管理员权限'}
                </button>
              )}
              {authorized && (
                <button
                  className="clean-secondary"
                  disabled={disabled}
                  onClick={() => void run('preview')}
                >
                  <FileText size={14} />
                  预览清理
                </button>
              )}
              <button
                className="clean-primary"
                disabled={disabled}
                onClick={() => void run(authorized ? 'clean' : 'preview')}
              >
                {busy ? (
                  <LoaderCircle size={15} className="clean-spin" />
                ) : authorized ? (
                  <Play size={14} />
                ) : (
                  <ArrowRight size={15} />
                )}
                {busy
                  ? mode === 'preview'
                    ? '正在预览…'
                    : '正在清理…'
                  : authorized
                    ? '开始清理'
                    : '预览清理'}
              </button>
            </div>
          </div>
          {!authorized && (
            <p className="clean-scope-note">
              未授权的预览可能跳过系统级项目。授权成功后不会自动开始清理。
            </p>
          )}
        </section>

        <div className="clean-delete-notice">
          <Trash2 size={17} />
          <p>
            <strong>清理会直接删除文件</strong>
            <span>
              清理将按 Mole
              规则直接删除缓存等文件，并默认清空回收站已有内容，无法通过回收站恢复。预览模式不会删除文件。
            </span>
          </p>
        </div>

        {!available && (
          <p className="clean-error" role="alert">
            请在 Electron 桌面应用中使用清理；更新后请重启应用以加载新功能。
          </p>
        )}
        {error && (
          <p className="clean-error" role="alert">
            {error}
          </p>
        )}

        <section className="clean-output" aria-label="清理日志" aria-busy={busy}>
          <header className="clean-output-heading">
            <div>
              <h2>运行记录</h2>
              <span className={`clean-mode ${mode}`}>
                {mode === 'preview' ? '预览模式' : '清理模式'}
              </span>
            </div>
            {busy && task && (
              <button
                className="clean-stop"
                disabled={task.cancellationRequested}
                onClick={() => void stop()}
              >
                <Square size={11} />
                {task.cancellationRequested ? '正在停止…' : '停止'}
              </button>
            )}
          </header>
          <div
            className={`clean-run-status ${completed ? 'completed' : result ? 'attention' : ''}`}
            role="status"
          >
            {busy ? (
              <LoaderCircle size={15} className="clean-spin" />
            ) : completed ? (
              <Check size={15} />
            ) : result ? (
              <CircleAlert size={15} />
            ) : (
              <span className="clean-status-dot" />
            )}
            <span>{statusText}</span>
          </div>
          {blocks.length === 0 && !busy && !result && !error && (
            <div className="clean-empty">
              <FileText size={32} strokeWidth={1.3} />
              <h3>从一次预览开始</h3>
              <p>缓存、浏览器、开发工具等分类的处理记录会显示在这里。</p>
              <span>实时输出 · 按分类展示 · 原始日志</span>
            </div>
          )}
          {sections.map((section) =>
            section.kind === 'summary' ? (
              <section className="clean-summary" key={section.id}>
                <span>
                  {completed ? <ShieldCheck size={17} /> : <FileText size={17} />}
                  {mode === 'preview' ? '预览摘要' : '清理摘要'}
                </span>
                <pre>{section.text}</pre>
              </section>
            ) : (
              <section className={`clean-log-section ${section.source}`} key={section.id}>
                <h3>
                  <span />
                  {section.title}
                  {section.partial && <small>部分输出</small>}
                </h3>
                <div className="clean-log-lines">
                  {section.text.split('\n').map((line, index) => (
                    <div className={`clean-log-line ${logTone(line)}`} key={index}>
                      {line || '\u00a0'}
                    </div>
                  ))}
                </div>
              </section>
            )
          )}
          {result?.output && (result.output.stdoutTruncated || result.output.stderrTruncated) && (
            <p className="clean-error">日志达到保留上限，以上仅为部分输出。</p>
          )}
        </section>
        <p className="clean-footer">
          <ShieldCheck size={13} />
          本机执行 · 预览与清理结果以 Mole 实际输出为准
        </p>
      </div>
    </div>
  )
}
