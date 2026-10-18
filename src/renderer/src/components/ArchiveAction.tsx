import { useEffect, useState } from 'react'
import type { ArchiveItem, CompressionRecord } from '../../../shared/contracts/catalog'
import { TagPicker } from './TagPicker'

export function ArchiveAction({ record }: { record: CompressionRecord }): React.JSX.Element {
  const [item, setItem] = useState<ArchiveItem | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [keepLink, setKeepLink] = useState(false)
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
          setKeepLink(Boolean(value.originalLink))
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
        ) : item?.backupStatus === 'trashed' ? (
          '原件备份已移入回收站，压缩结果仍可归档。'
        ) : item?.backupStatus === 'cleanup-unknown' ? (
          (item.backupError ?? '原件备份清理结果待核对。')
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
          {item.automaticTags?.status === 'error' && (
            <p role="alert">文件已归档，AI 标签生成失败：{item.automaticTags.error}</p>
          )}
          {item.originalLink && (
            <div>
              <p role={item.originalLink.status === 'error' ? 'alert' : 'status'}>
                {item.originalLink.status === 'ready'
                  ? '原位置访问入口已创建：'
                  : item.originalLink.status === 'error'
                    ? `归档已完成，原位置入口未创建：${item.originalLink.error ?? ''}`
                    : '原位置入口待创建：'}
                <span className="archive-path">{item.originalLink.path}</span>
              </p>
              {item.originalLink.status !== 'ready' && (
                <button
                  disabled={busy || !api}
                  onClick={() => {
                    if (api)
                      void perform(() =>
                        api.archive(record.id, [], { keepLinkAtOriginalLocation: true })
                      )
                  }}
                >
                  重试原位置入口
                </button>
              )}
            </div>
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
          <label className="archive-link-option">
            <input
              type="checkbox"
              checked={keepLink}
              disabled={busy || !api || !item}
              onChange={(event) => {
                setKeepLink(event.target.checked)
              }}
            />
            在原位置保留访问入口（试用）
          </label>
          {keepLink && (
            <small>入口指向正式归档文件。格式转换时使用新扩展名；原位置已有文件时不会覆盖。</small>
          )}
          <button
            className="archive-primary"
            disabled={
              !api ||
              !item ||
              busy ||
              item.backupStatus === 'error' ||
              item.backupStatus === 'cleanup-pending' ||
              item.backupStatus === 'pending'
            }
            onClick={() => {
              if (api)
                void perform(() =>
                  api.archive(record.id, tags, { keepLinkAtOriginalLocation: keepLink })
                )
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
