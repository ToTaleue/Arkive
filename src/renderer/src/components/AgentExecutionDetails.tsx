import { CheckCircle2, CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react'
import type { AgentExecution } from '../../../shared/contracts/agent'
import '../assets/chat-execution.css'

const phaseLabels: Record<AgentExecution['phase'], string> = {
  responding: '正在回复…',
  executing: '正在执行工具…',
  summarizing: '工具已返回，正在生成总结…',
  completed: '回复完成',
  'summary-error': '工具结果已保留，总结生成失败',
  cancelled: '已停止',
  error: '回复失败'
}

const toolStatusLabels = {
  running: '执行中',
  completed: '已完成',
  error: '执行失败',
  stopped: '已停止，请核对实际结果'
}

export function AgentExecutionDetails({
  execution
}: {
  execution: AgentExecution
}): React.JSX.Element {
  const active = ['responding', 'executing', 'summarizing'].includes(execution.phase)
  return (
    <div className="chat-execution" data-phase={execution.phase}>
      {execution.tools.length > 0 ? (
        <details className="chat-tool-activity" open={active}>
          <summary>
            <span>执行过程 · {execution.tools.length} 项工具操作</span>
            <span className="chat-execution-phase" role="status">
              {phaseLabels[execution.phase]}
            </span>
          </summary>
          <ol aria-label="工具执行状态">
            {execution.tools.map((tool) => (
              <li key={tool.id} data-status={tool.status}>
                <div className="chat-tool-heading">
                  <code>{tool.name}</code>
                  <span>{toolStatusLabels[tool.status]}</span>
                </div>
                {tool.stage && <p className="chat-tool-stage">{tool.stage}</p>}
                {Boolean(tool.logs?.length) && (
                  <pre className="chat-tool-log" aria-label={`${tool.name} 执行输出`}>
                    {tool.logs?.join('\n')}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </details>
      ) : (
        <p className="chat-execution-phase" role="status">
          {active && <LoaderCircle size={13} aria-hidden="true" />}
          {phaseLabels[execution.phase]}
        </p>
      )}
      <div className="chat-tool-results">
        {execution.tools.map((tool) =>
          tool.result ? (
            <section
              className="chat-tool-result"
              aria-label={`${tool.name} 工具结果`}
              data-tool-id={tool.id}
              data-status={tool.status}
              key={tool.id}
            >
              <div className="chat-tool-result-title">
                {tool.status === 'completed' ? (
                  <CheckCircle2 size={15} aria-hidden="true" />
                ) : (
                  <CircleAlert size={15} aria-hidden="true" />
                )}
                <code className="chat-tool-result-tool">{tool.name}</code>
                <strong>{tool.result.title}</strong>
              </div>
              <p>{tool.result.summary}</p>
              {tool.result.details && (
                <details className="chat-tool-result-details">
                  <summary>查看结果详情</summary>
                  <pre>{tool.result.details}</pre>
                </details>
              )}
            </section>
          ) : null
        )}
      </div>
    </div>
  )
}

export function AgentExecutionError({
  execution,
  retryDisabled,
  onRetry
}: {
  execution: AgentExecution
  retryDisabled: boolean
  onRetry: () => void
}): React.JSX.Element | null {
  if (execution.phase !== 'summary-error' && execution.phase !== 'error') return null
  return (
    <div className="chat-summary-error" role="alert">
      <p>{execution.error ?? '本次回复未完成，请重试。'}</p>
      {execution.phase === 'summary-error' && (
        <div className="chat-summary-retry">
          <button type="button" onClick={onRetry} disabled={retryDisabled}>
            <RotateCcw size={13} aria-hidden="true" />
            重新生成总结
          </button>
          <span>使用已有工具结果，不会再次执行操作</span>
        </div>
      )}
    </div>
  )
}
