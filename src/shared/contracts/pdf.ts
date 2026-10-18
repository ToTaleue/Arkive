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
  /** qpdf repaired or tolerated structural issues while reading the PDF. */
  warnings?: string[]
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
  /** Product flows retain the original on no savings; keep the unadopted candidate separate. */
  candidateOutputPath?: string
  candidateOutputBytes?: number
  savedBytes: number
  preset: PdfCompressionPreset
  tool: 'qpdf'
  validation: PdfCompressionValidation
}
