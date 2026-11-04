import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type TestContext, test } from 'node:test'
import type { WorkItem } from '@remember/shared'
import type { HostTaskEnvelopeV1, HostTaskOutcome } from '../../hostTaskProtocol'
import { EvidenceStore } from '../evidenceStore'

function fixture(t: TestContext) {
  const directory = mkdtempSync('/private/tmp/remember-host-task-')
  const path = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(path)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    get store() {
      return store
    },
    read<T>(sql: string): T[] {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        return db
          .prepare(sql)
          .all()
          .map((row) => ({ ...row })) as T[]
      } finally {
        db.close()
      }
    },
    sql(sql: string) {
      const db = new DatabaseSync(path)
      try {
        db.exec('PRAGMA foreign_keys=ON')
        db.exec(sql)
      } finally {
        db.close()
      }
    },
    reopen() {
      store.close()
      store = new EvidenceStore(path)
    },
  }
}

function envelope(item: WorkItem, suffix = 'a'): HostTaskEnvelopeV1 {
  return {
    version: 1,
    actionId: `action-${suffix}`,
    workItemId: item.id,
    sessionId: `session-${suffix}`,
    jobId: `job-${suffix}`,
    userMessageId: `user-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    provider: 'codex',
    instruction: 'Prepare the comparison; do not complete the task.',
    preparedInput: {
      prompt: 'Synthetic bounded comparison context',
      systemPrompt: 'Return a comparison only.',
      model: 'fake-model',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: '/private/tmp/remember-host-task-workspace',
    },
    targetId: 'synthetic-local-host',
    taskDefinition: {
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
          ...source,
          conversationReference: source.conversationReference ?? null,
          conversationActionId: source.conversationActionId ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    },
    policyFingerprint: 'synthetic-permitted-policy',
    sources: [],
    startedAt: 1_800_000_000_000,
  }
}

function outcome(status: 'completed' | 'stopped' = 'completed'): HostTaskOutcome {
  return {
    version: 1,
    status,
    response:
      'Done.\n```remember-task-update\n{"summary":"overwrite","remaining":"none","nextStep":"none","needsUser":true}\n```',
    steps: [{ id: 'step-a', kind: 'status', text: 'Compared two synthetic options.', at: 1_800_000_000_010 }],
    completedAt: 1_800_000_000_100,
    durationMs: 100,
  }
}

function taskFields(item: WorkItem) {
  const { agentSessions: _sessions, facts: _facts, ...fields } = item
  return fields
}

function counts(f: ReturnType<typeof fixture>) {
  return f.read<{ sessions: number; facts: number; receipts: number }>(
    `SELECT (SELECT count(*) FROM work_item_agent_session) sessions,
      (SELECT count(*) FROM work_item_fact WHERE type LIKE 'agent_%') facts,
      (SELECT count(*) FROM work_item_host_receipt) receipts`
  )[0]
}

test('host receipt atomically preserves exact metadata and is unchanged on repeat or store reopen', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Compare options', 'Keep the human decision open.')
  const input = envelope(item)
  const receipt = f.store.acceptHostTaskSession(input)
  assert.deepEqual(receipt, {
    version: 1,
    actionId: input.actionId,
    envelopeHash: receipt.envelopeHash,
    workItemId: item.id,
    sessionId: input.sessionId,
    jobId: input.jobId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
  })
  assert.match(receipt.envelopeHash, /^[a-f0-9]{64}$/)
  const accepted = f.store.getWorkItem(item.id)
  assert.ok(accepted)
  assert.deepEqual(taskFields(accepted), taskFields(item))
  assert.equal(accepted.agentSessions[0]?.instruction, input.preparedInput.prompt)
  assert.equal(accepted.agentSessions[0]?.message, input.instruction)
  assert.deepEqual(f.store.acceptHostTaskSession(input), receipt)
  assert.deepEqual(f.store.hostTaskReceipt(input.actionId), receipt)
  f.reopen()
  assert.deepEqual(f.store.acceptHostTaskSession(input), receipt)
  assert.deepEqual(f.store.getWorkItem(item.id), accepted)
  assert.deepEqual(counts(f), { sessions: 1, facts: 1, receipts: 1 })
  assert.deepEqual(f.store.validateHostTaskForDispatch(input.actionId, receipt.envelopeHash), { state: 'current' })
})

test('first receipt rejects edited, closed and physically deleted fixture tasks without inserting metadata', (t) => {
  const f = fixture(t)
  const edited = f.store.createWorkItem('Original', 'Original definition')
  const closed = f.store.createWorkItem('Closed', 'Original definition')
  const deleted = f.store.createWorkItem('Deleted', 'Explicit SQL deletion fixture, no product delete path')
  const inputs = [envelope(edited), envelope(closed, 'b'), envelope(deleted, 'c')]
  f.store.updateWorkItem(edited.id, 'Changed', edited.description)
  f.store.setWorkItemLifecycle(closed.id, 'completed')
  f.sql(`DELETE FROM work_item WHERE id='${deleted.id}'`)
  assert.throws(() => f.store.acceptHostTaskSession(inputs[0]), /host-task-definition-changed/)
  assert.throws(() => f.store.acceptHostTaskSession(inputs[1]), /host-task-not-open/)
  assert.throws(() => f.store.acceptHostTaskSession(inputs[2]), /work-item-not-found/)
  assert.deepEqual(counts(f), { sessions: 0, facts: 0, receipts: 0 })
})

test('receipt proves historical delivery only; current definition changes invalidate dispatch without rebasing', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Original', 'Original')
  const input = envelope(item)
  const receipt = f.store.acceptHostTaskSession(input)
  f.store.updateWorkItemMetadata(item.id, { status: 'in_progress', priority: 'high', dueAt: 1_900_000_000_000 })
  assert.deepEqual(f.store.validateHostTaskForDispatch(input.actionId, receipt.envelopeHash), { state: 'changed' })
  assert.deepEqual(f.store.acceptHostTaskSession(input), receipt)
  f.store.setWorkItemLifecycle(item.id, 'completed')
  assert.deepEqual(f.store.validateHostTaskForDispatch(input.actionId, receipt.envelopeHash), { state: 'closed' })
  f.sql(`DELETE FROM work_item WHERE id='${item.id}'`)
  f.reopen()
  assert.deepEqual(f.store.validateHostTaskForDispatch(input.actionId, receipt.envelopeHash), { state: 'missing' })
  assert.deepEqual(f.store.acceptHostTaskSession(input), receipt)
  assert.equal(f.store.getWorkItem(item.id), null)
})

test('all immutable binding/input differences reject without rebinding either task', (t) => {
  const f = fixture(t)
  const a = f.store.createWorkItem('A', 'Original')
  const b = f.store.createWorkItem('B', 'Original')
  const input = envelope(a)
  f.store.acceptHostTaskSession(input)
  const different = [
    { ...input, startedAt: input.startedAt + 1 },
    { ...input, instruction: 'Changed instruction' },
    { ...input, targetId: 'another-target' },
    { ...input, preparedInput: { ...input.preparedInput, prompt: 'Changed prepared input' } },
    { ...input, policyFingerprint: 'different-policy' },
    { ...envelope(b, 'b'), actionId: input.actionId },
    ...(['sessionId', 'jobId', 'userMessageId', 'assistantMessageId'] as const).map((key) => ({
      ...envelope(b, 'b'),
      [key]: input[key],
    })),
    { ...envelope(b, 'b'), userMessageId: input.assistantMessageId },
    { ...envelope(b, 'b'), assistantMessageId: input.userMessageId },
  ]
  for (const conflicting of different) {
    assert.throws(() => f.store.acceptHostTaskSession(conflicting), /host-task-binding-conflict/)
  }
  assert.deepEqual(counts(f), { sessions: 1, facts: 1, receipts: 1 })
  assert.equal(f.store.getWorkItem(b.id)?.agentSessions.length, 0)
})

test('host ownership and receipt rollback with started fact failure', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Atomic', 'Fixture transaction failure')
  const input = envelope(item)
  f.sql(`CREATE TRIGGER fail_host_start BEFORE INSERT ON work_item_fact WHEN NEW.type='agent_started'
    BEGIN SELECT RAISE(ABORT, 'synthetic-start-failure'); END`)
  assert.throws(() => f.store.acceptHostTaskSession(input), /synthetic-start-failure/)
  assert.deepEqual(counts(f), { sessions: 0, facts: 0, receipts: 0 })
  f.sql('DROP TRIGGER fail_host_start')
  f.store.acceptHostTaskSession(input)
  assert.deepEqual(counts(f), { sessions: 1, facts: 1, receipts: 1 })
})

test('constructor preserves owned host running session while recovering legacy local running session', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Hosted', 'Original')
  const local = f.store.createWorkItem('Local', 'Original')
  f.store.acceptHostTaskSession(envelope(item))
  f.store.startWorkItemAgentSession(local.id, {
    sessionId: 'local-session',
    provider: 'codex',
    prompt: 'local',
    message: '',
    startedAt: 1000,
  })
  f.reopen()
  assert.equal(f.store.getWorkItem(item.id)?.agentSessions[0]?.status, 'running')
  assert.equal(f.store.getWorkItem(local.id)?.agentSessions[0]?.status, 'stale')
  assert.equal(f.store.getWorkItem(item.id)?.facts.filter((fact) => fact.type === 'agent_failed').length, 0)
})

test('all legacy writers reject owned sessions, including completed shortcut and cross-task record upsert', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Hosted', 'Original')
  const other = f.store.createWorkItem('Other', 'Original')
  const input = envelope(item)
  f.store.acceptHostTaskSession(input)
  const legacy = {
    sessionId: input.sessionId,
    provider: 'codex' as const,
    prompt: 'legacy',
    message: '',
    startedAt: input.startedAt,
  }
  const writes = () => [
    () => f.store.startWorkItemAgentSession(item.id, legacy),
    () => f.store.recordWorkItemAgentSession(item.id, { ...legacy, response: 'overwrite', durationMs: 100, steps: [] }),
    () =>
      f.store.recordWorkItemAgentSession(other.id, {
        ...legacy,
        response: 'cross-task overwrite',
        durationMs: 100,
        steps: [],
      }),
    () =>
      f.store.finishWorkItemAgentSession(item.id, input.sessionId, {
        response: 'overwrite',
        durationMs: 100,
        steps: [],
      }),
    () => f.store.failWorkItemAgentSession(item.id, input.sessionId),
  ]
  for (const write of writes()) assert.throws(write, /host-task-session-owned/)
  f.store.applyHostTaskOutcome(input, outcome())
  const completed = f.store.getWorkItem(item.id)
  for (const write of writes()) assert.throws(write, /host-task-session-owned/)
  assert.deepEqual(f.store.getWorkItem(item.id), completed)
  assert.equal(f.store.getWorkItem(other.id)?.agentSessions.length, 0)
})

test('terminal receipt is exact/idempotent across reopen and never interprets response as task mutation', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Keep open', 'Human decision remains')
  const input = envelope(item)
  f.store.acceptHostTaskSession(input)
  const receipt = f.store.applyHostTaskOutcome(input, outcome())
  const completed = f.store.getWorkItem(item.id)
  assert.ok(completed)
  assert.equal(receipt.projection, 'applied')
  assert.equal(completed.agentSessions[0]?.status, 'completed')
  assert.equal(completed.agentSessions[0]?.response, outcome().response)
  assert.deepEqual(taskFields(completed), taskFields(item))
  f.reopen()
  assert.deepEqual(f.store.applyHostTaskOutcome(input, outcome()), receipt)
  assert.deepEqual(f.store.getWorkItem(item.id), completed)
  for (const changed of [
    { ...outcome(), response: 'changed' },
    outcome('stopped'),
    { ...outcome(), completedAt: outcome().completedAt + 1 },
  ]) {
    assert.throws(() => f.store.applyHostTaskOutcome(input, changed), /host-task-outcome-conflict/)
  }
  assert.deepEqual(counts(f), { sessions: 1, facts: 2, receipts: 1 })
})

test('stopped host session never becomes completed and late A cannot change active B or edited/closed Task', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Original', 'Original')
  const a = envelope(item)
  const b = envelope(item, 'b')
  f.store.acceptHostTaskSession(a)
  f.store.acceptHostTaskSession(b)
  f.store.updateWorkItem(item.id, 'Human edit', 'Retain this description')
  f.store.setWorkItemLifecycle(item.id, 'abandoned')
  const before = f.store.getWorkItem(item.id)
  assert.ok(before)
  const receipt = f.store.applyHostTaskOutcome(a, outcome('stopped'))
  assert.equal(receipt.projection, 'applied')
  const after = f.store.getWorkItem(item.id)
  assert.ok(after)
  assert.deepEqual(taskFields(after), taskFields(before))
  assert.equal(after.agentSessions.find((s) => s.id === a.sessionId)?.status, 'cancelled')
  assert.equal(after.agentSessions.find((s) => s.id === b.sessionId)?.status, 'running')
  assert.throws(() => f.store.applyHostTaskOutcome(a, outcome()), /host-task-outcome-conflict/)
})

test('terminal projection after explicit SQL Task deletion preserves orphan receipt and never recreates Task/session', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Deleted later', 'SQL fixture only')
  const input = envelope(item)
  const start = f.store.acceptHostTaskSession(input)
  f.sql(`DELETE FROM work_item WHERE id='${item.id}'`)
  f.reopen()
  const receipt = f.store.applyHostTaskOutcome(input, outcome())
  assert.equal(receipt.projection, 'orphaned')
  assert.equal(receipt.envelopeHash, start.envelopeHash)
  assert.equal(f.store.getWorkItem(item.id), null)
  assert.deepEqual(counts(f), { sessions: 0, facts: 0, receipts: 1 })
  f.reopen()
  assert.deepEqual(f.store.applyHostTaskOutcome(input, outcome()), receipt)
})

test('outcome/fact/session rollback together and wrong envelope cannot finish existing session', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Atomic finish', 'Original')
  const input = envelope(item)
  f.store.acceptHostTaskSession(input)
  f.sql(`CREATE TRIGGER fail_host_finish BEFORE INSERT ON work_item_fact WHEN NEW.type='agent_completed'
    BEGIN SELECT RAISE(ABORT, 'synthetic-finish-failure'); END`)
  assert.throws(() => f.store.applyHostTaskOutcome(input, outcome()), /synthetic-finish-failure/)
  assert.equal(f.store.getWorkItem(item.id)?.agentSessions[0]?.status, 'running')
  assert.deepEqual(counts(f), { sessions: 1, facts: 1, receipts: 1 })
  f.sql('DROP TRIGGER fail_host_finish')
  assert.throws(
    () => f.store.applyHostTaskOutcome({ ...input, instruction: 'conflict' }, outcome()),
    /host-task-binding-conflict/
  )
  f.store.applyHostTaskOutcome(input, outcome())
  assert.deepEqual(counts(f), { sessions: 1, facts: 2, receipts: 1 })
})

test('actual conversation writer source identities remain compatible with host task receipts', (t) => {
  const f = fixture(t)
  f.store.synchronizeConversationActionPoints({
    workdayId: 'synthetic-conversation-day',
    conversations: [
      {
        episodeId: 'synthetic-conversation',
        startTime: '09:00',
        endTime: '09:30',
        title: 'Synthetic discussion',
        description: 'One human commitment.',
        actionPoints: ['Compare the release options'],
      },
    ],
    observedAt: 1000,
  })
  const item = f.store.listWorkItems()[0]
  assert.ok(item)
  assert.equal(item.sources[0]?.kind, 'meeting')
  assert.match(item.sources[0]?.id ?? '', /:/)
  const input = envelope(item)
  const receipt = f.store.acceptHostTaskSession(input)
  f.reopen()
  assert.deepEqual(f.store.acceptHostTaskSession(input), receipt)
  assert.deepEqual(f.store.validateHostTaskForDispatch(input.actionId, receipt.envelopeHash), { state: 'current' })
})

test('derived legacy session/attention changes do not invalidate definition; existing local session cannot be adopted', (t) => {
  const f = fixture(t)
  const item = f.store.createWorkItem('Original', 'Original')
  const input = envelope(item)
  const receipt = f.store.acceptHostTaskSession(input)
  f.store.startWorkItemAgentSession(item.id, {
    sessionId: 'legacy-another',
    provider: 'codex',
    prompt: 'local',
    message: '',
    startedAt: input.startedAt + 1,
  })
  assert.deepEqual(f.store.validateHostTaskForDispatch(input.actionId, receipt.envelopeHash), { state: 'current' })
  assert.throws(
    () => f.store.acceptHostTaskSession({ ...envelope(item, 'b'), sessionId: 'legacy-another' }),
    /host-task-binding-conflict/
  )
  assert.throws(() => f.store.applyHostTaskOutcome(envelope(item, 'missing'), outcome()), /host-task-receipt-not-found/)
  assert.throws(
    () => f.store.applyHostTaskOutcome(input, { ...outcome(), completedAt: input.startedAt - 1 }),
    /host-task-invalid-data/
  )
})
