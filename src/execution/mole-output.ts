import { stripVTControlCharacters } from 'node:util'
import type { MoleOutputBlock, MoleOutputEvent } from '../shared/contracts/mole'

const maxBlockChars = 16_384
const fallbackLines = 12

/** Parses piped Mole output without requiring known titles or a fixed section order. */
export class MoleOutputParser {
  private pending = ''
  private lines: string[] = []
  private title: string
  private kind: MoleOutputBlock['kind'] = 'log'
  private sequence = 0
  private continued = false
  private finished = false
  private endingPartial = false
  private readonly source: MoleOutputBlock['source']
  private readonly emit: (event: MoleOutputEvent) => void

  constructor(source: MoleOutputBlock['source'], emit: (event: MoleOutputEvent) => void) {
    this.source = source
    this.emit = emit
    this.title = source === 'stdout' ? '运行日志' : '错误与提示'
  }

  push(chunk: string): void {
    if (this.finished) return
    this.pending += chunk
    while (this.pending) {
      const newline = this.pending.indexOf('\n')
      if (newline !== -1 && newline < maxBlockChars) {
        const line = this.pending.slice(0, newline)
        this.pending = this.pending.slice(newline + 1)
        this.readLine(line)
      } else if (this.pending.length >= maxBlockChars) {
        // A tool may emit a very long line or never print a newline.
        this.readLine(this.pending.slice(0, maxBlockChars))
        this.pending = this.pending.slice(maxBlockChars)
      } else {
        break
      }
    }
  }

  finish(partial: boolean): void {
    if (this.finished) return
    this.endingPartial = partial
    if (this.pending) this.readLine(this.pending)
    this.pending = ''
    this.flush(partial)
    this.finished = true
  }

  private readLine(raw: string): void {
    const line = stripVTControlCharacters(raw).replace(/\r/g, '')
    const heading = this.source === 'stdout' ? /^➤\s+(.+?)\s*$/.exec(line) : null
    if (heading) {
      this.flush(false)
      this.kind = 'section'
      this.title = heading[1]
      this.continued = false
      this.emit({ type: 'stage', title: this.title })
      return
    }
    if (this.source === 'stdout' && /^={10,}\s*$/.test(line)) {
      if (this.kind !== 'summary') {
        this.flush(false)
        this.kind = 'summary'
        this.title = '运行摘要'
        this.continued = false
        this.emit({ type: 'stage', title: this.title })
      }
      return
    }
    if (!line.trim() && this.lines.length === 0) return
    this.lines.push(line)
    if (
      this.lines.join('\n').length >= maxBlockChars ||
      (this.kind === 'log' && this.lines.length >= fallbackLines)
    ) {
      this.flush(false)
      this.continued = true
    }
  }

  private flush(partial: boolean): void {
    const text = this.lines.join('\n').trimEnd()
    this.lines = []
    if (!text) return
    this.emit({
      type: 'block',
      block: {
        id: `${this.source}-${String(this.sequence++)}`,
        source: this.source,
        kind: this.kind,
        title: this.title,
        text,
        partial: partial || this.endingPartial,
        continued: this.continued
      }
    })
  }
}
