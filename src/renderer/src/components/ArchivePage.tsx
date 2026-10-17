import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import type { ArchiveItem, CatalogQuery, CatalogPage } from '../../../shared/contracts/catalog'
import { TagPicker } from './TagPicker'
import { ArchiveAction } from './ArchiveAction'

function dateBound(value: string, next = false): number | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  if (next) date.setDate(date.getDate() + 1)
  return date.getTime()
}

export function ArchivePage(): React.JSX.Element {
  const [state, setState] = useState<'archived' | 'pending'>('archived')
  const [name, setName] = useState('')
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
  const generation = useRef(0)
  const api = window.api?.catalog
  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    const current = ++generation.current
    const query: CatalogQuery = {
      state,
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
      if (current === generation.current) setPage(result)
    } catch (failure) {
      if (current === generation.current) setError(String(failure))
    }
  }, [api, name, tags, dates, offset, state])
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
  return (
    <div className="archive-page">
      <header className="archive-heading">
        <div>
          <h1>我的归档</h1>
          <p>按文件名、标签和日期找回归档文件</p>
        </div>
        <button
          disabled={busy || !api}
          onClick={() => {
            if (api) void perform(() => api.refresh())
          }}
        >
          <RefreshCw size={15} />
          刷新标签
        </button>
      </header>
      <section className="archive-filters" aria-label="检索条件">
        <label>
          记录状态
          <select
            aria-label="归档记录状态"
            value={state}
            onChange={(event) => {
              setState(event.target.value === 'pending' ? 'pending' : 'archived')
              setSelected([])
              setOffset(0)
              setTags([])
              setDates(['', '', '', ''])
            }}
          >
            <option value="archived">已归档</option>
            <option value="pending">待归档压缩结果</option>
          </select>
        </label>
        <label>
          文件名
          <input
            type="search"
            value={name}
            placeholder="搜索文件名或原文件名"
            onChange={(event) => {
              setName(event.target.value)
              setOffset(0)
            }}
          />
        </label>
        <fieldset>
          <legend>标签（全部满足）</legend>
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
        </fieldset>
        <div className="archive-date-filters">
          {['修改日期从', '修改日期至', '归档日期从', '归档日期至'].map((label, index) => (
            <label key={label}>
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
      </section>
      {error && (
        <p role="alert" className="archive-error">
          {error}
        </p>
      )}
      <div className="archive-inline">
        <span>
          共 {page.total} 个文件 · 已选 {selected.length} 个
        </span>
        <button
          disabled={!selected.length}
          onClick={() => {
            setSelected([])
          }}
        >
          清除选择
        </button>
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
      {!page.items.length && (
        <div className="archive-empty">
          <FolderOpen size={32} />
          <p>
            {name || tags.length || dates.some(Boolean)
              ? '没有符合条件的文件'
              : state === 'pending'
                ? '没有待归档的压缩结果。'
                : '还没有归档文件。压缩完成后点击“确定归档”。'}
          </p>
        </div>
      )}
      <div className="archive-list">
        {page.items.map((item) => (
          <article className="archive-row" key={item.id}>
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
            <div className="archive-file">
              <strong>{item.name}</strong>
              <small>
                原文件：{item.originalName} ·{' '}
                {item.outputBytes < 1024 * 1024
                  ? `${(item.outputBytes / 1024).toFixed(1)} KB`
                  : `${(item.outputBytes / 1024 / 1024).toFixed(2)} MB`}
              </small>
              <small>
                修改 {new Date(item.sourceModifiedAt).toLocaleDateString()} · 归档{' '}
                {item.archivedAt ? new Date(item.archivedAt).toLocaleDateString() : ''}
              </small>
              <div className="archive-tags">
                {item.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              {item.tagStatus === 'error' && (
                <small role="alert">标签待同步：{item.tagError}</small>
              )}
            </div>
            {state === 'pending' ? (
              <ArchiveAction key={item.id} record={item} />
            ) : (
              <div className="archive-row-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    if (api) void perform(() => api.open(item.id))
                  }}
                >
                  打开
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (api) void perform(() => api.reveal(item.id))
                  }}
                >
                  在 Finder 中显示
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditing(item)
                    setEditedTags(item.tags)
                  }}
                >
                  编辑标签
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="archive-pagination">
        <button
          disabled={offset === 0}
          onClick={() => {
            setOffset(Math.max(0, offset - 50))
          }}
        >
          上一页
        </button>
        <span>第 {Math.floor(offset / 50) + 1} 页</span>
        <button
          disabled={offset + 50 >= page.total}
          onClick={() => {
            setOffset(offset + 50)
          }}
        >
          下一页
        </button>
      </div>
      {editing && (
        <section
          className="archive-editor"
          role="dialog"
          aria-label="编辑文件标签"
          aria-modal="false"
        >
          <h2>{editing.originalName}</h2>
          <TagPicker
            value={editedTags}
            onChange={setEditedTags}
            options={page.tags}
            disabled={busy}
          />
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
        </section>
      )}
    </div>
  )
}
