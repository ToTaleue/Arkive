import { useState } from 'react'
import { presetTags } from '../../../shared/contracts/catalog'

export function TagPicker({
  value,
  onChange,
  options = presetTags,
  disabled = false
}: {
  value: string[]
  onChange: (tags: string[]) => void
  options?: string[]
  disabled?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  function add(): void {
    const tags = draft
      .split(/[,，]/u)
      .map((tag) => tag.trim().normalize('NFC'))
      .filter(Boolean)
    onChange([...new Set([...value, ...tags])])
    setDraft('')
  }
  return (
    <div className="archive-tag-picker">
      <div className="archive-tags">
        {[...new Set([...options, ...value])].map((tag) => (
          <label key={tag}>
            <input
              type="checkbox"
              checked={value.includes(tag)}
              disabled={disabled}
              onChange={() => {
                onChange(
                  value.includes(tag) ? value.filter((entry) => entry !== tag) : [...value, tag]
                )
              }}
            />
            {tag}
          </label>
        ))}
      </div>
      <div className="archive-inline">
        <input
          aria-label="自定义标签"
          value={draft}
          maxLength={100}
          disabled={disabled}
          placeholder="新标签，多个用逗号分隔"
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <button type="button" disabled={disabled || !draft.trim()} onClick={add}>
          添加标签
        </button>
      </div>
    </div>
  )
}
