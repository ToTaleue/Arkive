import { presetTags } from '../../../shared/contracts/catalog'
import type {
  TagMetadataValue,
  TagRecommendationFile,
  TagRecommendationInput,
  TagRecommendationItem,
  TagRecommendationResult
} from '../../../shared/contracts/tag-recommendation'
import { agentErrorMessage } from '../agent/config'
import { createConfiguredModel } from '../agent/model'
import { tagRecommendationPrompt } from './tag-recommendation-prompt'

interface PreparedInput {
  payload: {
    vocabulary: string[]
    files: (TagRecommendationFile & { existingTags: string[] })[]
    userContext?: string
    corrections: NonNullable<TagRecommendationInput['corrections']>
  }
  json: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('标签推荐资料或回复须为对象。')
  }
  return value as Record<string, unknown>
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`标签推荐列表须为数组且不超过 ${String(maximum)} 项。`)
  }
  return value as unknown[]
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error(`标签推荐文本须非空且不超过 ${String(maximum)} 字符。`)
  }
  return value.trim()
}

function tagName(value: unknown): string {
  const name = text(value, 100).normalize('NFC')
  if (/[\r\n]/u.test(name)) throw new Error('标签名称须为单行文本。')
  return name
}

function tags(value: unknown, maximum: number): string[] {
  return [...new Set(array(value, maximum).map(tagName))]
}

function metadata(value: unknown): Record<string, TagMetadataValue> {
  return Object.fromEntries<TagMetadataValue>(
    Object.entries(object(value)).map(([key, entry]): [string, TagMetadataValue] => {
      text(key, 100)
      if (
        entry === null ||
        typeof entry === 'string' ||
        typeof entry === 'boolean' ||
        (typeof entry === 'number' && Number.isFinite(entry))
      ) {
        return [key, entry]
      }
      if (Array.isArray(entry) && entry.every((part: unknown) => typeof part === 'string')) {
        return [key, entry]
      }
      throw new Error('标签推荐元数据只接受已整理的文本、有限数字、布尔值、null 或文本数组。')
    })
  )
}

function prepareInput(input: TagRecommendationInput): PreparedInput {
  const source = object(input)
  const files = array(source.files, 10).map((entry) => {
    const file = object(entry)
    return {
      fileId: text(file.fileId, 100),
      fileName: text(file.fileName, 1000),
      ...(file.originalPath === undefined ? {} : { originalPath: text(file.originalPath, 4096) }),
      ...(file.metadata === undefined ? {} : { metadata: metadata(file.metadata) }),
      existingTags: tags(file.existingTags ?? [], 100)
    }
  })
  const ids = new Set(files.map((file) => file.fileId))
  if (!files.length || ids.size !== files.length) {
    throw new Error('每次标签推荐须包含 1–10 个文件，fileId 不可重复。')
  }
  const vocabulary = [
    ...new Set([
      ...presetTags,
      ...tags(source.availableTags ?? [], 1000),
      ...files.flatMap((file) => file.existingTags)
    ])
  ]
  const corrections = array(source.corrections ?? [], 100).map((entry) => {
    const correction = object(entry)
    const fileIds = array(correction.fileIds, files.length).map((id) => text(id, 100))
    if (
      !fileIds.length ||
      new Set(fileIds).size !== fileIds.length ||
      fileIds.some((id) => !ids.has(id))
    ) {
      throw new Error('用户纠正须明确对应本批次内不重复的 fileId。')
    }
    return { fileIds, instruction: text(correction.instruction, 4000) }
  })
  const payload = {
    vocabulary,
    files,
    ...(source.userContext === undefined ? {} : { userContext: text(source.userContext, 8000) }),
    corrections
  }
  const json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') > 24_000) {
    throw new Error('标签推荐资料超过 24 KB，请精简元数据、相关上下文或词库后重试。')
  }
  return { payload, json }
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('标签推荐回复包含约定以外的字段。')
  }
}

function parseReply(
  reply: string,
  input: ReturnType<typeof prepareInput>
): TagRecommendationItem[] {
  const result = object(JSON.parse(reply) as unknown)
  onlyKeys(result, ['items'])
  const items = array(result.items, input.payload.files.length)
  const byId = new Map<string, TagRecommendationItem>()
  const vocabulary = new Set(input.payload.vocabulary)
  for (const entry of items) {
    const item = object(entry)
    onlyKeys(item, ['fileId', 'tags'])
    const fileId = text(item.fileId, 100)
    const file = input.payload.files.find((candidate) => candidate.fileId === fileId)
    if (!file || byId.has(fileId)) throw new Error('标签推荐回复包含未知或重复的 fileId。')
    const names = new Set<string>()
    const recommended = array(item.tags, 8).map((entry) => {
      const tag = object(entry)
      onlyKeys(tag, ['name', 'reason'])
      const name = tagName(tag.name)
      if (names.has(name) || file.existingTags.includes(name)) {
        throw new Error('标签推荐回复重复推荐同名或文件已有的标签。')
      }
      names.add(name)
      return { name, reason: text(tag.reason, 200), isNew: !vocabulary.has(name) }
    })
    byId.set(fileId, { fileId, tags: recommended })
  }
  return input.payload.files.map((file) => {
    const item = byId.get(file.fileId)
    if (!item) throw new Error('标签推荐回复遗漏了输入文件。')
    return item
  })
}

/** One isolated model request. No file reads, tool loop, tag writes or chat history. */
export async function recommendTags(
  input: TagRecommendationInput,
  signal?: AbortSignal
): Promise<TagRecommendationResult> {
  let requestSignal: AbortSignal | undefined
  try {
    signal?.throwIfAborted()
    const prepared = prepareInput(input)
    requestSignal = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])])
    const { modelRuntime, model } = await createConfiguredModel(requestSignal)
    const response = await modelRuntime.completeSimple(
      model,
      {
        systemPrompt: tagRecommendationPrompt,
        messages: [{ role: 'user', content: prepared.json, timestamp: Date.now() }]
      },
      { signal: requestSignal, timeoutMs: 60_000, maxRetries: 0, maxTokens: 4096 }
    )
    signal?.throwIfAborted()
    if (requestSignal.aborted) throw new Error('标签推荐超时，请重试。')
    if (response.stopReason === 'error')
      throw new Error(response.errorMessage || '标签推荐模型请求失败。')
    if (
      response.stopReason !== 'stop' ||
      response.content.some((part) => part.type === 'toolCall')
    ) {
      throw new Error('标签推荐模型未返回完整的纯文本结果。')
    }
    const reply = response.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
    return { status: 'completed', items: parseReply(reply, prepared) }
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled' }
    if (requestSignal?.aborted) return { status: 'error', error: '标签推荐超时，请重试。' }
    return { status: 'error', error: await agentErrorMessage(error) }
  }
}
