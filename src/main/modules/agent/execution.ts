import { stripVTControlCharacters } from 'node:util'
import type { AgentToolActivity } from '../../../shared/contracts/agent'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export function boundedText(value: string, limit = 8192): string {
  const text = stripVTControlCharacters(value).replace(/\r/g, '')
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text
}

function resultText(value: unknown): string {
  const content = object(value).content
  return Array.isArray(content)
    ? content
        .flatMap((part: unknown) => {
          const entry = object(part)
          return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
        })
        .join('\n')
    : ''
}

/** Display facts from the tool boundary, independently of the model's later answer. */
export function toolResult(
  name: string,
  value: unknown,
  isError: boolean
): NonNullable<AgentToolActivity['result']> {
  const raw = resultText(value)
  const details = object(object(value).details)
  if (isError)
    return {
      title: '工具执行失败',
      summary: '请查看错误详情；已执行的操作不会自动回滚。',
      details: boundedText(raw)
    }
  if (name === 'mole_authorize_system') {
    return {
      title: details.authorized === true ? '本次授权成功' : '本次授权未成功',
      summary:
        details.authorized === true
          ? `已${details.method === 'cached' ? '复用缓存凭据' : '通过原生密码对话框授权'}。授权可能过期；未验证预览实际使用了系统权限。`
          : '未建立系统权限授权。',
      details: boundedText(raw)
    }
  }
  if (['mole_clean_preview', 'mole_installer_preview', 'mole_purge_preview'].includes(name)) {
    const incomplete =
      details.stdoutTruncated === true ||
      details.stderrTruncated === true ||
      details.incomplete === true
    const success = details.exitCode === 0 && !details.signal && !incomplete
    return {
      title: success ? '预览已完成' : '预览结果不完整',
      summary: `${Array.isArray(details.candidates) ? `返回 ${String(details.candidates.length)} 个候选。` : ''}未执行删除。${name === 'mole_clean_preview' ? '系统权限是否实际用于扫描：未验证。' : ''}${incomplete ? '输出有截断，请查看详情。' : ''}`,
      details: boundedText(raw)
    }
  }
  return {
    title: '工具已返回',
    summary: '请核对返回结果中的状态及未完成项目。',
    details: boundedText(raw)
  }
}

export function toolProgress(value: unknown, previous: AgentToolActivity): AgentToolActivity {
  const details = object(object(value).details)
  const event = object(details.progress)
  if (event.type === 'stage' && typeof event.title === 'string')
    return { ...previous, stage: boundedText(event.title, 200) }
  const block = object(event.block)
  const text =
    event.type === 'block' && typeof block.text === 'string' ? block.text : resultText(value)
  if (!text) return previous
  return { ...previous, logs: [...(previous.logs ?? []), boundedText(text, 1024)].slice(-24) }
}
