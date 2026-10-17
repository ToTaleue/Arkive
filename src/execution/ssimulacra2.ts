import { runBundledTool } from './process'

/** Run the bundled still-image SSIMULACRA2 CLI and return its 0–100 score. */
export async function scoreImagePair(
  sourcePath: string,
  distortedPath: string,
  signal?: AbortSignal
): Promise<number> {
  const result = await runBundledTool('ssimulacra2', ['image', sourcePath, distortedPath], {
    signal,
    maxOutputChars: 16_384
  })
  if (result.exitCode !== 0 || result.signal) {
    throw new Error(
      `SSIMULACRA2 评估失败（退出码 ${String(result.exitCode)}）：${(
        result.stderr || result.stdout
      ).slice(-4096)}`
    )
  }
  const match = /Score:\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(result.stdout)
  const score = match ? Number(match[1]) : Number.NaN
  if (!Number.isFinite(score)) throw new Error('SSIMULACRA2 未返回有效评分。')
  return score
}
