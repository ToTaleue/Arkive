import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from '@earendil-works/pi-ai'
import { shell } from 'electron'
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { runBundledTool } from '../../../execution/process'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import { compressImage } from '../image-compression/service'
import { runMoleDryRun } from '../mole/service'
import { compressVideo } from '../video-compression/service'

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function requireNewDestination(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  throw new Error(`目标已存在，未覆盖：${path}`)
}

function unavailableTool(
  name: string,
  label: string,
  description: string,
  parameters: TSchema
): ToolDefinition {
  // TODO: Connect an existing business API when available; do not implement it in this adapter.
  return {
    name,
    label,
    description: `${description} 当前仅占位，尚未实现；调用不会操作文件。`,
    parameters,
    execute: () => Promise.reject(new Error(`NOT_IMPLEMENTED: ${name} 尚未接入业务能力。`))
  }
}

export async function createArkiveTools(cwd: string): Promise<ToolDefinition[]> {
  // Preserve Pi AI's ESM import in the Electron CommonJS bundle.
  const [{ Type }, { defineTool }] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-coding-agent')
  ])
  return [
    defineTool({
      name: 'mole_analyze',
      label: 'Mole 磁盘占用分析',
      description:
        '分析指定目录的占用、大目录和大文件，供进一步检查用途和提出处理方案。运行 Mole analyze --json，不删除文件。保留 scan_status 等原始报告信息；partial 或 unavailable 不代表空目录，也不代表扫描完整。',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: '要分析的目录，省略时使用会话工作目录。' }))
      }),
      execute: async (_toolCallId, { path }, signal) => {
        const result = await runBundledTool(
          'mole',
          ['analyze', '--json', resolve(cwd, path ?? '.')],
          {
            signal
          }
        )
        signal?.throwIfAborted()
        if (result.exitCode !== 0 || result.signal) {
          throw new Error(`Mole 占用分析失败：${JSON.stringify(result)}`)
        }
        if (result.stdoutTruncated) {
          throw new Error('Mole 分析报告超出输出容量，结果不完整；请改为分析更具体的子目录。')
        }
        const report: unknown = JSON.parse(result.stdout)
        const details = { report, stderr: result.stderr, stderrTruncated: result.stderrTruncated }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
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
    },
    defineTool({
      name: 'compress_video',
      label: '视频压缩',
      description:
        '复用 Arkive 视频压缩业务。仅在用户已授权输入、输出位置和压缩操作后调用；生成新 MP4，保留原件，不覆盖已有文件。默认使用硬件 HEVC；compatibility=true 输出硬件 H.264 8bit，调用前须明确说明 10bit 原片将转为 8bit、体积可能更大；两种模式均保留原分辨率、帧时间关系与 AAC 音轨，HDR 等未支持特性仍拒绝。会移除字幕、章节、封面及其他辅助流，调用前向用户说明。结构和解码检查不代表感知画质验收。',
      parameters: Type.Object({
        inputPath: Type.String({ description: '源视频绝对路径。' }),
        outputPath: Type.String({ description: '用户授权的新 MP4 输出绝对路径，父目录须已存在。' }),
        preset: Type.Optional(
          Type.Union([Type.Literal('quality'), Type.Literal('balanced'), Type.Literal('size')])
        ),
        compatibility: Type.Optional(Type.Boolean())
      }),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        await assertSystemWriteAllowed(request.outputPath)
        const outputPath = await resolveFilePath(request.outputPath)
        const result = await compressVideo({ ...request, outputPath }, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'compress_image',
      label: '图片压缩',
      description:
        '复用 Arkive 图片压缩业务，仅在用户已授权输入、输出位置和压缩操作后调用。默认输出 WebP；显式 PNG 输出仅支持 PNG 输入，JPEG 输出或兼容性模式输出 JPEG。透明图片转 JPEG 须明确背景色。生成新文件，保留原件，不覆盖已有文件；体积减少不代表已经释放磁盘空间，结构检查不代表感知画质验收。',
      parameters: Type.Object({
        inputPath: Type.String({ description: '源图片绝对路径。' }),
        outputPath: Type.String({ description: '用户授权的新输出绝对路径，父目录须已存在。' }),
        outputFormat: Type.Optional(
          Type.Union([Type.Literal('webp'), Type.Literal('jpeg'), Type.Literal('png')])
        ),
        compatibility: Type.Optional(Type.Boolean()),
        quality: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: '已有业务的编码质量或 jpegoptim 质量上限；省略时沿用业务默认行为。'
          })
        ),
        jpegBackground: Type.Optional(Type.String({ description: '透明图片转 JPEG 的背景色。' }))
      }),
      execute: async (_toolCallId, request, signal) => {
        const result = await compressImage(request, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'move',
      label: '移动／重命名',
      description:
        '用户授权后移动或重命名文件／目录，直接使用 Node.js 文件 API。destinationPath 是完整的新路径，不自动拼接文件名，父目录须存在。默认拒绝已有目标；overwrite=true 仅在用户授权覆盖时使用，遵循系统 rename 的覆盖语义。跨卷移动返回错误并保留源文件，不自动复制后删除。',
      parameters: Type.Object({
        sourcePath: Type.String(),
        destinationPath: Type.String(),
        overwrite: Type.Optional(Type.Boolean())
      }),
      execute: async (_toolCallId, request, signal) => {
        const sourcePath = await resolveFilePath(request.sourcePath)
        const destinationPath = await resolveFilePath(request.destinationPath)
        if (isWithin(sourcePath, destinationPath) || isWithin(destinationPath, sourcePath)) {
          throw new Error('源路径与目标路径不能相同或互相包含。')
        }
        await assertSystemWriteAllowed(sourcePath, true)
        await assertSystemWriteAllowed(destinationPath, true)
        if (!request.overwrite) await requireNewDestination(destinationPath)
        signal?.throwIfAborted()
        await rename(sourcePath, destinationPath)
        const details = { sourcePath, destinationPath, operation: 'move' }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'copy',
      label: '复制文件',
      description:
        '用户授权后复制文件／目录，直接使用 Node.js fs.cp。destinationPath 是完整目标路径。默认递归复制目录、保留符号链接、拒绝覆盖；overwrite=true 须有覆盖授权。失败或取消可能留下部分副本，原件不删除；不要自动清理未确认的目标。',
      parameters: Type.Object({
        sourcePath: Type.String(),
        destinationPath: Type.String(),
        recursive: Type.Optional(Type.Boolean({ default: true })),
        overwrite: Type.Optional(Type.Boolean()),
        preserveTimestamps: Type.Optional(Type.Boolean()),
        verbatimSymlinks: Type.Optional(Type.Boolean())
      }),
      execute: async (_toolCallId, request, signal) => {
        const sourcePath = await resolveFilePath(request.sourcePath)
        const destinationPath = await resolveFilePath(request.destinationPath)
        if (isWithin(sourcePath, destinationPath) || isWithin(destinationPath, sourcePath)) {
          throw new Error('源路径与目标路径不能相同或互相包含。')
        }
        await assertSystemWriteAllowed(destinationPath, request.overwrite ?? false)
        if (!request.overwrite) await requireNewDestination(destinationPath)
        await cp(sourcePath, destinationPath, {
          recursive: request.recursive ?? true,
          force: request.overwrite ?? false,
          errorOnExist: true,
          preserveTimestamps: request.preserveTimestamps ?? false,
          verbatimSymlinks: request.verbatimSymlinks ?? false,
          filter: async (_source, destination) => {
            signal?.throwIfAborted()
            await assertSystemWriteAllowed(destination)
            return true
          }
        })
        const details = { sourcePath, destinationPath, operation: 'copy' }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'mkdir',
      label: '创建目录',
      description: '用户授权后通过 Node.js 创建目录；recursive 默认 true，可创建多层目录。',
      parameters: Type.Object({
        path: Type.String(),
        recursive: Type.Optional(Type.Boolean({ default: true })),
        mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 0o777 }))
      }),
      execute: async (_toolCallId, request, signal) => {
        const path = await resolveFilePath(request.path)
        await assertSystemWriteAllowed(path)
        signal?.throwIfAborted()
        await mkdir(path, { recursive: request.recursive ?? true, mode: request.mode })
        const details = { path, operation: 'mkdir' }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'trash',
      label: '清理文件',
      description:
        '用户授权后清理指定文件或目录。默认调用 Electron shell.trashItem 移入系统回收站；permanent=true 调用 Node.js 递归永久删除，必须有明确包含目标和永久删除方式的用户授权。回收站失败绝不改为永久删除。不清空整个回收站。逐项返回完成和失败结果；取消时停止后续项目，已开始的系统操作可能完成。移入回收站不等于已释放空间。',
      parameters: Type.Object({
        paths: Type.Array(Type.String(), { minItems: 1 }),
        permanent: Type.Optional(Type.Boolean({ description: '仅在用户明确授权永久删除时使用。' }))
      }),
      execute: async (_toolCallId, { paths, permanent = false }, signal) => {
        const completed: string[] = []
        const failed: { path: string; error: string }[] = []
        for (const requestedPath of paths) {
          try {
            signal?.throwIfAborted()
            const path = await resolveFilePath(requestedPath)
            await assertSystemWriteAllowed(path, true)
            signal?.throwIfAborted()
            if (permanent) await rm(path, { recursive: true })
            else await shell.trashItem(path)
            completed.push(requestedPath)
          } catch (error) {
            failed.push({ path: requestedPath, error: String(error) })
            if (signal?.aborted) break
          }
        }
        const details = {
          operation: permanent ? 'permanent-delete' : 'trash',
          completed,
          failed,
          unprocessed: paths.slice(completed.length + failed.length)
        }
        if (failed.length > 0) throw new Error(`清理未全部完成：${JSON.stringify(details)}`)
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    unavailableTool(
      'compress_pdf',
      'PDF 压缩',
      '复用 Arkive PDF 压缩业务。',
      Type.Object({ inputPath: Type.String(), outputPath: Type.String() })
    )
  ]
}
