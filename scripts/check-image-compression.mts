// Real Sharp + bundled pngquant. Only dedicated generated test fixtures are processed.
// Run: rtk proxy node scripts/check-image-compression.mts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp, { type Sharp } from 'sharp'
import { build } from 'vite'

await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/image-check-')
const path = (name: string): string => join(directory, name)
const hash = async (file: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false
  )
const width = 96
const height = 64
const raw = Buffer.alloc(width * height * 4)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    raw[offset] = Math.floor(x / 12) * 30
    raw[offset + 1] = Math.floor(y / 8) * 30
    raw[offset + 2] = (x + y) % 256
    raw[offset + 3] = x < 24 ? 0 : 255
  }
}
const fixture = (): Sharp => sharp(raw, { raw: { width, height, channels: 4 } })

try {
  await symlink(resolve('node_modules'), path('node_modules'), 'dir')
  // Only Electron's app paths are adapted. Native Sharp, process.ts and both binaries are real.
  await writeFile(
    path('electron-fixture.mjs'),
    `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(process.cwd())} }`
  )
  await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { electron: path('electron-fixture.mjs') } },
    build: {
      ssr: true,
      target: 'node22',
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve('src/main/modules/image-compression/service.ts'),
        output: { format: 'es', entryFileNames: 'service.mjs' }
      }
    }
  })
  const { compressImage, inspectImage } = (await import(
    pathToFileURL(path('service.mjs')).href
  )) as typeof import('../src/main/modules/image-compression/service')
  const png = path('input with spaces.png')
  const jpeg = path('input.jpg')
  await fixture().png().toFile(png)
  await fixture()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 95 })
    .withExif({ IFD0: { Artist: 'Arkive fixture' } })
    .withIccProfile('srgb')
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">Arkive fixture</x:xmpmeta>')
    .withMetadata({ orientation: 6 })
    .toFile(jpeg)
  const sourceHashes = await Promise.all([hash(png), hash(jpeg)])
  const info = await inspectImage({ inputPath: png })
  assert.equal(info.format, 'png')
  assert.equal(info.width, width)
  assert.equal(info.height, height)
  assert.equal(info.hasAlpha, true)

  const defaults = await compressImage({ inputPath: png, outputPath: path('default.webp') })
  assert.equal(defaults.tool, 'sharp')
  assert.equal(defaults.outputFormat, 'webp')
  assert.equal(defaults.qualityAnalysis.metric, 'ssimulacra2')
  assert.ok(defaults.qualityAnalysis.score !== null)
  assert.ok(defaults.qualityAnalysis.score >= 0 && defaults.qualityAnalysis.score <= 100)
  assert.ok(defaults.qualityAnalysis.attempts >= 1 && defaults.qualityAnalysis.attempts <= 6)
  const webpMeta = await sharp(defaults.outputPath).metadata()
  assert.equal(webpMeta.hasAlpha, true)
  const webpPixels = await sharp(defaults.outputPath).raw().toBuffer()
  assert.equal(webpPixels[3], 0, 'Transparent pixels survive PNG→WebP')

  const palette = await compressImage({
    inputPath: png,
    outputPath: path('palette.png'),
    outputFormat: 'png'
  })
  assert.equal(palette.tool, 'pngquant')
  assert.equal(palette.qualityAnalysis.metric, 'ssimulacra2')
  assert.ok(palette.qualityAnalysis.score !== null)
  assert.ok(palette.qualityAnalysis.score >= 0 && palette.qualityAnalysis.score <= 100)
  assert.ok(palette.qualityAnalysis.attempts >= 1 && palette.qualityAnalysis.attempts <= 5)
  assert.equal((await sharp(palette.outputPath).metadata()).isPalette, true)
  assert.equal((await sharp(palette.outputPath).raw().toBuffer())[3], 0)

  const jpegOriginalFormat = await compressImage({
    inputPath: jpeg,
    outputPath: path('original-format.jpg'),
    preserveFormat: true
  })
  assert.equal(jpegOriginalFormat.tool, 'sharp')
  assert.equal(jpegOriginalFormat.outputFormat, 'jpeg')
  assert.equal(jpegOriginalFormat.qualityAnalysis.metric, 'ssimulacra2')
  assert.ok(jpegOriginalFormat.qualityAnalysis.attempts >= 1)
  const jpegOriginalMeta = await sharp(jpegOriginalFormat.outputPath).metadata()
  assert.equal(jpegOriginalMeta.orientation, undefined)
  assert.equal(jpegOriginalMeta.width, height)
  assert.equal(jpegOriginalMeta.height, width)
  assert.equal(jpegOriginalMeta.exif, undefined)

  const lossy = await compressImage({
    inputPath: jpeg,
    outputPath: path('lossy.jpg'),
    outputFormat: 'jpeg',
    quality: 65
  })
  assert.equal(lossy.tool, 'sharp')
  assert.equal(lossy.quality, 65)
  assert.equal(lossy.qualityAnalysis.metric, 'ssimulacra2')
  assert.equal(lossy.qualityAnalysis.attempts, 1)
  assert.ok(lossy.outputBytes < lossy.originalBytes)

  const noise = Buffer.alloc(128 * 128 * 3)
  let seed = 42
  for (let index = 0; index < noise.length; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    noise[index] = seed >>> 24
  }
  const noisyInput = path('noise.png')
  await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } })
    .png()
    .toFile(noisyInput)
  const belowReference = await compressImage({
    inputPath: noisyInput,
    outputPath: path('noise.compressed.png'),
    preserveFormat: true,
    preset: 'quality'
  })
  assert.equal(belowReference.status, 'compressed')
  assert.equal(belowReference.qualityAnalysis.meetsTarget, false)
  assert.ok(belowReference.outputBytes < belowReference.originalBytes)
  assert.equal(
    belowReference.qualityAnalysis.attempts,
    1,
    'A smaller output is not re-encoded to chase a score'
  )

  const lowQualityJpeg = path('already-low-quality.jpg')
  await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } })
    .jpeg({ quality: 10 })
    .toFile(lowQualityJpeg)
  const lowered = await compressImage({
    inputPath: lowQualityJpeg,
    outputPath: path('lowered.jpg'),
    preserveFormat: true,
    quality: 100
  })
  assert.equal(lowered.status, 'compressed')
  assert.ok(lowered.outputBytes < lowered.originalBytes)
  assert.ok(lowered.qualityAnalysis.attempts > 1)
  assert.ok(lowered.quality !== undefined && lowered.quality < 100)

  const tinyWebp = path('tiny.webp')
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } })
    .webp({ quality: 1 })
    .toFile(tinyWebp)
  const tinyHash = await hash(tinyWebp)
  const noSavings = await compressImage({
    inputPath: tinyWebp,
    outputPath: path('tiny-result.webp')
  })
  assert.equal(noSavings.status, 'no-savings')
  assert.equal(noSavings.savedBytes, 0)
  assert.equal(noSavings.qualityAnalysis.score, null)
  assert.equal(noSavings.qualityAnalysis.meetsTarget, null)
  assert.match(noSavings.qualityAnalysis.error ?? '', /SSIMULACRA2/)
  assert.equal(await hash(tinyWebp), tinyHash)
  console.log(
    'PASS: below-reference image is published; larger candidates lower quality until smaller; no-savings retains source'
  )
  const jpegWebp = await compressImage({ inputPath: jpeg, outputPath: path('photo.webp') })
  assert.equal(jpegWebp.tool, 'sharp')
  const jpegWebpMeta = await sharp(jpegWebp.outputPath).metadata()
  assert.equal(jpegWebpMeta.orientation, undefined)
  assert.equal(jpegWebpMeta.width, height)
  assert.equal(jpegWebpMeta.height, width)
  assert.equal(jpegWebpMeta.exif, undefined)
  assert.equal(jpegWebpMeta.icc, undefined)
  assert.equal(jpegWebpMeta.xmp, undefined)

  const explicitJpeg = await compressImage({
    inputPath: png,
    outputPath: path('compatible.jpg'),
    outputFormat: 'jpeg',
    jpegBackground: '#ffffff'
  })
  assert.equal(explicitJpeg.tool, 'sharp')
  assert.equal(explicitJpeg.outputFormat, 'jpeg')
  const compatiblePixels = await sharp(explicitJpeg.outputPath).raw().toBuffer()
  assert.ok(
    compatiblePixels.subarray(0, 3).every((value) => value > 240),
    'Explicit white background is applied'
  )

  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('no-background.jpg'), outputFormat: 'jpeg' }),
    /背景色/
  )
  await assert.rejects(
    compressImage({
      inputPath: png,
      outputPath: path('conflict.png'),
      outputFormat: 'png',
      preserveFormat: true
    }),
    /不能与指定输出格式/
  )
  await assert.rejects(
    compressImage({ inputPath: jpeg, outputPath: path('invalid.png'), outputFormat: 'png' }),
    /PNG 输入/
  )
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('bad.webp'), quality: 0 }),
    /质量/
  )
  await assert.rejects(compressImage({ inputPath: png, outputPath: path('bad.jpg') }), /扩展名/)
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: png, outputFormat: 'png' }),
    /已存在/
  )
  await symlink(png, path('existing.webp'))
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('existing.webp') }),
    /已存在/
  )
  await symlink(path('missing.webp'), path('dangling.webp'))
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('dangling.webp') }),
    /已存在/
  )
  const race = await Promise.allSettled([
    compressImage({ inputPath: png, outputPath: path('race.webp') }),
    compressImage({ inputPath: png, outputPath: path('race.webp') })
  ])
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.filter((result) => result.status === 'rejected').length, 1)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('cancelled.webp') }, controller.signal),
    { name: 'AbortError' }
  )
  assert.equal(await exists(path('cancelled.webp')), false)
  const duringWork = new AbortController()
  const watcher = watch(directory, (_event, filename) => {
    if (filename?.startsWith('.arkive-image-')) duringWork.abort()
  })
  try {
    await assert.rejects(
      compressImage({ inputPath: png, outputPath: path('cancel-during.webp') }, duringWork.signal),
      { name: 'AbortError' }
    )
  } finally {
    watcher.close()
  }
  assert.equal(await exists(path('cancel-during.webp')), false)
  await fixture().png().toFile(path('looks-like-jpeg.jpg'))
  const actualFormat = await compressImage({
    inputPath: path('looks-like-jpeg.jpg'),
    outputPath: path('actual-format.jpg'),
    outputFormat: 'jpeg',
    jpegBackground: '#ffffff'
  })
  assert.equal(actualFormat.tool, 'sharp', 'Routing uses actual format, not filename')
  await fixture().flatten().ensureAlpha().png().toFile(path('opaque.png'))
  await compressImage({
    inputPath: path('opaque.png'),
    outputPath: path('opaque-result.png'),
    outputFormat: 'png'
  })
  await fixture()
    .withExif({ IFD0: { Artist: 'PNG metadata' } })
    .png()
    .toFile(path('metadata.png'))
  assert.ok((await sharp(path('metadata.png')).metadata()).exif)
  const metadataDropped = await compressImage({
    inputPath: path('metadata.png'),
    outputPath: path('metadata-result.webp')
  })
  assert.equal(metadataDropped.tool, 'sharp')
  assert.equal((await sharp(metadataDropped.outputPath).metadata()).exif, undefined)
  await writeFile(path('corrupt.png'), (await readFile(png)).subarray(0, 80))
  await assert.rejects(
    compressImage({ inputPath: path('corrupt.png'), outputPath: path('corrupt.webp') })
  )
  assert.equal(await exists(path('corrupt.webp')), false)
  await mkdir(path('private.photoslibrary'))
  await symlink(png, path('private.photoslibrary/photo.png'))
  const libraryImage = await inspectImage({ inputPath: path('private.photoslibrary/photo.png') })
  assert.equal(libraryImage.format, 'png')
  await compressImage({
    inputPath: path('private.photoslibrary/photo.png'),
    outputPath: path('private.photoslibrary/out.webp')
  })
  assert.equal((await sharp(path('private.photoslibrary/out.webp')).metadata()).format, 'webp')
  await symlink(png, path('valid-image.dat'))
  assert.equal((await inspectImage({ inputPath: path('valid-image.dat') })).format, 'png')
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: '/System/arkive-test-must-not-create.webp' }),
    /系统关键路径受保护/
  )
  await symlink('/System', path('system-link'))
  await assert.rejects(
    compressImage({
      inputPath: png,
      outputPath: path('system-link/arkive-test-must-not-create.webp')
    }),
    /系统关键路径受保护/
  )
  assert.deepEqual(
    await Promise.all([hash(png), hash(jpeg)]),
    sourceHashes,
    'Original bytes are unchanged'
  )
  assert.ok(
    !(await readdir(directory)).some((name) => name.startsWith('.arkive-image-')),
    'All task temp directories are removed'
  )
  console.log(
    'PASS: Real Sharp/pngquant lossy routes, transparent pixels, explicit JPEG background, metadata dropping, bounded quality attempts, no-savings output, validation, cancellation, unrestricted user directories and critical system path protection, no-overwrite race and source preservation.'
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
