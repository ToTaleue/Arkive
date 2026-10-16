import type { TextMessagePartProps } from '@assistant-ui/react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  table: ({ children }) => (
    <div className="chat-markdown-table" role="region" aria-label="消息表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  )
}

function externalUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : ''
  } catch {
    return ''
  }
}

export function MessageMarkdown({ text }: TextMessagePartProps): React.JSX.Element {
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={externalUrl}
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  )
}
