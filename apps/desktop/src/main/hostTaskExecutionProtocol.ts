import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { AgentTurnStep } from '@remember/shared'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, validateHostTaskEnvelope } from './hostTaskProtocol'

export type HostTaskRouterInput = Omit<HostTaskEnvelopeV1['preparedInput'], 'workspace'> & { reviewTtlMs: number }
export interface HostTaskRouterDescriptor {
  version: 2
  targetId: string
  targetEpoch: string
  root: string
  assignment: { jobId: string; messageId: string; workItemId: string; sessionId: string }
  directory: string
  workspace: string
  inputHash: string
}
export interface HostTaskPrepared {
  version: 1
  descriptor: HostTaskRouterDescriptor
  input: HostTaskRouterInput
}
export type HostTaskPhase =
  | 'thread-start-intent'
  | 'thread-bound'
  | 'turn-start-intent'
  | 'running'
  | 'waiting'
  | 'recovery-required'
  | 'completed'
  | 'stopped'
export interface HostTaskHostObservation {
  version: 1
  kind: 'host'
  preparedHash: string
  coordinatorSessionId: string
  cursor: number
  job: {
    jobId: string
    inputHash: string
    phase: HostTaskPhase
    threadId: string | null
    turnId: string | null
    createdAt: number
    updatedAt: number
    stopReason: null | 'request-expired'
  }
  terminalResultHash: string | null
  delivery:
    | { kind: 'content'; response: string; steps: AgentTurnStep[] }
    | { kind: 'withheld'; reason: 'context-unavailable' | 'context-invalidated' }
}
export type HostTaskObservation =
  | { version: 1; kind: 'admission'; preparedHash: string; state: 'registered' | 'dispatch-intent' }
  | {
      version: 1
      kind: 'cancelled-unsubmitted'
      preparedHash: string
      cancellation: { kind: 'unsubmitted'; at: number }
    }
  | HostTaskHostObservation
export interface HostTaskTerminalReceipt {
  version: 1
  preparedHash: string
  jobId: string
  inputHash: string
  phase: 'completed' | 'stopped'
  threadId: string | null
  turnId: string | null
  hostCreatedAt: number
  hostTerminalAt: number
  durationMs: number
  stopReason: null | 'request-expired'
  terminalResultHash: string | null
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const failPrepared = (): never => {
  throw new Error('host-task-prepared-invalid')
}
const failObservation = (): never => {
  throw new Error('host-task-observation-invalid')
}
type Fail = () => never

function object(value: unknown, keys: readonly string[], fail: Fail): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail()
  return value as Record<string, unknown>
}
function string(value: unknown, max: number, fail: Fail): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail()
}
function identifier(value: unknown, fail: Fail): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) fail()
}
function opaqueId(value: unknown, fail: Fail): asserts value is string {
  string(value, 200, fail)
  if (!value.trim() || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
    fail()
}
function digest(value: unknown, fail: Fail): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail()
}
function time(value: unknown, fail: Fail): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
}
function path(value: unknown): asserts value is string {
  string(value, 2000, failPrepared)
  if (
    !value.startsWith('/') ||
    value.length < 2 ||
    posix.normalize(value) !== value ||
    value.endsWith('/') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    failPrepared()
}
function routerBounds(value: unknown, maxBytes: number) {
  let nodes = 0
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 10000 || depth > 20) failPrepared()
    if (Array.isArray(item)) for (const entry of item) visit(entry, depth + 1)
    else if (item && typeof item === 'object') for (const entry of Object.values(item)) visit(entry, depth + 1)
  }
  visit(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) failPrepared()
}

export function validateHostTaskPrepared(
  inputEnvelope: unknown,
  value: unknown
): { prepared: HostTaskPrepared; serialized: string; preparedHash: string } {
  const { envelope } = validateHostTaskEnvelope(inputEnvelope)
  const serialized = canonicalHostTaskJson(value)
  const prepared = object(JSON.parse(serialized), ['version', 'descriptor', 'input'], failPrepared)
  if (prepared.version !== 1) failPrepared()
  const d = object(
    prepared.descriptor,
    ['version', 'targetId', 'targetEpoch', 'root', 'assignment', 'directory', 'workspace', 'inputHash'],
    failPrepared
  )
  if (d.version !== 2) failPrepared()
  identifier(d.targetId, failPrepared)
  identifier(d.targetEpoch, failPrepared)
  path(d.root)
  path(d.directory)
  path(d.workspace)
  digest(d.inputHash, failPrepared)
  const assignment = object(d.assignment, ['jobId', 'messageId', 'workItemId', 'sessionId'], failPrepared)
  for (const field of Object.values(assignment)) identifier(field, failPrepared)
  const expectedAssignment = {
    jobId: envelope.jobId,
    messageId: envelope.assistantMessageId,
    workItemId: envelope.workItemId,
    sessionId: envelope.sessionId,
  }
  if (
    canonicalHostTaskJson(assignment) !== canonicalHostTaskJson(expectedAssignment) ||
    d.targetId !== envelope.targetId
  )
    failPrepared()
  const directory = posix.join(d.root, 'jobs', hash(envelope.jobId).slice(0, 24))
  const workspace = posix.join(directory, 'workspace')
  if (
    d.directory !== directory ||
    d.workspace !== workspace ||
    Buffer.byteLength(posix.join(directory, 'client.sock')) > 100
  )
    failPrepared()
  const input = object(
    prepared.input,
    ['prompt', 'model', 'systemPrompt', 'effort', 'threadId', 'reviewTtlMs', 'tools'],
    failPrepared
  )
  time(input.reviewTtlMs, failPrepared)
  if (input.reviewTtlMs < 5000 || input.reviewTtlMs > 300000) failPrepared()
  const { reviewTtlMs: _reviewTtlMs, ...mappedInput } = input
  if (canonicalHostTaskJson({ ...mappedInput, workspace }) !== canonicalHostTaskJson(envelope.preparedInput))
    failPrepared()
  const spec = { ...input, workspace }
  const specText = canonicalHostTaskJson(spec)
  if (hash(specText) !== d.inputHash) failPrepared()
  routerBounds(spec, 65536)
  routerBounds({ op: 'prepare', assignment, input }, 70000)
  routerBounds({ op: 'register', assignment, input, prepared: d }, 70000)
  const submit = { op: 'submit', id: Number.MAX_SAFE_INTEGER, jobId: envelope.jobId, spec }
  routerBounds(submit, 69999)
  return { prepared: prepared as unknown as HostTaskPrepared, serialized, preparedHash: hash(serialized) }
}

function validateJob(value: unknown, prepared: HostTaskPrepared) {
  const job = object(
    value,
    ['jobId', 'inputHash', 'phase', 'threadId', 'turnId', 'createdAt', 'updatedAt', 'stopReason'],
    failObservation
  )
  if (job.jobId !== prepared.descriptor.assignment.jobId || job.inputHash !== prepared.descriptor.inputHash)
    failObservation()
  const phases: readonly unknown[] = [
    'thread-start-intent',
    'thread-bound',
    'turn-start-intent',
    'running',
    'waiting',
    'recovery-required',
    'completed',
    'stopped',
  ]
  if (!phases.includes(job.phase)) failObservation()
  if (job.threadId !== null) opaqueId(job.threadId, failObservation)
  if (job.turnId !== null) opaqueId(job.turnId, failObservation)
  if (job.turnId !== null && job.threadId === null) failObservation()
  if (job.phase === 'thread-start-intent' && (job.threadId !== null || job.turnId !== null)) failObservation()
  if (
    ['thread-bound', 'turn-start-intent'].includes(String(job.phase)) &&
    (job.threadId === null || job.turnId !== null)
  )
    failObservation()
  if (['running', 'waiting', 'completed'].includes(String(job.phase)) && (job.threadId === null || job.turnId === null))
    failObservation()
  time(job.createdAt, failObservation)
  time(job.updatedAt, failObservation)
  if (job.updatedAt < job.createdAt) failObservation()
  if (job.stopReason !== null && job.stopReason !== 'request-expired') failObservation()
  return job as unknown as HostTaskHostObservation['job']
}
function validateDelivery(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failObservation()
  const kind = (value as Record<string, unknown>).kind
  if (kind === 'withheld') {
    const delivery = object(value, ['kind', 'reason'], failObservation)
    if (delivery.reason !== 'context-unavailable' && delivery.reason !== 'context-invalidated') failObservation()
  } else if (kind === 'content') {
    const delivery = object(value, ['kind', 'response', 'steps'], failObservation)
    string(delivery.response, 100000, failObservation)
    if (!Array.isArray(delivery.steps) || delivery.steps.length > 500) failObservation()
    const ids = new Set<string>()
    for (const entry of delivery.steps as unknown[]) {
      const step = object(entry, ['id', 'kind', 'text', 'at'], failObservation)
      opaqueId(step.id, failObservation)
      if (ids.has(step.id)) failObservation()
      ids.add(step.id)
      if (step.kind !== 'status' && step.kind !== 'reasoning') failObservation()
      string(step.text, 20000, failObservation)
      time(step.at, failObservation)
    }
  } else failObservation()
  return value as HostTaskHostObservation['delivery']
}

export function validateHostTaskObservation(
  envelope: unknown,
  inputPrepared: unknown,
  value: unknown
): {
  observation: HostTaskObservation
  serialized: string
  observationHash: string
  terminal: HostTaskTerminalReceipt | null
} {
  const { prepared, preparedHash } = validateHostTaskPrepared(envelope, inputPrepared)
  const serialized = canonicalHostTaskJson(value)
  const parsed: unknown = JSON.parse(serialized)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) failObservation()
  const kind = (parsed as Record<string, unknown>).kind
  const keys =
    kind === 'admission'
      ? ['version', 'kind', 'preparedHash', 'state']
      : kind === 'cancelled-unsubmitted'
        ? ['version', 'kind', 'preparedHash', 'cancellation']
        : kind === 'host'
          ? [
              'version',
              'kind',
              'preparedHash',
              'coordinatorSessionId',
              'cursor',
              'job',
              'terminalResultHash',
              'delivery',
            ]
          : failObservation()
  const observation = object(parsed, keys, failObservation)
  if (observation.version !== 1 || observation.preparedHash !== preparedHash) failObservation()
  let terminal: HostTaskTerminalReceipt | null = null
  if (kind === 'admission') {
    if (observation.state !== 'registered' && observation.state !== 'dispatch-intent') failObservation()
  } else if (kind === 'cancelled-unsubmitted') {
    const cancellation = object(observation.cancellation, ['kind', 'at'], failObservation)
    if (cancellation.kind !== 'unsubmitted') failObservation()
    time(cancellation.at, failObservation)
  } else {
    opaqueId(observation.coordinatorSessionId, failObservation)
    time(observation.cursor, failObservation)
    if (observation.cursor > 10000) failObservation()
    const job = validateJob(observation.job, prepared)
    const delivery = validateDelivery(observation.delivery)
    if (job.phase === 'completed') {
      digest(observation.terminalResultHash, failObservation)
      if (
        delivery.kind === 'content' &&
        observation.terminalResultHash !==
          hash(canonicalHostTaskJson({ response: delivery.response, threadId: job.threadId }))
      )
        failObservation()
    } else if (observation.terminalResultHash !== null) failObservation()
    if (job.phase === 'completed' || job.phase === 'stopped') {
      terminal = {
        version: 1,
        preparedHash,
        jobId: job.jobId,
        inputHash: job.inputHash,
        phase: job.phase,
        threadId: job.threadId,
        turnId: job.turnId,
        hostCreatedAt: job.createdAt,
        hostTerminalAt: job.updatedAt,
        durationMs: job.updatedAt - job.createdAt,
        stopReason: job.stopReason,
        terminalResultHash: observation.terminalResultHash as string | null,
      }
    }
  }
  return {
    observation: observation as unknown as HostTaskObservation,
    serialized,
    observationHash: hash(serialized),
    terminal,
  }
}

export function validateHostTaskReceivedAt(inputEnvelope: unknown, value: unknown): number {
  const { envelope } = validateHostTaskEnvelope(inputEnvelope)
  if (!Number.isSafeInteger(value) || (value as number) < envelope.startedAt || (value as number) < 0)
    throw new Error('host-task-received-at-invalid')
  return value as number
}
