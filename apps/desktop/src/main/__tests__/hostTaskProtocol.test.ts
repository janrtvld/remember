import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkItem } from '@remember/shared'
import {
  canonicalHostTaskJson,
  type HostTaskEnvelopeV1,
  hostTaskDefinition,
  hostTaskDefinitionHash,
  hostTaskSessionReceipt,
  validateHostTaskEnvelope,
  validateHostTaskOutcome,
} from '../hostTaskProtocol'

function item(): WorkItem {
  return {
    id: 'task-a',
    title: 'Draft summary',
    description: 'Synthetic',
    prompt: 'Prepare',
    context: 'Local test',
    returnPoint: { lastMove: '', unresolved: 'Synthetic', nextMove: '' },
    lifecycle: 'open',
    status: 'todo',
    priority: 'none',
    dueAt: null,
    attention: 'idle',
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    userEditedTitle: false,
    userEditedDescription: false,
    sources: [
      {
        id: 'source-a',
        kind: 'manual',
        label: 'Manual',
        detail: 'Synthetic',
        workdayId: null,
        conversationStartTime: null,
        observedAt: 1,
        confidence: null,
      },
    ],
    facts: [],
    observations: [],
    agentSessions: [],
  }
}
function envelope(): HostTaskEnvelopeV1 {
  return {
    version: 1,
    actionId: 'action-a',
    workItemId: 'task-a',
    sessionId: 'session-a',
    jobId: 'job-a',
    userMessageId: 'user-a',
    assistantMessageId: 'assistant-a',
    provider: 'codex',
    instruction: 'Prepare a draft',
    targetId: 'mini-qa',
    taskDefinition: hostTaskDefinition(item()),
    policyFingerprint: 'policy-1',
    sources: [],
    startedAt: 2,
    preparedInput: {
      prompt: 'Prepare a draft',
      systemPrompt: 'Synthetic context',
      model: 'fake-model',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: '/private/tmp/task-a',
    },
  }
}
const outcome = () => ({
  version: 1,
  status: 'completed',
  response: 'Saved synthetic result',
  steps: [],
  completedAt: 3,
  durationMs: 1,
})

test('exact definition excludes only derived Task state and normalizes optional source references', () => {
  const a = item()
  const before = hostTaskDefinitionHash(hostTaskDefinition(a))
  a.updatedAt = 999
  a.attention = 'agent_running'
  a.closedAt = 777
  a.userEditedTitle = true
  a.facts.push({
    id: 'fact',
    type: 'agent_started',
    actor: 'user',
    summary: 'Prepared',
    at: 2,
    agentSessionId: 'session',
  })
  assert.equal(hostTaskDefinitionHash(hostTaskDefinition(a)), before)
  assert.equal(hostTaskDefinition(a).sources[0]?.conversationReference, null)
  a.title = 'Changed'
  assert.notEqual(hostTaskDefinitionHash(hostTaskDefinition(a)), before)
})
test('actual observed and legacy source ID shapes remain valid opaque source identifiers', () => {
  const a = item()
  a.sources[0]!.id = 'work-item-a:source:meeting-1'
  a.sources[0]!.kind = 'observed'
  assert.equal(hostTaskDefinition(a).sources[0]?.id, 'work-item-a:source:meeting-1')
  a.sources[0]!.id = 'session-1:legacy'
  a.sources[0]!.kind = 'legacy'
  assert.equal(hostTaskDefinition(a).sources[0]?.id, 'session-1:legacy')
})
test('definition/source ordering is canonical, duplicate IDs and source control characters reject', () => {
  const a = item()
  a.sources.push({ ...a.sources[0]!, id: 'source-0' })
  assert.equal(hostTaskDefinition(a).sources[0]?.id, 'source-0')
  a.sources[0]!.id = 'source-0'
  assert.throws(() => hostTaskDefinition(a))
  a.sources[0]!.id = 'source\nforged'
  assert.throws(() => hostTaskDefinition(a))
})
test('exact envelope receipt is stable and every immutable change changes its hash', () => {
  const a = envelope()
  const first = validateHostTaskEnvelope(a)
  assert.deepEqual(first.envelope, a)
  assert.equal(hostTaskSessionReceipt(a).envelopeHash, first.envelopeHash)
  for (const key of ['instruction', 'targetId', 'policyFingerprint'] as const) {
    const b = envelope()
    b[key] += '-changed'
    assert.notEqual(validateHostTaskEnvelope(b).envelopeHash, first.envelopeHash)
  }
  a.taskDefinition.title = 'Changed'
  assert.notEqual(validateHostTaskEnvelope(a).envelopeHash, first.envelopeHash)
})
test('no implicit task rebind, user/assistant collision, extra metadata or reused provider thread', () => {
  const a = envelope()
  for (const b of [
    { ...a, workItemId: 'task-b' },
    { ...a, userMessageId: a.assistantMessageId },
    { ...a, live: true },
    { ...a, preparedInput: { ...a.preparedInput, threadId: 'old-thread' } },
    { ...a, taskDefinition: { ...a.taskDefinition, updatedAt: 4 } },
  ])
    assert.throws(() => validateHostTaskEnvelope(b))
})
test('exact reference revision and explicit flag survive; duplicate refs and incomplete fields reject', () => {
  const a = envelope()
  a.sources = [{ spaceId: 'personal', slug: 'note', revision: 'rev1', explicit: true }]
  assert.deepEqual(validateHostTaskEnvelope(a).envelope.sources, a.sources)
  assert.throws(() => validateHostTaskEnvelope({ ...a, sources: [...a.sources, ...a.sources] }))
  assert.throws(() =>
    validateHostTaskEnvelope({ ...a, sources: [{ spaceId: 'personal', slug: 'note', revision: 'rev1' }] })
  )
})
test('non-JSON accessor/symbol/prototype/arrayhole rejected without invoking getter', () => {
  let calls = 0
  const a = { ...envelope() }
  Object.defineProperty(a, 'instruction', {
    enumerable: true,
    get() {
      calls++
      return 'bad'
    },
  })
  assert.throws(() => validateHostTaskEnvelope(a))
  assert.equal(calls, 0)
  assert.throws(() => canonicalHostTaskJson({ [Symbol('bad')]: true }))
  assert.throws(() => canonicalHostTaskJson(Object.create({ inherited: true })))
  assert.throws(() => canonicalHostTaskJson(new Array(2)))
  const arr: unknown[] = []
  Object.defineProperty(arr, '0', {
    enumerable: true,
    get() {
      calls++
      return 1
    },
  })
  assert.throws(() => canonicalHostTaskJson(arr))
  assert.equal(calls, 0)
})
test('non-finite/undefined/function/cyclic/deep/oversize payloads reject', () => {
  for (const value of [NaN, Infinity, undefined, () => 1, { x: undefined }, 'x'.repeat(131073)])
    assert.throws(() => canonicalHostTaskJson(value))
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalHostTaskJson(cyclic))
})
test('terminal outcome exact payload and hash, never uncertain/waiting completion', () => {
  const o = outcome()
  assert.deepEqual(validateHostTaskOutcome(o).outcome, o)
  for (const status of ['running', 'waiting', 'recovery-required', 'failed'])
    assert.throws(() => validateHostTaskOutcome({ ...o, status }))
  assert.throws(() => validateHostTaskOutcome({ ...o, completedAt: -1 }))
  assert.throws(() => validateHostTaskOutcome({ ...o, unexpected: 'private' }))
})
test('terminal step IDs and types are bounded and exact; duplicate IDs reject', () => {
  const step = { id: 'step-1', kind: 'status', text: 'Result received', at: 2 }
  assert.equal(validateHostTaskOutcome({ ...outcome(), steps: [step] }).outcome.steps.length, 1)
  assert.throws(() => validateHostTaskOutcome({ ...outcome(), steps: [step, step] }))
  assert.throws(() => validateHostTaskOutcome({ ...outcome(), steps: [{ ...step, kind: 'tool' }] }))
})
