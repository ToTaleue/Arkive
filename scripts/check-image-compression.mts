// Real Sharp + bundled pngquant. Only dedicated generated test fixtures are processed.
// Run: rtk proxy node scripts/check-image-compression.mts
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
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

// Independent TIFF reader for the fixture's EXIF values, including GPS rational numbers.
function exifValues(exif: Buffer | undefined): Map<string, string | number | number[]> {
  assert.ok(exif)
  const data = exif.subarray(exif.toString('ascii', 0, 4) === 'Exif' ? 6 : 0)
  const little = data.toString('ascii', 0, 2) === 'II'
  const u16 = (at: number): number => (little ? data.readUInt16LE(at) : data.readUInt16BE(at))
  const u32 = (at: number): number => (little ? data.readUInt32LE(at) : data.readUInt32BE(at))
  const tags = new Map<string, string | number | number[]>()
  function ifd(at: number, name: string): void {
    for (let index = 0; index < u16(at); index++) {
      const entry = at + 2 + index * 12
      const tag = u16(entry)
      const type = u16(entry + 2)
      const count = u32(entry + 4)
      const size = ({ 2: 1, 3: 2, 4: 4, 5: 8 } as Record<number, number>)[type]
      if (!size) continue
      const offset = count * size > 4 ? u32(entry + 8) : entry + 8
      if (tag === 0x8769 || tag === 0x8825) {
        ifd(u32(entry + 8), tag === 0x8769 ? 'exif' : 'gps')
      } else if (type === 2) {
        tags.set(
          `${name}:${String(tag)}`,
          data.toString('utf8', offset, offset + count).replace(/\0+$/, '')
        )
      } else {
        const values = Array.from({ length: count }, (_, i) =>
          type === 3
            ? u16(offset + i * 2)
            : type === 4
              ? u32(offset + i * 4)
              : u32(offset + i * 8) / u32(offset + i * 8 + 4)
        )
        tags.set(`${name}:${String(tag)}`, values.length === 1 ? values[0] : values)
      }
    }
  }
  ifd(u32(4), 'image')
  return tags
}

function pngText(keyword: string, text: string): Buffer {
  const body = Buffer.from(`tEXt${keyword}\0${text}`)
  const chunk = Buffer.alloc(body.length + 8)
  chunk.writeUInt32BE(body.length - 4)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), chunk.length - 4)
  return chunk
}

const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:im="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" im:Orientation="6" im:ImageWidth="96" im:ImageLength="64" exif:ColorSpace="65535" dc:format="image/jpeg" photoshop:ICCProfile="Display P3"><exif:PixelXDimension>96</exif:PixelXDimension><exif:PixelYDimension>64</exif:PixelYDimension><dc:subject><rdf:Bag><rdf:li>旅行 &amp; 收藏</rdf:li><rdf:li>Arkive fixture</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>`

async function assertPhotoMetadata(file: string, format: string): Promise<void> {
  const metadata = await sharp(file).metadata()
  assert.equal(metadata.orientation, 1)
  assert.equal(metadata.width, height)
  assert.equal(metadata.height, width)
  assert.ok(metadata.icc)
  const tags = exifValues(metadata.exif)
  assert.equal(tags.get('image:315'), 'Arkive fixture') // Artist
  assert.equal(tags.get('image:272'), 'Fixture camera') // Model
  assert.equal(tags.get('exif:36867'), '2026:10:17 12:34:56')
  assert.equal(tags.get('exif:40962'), height)
  assert.equal(tags.get('exif:40963'), width)
  assert.equal(tags.get('exif:40961'), 1) // sRGB
  assert.equal(tags.get('gps:1'), 'N')
  assert.deepEqual(tags.get('gps:2'), [31, 12, 0])
  assert.equal(tags.get('gps:3'), 'E')
  assert.deepEqual(tags.get('gps:4'), [121, 30, 0])
  assert.match(metadata.xmp?.toString() ?? '', /im:Orientation="1"/)
  assert.match(metadata.xmp?.toString() ?? '', /im:ImageWidth="64"/)
  assert.match(metadata.xmp?.toString() ?? '', /im:ImageLength="96"/)
  assert.match(metadata.xmp?.toString() ?? '', /<exif:PixelXDimension>64<\/exif:PixelXDimension>/)
  assert.match(metadata.xmp?.toString() ?? '', /<exif:PixelYDimension>96<\/exif:PixelYDimension>/)
  assert.match(metadata.xmp?.toString() ?? '', /exif:ColorSpace="1"/)
  assert.ok(metadata.xmp?.includes(Buffer.from(`dc:format="image/${format}"`)))
  assert.match(metadata.xmp?.toString() ?? '', /photoshop:ICCProfile="sRGB"/)
  assert.ok(metadata.xmp?.includes(Buffer.from('旅行 &amp; 收藏')))
  assert.ok(metadata.xmp?.includes(Buffer.from('Arkive fixture')))
}

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
    .withExif({
      IFD0: { Artist: 'Arkive fixture', Model: 'Fixture camera' },
      IFD2: { DateTimeOriginal: '2026:10:17 12:34:56' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '31/1 12/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '121/1 30/1 0/1'
      }
    })
    .withXmp(xmp)
    .withMetadata({ orientation: 6, icc: 'p3' })
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
  await assertPhotoMetadata(jpegOriginalFormat.outputPath, 'jpeg')

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
  await assertPhotoMetadata(jpegWebp.outputPath, 'webp')
  const normalizedProfile = (
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
      .withIccProfile('srgb')
      .png()
      .toBuffer({ resolveWithObject: true })
  ).data
  assert.deepEqual(
    (await sharp(jpegWebp.outputPath).metadata()).icc,
    (await sharp(normalizedProfile).metadata()).icc
  )
  // EXIF GPS and descriptive XMP remain useful independently of the original filename.
  const taggedPng = path('tagged.png')
  await sharp(jpeg).keepMetadata().png().toFile(taggedPng)
  const pngBytes = await readFile(taggedPng)
  await writeFile(
    taggedPng,
    Buffer.concat([
      pngBytes.subarray(0, 33),
      pngText('Project', 'Arkive sample'),
      pngBytes.subarray(33)
    ])
  )
  const taggedHash = await hash(taggedPng)
  const taggedResult = await compressImage({
    inputPath: taggedPng,
    outputPath: path('tagged-result.png'),
    preserveFormat: true
  })
  await assertPhotoMetadata(taggedResult.outputPath, 'png')
  assert.equal((await sharp(taggedResult.outputPath).metadata()).isPalette, true)
  assert.ok(
    (await sharp(taggedResult.outputPath).metadata()).comments?.some(
      (comment) => comment.keyword === 'Project' && comment.text === 'Arkive sample'
    )
  )
  assert.equal(taggedResult.outputBytes, (await readFile(taggedResult.outputPath)).length)
  assert.equal(
    taggedResult.savedBytes,
    Math.max(0, taggedResult.originalBytes - taggedResult.outputBytes)
  )
  assert.equal(await hash(taggedPng), taggedHash)
  const taggedWebp = await compressImage({
    inputPath: taggedPng,
    outputPath: path('tagged-result.webp')
  })
  await assertPhotoMetadata(taggedWebp.outputPath, 'webp')
  assert.ok(taggedWebp.metadataWarnings?.some((warning) => warning.includes('PNG 文本块')))

  // Photoshop APP13 carries IPTC keywords; JPEG can retain it, WebP cannot.
  const iptc = Buffer.concat([Buffer.from([0x1c, 2, 25, 0, 6]), Buffer.from('travel')])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(iptc.length)
  const photoshop = Buffer.concat([
    Buffer.from('Photoshop 3.0\0'),
    Buffer.from('8BIM'),
    Buffer.from([4, 4, 0, 0]),
    length,
    iptc,
    Buffer.alloc(iptc.length % 2)
  ])
  const marker = Buffer.alloc(4)
  marker.writeUInt16BE(0xffed)
  marker.writeUInt16BE(photoshop.length + 2, 2)
  const photoBytes = await readFile(jpeg)
  const iptcSource = path('iptc.jpg')
  await writeFile(
    iptcSource,
    Buffer.concat([photoBytes.subarray(0, 2), marker, photoshop, photoBytes.subarray(2)])
  )
  const iptcBefore = (await sharp(iptcSource).metadata()).iptc
  assert.ok(iptcBefore?.includes(Buffer.from('travel')))
  const iptcJpeg = await compressImage({
    inputPath: iptcSource,
    outputPath: path('iptc-result.jpg'),
    preserveFormat: true
  })
  assert.deepEqual((await sharp(iptcJpeg.outputPath).metadata()).iptc, iptcBefore)
  assert.equal(iptcJpeg.metadataWarnings, undefined)
  const iptcWebp = await compressImage({
    inputPath: iptcSource,
    outputPath: path('iptc-result.webp')
  })
  assert.ok(iptcWebp.metadataWarnings?.some((warning) => warning.includes('IPTC')))
  const badXmp = path('bad-xmp.jpg')
  await sharp(jpeg).keepMetadata().withXmp('<x:xmpmeta>').jpeg().toFile(badXmp)
  await assert.rejects(
    compressImage({ inputPath: badXmp, outputPath: path('bad-xmp.webp') }),
    /XMP/
  )
  assert.equal(await exists(path('bad-xmp.webp')), false)
  console.log(
    'PASS: IPTC retained in JPEG; unsupported IPTC/PNG text reported; malformed XMP never published'
  )

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
  const metadataPreserved = await compressImage({
    inputPath: path('metadata.png'),
    outputPath: path('metadata-result.webp')
  })
  assert.equal(metadataPreserved.tool, 'sharp')
  assert.equal(
    exifValues((await sharp(metadataPreserved.outputPath).metadata()).exif).get('image:315'),
    'PNG metadata'
  )
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
    'PASS: Real Sharp/pngquant lossy routes, EXIF date/device/GPS, XMP keywords and PNG text preserved; orientation/dimensions/ICC updated; final byte accounting, transparent pixels, bounded quality attempts, no-savings, validation, cancellation, no-overwrite and source preservation.'
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
