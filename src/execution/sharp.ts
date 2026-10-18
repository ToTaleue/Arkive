import sharp, { type Metadata, type OutputInfo, type Sharp, type Stats } from 'sharp'
import { XMLParser } from 'fast-xml-parser'
import XMLBuilder from 'fast-xml-builder'
import { SyntaxValidator } from 'fast-xml-validator'

export interface SharpEncodingOptions {
  format: 'webp' | 'jpeg'
  quality: number
  jpegBackground?: string
}

export interface QualityImageOptions {
  hasAlpha: boolean
  flattenBackground?: string
}

export function readImageMetadata(path: string): Promise<Metadata> {
  return sharp(path, { failOn: 'warning' }).metadata()
}

/** Update only fields changed by our pixel normalization, preserving descriptive XMP. */
export function outputXmp(metadata: Metadata, format: 'jpeg' | 'webp' | 'png'): string | undefined {
  if (!metadata.xmp) return undefined
  const text = metadata.xmpAsString ?? metadata.xmp.toString('utf8')
  if (!Buffer.from(text).equals(metadata.xmp)) throw new Error('无法完整读取图片 XMP 元数据。')
  try {
    SyntaxValidator.validate(text)
  } catch {
    throw new Error('图片 XMP 元数据无效，无法安全更新输出信息。')
  }
  const swapped = (metadata.orientation ?? 1) >= 5
  const width = String(swapped ? metadata.height : metadata.width)
  const height = String(swapped ? metadata.width : metadata.height)
  const fields: Record<string, Record<string, string>> = {
    'http://ns.adobe.com/tiff/1.0/': { Orientation: '1', ImageWidth: width, ImageLength: height },
    'http://ns.adobe.com/exif/1.0/': {
      PixelXDimension: width,
      PixelYDimension: height,
      ColorSpace: '1'
    },
    'http://ns.adobe.com/photoshop/1.0/': { ICCProfile: 'sRGB' },
    'http://purl.org/dc/elements/1.1/': { format: `image/${format}` }
  }
  const options = {
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
    commentPropName: '#comment',
    cdataPropName: '#cdata'
  }
  const document: unknown = new XMLParser(options).parse(text)
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  function visit(nodes: unknown, inherited: Record<string, string>): boolean {
    if (!Array.isArray(nodes)) return false
    let changed = false
    for (const node of nodes) {
      if (!record(node)) continue
      const namespaces = { ...inherited }
      const attributes = node[':@']
      if (record(attributes)) {
        for (const [key, value] of Object.entries(attributes)) {
          if (key.startsWith('@_xmlns:') && typeof value === 'string')
            namespaces[key.slice(8)] = value
          else if (key === '@_xmlns' && typeof value === 'string') namespaces[''] = value
        }
      }
      const replacement = (name: string, attribute = false): string | undefined => {
        const split = name.indexOf(':')
        if (split === -1 && attribute) return undefined
        const namespace = namespaces[split === -1 ? '' : name.slice(0, split)]
        if (!Object.hasOwn(fields, namespace)) return undefined
        const properties = fields[namespace]
        const local = split === -1 ? name : name.slice(split + 1)
        return Object.hasOwn(properties, local) ? properties[local] : undefined
      }
      if (record(attributes)) {
        for (const key of Object.keys(attributes)) {
          const value = replacement(key.slice(2), true)
          if (value !== undefined && attributes[key] !== value) {
            attributes[key] = value
            changed = true
          }
        }
      }
      for (const [name, children] of Object.entries(node)) {
        if (!Array.isArray(children)) continue
        const value = replacement(name)
        if (value !== undefined) {
          node[name] = [{ '#text': value }]
          changed = true
        } else changed = visit(children, namespaces) || changed
      }
    }
    return changed
  }
  return visit(document, {}) ? new XMLBuilder(options).build(document) : text
}

function imageForEncoding(
  inputPath: string,
  metadata: Metadata,
  format: 'jpeg' | 'webp' | 'png'
): Sharp {
  const image = sharp(inputPath, { failOn: 'warning' })
    .rotate()
    .toColourspace('srgb')
    .keepMetadata()
    .withIccProfile('srgb', { attach: Boolean(metadata.icc) })
  if (metadata.exif) {
    const swapped = (metadata.orientation ?? 1) >= 5
    image.withExifMerge({
      IFD0: { Orientation: '1' },
      IFD2: {
        ColorSpace: '1',
        PixelXDimension: String(swapped ? metadata.height : metadata.width),
        PixelYDimension: String(swapped ? metadata.width : metadata.height)
      }
    })
  }
  const xmp = outputXmp(metadata, format)
  if (xmp !== undefined) image.withXmp(xmp)
  return image
}

/** Normalize PNG pixels and metadata together before pngquant changes only the palette. */
export async function writeQuantizationInput(
  inputPath: string,
  outputPath: string,
  metadata: Metadata,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  await imageForEncoding(inputPath, metadata, 'png').png().toFile(outputPath)
  signal?.throwIfAborted()
}

/** Normalize an image for full-reference metrics and avoid palette decoder differences. */
export async function writeQualityImage(
  inputPath: string,
  outputPath: string,
  options: QualityImageOptions,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const image = sharp(inputPath, { failOn: 'warning' }).rotate().toColourspace('srgb')
  if (options.flattenBackground) image.flatten({ background: options.flattenBackground })
  else if (options.hasAlpha) image.ensureAlpha()
  else image.removeAlpha()
  await image.png({ palette: false }).toFile(outputPath)
  signal?.throwIfAborted()
}

/** Fixed-format adapter. Business defaults, paths and output publication belong to the service. */
export async function encodeImage(
  inputPath: string,
  outputPath: string,
  options: SharpEncodingOptions,
  signal?: AbortSignal
): Promise<OutputInfo> {
  signal?.throwIfAborted()
  const metadata = await readImageMetadata(inputPath)
  const image = imageForEncoding(inputPath, metadata, options.format)
  if (options.format === 'jpeg') {
    if (options.jpegBackground) image.flatten({ background: options.jpegBackground })
    image.jpeg({ quality: options.quality, mozjpeg: true })
  } else {
    image.webp({ quality: options.quality })
  }
  // Native encoding may finish after cancellation; wait before the caller removes its temp files.
  const result = await image.toFile(outputPath)
  signal?.throwIfAborted()
  return result
}

/** Decode all pixels without creating an output file. Metadata alone cannot detect truncated data. */
export async function validateImage(path: string, signal?: AbortSignal): Promise<Stats> {
  signal?.throwIfAborted()
  const result = await sharp(path, { failOn: 'warning' }).stats()
  signal?.throwIfAborted()
  return result
}
