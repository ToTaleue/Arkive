import type { CompressionLifecycleResult } from './catalog'
import type { PdfCompressionResult, PdfInspection } from './pdf'
import type { OfficeInspection, OfficeReplacementResult } from './office'
import type { DuplicateScanResult } from './duplicates'
import type { CloneDeduplicationRequest, CloneDeduplicationResult } from './clone-deduplication'

export type DocumentKind = 'pdf' | 'office'
export type SelectedDocument = { id: string; name: string; path: string } & (
  { kind: 'pdf'; inspection: PdfInspection } | { kind: 'office'; inspection: OfficeInspection }
)
export type DocumentResult =
  | { kind: 'pdf'; value: PdfCompressionResult & CompressionLifecycleResult }
  | { kind: 'office'; value: OfficeReplacementResult }
export type ProcessingOutcome<T> =
  { status: 'completed'; result: T } | { status: 'cancelled' } | { status: 'error'; error: string }
export interface DocumentStart {
  runId: string
  fileId: string
  preset: 'lossless' | 'deep-lossless' | 'quality' | 'balanced' | 'size'
  replaceConfirmed?: boolean
}
export const processingChannels = {
  select: 'processing:select',
  selectPath: 'processing:select-path',
  compress: 'processing:compress',
  selectFolder: 'processing:select-folder',
  duplicates: 'processing:duplicates',
  clone: 'processing:clone',
  cancel: 'processing:cancel',
  reveal: 'processing:reveal'
} as const
export interface ProcessingApi {
  select: (kind: DocumentKind) => Promise<SelectedDocument | null>
  selectPath: (kind: DocumentKind, path: string) => Promise<SelectedDocument>
  compress: (request: DocumentStart) => Promise<ProcessingOutcome<DocumentResult>>
  selectFolder: () => Promise<string | null>
  duplicates: (runId: string, path: string) => Promise<ProcessingOutcome<DuplicateScanResult>>
  clone: (
    runId: string,
    request: CloneDeduplicationRequest
  ) => Promise<ProcessingOutcome<CloneDeduplicationResult>>
  cancel: (runId: string) => Promise<void>
  reveal: () => Promise<void>
  localFilePath: (file: File) => string
}
