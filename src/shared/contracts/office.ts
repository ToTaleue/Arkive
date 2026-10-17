import type { CompressionRecord } from './catalog'
import type { ImageCompressionPreset } from './image'

export type OfficeFormat = 'docx' | 'pptx'

export interface OfficeInspection {
  inputPath: string
  format: OfficeFormat
  originalBytes: number
  embeddedImages: number
  embeddedVideos: number
  otherMedia: number
}

export interface OfficeCompressionRequest {
  inputPath: string
  outputPath: string
  preset?: ImageCompressionPreset
}

export interface OfficeMediaResult {
  part: string
  status: 'compressed' | 'skipped'
  reason?: string
  originalBytes: number
  outputBytes: number
}

export interface OfficeCompressionResult {
  status: 'compressed' | 'no-savings'
  inputPath: string
  outputPath: string
  format: OfficeFormat
  originalBytes: number
  outputBytes: number
  savedBytes: number
  media: OfficeMediaResult[]
}

export interface OfficeReplacementResult extends OfficeCompressionResult {
  replacementStatus: 'replaced' | 'unchanged' | 'error'
  replacementError?: string
  catalog?: CompressionRecord
}
