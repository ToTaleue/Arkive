import { stripVTControlCharacters } from 'node:util'
import type { AgentExecution, AgentToolActivity } from '../../../shared/contracts/agent'

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

function formatBytes(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  if (value < 1024) return `${String(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = units[0]
  for (const candidate of units) {
    size /= 1024
    unit = candidate
    if (size < 1024 || candidate === units.at(-1)) break
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`
}

const nativeFileTools = new Set(['read', 'grep', 'find', 'ls'])

function nativeToolSummary(name: string, raw: string): string | undefined {
  if (!nativeFileTools.has(name)) return undefined
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (name === 'grep') {
    if (lines.some((line) => /^no matches found$/i.test(line))) return '无匹配内容。'
    const limit = raw.match(/\[(\d+)\s+(?:match|matches)\s+limit reached/i)
    const count =
      limit?.[1] ?? String(lines.filter((line) => !/^\[.*limit reached/i.test(line)).length)
    return `返回 ${count} 条匹配结果${limit ? '，已达到结果上限，请缩小范围或继续分页。' : '。'}`
  }
  const more = raw.match(/\[(\d+)\s+more lines? in file\.\s+Use offset=(\d+)/i)
  const readMarker = raw.search(/\[\d+\s+more lines? in file\.\s+Use offset=\d+/i)
  const readBody = readMarker >= 0 ? raw.slice(0, readMarker) : raw
  const readContent = readMarker >= 0 ? readBody.replace(/\n{2}$/, '') : readBody
  const visible = readContent.length === 0 ? 0 : readContent.split('\n').length
  if (name === 'read')
    return `返回 ${String(visible)} 行${more ? `，还有 ${more[1]} 行，可用 offset=${more[2]} 继续读取。` : '。'}`
  const listedLines = lines.filter(
    (line) => !/^\[.*(?:more lines|内容已截断|limit reached)/i.test(line)
  )
  const truncated = /(?:内容已截断|limit reached|Use limit=|结果已截断)/i.test(raw)
  return `返回约 ${String(listedLines.length)} 项${truncated ? '，结果已截断，请缩小范围或继续分页。' : '。'}`
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
      summary: `${Array.isArray(details.candidates) ? `返回 ${String(details.candidates.length)} 个候选。` : ''}未执行删除。${name === 'mole_clean_preview' ? '系统权限是否实际用于扫描：未验证。' : ''}${incomplete ? '输出有截断，请查看详情。' : details.outputExcerpted === true ? '日志为摘录。' : ''}`,
      details: boundedText(raw)
    }
  }
  if (name === 'mole_uninstall_preview') {
    return {
      title: '卸载范围已检查',
      summary: `返回 ${Array.isArray(details.candidates) ? String(details.candidates.length) : '0'} 个候选。未执行删除；应用数据默认保留，系统级残留仅供审阅。`,
      details: boundedText(raw)
    }
  }
  if (name === 'mole_clean') {
    const status = details.status
    return {
      title:
        status === 'completed'
          ? 'Mole 清理已完成'
          : status === 'authorization-required'
            ? '需要重新授权'
            : status === 'cancelled'
              ? '清理已停止'
              : '清理未正常完成',
      summary:
        status === 'authorization-required'
          ? '本次未启动清理。'
          : '按 Mole 规则直接删除；请核对实际日志，已删除内容不会自动恢复。',
      details: boundedText(raw)
    }
  }
  if (['mole_installer', 'mole_purge', 'mole_uninstall'].includes(name)) {
    return {
      title:
        details.status === 'completed'
          ? '所选项目已移入回收站'
          : details.status === 'cancelled'
            ? '操作已停止'
            : '所选项目未全部完成',
      summary: `已完成 ${Array.isArray(details.completed) ? String(details.completed.length) : '0'} 项，失败 ${Array.isArray(details.failed) ? String(details.failed.length) : '0'} 项，未处理 ${Array.isArray(details.unprocessed) ? String(details.unprocessed.length) : '0'} 项。未永久删除，移入回收站不等于已释放空间。`,
      details: boundedText(raw)
    }
  }
  if (name === 'inspect_pdf') {
    const warnings = Array.isArray(details.warnings) ? details.warnings.length : 0
    return {
      title: warnings > 0 ? 'PDF 探测完成（有警告）' : 'PDF 探测完成',
      summary: `${typeof details.pageCount === 'number' ? `检测到 ${String(details.pageCount)} 页。` : '已返回 PDF 结构信息。'}${warnings > 0 ? `qpdf 返回 ${String(warnings)} 条结构警告，结果仍可用于审阅。` : '未报告结构警告。'}`,
      details: boundedText(raw)
    }
  }
  if (name === 'inspect_video') {
    const size = formatBytes(details.sizeBytes)
    const audioCodecs = Array.isArray(details.audioCodecs)
      ? details.audioCodecs.filter((value): value is string => typeof value === 'string')
      : []
    const removedContents = Array.isArray(details.removedContents)
      ? details.removedContents.filter((value): value is string => typeof value === 'string')
      : []
    const facts = [
      size ? `文件 ${size}。` : '',
      typeof details.width === 'number' && typeof details.height === 'number'
        ? `${String(details.width)}×${String(details.height)}。`
        : '',
      typeof details.duration === 'number' ? `时长 ${String(details.duration)} 秒。` : '',
      typeof details.codec === 'string' ? `视频编码 ${details.codec}。` : '',
      typeof details.bitDepth === 'number' ? `${String(details.bitDepth)}bit。` : '',
      `音频 ${String(typeof details.audioCount === 'number' ? details.audioCount : audioCodecs.length)} 条${audioCodecs.length > 0 ? `（${audioCodecs.join('、')}）` : ''}。`,
      removedContents.length > 0
        ? `压缩时将移除：${removedContents.join('、')}。`
        : '未发现会被移除的附加内容。'
    ].filter(Boolean)
    return {
      title: '视频探测完成',
      summary: facts.join(' '),
      details: boundedText(raw)
    }
  }
  const nativeSummary = nativeToolSummary(name, raw)
  if (nativeSummary)
    return {
      title: '已完成',
      summary: nativeSummary,
      details: boundedText(raw)
    }
  return {
    title: '工具已返回',
    summary: '请核对返回结果中的状态及未完成项目。',
    details: boundedText(raw)
  }
}

/** A deterministic summary keeps a tool run useful when the model emits no final text. */
export function executionFallback(execution: AgentExecution): string {
  const lines = execution.tools.map((tool) => {
    const status =
      tool.result?.summary ??
      (tool.status === 'running'
        ? '仍在执行。'
        : tool.status === 'stopped'
          ? '已停止。'
          : '未返回结果。')
    return `- ${tool.name}（${tool.status}）：${status}`
  })
  return [`已记录 ${String(execution.tools.length)} 项工具操作结果。`, ...lines].join('\n')
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
