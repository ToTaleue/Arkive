import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { runBundledTool } from '../../../execution/process'
import { compressPdf, inspectPdf } from './service'

async function makePdf(
  path: string,
  name: string,
  options: { image: boolean; text: boolean }
): Promise<string> {
  const postScript = join(path, `${name}.ps`)
  const content = ['%!PS-Adobe-3.0']
  if (options.image) {
    const width = 128
    const height = 128
    const pixels = Array.from({ length: width * height }, (_, index) => {
      const x = index % width
      const y = Math.floor(index / width)
      return `${((x * 2) % 256).toString(16).padStart(2, '0')}${((y * 2) % 256)
        .toString(16)
        .padStart(2, '0')}${((x + y) % 256).toString(16).padStart(2, '0')}`
    }).join('')
    content.push(
      `/picstr ${String(width * 3)} string def`,
      `${String(width)} ${String(height)} 8`,
      `[${String(width)} 0 0 -${String(height)} 0 ${String(height)}]`,
      '{ currentfile picstr readhexstring pop }',
      'false 3 colorimage',
      pixels
    )
  }
  if (options.text) {
    content.push(
      '/Helvetica findfont 18 scalefont setfont',
      '72 720 moveto (Arkive PDF compression fixture) show',
      '72 680 moveto (Text and metadata are generated for service checks.) show'
    )
  }
  content.push('showpage')
  await writeFile(postScript, content.join('\n'))
  const outputPath = join(path, `${name}.pdf`)
  const result = await runBundledTool('ghostscript', [
    '-dBATCH',
    '-dNOPAUSE',
    '-sDEVICE=pdfwrite',
    `-sOutputFile=${outputPath}`,
    postScript
  ])
  assert.equal(result.exitCode, 0, result.stderr)
  return outputPath
}

async function check(): Promise<void> {
  await app.whenReady()
  await mkdir('/Users/hu1hui/Desktop/arkive-test', { recursive: true })
  const directory = await mkdtemp('/Users/hu1hui/Desktop/arkive-test/pdf-compression-check-')
  try {
    const inputPath = await makePdf(directory, 'text', { image: false, text: true })
    const scannedPath = await makePdf(directory, 'scanned', { image: true, text: false })
    const mixedPath = await makePdf(directory, 'mixed', { image: true, text: true })
    const sourceHash = createHash('sha256')
      .update(await readFile(inputPath))
      .digest('hex')
    const inspection = await inspectPdf({ inputPath })
    assert.equal(inspection.pageCount, 1)
    assert.equal(inspection.features.encrypted, false)
    assert.equal(inspection.features.hasSignatures, false)

    for (const preset of ['lossless', 'balanced', 'size'] as const) {
      const outputPath = join(directory, `${preset}.pdf`)
      const result = await compressPdf({ inputPath, outputPath, preset })
      assert.equal(result.outputPath, outputPath)
      assert.equal(result.inputBytes, (await stat(inputPath)).size)
      assert.equal(result.outputBytes, (await stat(outputPath)).size)
      assert.equal(result.savedBytes, Math.max(0, result.inputBytes - result.outputBytes))
      assert.equal(
        result.status,
        result.outputBytes < result.inputBytes ? 'compressed' : 'no-savings'
      )
      assert.equal(result.validation.qpdfCheck, true)
      assert.equal(result.validation.pageCountPreserved, true)
      assert.equal(result.validation.featuresPreserved, true)
      assert.deepEqual(
        createHash('sha256')
          .update(await readFile(inputPath))
          .digest('hex'),
        sourceHash,
        'PDF compression preserves source bytes'
      )
    }
    for (const [name, samplePath] of [
      ['scanned', scannedPath],
      ['mixed', mixedPath]
    ] as const) {
      const sampleInspection = await inspectPdf({ inputPath: samplePath })
      assert.equal(sampleInspection.pageCount, 1, `${name} PDF should have one page`)
      const sampleOutput = join(directory, `${name}-balanced.pdf`)
      const sampleResult = await compressPdf({
        inputPath: samplePath,
        outputPath: sampleOutput,
        preset: 'balanced'
      })
      assert.equal(sampleResult.validation.qpdfCheck, true)
      assert.equal(sampleResult.validation.pageCountPreserved, true)
      assert.equal(sampleResult.validation.featuresPreserved, true)
    }
    await assert.rejects(
      compressPdf({ inputPath, outputPath: join(directory, 'lossless.pdf') }),
      /已存在/
    )
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(
      compressPdf({ inputPath, outputPath: join(directory, 'cancelled.pdf') }, cancelled.signal),
      /aborted|取消/i
    )

    const encryptedPath = join(directory, 'encrypted.pdf')
    const encrypted = await runBundledTool('qpdf', [
      '--encrypt',
      'user',
      'owner',
      '256',
      '--',
      inputPath,
      encryptedPath
    ])
    assert.equal(encrypted.exitCode, 0, encrypted.stderr)
    await assert.rejects(inspectPdf({ inputPath: encryptedPath }), /加密 PDF/)
    console.log(
      'PASS: PDF inspection, qpdf/Ghostscript presets, validation, no-overwrite and cancellation'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void check().then(
  () => {
    app.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    app.exit(1)
  }
)
