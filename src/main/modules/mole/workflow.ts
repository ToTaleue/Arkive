import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, relative, isAbsolute, sep } from 'node:path'
import type {
  MoleOutputEvent,
  MolePreviewResult,
  MoleSelectionCandidate,
  MoleSelectionKind,
  MoleSelectionResult,
  MoleUninstallInspection,
  MoleUninstallPreview
} from '../../../shared/contracts/mole'
import { assertSystemWriteAllowed, resolveFilePath } from '../../system-paths'
import { runTask, TaskCancelled, TaskFailure } from '../../tasks/service'
import { trashPaths } from '../file-operations/service'
import { runMoleInstallerPreview, runMolePurgePreview, previewMoleUninstall } from './operations'
import { previewMoleUninstall as inspectUninstall } from './service'

type SelectionPlan = {
  kind: MoleSelectionKind
  candidates: MoleSelectionCandidate[]
  identities: Map<string, string | undefined>
  inspection?: MoleUninstallInspection
  appPaths?: string[]
  warnings: string[]
  state: 'ready' | 'running' | 'finished'
  result?: MoleSelectionResult
  selectedIds?: string[]
}

function covers(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

async function identity(path: string): Promise<string> {
  const resolved = await resolveFilePath(path)
  const info = await lstat(resolved)
  // Bind the object, parent resolution, contents metadata and (for apps) Info.plist.
  let plist = ''
  if (/\.app$/i.test(path) && info.isDirectory()) {
    const file = await lstat(`${resolved}/Contents/Info.plist`)
    plist = JSON.stringify([file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs])
  }
  return JSON.stringify([
    await realpath(dirname(path)),
    info.dev,
    info.ino,
    info.mode,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
    plist
  ])
}

/** One instance per Agent conversation or UI window. Stores plans, never live processes. */
export class MoleWorkflowService {
  private readonly plans = new Map<string, SelectionPlan>()

  async preview(
    kind: 'installer' | 'purge',
    onUpdate: (event: MoleOutputEvent) => void,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<MolePreviewResult> {
    const result = await (kind === 'installer' ? runMoleInstallerPreview : runMolePurgePreview)(
      onUpdate,
      signal,
      requestId
    )
    // Partial previews remain readable, but must never become executable plans.
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.blocks.some((block) => block.partial)
    )
      return result
    const saved = await this.save(
      kind,
      result.candidates.map((candidate) => ({
        ...candidate,
        id: randomUUID(),
        suggested: kind === 'installer'
      })),
      [],
      signal
    )
    return { ...result, previewId: saved.id, candidates: saved.plan.candidates }
  }

  async previewUninstall(
    appPaths: string[],
    signal?: AbortSignal,
    requestId?: string
  ): Promise<MoleUninstallPreview> {
    appPaths = [...appPaths]
    const inspection = await previewMoleUninstall(appPaths, signal, requestId)
    const candidates = inspection.candidates.map((candidate): MoleSelectionCandidate => {
      const role =
        candidate.role === 'app'
          ? 'app'
          : /\/Library\/Caches\//.test(candidate.path)
            ? 'cache'
            : /\/Library\/Logs\//.test(candidate.path)
              ? 'log'
              : 'app-data'
      return {
        ...candidate,
        id: randomUUID(),
        role,
        suggested: role !== 'app-data',
        category: role === 'app-data' ? '应用数据，默认保留' : role
      }
    })
    const warnings = [
      ...inspection.warnings,
      '仅将所选应用与关联文件移入回收站；不运行 Homebrew 卸载 Hook、不卸载系统扩展、不终止应用进程。系统级残留仅供审阅。'
    ]
    const saved = await this.save('uninstall', candidates, warnings, signal)
    saved.plan.inspection = inspection
    saved.plan.appPaths = appPaths
    return {
      previewId: saved.id,
      dryRun: true,
      apps: inspection.apps.map(({ path, bundleId }) => ({ path, bundleId })),
      candidates: saved.plan.candidates,
      reviewOnly: inspection.reviewOnly,
      warnings,
      diagnostics: inspection.diagnostics
    }
  }

  private async save(
    kind: MoleSelectionKind,
    candidates: MoleSelectionCandidate[],
    warnings: string[],
    signal?: AbortSignal
  ): Promise<{ id: string; plan: SelectionPlan }> {
    if (candidates.length > 5000) throw new Error('候选超过 5000 项，请缩小扫描范围。')
    const plan: SelectionPlan = {
      kind,
      candidates,
      identities: new Map(),
      warnings,
      state: 'ready'
    }
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        plan.identities.set(candidate.id, await identity(candidate.path))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        candidate.suggested = false
        candidate.unavailableReason = '预览后路径已不存在，请重新扫描。'
        plan.identities.set(candidate.id, undefined)
      }
    }
    signal?.throwIfAborted()
    // Bounded in-memory retention; old ids fail closed and require a fresh preview.
    if (this.plans.size >= 20) {
      const oldest = [...this.plans].find(([, value]) => value.state !== 'running')
      if (!oldest) throw new Error('正在处理的清理方案过多。')
      this.plans.delete(oldest[0])
    }
    const id = randomUUID()
    this.plans.set(id, plan)
    return { id, plan }
  }

  async execute(
    kind: MoleSelectionKind,
    request: { previewId: string; candidateIds: string[] },
    onUpdate: (event: MoleOutputEvent) => void,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<MoleSelectionResult> {
    signal?.throwIfAborted()
    const plan = this.plans.get(request.previewId)
    if (!plan || plan.kind !== kind)
      throw new Error('清理方案不存在、已过期或不属于此会话，请重新预览。')
    const ids = [...request.candidateIds]
    if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length)
      throw new Error('请选择 1 至 100 个不同的候选 ID。')
    const selected = ids.map((id) => {
      const candidate = plan.candidates.find((item) => item.id === id)
      if (!candidate) throw new Error('所选 ID 不属于这份候选清单。')
      return candidate
    })
    if (
      selected.some((item, index) =>
        selected.some((other, otherIndex) => index !== otherIndex && covers(item.path, other.path))
      )
    )
      throw new Error('选中项包含重复或互相包含的路径，请只选择外层目录。')
    // A plan is consumed once, including partial runs; retries cannot delete another batch.
    if (plan.state === 'finished') {
      if (plan.result && JSON.stringify(ids.slice().sort()) === JSON.stringify(plan.selectedIds))
        return structuredClone(plan.result)
      throw new Error('此方案已执行，请重新预览后选择。')
    }
    if (plan.state === 'running') throw new Error('此方案正在执行。')
    const result: MoleSelectionResult = {
      kind,
      previewId: request.previewId,
      operation: 'trash',
      status: 'failed',
      completed: [],
      failed: [],
      unprocessed: selected.map((item) => item.path),
      retained: plan.candidates
        .filter((item) => !selected.some((chosen) => covers(chosen.path, item.path)))
        .map((item) => item.path),
      warnings: [...plan.warnings],
      diagnostics: plan.inspection?.diagnostics
    }
    plan.state = 'running'
    try {
      return await runTask(
        {
          title: `Mole ${kind}：所选项目移入回收站`,
          key: 'mole-preview',
          requestId,
          run: async (taskSignal, report) => {
            const stage = (title: string): void => {
              report({ message: title })
              onUpdate({ type: 'stage', title })
            }
            stage('正在核对已确认的候选…')
            // Preflight the whole batch before its first write, then check each object again.
            for (const item of selected) await this.check(plan, item, taskSignal)
            if (plan.appPaths && plan.inspection) {
              const current = await inspectUninstall(plan.appPaths, taskSignal)
              result.diagnostics = [
                ...new Set([...(result.diagnostics ?? []), ...(current.diagnostics ?? [])])
              ]
              if (current.warnings.some((warning) => warning.includes('Application is running;')))
                throw new Error('待卸载应用仍在运行，请退出应用后重新预览。')
              for (const app of plan.inspection.apps) {
                if (
                  !current.apps.some(
                    (item) =>
                      item.path === app.path &&
                      item.bundleId === app.bundleId &&
                      item.policy === app.policy
                  )
                )
                  throw new Error('应用、共享数据或其他安装副本已变化，请重新预览。')
              }
              if (
                selected.some(
                  (item) =>
                    !current.candidates.some(
                      (candidate) =>
                        candidate.path === item.path && candidate.appPath === item.appPath
                    )
                )
              )
                throw new Error('应用关联残留已变化，请重新预览。')
            }
            for (let index = 0; index < selected.length; index++) {
              const item = selected[index]
              try {
                await this.check(plan, item, taskSignal)
                stage(
                  `正在移入回收站 ${String(index + 1)}/${String(selected.length)}：${item.name}`
                )
                // Lower-level shared service: avoid submitting a nested Task into the queue.
                await trashPaths([item.path], taskSignal)
                result.completed.push(item.path)
              } catch (error) {
                if (taskSignal.aborted) throw new TaskCancelled('已停止，已完成项保留。', result)
                result.failed.push({
                  path: item.path,
                  error: error instanceof Error ? error.message : String(error)
                })
              }
              result.unprocessed = selected.slice(index + 1).map((item) => item.path)
            }
            result.status = result.failed.length
              ? result.completed.length
                ? 'partial'
                : 'failed'
              : 'completed'
            if (result.failed.length) throw new TaskFailure('所选项目未全部移入回收站。', result)
            return result
          }
        },
        signal
      )
    } catch (error) {
      result.status =
        signal?.aborted || error instanceof TaskCancelled
          ? 'cancelled'
          : result.completed.length
            ? 'partial'
            : 'failed'
      if (!result.failed.length && result.status !== 'cancelled')
        result.warnings.push(error instanceof Error ? error.message : String(error))
      return result
    } finally {
      plan.state = 'finished'
      plan.result = structuredClone(result)
      plan.selectedIds = ids.slice().sort()
    }
  }

  private async check(
    plan: SelectionPlan,
    item: MoleSelectionCandidate,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await assertSystemWriteAllowed(item.path, true)
    if (
      !plan.identities.get(item.id) ||
      (await identity(item.path)) !== plan.identities.get(item.id)
    )
      throw new Error(`候选已变化或不可用，请重新预览：${item.path}`)
    // Reject symlinks rather than widening scope through aliases.
    if ((await lstat(item.path)).isSymbolicLink())
      throw new Error(`候选为符号链接，请重新检查：${item.path}`)
  }
}
