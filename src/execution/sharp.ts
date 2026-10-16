import sharp, { type Metadata, type OutputInfo, type Stats } from 'sharp'

export interface SharpEncodingOptions {
  format: 'webp' | 'jpeg'
  quality: number
  jpegBackground?: string
}

export function readImageMetadata(path: string): Promise<Metadata> {
  return sharp(path, { failOn: 'warning' }).metadata()
}

/** Fixed-format adapter. Business defaults, paths and output publication belong to the service. */
export async function encodeImage(
  inputPath: string,
  outputPath: string,
  options: SharpEncodingOptions,
  signal?: AbortSignal
): Promise<OutputInfo> {
  signal?.throwIfAborted()
  const image = sharp(inputPath, { failOn: 'warning' }).keepMetadata()
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
