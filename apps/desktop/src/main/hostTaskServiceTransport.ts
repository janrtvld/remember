import { createHash } from 'node:crypto'
import type { AgentTurnStep } from '@remember/shared'
import type {
  HostTaskHostObservation,
  HostTaskPhase,
  HostTaskPrepared,
  HostTaskRouterDescriptor,
  HostTaskRouterInput,
} from './hostTaskExecutionProtocol'
import { canonicalHostTaskJson } from './hostTaskProtocol'

export type HostTaskGuard = () => Promise<() => void>
export type HostTaskAssignment = HostTaskRouterDescriptor['assignment']
export interface HostTaskRequest {
  id: string
  sessionId: string
  status: 'pending'
  method: 'client-tool' | 'provider-approval'
  payload: {
    expiresAt: number
    threadId?: string
    turnId?: string
    callId?: string
    tool?: string
    input?: unknown
    request?: unknown
  }
}
export interface HostTaskSnapshot {
  sessionId: string
  pid: number
  job: {
    id: string
    inputHash: string
    spec: HostTaskRouterInput & { workspace: string }
    phase: HostTaskPhase
    threadId: string | null
    turnId: string | null
    createdAt: number
    updatedAt: number
    stopReason?: 'request-expired'
  } | null
  events: { seq: number; type: string; payload: Record<string, unknown>; createdAt: number }[]
  requests: HostTaskRequest[]
  result: { response: string; threadId: string } | null
}
export interface HostTaskRouterResult {
  descriptor: HostTaskRouterDescriptor
  state: 'reserved' | 'recovery-required' | 'running' | 'waiting' | 'completed' | 'stopped' | 'cancelled-unsubmitted'
  snapshot: HostTaskSnapshot | null
  cancellation?: { kind: 'unsubmitted'; at: number }
}
export interface HostTaskProjection {
  observation: HostTaskHostObservation | null
  requests: HostTaskRequest[]
  cursor: number
  sessionChanged: boolean
  drained: boolean
}
export interface HostTaskRawTransport {
  request(
    text: string,
    binding?: { prepared: HostTaskPrepared; guard: HostTaskGuard; expectedReview?: HostTaskExpectedReview }
  ): Promise<unknown>
  dispose(): void
}
export interface HostTaskExpectedReview {
  request: HostTaskRequest
  threadId: string
  turnId: string
}
export interface HostTaskServiceTransport {
  prepare(assignment: HostTaskAssignment, input: HostTaskRouterInput): Promise<HostTaskRouterDescriptor>
  register(prepared: HostTaskPrepared): Promise<HostTaskRouterDescriptor>
  snapshot(prepared: HostTaskPrepared, afterSeq: number): Promise<HostTaskRouterResult>
  submit(prepared: HostTaskPrepared, guard: HostTaskGuard): Promise<HostTaskRouterResult>
  reply(
    prepared: HostTaskPrepared,
    reply: { sessionId: string; requestId: string; result: unknown; expectedReview: HostTaskExpectedReview },
    guard: HostTaskGuard
  ): Promise<HostTaskRouterResult>
  stop(prepared: HostTaskPrepared): Promise<HostTaskRouterResult>
  cancelUnsubmitted(prepared: HostTaskPrepared): Promise<HostTaskRouterResult>
  dispose(): void
}

function fail(): never {
  throw new Error('host-task-transport-invalid')
}
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const copy = <T>(value: T): T => JSON.parse(canonicalHostTaskJson(value))
const same = (left: unknown, right: unknown) => canonicalHostTaskJson(left) === canonicalHostTaskJson(right)
const terminal = (phase: HostTaskPhase) => phase === 'completed' || phase === 'stopped'
const phases: HostTaskPhase[] = [
  'thread-start-intent',
  'thread-bound',
  'turn-start-intent',
  'running',
  'waiting',
  'recovery-required',
  'completed',
  'stopped',
]

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertySymbols(value).length || required.some((key) => !descriptors[key])) fail()
  for (const [key, descriptor] of Object.entries(descriptors))
    if ((!required.includes(key) && !optional.includes(key)) || !descriptor.enumerable || !('value' in descriptor))
      fail()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail()
}
function time(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
}
function descriptor(value: unknown): HostTaskRouterDescriptor {
  const d = object(value, [
    'version',
    'targetId',
    'targetEpoch',
    'root',
    'assignment',
    'directory',
    'workspace',
    'inputHash',
  ])
  if (d.version !== 2) fail()
  for (const key of ['targetId', 'targetEpoch', 'root', 'directory', 'workspace', 'inputHash']) text(d[key], 2000)
  if (!/^[a-f0-9]{64}$/.test(String(d.inputHash))) fail()
  const assignment = object(d.assignment, ['jobId', 'messageId', 'workItemId', 'sessionId'])
  for (const value of Object.values(assignment)) text(value, 128)
  return copy(d) as unknown as HostTaskRouterDescriptor
}
function prepared(value: HostTaskPrepared): HostTaskPrepared {
  const p = object(value, ['version', 'descriptor', 'input'])
  if (p.version !== 1) fail()
  const d = descriptor(p.descriptor)
  const input = object(p.input, ['prompt', 'systemPrompt', 'model', 'effort', 'threadId', 'tools', 'reviewTtlMs'])
  if (hash({ ...input, workspace: d.workspace }) !== d.inputHash) fail()
  return copy(value)
}

function parseSnapshot(p: HostTaskPrepared, raw: unknown, afterSeq: number): HostTaskSnapshot {
  const s = object(raw, ['sessionId', 'pid', 'job', 'events', 'requests', 'result'])
  text(s.sessionId)
  time(s.pid)
  if (
    s.pid === 0 ||
    !Array.isArray(s.events) ||
    s.events.length > 100 ||
    !Array.isArray(s.requests) ||
    s.requests.length > 16
  )
    fail()
  const job =
    s.job === null
      ? null
      : (copy(
          object(
            s.job,
            ['id', 'inputHash', 'spec', 'phase', 'threadId', 'turnId', 'createdAt', 'updatedAt'],
            ['stopReason']
          )
        ) as unknown as NonNullable<HostTaskSnapshot['job']>)
  if (job) {
    if (
      job.id !== p.descriptor.assignment.jobId ||
      job.inputHash !== p.descriptor.inputHash ||
      !same(job.spec, { ...p.input, workspace: p.descriptor.workspace }) ||
      !phases.includes(job.phase)
    )
      fail()
    time(job.createdAt)
    time(job.updatedAt)
    if (job.updatedAt < job.createdAt) fail()
    if (job.threadId !== null) text(job.threadId)
    if (job.turnId !== null) text(job.turnId)
    if (
      (job.turnId && !job.threadId) ||
      (['running', 'waiting', 'completed'].includes(job.phase) && (!job.threadId || !job.turnId)) ||
      (['thread-start-intent', 'thread-bound', 'turn-start-intent'].includes(job.phase) && job.turnId)
    )
      fail()
    if (
      (job.phase === 'thread-start-intent' && job.threadId) ||
      (['thread-bound', 'turn-start-intent'].includes(job.phase) && !job.threadId)
    )
      fail()
    if (job.stopReason !== undefined && job.stopReason !== 'request-expired') fail()
  }
  let previousSeq = afterSeq
  const events = s.events.map((rawEvent) => {
    const event = object(rawEvent, ['seq', 'type', 'payload', 'createdAt'])
    time(event.seq)
    time(event.createdAt)
    text(event.type, 100)
    if (event.seq <= previousSeq || event.seq > 10000) fail()
    previousSeq = event.seq
    const payload = copy(event.payload)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail()
    return { seq: event.seq, type: event.type, payload: payload as Record<string, unknown>, createdAt: event.createdAt }
  })
  const requestIds = new Set<string>()
  const requests = s.requests.map((rawRequest) => {
    const r = object(
      rawRequest,
      ['id', 'sessionId', 'status', 'method', 'payload'],
      ['result', 'createdAt', 'updatedAt']
    )
    text(r.id)
    text(r.sessionId)
    if (
      !job ||
      terminal(job.phase) ||
      r.sessionId !== s.sessionId ||
      r.status !== 'pending' ||
      !['client-tool', 'provider-approval'].includes(String(r.method)) ||
      requestIds.has(r.id)
    )
      fail()
    requestIds.add(r.id)
    const payload = object(r.payload, ['expiresAt'], ['threadId', 'turnId', 'callId', 'tool', 'input', 'request'])
    time(payload.expiresAt)
    if (r.method === 'client-tool') {
      if (payload.threadId !== job.threadId || payload.turnId !== job.turnId) fail()
      text(payload.callId)
      text(payload.tool)
    } else if (!payload.request || typeof payload.request !== 'object') fail()
    return copy({ id: r.id, sessionId: r.sessionId, status: r.status, method: r.method, payload }) as HostTaskRequest
  })
  const result =
    s.result === null
      ? null
      : (copy(object(s.result, ['response', 'threadId'])) as unknown as NonNullable<HostTaskSnapshot['result']>)
  if (
    result &&
    (typeof result.response !== 'string' || result.response.length > 20000 || result.threadId !== job?.threadId)
  )
    fail()
  if (job?.phase === 'completed' ? result === null : result !== null) fail()
  if (!job && requests.length) fail()
  return { sessionId: s.sessionId, pid: s.pid, job, events, requests, result }
}

function parseResult(p: HostTaskPrepared, raw: unknown, afterSeq: number): HostTaskRouterResult {
  const result = object(raw, ['descriptor', 'state', 'snapshot'], ['cancellation'])
  if (
    !same(descriptor(result.descriptor), p.descriptor) ||
    !['reserved', 'recovery-required', 'running', 'waiting', 'completed', 'stopped', 'cancelled-unsubmitted'].includes(
      String(result.state)
    )
  )
    fail()
  const snapshot = result.snapshot === null ? null : parseSnapshot(p, result.snapshot, afterSeq)
  if (result.state === 'cancelled-unsubmitted') {
    const cancellation = object(result.cancellation, ['kind', 'at'])
    if (snapshot !== null || cancellation.kind !== 'unsubmitted') fail()
    time(cancellation.at)
    return {
      descriptor: p.descriptor,
      state: 'cancelled-unsubmitted',
      snapshot,
      cancellation: { kind: 'unsubmitted', at: cancellation.at },
    }
  }
  if (result.cancellation !== undefined || (result.state === 'reserved' && snapshot !== null)) fail()
  if (
    ['running', 'waiting', 'completed', 'stopped'].includes(String(result.state)) &&
    snapshot?.job?.phase !== result.state
  )
    fail()
  return { descriptor: p.descriptor, state: result.state as HostTaskRouterResult['state'], snapshot }
}

export function createHostTaskServiceTransport(raw: HostTaskRawTransport): HostTaskServiceTransport {
  let disposed = false
  const available = () => {
    if (disposed) throw Error('host-task-transport-disposed')
  }
  const request = async (
    p: HostTaskPrepared,
    op: string,
    fields: Record<string, unknown> = {},
    guard?: HostTaskGuard,
    expectedReview?: HostTaskExpectedReview
  ) => {
    available()
    const bound = prepared(p)
    const result = await raw.request(
      JSON.stringify({ op, assignment: bound.descriptor.assignment, ...fields }),
      guard
        ? { prepared: bound, guard, ...(expectedReview ? { expectedReview: copy(expectedReview) } : {}) }
        : undefined
    )
    available()
    return parseResult(bound, result, typeof fields.afterSeq === 'number' ? fields.afterSeq : 0)
  }
  return {
    async prepare(assignment, input) {
      available()
      const bound = copy({ assignment, input })
      const result = descriptor(await raw.request(JSON.stringify({ op: 'prepare', ...bound })))
      available()
      if (
        !same(result.assignment, bound.assignment) ||
        result.inputHash !== hash({ ...bound.input, workspace: result.workspace })
      )
        fail()
      return result
    },
    async register(p) {
      available()
      const bound = prepared(p)
      const result = descriptor(
        await raw.request(
          JSON.stringify({
            op: 'register',
            assignment: bound.descriptor.assignment,
            input: bound.input,
            prepared: bound.descriptor,
          })
        )
      )
      available()
      if (!same(result, bound.descriptor)) fail()
      return result
    },
    snapshot: (p, afterSeq) => {
      time(afterSeq)
      if (afterSeq > 10000) fail()
      return request(p, 'snapshot', { afterSeq })
    },
    submit: (p, guard) => request(p, 'submit', {}, guard),
    reply: (p, { expectedReview, ...reply }, guard) => request(p, 'reply', copy(reply), guard, expectedReview),
    stop: (p) => request(p, 'stop'),
    cancelUnsubmitted: (p) => request(p, 'cancel-unsubmitted', { inputHash: p.descriptor.inputHash }),
    dispose() {
      disposed = true
      raw.dispose()
    },
  }
}

export function accumulateHostSnapshot(
  input: HostTaskPrepared,
  previous: HostTaskProjection | null,
  raw: HostTaskSnapshot,
  afterSeq = previous?.cursor ?? 0
): HostTaskProjection {
  const p = prepared(input)
  time(afterSeq)
  if (afterSeq > 10000 || afterSeq !== (previous?.cursor ?? 0)) fail()
  const snapshot = parseSnapshot(p, raw, afterSeq)
  const last = previous?.observation
  if (last && (last.preparedHash !== hash(p) || last.delivery.kind !== 'content')) fail()
  const cursor = snapshot.events.at(-1)?.seq ?? afterSeq
  const sessionChanged = Boolean(previous?.sessionChanged || (last && last.coordinatorSessionId !== snapshot.sessionId))
  if (!snapshot.job) {
    if (last) fail()
    return { observation: null, requests: [], cursor, drained: snapshot.events.length < 100, sessionChanged }
  }
  const job = snapshot.job
  if (last) {
    if (
      job.createdAt !== last.job.createdAt ||
      job.updatedAt < last.job.updatedAt ||
      (last.job.threadId && job.threadId !== last.job.threadId) ||
      (last.job.turnId && job.turnId !== last.job.turnId)
    )
      fail()
    if (
      terminal(last.job.phase) &&
      (job.phase !== last.job.phase ||
        job.updatedAt !== last.job.updatedAt ||
        (job.stopReason ?? null) !== last.job.stopReason)
    )
      fail()
  }
  let response = last?.delivery.kind === 'content' ? last.delivery.response : ''
  const steps: AgentTurnStep[] = last?.delivery.kind === 'content' ? copy(last.delivery.steps) : []
  for (const event of snapshot.events) {
    if (event.type === 'worker-report') {
      const report = object(event.payload, ['type', 'id', 'text'], ['monotonicMs'])
      text(report.id)
      if (
        typeof report.text !== 'string' ||
        report.text.length > 10000 ||
        !['status', 'reasoning', 'response'].includes(String(report.type))
      )
        fail()
      if (report.type === 'response') response = report.text
      else {
        const prior = steps.findIndex((step) => step.id === report.id)
        if (prior >= 0) {
          if (steps[prior].kind !== report.type) fail()
          steps[prior] = { ...steps[prior], text: report.text }
        } else
          steps.push({
            id: report.id,
            kind: report.type as AgentTurnStep['kind'],
            text: report.text,
            at: event.createdAt,
          })
        if (steps.length > 500) fail()
      }
    } else if (event.type === 'result-persisted') {
      const payload = object(event.payload, ['result'], ['monotonicMs'])
      const result = object(payload.result, ['response', 'threadId'])
      if (typeof result.response !== 'string' || result.response.length > 20000 || result.threadId !== job.threadId)
        fail()
      if (job.phase === 'completed' && !same(result, snapshot.result)) fail()
    }
  }
  if (job.phase === 'completed') response = snapshot.result?.response ?? fail()
  const observation: HostTaskHostObservation = {
    version: 1,
    kind: 'host',
    preparedHash: hash(p),
    coordinatorSessionId: snapshot.sessionId,
    cursor,
    job: {
      jobId: job.id,
      inputHash: job.inputHash,
      phase: job.phase,
      threadId: job.threadId,
      turnId: job.turnId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      stopReason: job.stopReason ?? null,
    },
    terminalResultHash: job.phase === 'completed' ? hash({ response, threadId: job.threadId }) : null,
    delivery: { kind: 'content', response, steps },
  }
  if (
    last &&
    previous?.drained &&
    terminal(last.job.phase) &&
    (!same(last.delivery, observation.delivery) || last.terminalResultHash !== observation.terminalResultHash)
  )
    fail()
  canonicalHostTaskJson(observation)
  return { observation, requests: snapshot.requests, cursor, sessionChanged, drained: snapshot.events.length < 100 }
}
