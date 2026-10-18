import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  File,
  FolderOpen,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  X
} from 'lucide-react'
import type {
  ArchiveItem,
  CatalogQuery,
  CatalogPage,
  BackupCleanupResult
} from '../../../shared/contracts/catalog'
import { TagPicker } from './TagPicker'
import { ArchiveAction } from './ArchiveAction'

function dateBound(value: string, next = false): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  if (next) date.setDate(date.getDate() + 1)
  return date.getTime()
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}
function formatDate(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleDateString() : '—'
}

export function ArchivePage(): React.JSX.Element {
  const [state, setState] = useState<'archived' | 'pending' | 'backup'>('archived')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<CatalogQuery['kind']>()
  const [loading, setLoading] = useState(true)
  const [tags, setTags] = useState<string[]>([])
  const [dates, setDates] = useState(['', '', '', ''])
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<CatalogPage>({ items: [], tags: [], total: 0 })
  const [selected, setSelected] = useState<string[]>([])
  const [batchTags, setBatchTags] = useState<string[]>([])
  const [editing, setEditing] = useState<ArchiveItem | null>(null)
  const [editedTags, setEditedTags] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cleanupResult, setCleanupResult] = useState<BackupCleanupResult | null>(null)
  const [compact, setCompact] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [datesOpen, setDatesOpen] = useState(false)
  const [detail, setDetail] = useState<ArchiveItem | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const detailDialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (detail && !detailDialog.current?.open) detailDialog.current?.showModal()
  }, [detail])
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        searchInput.current?.getClientRects().length &&
        !detailDialog.current?.open
      ) {
        event.preventDefault()
        searchInput.current.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
    }
  }, [])
  useEffect(() => {
    if (detail && state === 'pending' && !page.items.some((item) => item.id === detail.id)) {
      detailDialog.current?.close()
    }
  }, [detail, page, state])
  const generation = useRef(0)
  const api = window.api?.catalog
  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    const current = ++generation.current
    setLoading(true)
    const query: CatalogQuery = {
      state,
      kind,
      name,
      tags,
      offset,
      modifiedFrom: dateBound(dates[0]),
      modifiedTo: dateBound(dates[1], true),
      archivedFrom: dateBound(dates[2]),
      archivedTo: dateBound(dates[3], true)
    }
    try {
      const result = await api.query(query)
      if (current === generation.current) {
        setPage(result)
        setError('')
      }
    } catch (failure) {
      if (current === generation.current) setError(String(failure))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [api, name, tags, dates, offset, state, kind])
  useEffect(() => {
    generation.current++
    const timer = setTimeout(() => {
      void load()
    }, 180)
    const unsubscribe = api?.onChanged(() => {
      void load()
    })
    return () => {
      clearTimeout(timer)
      unsubscribe?.()
    }
  }, [api, load])
  async function perform(operation: () => Promise<unknown>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
      await load()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  const isBackup = state === 'backup'
  const filtered = Boolean(name || kind || tags.length || dates.some(Boolean))
  const detailItem = detail ? (page.items.find((item) => item.id === detail.id) ?? detail) : null
  function clearFilters(): void {
    setName('')
    setKind(undefined)
    setTags([])
    setDates(['', '', '', ''])
    setOffset(0)
  }
  function changeState(next: 'archived' | 'backup' | 'pending'): void {
    setState(next)
    setLoading(true)
    setPage((current) => ({ ...current, items: [], total: 0 }))
    setSelected([])
    setEditing(null)
    setDetail(null)
    clearFilters()
  }
  function closeDetail(): void {
    detailDialog.current?.close()
    setDetail(null)
    setEditing(null)
  }
  return (
    <div className="archive-page" data-compact={compact}>
      <section className="archive-discovery" aria-label="归档概览">
        <header className="archive-heading">
          <div>
            <p className="archive-eyebrow">ARKIVE / 文件收藏</p>
            <h1>我的归档</h1>
            <p className="archive-intro">留得住，也找得到。</p>
          </div>
          <div className="archive-heading-actions">
            <button
              onClick={() => {
                setCompact(!compact)
              }}
              aria-expanded={!compact}
              aria-controls="archive-intro"
              className="archive-density-toggle"
            >
              {compact ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              {compact ? '展开概览' : '收起顶部'}
            </button>
          </div>
        </header>
        <p id="archive-intro" className="archive-overview-copy" hidden={compact}>
          归档收好压缩结果，备份保留完整原件。随时搜索，随时找回。
        </p>
        <section className="archive-controls" aria-label="检索条件">
          <label className="archive-search">
            <Search size={20} aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              aria-label="搜索归档"
              value={name}
              placeholder="搜索文件名、原文件名或标签"
              onChange={(event) => {
                setName(event.target.value)
                setOffset(0)
              }}
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="archive-toolbar">
            <div className="archive-segments" aria-label="归档状态">
              <button
                aria-pressed={state === 'archived'}
                onClick={() => {
                  changeState('archived')
                }}
              >
                已归档
              </button>
              <button
                aria-pressed={isBackup || state === 'pending'}
                onClick={() => {
                  changeState('backup')
                }}
              >
                备份
              </button>
            </div>
            <label className="archive-kind-filter">
              类型
              <select
                aria-label="文件类型"
                value={kind ?? 'all'}
                onChange={(event) => {
                  const value = event.target.value
                  setKind(
                    value === 'video' || value === 'image' || value === 'document'
                      ? value
                      : undefined
                  )
                  setOffset(0)
                }}
              >
                <option value="all">所有文件</option>
                <option value="video">视频</option>
                <option value="image">图片</option>
                <option value="document">文档</option>
              </select>
            </label>
            <button
              className="archive-filter-toggle"
              aria-expanded={tagsOpen}
              aria-controls="archive-tag-filters"
              onClick={() => {
                setTagsOpen(!tagsOpen)
              }}
            >
              <Tags size={14} />
              标签
              {tags.length ? ` · 已选 ${String(tags.length)}` : ` · ${String(page.tags.length)}`}
              <ChevronDown size={13} className={tagsOpen ? 'rotated' : ''} />
            </button>
            <button
              aria-expanded={datesOpen}
              aria-controls="archive-date-filters"
              onClick={() => {
                setDatesOpen(!datesOpen)
              }}
            >
              <CalendarDays size={14} />
              日期{dates.some(Boolean) ? ' · 已筛选' : ''}
            </button>
            {filtered && <button onClick={clearFilters}>清除筛选</button>}
            <button
              className="archive-refresh"
              disabled={busy || !api}
              onClick={() => {
                if (api) void perform(() => api.refresh())
              }}
            >
              <RefreshCw size={14} />
              刷新标签
            </button>
          </div>
          <section
            id="archive-tag-filters"
            className="archive-tag-filter"
            aria-label="按标签筛选"
            hidden={!tagsOpen}
          >
            <p>标签 · 同时满足已选标签</p>
            <div className="archive-tags">
              {page.tags.map((tag) => (
                <label key={tag}>
                  <input
                    type="checkbox"
                    checked={tags.includes(tag)}
                    onChange={() => {
                      setTags(
                        tags.includes(tag) ? tags.filter((value) => value !== tag) : [...tags, tag]
                      )
                      setOffset(0)
                    }}
                  />
                  {tag}
                </label>
              ))}
            </div>
          </section>
          {!tagsOpen && tags.length > 0 && (
            <div className="archive-active-tags">
              {tags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => {
                    setTags(tags.filter((value) => value !== tag))
                    setOffset(0)
                  }}
                >
                  {tag}
                  <X size={12} />
                  <span className="sr-only">移除标签筛选</span>
                </button>
              ))}
            </div>
          )}
          <div id="archive-date-filters" className="archive-date-filters" hidden={!datesOpen}>
            {[
              '修改日期从',
              '修改日期至',
              isBackup ? '备份日期从' : '归档日期从',
              isBackup ? '备份日期至' : '归档日期至'
            ].map((label, index) => (
              <label key={index}>
                {label}
                <input
                  type="date"
                  value={dates[index]}
                  onChange={(event) => {
                    setDates(dates.map((date, i) => (i === index ? event.target.value : date)))
                    setOffset(0)
                  }}
                />
              </label>
            ))}
          </div>
          {(isBackup || state === 'pending') && (
            <div className="archive-backup-view">
              <span>
                {isBackup
                  ? '完整原件备份，包含已归档文件的原件。'
                  : '这些压缩结果尚未归档，原件状态见详情。'}
              </span>
              <button
                onClick={() => {
                  changeState(isBackup ? 'pending' : 'backup')
                }}
              >
                {isBackup ? '查看待归档结果' : '返回原件备份'}
              </button>
            </div>
          )}
        </section>
      </section>
      {error && (
        <p role="alert" className="archive-error">
          {error}
        </p>
      )}
      <section className="archive-results" aria-label="文件列表" aria-busy={loading}>
        {isBackup && (
          <section className="archive-backup-cleanup" aria-label="清理原件备份">
            <div className="archive-cleanup-toolbar">
              <div className="archive-cleanup-copy">
                <span className="archive-cleanup-title">
                  <Trash2 size={14} aria-hidden="true" />
                  清理原件备份
                </span>
                <p>按备份时间，覆盖全部备份；移入回收站仍占空间。</p>
              </div>
              <div className="archive-cleanup-actions" role="group" aria-label="选择备份清理范围">
                {([7, 3, 0] as const).map((days) => (
                  <button
                    key={days}
                    className={days === 0 ? 'archive-cleanup-all' : 'archive-cleanup-period'}
                    aria-label={
                      days === 0 ? '清理所有 Backup' : `清理 ${String(days)} 天前的 Backup`
                    }
                    disabled={busy || !api}
                    onClick={() => {
                      if (api)
                        void perform(async () => {
                          setCleanupResult(null)
                          const result = await api.cleanupBackups(days)
                          if (!result.cancelled) {
                            setCleanupResult(result)
                            setSelected([])
                            setOffset(0)
                            closeDetail()
                          }
                        })
                    }}
                  >
                    {days === 0 ? '清理全部' : `${String(days)} 天前`}
                  </button>
                ))}
              </div>
            </div>
            {busy && <p role="status">正在确认或清理备份，请稍候…</p>}
            {cleanupResult && (
              <div role="status" aria-live="polite">
                <p>
                  已移入回收站 {cleanupResult.trashed} 项（{formatBytes(cleanupResult.trashedBytes)}
                  ），未清理 {cleanupResult.issues.length} 项。
                  {!cleanupResult.trashed &&
                    !cleanupResult.issues.length &&
                    '没有符合时间范围的备份。'}
                </p>
                {cleanupResult.issues.length > 0 && (
                  <details>
                    <summary>查看未清理原因（可重新点击按钮重试）</summary>
                    <ul>
                      {cleanupResult.issues.map((issue) => (
                        <li key={issue.id}>
                          {issue.name}：{issue.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>
        )}
        <div className="archive-list-head">
          <span role="status" aria-live="polite">
            {state === 'pending' ? '待归档结果' : isBackup ? '原件备份' : '已归档'} · 共{' '}
            {page.total} 个文件{selected.length > 0 ? ` · 已选 ${String(selected.length)} 个` : ''}
          </span>
          {selected.length > 0 ? (
            <button
              onClick={() => {
                setSelected([])
              }}
            >
              清除选择
            </button>
          ) : (
            <span>点击文件名查看详情</span>
          )}
        </div>
        {selected.length > 0 && state === 'archived' && (
          <section className="archive-batch" aria-label="批量添加标签">
            <h2>给选中文件添加公共标签</h2>
            <TagPicker
              value={batchTags}
              onChange={setBatchTags}
              options={page.tags}
              disabled={busy}
            />
            <button
              disabled={busy || !batchTags.length || !api}
              onClick={() => {
                if (api)
                  void perform(async () => {
                    await api.tags(selected, batchTags, [])
                    setBatchTags([])
                  })
              }}
            >
              应用到 {selected.length} 个文件
            </button>
          </section>
        )}
        {loading && (
          <p className="archive-loading" role="status">
            正在读取文件…
          </p>
        )}
        <div className="archive-table-scroll">
          <table className="archive-table">
            <thead>
              <tr>
                <th className="archive-select-column">
                  <span className="sr-only">选择</span>
                </th>
                <th>文件 / 原文件名</th>
                <th>标签</th>
                <th>{isBackup ? '原件体积' : '归档体积'}</th>
                <th>{isBackup ? '备份时间' : state === 'pending' ? '修改时间' : '归档时间'}</th>
                <th>原件</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr className="archive-row" key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.name}`}
                      checked={selected.includes(item.id)}
                      onChange={() => {
                        setSelected(
                          selected.includes(item.id)
                            ? selected.filter((id) => id !== item.id)
                            : [...selected, item.id].slice(0, 100)
                        )
                      }}
                    />
                  </td>
                  <td>
                    <button
                      className="archive-file-button"
                      onClick={() => {
                        setDetail(item)
                      }}
                    >
                      <File size={19} />
                      <span>
                        <strong>{isBackup ? item.originalName : item.name}</strong>
                        <small>{isBackup ? `压缩结果：${item.name}` : item.originalName}</small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <div className="archive-tags archive-row-tags">
                      {item.tags.slice(0, 2).map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                      {item.tags.length > 2 && (
                        <button
                          title={item.tags.join('、')}
                          onClick={() => {
                            setDetail(item)
                          }}
                        >
                          +{item.tags.length - 2}
                        </button>
                      )}
                      {!item.tags.length && <span className="archive-no-tag">—</span>}
                    </div>
                  </td>
                  <td className="archive-numeric">
                    {formatBytes(isBackup ? item.sourceBytes : item.outputBytes)}
                  </td>
                  <td className="archive-date">
                    {formatDate(
                      isBackup
                        ? item.backedUpAt
                        : state === 'pending'
                          ? item.sourceModifiedAt
                          : item.archivedAt
                    )}
                  </td>
                  <td>
                    <span
                      className={`archive-original-status ${item.backupStatus === 'error' ? 'has-error' : ''}`}
                    >
                      {item.backupStatus === 'ready'
                        ? '已备份'
                        : item.backupStatus === 'trashed'
                          ? '已移入回收站'
                          : item.backupStatus === 'cleanup-unknown'
                            ? '清理待核对'
                            : item.backupStatus === 'cleanup-pending'
                              ? '清理中'
                              : item.backupStatus === 'skipped'
                                ? '原位保留'
                                : item.backupStatus === 'error'
                                  ? '备份待处理'
                                  : '备份中'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="archive-row-detail"
                      aria-label={`查看 ${item.name} 详情`}
                      onClick={() => {
                        setDetail(item)
                      }}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && !page.items.length && (
          <div className="archive-empty">
            <FolderOpen size={36} />
            <h2>
              {filtered
                ? '没有找到匹配文件'
                : isBackup
                  ? '还没有原件备份'
                  : state === 'pending'
                    ? '没有待归档的结果'
                    : '还没有归档文件'}
            </h2>
            <p>
              {filtered
                ? '试试更短的文件名，或清除标签和日期条件。'
                : isBackup
                  ? '压缩产生收益后，完整原件会保存在这里。'
                  : '压缩完成后点击“确定归档”，之后就能在这里找回。'}
            </p>
            {filtered && <button onClick={clearFilters}>清除筛选</button>}
          </div>
        )}
        {page.total > 50 && (
          <div className="archive-pagination">
            <button
              disabled={offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - 50))
                setSelected([])
              }}
            >
              上一页
            </button>
            <span>第 {Math.floor(offset / 50) + 1} 页</span>
            <button
              disabled={offset + 50 >= page.total}
              onClick={() => {
                setOffset(offset + 50)
                setSelected([])
              }}
            >
              下一页
            </button>
          </div>
        )}
        <footer className="archive-catalog-footer">
          只展示 Arkive 的{isBackup ? '原件备份' : '处理'}记录。支持搜索文件名、原文件名和标签。
        </footer>
      </section>
      <dialog
        ref={detailDialog}
        className="archive-detail-dialog"
        aria-label="文件详情"
        onClose={() => {
          setDetail(null)
          setEditing(null)
        }}
      >
        {detailItem && (
          <>
            <header className="archive-detail-heading">
              <h2>{isBackup ? detailItem.originalName : detailItem.name}</h2>
              <button aria-label="关闭文件详情" onClick={closeDetail}>
                <X size={18} />
              </button>
            </header>
            <dl className="archive-metadata">
              <dt>原文件</dt>
              <dd>{detailItem.originalName}</dd>
              <dt>修改时间</dt>
              <dd>{new Date(detailItem.sourceModifiedAt).toLocaleString()}</dd>
              <dt>{isBackup ? '备份位置' : '文件位置'}</dt>
              <dd>
                {isBackup
                  ? detailItem.backupPath
                  : (detailItem.archivePath ?? detailItem.outputPath)}
              </dd>
              <dt>标签</dt>
              <dd>{detailItem.tags.join('、') || '暂无标签'}</dd>
            </dl>
            {detailItem.tagStatus === 'error' && (
              <p role="alert">标签待同步：{detailItem.tagError}</p>
            )}
            {detailItem.backupError && <p role="alert">{detailItem.backupError}</p>}
            {detailItem.originalLink && (
              <p className="archive-path">
                {detailItem.originalLink.status === 'ready'
                  ? '原位置入口：'
                  : `原位置入口未完成：${detailItem.originalLink.error ?? '待创建'} · `}
                {detailItem.originalLink.path}
              </p>
            )}
            {state === 'pending' && <ArchiveAction key={detailItem.id} record={detailItem} />}
            {state !== 'pending' && (
              <div className="archive-row-actions">
                <button
                  disabled={busy || !api || (isBackup && detailItem.backupStatus !== 'ready')}
                  onClick={() => {
                    if (api)
                      void perform(() => api.open(detailItem.id, isBackup ? 'backup' : 'archive'))
                  }}
                >
                  打开{isBackup ? '原件' : '文件'}
                </button>
                <button
                  disabled={busy || !api || (isBackup && detailItem.backupStatus !== 'ready')}
                  onClick={() => {
                    if (api)
                      void perform(() => api.reveal(detailItem.id, isBackup ? 'backup' : 'archive'))
                  }}
                >
                  在 Finder 中显示
                </button>
                {!isBackup && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(detailItem)
                      setEditedTags(detailItem.tags)
                    }}
                  >
                    编辑标签
                  </button>
                )}
                {!isBackup &&
                  detailItem.originalLink &&
                  detailItem.originalLink.status !== 'ready' && (
                    <button
                      disabled={busy || !api}
                      onClick={() => {
                        if (api)
                          void perform(() =>
                            api.archive(detailItem.id, [], { keepLinkAtOriginalLocation: true })
                          )
                      }}
                    >
                      重试原位置入口
                    </button>
                  )}
              </div>
            )}
            {editing && (
              <section className="archive-editor" aria-label="编辑文件标签">
                <h2>编辑标签</h2>
                <TagPicker
                  value={editedTags}
                  onChange={setEditedTags}
                  options={page.tags}
                  disabled={busy}
                />
                <div className="archive-inline">
                  <button
                    disabled={busy || !api}
                    onClick={() => {
                      if (api)
                        void perform(async () => {
                          await api.tags(
                            [editing.id],
                            editedTags.filter((tag) => !editing.tags.includes(tag)),
                            editing.tags.filter((tag) => !editedTags.includes(tag))
                          )
                          setEditing(null)
                        })
                    }}
                  >
                    保存标签
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(null)
                    }}
                  >
                    取消
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </dialog>
    </div>
  )
}
