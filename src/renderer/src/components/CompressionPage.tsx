import { useMemo, useRef, useState } from 'react'
import {
  Check,
  File,
  FolderOpen,
  LoaderCircle,
  Plus,
  Shrink,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useCompressionTask, compressionTaskMessage } from '../hooks/useCompressionTask'
import type { SelectedVideo } from '../../../shared/contracts/video'
import type { ImageQualityAnalysis, SelectedImage } from '../../../shared/contracts/image'
import type { SelectedDocument } from '../../../shared/contracts/processing'
import type { ArchiveAttempt, AutomaticTagAttempt } from '../../../shared/contracts/catalog'
import '../assets/compression.css'

type CompressionKind = 'video' | 'image' | 'pdf' | 'office'
type QueueStatus = 'ready' | 'running' | 'done' | 'error' | 'cancelled'
type SelectedFile = SelectedVideo | SelectedImage | SelectedDocument
type QueueItem = {
  id: string
  path: string
  name: string
  kind: CompressionKind
  sizeBytes: number
  selected?: SelectedFile
  status: QueueStatus
  message?: string
  details?: string[]
}

const videoExtensions = new Set(['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm'])
const imageExtensions = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'tif',
  'tiff',
  'gif',
  'heic',
  'heif'
])
const officeExtensions = new Set(['docx', 'pptx'])

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function classify(path: string): CompressionKind | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (videoExtensions.has(extension)) return 'video'
  if (imageExtensions.has(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (officeExtensions.has(extension)) return 'office'
  return null
}

function kindLabel(kind: CompressionKind): string {
  return kind === 'video' ? '视频' : kind === 'image' ? '图片' : kind === 'pdf' ? 'PDF' : 'Office'
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '处理失败，请重试。'
}

function completionMessage(
  archive: ArchiveAttempt | undefined,
  automaticTags: AutomaticTagAttempt | undefined,
  fallback: string
): string {
  if (archive?.status === 'error') return `${fallback} · 归档失败：${archive.error}`
  if (archive?.status === 'ready' && archive.item.originalLink?.status === 'error') {
    return `${fallback} · 已归档 · 原位置入口未创建：${archive.item.originalLink.error ?? '请在归档中重试'}`
  }
  if (archive?.status === 'ready' && archive.item.originalLink?.status === 'ready') {
    fallback += ' · 原位置入口已创建'
  }
  if (archive?.status === 'ready' && automaticTags?.status === 'error') {
    return `${fallback} · 已归档 · AI 标签失败：${automaticTags.error}`
  }
  if (archive?.status === 'ready' && archive.item.tagStatus === 'error') {
    return `${fallback} · 已归档 · Finder 标签同步失败：${archive.item.tagError ?? '请在归档中重试'}`
  }
  if (archive?.status === 'ready' && automaticTags?.status === 'cancelled') {
    return `${fallback} · 已归档 · AI 标签已取消`
  }
  if (archive?.status === 'ready' && automaticTags?.status === 'ready') {
    return `${fallback} · 已归档 · 已添加 ${String(automaticTags.tags.length)} 个标签`
  }
  if (archive?.status === 'ready') return `${fallback} · 已归档`
  return fallback
}

function resultSizes(inputBytes: number, outputBytes: number, status: string): string {
  if (status === 'no-savings') return `保留原文件 ${formatSize(inputBytes)} · 采用收益 0%`
  const reduction =
    inputBytes > 0
      ? ` · 体积减少 ${(((inputBytes - outputBytes) / inputBytes) * 100).toFixed(1)}%`
      : ''
  return `${formatSize(inputBytes)} → ${formatSize(outputBytes)}${reduction}`
}

function imageQualityMessage(analysis: ImageQualityAnalysis): string {
  if (analysis.score === null)
    return `画质参考评分不可用${analysis.error ? `：${analysis.error}` : ''}`
  return `画质参考 ${analysis.score.toFixed(1)} / 目标 ${String(analysis.targetScore)}${analysis.meetsTarget === false ? ' · 低于参考目标，请查看原图对照' : ''}`
}

export function CompressionPage(): React.JSX.Element {
  const api = window.api as NonNullable<typeof window.api>
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<QueueItem[]>([])
  const [preset, setPreset] = useState<'quality' | 'balanced' | 'size'>('balanced')
  const [imageOutput, setImageOutput] = useState<'webp' | 'original'>('webp')
  const [archiveAfterCompression, setArchiveAfterCompression] = useState(false)
  const [keepLinkAtOriginalLocation, setKeepLinkAtOriginalLocation] = useState(false)
  const [officeReplaceConfirmed, setOfficeReplaceConfirmed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<{ itemId: string; runId: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const activeTask = useCompressionTask(active?.runId ?? null)

  const readyItems = useMemo(() => items.filter((item) => item.status === 'ready'), [items])
  const canStart =
    readyItems.length > 0 &&
    (!readyItems.some((item) => item.kind === 'office') || officeReplaceConfirmed)
  const totalBytes = useMemo(() => items.reduce((sum, item) => sum + item.sizeBytes, 0), [items])
  const doneCount = items.filter((item) => item.status === 'done').length

  function updateItem(id: string, patch: Partial<QueueItem>): void {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function addPaths(paths: Array<{ path: string; sizeBytes: number }>, replace = false): void {
    const unique = paths.filter(
      (candidate, index) =>
        candidate.path &&
        (replace || !items.some((existing) => existing.path === candidate.path)) &&
        paths.findIndex((other) => other.path === candidate.path) === index
    )
    const candidates: QueueItem[] = []
    const skipped: string[] = []
    for (const candidate of unique) {
      const name =
        candidate.path
          .split(document.documentElement.dataset.platform === 'win32' ? /[\\/]/ : '/')
          .pop() || candidate.path
      const kind = classify(candidate.path)
      if (!kind) {
        skipped.push(name)
        continue
      }
      const item: QueueItem = {
        id: crypto.randomUUID(),
        path: candidate.path,
        name,
        kind,
        sizeBytes: candidate.sizeBytes,
        status: 'ready'
      }
      candidates.push(item)
    }
    if (!candidates.length && skipped.length) {
      setError(`没有可压缩的文件：${skipped.slice(0, 3).join('、')}`)
      return
    }
    setError('')
    setNotice(skipped.length ? `已跳过 ${String(skipped.length)} 个不支持的文件。` : '')
    if (candidates.some((candidate) => candidate.kind === 'office'))
      setOfficeReplaceConfirmed(false)
    setItems((current) => (replace ? candidates : [...current, ...candidates]))
  }

  function filesToPaths(files: FileList | File[]): Array<{ path: string; sizeBytes: number }> {
    return Array.from(files).map((file) => ({
      path: api.processing.localFilePath(file),
      sizeBytes: file.size
    }))
  }

  function onFilesSelected(event: React.ChangeEvent<HTMLInputElement>): void {
    if (event.target.files) addPaths(filesToPaths(event.target.files))
    event.target.value = ''
  }

  function onFolderSelected(event: React.ChangeEvent<HTMLInputElement>): void {
    if (event.target.files) addPaths(filesToPaths(event.target.files), true)
    event.target.value = ''
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    if (busy) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length)
      addPaths(
        filesToPaths(files),
        files.some((file) => file.webkitRelativePath)
      )
  }

  async function compressItem(item: QueueItem): Promise<'done' | 'cancelled' | 'error'> {
    const runId = crypto.randomUUID()
    const archiveOptions = archiveAfterCompression
      ? { archive: true, keepLinkAtOriginalLocation }
      : {}
    setActive({ itemId: item.id, runId })
    updateItem(item.id, { status: 'running', message: '正在准备文件…' })
    try {
      if (item.kind === 'video') {
        const selected = await api.video.selectPath(item.path)
        const outcome = await api.video.compress({
          runId,
          fileId: selected.id,
          preset,
          ...archiveOptions
        })
        if (outcome.status === 'completed') {
          updateItem(item.id, {
            status: 'done',
            message: completionMessage(
              outcome.result.archive,
              outcome.result.automaticTags,
              outcome.result.status === 'no-savings' ? '无压缩收益 · 原文件已保留' : '压缩完成'
            ),
            details: [
              resultSizes(
                outcome.result.inputBytes,
                outcome.result.outputBytes,
                outcome.result.status
              ),
              `${outcome.result.status === 'no-savings' ? '未采用候选 · ' : ''}抽样 VMAF ${outcome.result.qualityAnalysis.sampleVmaf.toFixed(1)} / 目标 ${String(outcome.result.qualityAnalysis.targetVmaf)}`
            ]
          })
          return 'done'
        }
        if (outcome.status === 'cancelled') {
          updateItem(item.id, { status: 'cancelled', message: '已取消，原件未修改' })
          return 'cancelled'
        }
        updateItem(item.id, { status: 'error', message: outcome.error })
        return 'error'
      } else if (item.kind === 'image') {
        const selected = await api.image.selectPath(item.path)
        const outcome = await api.image.compress({
          runId,
          fileId: selected.id,
          preset,
          ...archiveOptions,
          ...(imageOutput === 'original'
            ? { preserveFormat: true }
            : { outputFormat: 'webp' as const })
        })
        if (outcome.status === 'completed') {
          updateItem(item.id, {
            status: 'done',
            message: completionMessage(
              outcome.result.archive,
              outcome.result.automaticTags,
              outcome.result.status === 'no-savings' ? '无压缩收益 · 原文件已保留' : '压缩完成'
            ),
            details: [
              resultSizes(
                outcome.result.originalBytes,
                outcome.result.outputBytes,
                outcome.result.status
              ),
              imageQualityMessage(outcome.result.qualityAnalysis),
              ...(outcome.result.metadataWarnings ?? [])
            ]
          })
          return 'done'
        }
        if (outcome.status === 'cancelled') {
          updateItem(item.id, { status: 'cancelled', message: '已取消，原件未修改' })
          return 'cancelled'
        }
        updateItem(item.id, { status: 'error', message: outcome.error })
        return 'error'
      } else {
        const selected = await api.processing.selectPath(item.kind, item.path)
        const outcome = await api.processing.compress({
          runId,
          fileId: selected.id,
          preset: item.kind === 'pdf' ? (preset === 'quality' ? 'balanced' : preset) : preset,
          ...archiveOptions,
          ...(item.kind === 'office' ? { replaceConfirmed: officeReplaceConfirmed } : {})
        })
        if (outcome.status === 'completed') {
          if (
            outcome.result.kind === 'office' &&
            outcome.result.value.replacementStatus === 'error'
          ) {
            updateItem(item.id, {
              status: 'error',
              message: `原路径替换失败：${outcome.result.value.replacementError ?? '请查看备份与输出'}`
            })
            return 'error'
          }
          const archive = outcome.result.value.archive
          const value = outcome.result.value
          const details = [
            resultSizes(
              outcome.result.kind === 'pdf'
                ? outcome.result.value.inputBytes
                : outcome.result.value.originalBytes,
              value.outputBytes,
              value.status
            )
          ]
          if (outcome.result.kind === 'office') {
            const media = outcome.result.value.media
            details.push(
              `内嵌媒体：${String(media.filter((part) => part.status === 'compressed').length)} 项压缩、${String(media.filter((part) => part.status === 'skipped').length)} 项保留原样`
            )
            const belowTarget = media.filter(
              (part) => part.status === 'compressed' && part.qualityAnalysis?.meetsTarget === false
            ).length
            if (belowTarget > 0)
              details.push(`${String(belowTarget)} 张图片低于参考画质目标，请打开文档对照`)
          }
          updateItem(item.id, {
            status: 'done',
            message: completionMessage(
              archive,
              outcome.result.value.automaticTags,
              value.status === 'no-savings' ? '无压缩收益 · 原文件已保留' : '压缩完成'
            ),
            details
          })
          return 'done'
        }
        if (outcome.status === 'cancelled') {
          updateItem(item.id, { status: 'cancelled', message: '已取消，原件未修改' })
          return 'cancelled'
        }
        updateItem(item.id, { status: 'error', message: outcome.error })
        return 'error'
      }
    } catch (failure) {
      updateItem(item.id, { status: 'error', message: errorMessage(failure) })
      return 'error'
    } finally {
      setActive(null)
    }
  }

  async function startCompression(): Promise<void> {
    const officeNeedsConfirmation = readyItems.some((item) => item.kind === 'office')
    if (busy || !readyItems.length || (officeNeedsConfirmation && !officeReplaceConfirmed)) return
    setBusy(true)
    setError('')
    setNotice('')
    for (const item of items.filter((candidate) => candidate.status === 'ready')) {
      const result = await compressItem(item)
      if (result === 'cancelled') break
    }
    setBusy(false)
    setNotice('本批任务已结束。请查看每一项状态，原件保护和备份由现有 Task 负责。')
  }

  async function cancelCurrent(): Promise<void> {
    if (!active) return
    const item = items.find((candidate) => candidate.id === active.itemId)
    if (!item) return
    if (item.kind === 'video') await api.video.cancel(active.runId)
    else if (item.kind === 'image') await api.image.cancel(active.runId)
    else await api.processing.cancel(active.runId)
    setNotice('已请求取消当前文件；已经完成的文件会保留。')
  }

  function removeItem(id: string): void {
    if (!busy) setItems((current) => current.filter((item) => item.id !== id))
  }

  return (
    <div className="compression-page">
      <input ref={inputRef} hidden type="file" multiple onChange={onFilesSelected} />
      <input
        ref={folderRef}
        hidden
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={onFolderSelected}
      />
      <header className="compression-heading">
        <div>
          <p className="compression-eyebrow">ARKIVE / 压缩</p>
          <h1>压缩</h1>
          <p>把一批视频、图片或文档放在一起，按顺序处理。</p>
        </div>
        <button
          className="compression-primary"
          disabled={busy || !canStart}
          onClick={() => void startCompression()}
        >
          {busy ? '正在压缩…' : '开始压缩'}
        </button>
      </header>

      <section
        className={`compression-drop ${dragging ? 'is-dragging' : ''}`}
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
        onDrop={onDrop}
      >
        <Upload size={28} />
        <strong>{dragging ? '松开以加入文件' : '把文件拖到这里'}</strong>
        <span>支持继续追加文件；拖入文件夹会替换当前列表。</span>
        <div className="compression-drop-actions">
          <button
            className="compression-secondary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Plus size={15} /> 选择文件
          </button>
          <button
            className="compression-secondary"
            disabled={busy}
            onClick={() => folderRef.current?.click()}
          >
            <FolderOpen size={15} /> 打开文件夹
          </button>
        </div>
      </section>

      <section className="compression-summary" aria-label="压缩概览">
        <div>
          <span>当前文件</span>
          <strong>{items.length} 个</strong>
        </div>
        <div>
          <span>原始体积</span>
          <strong>{formatSize(totalBytes)}</strong>
        </div>
        <div>
          <span>原件</span>
          <strong>默认保留</strong>
        </div>
        <div>
          <span>已完成</span>
          <strong>{doneCount} 个</strong>
        </div>
      </section>

      <section className="compression-options" aria-label="压缩设置">
        <div>
          <span className="compression-label">快捷档位</span>
          <div className="compression-segments" role="group" aria-label="快捷档位">
            {(['quality', 'balanced', 'size'] as const).map((value) => (
              <button
                key={value}
                className={preset === value ? 'selected' : ''}
                aria-pressed={preset === value}
                disabled={busy}
                onClick={() => {
                  setPreset(value)
                }}
              >
                {value === 'quality'
                  ? '画质优先'
                  : value === 'balanced'
                    ? '平衡 · 推荐'
                    : '体积优先'}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span className="compression-label">图片输出</span>
          <select
            disabled={busy}
            value={imageOutput}
            onChange={(event) => {
              setImageOutput(event.target.value as 'webp' | 'original')
            }}
          >
            <option value="webp">WebP</option>
            <option value="original">原格式输出</option>
          </select>
        </label>
        {items.some((item) => item.kind === 'office') && (
          <label className="compression-confirm">
            <input
              type="checkbox"
              disabled={busy}
              checked={officeReplaceConfirmed}
              onChange={(event) => {
                setOfficeReplaceConfirmed(event.target.checked)
              }}
            />
            <span>Office 压缩（实验性）：原路径替换，并保留完整原件备份</span>
            <small>复杂版式和嵌入媒体兼容性仍在验证，处理后请用 Word／PowerPoint 检查。</small>
          </label>
        )}
        <label className="compression-confirm">
          <input
            type="checkbox"
            checked={archiveAfterCompression}
            disabled={busy}
            onChange={(event) => {
              setArchiveAfterCompression(event.target.checked)
              if (!event.target.checked) setKeepLinkAtOriginalLocation(false)
            }}
          />
          <span>压缩完成后归档</span>
          <small>复制压缩结果到 Arkive Archive，并根据元数据自动生成词库标签。</small>
        </label>
        <label className="compression-confirm">
          <input
            type="checkbox"
            checked={keepLinkAtOriginalLocation}
            disabled={busy || !archiveAfterCompression}
            onChange={(event) => {
              setKeepLinkAtOriginalLocation(event.target.checked)
            }}
          />
          <span>在原位置保留访问入口（试用）</span>
          <small>
            需开启归档；归档后创建软链接。格式转换使用新扩展名，原位置已有文件（如 Office
            压缩结果）时保留文件并提示。
          </small>
        </label>
      </section>

      {active && (
        <div className="compression-running" role="status">
          <LoaderCircle className="spin" size={17} />{' '}
          {activeTask
            ? (compressionTaskMessage(activeTask) ?? '正在处理当前文件…')
            : '正在准备当前文件…'}{' '}
          <button onClick={() => void cancelCurrent()}>取消当前文件</button>
        </div>
      )}

      {items.length === 0 ? (
        <section className="compression-empty">
          <Shrink size={36} />
          <h2>还没有文件</h2>
          <p>拖入视频、图片或文件夹，先看看这一批会怎么处理。</p>
        </section>
      ) : (
        <section className="compression-list" aria-label="待处理文件">
          <div className="compression-list-heading">
            <span>文件</span>
            <span>类型</span>
            <span>原始体积</span>
            <span>状态</span>
            <span />
          </div>
          {items.map((item) => (
            <div className="compression-row" key={item.id}>
              <div className="compression-file">
                <span className="compression-file-icon">
                  <File size={16} />
                </span>
                <div>
                  <strong>{item.name}</strong>
                  <small title={item.path}>本机文件 · 原件由 Task 处理</small>
                </div>
              </div>
              <span className="compression-kind">{kindLabel(item.kind)}</span>
              <span>{formatSize(item.sizeBytes)}</span>
              <span className={`compression-status ${item.status}`}>
                {item.status === 'ready' ? (
                  '待处理'
                ) : item.status === 'running' ? (
                  '处理中'
                ) : item.status === 'done' ? (
                  <>
                    <Check size={14} />
                    <span>
                      {item.message || '已完成'}
                      {item.details?.map((detail, index) => (
                        <small className="compression-result-detail" key={index}>
                          {detail}
                        </small>
                      ))}
                    </span>
                  </>
                ) : (
                  item.message || (item.status === 'cancelled' ? '已取消' : '处理失败')
                )}
              </span>
              <button
                className="compression-remove"
                disabled={busy}
                aria-label={`移除 ${item.name}`}
                onClick={() => {
                  removeItem(item.id)
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </section>
      )}

      {error && (
        <p className="compression-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="compression-notice" role="status">
          {notice}
        </p>
      )}
      <p className="compression-footnote">
        <X size={14} /> 原件不会被静默删除；每个文件仍由原有 Task 独立校验、备份并报告结果。
      </p>
    </div>
  )
}
