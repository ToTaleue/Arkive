import { stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { readImageMetadata } from '../../../execution/sharp'
import { inspectOffice } from '../office-compression/service'
import { inspectPdf } from '../pdf-compression/service'
import { inspectVideo } from '../video-compression/service'
import type { AutomaticTagAttempt } from '../../../shared/contracts/catalog'
import type {
  TagMetadataValue,
  TagRecommendationInput
} from '../../../shared/contracts/tag-recommendation'
import { recommendTags } from './tag-recommendation'
import type { Catalog } from './service'

function add(
  metadata: Record<string, TagMetadataValue>,
  key: string,
  value: TagMetadataValue | undefined
): void {
  if (value !== undefined) metadata[key] = value
}

async function collectMetadata(
  inputPath: string,
  signal?: AbortSignal
): Promise<Record<string, TagMetadataValue>> {
  // Already inside a compression/archive task: use raw inspections so the
  // single-worker queue does not wait for a child job queued behind itself.
  signal?.throwIfAborted()
  const info = await stat(inputPath)
  const metadata: Record<string, TagMetadataValue> = {
    extension: extname(inputPath).toLowerCase().replace(/^\./u, ''),
    directory: basename(dirname(inputPath)),
    sizeBytes: info.size,
    modifiedAt: info.mtimeMs,
    createdAt: info.birthtimeMs
  }
  const extension = extname(inputPath).toLowerCase()
  try {
    if (
      ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif', '.heic', '.heif'].includes(
        extension
      )
    ) {
      const image = await readImageMetadata(inputPath)
      add(metadata, 'format', image.format)
      add(metadata, 'width', image.width)
      add(metadata, 'height', image.height)
      add(metadata, 'space', image.space)
      add(metadata, 'channels', image.channels)
      add(metadata, 'depth', image.depth)
      add(metadata, 'density', image.density)
      add(metadata, 'orientation', image.orientation)
      add(metadata, 'hasAlpha', image.hasAlpha)
      add(metadata, 'hasProfile', image.hasProfile)
      add(metadata, 'hasExif', image.exif !== undefined)
      add(metadata, 'hasXmp', image.xmp !== undefined)
      add(metadata, 'hasIcc', image.icc !== undefined)
    } else if (['.mov', '.mp4', '.m4v', '.avi', '.mkv'].includes(extension)) {
      const video = await inspectVideo(inputPath, signal)
      add(metadata, 'width', video.width)
      add(metadata, 'height', video.height)
      add(metadata, 'durationSeconds', video.duration)
      add(metadata, 'codec', video.codec)
      add(metadata, 'bitDepth', video.bitDepth)
      add(metadata, 'audioCount', video.audioCount)
      add(metadata, 'audioCodecs', video.audioCodecs)
      add(metadata, 'removedContents', video.removedContents)
    } else if (extension === '.pdf') {
      const pdf = await inspectPdf({ inputPath }, signal)
      add(metadata, 'pageCount', pdf.pageCount)
      add(metadata, 'encrypted', pdf.features.encrypted)
      add(metadata, 'hasForms', pdf.features.hasForms)
      add(metadata, 'hasAnnotations', pdf.features.hasAnnotations)
      add(metadata, 'hasAttachments', pdf.features.hasAttachments)
      add(metadata, 'hasOutlines', pdf.features.hasOutlines)
      add(metadata, 'hasSignatures', pdf.features.hasSignatures)
      add(metadata, 'hasPdfA', pdf.features.hasPdfA)
    } else if (extension === '.docx' || extension === '.pptx') {
      const office = await inspectOffice(inputPath, signal)
      add(metadata, 'format', office.format)
      add(metadata, 'embeddedImages', office.embeddedImages)
      add(metadata, 'embeddedVideos', office.embeddedVideos)
      add(metadata, 'otherMedia', office.otherMedia)
    }
  } catch (error) {
    // Compression has already produced a valid result. Keep common file metadata and let the
    // recommendation response expose the optional probe failure instead of blocking archiving.
    add(metadata, 'metadataReadError', error instanceof Error ? error.message : String(error))
  }
  return metadata
}

async function collectInput(
  catalog: Catalog,
  id: string,
  fallbackPath: string,
  signal?: AbortSignal
): Promise<TagRecommendationInput> {
  const row = catalog.repo.get(id)
  const sourcePath =
    row.backup_status === 'trashed' || row.backup_status === 'cleanup-unknown'
      ? row.output_path
      : (row.backup_path ?? fallbackPath)
  return {
    files: [
      {
        fileId: id,
        fileName: basename(row.original_path),
        originalPath: row.original_path,
        metadata: await collectMetadata(sourcePath, signal),
        existingTags: catalog.repo.tags(id)
      }
    ],
    availableTags: catalog.repo.allTags().slice(0, 1000)
  }
}

/** Read a finished record's original metadata and run the isolated AI tag recommender. */
export async function recommendArchiveTags(
  catalog: Catalog,
  id: string,
  fallbackPath: string,
  signal?: AbortSignal
): Promise<AutomaticTagAttempt> {
  try {
    const input = await collectInput(catalog, id, fallbackPath, signal)
    const result = await recommendTags(input, signal)
    if (result.status === 'cancelled') return result
    if (result.status === 'error') return result
    return { status: 'ready', tags: result.items[0]?.tags.map((tag) => tag.name) ?? [] }
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled' }
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}
