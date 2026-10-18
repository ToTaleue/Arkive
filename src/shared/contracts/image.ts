import type { ArchiveAttempt, AutomaticTagAttempt, CompressionRecord } from './catalog'

export type ImageOutputFormat = 'webp' | 'jpeg' | 'png'
export type ImageCompressionPreset = 'quality' | 'balanced' | 'size'

export interface ImageCompressionRequest {
  inputPath: string
  outputPath: string
  /** Defaults to WebP. PNG output requires PNG input and uses pngquant. */
  outputFormat?: ImageOutputFormat
  /** Keep the input format for JPEG, PNG, or WebP; PNG uses pngquant, others use Sharp. */
  preserveFormat?: boolean
  /** Starting encoding quality preset; perceptual scores are advisory, byte savings decide adoption. */
  preset?: ImageCompressionPreset
  /** Starting Sharp quality; lower qualities may be tried if the output is not smaller. */
  quality?: number
  /** Required for transparent input when exporting JPEG, e.g. #ffffff. */
  jpegBackground?: string
}

export interface ImageInspection {
  inputPath: string
  format: string
  originalBytes: number
  width: number
  height: number
  hasAlpha: boolean
}

export interface SelectedImage extends ImageInspection {
  id: string
  name: string
  path: string
  sizeBytes: number
}

export interface ImageStartRequest {
  runId: string
  fileId: string
  /** Archive the verified result after compression when explicitly selected in the UI. */
  archive?: boolean
  outputFormat?: ImageOutputFormat
  preserveFormat?: boolean
  preset?: ImageCompressionPreset
  quality?: number
  jpegBackground?: string
}

export interface ImageCompressionResult {
  catalog?: CompressionRecord
  archive?: ArchiveAttempt
  automaticTags?: AutomaticTagAttempt
  status: 'compressed' | 'no-savings'
  inputPath: string
  outputPath: string
  originalBytes: number
  outputBytes: number
  savedBytes: number
  outputFormat: ImageOutputFormat
  tool: 'sharp' | 'pngquant'
  /** Source metadata that the output format cannot carry; the original retains it. */
  metadataWarnings?: string[]
  quality?: number
  qualityAnalysis: ImageQualityAnalysis
}

export interface ImageQualityAnalysis {
  metric: 'ssimulacra2'
  /** Advisory reference score only; never blocks a smaller, validated output. */
  targetScore: number
  /** Null when the optional metric cannot evaluate this image. */
  score: number | null
  attempts: number
  /** Informational comparison with targetScore, not an acceptance condition. */
  meetsTarget: boolean | null
  error?: string
}

export type ImageCompressionOutcome =
  | { status: 'completed'; result: ImageCompressionResult }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }

export const imageChannels = {
  select: 'image:select',
  selectPath: 'image:select-path',
  compress: 'image:compress',
  cancel: 'image:cancel',
  reveal: 'image:reveal'
} as const

export interface ImageApi {
  select: () => Promise<SelectedImage | null>
  selectPath: (inputPath: string) => Promise<SelectedImage>
  compress: (request: ImageStartRequest) => Promise<ImageCompressionOutcome>
  cancel: (runId: string) => Promise<void>
  reveal: () => Promise<void>
}
