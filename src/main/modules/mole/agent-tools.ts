import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { resolve } from 'node:path'
import type { MolePreviewResult } from '../../../shared/contracts/mole'
import { analyzeMole, listMoleApps, runMoleClean, runMoleDryRun } from './operations'
import { authorizeMoleSystem } from './service'
import { MoleWorkflowService } from './workflow'

function previewDetails(
  result: MolePreviewResult
): Pick<
  MolePreviewResult,
  | 'previewId'
  | 'candidates'
  | 'exitCode'
  | 'signal'
  | 'stdout'
  | 'stderr'
  | 'stdoutTruncated'
  | 'stderrTruncated'
> & { dryRun: true; incomplete: boolean; outputExcerpted: boolean } {
  const maxChars = 16_384
  return {
    dryRun: true,
    previewId: result.previewId,
    candidates: result.candidates,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout.slice(0, maxChars),
    stderr: result.stderr.slice(0, maxChars),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    outputExcerpted: result.stdout.length > maxChars || result.stderr.length > maxChars,
    incomplete: result.blocks.some((block) => block.partial)
  }
}

/** Definitions are per conversation, so saved selections cannot leak across chats. */
export async function createMoleTools(cwd: string): Promise<ToolDefinition[]> {
  const [{ Type }, { defineTool }] = await Promise.all([
    import('@earendil-works/pi-ai'),
    import('@earendil-works/pi-coding-agent')
  ])
  const workflow = new MoleWorkflowService()
  const id = Type.String({ pattern: '^[a-fA-F0-9-]{36}$' })
  const selection = Type.Object(
    {
      previewId: id,
      candidateIds: Type.Array(id, {
        minItems: 1,
        maxItems: 100,
        uniqueItems: true,
        description: '这份预览中用户已确认的候选 ID；不得用路径或猜测的 ID 替代。'
      })
    },
    { additionalProperties: false }
  )
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'mole_analyze',
      label: 'Mole 磁盘占用分析',
      description:
        '分析指定目录的占用、大目录和大文件。运行 analyze --json，不删除文件；根据结果可再次传子目录路径继续分析，无需保留进程。保留 scan_status；partial 或 unavailable 不代表空目录或扫描完整。',
      parameters: Type.Object(
        {
          path: Type.Optional(
            Type.String({ description: '要分析的目录，省略时使用会话工作目录。' })
          )
        },
        { additionalProperties: false }
      ),
      execute: async (_callId, { path }, signal) => {
        const details = await analyzeMole(resolve(cwd, path ?? '.'), signal)
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'mole_authorize_system',
      label: 'Mole 系统权限授权',
      description:
        '用户明确要求给 Mole 授权、检查或清理系统级项目时调用。复用缓存或弹出本机原生隐藏密码对话框建立短期 sudo 授权，密码不返回 Agent。授权不执行扫描或删除；仅要求授权时报告结果即可。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_callId, _request, signal) => {
        signal?.throwIfAborted()
        const details = await authorizeMoleSystem()
        signal?.throwIfAborted()
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'mole_clean_preview',
      label: 'Mole 清理预览',
      description:
        '预览当前 Mac 的缓存、日志和临时文件。固定运行 clean --dry-run，返回候选路径；不删除文件，不代表已经释放空间。用户仅要求授权时不得自动运行。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_callId, _request, signal, onUpdate) => {
        const result = await runMoleDryRun(
          (progress) => onUpdate?.({ content: [], details: { progress } }),
          signal
        )
        const details = previewDetails(result)
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'mole_clean',
      label: 'Mole 执行清理',
      description:
        '执行完整 Mole Clean，复用清理页的 Service 和队列。只在用户明确同意“按 Mole 规则直接删除并清空回收站已有内容，无法从回收站恢复”后调用；管理员授权不等于删除授权。不可用于“只清理几项”的请求，不接受路径、类别或命令参数；选择性处理仍用已展示路径的 trash。启动时复查 sudo，失效时返回 authorization-required，不自动重新授权或重试删除。失败、取消可能已有部分删除，须如实总结。',
      parameters: Type.Object(
        {
          confirmedDirectDeletionAndEmptyTrash: Type.Literal(true, {
            description: '用户已明确同意完整 Clean 的直接删除和清空回收站影响。'
          })
        },
        { additionalProperties: false }
      ),
      execute: async (_callId, _request, signal, onUpdate) => {
        const result = await runMoleClean(
          'clean',
          (progress) => onUpdate?.({ content: [], details: { progress } }),
          signal
        )
        const maxChars = 16_384
        const details = {
          ...result,
          output: result.output
            ? {
                ...result.output,
                blocks: undefined,
                stdout: result.output.stdout.slice(-maxChars),
                stderr: result.output.stderr.slice(-maxChars),
                stdoutTruncated:
                  result.output.stdoutTruncated || result.output.stdout.length > maxChars,
                stderrTruncated:
                  result.output.stderrTruncated || result.output.stderr.length > maxChars
              }
            : undefined
        }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'mole_uninstall_list',
      label: 'Mole 应用清单',
      description:
        '只读获取已安装应用的 path、Bundle ID、来源和大小。用户选定应用后将精确 appPaths 交给 mole_uninstall_preview 检查关联残留，不按名字猜测文件路径。',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_callId, _request, signal) => {
        const details = { apps: await listMoleApps(signal) }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    }),
    defineTool({
      name: 'mole_uninstall_preview',
      label: 'Mole 卸载范围预览',
      description:
        '按用户选中的应用绝对路径，复用 Mole 的真实关联残留发现与同 Bundle 多副本保护；只读、不终止应用。返回 previewId、候选 id、role、suggested、仅审阅系统残留和警告。role=app-data 默认保留；必须单独展示并获得明确授权才能选入执行。先展示用户要处理的应用和关联文件，再调用 mole_uninstall。',
      parameters: Type.Object(
        { appPaths: Type.Array(Type.String(), { minItems: 1, maxItems: 20, uniqueItems: true }) },
        { additionalProperties: false }
      ),
      execute: async (_callId, { appPaths }, signal, onUpdate) => {
        onUpdate?.({
          content: [],
          details: { progress: { type: 'stage', title: '正在扫描应用与关联残留…' } }
        })
        const details = await workflow.previewUninstall(appPaths, signal)
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
    })
  ]
  for (const [kind, label, description] of [
    [
      'installer',
      '安装包',
      '只读发现 DMG、PKG 等安装包，固定运行 installer --dry-run --debug；普通下载文件不属于清理范围。'
    ],
    [
      'purge',
      '开发产物',
      '只读发现已配置项目目录中的 node_modules、target、dist、.venv 等可重建产物，固定运行 purge --dry-run --debug；恢复可能需要联网安装或重新构建，不自动加入归档。'
    ]
  ] as const) {
    tools.push(
      defineTool({
        name: `mole_${kind}_preview`,
        label: `Mole ${label}预览`,
        description: `${description} 返回 previewId 和候选 id，供用户下一轮选择；确认后通过 mole_${kind} 只处理选中项。预览不代表已释放空间。`,
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async (_callId, _request, signal, onUpdate) => {
          const result = await workflow.preview(
            kind,
            (progress) => onUpdate?.({ content: [], details: { progress } }),
            signal
          )
          const details = previewDetails(result)
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
        }
      })
    )
  }
  for (const [kind, label] of [
    ['installer', '安装包清理'],
    ['purge', '开发产物清理'],
    ['uninstall', '卸载所选应用与残留']
  ] as const) {
    tools.push(
      defineTool({
        name: `mole_${kind}`,
        label: `Mole ${label}`,
        description: `用户明确授权这批已展示目标后，将该会话预览的 previewId 和选中 candidateIds 交给 Service，核对目标未变化后移入回收站。${kind === 'purge' ? '可重建不等于无影响，调用前说明恢复可能需要联网或重新构建。' : ''}${kind === 'uninstall' ? '应用数据默认保留，只有明确授权时才选入；系统级残留仅审阅。不运行 Homebrew Hook、不修改包管理记录、不终止进程；应用须先退出。' : ''}不接受任意路径、不永久删除、不运行 Mole --yes。同一份方案只执行一次；失败或部分完成后重新预览，不盲目重试。逐项检查 status、completed、failed、unprocessed 和 warnings，回收站成功不等于磁盘已释放。`,
        parameters: selection,
        execute: async (_callId, request, signal, onUpdate) => {
          const details = await workflow.execute(
            kind,
            request,
            (progress) => onUpdate?.({ content: [], details: { progress } }),
            signal
          )
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
        }
      })
    )
  }
  return tools
}
