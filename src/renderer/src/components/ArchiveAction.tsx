import { useEffect, useState } from 'react'
import type { ArchiveItem, CompressionRecord } from '../../../shared/contracts/catalog'
import { TagPicker } from './TagPicker'

export function ArchiveAction({ record }: { record: CompressionRecord }): React.JSX.Element {
  const [item, setItem] = useState<ArchiveItem | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.api?.catalog
  useEffect(() => {
    let active = true
    if (!api) return
    void api
      .get(record.id)
      .then((value) => {
        if (active) {
          setItem(value)
          setTags(value.tags)
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure))
      })
    return () => {
      active = false
    }
  }, [api, record.id])
  async function perform(operation: () => Promise<ArchiveItem>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      setItem(await operation())
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="archive-action">
      <p>
        {item?.backupStatus === 'ready' ? (
          <>
            原件已移入备份目录：<span className="archive-path">{item.backupPath}</span>
          </>
        ) : item?.backupStatus === 'skipped' ? (
          '本次无体积收益，原件保留在原位置。'
        ) : item?.backupStatus === 'error' ? (
          `原件备份未完成：${item.backupError ?? ''}`
        ) : (
          '正在读取备份状态…'
        )}
      </p>
      {api && item?.backupStatus === 'error' && (
        <button disabled={busy} onClick={() => void perform(() => api.retryBackup(record.id))}>
          重试原件备份
        </button>
      )}
      {item?.archivePath ? (
        <>
          <p>
            已归档：<span className="archive-path">{item.archivePath}</span>
          </p>
          {item.tagStatus === 'error' && (
            <p role="alert">文件已归档，标签待同步：{item.tagError}</p>
          )}
          <button
            disabled={busy}
            onClick={() => {
              if (api)
                void perform(async () => {
                  await api.refresh()
                  return api.get(record.id)
                })
            }}
          >
            刷新标签状态
          </button>
        </>
      ) : (
        <>
          <details>
            <summary>归档标签（可选）</summary>
            <TagPicker value={tags} onChange={setTags} disabled={busy} />
          </details>
          <button
            className="archive-primary"
            disabled={
              !api ||
              !item ||
              busy ||
              item.backupStatus === 'error' ||
              item.backupStatus === 'pending'
            }
            onClick={() => {
              if (api) void perform(() => api.archive(record.id, tags))
            }}
          >
            {busy ? '处理中…' : '确定归档'}
          </button>
          <small>复制压缩结果到归档目录，当前输出仍保留。</small>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
