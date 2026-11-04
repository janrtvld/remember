import { createHash } from 'node:crypto'
import type { AgentTurnStep, WorkItem, WorkItemSource } from '@remember/shared'

export type HostTaskDefinitionV1 = Pick<
  WorkItem,
  'id' | 'title' | 'description' | 'prompt' | 'context' | 'returnPoint' | 'lifecycle' | 'status' | 'priority' | 'dueAt'
> & {
  version: 1
  aiSuggestion: string | null
  sources: (WorkItemSource & { conversationReference: string | null; conversationActionId: string | null })[]
}

export interface HostTaskEnvelopeV1 {
  version: 1
  actionId: string
  workItemId: string
  sessionId: string
  jobId: string
  userMessageId: string
  assistantMessageId: string
  provider: 'codex'
  instruction: string
  targetId: string
  taskDefinition: HostTaskDefinitionV1
  policyFingerprint: string
  sources: { spaceId: string; slug: string; revision: string; explicit: boolean }[]
  startedAt: number
  preparedInput: {
    prompt: string
    systemPrompt: string
    model: string
    effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
    threadId: null
    tools: { name: 'remember_memory'; description: string; inputSchema: Record<string, unknown> }[]
    workspace: string
  }
}

export interface HostTaskSessionReceipt {
  version: 1
  actionId: string
  envelopeHash: string
  workItemId: string
  sessionId: string
  jobId: string
  userMessageId: string
  assistantMessageId: string
}

export interface HostTaskOutcome {
  version: 1
  status: 'completed' | 'stopped'
  response: string
  steps: AgentTurnStep[]
  completedAt: number
  durationMs: number
}

export interface HostTaskOutcomeReceipt extends HostTaskSessionReceipt {
  outcomeHash: string
  projection: 'applied' | 'orphaned'
}

const MAX_BYTES = 131072
const fail = (): never => {
  throw new Error('host-task-invalid-data')
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function canonicalHostTaskJson(value: unknown): string {
  let count = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > 12000 || depth > 24) fail()
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (!item || typeof item !== 'object') return fail()
    if (Object.getOwnPropertySymbols(item).length) fail()
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.keys(descriptors).length !== item.length + 1) fail()
      return Array.from({ length: item.length }, (_, index) => {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable || !('value' in descriptor)) fail()
        return visit(descriptor.value, depth + 1)
      })
    }
    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail()
    return Object.fromEntries(
      Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key]
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail()
          return [key, visit(descriptor.value, depth + 1)]
        })
    )
  }
  const serialized = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(serialized) > MAX_BYTES) fail()
  return serialized
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
function string(value: unknown, max = 20000, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || value.includes('\0')) fail()
}
function id(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)) fail()
}
function time(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
}
function member(value: unknown, allowed: readonly unknown[]) {
  if (!allowed.includes(value)) fail()
}
function definition(value: unknown): asserts value is HostTaskDefinitionV1 {
  const d = object(value, [
    'version',
    'id',
    'title',
    'description',
    'prompt',
    'aiSuggestion',
    'context',
    'returnPoint',
    'lifecycle',
    'status',
    'priority',
    'dueAt',
    'sources',
  ])
  if (d.version !== 1) fail()
  id(d.id)
  for (const key of ['title', 'description', 'prompt', 'context']) string(d[key])
  if (d.aiSuggestion !== null) string(d.aiSuggestion)
  const point = object(d.returnPoint, ['lastMove', 'unresolved', 'nextMove'])
  for (const key of Object.keys(point)) string(point[key])
  member(d.lifecycle, ['open', 'completed', 'abandoned', 'superseded'])
  member(d.status, ['todo', 'in_progress'])
  member(d.priority, ['none', 'low', 'medium', 'high', 'urgent'])
  if (d.dueAt !== null) time(d.dueAt)
  if (!Array.isArray(d.sources) || d.sources.length > 100) fail()
  let previous = ''
  for (const entry of d.sources as unknown[]) {
    const s = object(entry, [
      'id',
      'kind',
      'label',
      'detail',
      'workdayId',
      'conversationReference',
      'conversationActionId',
      'conversationStartTime',
      'observedAt',
      'confidence',
    ])
    string(s.id, 1000, true)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: opaque source IDs must reject ASCII controls.
    if (/[\u0000-\u001f\u007f]/.test(s.id as string)) fail()
    if ((s.id as string) <= previous) fail()
    previous = s.id as string
    member(s.kind, ['manual', 'meeting', 'observed', 'legacy'])
    string(s.label)
    string(s.detail)
    for (const key of ['workdayId', 'conversationReference', 'conversationActionId', 'conversationStartTime'])
      if (s[key] !== null) string(s[key], 1000, true)
    time(s.observedAt)
    if (s.confidence !== null && (typeof s.confidence !== 'number' || s.confidence < 0 || s.confidence > 1)) fail()
  }
}

export function hostTaskDefinition(item: WorkItem): HostTaskDefinitionV1 {
  const value: HostTaskDefinitionV1 = {
    version: 1,
    id: item.id,
    title: item.title,
    description: item.description,
    prompt: item.prompt,
    aiSuggestion: item.aiSuggestion ?? null,
    context: item.context,
    returnPoint: { ...item.returnPoint },
    lifecycle: item.lifecycle,
    status: item.status,
    priority: item.priority,
    dueAt: item.dueAt,
    sources: item.sources
      .map((source) => ({
        id: source.id,
        kind: source.kind,
        label: source.label,
        detail: source.detail,
        workdayId: source.workdayId,
        conversationReference: source.conversationReference ?? null,
        conversationActionId: source.conversationActionId ?? null,
        conversationStartTime: source.conversationStartTime,
        observedAt: source.observedAt,
        confidence: source.confidence,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
  const copy: unknown = JSON.parse(canonicalHostTaskJson(value))
  definition(copy)
  return copy
}

export function hostTaskDefinitionHash(value: HostTaskDefinitionV1): string {
  const serialized = canonicalHostTaskJson(value)
  definition(JSON.parse(serialized))
  return hash(serialized)
}

export function validateHostTaskEnvelope(value: unknown): {
  envelope: HostTaskEnvelopeV1
  serialized: string
  envelopeHash: string
} {
  const serialized = canonicalHostTaskJson(value)
  const e = object(JSON.parse(serialized), [
    'version',
    'actionId',
    'workItemId',
    'sessionId',
    'jobId',
    'userMessageId',
    'assistantMessageId',
    'provider',
    'instruction',
    'targetId',
    'taskDefinition',
    'policyFingerprint',
    'sources',
    'startedAt',
    'preparedInput',
  ])
  if (e.version !== 1 || e.provider !== 'codex') fail()
  for (const key of ['actionId', 'workItemId', 'sessionId', 'jobId', 'userMessageId', 'assistantMessageId', 'targetId'])
    id(e[key])
  if (e.userMessageId === e.assistantMessageId) fail()
  string(e.instruction, 30000, true)
  string(e.policyFingerprint, 1000, true)
  time(e.startedAt)
  definition(e.taskDefinition)
  if (e.taskDefinition.id !== e.workItemId) fail()
  const input = object(e.preparedInput, ['prompt', 'systemPrompt', 'model', 'effort', 'threadId', 'tools', 'workspace'])
  string(input.prompt, 30000, true)
  string(input.systemPrompt)
  string(input.workspace, 2000, true)
  if (
    input.threadId !== null ||
    !(input.workspace as string).startsWith('/') ||
    (input.workspace as string).split('/').includes('..')
  )
    fail()
  if (typeof input.model !== 'string' || !/^[a-z0-9.-]{1,80}$/.test(input.model)) fail()
  member(input.effort, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  if (!Array.isArray(input.tools) || input.tools.length > 1) fail()
  for (const tool of input.tools as unknown[]) {
    const t = object(tool, ['name', 'description', 'inputSchema'])
    if (
      t.name !== 'remember_memory' ||
      !t.inputSchema ||
      typeof t.inputSchema !== 'object' ||
      Array.isArray(t.inputSchema)
    )
      fail()
    string(t.description, 4000)
  }
  if (!Array.isArray(e.sources) || e.sources.length > 100) fail()
  const sourceIds = new Set<string>()
  for (const entry of e.sources as unknown[]) {
    const s = object(entry, ['spaceId', 'slug', 'revision', 'explicit'])
    for (const key of ['spaceId', 'slug', 'revision']) string(s[key], 1000, true)
    if (typeof s.explicit !== 'boolean') fail()
    const key = JSON.stringify([s.spaceId, s.slug])
    if (sourceIds.has(key)) fail()
    sourceIds.add(key)
  }
  return { envelope: e as unknown as HostTaskEnvelopeV1, serialized, envelopeHash: hash(serialized) }
}

export function hostTaskSessionReceipt(value: HostTaskEnvelopeV1): HostTaskSessionReceipt {
  const { envelope: e, envelopeHash } = validateHostTaskEnvelope(value)
  return {
    version: 1,
    actionId: e.actionId,
    envelopeHash,
    workItemId: e.workItemId,
    sessionId: e.sessionId,
    jobId: e.jobId,
    userMessageId: e.userMessageId,
    assistantMessageId: e.assistantMessageId,
  }
}

export function validateHostTaskOutcome(value: unknown): {
  outcome: HostTaskOutcome
  serialized: string
  outcomeHash: string
} {
  const serialized = canonicalHostTaskJson(value)
  const o = object(JSON.parse(serialized), ['version', 'status', 'response', 'steps', 'completedAt', 'durationMs'])
  if (o.version !== 1) fail()
  member(o.status, ['completed', 'stopped'])
  string(o.response, 100000)
  time(o.completedAt)
  time(o.durationMs)
  if (!Array.isArray(o.steps) || o.steps.length > 500) fail()
  const ids = new Set<string>()
  for (const entry of o.steps as unknown[]) {
    const s = object(entry, ['id', 'kind', 'text', 'at'])
    string(s.id, 200, true)
    member(s.kind, ['status', 'reasoning'])
    string(s.text, 20000)
    time(s.at)
    if (ids.has(s.id as string)) fail()
    ids.add(s.id as string)
  }
  return { outcome: o as unknown as HostTaskOutcome, serialized, outcomeHash: hash(serialized) }
}
