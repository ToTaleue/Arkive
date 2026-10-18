import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentService } from '../agent/service'
import type { AgentUpdate } from '../../../shared/contracts/agent'

export function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

export function jsonFile(root: string, name: string, data: unknown): Promise<void> {
  return writeFile(join(root, name), JSON.stringify(data))
}

export function messageText(message: {
  content: string | { type: string; text?: string }[]
}): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
}

export function loadBuilt(root: string, name: string): Promise<unknown> {
  return import(pathToFileURL(join(root, `${name}.mjs`)).href)
}

export function sendChunk(
  response: ServerResponse,
  delta: unknown,
  finish_reason: string | null = null
): boolean {
  return response.write(
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  )
}

export async function generated(root: string, name: string, contents = 'fixture'): Promise<string> {
  const path = join(root, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
  return path
}

export function createToolCaller(
  service: AgentService,
  updates: AgentUpdate[]
): (name: string, args?: Record<string, unknown>, conversationId?: string) => Promise<string> {
  let requestId = 0
  return async (name, args = {}, conversationId = 'workflow') => {
    const result = await service.send(
      {
        conversationId,
        requestId: `request-${String(++requestId)}`,
        text: `CALL ${JSON.stringify({ name, args })}`
      },
      (update) => updates.push(update)
    )
    assert.equal(result.status, 'completed', JSON.stringify(result))
    return result.text
  }
}
