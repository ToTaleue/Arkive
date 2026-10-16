import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { runMoleDryRun } from '../mole/service'

export async function createArkiveTools(): Promise<ToolDefinition[]> {
  // Preserve Pi AI's ESM import in the Electron CommonJS bundle.
  const { Type } = await import('@earendil-works/pi-ai')
  return [
    {
      name: 'mole_clean_preview',
      label: 'Mole 清理预览',
      description:
        '预览当前 Mac 中 Mole 建议清理的缓存、日志和临时文件。固定运行 clean --dry-run，不删除清理目标，不接受命令参数。仅在用户要求检查清理机会或预览清理时使用；结果只代表预览，不代表已经释放空间。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_toolCallId, _params, signal) => {
        const result = await runMoleDryRun(() => undefined, signal)
        const maxChars = 16_384
        const details = {
          dryRun: true,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout.slice(0, maxChars),
          stderr: result.stderr.slice(0, maxChars),
          stdoutTruncated: result.stdoutTruncated || result.stdout.length > maxChars,
          stderrTruncated: result.stderrTruncated || result.stderr.length > maxChars
        }
        if (result.exitCode !== 0) {
          throw new Error(`Mole 清理预览失败：${JSON.stringify(details)}`)
        }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }
  ]
}
