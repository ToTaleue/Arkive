import type { VideoCompressionProgress } from '../../../shared/contracts/video'

/** FFmpeg progress records end at progress=continue/end; other output is ignored. */
export function createProgressReader(
  stage: 'encoding' | 'validating',
  durationSeconds: number,
  report: (progress: VideoCompressionProgress) => void,
  totalFrames?: number,
  now: () => number = () => performance.now()
): (line: string) => void {
  const started = now()
  let processedSeconds = 0
  let nextSeconds = 0
  let nextFrames = 0
  report({ stage, percent: 0, elapsedSeconds: 0, remainingSeconds: null })
  return (line) => {
    const separator = line.indexOf('=')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1).trim()
    if (key === 'frame' && /^\d+$/.test(value)) {
      const frames = Number(value)
      if (Number.isSafeInteger(frames)) nextFrames = frames
    }
    if (key === 'out_time_us' && /^-?\d+$/.test(value)) {
      const seconds = Number(value) / 1_000_000
      if (Number.isFinite(seconds)) nextSeconds = Math.max(0, seconds)
    }
    if (key !== 'progress' || !['continue', 'end'].includes(value)) return
    // With -copyts FFmpeg can report out_time_us=0 even after a short clip is encoded.
    if (totalFrames !== undefined && Number.isSafeInteger(totalFrames) && totalFrames > 0) {
      nextSeconds = (nextFrames / totalFrames) * durationSeconds
    }
    if (value === 'end') nextSeconds = durationSeconds
    processedSeconds = Math.min(durationSeconds, Math.max(processedSeconds, nextSeconds))
    const elapsedSeconds = Math.max(0, (now() - started) / 1000)
    const fraction = processedSeconds / durationSeconds
    // Include startup in the measured average; avoid an unstable estimate in the first 2s.
    const remainingSeconds =
      elapsedSeconds >= 2 && processedSeconds >= 0.1 && fraction < 0.999
        ? ((durationSeconds - processedSeconds) * elapsedSeconds) / processedSeconds
        : null
    report({
      stage,
      // FFmpeg may still be flushing buffers or moving MP4 metadata after its final frame.
      percent: Math.min(99, Math.floor(fraction * 100)),
      elapsedSeconds,
      remainingSeconds
    })
  }
}
