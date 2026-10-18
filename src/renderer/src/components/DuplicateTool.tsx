import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { CloneDeduplicationResult } from '../../../shared/contracts/clone-deduplication'
import type { DuplicateGroup, DuplicateScanResult } from '../../../shared/contracts/duplicates'
import '../assets/toolbox.css'

type GroupState = 'ready' | 'running' | 'done' | 'failed' | 'skipped'
type GroupView = DuplicateGroup & {
  sourcePath?: string
  selected: boolean
  state: GroupState
  message?: string
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${(bytes / 1_000).toFixed(0)} KB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function DuplicateTool(): React.JSX.Element {
  const api = window.api?.processing
  const [folder, setFolder] = useState<string | null>(null)
  const [scan, setScan] = useState<DuplicateScanResult | null>(null)
  const [groups, setGroups] = useState<GroupView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [cancelId, setCancelId] = useState<string | null>(null)
  const activeRunId = useRef<string | null>(null)

  const totalSelectedCopies = useMemo(
    () =>
      groups
        .filter((group) => group.selected && group.sourcePath)
        .reduce((sum, group) => sum + group.files.length - 1, 0),
    [groups]
  )
  const selectedLogicalBytes = useMemo(
    () =>
      groups
        .filter((group) => group.selected && group.sourcePath)
        .reduce((sum, group) => sum + group.sizeBytes * (group.files.length - 1), 0),
    [groups]
  )

  const chooseFolder = useCallback(async (): Promise<void> => {
    if (!api || busy) return
    setError('')
    setNotice('')
    const path = await api.selectFolder()
    if (!path) return
    setFolder(path)
    setScan(null)
    setGroups([])
    setBusy(true)
    const id = crypto.randomUUID()
    setCancelId(id)
    try {
      const result = await api.duplicates(id, path)
      if (result.status === 'completed') {
        setScan(result.result)
        setGroups(
          result.result.groups.map((group) => ({ ...group, selected: false, state: 'ready' }))
        )
        if (result.result.status === 'partial')
          setNotice('扫描不完整，以下结果不能代表文件夹中的全部重复内容。')
      } else if (result.status === 'cancelled') {
        setNotice('扫描已取消，没有修改任何文件。')
      } else {
        setError(result.error)
      }
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setCancelId(null)
      setBusy(false)
    }
  }, [api, busy])

  function updateGroup(index: number, patch: Partial<GroupView>): void {
    setGroups((current) =>
      current.map((group, groupIndex) => (groupIndex === index ? { ...group, ...patch } : group))
    )
  }

  async function runSelected(): Promise<void> {
    if (!api || busy) return
    const pending = groups.filter((group) => group.selected && group.sourcePath)
    if (!pending.length) {
      setError('请先为至少一组选择参照文件，并勾选要处理的组。')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      for (const group of pending) {
        const index = groups.indexOf(group)
        const sourcePath = group.sourcePath
        if (!sourcePath) continue
        updateGroup(index, { state: 'running', message: '正在校验与共享存储…' })
        const requestId = crypto.randomUUID()
        activeRunId.current = requestId
        const result = await api.clone(requestId, {
          sourcePath,
          duplicatePaths: group.files
            .map((file) => file.path)
            .filter((path) => path !== group.sourcePath)
        })
        if (result.status === 'completed') {
          const outcome: CloneDeduplicationResult = result.result
          updateGroup(index, {
            state: outcome.status === 'completed' ? 'done' : 'failed',
            message: outcome.status === 'completed' ? '内容校验通过 · 已共享' : '部分项目未完成'
          })
        } else if (result.status === 'cancelled') {
          updateGroup(index, { state: 'failed', message: '已取消，未处理' })
          break
        } else {
          updateGroup(index, { state: 'failed', message: result.error })
          break
        }
      }
      setNotice('去重任务已结束。请逐项查看状态；实际释放空间不会由逻辑重复内容量推算。')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      activeRunId.current = null
      setBusy(false)
    }
  }

  async function cancelActive(): Promise<void> {
    if (!api) return
    const id = activeRunId.current || cancelId
    if (!id) return
    await api.cancel(id).catch((failure: unknown) => {
      setError(errorMessage(failure))
    })
  }

  const completed = groups.filter((group) => group.state === 'done').length
  return (
    <div className="toolbox-dedup-page">
      <header className="toolbox-heading dedup-heading">
        <div>
          <p className="toolbox-eyebrow">工具箱 / 无损去重</p>
          <h1>无损去重</h1>
          <p>文件照常使用，重复内容共享空间。</p>
          <div className="dedup-traits">
            <span>内容逐字节一致</span>
            <span>保留文件位置</span>
            <span>后续修改互不影响</span>
          </div>
        </div>
        <button
          className="primary-action"
          disabled={busy || totalSelectedCopies === 0}
          onClick={() => void runSelected()}
        >
          确认去重
        </button>
      </header>
      {!folder && (
        <section className="dedup-empty">
          <FolderOpen size={40} />
          <h2>先选一个文件夹</h2>
          <p>查找内容完全相同的文件。先看重复组，再决定哪些文件共享存储。</p>
          <button className="primary-action" disabled={!api} onClick={() => void chooseFolder()}>
            选择文件夹
          </button>
          <small>文件选择和处理均通过本地 Task；不会把文件上传到网络。</small>
        </section>
      )}
      {folder && (
        <>
          <section className="dedup-scope">
            <div>
              <strong>{folder.split('/').pop() || folder}</strong>
              <small>选择的文件夹 · 扫描结果来自当前本机路径</small>
            </div>
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() => void chooseFolder()}
            >
              更换文件夹
            </button>
          </section>
          {busy && (
            <div className="dedup-running" role="status">
              <LoaderCircle className="spin" size={18} />
              正在执行 Task…
              <button className="text-action" onClick={() => void cancelActive()}>
                取消后续处理
              </button>
            </div>
          )}
          {scan && (
            <div className="dedup-summary">
              <div>
                <span>发现重复组</span>
                <strong>{scan.groups.length} 组</strong>
              </div>
              <div>
                <span>本次可处理副本</span>
                <strong>{totalSelectedCopies} 份</strong>
              </div>
              <div>
                <span>逻辑重复内容量</span>
                <strong className="accent">
                  {formatSize(selectedLogicalBytes || scan.redundantBytes)}
                </strong>
              </div>
            </div>
          )}
          {scan && (
            <p className="dedup-note">
              <ShieldCheck size={15} />{' '}
              逻辑重复内容量不等于本次实际释放的磁盘空间；已有快照和共享块会影响结果。
            </p>
          )}
          {groups.length > 0 && (
            <div className="dedup-table-wrap">
              <table className="dedup-table">
                <thead>
                  <tr>
                    <th>处理</th>
                    <th>重复组 / 文件位置</th>
                    <th>参照文件</th>
                    <th>重复内容量</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group, index) => (
                    <tr key={group.hash}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`处理 ${group.files[0]?.relativePath || '重复组'}`}
                          disabled={busy || group.state !== 'ready' || !group.sourcePath}
                          checked={group.selected}
                          onChange={(event) => {
                            updateGroup(index, { selected: event.target.checked })
                          }}
                        />
                      </td>
                      <td>
                        <details>
                          <summary>
                            <ChevronDown size={13} />
                            {group.files[0]?.relativePath || '重复文件'} · {group.files.length} 份
                          </summary>
                          <ul>
                            {group.files.map((file) => (
                              <li key={file.path}>{file.relativePath}</li>
                            ))}
                          </ul>
                        </details>
                        <small>每份 {formatSize(group.sizeBytes)} · 内容完全相同</small>
                      </td>
                      <td>
                        <select
                          aria-label={`${group.files[0]?.relativePath || '重复组'} 的参照文件`}
                          disabled={busy || group.state !== 'ready'}
                          value={group.sourcePath || ''}
                          onChange={(event) => {
                            updateGroup(index, {
                              sourcePath: event.target.value || undefined,
                              selected: Boolean(event.target.value)
                            })
                          }}
                        >
                          <option value="">选择参照文件…</option>
                          {group.files.map((file) => (
                            <option key={file.path} value={file.path}>
                              {file.relativePath}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>{formatSize(group.sizeBytes * (group.files.length - 1))}</td>
                      <td>
                        <span className={`dedup-status ${group.state}`}>
                          {group.message || (group.selected ? '待确认' : '本次不处理')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {scan?.warnings.map((warning) => (
            <p className="dedup-warning" key={warning}>
              {warning}
            </p>
          ))}
        </>
      )}
      {error && (
        <p className="tool-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="tool-notice" role="status">
          {notice}
        </p>
      )}
      <details className="dedup-principle">
        <summary>无损去重如何工作？</summary>
        <p>
          在同一个 APFS 卷上使用
          clonefile，让相同内容共享底层存储。每份文件仍有自己的位置，之后修改其中一份，其他文件不会跟着改变。
        </p>
      </details>
      {completed > 0 && (
        <p className="tool-notice">
          已完成 {completed} 组。原型与正式功能均不会把逻辑容量直接当成实际释放空间。
        </p>
      )}
    </div>
  )
}
