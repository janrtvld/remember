import { createAgentError } from './agentErrors'

type ClaudeFailure = {
  code: string
  detail: string
}

type ClaudeResponse = { status: 'success'; value: unknown } | { status: 'failure'; failure: ClaudeFailure }

const MAX_NORMALIZATION_DEPTH = 4
const MAX_NESTED_JSON_BYTES = 256 * 1024

const CLAUDE_PAYLOAD_KEYS = new Set([
  'parametername',
  'output',
  'response',
  'json',
  'data',
  'result',
  'structuredoutput',
])

const RESPONSE_SHAPE_KEYS = new Set([
  'type',
  'subtype',
  'is_error',
  'result',
  'structured_output',
  'message',
  'content',
  'text',
  'summary',
  'outcomes',
  'openTasks',
  'projectAttention',
  'conversations',
  'knowledgeSuggestions',
  'timeline',
  'range',
  'facts',
  'activities',
  'audioConversations',
  'decisions',
  'actionPoints',
  'openLoops',
])

export function parseJsonResponse(output: string) {
  const trimmed = output.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1]
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  const candidates = [
    trimmed,
    fenced,
    objectStart >= 0 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Continue through the supported plain, fenced, and CLI-prefixed forms.
    }
  }
  throw createAgentError(
    'agent-invalid-response',
    `Response was not valid JSON (length=${trimmed.length}, fencedJson=${fenced ? 'yes' : 'no'}, objectCandidate=${objectStart >= 0 && objectEnd > objectStart ? 'yes' : 'no'}).`
  )
}

export function parseClaudeResponse(output: string) {
  const response = decodeClaudeResponse(output)
  if (response.status === 'failure') {
    throw createAgentError(response.failure.code, response.failure.detail)
  }
  return response.value
}

export function claudeResponseFailure(output: string) {
  try {
    const response = decodeClaudeResponse(output)
    return response.status === 'failure' ? response.failure : null
  } catch {
    return null
  }
}

export function responseShape(value: unknown) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(length=${value.length})`
  if (typeof value !== 'object') return typeof value
  const keys = Object.keys(value)
  const recognizedKeys = keys.filter((key) => RESPONSE_SHAPE_KEYS.has(key))
  return `object(keys=${keys.length}, recognized=${recognizedKeys.length ? recognizedKeys.join(',') : 'none'}, other=${keys.length - recognizedKeys.length})`
}

export function normalizeResponseValue(value: unknown, depth = 0): unknown {
  if (typeof value !== 'string' || depth >= MAX_NORMALIZATION_DEPTH) return value
  const nestedJson = parseNestedJson(value)
  if (nestedJson !== value) return normalizeResponseValue(nestedJson, depth + 1)
  return parseClaudeParameters(value, depth + 1) ?? value
}

function decodeClaudeResponse(output: string): ClaudeResponse {
  const envelope = extractClaudeEnvelope(parseJsonResponse(output))
  if (!isRecord(envelope)) {
    throw createAgentError(
      'agent-invalid-response',
      `Claude CLI envelope was ${responseShape(envelope)}; expected object.`
    )
  }

  if (envelope.is_error === true) {
    return { status: 'failure', failure: classifyClaudeFailure(envelope.subtype, envelope.result) }
  }

  if (envelope.structured_output != null) {
    return decodeClaudePayload(envelope.structured_output)
  }
  if (envelope.result != null) {
    return decodeClaudePayload(envelope.result)
  }
  return decodeClaudePayload(envelope)
}

function decodeClaudePayload(value: unknown): ClaudeResponse {
  const payload = unwrapClaudePayload(value)
  if (isRecord(payload) && payload.is_error === true) {
    return { status: 'failure', failure: classifyClaudeFailure(payload.subtype, payload.result) }
  }
  return { status: 'success', value: payload }
}

function extractClaudeEnvelope(value: unknown) {
  if (!Array.isArray(value)) return value

  // Claude normally emits one JSON result object. Some gateways preserve its
  // lifecycle stream and serialize all events as an array instead.
  return (
    value.findLast((event) => isRecord(event) && event.type === 'result') ??
    value.findLast(
      (event) => isRecord(event) && ('result' in event || 'structured_output' in event || 'is_error' in event)
    ) ??
    value
  )
}

function classifyClaudeFailure(subtype: unknown, result: unknown): ClaudeFailure {
  const detail = typeof result === 'string' ? result : ''
  if (/authenticate|oauth session expired/i.test(detail)) return { code: 'claude-auth-required', detail }
  if (isStructuredOutputFailure(subtype, detail)) {
    return { code: 'claude-structured-output-failed', detail }
  }
  return { code: 'claude-failed', detail }
}

function isStructuredOutputFailure(subtype: unknown, detail: string) {
  return (
    subtype === 'error_max_structured_output_retries' ||
    /output does not match required schema|structured.?output.*(?:schema|retr(?:y|ies))|error_max_structured_output_retries/i.test(
      detail
    )
  )
}

function unwrapClaudePayload(value: unknown, depth = 0): unknown {
  const normalized = normalizeResponseValue(value, depth)
  if (depth >= MAX_NORMALIZATION_DEPTH) return normalized
  if (!isRecord(normalized)) return normalized

  const entries = Object.entries(normalized)
  if (entries.length === 1) {
    const [key, nested] = entries[0]
    return CLAUDE_PAYLOAD_KEYS.has(normalizeKey(key)) ? unwrapClaudePayload(nested, depth + 1) : normalized
  }

  const structuredOutput = entries.find(([key]) => normalizeKey(key) === 'structuredoutput')
  if (!structuredOutput) return normalized
  const structuredPayload = normalizeResponseValue(structuredOutput[1], depth + 1)
  if (!isRecord(structuredPayload)) return normalized
  return unwrapClaudePayload(
    {
      ...Object.fromEntries(entries.filter(([key]) => normalizeKey(key) !== 'structuredoutput')),
      ...structuredPayload,
    },
    depth + 1
  )
}

function parseNestedJson(value: string): unknown {
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed) > MAX_NESTED_JSON_BYTES) return value
  const looksLikeJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('```') && trimmed.endsWith('```'))
  if (!looksLikeJson) return value

  try {
    return parseJsonResponse(trimmed)
  } catch {
    return value
  }
}

function parseClaudeParameters(value: string, depth: number) {
  const parameters = Array.from(
    value.matchAll(/<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi),
    (match) => [match[1], normalizeResponseValue(match[2]?.trim() ?? '', depth)] as const
  )
  return parameters.length ? Object.fromEntries(parameters) : null
}

function normalizeKey(key: string) {
  return key.replaceAll(/[^a-z]/gi, '').toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
