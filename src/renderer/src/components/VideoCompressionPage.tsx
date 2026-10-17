import { ArchiveAction } from './ArchiveAction'
import { useCompressionTask, compressionTaskMessage } from '../hooks/useCompressionTask'
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, CheckCircle2, FileVideo, FolderOpen, LoaderCircle, Upload } from 'lucide-react'
import type {
  SelectedVideo,
  VideoCompressionPreset,
  VideoCompressionProgress,
  VideoCompressionResult,
  VideoCompressionStage
} from '../../../shared/contracts/video'

const presets: { value: VideoCompressionPreset; title: string; description: string }[] = [
  { value: 'quality', title: '画质优先', description: '尽量保留细节，体积收益其次' },
  { value: 'balanced', title: '均衡压缩', description: '兼顾画质和体积，推荐从这里开始' },
  { value: 'size', title: '体积优先', description: '争取更小体积，接受更多细节损失' }
]
const stageLabels: Record<VideoCompressionStage, string> = {
  probing: '正在读取视频信息…',
  analyzing: '正在分析画质并自动选择压缩参数…',
  encoding: '正在压缩视频…',
  validating: '正在检查并解码压缩结果…'
}
type Phase = 'idle' | 'selecting' | 'saving' | 'cancelling' | VideoCompressionStage

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

function formatDuration(seconds: number): string {
  if (seconds < 1) return '不足 1 秒'
  const rounded = Math.max(1, Math.ceil(seconds))
  if (rounded < 60) return `${String(rounded)} 秒`
  if (rounded < 3600) return `${String(Math.ceil(rounded / 60))} 分钟`
  const minutes = Math.ceil(rounded / 60)
  return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分钟`
}

export function VideoCompressionPage(): React.JSX.Element {
  const [selected, setSelected] = useState<SelectedVideo | null>(null)
  const [preset, setPreset] = useState<VideoCompressionPreset>('balanced')
  const [compatibility, setCompatibility] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<VideoCompressionProgress | null>(null)
  const [result, setResult] = useState<VideoCompressionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const runId = useRef<string | null>(null)
  const [taskRequestId, setTaskRequestId] = useState<string | null>(null)
  const task = useCompressionTask(taskRequestId)
  const operating = useRef(false)
  const mounted = useRef(true)
  const api = window.api?.video
  const busy = phase !== 'idle'

  useEffect(() => {
    mounted.current = true
    const video = window.api?.video
    const unsubscribe = video?.onUpdate((update) => {
      if (update.runId === runId.current) {
        setPhase((current) => (current === 'cancelling' ? current : update.stage))
        setProgress(update)
      }
    })
    return () => {
      mounted.current = false
      unsubscribe?.()
    }
  }, [])

  async function selectVideo(): Promise<void> {
    if (!api || operating.current) return
    operating.current = true
    setPhase('selecting')
    setError(null)
    try {
      const file = await api.select()
      if (file && mounted.current) {
        setSelected(file)
        setResult(null)
        setNotice(null)
      }
    } catch (failure) {
      if (mounted.current) setError(message(failure))
    } finally {
      operating.current = false
      if (mounted.current) setPhase('idle')
    }
  }

  async function compress(): Promise<void> {
    if (!api || !selected || operating.current) return
    operating.current = true
    const id = crypto.randomUUID()
    runId.current = id
    setTaskRequestId(id)
    setPhase('saving')
    setProgress(null)
    setResult(null)
    setError(null)
    setNotice(null)
    try {
      const outcome = await api.compress({ runId: id, fileId: selected.id, preset, compatibility })
      if (!mounted.current) return
      if (outcome.status === 'completed') setResult(outcome.result)
      else if (outcome.status === 'error') setError(outcome.error)
      else setNotice('已取消，原视频已保留。')
    } catch (failure) {
      if (mounted.current) setError(message(failure))
    } finally {
      operating.current = false
      runId.current = null
      setTaskRequestId(null)
      if (mounted.current) setPhase('idle')
    }
  }

  async function cancel(): Promise<void> {
    if (!api || !runId.current || phase === 'cancelling') return
    const previousPhase = phase
    setPhase('cancelling')
    try {
      await api.cancel(runId.current)
    } catch (failure) {
      if (mounted.current && runId.current) {
        setError(message(failure))
        setPhase(previousPhase)
      }
    }
  }

  async function reveal(): Promise<void> {
    try {
      await api?.reveal()
    } catch (failure) {
      setError(message(failure))
    }
  }

  const status =
    compressionTaskMessage(task) ??
    (phase === 'saving'
      ? '选择保存位置，确认后开始压缩；成功且体积减小后原件移入备份目录。'
      : phase === 'cancelling'
        ? '正在取消并清理临时文件…'
        : phase === 'selecting'
          ? '请选择本地视频。'
          : phase === 'idle'
            ? null
            : stageLabels[phase])

  return (
    <div className="video-page">
      <header className="video-page-heading">
        <div className="video-heading-icon">
          <FileVideo size={25} strokeWidth={1.5} />
        </div>
        <div>
          <h1>视频压缩</h1>
          <p>成功且体积减小后，原件移入 Arkive Backup；压缩结果保留在选定位置。</p>
          <p>选一个视频，从一小次压缩开始。</p>
        </div>
        <span className="video-format">MP4 · {compatibility ? 'H.264' : 'HEVC'}</span>
      </header>

      <section className="video-card" aria-labelledby="video-file-heading">
        <div className="video-section-heading">
          <span>01</span>
          <h2 id="video-file-heading">选择视频</h2>
        </div>
        {!selected ? (
          <button
            className="video-file-picker"
            disabled={busy || !api}
            onClick={() => void selectVideo()}
          >
            <Upload size={30} strokeWidth={1.4} />
            <strong>点击选择本地视频</strong>
            <span>支持 MP4、MOV 等常见格式</span>
          </button>
        ) : (
          <div className="video-selected-file">
            <FileVideo size={30} strokeWidth={1.4} />
            <div>
              <strong>{selected.name}</strong>
              <span>{formatSize(selected.sizeBytes)}</span>
              <p>{selected.path}</p>
            </div>
            <button
              className="video-text-button"
              disabled={busy}
              onClick={() => void selectVideo()}
            >
              更换视频
            </button>
          </div>
        )}
        <p className="video-hint">
          文件仅在本机处理，自动分析画质后使用 Apple 硬件压缩，始终保留原视频。
        </p>
        {selected && (
          <p className="video-hint" role="note">
            仅保留主视频和音频。
            {selected.removedContents.length > 0 &&
              `将移除：${selected.removedContents.join('、')}。`}
            原文件保留。
          </p>
        )}
        {!api && (
          <p role="alert" className="video-error">
            请在 Electron 桌面应用中打开；开发中更新后请重启应用。
          </p>
        )}
      </section>

      <section className="video-card" aria-labelledby="video-preset-heading">
        <div className="video-section-heading">
          <span>02</span>
          <h2 id="video-preset-heading">选择压缩档位</h2>
        </div>
        <fieldset className="video-presets" disabled={busy}>
          <legend className="sr-only">压缩档位</legend>
          {presets.map((item) => (
            <label
              key={item.value}
              className={`video-preset ${preset === item.value ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="video-preset"
                value={item.value}
                checked={preset === item.value}
                onChange={() => {
                  setPreset(item.value)
                }}
              />
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </label>
          ))}
        </fieldset>
        <label className="video-compatibility">
          <input
            type="checkbox"
            checked={compatibility}
            disabled={busy}
            onChange={(event) => {
              setCompatibility(event.target.checked)
            }}
          />
          兼容优先（H.264）
        </label>
        <p className="video-hint">
          {compatibility
            ? '输出 8bit H.264，便于在更多设备播放；10bit 原片将转为 8bit，体积可能比 HEVC 更大。保留原分辨率与帧率，老设备仍可能无法播放高规格视频。'
            : '默认输出 HEVC，侧重节省空间，并保留支持的原片位深。'}
        </p>
        <div className="video-actions">
          <p>
            保留原分辨率与帧率
            <br />
            <span>点击开始后选择保存位置；成功且体积减小后，原件移入备份目录</span>
          </p>
          <button
            className="video-primary-button"
            disabled={!selected || busy || !api}
            onClick={() => void compress()}
          >
            {busy && phase !== 'selecting' ? (
              <LoaderCircle size={16} className="video-spinner" />
            ) : (
              <ArrowDown size={16} />
            )}
            {busy && phase !== 'selecting' ? '处理中…' : '开始压缩'}
          </button>
        </div>
        {status && (
          <div className="video-running" role="status">
            <p>{status}</p>
            {phase !== 'selecting' && (
              <progress
                aria-label={phase === 'validating' ? '校验进度' : '视频处理进度'}
                max={100}
                value={
                  phase === 'encoding' || phase === 'validating'
                    ? (progress?.percent ?? undefined)
                    : undefined
                }
              />
            )}
            {phase === 'analyzing' && progress && (
              <div className="video-progress-details">
                <span>本阶段已用 {formatDuration(progress.elapsedSeconds)}</span>
                <p>正在抽样试压和比较画质，可能需要几分钟；分析完成后开始压缩和校验。</p>
              </div>
            )}
            {(phase === 'encoding' || phase === 'validating') && progress && (
              <div className="video-progress-details">
                <span>
                  {phase === 'encoding' ? '压缩' : '校验'}进度 {progress.percent ?? 0}%
                </span>
                <span>本阶段已用 {formatDuration(progress.elapsedSeconds)}</span>
                <strong>
                  {progress.percent !== null && progress.percent >= 99
                    ? '正在收尾…'
                    : progress.remainingSeconds === null
                      ? '正在估算剩余时间…'
                      : `本阶段预计还需约 ${formatDuration(progress.remainingSeconds)}`}
                </strong>
                {phase === 'encoding' && <p>压缩后还会校验文件；预计时间随实际处理速度更新。</p>}
              </div>
            )}
            {(phase !== 'saving' || task) && phase !== 'selecting' && (
              <button
                className="video-text-button"
                disabled={phase === 'cancelling'}
                onClick={() => void cancel()}
              >
                取消压缩
              </button>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="video-error video-feedback" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="video-feedback" role="status">
          {notice}
        </p>
      )}
      {result && (
        <section className="video-card video-result" aria-label="压缩结果" role="status">
          <h2>
            <CheckCircle2 size={19} />
            {result.status === 'compressed' ? '压缩完成' : '处理完成，体积没有减小'}
          </h2>
          <div className="video-size-comparison">
            <div>
              <span>原视频</span>
              <strong>{formatSize(result.inputBytes)}</strong>
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
              ? '已检查文件并完成解码验证。原件位置见下方备份状态。'
              : '本次没有体积收益；输出文件和原视频均已保留。'}
          </p>
          <p>
            输出 MP4 · {result.videoCodec === 'h264' ? 'H.264' : 'HEVC'} · {result.bitDepth}bit。
          </p>
          <p>
            抽样画质评分 {result.qualityAnalysis.sampleVmaf.toFixed(1)} / 100 （目标{' '}
            {result.qualityAnalysis.targetVmaf}）。评分来自抽样分析，不代表整片画质保证。
          </p>
          <p className="video-output-path">{result.outputPath}</p>
          <button className="video-text-button" onClick={() => void reveal()}>
            <FolderOpen size={15} />在 Finder 中显示
          </button>
          {result.catalog && <ArchiveAction key={result.catalog.id} record={result.catalog} />}
        </section>
      )}
    </div>
  )
}
