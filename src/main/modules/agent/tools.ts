import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { shell } from 'electron'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import {
  compressImageAndBackup as compressImage,
  compressPdfAndBackup as compressPdf,
  compressVideoAndBackup as compressVideo
} from '../catalog/compression'
import { createMoleTools } from '../mole/agent-tools'
import { getCatalog } from '../catalog/service'
import { archiveFile, archivePath, tagArchives } from '../catalog/operations'
import { normalizeTags } from '../catalog/finder-tags'
import { compressOfficeInPlace } from '../office-compression/in-place'
import { inspectImage, inspectVideo, inspectPdf, inspectOffice } from '../processing/operations'
import { scanDuplicates } from '../duplicate-detection/operations'
import { cloneDuplicates } from '../clone-deduplication/operations'
import { copyPath, movePath, createDirectory, trashFiles } from '../file-operations/operations'

export async function createArkiveTools(cwd: string): Promise<ToolDefinition[]> {
  // Preserve Pi AI's ESM import in the Electron CommonJS bundle.
  const [{ Type }, { defineTool }] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-coding-agent')
  ])
  const tags = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100 })
  const recordId = Type.String({ pattern: '^[a-fA-F0-9-]{36}$' })
  const autoTag = Type.Optional(
    Type.Boolean({
      description:
        '归档时是否自动推荐并写入标签，默认 true。用户要求不加标签或仅用指定标签时设为 false；不删除已有标签，显式 tags 仍会应用。'
    })
  )
  const archiveOptions = {
    archive: Type.Optional(
      Type.Boolean({ description: '用户要求压缩后归档时设为 true，默认只压缩并备份原件。' })
    ),
    tags: Type.Optional({ ...tags, description: '归档标签，与 archive=true 一起使用；可省略。' }),
    autoTag,
    keepLinkAtOriginalLocation: Type.Optional(
      Type.Boolean({
        description:
          '仅在用户要求归档后保留原位置入口时设为 true，需 archive=true。默认关闭；不覆盖已有文件，检查归档结果 originalLink 的状态。'
      })
    )
  }
  return [
    ...[
      {
        name: 'inspect_image',
        label: '图片探测',
        inspect: (path: string, signal?: AbortSignal) => inspectImage({ inputPath: path }, signal)
      },
      { name: 'inspect_video', label: '视频探测', inspect: inspectVideo },
      {
        name: 'inspect_pdf',
        label: 'PDF 探测',
        inspect: (path: string, signal?: AbortSignal) => inspectPdf({ inputPath: path }, signal)
      }
    ].map(({ name, label, inspect }) =>
      defineTool({
        name,
        label,
        description: `只读${label}，返回格式、大小、结构和当前业务支持情况，供制定压缩方案；不修改文件，不保证一定有压缩收益。`,
        parameters: Type.Object(
          { inputPath: Type.String({ description: '用户授权检查的文件绝对路径。' }) },
          { additionalProperties: false }
        ),
        execute: async (_toolCallId, request, signal) => {
          signal?.throwIfAborted()
          const result = await inspect(request.inputPath, signal)
          signal?.throwIfAborted()
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
        }
      })
    ),
    defineTool({
      name: 'scan_duplicates',
      label: '重复文件检测',
      description:
        '只读递归检查用户指定文件夹中的重复文件，比较内容哈希，排除硬链接别名，不自动删除。partial 和 warnings 表示扫描不完整；redundantBytes 是逻辑重复内容大小，不是保证可释放的磁盘空间。',
      parameters: Type.Object({ directoryPath: Type.String() }, { additionalProperties: false }),
      execute: async (_toolCallId, request, signal) => {
        const result = await scanDuplicates(request, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'clone_duplicates',
      label: 'APFS 无损去重',
      description:
        '仅在用户明确授权这些路径进行 APFS 克隆替换后调用。sourcePath 为用户方案中选定的源，duplicatePaths 为已展示并获授权的重复副本，最多 100 个；不扫描目录。重新逐字节比对，在同一 APFS 卷上保留全部路径、内容及各副本元数据，后续修改互不影响。旧存储副本在验证后移除，不另存一份完整备份或进入回收站。硬链接、符号链接、不支持或变化中的文件不处理；items 可能部分失败，recoveryPath 表示保留了需恢复的事务文件。logicalBytesShared 不是实测释放空间；diskSpaceReclaimedBytes=null，不得承诺绝对安全或固定收益。',
      parameters: Type.Object(
        {
          sourcePath: Type.String({ description: '明确选定且已获授权的源文件绝对路径。' }),
          duplicatePaths: Type.Array(Type.String(), { minItems: 1, maxItems: 100 })
        },
        { additionalProperties: false }
      ),
      execute: async (_toolCallId, request, signal) => {
        const result = await cloneDuplicates(request, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'open_archive',
      label: '打开或定位归档文件',
      description:
        '按归档记录 id 打开已经归档的副本，或在 Finder 中定位。仅在用户要求打开或显示时使用；只接受已完成的归档记录，不能打开任意路径。',
      parameters: Type.Object(
        { id: recordId, action: Type.Union([Type.Literal('open'), Type.Literal('reveal')]) },
        { additionalProperties: false }
      ),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const path = await getCatalog().archivePath(request.id)
        signal?.throwIfAborted()
        if (request.action === 'open') {
          const error = await shell.openPath(path)
          if (error) throw new Error(error)
        } else shell.showItemInFolder(path)
        const result = { id: request.id, path, action: request.action, status: 'requested' }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'archive_path',
      label: '不压缩直接归档',
      description:
        '用户授权后，将一个普通文件原样校验复制到 Arkive Archive 并登记、打标签；不要求压缩收益，可用于 TXT、表格、压缩包、无收益文档等混合素材。默认保留原路径文件。用户要求搬过去并保留软链接时传 moveToArchive=true：正式归档校验后，仅将与归档内容一致的原路径文件换为软链接；内容保存在 Archive，不另建 Backup。不能对正在写入的数据库或未知用途文件自动执行。按每个文件调用，检查 archivePath、tagStatus、originalLink；已有路径冲突不覆盖，失败保留恢复记录。重复调用复用相同记录，不重新压缩。',
      parameters: Type.Object(
        {
          inputPath: Type.String({ description: '已授权归档的普通文件绝对路径。' }),
          tags: Type.Optional(tags),
          autoTag,
          moveToArchive: Type.Optional(
            Type.Boolean({
              description: '用户要求搬入归档并在原路径保留软链接时启用；默认只复制归档。'
            })
          )
        },
        { additionalProperties: false }
      ),
      execute: async (_toolCallId, request, signal) => {
        const result = await archivePath(
          getCatalog(),
          request.inputPath,
          request.tags ?? [],
          signal,
          request
        )
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'archive_file',
      label: '归档与原件备份',
      description:
        '用户授权后，按压缩结果的 catalog.id 归档已有结果。先核对或重试未完成的原件备份，再复制压缩结果到 Arkive Archive，不重新压缩，不覆盖文件。只接受已有压缩记录，不支持任意文件直接归档。重复调用复用同一副本；标签可选，合并原件已有标签。核对 backupStatus、archivePath、tagStatus，标签待同步不代表归档文件失败。',
      parameters: Type.Object({
        id: { ...recordId, description: '压缩工具返回的 catalog.id，或检索结果中的 id。' },
        tags: Type.Optional(tags),
        autoTag,
        moveToArchive: Type.Optional(
          Type.Boolean({
            description:
              '用户要求搬过去并留软链接时启用，允许将与归档内容完全一致的原位置文件换为链接，适用于 Office 原位结果；不同内容或其他链接不覆盖。'
          })
        ),
        keepLinkAtOriginalLocation: Type.Optional(
          Type.Boolean({
            description:
              '用户要求时，在原目录创建指向正式归档的软链接。默认关闭，已有文件不覆盖；入口失败不代表归档失败，检查 originalLink。'
          })
        )
      }),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const result = await archiveFile(
          getCatalog(),
          request.id,
          request.tags ?? [],
          signal,
          request
        )
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'search_archives',
      label: '检索归档与标签',
      description:
        '只读查询归档库，返回文件 id、原件备份位置、归档路径、当前标签、同步状态和可用标签（含预设）。名称匹配原文件名或输出文件名子串，多标签必须全部满足；日期是毫秒时间戳，起点包含、终点不包含，每页 50 条。不读取正文、不做 OCR；可用来获取快速打标前的记录和已有标签。',
      parameters: Type.Object({
        state: Type.Optional(
          Type.Union([Type.Literal('archived'), Type.Literal('pending')], {
            description: '默认 archived；pending 查询已压缩但尚未归档的结果，可用于恢复后续归档。'
          })
        ),
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
        '用户授权后，按记录 id 批量增删归档副本的标签，同步 Finder 与 SQLite，不搬迁文件，不修改备份或原输出。优先复用 search_archives 返回的预设和已有标签，也可使用用户指定或已确认建议中的具体标签；默认词库不是封闭名单。只应用明确的增删差量，不用整组旧值覆盖；逐项核对返回的 tagStatus 和 tagError。可供后续 AI 快速打标使用，但不自动读取正文或推断用户未授权的分类。',
      parameters: Type.Object({
        ids: Type.Array(recordId, { minItems: 1, maxItems: 100, uniqueItems: true }),
        add: Type.Optional(tags),
        remove: Type.Optional(tags)
      }),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const result = await tagArchives(
          getCatalog(),
          request.ids,
          request.add ?? [],
          request.remove ?? [],
          signal
        )
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    ...(await createMoleTools(cwd)),
    defineTool({
      name: 'inspect_office',
      label: 'Office 嵌入媒体探测',
      description:
        '只读探测普通 DOCX／PPTX 的包结构、大小及嵌入 JPEG／PNG、MP4 候选数量和其他媒体数量。不修改源文档、不访问外链；候选数量不代表一定可压缩，包校验不等于 Word／PowerPoint 打开或播放验收。旧版 DOC／PPT、宏、签名及加密文档不支持。',
      parameters: Type.Object(
        { inputPath: Type.String({ description: '源 DOCX／PPTX 文档绝对路径。' }) },
        { additionalProperties: false }
      ),
      execute: async (_toolCallId, request, signal) => {
        const result = await inspectOffice(request.inputPath, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'compress_office',
      label: 'Office 原路径压缩（实验性）',
      description:
        '实验性功能，复杂版式和嵌入媒体兼容性仍在验证，处理后须用 Word／PowerPoint 验看。用户明确授权后，压缩普通 DOCX／PPTX 内嵌媒体并替换原路径上的整份文档，保持文件名及文档格式。调用前说明有损压缩、原路径替换和完整原件移动到 Arkive Backup。JPEG／PNG 保持格式，MP4 输出 H.264 8bit 并复制 AAC；外链不访问；图片评分仅供参考，图片只要变小且校验通过就回填，不因评分低而跳过。不支持或视频质量未达标的媒体保留原样。默认质量优先，只有媒体和完整文档变小且校验通过才替换；无收益返回 unchanged。必须检查 replacementStatus、replacementError、media 和 catalog.backupStatus，不能只根据 status 宣称替换成功。选参和编码可取消；进入备份发布提交阶段后完成提交。归档须在 replaced 后用返回的 catalog.id 调用 archive_file，不再压缩。',
      parameters: Type.Object(
        {
          inputPath: Type.String({ description: '已授权原路径替换的 DOCX／PPTX 文档绝对路径。' }),
          preset: Type.Optional(
            Type.Union([Type.Literal('quality'), Type.Literal('balanced'), Type.Literal('size')])
          )
        },
        { additionalProperties: false }
      ),
      execute: async (_toolCallId, request, signal) => {
        signal?.throwIfAborted()
        const inputPath = await resolveFilePath(request.inputPath)
        await assertSystemWriteAllowed(inputPath, true)
        const result = await compressOfficeInPlace({ ...request, inputPath }, signal)
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      }
    }),
    defineTool({
      name: 'compress_video',
      label: '视频压缩',
      description:
        '复用 Arkive 视频压缩业务。仅在用户已授权输入、输出位置和压缩操作后调用；生成新 MP4，不覆盖已有文件；成功且有体积收益后会将原件移动到 Arkive Backup，调用前明确告知用户。仅支持硬件 HEVC 输出，暂不支持 H.264 转换；保留原分辨率、帧时间关系、支持的原片位深与 AAC 音轨，HDR 等未支持特性仍拒绝。会移除字幕、章节、封面及其他辅助流，调用前向用户说明。结构和解码检查不代表感知画质验收。',
      parameters: Type.Object(
        {
          inputPath: Type.String({ description: '源视频绝对路径。' }),
          outputPath: Type.String({
            description: '用户授权的新 MP4 输出绝对路径，父目录须已存在。'
          }),
          preset: Type.Optional(
            Type.Union([Type.Literal('quality'), Type.Literal('balanced'), Type.Literal('size')])
          ),
          ...archiveOptions
        },
        { additionalProperties: false }
      ),
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
        '复用 Arkive 图片压缩业务，仅在用户已授权输入、输出位置和压缩操作后调用。默认使用 Sharp 输出 WebP；preserveFormat 会保持 JPEG、PNG 或 WebP 原格式，其中 PNG 使用 pngquant，其余使用 Sharp。保留未受处理影响的元数据，更新变化字段并通过 metadataWarnings 报告无法保留的项目；生成新文件、不覆盖已有文件；成功且有体积收益后会将原件移动到 Arkive Backup，调用前明确告知用户；以体积收益为首要目标，遇到无收益逐级下调编码质量；SSIMULACRA2 仅供参考，低分或评分不可用不阻止输出，更小才采用；持平或变大则保留原件，不宣称压缩成功。',
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
            description: '起始编码质量；省略时按 preset 起步，无收益时会逐级下调。'
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
        const details = await movePath(request, signal)
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
        const details = await copyPath(request, signal)
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
        const details = await createDirectory(request, signal)
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
        const details = await trashFiles(paths, signal, permanent)
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'compress_pdf',
      label: 'PDF 压缩',
      description:
        '复用 Arkive PDF 压缩业务，仅在用户已授权输入、输出位置和压缩操作后调用。lossless 使用 qpdf 做结构优化；deep-lossless 使用 qpdf 压缩等级 9，仍然无损但更慢；balanced 和 size 也使用 qpdf 做无损结构优化。生成新 PDF，成功且有体积收益后按共用归档生命周期将原件校验后备份到 Arkive Backup，不覆盖已有文件。加密、数字签名和 PDF/A 暂不处理；balanced／size 不处理真实表单字段、Widget、XFA、批注和附件，只带空 AcroForm 字典的 PDF 可以压缩。输出会通过 qpdf 结构检查并比较页面数量与 PDF 特征。',
      parameters: Type.Object({
        inputPath: Type.String({ description: '源 PDF 绝对路径。' }),
        outputPath: Type.String({ description: '用户授权的新 PDF 输出绝对路径，父目录须已存在。' }),
        preset: Type.Optional(
          Type.Union([
            Type.Literal('lossless'),
            Type.Literal('deep-lossless'),
            Type.Literal('balanced'),
            Type.Literal('size')
          ])
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
