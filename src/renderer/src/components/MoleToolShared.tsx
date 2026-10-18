import type { ReactNode } from 'react'
import { Check, FileText, LoaderCircle, Square, TriangleAlert } from 'lucide-react'
import type { MoleOutputBlock } from '../../../shared/contracts/mole'
import type { useMoleToolRun } from './useMoleToolRun'

export function MoleToolHeading({
  title,
  engine,
  children
}: {
  title: string
  engine: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <header className="mole-tool-heading">
      <p className="toolbox-eyebrow">工具箱 / Mole {engine}</p>
      <h1>{title}</h1>
      <p>{children}</p>
    </header>
  )
}

export function MoleToolHero({
  title,
  label,
  value,
  warning = false,
  actions,
  children
}: {
  title: string
  label: string
  value: ReactNode
  warning?: boolean
  actions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className={`mole-tool-hero${warning ? ' warning' : ''}`} role="status">
      <div className="mole-tool-hero-icon">
        {warning ? (
          <TriangleAlert size={28} strokeWidth={1.5} />
        ) : (
          <Check size={28} strokeWidth={1.5} />
        )}
      </div>
      <div>
        <h2>{title}</h2>
        <div className="mole-tool-measure">
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
        <p>{children}</p>
        {actions}
      </div>
    </section>
  )
}

export function MoleToolFeedback({
  run
}: {
  run: ReturnType<typeof useMoleToolRun>
}): React.JSX.Element {
  return (
    <>
      {run.busy && (
        <div className="mole-tool-running" role="status">
          <LoaderCircle className="mole-tool-spin" size={16} />
          <span>{run.progress}</span>
          <button
            className="mole-tool-button"
            disabled={run.stopping}
            onClick={() => void run.stop()}
          >
            <Square size={11} />
            {run.stopping ? '正在停止…' : '停止'}
          </button>
        </div>
      )}
      {run.error && (
        <p className="mole-tool-error" role="alert">
          {run.error}
        </p>
      )}
      {run.notice && (
        <p className="mole-tool-note" role="status">
          {run.notice}
        </p>
      )}
    </>
  )
}

export function MoleToolLogs({
  blocks,
  text
}: {
  blocks?: MoleOutputBlock[]
  text?: string
}): React.JSX.Element | null {
  if (!blocks?.length && !text) return null
  return (
    <details className="mole-tool-logs">
      <summary>
        <FileText size={13} />
        运行记录 · 查看原始输出
      </summary>
      {blocks?.map((block) => (
        <pre key={block.id} className={block.source === 'stderr' ? 'stderr' : ''}>
          {block.continued ? '' : `${block.title}${block.partial ? '（输出不完整）' : ''}\n`}
          {block.text}
        </pre>
      ))}
      {text && <pre>{text}</pre>}
    </details>
  )
}
