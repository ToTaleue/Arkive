import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import { XMLParser } from 'fast-xml-parser'
import { SyntaxValidator } from 'fast-xml-validator'
import { open as openZip, type Entry, type ZipFile } from 'yauzl'
import { ZipFile as ZipWriter } from 'yazl'
import type { OfficeFormat } from '../../../shared/contracts/office'

// Disk-backed processing: never expand a full presentation into memory.
const maxParts = 20_000
const maxExpandedBytes = 4 * 1024 ** 3
const maxXmlBytes = 16 * 1024 ** 2

export interface OfficePart {
  name: string
  path: string
  bytes: number
  hash: string
  modifiedAt: Date
  compressed: boolean
  contentType: string
}

export interface OfficePackage {
  format: OfficeFormat
  parts: OfficePart[]
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Office XML 结构无效。')
  }
  return value as Record<string, unknown>
}

function elements(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).map(record)
}

function attribute(element: Record<string, unknown>, name: string): string {
  const value = element[`@_${name}`]
  if (typeof value !== 'string' || !value) throw new Error(`Office XML 缺少 ${name}。`)
  return value
}

function safePartName(name: string): void {
  for (let index = 0; index < name.length; index++) {
    if (name.charCodeAt(index) < 32) throw new Error('Office 包包含无效路径。')
  }
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    name.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')
  ) {
    throw new Error('Office 包包含无效路径。')
  }
}

async function xml(part: OfficePart): Promise<Record<string, unknown>> {
  if (part.bytes > maxXmlBytes) throw new Error('Office XML 超出当前处理上限。')
  const text = await readFile(part.path, 'utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new Error(`Office XML 校验失败：${part.name}`)
  }
  try {
    SyntaxValidator.validate(text, {
      invalidCharSequence: { comment: true, tagValue: true, attrLt: true }
    })
  } catch {
    throw new Error(`Office XML 校验失败：${part.name}`)
  }
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseAttributeValue: false
  }).parse(text)
  return record(parsed)
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zip.off('entry', onEntry)
      zip.off('end', onEnd)
      zip.off('error', onError)
    }
    const onEntry = (entry: Entry): void => {
      cleanup()
      resolve(entry)
    }
    const onEnd = (): void => {
      cleanup()
      resolve(undefined)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

/** Internal package reader, validator and extractor; output filenames are private numeric IDs. */
export async function readOfficePackage(
  inputPath: string,
  directory: string,
  signal?: AbortSignal
): Promise<OfficePackage> {
  signal?.throwIfAborted()
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZip(
      inputPath,
      { lazyEntries: true, autoClose: false, strictFileNames: true },
      (error, value) => {
        if (error) reject(error)
        else resolve(value)
      }
    )
  })
  const parts: OfficePart[] = []
  // Keep ZIP errors observable while an entry stream is being consumed, between readEntry calls.
  let zipError: Error | undefined
  zip.on('error', (error: Error) => {
    zipError = error
  })
  const names = new Set<string>()
  let total = 0
  let entryCount = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      if (zipError) throw zipError
      const entry = await nextEntry(zip)
      if (!entry) break
      entryCount += 1
      if (entryCount > maxParts) throw new Error('Office 包文件数量超出当前处理上限。')
      const name = entry.fileName
      safePartName(name.endsWith('/') ? name.slice(0, -1) : name)
      const key = name.toLowerCase()
      if (names.has(key)) throw new Error('Office 包存在重复文件名。')
      names.add(key)
      const mode = entry.externalFileAttributes >>> 16
      if ((mode & 0o170000) === 0o120000 || (entry.generalPurposeBitFlag & 1) !== 0) {
        throw new Error('当前不处理含符号链接或加密条目的 Office 包。')
      }
      if (name.endsWith('/')) continue
      if (name.startsWith('_xmlsignatures/') || /vbaProject\.bin$/i.test(name)) {
        throw new Error('当前不处理签名或含宏的 Office 文档。')
      }
      total += entry.uncompressedSize
      if (total > maxExpandedBytes) throw new Error('Office 包展开大小超出当前处理上限。')
      const path = join(directory, `part-${String(parts.length)}`)
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zip.openReadStream(entry, (error, value) => {
          if (error) reject(error)
          else resolve(value)
        })
      })
      let bytes = 0
      let checksum = 0
      const hash = createHash('sha256')
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > entry.uncompressedSize) {
            callback(new Error('Office 包条目大小无效。'))
            return
          }
          checksum = crc32(chunk, checksum)
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(stream, verifier, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
        signal
      })
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) {
        throw new Error(`Office 包内容校验失败：${name}`)
      }
      parts.push({
        name,
        path,
        bytes,
        hash: hash.digest('hex'),
        modifiedAt: entry.getLastModDate(),
        compressed: entry.compressionMethod !== 0,
        contentType: ''
      })
    }
  } finally {
    zip.close()
  }
  const byName = new Map(parts.map((part) => [part.name, part]))
  const typesPart = byName.get('[Content_Types].xml')
  const rootRels = byName.get('_rels/.rels')
  if (!typesPart || !rootRels) throw new Error('文件不是完整的 DOCX／PPTX 文档。')
  const types = record((await xml(typesPart)).Types)
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const item of elements(types.Default)) {
    const extension = attribute(item, 'Extension').toLowerCase()
    if (defaults.has(extension)) throw new Error('Office 内容类型声明重复。')
    defaults.set(extension, attribute(item, 'ContentType'))
  }
  for (const item of elements(types.Override)) {
    const name = decodeURIComponent(attribute(item, 'PartName')).replace(/^\//, '')
    if (!byName.has(name) || overrides.has(name)) throw new Error('Office 内容类型引用无效。')
    overrides.set(name, attribute(item, 'ContentType'))
  }
  let mainPart: string | undefined
  for (const part of parts) {
    signal?.throwIfAborted()
    if (part.name !== '[Content_Types].xml') {
      part.contentType =
        overrides.get(part.name) ??
        defaults.get(
          part.name.endsWith('.rels') ? 'rels' : extname(part.name).slice(1).toLowerCase()
        ) ??
        ''
      if (!part.contentType) throw new Error(`Office 条目缺少内容类型：${part.name}`)
    }
    if (
      part.name.endsWith('.xml') ||
      part.name.endsWith('.rels') ||
      part.contentType.endsWith('+xml')
    ) {
      const document = await xml(part)
      if (!part.name.endsWith('.rels')) continue
      const source =
        part.name === '_rels/.rels' ? '' : part.name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2')
      if (source && (!byName.has(source) || source === part.name))
        throw new Error('Office 关系源文件缺失。')
      const ids = new Set<string>()
      const relationships = document.Relationships === '' ? {} : record(document.Relationships)
      for (const rel of elements(relationships.Relationship)) {
        const id = attribute(rel, 'Id')
        if (ids.has(id)) throw new Error('Office 关系 ID 重复。')
        ids.add(id)
        const target = attribute(rel, 'Target')
        const type = attribute(rel, 'Type')
        if (rel['@_TargetMode'] === 'External') continue
        if (rel['@_TargetMode'] !== undefined && rel['@_TargetMode'] !== 'Internal')
          throw new Error('Office 关系模式无效。')
        const decoded = decodeURIComponent(target.split('#')[0])
        if (decoded.includes('\\') || decoded.includes('?') || /^[a-z][a-z0-9+.-]*:/i.test(decoded))
          throw new Error('Office 内部关系路径无效。')
        const resolved = decoded.startsWith('/')
          ? posix.normalize(decoded.slice(1))
          : posix.normalize(posix.join(posix.dirname(source), decoded))
        if (!byName.has(resolved)) throw new Error(`Office 引用文件缺失：${resolved}`)
        if (part.name === '_rels/.rels' && type.endsWith('/officeDocument')) {
          if (mainPart) throw new Error('Office 主文档关系重复。')
          mainPart = resolved
        }
      }
    }
  }
  const mainType = mainPart ? byName.get(mainPart)?.contentType : undefined
  const format =
    mainType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      ? 'docx'
      : mainType ===
          'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
        ? 'pptx'
        : undefined
  if (!format || extname(inputPath).toLowerCase() !== `.${format}`)
    throw new Error('仅支持格式与内容一致的普通 DOCX／PPTX 文档。')
  return { format, parts }
}

/** Repack unchanged XML and objects byte for byte; only selected media paths vary. */
export async function writeOfficePackage(
  document: OfficePackage,
  replacements: ReadonlyMap<string, string>,
  outputPath: string,
  signal?: AbortSignal
): Promise<void> {
  const writer = new ZipWriter()
  const stream = writer.outputStream
  if (!(stream instanceof Readable)) throw new Error('ZIP 输出流无效。')
  const onError = (error: Error): void => {
    stream.destroy(error)
  }
  writer.on('error', onError)
  const writing = pipeline(stream, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), {
    signal
  })
  try {
    for (const part of document.parts) {
      writer.addFile(replacements.get(part.name) ?? part.path, part.name, {
        mtime: part.modifiedAt,
        mode: 0o100600,
        compress: part.compressed
      })
    }
    writer.end()
    await writing
  } catch (error) {
    stream.destroy()
    await writing.catch(() => undefined)
    throw error
  }
}
