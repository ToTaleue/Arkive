// Real Sharp + bundled pngquant/jpegoptim. Only generated fixtures under out/ are processed.
// Run: rtk proxy node scripts/check-image-compression.mts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp, { type Sharp } from 'sharp'
import { build } from 'vite'

await mkdir('out', { recursive: true })
const directory = await mkdtemp(resolve('out/image-check-'))
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
  assert.equal((await sharp(palette.outputPath).metadata()).isPalette, true)
  assert.equal((await sharp(palette.outputPath).raw().toBuffer())[3], 0)

  const lossless = await compressImage({
    inputPath: jpeg,
    outputPath: path('lossless.jpg'),
    outputFormat: 'jpeg'
  })
  assert.equal(lossless.tool, 'jpegoptim')
  assert.equal(lossless.quality, undefined)
  assert.deepEqual(
    await sharp(jpeg).raw().toBuffer(),
    await sharp(lossless.outputPath).raw().toBuffer()
  )
  assert.equal((await sharp(lossless.outputPath).metadata()).orientation, 6)
  const again = await compressImage({
    inputPath: lossless.outputPath,
    outputPath: path('again.jpg'),
    compatibility: true
  })
  assert.equal(again.tool, 'jpegoptim')
  assert.equal(again.status, 'no-savings')
  assert.equal(again.savedBytes, 0)
  assert.equal(again.outputBytes, again.originalBytes)

  const lossy = await compressImage({
    inputPath: jpeg,
    outputPath: path('lossy.jpg'),
    outputFormat: 'jpeg',
    quality: 65
  })
  assert.equal(lossy.tool, 'jpegoptim')
  assert.equal(lossy.quality, 65)
  assert.ok(lossy.outputBytes < lossy.originalBytes)
  const jpegWebp = await compressImage({ inputPath: jpeg, outputPath: path('photo.webp') })
  assert.equal(jpegWebp.tool, 'sharp')
  const jpegWebpMeta = await sharp(jpegWebp.outputPath).metadata()
  const sourceMeta = await sharp(jpeg).metadata()
  assert.equal(jpegWebpMeta.orientation, 6)
  assert.ok(jpegWebpMeta.exif?.includes(Buffer.from('Arkive fixture')))
  assert.deepEqual(jpegWebpMeta.icc, sourceMeta.icc)
  assert.deepEqual(jpegWebpMeta.xmp, sourceMeta.xmp)

  const compatibility = await compressImage({
    inputPath: png,
    outputPath: path('compatible.jpg'),
    compatibility: true,
    jpegBackground: '#ffffff'
  })
  assert.equal(compatibility.tool, 'sharp')
  assert.equal(compatibility.outputFormat, 'jpeg')
  const compatiblePixels = await sharp(compatibility.outputPath).raw().toBuffer()
  assert.ok(
    compatiblePixels.subarray(0, 3).every((value) => value > 240),
    'Explicit white background is applied'
  )

  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('no-background.jpg'), compatibility: true }),
    /背景色/
  )
  await assert.rejects(
    compressImage({
      inputPath: png,
      outputPath: path('conflict.png'),
      outputFormat: 'png',
      compatibility: true
    }),
    /冲突/
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
    compatibility: true,
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
  // The macOS binary may strip metadata: either preserve it exactly, or fail without publication.
  try {
    await compressImage({
      inputPath: path('metadata.png'),
      outputPath: path('metadata-result.png'),
      outputFormat: 'png'
    })
    assert.deepEqual(
      (await sharp(path('metadata-result.png')).metadata()).exif,
      (await sharp(path('metadata.png')).metadata()).exif
    )
  } catch (error) {
    assert.match(String(error), /元数据/)
    assert.equal(await exists(path('metadata-result.png')), false)
    console.log(
      'NOTE: Bundled pngquant strips fixture EXIF; service rejects publication and keeps the original.'
    )
  }
  await writeFile(path('corrupt.png'), (await readFile(png)).subarray(0, 80))
  await assert.rejects(
    compressImage({ inputPath: path('corrupt.png'), outputPath: path('corrupt.webp') })
  )
  assert.equal(await exists(path('corrupt.webp')), false)
  await assert.rejects(
    inspectImage({ inputPath: join(homedir(), 'Documents', 'not-read.png') }),
    /受保护/
  )
  await mkdir(path('private.photoslibrary'))
  await symlink(png, path('private.photoslibrary/photo.png'))
  await assert.rejects(
    inspectImage({ inputPath: path('private.photoslibrary/photo.png') }),
    /照片图库/
  )
  await assert.rejects(
    compressImage({ inputPath: png, outputPath: path('private.photoslibrary/out.webp') }),
    /照片图库/
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
    'PASS: Real Sharp/pngquant/jpegoptim routes, transparent pixels, explicit JPEG background, JPEG lossless pixels, EXIF/ICC/XMP, no-savings output, validation, cancellation, protected paths, no-overwrite race and source preservation.'
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
