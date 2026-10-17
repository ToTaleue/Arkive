import { link, lstat, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { spawnFfmpeg } from '../../../execution/ffmpeg'
import { runBundledTool } from '../../../execution/process'
import type {
  VideoCompressionRequest,
  VideoCompressionResult,
  VideoCompressionStage
} from '../../../shared/contracts/video'
export type {
  VideoCompressionPreset,
  VideoCompressionRequest,
  VideoCompressionResult
} from '../../../shared/contracts/video'

interface VideoInfo {
  width: number
  height: number
  duration: number
  frames?: string
  audio: boolean
  codec: string
}

// HEVC VideoToolbox 起始值，尚未完成真实素材的画质标定；不是 CRF 或保真百分比。
const hevcQuality = { quality: 80, balanced: 65, size: 50 } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function probeVideo(path: string, signal?: AbortSignal): Promise<VideoInfo> {
  const result = await runBundledTool(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
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
  const videos = streams.filter((stream) => stream.codec_type === 'video')
  const audios = streams.filter((stream) => stream.codec_type === 'audio')
  if (videos.length !== 1 || audios.length > 1 || streams.length !== 1 + audios.length) {
    throw new Error('当前仅支持单视频轨、至多一条音轨；多音轨、字幕和附加流的保留规则待确定。')
  }
  const video = videos[0]
  if (
    !['yuv420p', 'nv12'].includes(String(video.pix_fmt)) ||
    ['smpte2084', 'arib-std-b67'].includes(String(video.color_transfer)) ||
    (Array.isArray(video.side_data_list) && video.side_data_list.length > 0) ||
    (isRecord(video.tags) && video.tags.rotate !== undefined) ||
    (isRecord(video.disposition) && video.disposition.attached_pic !== 0) ||
    !['progressive', 'unknown', 'undefined'].includes(String(video.field_order))
  ) {
    throw new Error('当前仅支持普通 8bit SDR 视频；HDR、10bit、透明、旋转及其他特殊视频尚待验证。')
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
    typeof video.codec_name !== 'string'
  ) {
    throw new Error('无法确定视频的分辨率、时长或编码，暂不处理。')
  }
  return {
    width: video.width,
    height: video.height,
    duration,
    frames:
      typeof video.nb_frames === 'string' && /^\d+$/.test(video.nb_frames)
        ? video.nb_frames
        : undefined,
    audio: audios.length === 1,
    codec: video.codec_name
  }
}

/** 消费两路输出；进程出错或取消后等 close，再允许清理临时文件。 */
async function runFfmpeg(args: readonly string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const child = spawnFfmpeg(args, { signal })
  await new Promise<void>((resolve, reject) => {
    let stderr = ''
    let processError: Error | undefined
    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384)
    })
    child.on('error', (error) => {
      processError = error
    })
    child.on('close', (code, exitSignal) => {
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
 * 任务持久化、H.264 参数和原件处理后续再接入。
 */
export async function compressVideo(
  request: VideoCompressionRequest,
  signal?: AbortSignal,
  onStage?: (stage: VideoCompressionStage) => void
): Promise<VideoCompressionResult> {
  signal?.throwIfAborted()
  const { inputPath, outputPath, preset = 'balanced', compatibility = false } = request
  if (compatibility) {
    throw new Error('H.264 兼容优先模式的三档参数尚待单独验证，当前不套用 HEVC 参数。')
  }
  if (!Object.hasOwn(hevcQuality, preset)) throw new Error('未知的视频压缩档位。')
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
  onStage?.('probing')
  const before = await probeVideo(input, signal)
  signal?.throwIfAborted()
  const temporaryDirectory = await mkdtemp(join(dirname(outputPath), '.arkive-video-'))
  const temporaryOutput = join(temporaryDirectory, 'compressed.mp4')
  try {
    onStage?.('encoding')
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
        '0:v:0',
        '-map',
        '0:a:0?',
        '-map_metadata',
        '0',
        '-map_chapters',
        '0',
        '-c:v',
        'hevc_videotoolbox',
        '-allow_sw',
        '0',
        '-q:v',
        String(hevcQuality[preset]),
        '-tag:v',
        'hvc1',
        '-fps_mode:v',
        'passthrough',
        '-enc_time_base:v',
        'demux',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        temporaryOutput
      ],
      signal
    )
    onStage?.('validating')
    const after = await probeVideo(temporaryOutput, signal)
    if (
      after.codec !== 'hevc' ||
      after.width !== before.width ||
      after.height !== before.height ||
      after.audio !== before.audio ||
      Math.abs(after.duration - before.duration) > 0.1 ||
      (before.frames !== undefined && after.frames !== before.frames)
    ) {
      throw new Error('输出视频的编码、分辨率、时长、帧数或音轨检查未通过。')
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
      signal
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
      savedBytes: Math.max(0, inputStat.size - outputStat.size)
    }
  } finally {
    // 仅清理本次创建的私有临时目录，绝不处理原件或已有目标文件。
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
