import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  const testRoot = '/Users/hu1hui/Desktop/arkive-test'
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(join(testRoot, 'video-check-'))
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
      '-metadata',
      'creation_time=2026-10-17T04:34:56Z',
      '-metadata',
      'title=Arkive 元数据 "样本"',
      '-metadata',
      'comment=Unchanged description',
      '-metadata',
      'keywords=旅行,收藏',
      '-metadata',
      'com.apple.quicktime.location.ISO6709=+31.2000+121.5000/',
      '-metadata',
      'com.apple.quicktime.model=Fixture camera',
      '-metadata',
      'arkive_custom=custom $ [value]',
      '-metadata:s:a:0',
      'language=zho',
      '-movflags',
      '+use_metadata_tags',
      source
    ])
    const originalHash = createHash('sha256')
      .update(await readFile(source))
      .digest('hex')
    const sourceInspection = await inspectVideo(source)
    assert.equal(sourceInspection.sizeBytes, (await stat(source)).size)
    assert.deepEqual(sourceInspection.audioCodecs, ['aac'])
    for (const compatibility of [false, true]) {
      for (const preset of ['quality', 'balanced', 'size'] as const) {
        const outputPath = join(directory, `${compatibility ? 'h264' : 'hevc'}-${preset}.mp4`)
        const updates: VideoCompressionProgress[] = []
        const result = await compressVideo(
          { inputPath: source, outputPath, preset, compatibility },
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
        assert.equal(result.videoCodec, compatibility ? 'h264' : 'hevc')
        assert.equal(result.bitDepth, 8)
        const video = await runBundledTool('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name,codec_tag_string,profile,pix_fmt,width,height,nb_frames',
          '-of',
          'json',
          outputPath
        ])
        assert.equal(video.exitCode, 0, video.stderr)
        const metadata = await runBundledTool('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format_tags:stream_tags=language',
          '-of',
          'json',
          outputPath
        ])
        assert.equal(metadata.exitCode, 0, metadata.stderr)
        const tags: unknown = JSON.parse(metadata.stdout)
        assert.ok(typeof tags === 'object' && tags !== null && 'format' in tags)
        assert.ok(typeof tags.format === 'object' && tags.format !== null && 'tags' in tags.format)
        const actual = tags.format.tags
        assert.ok(typeof actual === 'object' && actual !== null)
        assert.ok('title' in actual && actual.title === 'Arkive 元数据 "样本"')
        assert.ok('comment' in actual && actual.comment === 'Unchanged description')
        assert.ok('keywords' in actual && actual.keywords === '旅行,收藏')
        assert.ok('arkive_custom' in actual && actual.arkive_custom === 'custom $ [value]')
        assert.ok(
          'com.apple.quicktime.model' in actual &&
            actual['com.apple.quicktime.model'] === 'Fixture camera'
        )
        assert.ok(
          'com.apple.quicktime.location.ISO6709' in actual &&
            actual['com.apple.quicktime.location.ISO6709'] === '+31.2000+121.5000/'
        )
        assert.ok(
          'creation_time' in actual &&
            typeof actual.creation_time === 'string' &&
            actual.creation_time
              .split(';')
              .every((timestamp) => Date.parse(timestamp) === Date.parse('2026-10-17T04:34:56Z'))
        )
        const data: unknown = JSON.parse(video.stdout)
        assert.ok(typeof data === 'object' && data !== null && 'streams' in data)
        assert.deepEqual(data.streams, [
          {
            codec_name: compatibility ? 'h264' : 'hevc',
            profile: compatibility ? 'High' : 'Main',
            codec_tag_string: compatibility ? 'avc1' : 'hvc1',
            width: 320,
            height: 240,
            pix_fmt: 'yuv420p',
            nb_frames: '90'
          }
        ])
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
    }
    console.log(
      'PASS: all three HEVC and H.264 presets with real VideoToolbox, AAC, dates/GPS/device/custom metadata and output decoding'
    )

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
    for (const compatibility of [false, true]) {
      const cameraOutput = join(directory, `camera-${compatibility ? 'h264' : 'hevc'}.mp4`)
      await compressVideo({ inputPath: camera, outputPath: cameraOutput, compatibility })
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
      assert.equal(
        tracks.stdout.trim(),
        `video,${compatibility ? 'yuv420p' : 'yuv420p10le'}\naudio\naudio`
      )
    }
    console.log(
      'PASS: 10bit camera fixture retains AAC tracks; HEVC preserves 10bit, H.264 outputs 8bit; cover/timecode removed'
    )

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
    for (const compatibility of [false, true]) {
      const variableOutput = join(directory, `variable-${compatibility ? 'h264' : 'hevc'}.mp4`)
      await compressVideo({ inputPath: variable, outputPath: variableOutput, compatibility })
      const before = await timestamps(variable)
      const after = await timestamps(variableOutput)
      assert.equal(after.length, before.length)
      assert.ok(
        new Set(before.slice(1).map((time, index) => (time - before[index]).toFixed(4))).size > 1
      )
      after.forEach((time, index) => {
        assert.ok(Math.abs(time - before[index]) < 0.0001)
      })
    }
    console.log('PASS: HEVC and H.264 preserve VFR frame timestamps and frame count')

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
    console.log('PASS: existing files protected; unresolved audio/4:2:2 rejected')

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
    for (const compatibility of [false, true]) {
      const controller = new AbortController()
      const cancelledOutput = join(directory, `cancelled-${compatibility ? 'h264' : 'hevc'}.mp4`)
      const cancelled = compressVideo(
        { inputPath: longSource, outputPath: cancelledOutput, compatibility },
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
        assert.ok(
          Date.now() < deadline,
          'Timed out waiting for automatic quality analysis to start'
        )
        if (!analysisStarted) await delay(10)
      }
      const processLine = execFileSync('/bin/ps', ['-axo', 'pid,pgid,command'], {
        encoding: 'utf8'
      })
        .split('\n')
        .find(
          (line) =>
            line.includes(`ab-av1 ${compatibility ? 'sample-encode' : 'crf-search'}`) &&
            line.includes(directory)
        )
      assert.ok(processLine, 'Expected an active ab-av1 search process')
      const [pid, group] = processLine.trim().split(/\s+/).map(Number)
      assert.equal(pid, group, 'Search must own a private process group')
      controller.abort()
      await rejection
      // macOS may briefly keep killed descendants as zombies (kill(0) can return EPERM).
      // Check that no live member of this private process group remains.
      const shutdownDeadline = Date.now() + 5_000
      for (;;) {
        const liveMembers = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter(([pgid, state]) => Number(pgid) === group && !state.startsWith('Z'))
        if (liveMembers.length === 0) break
        assert.ok(
          Date.now() < shutdownDeadline,
          `Live analysis descendants remain: ${JSON.stringify(liveMembers)}`
        )
        await delay(20)
      }
      await assert.rejects(stat(cancelledOutput), { code: 'ENOENT' })
      assert.ok(!(await readdir(directory)).some((name) => name.startsWith('.arkive-video-')))
    }
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
