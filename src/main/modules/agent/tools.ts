import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { shell } from 'electron'
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { runBundledTool } from '../../../execution/process'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import {
  compressImageAndBackup as compressImage,
  compressPdfAndBackup as compressPdf,
  compressVideoAndBackup as compressVideo
} from '../catalog/compression'
import { runMoleDryRun } from '../mole/service'
import { getCatalog } from '../catalog/service'
import { normalizeTags } from '../catalog/finder-tags'

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

export async function createArkiveTools(cwd: string): Promise<ToolDefinition[]> {
  // Preserve Pi AI's ESM import in the Electron CommonJS bundle.
  const [{ Type }, { defineTool }] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-coding-agent')
  ])
  const tags = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100 })
  const recordId = Type.String({ pattern: '^[a-fA-F0-9-]{36}$' })
  const archiveOptions = {
    archive: Type.Optional(
      Type.Boolean({ description: '用户要求压缩后归档时设为 true，默认只压缩并备份原件。' })
    ),
    tags: Type.Optional({ ...tags, description: '归档标签，与 archive=true 一起使用；可省略。' })
  }
  return [
    defineTool({
      name: 'archive_file',
      label: '归档与原件备份',
      description:
        '用户授权后，按压缩结果的 catalog.id 归档已有结果。先核对或重试未完成的原件备份，再复制压缩结果到 Arkive Archive，不重新压缩，不覆盖文件。只接受已有压缩记录，不支持任意文件直接归档。重复调用复用同一副本；标签可选，合并原件已有标签。核对 backupStatus、archivePath、tagStatus，标签待同步不代表归档文件失败。',
      parameters: Type.Object({
        id: { ...recordId, description: '压缩工具返回的 catalog.id，或检索结果中的 id。' },
        tags: Type.Optional(tags)
      }),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const result = await getCatalog().archive(request.id, request.tags ?? [])
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'search_archives',
      label: '检索归档与标签',
      description:
        '只读查询归档库，返回文件 id、原件备份位置、归档路径、当前标签、同步状态和可用标签（含预设）。名称匹配原文件名或输出文件名子串，多标签必须全部满足；日期是毫秒时间戳，起点包含、终点不包含，每页 50 条。不读取正文、不做 OCR；可用来获取快速打标前的记录和已有标签。',
      parameters: Type.Object({
        name: Type.Optional(Type.String({ maxLength: 500 })),
        tags: Type.Optional(tags),
        modifiedFrom: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        modifiedTo: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        archivedFrom: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        archivedTo: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
      }),
      execute: (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const result = getCatalog().query({ ...request, tags: normalizeTags(request.tags ?? []) })
        return Promise.resolve({
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result
        })
      }
    }),
    defineTool({
      name: 'tag_archives',
      label: '批量修改归档标签',
      description:
        '用户授权后，按记录 id 批量增删归档副本的标签，同步 Finder 与 SQLite，不搬迁文件，不修改备份或原输出。优先复用 search_archives 返回的预设和已有标签，可使用用户指定的自定义标签。只应用明确的增删差量，不用整组旧值覆盖；逐项核对返回的 tagStatus 和 tagError。可供后续 AI 快速打标使用，但不自动读取正文或推断用户未授权的分类。',
      parameters: Type.Object({
        ids: Type.Array(recordId, { minItems: 1, maxItems: 100, uniqueItems: true }),
        add: Type.Optional(tags),
        remove: Type.Optional(tags)
      }),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const catalog = getCatalog()
        await catalog.editTags(request.ids, request.add ?? [], request.remove ?? [])
        const result = { items: request.ids.map((id) => catalog.get(id)) }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
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
        '复用 Arkive 视频压缩业务。仅在用户已授权输入、输出位置和压缩操作后调用；生成新 MP4，不覆盖已有文件；成功且有体积收益后会将原件移动到 Arkive Backup，调用前明确告知用户。默认使用硬件 HEVC；compatibility=true 输出硬件 H.264 8bit，调用前须明确说明 10bit 原片将转为 8bit、体积可能更大；两种模式均保留原分辨率、帧时间关系与 AAC 音轨，HDR 等未支持特性仍拒绝。会移除字幕、章节、封面及其他辅助流，调用前向用户说明。结构和解码检查不代表感知画质验收。',
      parameters: Type.Object({
        inputPath: Type.String({ description: '源视频绝对路径。' }),
        outputPath: Type.String({ description: '用户授权的新 MP4 输出绝对路径，父目录须已存在。' }),
        preset: Type.Optional(
          Type.Union([Type.Literal('quality'), Type.Literal('balanced'), Type.Literal('size')])
        ),
        compatibility: Type.Optional(Type.Boolean()),
        ...archiveOptions
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
        '复用 Arkive 图片压缩业务，仅在用户已授权输入、输出位置和压缩操作后调用。默认使用 Sharp 输出 WebP；preserveFormat 会保持 JPEG、PNG 或 WebP 原格式，其中 PNG 使用 pngquant，其余使用 Sharp。元数据会被丢弃，生成新文件、不覆盖已有文件；成功且有体积收益后会将原件移动到 Arkive Backup，调用前明确告知用户；所有输出都使用 SSIMULACRA2 评估，最多尝试两个候选质量。',
      parameters: Type.Object({
        inputPath: Type.String({ description: '源图片绝对路径。' }),
        outputPath: Type.String({ description: '用户授权的新输出绝对路径，父目录须已存在。' }),
        outputFormat: Type.Optional(
          Type.Union([Type.Literal('webp'), Type.Literal('jpeg'), Type.Literal('png')])
        ),
        preset: Type.Optional(
          Type.Union([Type.Literal('quality'), Type.Literal('balanced'), Type.Literal('size')])
        ),
        preserveFormat: Type.Optional(
          Type.Boolean({ description: '保持 JPEG、PNG 或 WebP 原格式；PNG 使用 pngquant。' })
        ),
        quality: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            description: '显式编码质量；省略时按 preset 最多尝试两个候选质量。'
          })
        ),
        jpegBackground: Type.Optional(Type.String({ description: '透明图片转 JPEG 的背景色。' })),
        ...archiveOptions
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
    defineTool({
      name: 'compress_pdf',
      label: 'PDF 压缩',
      description:
        '复用 Arkive PDF 压缩业务，仅在用户已授权输入、输出位置和压缩操作后调用。lossless 使用 qpdf 做结构优化；balanced 使用 Ghostscript ebook 预设；size 使用 Ghostscript screen 预设。生成新 PDF，成功且有体积收益后按共用归档生命周期将原件校验后备份到 Arkive Backup，不覆盖已有文件。加密、数字签名和 PDF/A 暂不处理；balanced／size 不处理表单、批注和附件。输出会通过 qpdf 结构检查并比较页面数量与 PDF 特征。',
      parameters: Type.Object({
        inputPath: Type.String({ description: '源 PDF 绝对路径。' }),
        outputPath: Type.String({ description: '用户授权的新 PDF 输出绝对路径，父目录须已存在。' }),
        preset: Type.Optional(
          Type.Union([Type.Literal('lossless'), Type.Literal('balanced'), Type.Literal('size')])
        ),
        ...archiveOptions
      }),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        await assertSystemWriteAllowed(request.outputPath)
        const outputPath = await resolveFilePath(request.outputPath)
        const result = await compressPdf({ ...request, outputPath }, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    })
  ]
}
