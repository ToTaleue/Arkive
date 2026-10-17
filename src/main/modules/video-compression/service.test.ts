import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app } from 'electron'
import { runBundledTool } from '../../../execution/process'
import { checkAbAv1Results } from '../../../execution/ab-av1.test'
import { compressVideo, inspectVideo } from './service'
import type { VideoCompressionProgress } from '../../../shared/contracts/video'
import { checkProgressEstimates } from './progress.test'

async function ffmpeg(args: string[]): Promise<void> {
  const result = await runBundledTool('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    ...args
  ])
  assert.equal(result.exitCode, 0, result.stderr)
}

async function timestamps(path: string): Promise<number[]> {
  const result = await runBundledTool('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=best_effort_timestamp_time',
    '-of',
    'csv=p=0',
    path
  ])
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => Number(line.split(',')[0]))
}

async function check(): Promise<void> {
  await app.whenReady()
  checkProgressEstimates()
  checkAbAv1Results()
  const directory = await mkdtemp(join(tmpdir(), 'arkive-video-check-'))
  try {
    const source = join(directory, 'source $ [clip].mov')
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      '-c:a',
      'aac',
      source
    ])
    const originalHash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex')
    for (const preset of ['quality', 'balanced', 'size'] as const) {
      const outputPath = join(directory, `${preset}.mp4`)
      const updates: VideoCompressionProgress[] = []
      const result = await compressVideo(
        { inputPath: source, outputPath, preset },
        undefined,
        (update) => updates.push(update)
      )
      for (const stage of ['encoding', 'validating'] as const) {
        const reports = updates.filter((update) => update.stage === stage)
        assert.ok(reports.length >= 2, `Expected real FFmpeg progress for ${stage}`)
        assert.ok(
          reports.some((update) => update.percent !== null && update.percent > 0),
          `No processed frames reported: ${JSON.stringify({ stage, reports })}`
        )
        assert.ok(
          reports.every(
            (update) => update.percent === null || (update.percent >= 0 && update.percent < 100)
          )
        )
      }
      assert.equal(result.outputBytes, (await stat(outputPath)).size)
      assert.equal(
        result.status,
        result.outputBytes < result.inputBytes ? 'compressed' : 'no-savings'
      )
      assert.equal(result.savedBytes, Math.max(0, result.inputBytes - result.outputBytes))
      assert.ok(result.qualityAnalysis.sampleVmaf >= result.qualityAnalysis.targetVmaf)
      assert.ok(result.qualityAnalysis.quality >= 0 && result.qualityAnalysis.quality <= 100)
      const analysis = updates.filter((update) => update.stage === 'analyzing')
      assert.ok(analysis.length > 0)
      assert.ok(
        analysis.every((update) => update.percent === null && update.remainingSeconds === null)
      )
    }
    console.log('PASS: all three HEVC presets with real VideoToolbox, AAC and output decoding')

    const cover = join(directory, 'cover.jpg')
    await ffmpeg(['-i', source, '-frames:v', '1', '-update', '1', cover])
    const camera = join(directory, 'camera-10bit.mp4')
    await ffmpeg([
      '-i',
      source,
      '-i',
      cover,
      '-map',
      '0:v',
      '-map',
      '0:a',
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:v:0',
      'hevc_videotoolbox',
      '-allow_sw',
      '0',
      '-pix_fmt:v:0',
      'p010le',
      '-profile:v:0',
      'main10',
      '-tag:v:0',
      'hvc1',
      '-c:a',
      'copy',
      '-c:v:1',
      'copy',
      '-disposition:v:1',
      'attached_pic',
      '-timecode',
      '01:02:03:00',
      camera
    ])
    assert.deepEqual((await inspectVideo(camera)).removedContents, ['时间码', '封面／缩略图'])
    const cameraOutput = join(directory, 'camera-compressed.mp4')
    await compressVideo({ inputPath: camera, outputPath: cameraOutput })
    assert.deepEqual((await inspectVideo(cameraOutput)).removedContents, [])
    const tracks = await runBundledTool('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,pix_fmt',
      '-of',
      'csv=p=0',
      cameraOutput
    ])
    assert.equal(tracks.stdout.trim(), 'video,yuv420p10le\naudio\naudio')
    console.log('PASS: 10bit camera fixture retains both AAC tracks and removes cover/timecode')

    const variable = join(directory, 'variable.mov')
    await ffmpeg([
      '-i',
      source,
      '-vf',
      'select=not(mod(n\\,3))+not(mod(n\\,5))',
      '-fps_mode',
      'passthrough',
      '-c:v',
      'mpeg4',
      '-q:v',
      '2',
      '-an',
      variable
    ])
    const variableOutput = join(directory, 'variable.mp4')
    await compressVideo({ inputPath: variable, outputPath: variableOutput })
    const before = await timestamps(variable)
    const after = await timestamps(variableOutput)
    assert.equal(after.length, before.length)
    assert.ok(
      new Set(before.slice(1).map((time, index) => (time - before[index]).toFixed(4))).size > 1
    )
    after.forEach((time, index) => {
      assert.ok(Math.abs(time - before[index]) < 0.0001)
    })
    console.log('PASS: VFR frame timestamps and frame count preserved')

    const tiny = join(directory, 'tiny.mp4')
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x480:rate=30:duration=1',
      '-c:v',
      'hevc_videotoolbox',
      '-allow_sw',
      '0',
      '-q:v',
      '1',
      '-tag:v',
      'hvc1',
      tiny
    ])
    const noSavings = await compressVideo({
      inputPath: tiny,
      outputPath: join(directory, 'larger.mp4'),
      preset: 'quality'
    })
    assert.equal(noSavings.status, 'no-savings')
    assert.equal(noSavings.savedBytes, 0)
    assert.ok((await stat(tiny)).isFile())
    console.log('PASS: larger output reports no savings and retains original')

    const existing = join(directory, 'existing.mp4')
    await writeFile(existing, 'keep existing content')
    await assert.rejects(compressVideo({ inputPath: source, outputPath: existing }), /已存在/)
    assert.equal(await readFile(existing, 'utf8'), 'keep existing content')
    await assert.rejects(compressVideo({ inputPath: source, outputPath: source }), /扩展名|已存在/)
    await assert.rejects(
      compressVideo({
        inputPath: source,
        outputPath: join(directory, 'compat.mp4'),
        compatibility: true
      }),
      /H.264/
    )

    const audio = join(directory, 'pcm.mov')
    await ffmpeg(['-i', source, '-c:v', 'copy', '-c:a', 'pcm_s16le', audio])
    await assert.rejects(
      compressVideo({ inputPath: audio, outputPath: join(directory, 'pcm.mp4') }),
      /AAC/
    )
    const highDepth = join(directory, '10bit.mov')
    await ffmpeg(['-i', source, '-an', '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', highDepth])
    await assert.rejects(
      compressVideo({ inputPath: highDepth, outputPath: join(directory, '10bit.mp4') }),
      /4:2:0/
    )
    console.log('PASS: existing files protected; unresolved compatibility/audio/4:2:2 rejected')

    // Wait for ab-av1 to start creating its private samples, then cancel during analysis.
    const longSource = join(directory, 'long.mov')
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x480:rate=30:duration=30',
      '-c:v',
      'mpeg4',
      '-q:v',
      '3',
      longSource
    ])
    const controller = new AbortController()
    const cancelledOutput = join(directory, 'cancelled.mp4')
    const cancelled = compressVideo(
      { inputPath: longSource, outputPath: cancelledOutput },
      controller.signal
    )
    const rejection = assert.rejects(cancelled, { name: 'AbortError' })
    const deadline = Date.now() + 10_000
    let analysisStarted = false
    while (!analysisStarted) {
      const task = (await readdir(directory)).find((name) => name.startsWith('.arkive-video-'))
      analysisStarted = Boolean(
        task && (await readdir(join(directory, task))).some((name) => name.startsWith('.ab-av1-'))
      )
      assert.ok(Date.now() < deadline, 'Timed out waiting for automatic quality analysis to start')
      if (!analysisStarted) await delay(10)
    }
    const processLine = execFileSync('/bin/ps', ['-axo', 'pid,pgid,command'], { encoding: 'utf8' })
      .split('\n')
      .find((line) => line.includes('ab-av1 crf-search') && line.includes(directory))
    assert.ok(processLine, 'Expected an active ab-av1 search process')
    const [pid, group] = processLine.trim().split(/\s+/).map(Number)
    assert.equal(pid, group, 'Search must own a private process group')
    controller.abort()
    await rejection
    assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' })
    await assert.rejects(stat(cancelledOutput), { code: 'ENOENT' })
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.arkive-video-')))
    assert.equal(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
      originalHash
    )
    console.log(
      'PASS: cancellation stops the search process group, cleans temporary files and preserves originals'
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
