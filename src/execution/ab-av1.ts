import { dirname } from 'node:path'
import { getBundledToolPath, runBundledTool, type ToolProcessOptions } from './process'

export interface AbAv1SearchResult {
  quality: number
  sampleVmaf: number
  predictedVideoBytes: number
  predictedEncodingSeconds: number
}

/** Decode only the terminal success event, never an intermediate sample or error event. */
export function parseAbAv1SearchResult(stdout: string): AbAv1SearchResult {
  return parseResult(stdout, 'crf-search-done')
}

function parseResult(
  stdout: string,
  type: 'crf-search-done' | 'sample-encode-done'
): AbAv1SearchResult {
  const events: unknown[] = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown)
  const done = events.findLast(
    (event) => typeof event === 'object' && event !== null && 'type' in event && event.type === type
  )
  if (
    typeof done !== 'object' ||
    done === null ||
    !('crf' in done) ||
    typeof done.crf !== 'number' ||
    !Number.isFinite(done.crf) ||
    done.crf < 0 ||
    done.crf > 100 ||
    !('vmaf' in done) ||
    typeof done.vmaf !== 'number' ||
    !Number.isFinite(done.vmaf) ||
    done.vmaf < 0 ||
    done.vmaf > 100 ||
    !('predicted_encode_size' in done) ||
    typeof done.predicted_encode_size !== 'number' ||
    !Number.isSafeInteger(done.predicted_encode_size) ||
    done.predicted_encode_size <= 0 ||
    !('predicted_encode_seconds' in done) ||
    typeof done.predicted_encode_seconds !== 'number' ||
    !Number.isFinite(done.predicted_encode_seconds) ||
    done.predicted_encode_seconds < 0
  ) {
    throw new Error('自动选参结果不完整或数值无效。')
  }
  return {
    quality: done.crf,
    sampleVmaf: done.vmaf,
    predictedVideoBytes: done.predicted_encode_size,
    predictedEncodingSeconds: done.predicted_encode_seconds
  }
}

/** ab-av1 launches ffmpeg/ffprobe by name; use the exact binaries bundled with Arkive. */
export async function searchWithAbAv1(
  args: readonly string[],
  options: Pick<ToolProcessOptions, 'signal' | 'cwd'>
): Promise<AbAv1SearchResult> {
  return runAbAv1(args, options, 'crf-search-done')
}

/** Explicit q:v is needed for H.264 VideoToolbox; upstream only maps HEVC's crf to q:v. */
export async function sampleWithAbAv1(
  args: readonly string[],
  options: Pick<ToolProcessOptions, 'signal' | 'cwd'>
): Promise<AbAv1SearchResult> {
  return runAbAv1(args, options, 'sample-encode-done')
}

async function runAbAv1(
  args: readonly string[],
  options: Pick<ToolProcessOptions, 'signal' | 'cwd'>,
  terminalType: 'crf-search-done' | 'sample-encode-done'
): Promise<AbAv1SearchResult> {
  options.signal?.throwIfAborted()
  const tools = dirname(getBundledToolPath('ffmpeg'))
  getBundledToolPath('ffprobe')
  const result = await runBundledTool('ab-av1', args, {
    ...options,
    killTreeOnAbort: true,
    env: { ...process.env, PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin` }
  })
  options.signal?.throwIfAborted()
  if (result.exitCode !== 0 || result.signal || result.stdoutTruncated) {
    throw new Error(`自动选参失败；未改用固定参数或软件编码。\n${result.stderr.slice(-4096)}`)
  }
  return parseResult(result.stdout, terminalType)
}
