import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { HostTaskPrepared } from '../hostTaskExecutionProtocol'
import { canonicalHostTaskJson } from '../hostTaskProtocol'
import {
  accumulateHostSnapshot,
  createHostTaskServiceTransport,
  type HostTaskProjection,
  type HostTaskSnapshot,
} from '../hostTaskServiceTransport'

const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
function fixture() {
  const input = {
    prompt: 'Synthetic',
    systemPrompt: 'Synthetic',
    model: 'fake-model',
    effort: 'low' as const,
    threadId: null,
    tools: [],
    reviewTtlMs: 300000,
  }
  const directory = '/private/tmp/e075/jobs/123'
  const prepared: HostTaskPrepared = {
    version: 1,
    input,
    descriptor: {
      version: 2,
      targetId: 'local',
      targetEpoch: 'epoch-1',
      root: '/private/tmp/e075',
      directory,
      workspace: `${directory}/workspace`,
      assignment: { jobId: 'job-A', messageId: 'assistant-A', workItemId: 'task-A', sessionId: 'session-A' },
      inputHash: hash({ ...input, workspace: `${directory}/workspace` }),
    },
  }
  const snapshot: HostTaskSnapshot = {
    sessionId: 'coordinator-1',
    pid: 123,
    job: {
      id: 'job-A',
      inputHash: prepared.descriptor.inputHash,
      spec: { ...input, workspace: prepared.descriptor.workspace },
      phase: 'running',
      threadId: 'thread-A',
      turnId: 'turn-A',
      createdAt: 100,
      updatedAt: 110,
    },
    events: [],
    requests: [],
    result: null,
  }
  return { prepared, snapshot }
}
const report = (seq: number, id: string, text: string, type = 'status') => ({
  seq,
  type: 'worker-report',
  createdAt: 100 + seq,
  payload: { type, id, text },
})

test('repeated report IDs preserve first timestamp/order and update full text without a new step', () => {
  const { prepared, snapshot } = fixture()
  const first = accumulateHostSnapshot(prepared, null, {
    ...snapshot,
    events: [report(1, 'a', 'First'), report(2, 'b', 'Second')],
  })
  const next = accumulateHostSnapshot(prepared, first, { ...snapshot, events: [report(3, 'a', 'Updated')] })
  assert.deepEqual(next.observation?.delivery, {
    kind: 'content',
    response: '',
    steps: [
      { id: 'a', kind: 'status', text: 'Updated', at: 101 },
      { id: 'b', kind: 'status', text: 'Second', at: 102 },
    ],
  })
  assert.equal(next.cursor, 3)
  assert.equal(next.drained, true)
})

test('completed snapshot paginates 105 reports before terminal freeze; later reconnect preserves all steps and host time', () => {
  const { prepared, snapshot } = fixture()
  assert(snapshot.job)
  const done: HostTaskSnapshot = {
    ...snapshot,
    job: { ...snapshot.job, phase: 'completed', updatedAt: 300 },
    result: { response: 'Done', threadId: 'thread-A' },
  }
  const first = accumulateHostSnapshot(prepared, null, {
    ...done,
    events: Array.from({ length: 100 }, (_, i) => report(i + 1, `id-${i}`, `Step ${i}`)),
  })
  assert.equal(first.drained, false)
  const next = accumulateHostSnapshot(prepared, first, {
    ...done,
    events: Array.from({ length: 5 }, (_, i) => report(i + 101, `id-${i + 100}`, `Step ${i + 100}`)),
  })
  assert.equal(next.drained, true)
  assert.equal(next.observation?.delivery.kind === 'content' && next.observation.delivery.steps.length, 105)
  const reconnect = accumulateHostSnapshot(prepared, next, {
    ...done,
    sessionId: 'coordinator-2',
    events: [{ seq: 106, type: 'coordinator-started', payload: {}, createdAt: 400 }],
  })
  assert.equal(reconnect.sessionChanged, true)
  assert.deepEqual(reconnect.observation?.delivery, next.observation?.delivery)
  assert.equal(reconnect.observation?.job.updatedAt, 300)
  assert.equal(reconnect.observation?.terminalResultHash, hash({ response: 'Done', threadId: 'thread-A' }))
  assert.throws(
    () => accumulateHostSnapshot(prepared, next, { ...done, events: [report(106, 'new', 'Illegal late step')] }),
    /transport|projection/
  )
})

test('result-persisted alone never publishes a terminal result', () => {
  const { prepared, snapshot } = fixture()
  const value = accumulateHostSnapshot(prepared, null, {
    ...snapshot,
    events: [
      {
        seq: 1,
        type: 'result-persisted',
        createdAt: 105,
        payload: { result: { response: 'Not yet terminal', threadId: 'thread-A' } },
      },
    ],
  })
  assert.equal(value.observation?.job.phase, 'running')
  assert.equal(value.observation?.terminalResultHash, null)
  assert.equal(value.observation?.delivery.kind === 'content' && value.observation.delivery.response, '')
})

test('wrong exact identity/spec/time/session/cursor and changed step kind fail closed', () => {
  const { prepared, snapshot } = fixture()
  assert(snapshot.job)
  for (const job of [
    { ...snapshot.job, id: 'other' },
    { ...snapshot.job, spec: { ...snapshot.job.spec, prompt: 'changed' } },
    { ...snapshot.job, updatedAt: 99 },
  ])
    assert.throws(() => accumulateHostSnapshot(prepared, null, { ...snapshot, job }), /transport|projection/)
  const first = accumulateHostSnapshot(prepared, null, { ...snapshot, events: [report(1, 'a', 'First')] })
  for (const changed of [
    { ...snapshot, events: [report(1, 'a', 'Again')] },
    { ...snapshot, events: [report(2, 'a', 'Kind changed', 'reasoning')] },
    { ...snapshot, job: { ...snapshot.job, turnId: 'other-turn' }, events: [] },
  ])
    assert.throws(() => accumulateHostSnapshot(prepared, first, changed), /transport|projection/)
})

test('current reviews are exact session/thread/turn bound, while absent job has no private result or reviews', () => {
  const { prepared, snapshot } = fixture()
  const review = {
    id: 'review-A',
    sessionId: snapshot.sessionId,
    status: 'pending' as const,
    method: 'client-tool' as const,
    payload: {
      expiresAt: 1000,
      threadId: 'thread-A',
      turnId: 'turn-A',
      callId: 'call-A',
      tool: 'remember_memory',
      input: { action: 'qa_review', question: 'Synthetic?' },
    },
  }
  const valid = accumulateHostSnapshot(prepared, null, { ...snapshot, requests: [review] })
  assert.equal(valid.requests.length, 1)
  assert.throws(
    () => accumulateHostSnapshot(prepared, null, { ...snapshot, requests: [{ ...review, sessionId: 'other' }] }),
    /transport|projection/
  )
  assert.throws(
    () => accumulateHostSnapshot(prepared, null, { ...snapshot, job: null, requests: [review] }),
    /transport|projection/
  )
  assert.throws(
    () =>
      accumulateHostSnapshot(prepared, null, {
        ...snapshot,
        job: null,
        result: { response: 'Private', threadId: 'thread-A' },
      }),
    /transport|projection/
  )
})

test('typed port pins exact descriptor and guard; rejects mismatched response without changing caller input', async () => {
  const { prepared, snapshot } = fixture()
  const calls: unknown[] = []
  const guard = async () => () => {}
  const port = createHostTaskServiceTransport({
    request: async (text, binding) => {
      calls.push({ text: JSON.parse(text), binding })
      return { descriptor: prepared.descriptor, state: 'running', snapshot }
    },
    dispose() {},
  })
  await port.submit(prepared, guard)
  assert.equal((calls[0] as { binding: { guard: unknown } }).binding.guard, guard)
  const wrong = createHostTaskServiceTransport({
    request: async () => ({ descriptor: { ...prepared.descriptor, targetEpoch: 'other' }, state: 'running', snapshot }),
    dispose() {},
  })
  await assert.rejects(wrong.snapshot(prepared, 0), /transport/)
})

test('declared step and cursor bounds reject overflow without truncating the prior projection', () => {
  const { prepared, snapshot } = fixture()
  let projection: HostTaskProjection | null = null
  for (let page = 0; page < 5; page++) {
    projection = accumulateHostSnapshot(prepared, projection, {
      ...snapshot,
      events: Array.from({ length: 100 }, (_, index) => {
        const sequence = page * 100 + index + 1
        return report(sequence, `step-${sequence}`, 'Synthetic')
      }),
    })
  }
  assert(projection?.observation?.delivery.kind === 'content')
  assert.equal(projection.observation.delivery.steps.length, 500)
  const before = structuredClone(projection)
  assert.throws(
    () => accumulateHostSnapshot(prepared, projection, { ...snapshot, events: [report(501, 'overflow', 'Rejected')] }),
    /transport/
  )
  assert.throws(
    () =>
      accumulateHostSnapshot(prepared, projection, { ...snapshot, events: [report(10001, 'overflow', 'Rejected')] }),
    /transport/
  )
  assert.deepEqual(projection, before)
})

test('withheld release must rebuild from zero rather than inventing a previous projection at an advanced cursor', () => {
  const { prepared, snapshot } = fixture()
  const history = {
    ...snapshot,
    events: [
      report(1, 'first', 'Before unavailable'),
      report(2, 'first', 'After unavailable'),
      report(3, 'second', 'Later work'),
    ],
  }
  const rebuilt = accumulateHostSnapshot(prepared, null, history, 0)
  assert(rebuilt.observation?.delivery.kind === 'content')
  assert.deepEqual(
    rebuilt.observation.delivery.steps.map(({ id, text, at }) => ({ id, text, at })),
    [
      { id: 'first', text: 'After unavailable', at: 101 },
      { id: 'second', text: 'Later work', at: 103 },
    ]
  )
  assert.throws(() => accumulateHostSnapshot(prepared, null, { ...snapshot, events: [] }, 3), /transport/)
})
