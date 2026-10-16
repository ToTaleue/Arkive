export type ImageOutputFormat = 'webp' | 'jpeg' | 'png'

export interface ImageCompressionRequest {
  inputPath: string
  outputPath: string
  /** Defaults to WebP. PNG output requires PNG input. */
  outputFormat?: ImageOutputFormat
  /** Requests JPEG output; cannot be combined with another explicit output format. */
  compatibility?: boolean
  /** Sharp encoding quality, or jpegoptim's quality ceiling. Omit for lossless jpegoptim. */
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

export interface ImageCompressionResult {
  status: 'compressed' | 'no-savings'
  inputPath: string
  outputPath: string
  originalBytes: number
  outputBytes: number
  savedBytes: number
  outputFormat: ImageOutputFormat
  tool: 'sharp' | 'pngquant' | 'jpegoptim'
  quality?: number
}
