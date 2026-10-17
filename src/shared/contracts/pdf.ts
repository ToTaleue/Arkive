export type PdfCompressionPreset = 'lossless' | 'deep-lossless' | 'balanced' | 'size'

export interface PdfFeatures {
  encrypted: boolean
  hasForms: boolean
  hasSignatures: boolean
  hasAnnotations: boolean
  hasAttachments: boolean
  hasOutlines: boolean
  hasPdfA: boolean
}

export interface PdfInspection {
  inputPath: string
  originalBytes: number
  pageCount: number
  features: PdfFeatures
}

export interface PdfCompressionRequest {
  inputPath: string
  outputPath: string
  preset?: PdfCompressionPreset
}

export interface PdfCompressionValidation {
  qpdfCheck: boolean
  pageCountPreserved: boolean
  featuresPreserved: boolean
}

export interface PdfCompressionResult {
  status: 'compressed' | 'no-savings'
  inputPath: string
  outputPath: string
  inputBytes: number
  outputBytes: number
  savedBytes: number
  preset: PdfCompressionPreset
  tool: 'qpdf' | 'ghostscript'
  validation: PdfCompressionValidation
}
