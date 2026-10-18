import type { CompressionRecord } from './catalog'

export type VideoCompressionPreset = 'quality' | 'balanced' | 'size'

export interface VideoCompressionRequest {
  inputPath: string
  outputPath: string
  preset?: VideoCompressionPreset
  /** Internal Office media encoding only; standalone compression supports HEVC only. */
  compatibility?: boolean
}

export interface VideoCompressionResult {
  catalog?: CompressionRecord
  status: 'compressed' | 'no-savings'
  outputPath: string
  inputBytes: number
  outputBytes: number
  savedBytes: number
  videoCodec: 'hevc' | 'h264'
  bitDepth: 8 | 10
  qualityAnalysis: VideoQualityAnalysis
}

export interface VideoQualityAnalysis {
  quality: number
  targetVmaf: number
  sampleVmaf: number
  predictedVideoBytes: number
  predictedEncodingSeconds: number
}

export type VideoCompressionStage = 'probing' | 'analyzing' | 'encoding' | 'validating'
export interface VideoCompressionProgress {
  stage: VideoCompressionStage
  /** Progress and ETA apply to the current stage, not the whole task. */
  percent: number | null
  elapsedSeconds: number
  remainingSeconds: number | null
}
export interface VideoInspection {
  width: number
  height: number
  duration: number
  codec: string
  bitDepth: 8 | 10
  audioCount: number
  removedContents: string[]
}
export interface SelectedVideo extends VideoInspection {
  id: string
  name: string
  path: string
  sizeBytes: number
}
export interface VideoStartRequest {
  runId: string
  fileId: string
  preset: VideoCompressionPreset
}
export type VideoCompressionOutcome =
  | { status: 'completed'; result: VideoCompressionResult }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }

export const videoChannels = {
  select: 'video:select',
  compress: 'video:compress',
  cancel: 'video:cancel',
  update: 'video:update',
  reveal: 'video:reveal'
} as const

export type VideoCompressionUpdate = VideoCompressionProgress & { runId: string }
export interface VideoApi {
  select: () => Promise<SelectedVideo | null>
  compress: (request: VideoStartRequest) => Promise<VideoCompressionOutcome>
  cancel: (runId: string) => Promise<void>
  onUpdate: (listener: (update: VideoCompressionUpdate) => void) => () => void
  reveal: () => Promise<void>
}
