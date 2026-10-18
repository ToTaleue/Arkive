import { useRef, useState } from 'react'
import type {
  DocumentKind,
  DocumentResult,
  SelectedDocument,
  ProcessingApi
} from '../../../shared/contracts/processing'
import type { DuplicateScanResult } from '../../../shared/contracts/duplicates'
import { ArchiveAction } from './ArchiveAction'
import { useCompressionTask, compressionTaskMessage } from '../hooks/useCompressionTask'
import '../assets/documents.css'

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : String(error)
}
function size(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function DocumentCompressionPage(): React.JSX.Element {
  const [kind, setKind] = useState<DocumentKind>('pdf')
  const [selected, setSelected] = useState<SelectedDocument | null>(null)
  const [preset, setPreset] = useState<
    'lossless' | 'deep-lossless' | 'quality' | 'balanced' | 'size'
  >('lossless')
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<DocumentResult | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateScanResult | null>(null)
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancellable, setCancellable] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const run = useRef<string | null>(null)
  const [taskRequestId, setTaskRequestId] = useState<string | null>(null)
  const task = useCompressionTask(taskRequestId)
  const api = window.api?.processing

  async function perform(work: (client: ProcessingApi) => Promise<void>): Promise<void> {
    if (lock.current || !api) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work(api)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      lock.current = false
      run.current = null
      setTaskRequestId(null)
      setBusy(false)
      setStage('')
      setCancellable(false)
    }
  }
  async function select(path?: string): Promise<void> {
    await perform(async (client) => {
      setStage('正在检查文档…')
      const file = path ? await client.selectPath(kind, path) : await client.select(kind)
      if (file) {
        setSelected(file)
        setResult(null)
        setConfirmed(false)
      }
    })
  }
  async function compress(): Promise<void> {
    if (!selected) return
    const file = selected
    await perform(async (client) => {
      const id = crypto.randomUUID()
      run.current = id
      setTaskRequestId(id)
      setCancellable(true)
      setStage('正在压缩与校验，完成后处理原件备份…')
      setResult(null)
      const outcome = await client.compress({
        runId: id,
        fileId: file.id,
        preset,
        replaceConfirmed: confirmed
      })
      if (outcome.status === 'completed') {
        setResult(outcome.result)
        setSelected(null)
      } else if (outcome.status === 'error') setError(outcome.error)
      else setNotice('已取消，未发布本次压缩结果。')
    })
  }
  async function scan(): Promise<void> {
    if (!folder) return
    await perform(async (client) => {
      const id = crypto.randomUUID()
      run.current = id
      setCancellable(true)
      setDuplicates(null)
      setTaskRequestId(id)
      setStage('正在只读检测重复文件…')
      const outcome = await client.duplicates(id, folder)
      if (outcome.status === 'completed') setDuplicates(outcome.result)
      else if (outcome.status === 'error') setError(outcome.error)
      else setNotice('扫描已取消，源文件未修改。')
    })
  }
  async function cancel(): Promise<void> {
    if (!run.current || !api) return
    setStage('已请求取消；已经进入备份或发布提交的操作会完成后返回实际结果。')
    try {
      await api.cancel(run.current)
    } catch (failure) {
      setError(errorText(failure))
    }
  }
  const record = result?.value.catalog
  const officeFailed = result?.kind === 'office' && result.value.replacementStatus === 'error'
  return (
    <div className="documents-page">
      <header>
        <h1>文档压缩</h1>
        <p>压缩 PDF、Word 和 PowerPoint，保留完整原件备份。</p>
      </header>
      <div className="document-tabs" role="group" aria-label="文档类型">
        {(['pdf', 'office'] as const).map((type) => (
          <button
            key={type}
            aria-pressed={kind === type}
            disabled={busy}
            onClick={() => {
              setKind(type)
              setSelected(null)
              setResult(null)
              setConfirmed(false)
              setError('')
              setNotice('')
              setPreset(type === 'pdf' ? 'lossless' : 'quality')
            }}
          >
            {type === 'pdf' ? 'PDF' : 'Word / PowerPoint · 实验性'}
          </button>
        ))}
      </div>
      <section aria-label="文档压缩操作" className="document-card">
        <h2>{kind === 'pdf' ? 'PDF 压缩' : 'Office 压缩（实验性）'}</h2>
        {kind === 'office' && (
          <p>复杂版式和嵌入媒体兼容性仍在验证，处理后请用 Word／PowerPoint 检查。</p>
        )}
        <button
          className="document-select"
          disabled={busy || !api}
          onClick={() => void select()}
          onDragOver={(event) => {
            event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            const file = event.dataTransfer.files.item(0)
            if (file && api) {
              const path = api.localFilePath(file)
              if (path) void select(path)
              else setError('请从 Finder 拖入本地文件。')
            }
          }}
        >
          选择{kind === 'pdf' ? ' PDF' : ' DOCX / PPTX'}，或从 Finder 拖入
        </button>
        {selected && (
          <div className="document-selected">
            <strong>{selected.name}</strong>
            <p>{selected.path}</p>
            <p>
              {size(selected.inspection.originalBytes)} ·{' '}
              {selected.kind === 'pdf'
                ? `${String(selected.inspection.pageCount)} 页`
                : `${String(selected.inspection.embeddedImages)} 张图片、${String(selected.inspection.embeddedVideos)} 个 MP4 候选、${String(selected.inspection.otherMedia)} 个其他媒体`}
            </p>
            {selected.kind === 'pdf' && (
              <p>
                表单 {selected.inspection.features.hasForms ? '有' : '无'} · 批注{' '}
                {selected.inspection.features.hasAnnotations ? '有' : '无'} · 附件{' '}
                {selected.inspection.features.hasAttachments ? '有' : '无'}。加密、签名及 PDF/A
                暂不处理；有损档不处理表单、批注及附件。
              </p>
            )}
          </div>
        )}
        <label className="document-preset">
          压缩档位
          <select
            aria-label="文档压缩档位"
            disabled={busy}
            value={preset}
            onChange={(event) => {
              const value = event.target.value
              if (
                value === 'lossless' ||
                value === 'deep-lossless' ||
                value === 'quality' ||
                value === 'balanced' ||
                value === 'size'
              )
                setPreset(value)
            }}
          >
            {kind === 'pdf' ? (
              <>
                <option value="lossless">无损结构优化</option>
                <option value="deep-lossless">极限无损（更慢）</option>
              </>
            ) : (
              <option value="quality">质量优先</option>
            )}
            <option value="balanced">均衡</option>
            <option value="size">体积优先</option>
          </select>
        </label>
        {kind === 'office' ? (
          <label className="document-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => {
                setConfirmed(event.target.checked)
              }}
            />
            我同意有损压缩嵌入媒体并替换原路径文档；完整旧原件先移入 Arkive
            Backup。不支持或未达标的媒体保留原样。
          </label>
        ) : (
          <p>
            生成新的 PDF，不覆盖已有文件；有体积收益后将完整原件移入 Arkive Backup。有损档会重写
            PDF，检查不代表视觉验收。
          </p>
        )}
        <button
          className="archive-primary"
          disabled={busy || !api || !selected || (kind === 'office' && !confirmed)}
          onClick={() => void compress()}
        >
          开始文档压缩
        </button>
      </section>
      {result && (
        <section className="document-card" aria-label="文档压缩结果">
          <h2>
            {officeFailed
              ? '文档替换未完成'
              : result.value.status === 'compressed'
                ? '文档压缩完成'
                : '无体积收益'}
          </h2>
          <p>输出：{result.value.outputPath}</p>
          <p>
            处理后 {size(result.value.outputBytes)} · 文档体积差额 {size(result.value.savedBytes)}
            ，备份仍占磁盘空间。
          </p>
          {result.kind === 'office' && (
            <>
              <p>替换状态：{result.value.replacementStatus}</p>
              {result.value.replacementError && <p role="alert">{result.value.replacementError}</p>}
              <ul>
                {result.value.media.map((media) => (
                  <li key={media.part}>
                    {media.part}：
                    {media.status === 'compressed' ? '已压缩' : `已保留 · ${media.reason ?? ''}`}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!officeFailed && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async (client) => {
                  await client.reveal()
                })
              }
            >
              在 Finder 中显示文档结果
            </button>
          )}
          {record && !officeFailed && <ArchiveAction key={record.id} record={record} />}
          {officeFailed && (
            <p>原路径发布失败；请重启应用后核对启动恢复结果，不要重新编码或归档候选文件。</p>
          )}
        </section>
      )}
      <section className="document-card" aria-label="文件夹重复检测">
        <h2>文件夹重复检测</h2>
        <p>
          只比较选中的文件夹及子目录，不删除、不移动文件。重复体积是逻辑冗余量，不是实际释放量。
        </p>
        <button
          disabled={busy || !api}
          onClick={() =>
            void perform(async (client) => {
              const path = await client.selectFolder()
              if (path) {
                setFolder(path)
                setDuplicates(null)
              }
            })
          }
        >
          选择检测文件夹
        </button>
        {folder && <p>{folder}</p>}
        <button disabled={busy || !api || !folder} onClick={() => void scan()}>
          检测重复文件
        </button>
        {duplicates && (
          <div>
            <p role="status">
              {duplicates.status === 'partial' ? '部分扫描' : '扫描完成'} ·{' '}
              {duplicates.groups.length} 组 · {duplicates.duplicateFileCount} 份重复副本 · 逻辑冗余{' '}
              {size(duplicates.redundantBytes)}
            </p>
            {duplicates.warnings.map((warning, index) => (
              <p role="alert" key={index}>
                {warning}
              </p>
            ))}
            {duplicates.groups.map((group) => (
              <details key={group.hash}>
                <summary>
                  {group.files.length} 个相同文件 · 每份 {size(group.sizeBytes)}
                </summary>
                <ul>
                  {group.files.map((file) => (
                    <li key={file.path}>{file.path}</li>
                  ))}
                </ul>
              </details>
            ))}
            {!duplicates.groups.length && (
              <p>本次扫描没有发现重复组；部分扫描不代表不存在其他重复文件。</p>
            )}
          </div>
        )}
      </section>
      {busy && (
        <div className="document-running" role="status">
          <p>{compressionTaskMessage(task) ?? stage}</p>
          {cancellable && <button onClick={() => void cancel()}>取消当前处理</button>}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="document-error">
          {error}
        </p>
      )}
    </div>
  )
}
