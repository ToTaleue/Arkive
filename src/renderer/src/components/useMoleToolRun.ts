import { useCallback, useEffect, useRef, useState } from 'react'
import type { MoleOutputBlock } from '../../../shared/contracts/mole'
import { useCompressionTask, compressionTaskMessage } from '../hooks/useCompressionTask'

export type MoleToolRun = {
  run: <T>(work: (id: string) => Promise<T>) => Promise<T | undefined>
  stop: () => Promise<void>
  reveal: (path: string) => Promise<void>
  busy: boolean
  stopping: boolean
  error: string
  notice: string
  blocks: MoleOutputBlock[]
  progress: string
}
export function useMoleToolRun(): MoleToolRun {
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [blocks, setBlocks] = useState<MoleOutputBlock[]>([])
  const [stage, setStage] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const active = useRef<string | null>(null)
  const stopped = useRef(false)
  const task = useCompressionTask(requestId)
  useEffect(
    () =>
      window.api?.mole.onUpdate((update) => {
        if (update.runId !== active.current) return
        if (update.event.type === 'stage') setStage(update.event.title)
        else {
          const block = update.event.block
          setBlocks((current) => [...current, block])
        }
      }),
    []
  )
  const wasStopped = (): boolean => stopped.current
  const run = useCallback(async <T>(work: (id: string) => Promise<T>): Promise<T | undefined> => {
    if (active.current) return
    const id = crypto.randomUUID()
    active.current = id
    stopped.current = false
    setRequestId(id)
    setBusy(true)
    setStopping(false)
    setError('')
    setNotice('')
    setBlocks([])
    setStage('正在提交任务…')
    try {
      return await work(id)
    } catch (failure) {
      if (wasStopped()) setNotice('操作已停止。请检查已完成的处理结果。')
      else setError(failure instanceof Error ? failure.message : String(failure))
      return undefined
    } finally {
      active.current = null
      setBusy(false)
      setStopping(false)
    }
  }, [])
  async function stop(): Promise<void> {
    if (!active.current || !window.api) return
    stopped.current = true
    setStopping(true)
    try {
      await window.api.mole.cancel(active.current)
    } catch (failure) {
      setStopping(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  async function reveal(path: string): Promise<void> {
    if (!window.api) return
    try {
      await window.api.mole.reveal(path)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }
  return {
    run,
    reveal,
    stop,
    busy,
    stopping,
    error,
    notice,
    blocks,
    progress: compressionTaskMessage(task) ?? stage
  }
}
