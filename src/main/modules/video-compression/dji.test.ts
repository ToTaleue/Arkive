// Real Pocket 3 regression. Successful output stays beside the fixture for manual review.
// Run: rtk proxy node scripts/check-video-compression.mjs --dji
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { runBundledTool } from '../../../execution/process'
import { compressVideo, inspectVideo } from './service'
import type { VideoCompressionProgress } from '../../../shared/contracts/video'

async function hash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    const bytes: unknown = chunk
    assert.ok(Buffer.isBuffer(bytes))
    digest.update(bytes)
  }
  return digest.digest('hex')
}

async function probe(path: string, entries: string, selector?: string): Promise<string> {
  const result = await runBundledTool('ffprobe', [
    '-v',
    'error',
    ...(selector ? ['-select_streams', selector] : []),
    '-show_entries',
    entries,
    '-of',
    'json',
    path
  ])
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(result.stdoutTruncated, false)
  const data: unknown = JSON.parse(result.stdout)
  assert.ok(
    typeof data === 'object' && data !== null && 'streams' in data && Array.isArray(data.streams)
  )
  return JSON.stringify(data.streams)
}

async function audioHashes(path: string): Promise<string> {
  const result = await runBundledTool('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_packets',
    '-show_data_hash',
    'sha256',
    '-show_entries',
    'packet=data_hash',
    '-of',
    'csv=p=0',
    path
  ])
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout
}

async function check(): Promise<void> {
  await app.whenReady()
  const fixtures = join(app.getPath('desktop'), 'arkive-test')
  const source = join(fixtures, 'video-dji-4k.MP4')
  const directory = await mkdtemp(join(fixtures, 'dji-compression-check-'))
  const compatibility = process.argv.includes('--h264')
  try {
    const originalHash = await hash(source)
    assert.deepEqual((await inspectVideo(source)).removedContents, [
      'DJI 附加数据',
      '时间码',
      '封面／缩略图'
    ])
    const outputPath = join(directory, `video-dji-4k-balanced${compatibility ? '-h264' : ''}.mp4`)
    const started = Date.now()
    const updates: VideoCompressionProgress[] = []
    const result = await compressVideo(
      { inputPath: source, outputPath, preset: 'balanced', compatibility },
      undefined,
      (update) => updates.push(update)
    )
    const analysis = updates.filter((update) => update.stage === 'analyzing')
    assert.ok(analysis.length > 1)
    assert.ok(result.qualityAnalysis.sampleVmaf >= result.qualityAnalysis.targetVmaf)
    console.log(`PASS: DJI automatic quality analysis received ${String(analysis.length)} updates`)
    for (const stage of ['encoding', 'validating'] as const) {
      const reports = updates.filter((update) => update.stage === stage)
      assert.ok(
        reports.some(
          (update) => update.percent !== null && update.percent > 0 && update.percent < 99
        )
      )
      assert.ok(
        reports.some(
          (update) =>
            update.remainingSeconds !== null &&
            Number.isFinite(update.remainingSeconds) &&
            update.remainingSeconds > 0
        )
      )
      console.log(`PASS: DJI ${stage} received ${String(reports.length)} progress/ETA updates`)
    }
    const elapsedSeconds = (Date.now() - started) / 1000
    assert.equal(result.status, 'compressed')
    assert.equal(
      await probe(outputPath, 'stream=codec_type'),
      JSON.stringify([{ codec_type: 'video' }, { codec_type: 'audio' }])
    )
    assert.equal(
      await probe(outputPath, 'stream=codec_name,profile,width,height,pix_fmt', 'V'),
      JSON.stringify([
        {
          codec_name: compatibility ? 'h264' : 'hevc',
          profile: compatibility ? 'High' : 'Main 10',
          width: 3840,
          height: 2160,
          pix_fmt: compatibility ? 'yuv420p' : 'yuv420p10le'
        }
      ])
    )
    assert.equal(
      await probe(outputPath, 'stream=avg_frame_rate,nb_frames', 'V'),
      await probe(source, 'stream=avg_frame_rate,nb_frames', 'V')
    )
    assert.equal(
      await probe(outputPath, 'stream=color_range,color_space,color_transfer,color_primaries', 'V'),
      await probe(source, 'stream=color_range,color_space,color_transfer,color_primaries', 'V')
    )
    assert.equal(await audioHashes(outputPath), await audioHashes(source))
    assert.equal(await hash(source), originalHash)
    console.log(
      `PASS: actual DJI Pocket 3; 4K/59.94fps/color preserved, ${compatibility ? 'H.264 8bit' : 'HEVC 10bit'}, AAC packets unchanged, extra streams removed, full decode passed, original unchanged`
    )
    console.log(
      JSON.stringify(
        {
          ...result,
          elapsedSeconds,
          analysisSeconds: analysis.at(-1)?.elapsedSeconds,
          encodingSeconds: updates.filter((update) => update.stage === 'encoding').at(-1)
            ?.elapsedSeconds,
          validationSeconds: updates.filter((update) => update.stage === 'validating').at(-1)
            ?.elapsedSeconds
        },
        null,
        2
      )
    )
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
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
