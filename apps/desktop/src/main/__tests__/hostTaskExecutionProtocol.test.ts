import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  type HostTaskHostObservation,
  type HostTaskPrepared,
  validateHostTaskObservation,
  validateHostTaskPrepared,
  validateHostTaskReceivedAt,
} from '../hostTaskExecutionProtocol'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1 } from '../hostTaskProtocol'

const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const invalidPrepared = /host-task-prepared-invalid|host-task-invalid-data/
const invalidObservation = /host-task-observation-invalid|host-task-invalid-data/
function fixture() {
  const jobId = 'job-A'
  const directory = `/private/tmp/e074/jobs/${createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`
  const envelope: HostTaskEnvelopeV1 = {
    version: 1,
    actionId: 'action-A',
    workItemId: 'task-A',
    sessionId: 'session-A',
    jobId,
    userMessageId: 'user-A',
    assistantMessageId: 'assistant-A',
    provider: 'codex',
    instruction: 'Prepare the synthetic draft.',
    targetId: 'mini-1',
    policyFingerprint: 'policy-1',
    startedAt: 100000,
    sources: [{ spaceId: 'personal', slug: 'draft', revision: 'r1', explicit: true }],
    taskDefinition: {
      version: 1,
      id: 'task-A',
      title: 'Prepare draft',
      description: 'A synthetic obligation',
      prompt: 'Draft only',
      aiSuggestion: null,
      context: 'Synthetic',
      returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
      lifecycle: 'open',
      status: 'todo',
      priority: 'none',
      dueAt: null,
      sources: [],
    },
    preparedInput: {
      prompt: 'Exact synthetic task context',
      systemPrompt: 'No external actions.',
      model: 'gpt-5.2',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: `${directory}/workspace`,
    },
  }
  const { workspace, ...input } = envelope.preparedInput
  const prepared: HostTaskPrepared = {
    version: 1,
    descriptor: {
      version: 2,
      targetId: envelope.targetId,
      targetEpoch: 'epoch-1',
      root: '/private/tmp/e074',
      assignment: { jobId, messageId: 'assistant-A', workItemId: 'task-A', sessionId: 'session-A' },
      directory,
      workspace,
      inputHash: '',
    },
    input: { ...input, reviewTtlMs: 300000 },
  }
  prepared.descriptor.inputHash = hash({ ...prepared.input, workspace })
  return { envelope, prepared }
}
function completed(prepared: HostTaskPrepared): HostTaskHostObservation {
  const response = 'The draft is ready; the human task is still open.'
  return {
    version: 1,
    kind: 'host',
    preparedHash: hash(prepared),
    coordinatorSessionId: 'coordinator-A',
    cursor: 15,
    job: {
      jobId: prepared.descriptor.assignment.jobId,
      inputHash: prepared.descriptor.inputHash,
      phase: 'completed',
      threadId: 'thread-A',
      turnId: 'turn-A',
      createdAt: 1000,
      updatedAt: 1400,
      stopReason: null,
    },
    terminalResultHash: hash({ response, threadId: 'thread-A' }),
    delivery: { kind: 'content', response, steps: [{ id: 'step-1', kind: 'status', text: 'Drafting', at: 1200 }] },
  }
}
function check(observation: unknown, f = fixture()) {
  return validateHostTaskObservation(f.envelope, f.prepared, observation)
}

test('prepared input preserves exact descriptor, explicit TTL and canonical hashes without aliasing', () => {
  const { envelope, prepared } = fixture()
  const result = validateHostTaskPrepared(envelope, prepared)
  assert.deepEqual(result.prepared, prepared)
  assert.equal(result.serialized, canonicalHostTaskJson(prepared))
  assert.equal(result.preparedHash, hash(prepared))
  result.prepared.descriptor.assignment.jobId = 'mutated-copy'
  assert.equal(prepared.descriptor.assignment.jobId, 'job-A')
  assert.equal(validateHostTaskPrepared(envelope, prepared).preparedHash, hash(prepared))
})

test('every prepared assignment identity and target is bound to the envelope', () => {
  for (const key of ['jobId', 'messageId', 'workItemId', 'sessionId'] as const) {
    const { envelope, prepared } = fixture()
    prepared.descriptor.assignment[key] = 'other'
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared, key)
  }
  for (const key of ['targetId', 'inputHash'] as const) {
    const { envelope, prepared } = fixture()
    prepared.descriptor[key] = key === 'inputHash' ? 'f'.repeat(64) : 'other'
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared, key)
  }
})

test('prepared mapping cannot borrow prompt, tools, workspace or an implicit TTL', () => {
  for (const mutate of [
    (p: HostTaskPrepared) => {
      p.input.prompt = 'different'
    },
    (p: HostTaskPrepared) => {
      p.input.systemPrompt = 'different'
    },
    (p: HostTaskPrepared) => {
      p.input.model = 'other-model'
    },
    (p: HostTaskPrepared) => {
      p.input.effort = 'high'
    },
    (p: HostTaskPrepared) => {
      p.input.tools = [{ name: 'remember_memory', description: 'other', inputSchema: {} }]
    },
    (p: HostTaskPrepared) => {
      p.descriptor.workspace += '/other'
    },
  ]) {
    const { envelope, prepared } = fixture()
    mutate(prepared)
    prepared.descriptor.inputHash = hash({ ...prepared.input, workspace: prepared.descriptor.workspace })
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
  }
  for (const ttl of [undefined, 4999, 300001, 5000.5]) {
    const { envelope, prepared } = fixture()
    const value = { ...prepared, input: { ...prepared.input, reviewTtlMs: ttl } }
    assert.throws(() => validateHostTaskPrepared(envelope, value), invalidPrepared)
  }
  for (const ttl of [5000, 300000]) {
    const { envelope, prepared } = fixture()
    prepared.input.reviewTtlMs = ttl
    prepared.descriptor.inputHash = hash({ ...prepared.input, workspace: prepared.descriptor.workspace })
    assert.equal(validateHostTaskPrepared(envelope, prepared).prepared.input.reviewTtlMs, ttl)
  }
})

test('root, child path, epoch and router identifier bounds are strict and purely lexical', () => {
  for (const root of [
    'relative',
    '/private/tmp/../e074',
    '/private//tmp/e074',
    '/private/tmp/e074/',
    '/private/./e074',
    '/private\\tmp',
    '/private/tmp/\n',
  ]) {
    const { envelope, prepared } = fixture()
    prepared.descriptor.root = root
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
  }
  for (const key of ['directory', 'workspace'] as const) {
    const { envelope, prepared } = fixture()
    prepared.descriptor[key] += '-other'
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
  }
  for (const epoch of ['', 'x'.repeat(129), 'epoch\n', '../epoch']) {
    const { envelope, prepared } = fixture()
    prepared.descriptor.targetEpoch = epoch
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
  }
  const { envelope, prepared } = fixture()
  envelope.jobId = 'j'.repeat(129)
  prepared.descriptor.assignment.jobId = envelope.jobId
  assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
})

test('actual UTF8 serialized router limits reject oversized requests instead of character-count shortcuts', () => {
  for (const text of ['界'.repeat(22000), '\\'.repeat(30000)]) {
    const { envelope, prepared } = fixture()
    envelope.preparedInput.prompt = text
    prepared.input.prompt = text
    envelope.preparedInput.systemPrompt = 's'.repeat(10000)
    prepared.input.systemPrompt = envelope.preparedInput.systemPrompt
    prepared.descriptor.inputHash = hash({ ...prepared.input, workspace: prepared.descriptor.workspace })
    assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
  }
})

test('prepared data reject accessors, sparse arrays, extra keys and router-depth overflow', () => {
  const { envelope, prepared } = fixture()
  let called = 0
  const accessor = { ...prepared }
  Object.defineProperty(accessor, 'version', {
    enumerable: true,
    get: () => {
      called++
      return 1
    },
  })
  assert.throws(() => validateHostTaskPrepared(envelope, accessor), invalidPrepared)
  assert.equal(called, 0)
  assert.throws(() => validateHostTaskPrepared(envelope, { ...prepared, extra: true }), invalidPrepared)
  const sparse = { ...prepared, input: { ...prepared.input, tools: Array(1) } }
  assert.throws(() => validateHostTaskPrepared(envelope, sparse), invalidPrepared)
  let schema: Record<string, unknown> = {}
  for (let i = 0; i < 19; i++) schema = { nested: schema }
  envelope.preparedInput.tools = [{ name: 'remember_memory', description: '', inputSchema: schema }]
  prepared.input.tools = envelope.preparedInput.tools
  prepared.descriptor.inputHash = hash({ ...prepared.input, workspace: prepared.descriptor.workspace })
  assert.throws(() => validateHostTaskPrepared(envelope, prepared), invalidPrepared)
})

test('admission and cancelled-unsubmitted are distinct metadata without host or outcome', () => {
  const f = fixture()
  for (const state of ['registered', 'dispatch-intent']) {
    const value = { version: 1, kind: 'admission', preparedHash: hash(f.prepared), state }
    assert.deepEqual(check(value, f).observation, value)
    assert.equal(check(value, f).terminal, null)
  }
  const cancelled = {
    version: 1,
    kind: 'cancelled-unsubmitted',
    preparedHash: hash(f.prepared),
    cancellation: { kind: 'unsubmitted', at: 3 },
  }
  assert.deepEqual(check(cancelled, f).observation, cancelled)
  assert.equal(check(cancelled, f).terminal, null)
  for (const key of ['job', 'cursor', 'delivery', 'outcome', 'receivedAt'])
    assert.throws(() => check({ ...cancelled, [key]: null }, f), invalidObservation)
  assert.throws(() => check({ ...cancelled, cancellation: { kind: 'stopped', at: 3 } }, f), invalidObservation)
  assert.throws(() => check({ ...cancelled, cancellation: { kind: 'unsubmitted', at: -1 } }, f), invalidObservation)
  assert.throws(
    () => check({ version: 1, kind: 'admission', preparedHash: hash(f.prepared), state: 'running' }, f),
    invalidObservation
  )
})

test('completed observation binds result content and keeps host clock separate from local clock', () => {
  const f = fixture()
  const value = completed(f.prepared)
  const result = check(value, f)
  assert.deepEqual(result.observation, value)
  assert.equal(result.observationHash, hash(value))
  assert.equal(result.terminal?.hostCreatedAt, 1000)
  assert.equal(result.terminal?.hostTerminalAt, 1400)
  assert.equal(result.terminal?.durationMs, 400)
  assert.equal(result.terminal?.phase, 'completed')
  assert.equal(validateHostTaskReceivedAt(f.envelope, 100002), 100002)
  assert.equal(f.envelope.startedAt > value.job.updatedAt, true)
})

test('terminal identity survives later coordinator session and cursor without resampling time', () => {
  const f = fixture()
  const value = completed(f.prepared)
  const first = check(value, f)
  const next = check({ ...value, coordinatorSessionId: 'coordinator-restarted', cursor: 20 }, f)
  assert.deepEqual(first.terminal, next.terminal)
  assert.notEqual(first.observationHash, next.observationHash)
  assert.equal(Object.hasOwn(first.terminal ?? {}, 'receivedAt'), false)
})

test('completed-withheld has metadata only and shares the same terminal identity with verified content', () => {
  const f = fixture()
  const value = completed(f.prepared)
  const withheld = { ...value, delivery: { kind: 'withheld', reason: 'context-unavailable' } }
  assert.deepEqual(check(withheld, f).terminal, check(value, f).terminal)
  for (const extra of [{ response: 'secret' }, { steps: [] }, { content: null }])
    assert.throws(() => check({ ...withheld, delivery: { ...withheld.delivery, ...extra } }, f), invalidObservation)
  assert.throws(() => check({ ...withheld, delivery: { kind: 'withheld', reason: 'deleted' } }, f), invalidObservation)
})

test('wrong prepared/job/input/result hashes reject before a result can be represented', () => {
  const f = fixture()
  const value = completed(f.prepared)
  for (const altered of [
    { ...value, preparedHash: 'f'.repeat(64) },
    { ...value, job: { ...value.job, jobId: 'job-B' } },
    { ...value, job: { ...value.job, inputHash: 'f'.repeat(64) } },
    { ...value, terminalResultHash: 'f'.repeat(64) },
    { ...value, terminalResultHash: null },
    { ...value, job: { ...value.job, threadId: 'thread-B' } },
  ])
    assert.throws(() => check(altered, f), invalidObservation)
})

test('result-like response without completed phase never produces terminal completion', () => {
  const f = fixture()
  const value = completed(f.prepared)
  const running = { ...value, job: { ...value.job, phase: 'running' }, terminalResultHash: null }
  assert.equal(check(running, f).terminal, null)
  assert.throws(() => check({ ...running, terminalResultHash: value.terminalResultHash }, f), invalidObservation)
  const recovery = { ...running, job: { ...running.job, phase: 'recovery-required', stopReason: 'request-expired' } }
  assert.equal(check(recovery, f).terminal, null)
})

test('stopped is confirmed phase metadata and does not invent a result hash or local invalidation reason', () => {
  const f = fixture()
  const value = completed(f.prepared)
  const stopped = {
    ...value,
    job: { ...value.job, phase: 'stopped', stopReason: 'request-expired' },
    terminalResultHash: null,
    delivery: { kind: 'content', response: '', steps: [] },
  }
  assert.equal(check(stopped, f).terminal?.phase, 'stopped')
  assert.equal(check(stopped, f).terminal?.stopReason, 'request-expired')
  assert.throws(
    () => check({ ...stopped, job: { ...stopped.job, stopReason: 'context-invalidated' } }, f),
    invalidObservation
  )
})

test('phase/thread/turn combinations match the actual coordinator lifecycle', () => {
  const f = fixture()
  const value = completed(f.prepared)
  for (const [phase, threadId, turnId] of [
    ['thread-start-intent', null, null],
    ['thread-bound', 'thread-A', null],
    ['turn-start-intent', 'thread-A', null],
    ['running', 'thread-A', 'turn-A'],
    ['waiting', 'thread-A', 'turn-A'],
    ['recovery-required', null, null],
    ['stopped', null, null],
  ]) {
    const observation = { ...value, job: { ...value.job, phase, threadId, turnId }, terminalResultHash: null }
    assert.equal(check(observation, f).observation.kind, 'host')
  }
  for (const [phase, threadId, turnId] of [
    ['thread-start-intent', 'thread-A', null],
    ['thread-bound', 'thread-A', 'turn-A'],
    ['running', 'thread-A', null],
    ['waiting', null, null],
    ['recovery-required', null, 'turn-A'],
    ['stopped', null, 'turn-A'],
    ['done', 'thread-A', 'turn-A'],
  ])
    assert.throws(
      () => check({ ...value, job: { ...value.job, phase, threadId, turnId }, terminalResultHash: null }, f),
      invalidObservation
    )
})

test('host time, cursor and opaque identifiers have explicit safe bounds', () => {
  const f = fixture()
  const value = completed(f.prepared)
  for (const cursor of [-1, 1.5, 10001, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => check({ ...value, cursor }, f), invalidObservation)
  assert.equal(check({ ...value, cursor: 10000 }, f).observation.kind, 'host')
  for (const updatedAt of [-1, 999, 1000.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => check({ ...value, job: { ...value.job, updatedAt } }, f), invalidObservation)
  for (const coordinatorSessionId of ['', 'x'.repeat(201), 'id\n'])
    assert.throws(() => check({ ...value, coordinatorSessionId }, f), invalidObservation)
})

test('full steps require bounded unique exact records and reject sparse/accessor data without invocation', () => {
  const f = fixture()
  const value = completed(f.prepared)
  assert.equal(value.delivery.kind, 'content')
  const step = { id: 'step', kind: 'status', text: 'Kept', at: 1001 }
  for (const steps of [
    [step, step],
    [{ ...step, extra: true }],
    [{ ...step, kind: 'response' }],
    [{ ...step, at: -1 }],
    Array(1),
    Array.from({ length: 501 }, (_, i) => ({ ...step, id: `step-${i}` })),
  ])
    assert.throws(
      () =>
        check(
          {
            ...value,
            delivery: { kind: 'content', response: 'x', steps },
            terminalResultHash: hash({ response: 'x', threadId: 'thread-A' }),
          },
          f
        ),
      invalidObservation
    )
  let called = 0
  const steps = [step]
  Object.defineProperty(steps, '0', {
    enumerable: true,
    get: () => {
      called++
      return step
    },
  })
  assert.throws(() => check({ ...value, delivery: { kind: 'content', response: 'x', steps } }, f), invalidObservation)
  assert.equal(called, 0)
})

test('local terminal receivedAt is explicit, nonregressing and never sampled by the pure validator', () => {
  const f = fixture()
  for (const value of [-1, 99999, 100000.1, Number.MAX_SAFE_INTEGER + 1, undefined])
    assert.throws(() => validateHostTaskReceivedAt(f.envelope, value), /host-task-received-at-invalid/)
  const original = Date.now
  Date.now = () => {
    throw new Error('clock-must-not-be-sampled')
  }
  try {
    assert.equal(validateHostTaskReceivedAt(f.envelope, 100000), 100000)
    assert.equal(check(completed(f.prepared), f).terminal?.durationMs, 400)
  } finally {
    Date.now = original
  }
})
