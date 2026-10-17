import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runBundledTool } from '../../../execution/process'
import { TaskCancelled } from '../../tasks/service'
import { exists, hashFile } from '../catalog/files'
import { fixture } from './fixtures.test'
import { compressOffice, inspectOffice } from './service'
import { compressOfficeInPlace } from './in-place'
import { readOfficePackage } from './package'

async function ffmpeg(args: string[]): Promise<void> {
  const result = await runBundledTool('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-n',
    ...args
  ])
  assert.equal(result.exitCode, 0, result.stderr)
}

async function probe(path: string, entries: string, stream: string): Promise<string> {
  const result = await runBundledTool('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    stream,
    '-show_entries',
    entries,
    '-show_data_hash',
    'sha256',
    '-of',
    'csv=p=0',
    path
  ])
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(result.stdoutTruncated, false)
  return result.stdout.trim()
}

async function videoAnalysisStarted(directory: string): Promise<boolean> {
  for (const name of (await readdir(directory)).filter((item) =>
    item.startsWith('.arkive-office-replace-')
  )) {
    for (const office of (await readdir(join(directory, name))).filter((item) =>
      item.startsWith('.arkive-office-')
    )) {
      const privateDirectory = join(directory, name, office)
      for (const video of (await readdir(privateDirectory)).filter((item) =>
        item.startsWith('.arkive-video-')
      )) {
        if (
          (await readdir(join(privateDirectory, video))).some((item) => item.startsWith('.ab-av1-'))
        )
          return true
      }
    }
  }
  return false
}

export async function checkOfficeVideos(directory: string): Promise<void> {
  const path = (name: string): string => join(directory, name)
  const source = path('movie.mp4')
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x480:rate=30:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'mpeg4',
    '-q:v',
    '1',
    '-c:a',
    'aac',
    source
  ])
  const movie = await readFile(source)
  for (const format of ['docx', 'pptx'] as const) {
    const input = path(`video.${format}`)
    const output = path(`video.compressed.${format}`)
    await fixture(input, format, [], { video: movie })
    const inspection = await inspectOffice(input)
    assert.equal(inspection.embeddedVideos, 1)
    assert.equal(inspection.otherMedia, 0)
    const original = await hashFile(input)
    const result = await compressOffice({ inputPath: input, outputPath: output })
    assert.equal(result.status, 'compressed', JSON.stringify(result.media))
    assert.equal(await hashFile(input), original)
    assert.equal(result.media.find((item) => item.part.endsWith('.mp4'))?.status, 'compressed')
    const before = await readOfficePackage(input, await mkdtemp(path('video-before-')))
    const after = await readOfficePackage(output, await mkdtemp(path('video-after-')))
    const compressedMovie = after.parts.find((item) => item.name.endsWith('.mp4'))
    assert.ok(compressedMovie)
    for (const part of before.parts.filter((item) => !item.name.endsWith('.mp4'))) {
      assert.equal(after.parts.find((item) => item.name === part.name)?.hash, part.hash, part.name)
    }
    assert.equal(
      await probe(compressedMovie.path, 'stream=codec_name,pix_fmt', 'v:0'),
      'h264,yuv420p'
    )
    assert.equal(
      await probe(compressedMovie.path, 'packet=data_hash', 'a:0'),
      await probe(source, 'packet=data_hash', 'a:0'),
      'AAC packet contents must remain identical'
    )
    const times = (value: string): number[] =>
      value.split('\n').map((line) => Number(line.split(',')[0]))
    const oldTimes = times(await probe(source, 'frame=best_effort_timestamp_time', 'v:0'))
    const newTimes = times(
      await probe(compressedMovie.path, 'frame=best_effort_timestamp_time', 'v:0')
    )
    assert.equal(newTimes.length, oldTimes.length)
    newTimes.forEach((time, index) => {
      assert.ok(Math.abs(time - oldTimes[index]) < 0.0001)
    })
    console.log(
      `PASS: ${format} embedded MP4 H.264/AAC, XML preservation, timestamps; ${String(result.originalBytes)} → ${String(result.outputBytes)} bytes`
    )
  }

  const inPlace = path('video-replaced.pptx')
  await fixture(inPlace, 'pptx', [], { video: movie })
  const original = await hashFile(inPlace)
  const replacement = await compressOfficeInPlace({ inputPath: inPlace })
  assert.equal(replacement.replacementStatus, 'replaced', replacement.replacementError)
  assert.equal(replacement.outputPath, inPlace)
  assert.ok(replacement.catalog?.backupPath)
  assert.equal(await hashFile(replacement.catalog.backupPath), original)
  assert.notEqual(await hashFile(inPlace), original)

  const alac = path('alac.mp4')
  await ffmpeg(['-i', source, '-c:v', 'copy', '-c:a', 'alac', alac])
  const subtitle = path('caption.srt')
  await writeFile(subtitle, '1\n00:00:00,000 --> 00:00:03,000\nkeep embedded subtitle\n')
  const captioned = path('captioned.mp4')
  await ffmpeg([
    '-i',
    source,
    '-i',
    subtitle,
    '-map',
    '0',
    '-map',
    '1',
    '-c',
    'copy',
    '-c:s',
    'mov_text',
    captioned
  ])
  const tiny = path('tiny-hevc.mp4')
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x480:rate=30:duration=3',
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
  for (const [name, content, reason] of [
    ['alac', await readFile(alac), /AAC/],
    ['captioned', await readFile(captioned), /字幕/],
    ['damaged-video', Buffer.from('not a video'), /探测/],
    ['no-video-savings', await readFile(tiny), /体积未减少/]
  ] as const) {
    const input = path(`${name}.pptx`)
    const output = path(`${name}.compressed.pptx`)
    await fixture(input, 'pptx', [], { video: content })
    const originalHash = await hashFile(input)
    const result = await compressOffice({ inputPath: input, outputPath: output })
    assert.equal(result.status, 'no-savings')
    assert.match(result.media[0]?.reason ?? '', reason)
    assert.equal(await hashFile(input), originalHash)
    assert.equal(await exists(output), false)
  }
  console.log(
    'PASS: embedded video in-place replacement/backup; non-AAC, subtitles, invalid video and no-savings preserved'
  )

  const cancelInput = path('cancel-video.pptx')
  await fixture(cancelInput, 'pptx', [], { video: movie })
  const cancelHash = await hashFile(cancelInput)
  const controller = new AbortController()
  const task = compressOfficeInPlace({ inputPath: cancelInput }, controller.signal)
  const rejection = assert.rejects(task, TaskCancelled)
  const deadline = Date.now() + 20_000
  let analyzing = false
  try {
    while (Date.now() < deadline) {
      analyzing = await videoAnalysisStarted(directory)
      if (analyzing) break
      await delay(10)
    }
  } finally {
    controller.abort()
    await rejection
  }
  assert.ok(analyzing, 'Expected cancellation during actual embedded-video quality analysis')
  assert.equal(await hashFile(cancelInput), cancelHash)
  assert.ok((await stat(cancelInput)).isFile())
  console.log('PASS: cancellation during embedded-video analysis preserves the whole original')
}
