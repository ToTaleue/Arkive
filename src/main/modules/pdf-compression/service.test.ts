import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { runBundledTool } from '../../../execution/process'
import { compressPdf, inspectPdf } from './service'
import { writePdfFixture } from './test-fixture'

async function makePdf(
  path: string,
  name: string,
  options: { image: boolean; text: boolean }
): Promise<string> {
  const outputPath = join(path, `${name}.pdf`)
  const kind = options.image ? 'image' : options.text ? 'text' : 'blank'
  await writePdfFixture(outputPath, `Arkive PDF compression fixture: ${name} ${kind}`)
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

    const warningPath = join(directory, 'recoverable-xref-warning.pdf')
    const warningBytes = Buffer.from(
      (await readFile(inputPath)).toString('latin1').replace(/startxref\s+\d+/, 'startxref\n0'),
      'latin1'
    )
    await writeFile(warningPath, warningBytes)
    const warningCheck = await runBundledTool('qpdf', ['--check', warningPath])
    assert.equal(
      warningCheck.exitCode,
      3,
      'Fixture must reproduce successful qpdf recovery with warnings'
    )
    const warningInspection = await inspectPdf({ inputPath: warningPath })
    assert.ok(warningInspection.warnings?.length)
    const recovered = await compressPdf({
      inputPath: warningPath,
      outputPath: join(directory, 'recovered.pdf'),
      preset: 'lossless'
    })
    assert.equal(recovered.validation.pageCountPreserved, true)
    assert.equal(recovered.validation.featuresPreserved, true)
    assert.deepEqual(await readFile(warningPath), warningBytes)
    console.log(
      'PASS: recoverable qpdf warning exit 3 is validated instead of rejected as a failed optimization'
    )

    for (const preset of ['lossless', 'deep-lossless', 'balanced', 'size'] as const) {
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
    console.log('PASS: PDF inspection, qpdf presets, validation, no-overwrite and cancellation')
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
