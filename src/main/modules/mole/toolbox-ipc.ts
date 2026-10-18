import { ipcMain, shell, type IpcMainInvokeEvent, type WebFrameMain } from 'electron'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  moleChannels,
  moleToolboxChannels,
  type MoleOutputEvent,
  type MoleSelectionKind
} from '../../../shared/contracts/mole'
import { analyzeMole, listMoleApps } from './operations'
import { MoleWorkflowService } from './workflow'

type WindowSession = {
  frame: WebFrameMain | null
  workflow: MoleWorkflowService
  runs: Map<string, AbortController>
}

export function registerMoleToolboxIpc(): void {
  const sessions = new Map<number, WindowSession>()
  const observed = new Set<number>()
  const reset = (id: number): void => {
    const session = sessions.get(id)
    session?.runs.forEach((controller) => {
      controller.abort()
    })
    sessions.delete(id)
  }
  const sessionFor = (event: IpcMainInvokeEvent): WindowSession => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('无效的工具箱请求。')
    const id = event.sender.id
    if (!observed.has(id)) {
      observed.add(id)
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) reset(id)
      })
      event.sender.on('render-process-gone', () => {
        reset(id)
      })
      event.sender.once('destroyed', () => {
        reset(id)
        observed.delete(id)
      })
    }
    if (sessions.get(id)?.frame !== event.senderFrame) reset(id)
    let session = sessions.get(id)
    if (!session) {
      session = { frame: event.senderFrame, workflow: new MoleWorkflowService(), runs: new Map() }
      sessions.set(id, session)
    }
    return session
  }
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
  const kindOf = (value: unknown): MoleSelectionKind => {
    if (value !== 'installer' && value !== 'purge' && value !== 'uninstall')
      throw new Error('未知的工具类型。')
    return value
  }
  const run = async <T>(
    event: IpcMainInvokeEvent,
    id: unknown,
    work: (
      session: WindowSession,
      signal: AbortSignal,
      emit: (event: MoleOutputEvent) => void
    ) => Promise<T>
  ): Promise<T> => {
    const session = sessionFor(event)
    if (!validId(id) || session.runs.has(id)) throw new Error('无效或重复的工具运行 ID。')
    const controller = new AbortController()
    session.runs.set(id, controller)
    const emit = (output: MoleOutputEvent): void => {
      if (!event.sender.isDestroyed() && event.sender.mainFrame === session.frame)
        event.sender.send(moleChannels.update, { runId: id, event: output })
    }
    try {
      return await work(session, controller.signal, emit)
    } finally {
      session.runs.delete(id)
    }
  }
  ipcMain.handle(moleToolboxChannels.analyze, (event, id: unknown, path: unknown) => {
    if (path !== undefined && typeof path !== 'string') throw new Error('无效的分析路径。')
    return run(event, id, (_session, signal) => analyzeMole(path, signal, String(id)))
  })
  ipcMain.handle(moleToolboxChannels.apps, (event, id: unknown) =>
    run(event, id, (_session, signal) => listMoleApps(signal, String(id)))
  )
  ipcMain.handle(moleToolboxChannels.preview, (event, id: unknown, kind: unknown) => {
    if (kind !== 'installer' && kind !== 'purge') throw new Error('无效的预览类型。')
    return run(event, id, async (session, signal, emit) => {
      const result = await session.workflow.preview(kind, emit, signal, String(id))
      // File sizes come from the confirmed paths; never guess a directory's recursive size.
      const candidates = await Promise.all(
        result.candidates.map(async (candidate) => {
          signal.throwIfAborted()
          const info = await lstat(candidate.path).catch(() => undefined)
          return { ...candidate, sizeBytes: info?.isFile() ? info.size : undefined }
        })
      )
      signal.throwIfAborted()
      return { ...result, candidates }
    })
  })
  ipcMain.handle(moleToolboxChannels.uninstallPreview, (event, id: unknown, paths: unknown) => {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 20 ||
      !paths.every((p: unknown): p is string => typeof p === 'string')
    )
      throw new Error('无效的应用选择。')
    return run(event, id, (session, signal) =>
      session.workflow.previewUninstall(paths, signal, String(id))
    )
  })
  ipcMain.handle(
    moleToolboxChannels.execute,
    (event, id: unknown, kind: unknown, request: unknown) => {
      const selectionKind = kindOf(kind)
      if (
        !request ||
        typeof request !== 'object' ||
        !('previewId' in request) ||
        !validId(request.previewId) ||
        !('candidateIds' in request) ||
        !Array.isArray(request.candidateIds) ||
        !request.candidateIds.length ||
        request.candidateIds.length > 100 ||
        !request.candidateIds.every(validId)
      )
        throw new Error('无效的候选选择，请重新预览。')
      const selection = {
        previewId: request.previewId,
        candidateIds: request.candidateIds
      }
      return run(event, id, (session, signal, emit) =>
        session.workflow.execute(selectionKind, selection, emit, signal, String(id))
      )
    }
  )
  ipcMain.handle(moleToolboxChannels.cancel, (event, id: unknown) => {
    if (!validId(id)) throw new Error('无效的运行 ID。')
    sessionFor(event).runs.get(id)?.abort()
  })
  ipcMain.handle(moleToolboxChannels.reveal, (event, path: unknown) => {
    sessionFor(event)
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
      throw new Error('无效的文件路径。')
    shell.showItemInFolder(path)
  })
}
