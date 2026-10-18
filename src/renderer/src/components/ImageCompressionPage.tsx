import { ArchiveAction } from './ArchiveAction'
import { useCompressionTask, compressionTaskMessage } from '../hooks/useCompressionTask'
import { useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, FileImage, FolderOpen, LoaderCircle, Upload } from 'lucide-react'
import type {
  ImageCompressionResult,
  ImageOutputFormat,
  SelectedImage
} from '../../../shared/contracts/image'

type Strategy = 'webp' | 'original'

const strategyInfo: Record<Strategy, { title: string; description: string }> = {
  webp: { title: '默认 WebP', description: '适用于一般压缩，通常能取得较好的体积收益。' },
  original: {
    title: '原格式输出',
    description: 'JPEG、PNG、WebP 保持原格式；PNG 使用 pngquant，其余使用 Sharp。'
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '操作失败，请重试。'
}

function outputFormat(strategy: Strategy): ImageOutputFormat | undefined {
  return strategy === 'webp' ? 'webp' : undefined
}

export function ImageCompressionPage(): React.JSX.Element {
  const [selected, setSelected] = useState<SelectedImage | null>(null)
  const [strategy, setStrategy] = useState<Strategy>('webp')
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImageCompressionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const runId = useRef<string | null>(null)
  const [taskRequestId, setTaskRequestId] = useState<string | null>(null)
  const task = useCompressionTask(taskRequestId)
  const api = window.api?.image

  async function selectImage(): Promise<void> {
    if (!api || busy) return
    setError(null)
    try {
      const file = await api.select()
      if (file) {
        setSelected(file)
        setResult(null)
        setNotice(null)
      }
    } catch (failure) {
      setError(message(failure))
    }
  }

  async function dropImage(event: React.DragEvent<HTMLButtonElement>): Promise<void> {
    event.preventDefault()
    setDragging(false)
    if (busy || !api) return
    const file = event.dataTransfer.files.item(0)
    const path = file ? (window.api?.processing.localFilePath(file) ?? '') : ''
    if (!path) {
      setError('请从本机文件管理器拖入图片。')
      return
    }
    setError(null)
    try {
      const selectedFile = await api.selectPath(path)
      setSelected(selectedFile)
      setResult(null)
      setNotice(null)
    } catch (failure) {
      setError(message(failure))
    }
  }

  async function compress(): Promise<void> {
    if (!api || !selected || busy) return
    const id = crypto.randomUUID()
    runId.current = id
    setTaskRequestId(id)
    setBusy(true)
    setResult(null)
    setError(null)
    setNotice(null)
    try {
      const outcome = await api.compress({
        runId: id,
        fileId: selected.id,
        outputFormat: outputFormat(strategy),
        preserveFormat: strategy === 'original'
      })
      if (outcome.status === 'completed') setResult(outcome.result)
      else if (outcome.status === 'error') setError(outcome.error)
      else setNotice('已取消，原图片已保留。')
    } catch (failure) {
      setError(message(failure))
    } finally {
      runId.current = null
      setTaskRequestId(null)
      setBusy(false)
    }
  }

  async function cancel(): Promise<void> {
    if (!api || !runId.current) return
    try {
      await api.cancel(runId.current)
    } catch (failure) {
      setError(message(failure))
    }
  }

  async function reveal(): Promise<void> {
    try {
      await api?.reveal()
    } catch (failure) {
      setError(message(failure))
    }
  }

  return (
    <div className="image-page">
      <header className="image-page-heading">
        <div className="image-heading-icon">
          <FileImage size={25} strokeWidth={1.5} />
        </div>
        <div>
          <h1>图片压缩</h1>
          <p>拖入一张图片，选择输出策略，再保存压缩结果。</p>
        </div>
        <span className="image-format">WebP · JPEG · PNG</span>
      </header>

      <section className="image-card" aria-labelledby="image-file-heading">
        <div className="image-section-heading">
          <span>01</span>
          <h2 id="image-file-heading">选择图片</h2>
        </div>
        {!selected ? (
          <button
            className={`image-drop-zone ${dragging ? 'is-dragging' : ''}`}
            type="button"
            disabled={busy || !api}
            onClick={() => void selectImage()}
            onDragEnter={(event) => {
              event.preventDefault()
              if (!busy) setDragging(true)
            }}
            onDragOver={(event) => {
              event.preventDefault()
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false)
            }}
            onDrop={(event) => void dropImage(event)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') void selectImage()
            }}
          >
            <Upload size={32} strokeWidth={1.35} />
            <strong>{dragging ? '松开以选择图片' : '拖入图片，或点击选择'}</strong>
            <span>支持 PNG、JPEG、WebP、TIFF 等静态图片</span>
          </button>
        ) : (
          <div className="image-selected-file">
            <FileImage size={30} strokeWidth={1.4} />
            <div>
              <strong>{selected.name}</strong>
              <span>
                {selected.format.toUpperCase()} · {selected.width} × {selected.height} ·{' '}
                {formatSize(selected.sizeBytes)}
              </span>
              <p>{selected.path}</p>
            </div>
            <button
              className="image-text-button"
              disabled={busy}
              onClick={() => void selectImage()}
            >
              更换图片
            </button>
          </div>
        )}
        <p className="image-hint">
          文件仅在本机处理。压缩写入新文件；有体积收益后，完整原件移入备份目录。
        </p>
        {!api && (
          <p className="image-error" role="alert">
            请在 Electron 桌面应用中打开；开发中更新后请重启应用。
          </p>
        )}
      </section>

      <section className="image-card" aria-labelledby="image-strategy-heading">
        <div className="image-section-heading">
          <span>02</span>
          <h2 id="image-strategy-heading">选择输出策略</h2>
        </div>
        <fieldset className="image-strategies" disabled={busy}>
          <legend className="sr-only">图片输出策略</legend>
          {(Object.keys(strategyInfo) as Strategy[]).map((value) => {
            return (
              <label
                key={value}
                className={`image-strategy ${strategy === value ? 'selected' : ''}`}
              >
                <input
                  type="radio"
                  name="image-strategy"
                  value={value}
                  checked={strategy === value}
                  onChange={() => {
                    setStrategy(value)
                  }}
                />
                <strong>{strategyInfo[value].title}</strong>
                <span>{strategyInfo[value].description}</span>
              </label>
            )
          })}
        </fieldset>
        <div className="image-actions">
          <p>
            {strategyInfo[strategy].title}
            <br />
            <span>点击开始后选择保存位置；成功且体积减小后，原件移入备份目录</span>
          </p>
          <button
            className="image-primary-button"
            disabled={!selected || busy || !api}
            onClick={() => void compress()}
          >
            {busy ? <LoaderCircle size={16} className="image-spinner" /> : <ArrowDown size={16} />}
            {busy ? '处理中…' : '开始压缩'}
          </button>
          {busy && (
            <button className="image-text-button" onClick={() => void cancel()}>
              取消
            </button>
          )}
        </div>
        {busy && (
          <p className="image-feedback" role="status">
            {compressionTaskMessage(task) ?? '请选择保存位置，确认后加入压缩队列。'}
          </p>
        )}
      </section>

      {error && (
        <div className="image-error image-feedback" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="image-feedback" role="status">
          {notice}
        </p>
      )}
      {result && (
        <section className="image-card image-result" aria-label="压缩结果" role="status">
          <h2>
            <CheckCircle2 size={19} />
            {result.status === 'compressed' ? '压缩完成' : '处理完成，体积没有减小'}
          </h2>
          <div className="image-size-comparison">
            <div>
              <span>原图片</span>
              <strong>{formatSize(result.originalBytes)}</strong>
            </div>
            <ArrowDown size={18} />
            <div>
              <span>压缩后</span>
              <strong>{formatSize(result.outputBytes)}</strong>
            </div>
            <div>
              <span>体积减少</span>
              <strong>{formatSize(result.savedBytes)}</strong>
            </div>
          </div>
          <p>
            {result.status === 'compressed'
              ? '已完成格式和解码校验。原件位置见下方备份状态。'
              : '本次没有体积收益，继续使用原图片。'}
          </p>
          <p>
            {result.qualityAnalysis.score === null
              ? '画质评分暂不可用，按体积收益采用结果。'
              : `SSIMULACRA2 ${result.qualityAnalysis.score.toFixed(1)} / 100，参考值 ${String(result.qualityAnalysis.targetScore)}，尝试 ${String(result.qualityAnalysis.attempts)} 次。评分仅供参考，按体积收益采用结果。`}
          </p>
          <p className="image-output-path">
            {result.status === 'compressed' ? result.outputPath : result.inputPath}
          </p>
          {result.metadataWarnings?.map((warning) => (
            <p key={warning} className="image-hint">
              {warning}
            </p>
          ))}
          <button className="image-text-button" onClick={() => void reveal()}>
            <FolderOpen size={15} />在 Finder 中显示
          </button>
          {result.status === 'compressed' && result.catalog && (
            <ArchiveAction key={result.catalog.id} record={result.catalog} />
          )}
        </section>
      )}
    </div>
  )
}
