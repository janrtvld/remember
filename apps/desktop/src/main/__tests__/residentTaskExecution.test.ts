import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { AgentTurnStep } from '@remember/shared'
import type { HostTaskHostObservation, HostTaskPrepared } from '../hostTaskExecutionProtocol'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskSessionReceipt } from '../hostTaskProtocol'
import { ResidentAgentStore, type SavedMemoryReceipt } from '../residentAgentStore'

const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const source = { spaceId: 'personal', slug: 'decision', revision: 'r1', explicit: true }
const step: AgentTurnStep = { id: 'step-1', kind: 'status', text: 'Earlier work', at: 100 }
const saved: SavedMemoryReceipt = {
  kind: 'saved-page',
  saved: true,
  proposed: false,
  spaceId: 'personal',
  slug: 'decision',
  revision: 'r2',
  title: 'Decision',
}

function input(id = 'A') {
  const root = '/private/tmp/e074-unit'
  const directory = `${root}/jobs/${createHash('sha256').update(`job-${id}`).digest('hex').slice(0, 24)}`
  const envelope: HostTaskEnvelopeV1 = {
    version: 1,
    actionId: `action-${id}`,
    workItemId: `task-${id}`,
    sessionId: `session-${id}`,
    jobId: `job-${id}`,
    userMessageId: `user-${id}`,
    assistantMessageId: `assistant-${id}`,
    provider: 'codex',
    instruction: 'Explicit synthetic instruction',
    targetId: 'mini-1',
    policyFingerprint: 'policy-1',
    sources: [{ ...source }],
    startedAt: 1000,
    preparedInput: {
      prompt: `Task ${id}`,
      systemPrompt: 'Synthetic only',
      model: 'fake-model',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: `${directory}/workspace`,
    },
    taskDefinition: {
      version: 1,
      id: `task-${id}`,
      title: `Task ${id}`,
      description: 'Human task stays open',
      prompt: 'Draft',
      aiSuggestion: null,
      context: 'Synthetic context',
      returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
      lifecycle: 'open',
      status: 'todo',
      priority: 'none',
      dueAt: null,
      sources: [],
    },
  }
  const { workspace, ...providerInput } = envelope.preparedInput
  const routerInput = { ...providerInput, reviewTtlMs: 300000 }
  const prepared: HostTaskPrepared = {
    version: 1,
    descriptor: {
      version: 2,
      targetId: 'mini-1',
      targetEpoch: 'epoch-1',
      root,
      directory,
      workspace,
      assignment: {
        jobId: envelope.jobId,
        messageId: envelope.assistantMessageId,
        workItemId: envelope.workItemId,
        sessionId: envelope.sessionId,
      },
      inputHash: hash({ ...routerInput, workspace }),
    },
    input: routerInput,
  }
  return { envelope, prepared }
}

function host(
  id = 'A',
  phase: HostTaskHostObservation['job']['phase'] = 'running',
  cursor = 1
): HostTaskHostObservation {
  const { prepared } = input(id)
  const response = phase === 'completed' ? 'Final synthetic answer' : phase === 'stopped' ? '' : 'Progress'
  return {
    version: 1,
    kind: 'host',
    preparedHash: hash(prepared),
    coordinatorSessionId: 'host-session-1',
    cursor,
    job: {
      jobId: `job-${id}`,
      inputHash: prepared.descriptor.inputHash,
      phase,
      threadId: `thread-${id}`,
      turnId: `turn-${id}`,
      createdAt: 3600000,
      updatedAt: phase === 'running' ? 3600010 : 3600100,
      stopReason: null,
    },
    terminalResultHash: phase === 'completed' ? hash({ response, threadId: `thread-${id}` }) : null,
    delivery: { kind: 'content', response, steps: phase === 'stopped' ? [] : [{ ...step }] },
  }
}

function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync('/private/tmp/e074-store-')
  const file = join(directory, 'assistant.sqlite')
  let now = 2000
  let samples = 0
  const clock = () => {
    samples++
    return now
  }
  let store = new ResidentAgentStore(file, { now: clock })
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const read = (sql: string) => {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return JSON.parse(JSON.stringify(db.prepare(sql).all()))
    } finally {
      db.close()
    }
  }
  return {
    file,
    get store() {
      return store
    },
    get samples() {
      return samples
    },
    time(value: number) {
      now = value
    },
    reopen() {
      store.close()
      store = new ResidentAgentStore(file, { now: clock })
    },
    read,
    exec(sql: string) {
      const db = new DatabaseSync(file)
      try {
        db.exec(sql)
      } finally {
        db.close()
      }
    },
    rows() {
      return Object.fromEntries(
        [
          'assistant_message',
          'assistant_task_run',
          'assistant_task_execution',
          'assistant_task_memory_source',
          'assistant_tool_call',
          'assistant_memory_source',
        ].map((table) => [table, read(`SELECT * FROM ${table} ORDER BY rowid`)])
      )
    },
    create(id = 'A', dispatch = false) {
      const value = input(id)
      store.createPreparedHostTaskIntent(value.envelope, value.prepared)
      store.acknowledgeHostTaskSession(`action-${id}`, hostTaskSessionReceipt(value.envelope))
      if (dispatch) {
        store.commitHostTaskObservation(`action-${id}`, {
          version: 1,
          kind: 'admission',
          preparedHash: hash(value.prepared),
          state: 'registered',
        })
        store.commitHostTaskObservation(`action-${id}`, {
          version: 1,
          kind: 'admission',
          preparedHash: hash(value.prepared),
          state: 'dispatch-intent',
        })
      }
      return value
    },
    claim(id = 'A', callId = `call-${id}`) {
      return store.claimToolCall(callId, `hash-${callId}`, {
        actionId: `action-${id}`,
        messageId: `assistant-${id}`,
        toolName: 'remember_memory',
      })
    },
  }
}

test('prepared creation owns descriptor, explicit TTL, messages and references atomically across reopen', (t) => {
  const f = fixture(t)
  const value = input()
  const result = f.store.createPreparedHostTaskIntent(value.envelope, value.prepared)
  assert.equal(result.state, 'prepared')
  assert.deepEqual(result.prepared, value.prepared)
  assert.equal(result.preparedHash, hash(value.prepared))
  assert.deepEqual(result.sources, [source])
  assert.equal(result.observation, null)
  assert.equal(result.terminal, null)
  assert.equal(f.store.hostRun(), null)
  assert.equal(f.store.get('assistant-A')?.error, 'assistant-host-task-not-submitted')
  const before = f.rows()
  value.prepared.input.reviewTtlMs = 5000
  assert.throws(() => f.store.createPreparedHostTaskIntent(value.envelope, value.prepared))
  assert.deepEqual(f.store.createPreparedHostTaskIntent(input().envelope, input().prepared), result)
  f.reopen()
  assert.deepEqual(f.store.hostTaskExecution('action-A'), result)
  assert.deepEqual(f.rows(), before)
})

test('legacy intent cannot be upgraded and immutable prepared identity never silently changes', (t) => {
  const f = fixture(t)
  f.create()
  for (const patch of [{ targetEpoch: 'epoch-2' }, { root: '/private/tmp/other' }, { inputHash: 'a'.repeat(64) }]) {
    const value = input()
    assert.throws(() =>
      f.store.createPreparedHostTaskIntent(value.envelope, {
        ...value.prepared,
        descriptor: { ...value.prepared.descriptor, ...patch },
      })
    )
  }
  f.store.createHostTaskIntent(input('B').envelope)
  const before = f.rows()
  assert.throws(() => f.store.createPreparedHostTaskIntent(input('B').envelope, input('B').prepared), /host-task/)
  assert.deepEqual(f.rows(), before)
})

for (const table of [
  'assistant_message',
  'assistant_task_run',
  'assistant_task_execution',
  'assistant_task_memory_source',
]) {
  for (const fault of ['ABORT', 'IGNORE'])
    test(`create rolls back every row when ${table} insert ${fault}s`, (t) => {
      const f = fixture(t)
      const before = f.rows()
      f.exec(
        `CREATE TRIGGER fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'synthetic-create-fault'" : ''}); END`
      )
      assert.throws(() => f.store.createPreparedHostTaskIntent(input().envelope, input().prepared))
      assert.deepEqual(f.rows(), before)
    })
}

test('unused cancellation stays a distinct tombstone with no stopped outcome', (t) => {
  const f = fixture(t)
  const value = f.create()
  const registered = { version: 1, kind: 'admission', preparedHash: hash(value.prepared), state: 'registered' }
  f.store.commitHostTaskObservation('action-A', registered)
  const cancel = {
    version: 1,
    kind: 'cancelled-unsubmitted',
    preparedHash: hash(value.prepared),
    cancellation: { kind: 'unsubmitted', at: 1234 },
  }
  const result = f.store.commitHostTaskObservation('action-A', cancel)
  assert.equal(result.state, 'cancelled-unsubmitted')
  assert.equal(result.intent.outcome, null)
  assert.equal(result.terminal, null)
  assert.equal(f.store.get('assistant-A')?.error, 'assistant-host-task-not-started')
  const before = f.rows()
  f.reopen()
  assert.deepEqual(f.store.commitHostTaskObservation('action-A', cancel), result)
  assert.throws(() => f.store.commitHostTaskObservation('action-A', registered), /host-task/)
  assert.throws(() => f.store.commitHostTaskObservation('action-A', host()), /host-task/)
  assert.deepEqual(f.rows(), before)
})

test('host observation needs receipt and dispatch intent; dispatch cannot become unused cancellation', (t) => {
  const f = fixture(t)
  const value = input()
  f.store.createPreparedHostTaskIntent(value.envelope, value.prepared)
  assert.throws(() => f.store.commitHostTaskObservation('action-A', host()), /host-task/)
  f.store.acknowledgeHostTaskSession('action-A', hostTaskSessionReceipt(value.envelope))
  assert.throws(() => f.store.commitHostTaskObservation('action-A', host()), /host-task/)
  f.store.commitHostTaskObservation('action-A', {
    version: 1,
    kind: 'admission',
    preparedHash: hash(value.prepared),
    state: 'registered',
  })
  f.store.commitHostTaskObservation('action-A', {
    version: 1,
    kind: 'admission',
    preparedHash: hash(value.prepared),
    state: 'dispatch-intent',
  })
  const before = f.rows()
  assert.throws(
    () =>
      f.store.commitHostTaskObservation('action-A', {
        version: 1,
        kind: 'cancelled-unsubmitted',
        preparedHash: hash(value.prepared),
        cancellation: { kind: 'unsubmitted', at: 1234 },
      }),
    /host-task/
  )
  assert.deepEqual(f.rows(), before)
})

test('owned streaming projection survives constructor and rejects same-ID legacy writer bypasses', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.store.commitHostTaskObservation('action-A', host())
  assert.equal(f.store.get('assistant-A')?.status, 'streaming')
  const before = f.rows()
  f.reopen()
  assert.deepEqual(f.rows(), before)
  assert.throws(() => f.store.update('assistant-A', { text: 'Bypass', steps: [], status: 'completed' }), /host-task/)
  assert.throws(
    () =>
      f.store.persistHostRun(
        {
          jobId: 'job-A',
          messageId: 'assistant-A',
          endpoint: 'tcp://127.0.0.1:1',
          phase: 'completed',
          connection: 'connected',
          cursor: 9,
        },
        { text: 'Bypass', steps: [], status: 'completed' }
      ),
    /host-task/
  )
  assert.throws(
    () =>
      f.store.recordHostTaskOutcome('action-A', {
        version: 1,
        status: 'completed',
        response: 'Bypass',
        steps: [],
        completedAt: 2000,
        durationMs: 1,
      }),
    /host-task/
  )
  assert.throws(
    () =>
      f.store.setRemoteRun({
        messageId: 'assistant-A',
        computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47832', workspace: '/private/tmp/work' },
        threadId: 'other',
        turnId: null,
        previousTurnId: null,
      }),
    /host-task/
  )
  assert.throws(() => f.store.start('', 'codex', 'assistant-A'), /not-retryable/)
  assert.deepEqual(f.rows(), before)
})

test('cursor/content conflicts and missing or reordered earlier steps do not partially advance', (t) => {
  const f = fixture(t)
  f.create('A', true)
  const first = host()
  f.store.commitHostTaskObservation('action-A', first)
  const before = f.rows()
  assert.throws(
    () =>
      f.store.commitHostTaskObservation('action-A', {
        ...first,
        delivery: { kind: 'content', response: 'Different', steps: [step] },
      }),
    /host-task/
  )
  assert.throws(() => f.store.commitHostTaskObservation('action-A', { ...first, cursor: 0 }), /host-task/)
  for (const steps of [[], [{ ...step, at: 101 }], [{ id: 'new', kind: 'status', at: 101, text: 'new' }, step]]) {
    assert.throws(
      () =>
        f.store.commitHostTaskObservation('action-A', {
          ...first,
          cursor: 2,
          delivery: { kind: 'content', response: 'Next', steps },
        }),
      /host-task/
    )
  }
  assert.deepEqual(f.rows(), before)
  f.store.commitHostTaskObservation('action-A', {
    ...first,
    cursor: 2,
    delivery: { kind: 'content', response: 'Next', steps: [{ ...step, text: 'Updated nonterminal' }] },
  })
  assert.equal(f.store.get('assistant-A')?.steps[0]?.text, 'Updated nonterminal')
})

test('terminal host offset and stable local receipt survive later cursor/session without resampling', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.store.commitHostTaskObservation('action-A', host())
  const terminal = host('A', 'completed', 2)
  const done = f.store.commitHostTaskObservation('action-A', terminal)
  assert.equal(done.terminalReceivedAt, 2000)
  assert.equal(done.terminal?.hostTerminalAt, 3600100)
  assert.equal(done.intent.outcome?.completedAt, 2000)
  assert.equal(done.intent.outcome?.durationMs, 100)
  const outcome = f.store.getHostTaskIntent('action-A')?.outcome
  const outcomeRow = f.read('SELECT outcome_json,outcome_hash FROM assistant_task_run')
  const message = f.store.get('assistant-A')
  const samples = f.samples
  f.time(0)
  assert.deepEqual(f.store.commitHostTaskObservation('action-A', terminal), done)
  f.reopen()
  f.store.commitHostTaskObservation('action-A', { ...terminal, coordinatorSessionId: 'host-session-2', cursor: 10 })
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.outcome, outcome)
  assert.deepEqual(f.read('SELECT outcome_json,outcome_hash FROM assistant_task_run'), outcomeRow)
  assert.deepEqual(f.store.get('assistant-A'), message)
  assert.equal(f.samples, samples)
  assert.throws(
    () =>
      f.store.commitHostTaskObservation('action-A', {
        ...terminal,
        cursor: 11,
        job: { ...terminal.job, updatedAt: 3600101 },
      }),
    /host-task/
  )
  assert.throws(
    () =>
      f.store.commitHostTaskObservation('action-A', {
        ...terminal,
        cursor: 11,
        delivery: { kind: 'content', response: 'Final synthetic answer', steps: [] },
      }),
    /host-task/
  )
})

test('new terminal local clock regression is explicit and rolls back, not clamped', (t) => {
  const f = fixture(t)
  f.create('A', true)
  const before = f.rows()
  f.time(999)
  assert.throws(
    () => f.store.commitHostTaskObservation('action-A', host('A', 'completed')),
    /host-task-received-at-invalid/
  )
  assert.deepEqual(f.rows(), before)
})

test('new cursor or coordinator session cannot substitute established host identity or rewind to pre-start', (t) => {
  const f = fixture(t)
  f.create('A', true)
  const running = host()
  f.store.commitHostTaskObservation('action-A', running)
  const before = f.rows()
  for (const patch of [
    { createdAt: running.job.createdAt + 1 },
    { threadId: 'other-thread' },
    { turnId: 'other-turn' },
    { phase: 'thread-start-intent', threadId: null, turnId: null },
    { phase: 'thread-bound', turnId: null },
    { updatedAt: running.job.updatedAt - 1 },
  ]) {
    assert.throws(
      () =>
        f.store.commitHostTaskObservation('action-A', {
          ...running,
          cursor: 2,
          coordinatorSessionId: 'new-host-session',
          job: { ...running.job, ...patch },
        }),
      /host-task/
    )
  }
  assert.deepEqual(f.rows(), before)
})

test('completed-withheld stores only terminal metadata and can release exact content on same cursor', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.store.commitHostTaskObservation('action-A', host())
  const complete = host('A', 'completed', 2)
  const withheld = { ...complete, delivery: { kind: 'withheld', reason: 'context-unavailable' } }
  const result = f.store.commitHostTaskObservation('action-A', withheld)
  assert.equal(result.state, 'completed')
  assert.equal(result.intent.outcome, null)
  assert.equal(f.store.get('assistant-A')?.text, 'Progress')
  assert.equal(f.store.get('assistant-A')?.status, 'interrupted')
  assert(!JSON.stringify(f.rows()).includes('Final synthetic answer'))
  const samples = f.samples
  f.time(3000)
  f.store.commitHostTaskObservation('action-A', complete)
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome?.completedAt, 2000)
  assert.equal(f.samples, samples)
})

test('invalidated content never enters storage; confirmed empty Stop is sanitized with expiry priority', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.store.commitHostTaskObservation('action-A', host())
  f.store.resetContext()
  const before = f.rows()
  assert.throws(() => f.store.commitHostTaskObservation('action-A', host('A', 'completed', 2)), /context-invalidated/)
  assert.deepEqual(f.rows(), before)
  const stopped = host('A', 'stopped', 2)
  stopped.job.stopReason = 'request-expired'
  f.store.commitHostTaskObservation('action-A', stopped)
  assert.equal(f.store.get('assistant-A')?.error, 'assistant-host-request-expired')
  assert.equal(f.store.get('assistant-A')?.text, '')
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.outcome?.steps, [])
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome?.status, 'stopped')
})

test('invalidated completed-withheld stays completed metadata without private outcome or Stop', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.store.resetContext()
  const complete = host('A', 'completed')
  f.store.commitHostTaskObservation('action-A', {
    ...complete,
    delivery: { kind: 'withheld', reason: 'context-invalidated' },
  })
  assert.equal(f.store.hostTaskExecution('action-A')?.state, 'completed')
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome, null)
  assert.throws(() => f.store.commitHostTaskObservation('action-A', complete), /context-invalidated/)
  assert.throws(() => f.store.commitHostTaskObservation('action-A', host('A', 'stopped', 2)), /host-task/)
  assert(!JSON.stringify(f.rows()).includes('Final synthetic answer'))
})

for (const table of ['assistant_task_execution', 'assistant_message', 'assistant_task_run']) {
  for (const fault of ['ABORT', 'IGNORE'])
    test(`observation transaction rolls back when ${table} update ${fault}s`, (t) => {
      const f = fixture(t)
      f.create('A', true)
      f.store.commitHostTaskObservation('action-A', host())
      const before = f.rows()
      f.exec(
        `CREATE TRIGGER fault BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'synthetic-observation-fault'" : ''}); END`
      )
      assert.throws(() => f.store.commitHostTaskObservation('action-A', host('A', 'completed', 2)))
      assert.deepEqual(f.rows(), before)
      f.exec('DROP TRIGGER fault')
      f.reopen()
      assert.deepEqual(f.rows(), before)
    })
}

test('A saved receipt atomically advances A only, preserving B/global/original reference and exact replay', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.create('B', true)
  f.store.recordMemorySources([{ ...source }])
  f.claim()
  f.store.finishToolCall('call-A', saved, { actionId: 'action-A', expectedRevision: 'r1' })
  assert.deepEqual(f.store.taskMemorySources('action-A'), [{ ...source, revision: 'r2' }])
  assert.deepEqual(f.store.taskMemorySources('action-B'), [source])
  assert.deepEqual(f.store.memorySources(), [source])
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.envelope.sources, [source])
  assert.equal(f.store.hostTaskResults('action-A').length, 1)
  assert.equal(f.store.hostTaskResults('action-B').length, 0)
  const before = f.rows()
  f.reopen()
  f.store.finishToolCall('call-A', saved, { actionId: 'action-A', expectedRevision: 'r1' })
  assert.deepEqual(f.rows(), before)
  assert.throws(() => f.store.recordTaskMemorySources('action-B', [{ ...source, revision: 'r2' }]), /host-task/)
})

test('source reads have exact revision and explicitness, current action scope and invalidation guard', (t) => {
  const f = fixture(t)
  f.create('A')
  f.create('B')
  const next = { ...source, slug: 'second', explicit: false }
  f.store.recordTaskMemorySources('action-A', [next])
  assert.equal(f.store.taskMemorySources('action-A').length, 2)
  assert.deepEqual(f.store.taskMemorySources('action-B'), [source])
  assert.throws(() => f.store.recordTaskMemorySources('action-A', [{ ...source, explicit: false }]), /host-task/)
  assert.throws(() => f.store.recordTaskMemorySources('action-A', [{ ...next, explicit: true }]), /host-task/)
  const before = f.rows()
  assert.throws(
    () =>
      f.store.recordTaskMemorySources('action-A', [
        { ...source, slug: 'third' },
        { ...source, revision: 'changed' },
      ]),
    /host-task/
  )
  assert.deepEqual(f.rows(), before)
  f.store.resetContext()
  assert.throws(() => f.store.recordTaskMemorySources('action-A', [source]), /context-invalidated/)
})

test('wrong binding, stale or non-saved receipts cannot advance a prepared source or publish a saved result', (t) => {
  const f = fixture(t)
  f.create('A')
  f.create('B')
  assert.throws(
    () => f.store.claimToolCall('wrong', 'hash', { messageId: 'assistant-A', toolName: 'remember_memory' }),
    /host-task/
  )
  assert.throws(
    () =>
      f.store.claimToolCall('wrong', 'hash', {
        actionId: 'action-B',
        messageId: 'assistant-A',
        toolName: 'remember_memory',
      }),
    /host-task/
  )
  f.claim()
  for (const options of [
    undefined,
    { actionId: 'action-B', expectedRevision: 'r1' },
    { actionId: 'action-A', expectedRevision: 'stale' },
  ]) {
    assert.throws(() => f.store.finishToolCall('call-A', saved, options), /host-task|source/)
  }
  for (const [index, result] of [
    { saved: false, reason: 'declined' },
    { saved: false, proposed: true },
    { saved: false, error: 'uncertain' },
  ].entries()) {
    f.claim('A', `non-saved-${index}`)
    f.store.finishToolCall(`non-saved-${index}`, result)
  }
  assert.deepEqual(f.store.taskMemorySources('action-A'), [source])
  assert.equal(f.store.hostTaskResults('action-A').length, 0)
})

for (const table of ['assistant_tool_call', 'assistant_task_memory_source']) {
  for (const fault of ['ABORT', 'IGNORE'])
    test(`saved receipt/source rollback on ${table} ${fault}`, (t) => {
      const f = fixture(t)
      f.create()
      f.claim()
      const before = f.rows()
      f.exec(
        `CREATE TRIGGER fault BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(${fault}${fault === 'ABORT' ? ", 'synthetic-source-fault'" : ''}); END`
      )
      assert.throws(() => f.store.finishToolCall('call-A', saved, { actionId: 'action-A', expectedRevision: 'r1' }))
      assert.deepEqual(f.rows(), before)
    })
}

test('terminal prepared action invalidation blocks late new receipts but preserves exact historical duplicates', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.claim('A', 'early')
  f.claim('A', 'late')
  f.store.finishToolCall('early', saved, { actionId: 'action-A', expectedRevision: 'r1' })
  const terminal = host('A', 'completed')
  f.store.commitHostTaskObservation('action-A', terminal)
  const outcome = f.store.getHostTaskIntent('action-A')?.outcome
  const message = f.store.get('assistant-A')
  f.store.resetContext()
  f.store.synchronizePolicy('new-policy')
  assert.equal(f.store.getHostTaskIntent('action-A')?.invalidated, true)
  const before = f.rows()
  f.store.finishToolCall('early', saved, { actionId: 'action-A', expectedRevision: 'r1' })
  f.store.commitHostTaskObservation('action-A', terminal)
  assert.throws(
    () =>
      f.store.finishToolCall('late', { ...saved, revision: 'r3' }, { actionId: 'action-A', expectedRevision: 'r2' }),
    /context-invalidated/
  )
  assert.throws(() => f.claim('A', 'new'), /host-task/)
  assert.deepEqual(f.rows(), before)
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.outcome, outcome)
  assert.deepEqual(f.store.get('assistant-A'), message)
})

test('legacy chat and unprepared intent remain usable without new execution rows', (t) => {
  const f = fixture(t)
  const chat = f.store.start('Legacy', 'codex')
  f.store.update(chat.id, { text: 'Legacy answer', steps: [], status: 'completed' })
  f.store.createHostTaskIntent(input().envelope)
  assert.equal(f.store.get(chat.id)?.text, 'Legacy answer')
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome, null)
})

test('prepared duplicate tool claims require exact action and message even for a persisted result', (t) => {
  const f = fixture(t)
  f.create()
  f.claim()
  f.store.finishToolCall('call-A', saved, { actionId: 'action-A', expectedRevision: 'r1' })
  const before = f.rows()
  assert.throws(() => f.store.claimToolCall('call-A', 'hash-call-A'), /host-task-tool-binding-conflict/)
  assert.throws(
    () => f.store.claimToolCall('call-A', 'hash-call-A', { messageId: 'assistant-A', toolName: 'remember_memory' }),
    /host-task-tool-binding-conflict/
  )
  assert.deepEqual(f.claim(), { existing: true, result: saved })
  assert.deepEqual(f.rows(), before)
  f.store.claimToolCall('legacy-call', 'legacy-hash')
  f.store.finishToolCall('legacy-call', { legacy: true })
  assert.deepEqual(f.store.claimToolCall('legacy-call', 'legacy-hash'), { existing: true, result: { legacy: true } })
})

test('host recovery-required cannot resume an active or pre-start phase on a newer cursor', (t) => {
  const f = fixture(t)
  f.create('A', true)
  f.store.commitHostTaskObservation('action-A', host('A', 'recovery-required'))
  const before = f.rows()
  for (const phase of ['running', 'waiting'] as const) {
    const next = host('A', phase, 2)
    next.job.updatedAt = 3600200
    assert.throws(() => f.store.commitHostTaskObservation('action-A', next), /host-task-host-phase-regression/)
    assert.deepEqual(f.rows(), before)
  }
  f.store.commitHostTaskObservation('action-A', host('A', 'completed', 2))
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome?.status, 'completed')
})

test('legacy message writer cannot rewrite the immutable prepared user instruction', (t) => {
  const f = fixture(t)
  f.create()
  const before = f.rows()
  assert.throws(
    () => f.store.update('user-A', { text: 'Different instruction', steps: [], status: 'completed' }),
    /host-task-execution-owned/
  )
  assert.deepEqual(f.rows(), before)
})

for (const receipt of ['session', 'outcome'] as const) {
  test(`prepared ${receipt} acknowledgement rejects an ignored write`, (t) => {
    const f = fixture(t)
    const value = input()
    f.store.createPreparedHostTaskIntent(value.envelope, value.prepared)
    if (receipt === 'outcome') {
      f.create('A', true)
      f.store.commitHostTaskObservation('action-A', host('A', 'completed'))
    }
    const before = f.rows()
    f.exec('CREATE TRIGGER fault BEFORE UPDATE ON assistant_task_run BEGIN SELECT RAISE(IGNORE); END')
    const sessionReceipt = hostTaskSessionReceipt(value.envelope)
    assert.throws(
      () =>
        receipt === 'session'
          ? f.store.acknowledgeHostTaskSession('action-A', sessionReceipt)
          : f.store.acknowledgeHostTaskOutcome('action-A', {
              ...sessionReceipt,
              outcomeHash: hash(f.store.getHostTaskIntent('action-A')?.outcome),
              projection: 'applied',
            }),
      /host-task-write-not-persisted/
    )
    assert.deepEqual(f.rows(), before)
  })
}

test('prepared invalidation cannot report success while an ignored write leaves permission active', (t) => {
  const f = fixture(t)
  f.create()
  const before = f.rows()
  f.exec('CREATE TRIGGER fault BEFORE UPDATE ON assistant_task_run BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => f.store.resetContext(), /host-task-write-not-persisted/)
  assert.deepEqual(f.rows(), before)
  f.exec('DROP TRIGGER fault')
  f.store.resetContext()
  assert.equal(f.store.getHostTaskIntent('action-A')?.invalidated, true)
})

test('same-cursor terminal replay permits only a new coordinator session without resampling', (t) => {
  const f = fixture(t)
  f.create('A', true)
  const terminal = host('A', 'completed')
  f.store.commitHostTaskObservation('action-A', terminal)
  const outcome = f.store.getHostTaskIntent('action-A')?.outcome
  const message = f.store.get('assistant-A')
  const samples = f.samples
  f.time(0)
  f.store.commitHostTaskObservation('action-A', { ...terminal, coordinatorSessionId: 'host-session-2' })
  assert.equal(f.samples, samples)
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.outcome, outcome)
  assert.deepEqual(f.store.get('assistant-A'), message)
  const changed = structuredClone(terminal)
  changed.coordinatorSessionId = 'host-session-3'
  if (changed.delivery.kind === 'content') changed.delivery.steps[0] = { ...step, text: 'Changed' }
  assert.throws(() => f.store.commitHostTaskObservation('action-A', changed), /host-task/)
})

test('withheld context-invalidated hint requires the durable intent latch first', (t) => {
  const f = fixture(t)
  f.create('A', true)
  const withheld = { ...host('A', 'completed'), delivery: { kind: 'withheld', reason: 'context-invalidated' } }
  const before = f.rows()
  assert.throws(() => f.store.commitHostTaskObservation('action-A', withheld), /host-task-invalidation-required/)
  assert.deepEqual(f.rows(), before)
  f.store.resetContext()
  f.store.commitHostTaskObservation('action-A', withheld)
  assert.equal(f.store.hostTaskExecution('action-A')?.state, 'completed')
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome, null)
})
