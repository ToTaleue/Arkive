import { link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { sampleWithAbAv1, searchWithAbAv1, type AbAv1SearchResult } from '../../../execution/ab-av1'
import { spawnFfmpeg } from '../../../execution/ffmpeg'
import { runBundledTool } from '../../../execution/process'
import type {
  VideoCompressionRequest,
  VideoCompressionResult,
  VideoCompressionProgress,
  VideoQualityAnalysis,
  VideoInspection
} from '../../../shared/contracts/video'
import { createProgressReader } from './progress'
export type {
  VideoCompressionPreset,
  VideoCompressionRequest,
  VideoCompressionResult
} from '../../../shared/contracts/video'

interface VideoInfo extends VideoInspection {
  videoIndex: number
  width: number
  height: number
  duration: number
  frames?: string
  audioCount: number
  codec: string
  bitDepth: 8 | 10
  color: { option: string; value: string }[]
  metadata: {
    format: Map<string, string>
    streams: Map<string, string>[]
  }
}

// These describe the old container/encoder or removed timecode, not the retained content.
const replacedMetadata = new Set([
  'major_brand',
  'minor_version',
  'compatible_brands',
  'encoder',
  'encoding_tool',
  'vendor_id',
  'timecode'
])

function retainedMetadata(value: unknown): Map<string, string> {
  const entries: [string, string][] = []
  if (isRecord(value)) {
    for (const [key, text] of Object.entries(value)) {
      if (typeof text !== 'string' || replacedMetadata.has(key.toLowerCase())) continue
      // ffprobe can join equivalent dates from the container header and mdta with ';'.
      // Normalize those duplicates so the new container can also write a valid header date.
      const timestamps = text.split(';')
      const dates = timestamps.map((date) => Date.parse(date))
      const timestamp =
        key.toLowerCase() === 'creation_time' &&
        Number.isFinite(dates[0]) &&
        dates.every((date) => date === dates[0])
          ? timestamps[0]
          : text
      entries.push([key, timestamp])
    }
  }
  return new Map(entries)
}

// 抽样 VMAF 试验目标，尚待更多素材标定；不是整片画质保证或画质保留百分比。
const targetVmaf = { quality: 98, balanced: 95, size: 90 } as const

/** ab-av1 0.11.7 only maps HEVC's crf to q:v. Search H.264 with explicit q:v samples. */
async function selectH264Quality(
  sampleArgs: readonly string[],
  target: number,
  cwd: string,
  signal?: AbortSignal
): Promise<AbAv1SearchResult> {
  let low = 4 // q:v 20, in steps of 5 up to 100; matches the HEVC search range.
  let high = 20
  let best: AbAv1SearchResult | undefined
  while (low <= high) {
    signal?.throwIfAborted()
    const step = Math.floor((low + high) / 2)
    const quality = step * 5
    const sample = await sampleWithAbAv1(
      ['sample-encode', ...sampleArgs, '--crf', String(quality), '--enc', `q:v=${String(quality)}`],
      { cwd, signal }
    )
    if (sample.sampleVmaf >= target) {
      best = sample
      high = step - 1
    } else low = step + 1
  }
  if (!best) throw new Error('H.264 自动选参未达到所选档位的抽样画质目标；未降低画质目标。')
  return best
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function probeVideo(path: string, signal?: AbortSignal): Promise<VideoInfo> {
  const inputStat = await stat(path)
  if (!inputStat.isFile()) throw new Error('输入须为普通视频文件。')
  const result = await runBundledTool(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', path],
    { signal }
  )
  if (result.exitCode !== 0 || result.signal || result.stdoutTruncated) {
    throw new Error(`无法完整探测视频：${result.stderr.slice(-4096)}`)
  }
  const data: unknown = JSON.parse(result.stdout)
  if (!isRecord(data) || !Array.isArray(data.streams) || !data.streams.every(isRecord)) {
    throw new Error('视频探测结果格式无效。')
  }
  const streams = data.streams
  const isCover = (stream: Record<string, unknown>): boolean =>
    isRecord(stream.disposition) &&
    (stream.disposition.attached_pic === 1 || stream.disposition.timed_thumbnails === 1)
  const videos = streams.filter((stream) => stream.codec_type === 'video' && !isCover(stream))
  const audios = streams.filter((stream) => stream.codec_type === 'audio')
  if (videos.length !== 1) {
    throw new Error('须包含一条主视频；多个独立视频的选择功能尚未接入。封面不计入主视频。')
  }
  const video = videos[0]
  const bitDepth = ['yuv420p10le', 'p010le'].includes(String(video.pix_fmt)) ? 10 : 8
  if (
    !['yuv420p', 'nv12', 'yuv420p10le', 'p010le'].includes(String(video.pix_fmt)) ||
    ['smpte2084', 'arib-std-b67'].includes(String(video.color_transfer)) ||
    (Array.isArray(video.side_data_list) && video.side_data_list.length > 0) ||
    (isRecord(video.tags) && video.tags.rotate !== undefined) ||
    (isRecord(video.disposition) && video.disposition.attached_pic !== 0) ||
    !['progressive', 'unknown', 'undefined'].includes(String(video.field_order))
  ) {
    throw new Error(
      '当前支持 8bit／10bit 4:2:0 非 HDR 视频；HDR、其他色度采样、透明及旋转视频尚待验证。'
    )
  }
  // 暂不把待讨论的 AAC 转码建议变成默认行为，已有 AAC 音轨原样保留。
  if (audios.some((audio) => audio.codec_name !== 'aac')) {
    throw new Error('当前仅支持保留 AAC 音轨；其他音频编码的转换规则待确定。')
  }
  const duration = Number(video.duration)
  if (
    typeof video.width !== 'number' ||
    typeof video.height !== 'number' ||
    video.width <= 0 ||
    video.height <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    typeof video.codec_name !== 'string' ||
    !Number.isInteger(video.index) ||
    typeof video.index !== 'number'
  ) {
    throw new Error('无法确定视频的分辨率、时长或编码，暂不处理。')
  }
  const removedContents: string[] = []
  const dataStreams = streams.filter((stream) => stream.codec_type === 'data')
  if (dataStreams.some((stream) => ['djmd', 'dbgi'].includes(String(stream.codec_tag_string))))
    removedContents.push('DJI 附加数据')
  if (
    dataStreams.some((stream) => stream.codec_tag_string === 'tmcd') ||
    (isRecord(video.tags) && video.tags.timecode !== undefined)
  )
    removedContents.push('时间码')
  if (streams.some(isCover)) removedContents.push('封面／缩略图')
  if (streams.some((stream) => stream.codec_type === 'subtitle')) removedContents.push('字幕')
  if (streams.some((stream) => stream.codec_type === 'attachment')) removedContents.push('附件')
  if (Array.isArray(data.chapters) && data.chapters.length > 0) removedContents.push('章节')
  if (
    dataStreams.some(
      (stream) => !['djmd', 'dbgi', 'tmcd'].includes(String(stream.codec_tag_string))
    ) ||
    streams.some(
      (stream) =>
        !['video', 'audio', 'data', 'subtitle', 'attachment'].includes(String(stream.codec_type))
    )
  )
    removedContents.push('其他附加流')
  return {
    sizeBytes: inputStat.size,
    videoIndex: video.index,
    width: video.width,
    height: video.height,
    duration,
    frames:
      typeof video.nb_frames === 'string' && /^\d+$/.test(video.nb_frames)
        ? video.nb_frames
        : undefined,
    audioCount: audios.length,
    codec: video.codec_name,
    bitDepth,
    color: [
      { field: 'color_range', option: '-color_range:v' },
      { field: 'color_space', option: '-colorspace:v' },
      { field: 'color_transfer', option: '-color_trc:v' },
      { field: 'color_primaries', option: '-color_primaries:v' }
    ].flatMap(({ field, option }) => {
      const value = video[field]
      return typeof value === 'string' && !['unknown', 'unspecified'].includes(value)
        ? [{ option, value }]
        : []
    }),
    audioCodecs: audios.map((audio) => String(audio.codec_name)),
    removedContents,
    metadata: {
      format: retainedMetadata(isRecord(data.format) ? data.format.tags : undefined),
      streams: [video, ...audios].map((stream) => retainedMetadata(stream.tags))
    }
  }
}

/** Selection-time inspection: show exactly which auxiliary streams will be discarded. */
export async function inspectVideo(path: string, signal?: AbortSignal): Promise<VideoInspection> {
  signal?.throwIfAborted()
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('视频路径须为本地绝对路径。')
  const {
    sizeBytes,
    width,
    height,
    duration,
    codec,
    bitDepth,
    audioCount,
    audioCodecs,
    removedContents
  } = await probeVideo(path, signal)
  return {
    sizeBytes,
    width,
    height,
    duration,
    codec,
    bitDepth,
    audioCount,
    audioCodecs,
    removedContents
  }
}

/** 消费两路输出；进程出错或取消后等 close，再允许清理临时文件。 */
async function runFfmpeg(
  args: readonly string[],
  signal?: AbortSignal,
  progress?: {
    stage: 'encoding' | 'validating'
    durationSeconds: number
    totalFrames?: number
    report: (update: VideoCompressionProgress) => void
  }
): Promise<void> {
  signal?.throwIfAborted()
  const child = spawnFfmpeg(
    progress ? ['-progress', 'pipe:1', '-stats_period', '0.5', '-nostats', ...args] : args,
    { signal }
  )
  const lines = progress ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : undefined
  if (lines && progress) {
    lines.on(
      'line',
      createProgressReader(
        progress.stage,
        progress.durationSeconds,
        progress.report,
        progress.totalFrames
      )
    )
  } else child.stdout.resume()
  await new Promise<void>((resolve, reject) => {
    let stderr = ''
    let processError: Error | undefined
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384)
    })
    child.on('error', (error) => {
      processError = error
    })
    child.on('close', (code, exitSignal) => {
      lines?.close()
      if (processError) reject(processError)
      else if (code !== 0 || exitSignal) {
        reject(new Error(`FFmpeg 处理失败；硬件编码不可用时不会回退软件编码。\n${stderr}`))
      } else resolve()
    })
  })
  signal?.throwIfAborted()
}

/**
 * 主进程内的业务入口，由用户确认后的任务流程调用，不直接注册为 Agent Tool。
 * 仅生成新文件，始终保留原件；结构检查和完整解码不代表感知画质验收。
 * 任务持久化和原件处理后续再接入。
 */
export async function compressVideo(
  request: VideoCompressionRequest,
  signal?: AbortSignal,
  onUpdate?: (update: VideoCompressionProgress) => void
): Promise<VideoCompressionResult> {
  signal?.throwIfAborted()
  const { inputPath, outputPath, preset = 'balanced', compatibility = false } = request
  if (!Object.hasOwn(targetVmaf, preset)) throw new Error('未知的视频压缩档位。')
  if (
    !isAbsolute(inputPath) ||
    !isAbsolute(outputPath) ||
    extname(outputPath).toLowerCase() !== '.mp4'
  ) {
    throw new Error('输入输出须为本地绝对路径，输出文件扩展名须为 .mp4。')
  }
  // 确认目标不存在；发布时的 link 也会原子拒绝覆盖，避免检查后的竞争。
  const existing = await lstat(outputPath).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing) throw new Error('输出路径已存在，不覆盖已有文件。')
  const input = await realpath(inputPath)
  const inputStat = await stat(input)
  if (!inputStat.isFile()) throw new Error('输入须为普通视频文件。')
  onUpdate?.({ stage: 'probing', percent: null, elapsedSeconds: 0, remainingSeconds: null })
  const before = await probeVideo(input, signal)
  // Compatibility explicitly selects 8bit H.264; HEVC continues to preserve input bit depth.
  const outputCodec = compatibility ? 'h264' : 'hevc'
  const encoder = compatibility ? 'h264_videotoolbox' : 'hevc_videotoolbox'
  const outputBitDepth = compatibility ? 8 : before.bitDepth
  const pixelFormat = outputBitDepth === 10 ? 'p010le' : 'nv12'
  const profile = compatibility ? 'high' : outputBitDepth === 10 ? 'main10' : 'main'
  // VideoToolbox may omit H.264's limited-range VUI when no other color fields exist.
  // Write the known source range explicitly, rather than weakening color validation.
  const colorRange = before.color.find(({ option }) => option === '-color_range:v')?.value
  const bitstreamFilter =
    compatibility && colorRange
      ? `h264_metadata=video_full_range_flag=${colorRange === 'pc' ? '1' : '0'}`
      : undefined
  signal?.throwIfAborted()
  const temporaryDirectory = await mkdtemp(join(dirname(outputPath), '.arkive-video-'))
  const temporaryOutput = join(temporaryDirectory, 'compressed.mp4')
  try {
    const analysisStarted = performance.now()
    const reportAnalysis = (): void =>
      onUpdate?.({
        stage: 'analyzing',
        percent: null,
        elapsedSeconds: (performance.now() - analysisStarted) / 1000,
        remainingSeconds: null
      })
    reportAnalysis()
    const analysisTimer = setInterval(reportAnalysis, 500)
    let qualityAnalysis: VideoQualityAnalysis
    try {
      // A video-only, lossless remux prevents covers/DJI data from affecting ab-av1's
      // stream selection. Analysis and final encoding both use the original image data.
      const analysisInput = join(temporaryDirectory, 'analysis-input.mkv')
      await runFfmpeg(
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-xerror',
          '-n',
          '-i',
          input,
          '-map',
          `0:${String(before.videoIndex)}`,
          '-c:v',
          'copy',
          '-map_metadata',
          '-1',
          '-map_chapters',
          '-1',
          analysisInput
        ],
        signal
      )
      const sampleArgs = [
        '--input',
        analysisInput,
        '--encoder',
        encoder,
        '--samples',
        '2',
        '--sample-duration',
        '1s',
        '--cache',
        'false',
        '--temp-dir',
        temporaryDirectory,
        '--stdout-format',
        'json',
        '--vmaf-fps',
        '0',
        '--vmaf',
        'n_subsample=12',
        '--vmaf',
        'n_threads=8',
        '--enc',
        'allow_sw=0',
        '--enc',
        'enc_time_base:v=demux',
        '--enc',
        'g=250',
        '--enc',
        `pix_fmt:v:0=${pixelFormat}`,
        '--enc',
        `profile:v=${profile}`,
        ...(bitstreamFilter ? ['--enc', `bsf:v=${bitstreamFilter}`] : []),
        ...before.color.flatMap(({ option, value }) => ['--enc', `${option.slice(1)}=${value}`])
      ]
      const search = compatibility
        ? await selectH264Quality(sampleArgs, targetVmaf[preset], temporaryDirectory, signal)
        : await searchWithAbAv1(
            [
              'crf-search',
              ...sampleArgs,
              '--min-vmaf',
              String(targetVmaf[preset]),
              // Savings are determined from the actual final file, including retained audio.
              '--max-encoded-percent',
              'inf',
              '--min-crf',
              '20',
              '--max-crf',
              '100',
              '--crf-increment',
              '5'
            ],
            { signal, cwd: temporaryDirectory }
          )
      if (search.sampleVmaf < targetVmaf[preset]) {
        throw new Error('自动选参结果未达到所选档位的抽样画质目标。')
      }
      qualityAnalysis = { ...search, targetVmaf: targetVmaf[preset] }
    } finally {
      clearInterval(analysisTimer)
    }
    signal?.throwIfAborted()
    // 所有业务参数集中在此；不接受调用方传入任意 FFmpeg 参数。
    await runFfmpeg(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-n',
        '-copyts',
        '-start_at_zero',
        '-noautorotate',
        '-i',
        input,
        '-map',
        `0:${String(before.videoIndex)}`,
        '-map',
        '0:a?',
        '-map_metadata',
        '0',
        // MP4's default iTunes metadata mapping silently drops arbitrary QuickTime/custom keys.
        // Preserve descriptive keys in mdta, but let the muxer/encoder regenerate technical data.
        ...[...replacedMetadata].flatMap((key) => ['-metadata', `${key}=`]),
        ...(before.metadata.format.has('creation_time')
          ? ['-metadata', `creation_time=${before.metadata.format.get('creation_time') ?? ''}`]
          : []),
        '-metadata:s:v:0',
        'encoder=',
        '-map_chapters',
        '-1',
        // Do not let copied video metadata cause the MP4 muxer to recreate a timecode track.
        '-metadata:s:v:0',
        'timecode=',
        '-metadata',
        'timecode=',
        '-write_tmcd',
        '0',
        '-c:v',
        encoder,
        '-allow_sw',
        '0',
        '-g',
        '250',
        '-pix_fmt',
        pixelFormat,
        '-profile:v',
        profile,
        ...before.color.flatMap(({ option, value }) => [option, value]),
        ...(bitstreamFilter ? ['-bsf:v', bitstreamFilter] : []),
        '-q:v',
        String(qualityAnalysis.quality),
        '-tag:v',
        compatibility ? 'avc1' : 'hvc1',
        '-fps_mode:v',
        'passthrough',
        '-enc_time_base:v',
        'demux',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart+use_metadata_tags',
        '-f',
        'mp4',
        temporaryOutput
      ],
      signal,
      onUpdate
        ? {
            stage: 'encoding',
            durationSeconds: before.duration,
            totalFrames: Number(before.frames),
            report: onUpdate
          }
        : undefined
    )
    onUpdate?.({ stage: 'validating', percent: null, elapsedSeconds: 0, remainingSeconds: null })
    const after = await probeVideo(temporaryOutput, signal)
    if (
      after.codec !== outputCodec ||
      after.width !== before.width ||
      after.height !== before.height ||
      after.audioCount !== before.audioCount ||
      after.bitDepth !== outputBitDepth ||
      after.removedContents.length !== 0 ||
      before.color.some(
        ({ option, value }) =>
          !after.color.some((entry) => entry.option === option && entry.value === value)
      ) ||
      Math.abs(after.duration - before.duration) > 0.1 ||
      (before.frames !== undefined && after.frames !== before.frames)
    ) {
      throw new Error('输出视频的编码、分辨率、时长、帧数或音轨检查未通过。')
    }
    for (const [index, expected] of [
      before.metadata.format,
      ...before.metadata.streams
    ].entries()) {
      const actual = [after.metadata.format, ...after.metadata.streams][index]
      for (const [key, value] of expected) {
        const retained = actual.get(key)
        const sameDate =
          key.toLowerCase() === 'creation_time' &&
          retained !== undefined &&
          Number.isFinite(Date.parse(value)) &&
          Date.parse(value) === Date.parse(retained)
        if (retained !== value && !sameDate) {
          throw new Error(`输出视频未保留元数据 ${key}，未发布结果。`)
        }
      }
    }
    await runFfmpeg(
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-i',
        temporaryOutput,
        '-map',
        '0:v',
        '-map',
        '0:a?',
        '-f',
        'null',
        '-'
      ],
      signal,
      onUpdate
        ? {
            stage: 'validating',
            durationSeconds: after.duration,
            totalFrames: Number(after.frames),
            report: onUpdate
          }
        : undefined
    )
    const outputStat = await stat(temporaryOutput)
    if (outputStat.size === 0) throw new Error('压缩输出为空。')
    signal?.throwIfAborted()
    await link(temporaryOutput, outputPath)
    return {
      status: outputStat.size < inputStat.size ? 'compressed' : 'no-savings',
      outputPath,
      inputBytes: inputStat.size,
      outputBytes: outputStat.size,
      savedBytes: Math.max(0, inputStat.size - outputStat.size),
      videoCodec: outputCodec,
      bitDepth: outputBitDepth,
      qualityAnalysis
    }
  } finally {
    // 仅清理本次创建的私有临时目录，绝不处理原件或已有目标文件。
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
