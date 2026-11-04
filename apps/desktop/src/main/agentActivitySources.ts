import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentProvider } from '@remember/shared'
import { originalRememberUserRequest } from './agentTurnEnvelope'

export type AgentActivitySource = {
  path: string
  provider: AgentProvider
  modifiedAt: number
  size?: number
  identity?: string
}
export type AgentActivityCursor = {
  path: string
  provider: AgentProvider
  identity: string
  offset: number
  generation: number
  prefix: string
  sessionId: string
  projectPath: string | null
  turnId: string | null
  modifiedAt?: number
  readThrough?: number
  generatedUserMessages?: boolean
}
export type AgentActivityMessage = {
  provider: AgentProvider
  sessionId: string
  projectPath: string | null
  role: 'user' | 'assistant'
  text: string
  observedAt: number
  providerEventId: string | null
  turnId: string | null
  representation: string
  sourcePath: string
  sourceOffset: number
}
export type AgentActivityRead = {
  cursor: AgentActivityCursor
  messages: AgentActivityMessage[]
  malformedRecords: number
  unsupportedRecords: number
  excludedRecords: number
  hasMore: boolean
}

const READ_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 32 * 1024 * 1024

export async function discoverAgentActivitySources(
  homeDirectory: string,
  options: { codexDirectory?: string; claudeDirectory?: string; after?: number } = {}
) {
  const codexDirectory = options.codexDirectory ?? path.join(homeDirectory, '.codex')
  const claudeDirectory = options.claudeDirectory ?? path.join(homeDirectory, '.claude')
  const roots = [
    { provider: 'codex' as const, directory: path.join(codexDirectory, 'sessions') },
    { provider: 'codex' as const, directory: path.join(codexDirectory, 'archived_sessions') },
    { provider: 'claude' as const, directory: path.join(claudeDirectory, 'projects') },
  ]
  const sources = await Promise.all(
    roots.map(async ({ provider, directory }) => {
      const files = await filesBelow(directory)
      return Promise.all(
        files
          .filter((file) => file.endsWith('.jsonl'))
          .map(async (file): Promise<AgentActivitySource | null> => {
            try {
              const metadata = await stat(file)
              if (metadata.mtimeMs < (options.after ?? 0)) return null
              return {
                path: file,
                provider,
                modifiedAt: metadata.mtimeMs,
                size: metadata.size,
                identity: `${metadata.dev}:${metadata.ino}`,
              }
            } catch {
              return null
            }
          })
      )
    })
  )
  return sources.flat().filter((source): source is AgentActivitySource => source !== null)
}

export async function readAgentActivitySource(
  source: AgentActivitySource,
  previous: AgentActivityCursor | null,
  options: { excludedDirectories?: string[]; maxBytes?: number } = {}
): Promise<AgentActivityRead> {
  const file = await open(source.path, 'r')
  try {
    const metadata = await file.stat()
    const identity = `${metadata.dev}:${metadata.ino}`
    const prefixBuffer = Buffer.alloc(Math.min(256, metadata.size))
    await file.read(prefixBuffer, 0, prefixBuffer.length, 0)
    // Only compare bytes that existed at the preceding checkpoint; appending to a short file is not rotation.
    const previousPrefixBytes = previous?.prefix ? Buffer.from(previous.prefix, 'base64') : null
    const prefixMatches =
      !previousPrefixBytes || prefixBuffer.subarray(0, previousPrefixBytes.length).equals(previousPrefixBytes)
    const rotated = !previous || previous.identity !== identity || metadata.size < previous.offset || !prefixMatches
    const cursor: AgentActivityCursor = rotated
      ? {
          path: source.path,
          provider: source.provider,
          identity,
          offset: 0,
          generation: (previous?.generation ?? -1) + 1,
          prefix: prefixBuffer.toString('base64'),
          sessionId: path.basename(source.path, '.jsonl').replace(/^rollout-.*?(?=[0-9a-f]{8}-[0-9a-f-]{27}$)/i, ''),
          projectPath: null,
          turnId: null,
        }
      : { ...previous, prefix: prefixBuffer.toString('base64') }
    let buffer = Buffer.alloc(0)
    let readPosition = cursor.offset
    const targetBytes = options.maxBytes ?? READ_BYTES
    // A single large record may exceed the normal batch budget, but is never truncated or acknowledged.
    while (readPosition < metadata.size) {
      const chunk = Buffer.alloc(Math.min(READ_BYTES, metadata.size - readPosition))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, readPosition)
      if (!bytesRead) break
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)])
      readPosition += bytesRead
      if (buffer.lastIndexOf(10) >= 0 && buffer.length >= targetBytes) break
      if (buffer.length > MAX_RECORD_BYTES) throw new Error('agent-activity-record-too-large')
    }
    let boundary = buffer.lastIndexOf(10) + 1
    if (readPosition === metadata.size && boundary < buffer.length) {
      try {
        JSON.parse(buffer.subarray(boundary).toString('utf8'))
        boundary = buffer.length
      } catch {
        // The writer may still be appending the last record. Retry it from the same offset.
      }
    }
    const complete = buffer.subarray(0, boundary)
    const result: AgentActivityRead = {
      cursor,
      messages: [],
      malformedRecords: 0,
      unsupportedRecords: 0,
      excludedRecords: 0,
      hasMore: cursor.offset + boundary < metadata.size,
    }
    for (const { bytes, length } of splitLines(complete)) {
      const offset = cursor.offset
      cursor.offset += length
      if (!bytes.length) continue
      let record: unknown
      try {
        record = JSON.parse(bytes.toString('utf8'))
      } catch {
        result.malformedRecords += 1
        continue
      }
      if (!isRecord(record)) {
        result.unsupportedRecords += 1
        continue
      }
      const parsed = parseAgentActivityRecord(source.provider, record, cursor)
      if (parsed.unsupported) result.unsupportedRecords += 1
      if (parsed.excluded) result.excludedRecords += 1
      for (const message of parsed.messages) {
        if (isExcludedDirectory(cursor.projectPath, options.excludedDirectories ?? [])) {
          result.excludedRecords += 1
          continue
        }
        result.messages.push({
          ...message,
          provider: source.provider,
          sessionId: cursor.sessionId,
          projectPath: cursor.projectPath,
          turnId: message.turnId ?? cursor.turnId,
          sourcePath: source.path,
          sourceOffset: offset,
        })
      }
    }
    cursor.modifiedAt = metadata.mtimeMs
    cursor.readThrough = readPosition
    return result
  } finally {
    await file.close()
  }
}

export function activityContentHash(text: string) {
  return createHash('sha256').update(text.normalize('NFKC').replace(/\s+/g, ' ').trim()).digest('hex')
}

export function parseAgentActivityRecord(
  provider: AgentProvider,
  record: Record<string, unknown>,
  cursor: Pick<AgentActivityCursor, 'sessionId' | 'projectPath' | 'turnId' | 'generatedUserMessages'>
) {
  type ParsedMessage = Pick<
    AgentActivityMessage,
    'role' | 'text' | 'observedAt' | 'providerEventId' | 'turnId' | 'representation'
  >
  const messages: ParsedMessage[] = []
  let unsupported = false
  let excluded = false
  const add = (
    role: 'user' | 'assistant',
    value: unknown,
    representation: string,
    id: unknown = null,
    timestamp: unknown = record.timestamp
  ) => {
    const original = textFromContent(value)
    const text = cleanActivityText(role === 'user' ? originalRememberUserRequest(original) : original)
    if (!text) return
    if (role === 'user' && (cursor.generatedUserMessages || isRuntimeContext(text))) {
      excluded = true
      return
    }
    const observedAt =
      typeof timestamp === 'number' ? timestamp : typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
    if (!Number.isFinite(observedAt)) {
      unsupported = true
      return
    }
    messages.push({
      role,
      text,
      observedAt,
      providerEventId: typeof id === 'string' ? id : null,
      turnId: cursor.turnId,
      representation,
    })
  }
  if (provider === 'codex') {
    const payload = isRecord(record.payload) ? record.payload : null
    if (record.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string') cursor.sessionId = payload.id
      if (typeof payload.cwd === 'string') cursor.projectPath = payload.cwd
      cursor.generatedUserMessages =
        payload.source === 'subagent' ||
        (isRecord(payload.source) && ('subagent' in payload.source || 'Subagent' in payload.source))
    } else if (record.type === 'turn_context' && payload) {
      if (typeof payload.cwd === 'string') cursor.projectPath = payload.cwd
      if (typeof payload.turn_id === 'string') cursor.turnId = payload.turn_id
    } else if (record.type === 'response_item' && payload?.type === 'message') {
      if (payload.role === 'user' || payload.role === 'assistant') {
        if (payload.role === 'assistant' && payload.channel === 'analysis') excluded = true
        else add(payload.role, payload.content, 'response_item', payload.id)
      }
    } else if (record.type === 'event_msg' && payload) {
      if (payload.type === 'user_message') add('user', payload.message, 'user_message', payload.id)
      else if (payload.type === 'task_complete')
        add('assistant', payload.last_agent_message, 'task_complete', payload.id)
      else if (payload.type === 'agent_message') add('assistant', payload.message, 'agent_message', payload.id)
      else if (payload.type === 'task_started' && typeof payload.turn_id === 'string') cursor.turnId = payload.turn_id
      else if (payload.type === 'item_completed' && isRecord(payload.item)) {
        const item = payload.item
        if (item.type === 'UserMessage' || item.type === 'userMessage')
          add('user', item.content, 'item_completed', item.id)
        else if (item.type === 'AgentMessage' || item.type === 'agentMessage') {
          if (item.phase === 'analysis') excluded = true
          else add('assistant', item.text ?? item.content, 'item_completed', item.id)
        }
      }
    } else if (record.type === 'compacted') excluded = true
  } else {
    if (typeof record.sessionId === 'string') cursor.sessionId = record.sessionId
    if (typeof record.cwd === 'string') cursor.projectPath = record.cwd
    if (record.isSidechain === true || record.isCompactSummary === true || record.isMeta === true) excluded = true
    else if ((record.type === 'user' || record.type === 'assistant') && isRecord(record.message)) {
      const message = record.message
      if (record.type === 'user' && message.role === 'user') add('user', message.content, 'user', record.uuid)
      else if (record.type === 'assistant' && message.role === 'assistant')
        add('assistant', message.content, 'assistant', record.uuid ?? message.id)
      else unsupported = true
    }
  }
  return { messages, unsupported, excluded }
}

async function filesBelow(directory: string, depth = 8): Promise<string[]> {
  if (depth < 0) return []
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name)
        if (entry.isFile()) return [target]
        // Do not follow symlinks outside the permitted provider directories.
        return entry.isDirectory() ? filesBelow(target, depth - 1) : []
      })
    )
    return nested.flat()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
}

function splitLines(buffer: Buffer) {
  const lines: Array<{ bytes: Buffer; length: number }> = []
  let start = 0
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 10) continue
    lines.push({ bytes: buffer.subarray(start, index), length: index - start + 1 })
    start = index + 1
  }
  if (start < buffer.length) lines.push({ bytes: buffer.subarray(start), length: buffer.length - start })
  return lines
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      if (!isRecord(block)) return []
      return ['text', 'input_text', 'output_text'].includes(String(block.type).toLowerCase()) &&
        typeof block.text === 'string'
        ? [block.text]
        : []
    })
    .join('\n\n')
}

function cleanActivityText(text: string) {
  return text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g, '').trim()
}

function isRuntimeContext(text: string) {
  return /^(?:Remember context\. The JSON records below are retrieved knowledge|# AGENTS\.md instructions\b|<(?:environment_context|permissions\s+instructions|app-context|system[_-]reminder|turn_aborted|codex_internal_context|subagent_notification)\b)/i.test(
    text
  )
}

function isExcludedDirectory(directory: string | null, excluded: string[]) {
  if (!directory) return false
  return excluded.some((root) => {
    const relative = path.relative(root, directory)
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
