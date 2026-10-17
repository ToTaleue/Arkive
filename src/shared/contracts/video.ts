export type VideoCompressionPreset = 'quality' | 'balanced' | 'size'

export interface VideoCompressionRequest {
  inputPath: string
  outputPath: string
  preset?: VideoCompressionPreset
  compatibility?: boolean
}

export interface VideoCompressionResult {
  status: 'compressed' | 'no-savings'
  outputPath: string
  inputBytes: number
  outputBytes: number
  savedBytes: number
}

export type VideoCompressionStage = 'probing' | 'encoding' | 'validating'
export interface SelectedVideo {
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

export type VideoCompressionUpdate = { runId: string; stage: VideoCompressionStage }
export interface VideoApi {
  select: () => Promise<SelectedVideo | null>
  compress: (request: VideoStartRequest) => Promise<VideoCompressionOutcome>
  cancel: (runId: string) => Promise<void>
  onUpdate: (listener: (update: VideoCompressionUpdate) => void) => () => void
  reveal: () => Promise<void>
}
