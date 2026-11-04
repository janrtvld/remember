import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ResidentAgentStore, type SavedMemoryReceipt } from '../residentAgentStore'

function envelope(id = 'A') {
  return {
    version: 1,
    actionId: `action-${id}`,
    workItemId: `task-${id}`,
    sessionId: `session-${id}`,
    jobId: `job-${id}`,
    userMessageId: `user-${id}`,
    assistantMessageId: `assistant-${id}`,
    provider: 'codex',
    instruction: `Draft the update for ${id}.`,
    preparedInput: {
      prompt: `Exact task ${id} context`,
      systemPrompt: 'Explicit synthetic instruction only',
      model: 'gpt-5.2',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: `/private/tmp/remember-e072-${id}/workspace`,
    },
    targetId: 'mini-1',
    policyFingerprint: 'current-policy',
    sources: [{ spaceId: 'personal', slug: 'decision', revision: 'r1', explicit: true }],
    taskDefinition: {
      version: 1,
      id: `task-${id}`,
      title: `Task ${id}`,
      description: 'A user-owned obligation',
      prompt: 'Prepare a draft',
      aiSuggestion: null,
      context: 'Synthetic context',
      returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
      lifecycle: 'open',
      status: 'todo',
      priority: 'none',
      dueAt: null,
      sources: [],
    },
    startedAt: 1792700000000,
  }
}
function outcome(status: 'completed' | 'stopped' = 'completed') {
  return {
    version: 1,
    status,
    response: 'Done. This does not complete the human task.',
    steps: [{ id: 'step-1', kind: 'status', text: 'Prepared draft', at: 1792700000001 }],
    completedAt: 1792700000100,
    durationMs: 100,
  }
}
function receipt(value: ReturnType<ResidentAgentStore['getHostTaskIntent']>) {
  assert(value)
  const { envelope: e, envelopeHash } = value
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
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-task-intent-'))
  const file = join(directory, 'conversation.sqlite')
  let store = new ResidentAgentStore(file)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    file,
    get store() {
      return store
    },
    reopen() {
      store.close()
      store = new ResidentAgentStore(file)
    },
    read(sql: string) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return JSON.parse(JSON.stringify(db.prepare(sql).all()))
      } finally {
        db.close()
      }
    },
    exec(sql: string) {
      const db = new DatabaseSync(file)
      try {
        db.exec(sql)
      } finally {
        db.close()
      }
    },
  }
}

test('explicit intent atomically owns two messages and stable identities across duplicates and reopen without a host binding', (t) => {
  const f = fixture(t)
  const value = f.store.createHostTaskIntent(envelope())
  assert.deepEqual(value.envelope, envelope())
  assert.equal(value.sessionReceipt, null)
  assert.equal(value.outcome, null)
  assert.equal(value.outcomeReceipt, null)
  assert.equal(value.invalidated, false)
  assert.equal(f.store.hostRun(), null)
  assert.equal(f.store.conversation(null).activeTurnId, null)
  assert.equal(f.store.get('user-A')?.text, envelope().instruction)
  assert.equal(f.store.get('assistant-A')?.status, 'interrupted')
  assert.equal(f.store.get('assistant-A')?.error, 'assistant-host-task-not-submitted')
  const before = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  assert.deepEqual(f.store.createHostTaskIntent(envelope()), value)
  f.reopen()
  assert.deepEqual(f.store.createHostTaskIntent(envelope()), value)
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), before)
  assert.equal(f.read('SELECT * FROM assistant_task_run').length, 1)
  assert.deepEqual(f.read('SELECT * FROM assistant_host_run'), [])
  assert.throws(() => f.store.start('', 'codex', 'assistant-A'), /not-retryable/)
})

test('every changed immutable input or cross-bound action identity rejects without changing messages', (t) => {
  const f = fixture(t)
  f.store.createHostTaskIntent(envelope())
  const before = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  const changes = [
    { instruction: 'Different instruction' },
    { targetId: 'other-computer' },
    { policyFingerprint: 'new-policy' },
    { startedAt: envelope().startedAt + 1 },
    { provider: 'claude' },
    { workItemId: 'other-task' },
    { assistantMessageId: 'other-assistant' },
    { userMessageId: 'other-user' },
    { sessionId: 'other-session' },
    { jobId: 'other-job' },
    { preparedInput: { ...envelope().preparedInput, prompt: 'Different actual provider input' } },
    { sources: [{ ...envelope().sources[0], revision: 'r2' }] },
    { taskDefinition: { ...envelope().taskDefinition, title: 'Edited title' } },
  ]
  for (const change of changes)
    assert.throws(() => f.store.createHostTaskIntent({ ...envelope(), ...change }), /host-task/)
  for (const key of ['sessionId', 'jobId', 'userMessageId', 'assistantMessageId'] as const)
    assert.throws(() => f.store.createHostTaskIntent({ ...envelope('B'), [key]: envelope()[key] }), /host-task/)
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), before)
  assert.equal(f.read('SELECT * FROM assistant_task_run').length, 1)
})

test('intent insertion failure rolls back both exact messages and leaves no half-bound action', (t) => {
  const f = fixture(t)
  f.exec(
    "CREATE TRIGGER reject_task_intent BEFORE INSERT ON assistant_task_run BEGIN SELECT RAISE(ABORT, 'synthetic-intent-failure'); END"
  )
  assert.throws(() => f.store.createHostTaskIntent(envelope()), /synthetic-intent-failure/)
  assert.deepEqual(f.read('SELECT * FROM assistant_message'), [])
  assert.deepEqual(f.read('SELECT * FROM assistant_task_run'), [])
  f.exec('DROP TRIGGER reject_task_intent')
  assert.equal(f.store.createHostTaskIntent(envelope()).envelope.actionId, 'action-A')
})

test('session receipt ACK is exact historical metadata, survives restart, and cannot clear policy invalidation', (t) => {
  const f = fixture(t)
  const created = f.store.createHostTaskIntent(envelope())
  const expected = receipt(created)
  for (const change of [
    { actionId: 'action-B' },
    { sessionId: 'session-B' },
    { envelopeHash: '0'.repeat(64) },
    { jobId: 'job-B' },
    { extra: true },
  ])
    assert.throws(() => f.store.acknowledgeHostTaskSession('action-A', { ...expected, ...change }), /host-task/)
  f.store.resetContext()
  assert.equal(f.store.getHostTaskIntent('action-A')?.invalidated, true)
  f.store.acknowledgeHostTaskSession('action-A', expected)
  const before = f.read('SELECT * FROM assistant_task_run')
  f.reopen()
  f.store.acknowledgeHostTaskSession('action-A', expected)
  assert.deepEqual(f.read('SELECT * FROM assistant_task_run'), before)
  assert.equal(f.store.getHostTaskIntent('action-A')?.invalidated, true)
  assert.equal(f.store.hostRun(), null)
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.sessionReceipt, expected)
})

test('terminal outcome plus exact assistant message commits atomically and conflicting or missing-receipt outcomes reject', (t) => {
  const f = fixture(t)
  const intent = f.store.createHostTaskIntent(envelope())
  assert.throws(() => f.store.recordHostTaskOutcome('action-A', outcome()), /host-task/)
  f.store.acknowledgeHostTaskSession('action-A', receipt(intent))
  const before = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  f.exec(
    "CREATE TRIGGER reject_task_outcome BEFORE UPDATE OF outcome_json ON assistant_task_run BEGIN SELECT RAISE(ABORT, 'synthetic-outcome-failure'); END"
  )
  assert.throws(() => f.store.recordHostTaskOutcome('action-A', outcome()), /synthetic-outcome-failure/)
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), before)
  assert.equal(f.store.getHostTaskIntent('action-A')?.outcome, null)
  f.exec('DROP TRIGGER reject_task_outcome')
  const completed = f.store.recordHostTaskOutcome('action-A', outcome())
  assert.deepEqual(completed.outcome, outcome())
  assert.equal(f.store.get('assistant-A')?.status, 'completed')
  assert.equal(f.store.get('assistant-A')?.text, outcome().response)
  const saved = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  f.reopen()
  f.store.recordHostTaskOutcome('action-A', outcome())
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), saved)
  for (const value of [
    outcome('stopped'),
    { ...outcome(), response: 'Different result' },
    { ...outcome(), completedAt: outcome().completedAt + 1 },
  ])
    assert.throws(() => f.store.recordHostTaskOutcome('action-A', value), /host-task-outcome-conflict/)
})

test('terminal projection ACK is tied to its exact result and retains orphaned history', (t) => {
  const f = fixture(t)
  const intent = f.store.createHostTaskIntent(envelope())
  const sessionReceipt = receipt(intent)
  f.store.acknowledgeHostTaskSession('action-A', sessionReceipt)
  const terminal = f.store.recordHostTaskOutcome('action-A', outcome('stopped'))
  const dbOutcome = f.read('SELECT outcome_hash FROM assistant_task_run')[0]
  const expected = { ...sessionReceipt, outcomeHash: dbOutcome.outcome_hash, projection: 'orphaned' }
  assert.equal(terminal.outcome?.status, 'stopped')
  assert.equal(f.store.get('assistant-A')?.status, 'cancelled')
  for (const change of [{ outcomeHash: '1'.repeat(64) }, { jobId: 'job-B' }, { projection: 'invented' }, { extra: 1 }])
    assert.throws(() => f.store.acknowledgeHostTaskOutcome('action-A', { ...expected, ...change }), /host-task/)
  f.store.acknowledgeHostTaskOutcome('action-A', expected)
  f.reopen()
  f.store.acknowledgeHostTaskOutcome('action-A', expected)
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.outcomeReceipt, expected)
  assert.throws(
    () => f.store.acknowledgeHostTaskOutcome('action-A', { ...expected, projection: 'applied' }),
    /host-task/
  )
  assert.throws(() => f.store.recordHostTaskOutcome('action-A', outcome()), /host-task-outcome-conflict/)
})

test('late A saved receipt stays on original task/action/message while B is current; unknown/proposed/declined never become saved', (t) => {
  const f = fixture(t)
  f.store.createHostTaskIntent(envelope('A'))
  f.store.createHostTaskIntent(envelope('B'))
  const saved: SavedMemoryReceipt = {
    kind: 'saved-page',
    saved: true,
    proposed: false,
    spaceId: 'personal',
    slug: 'result-a',
    revision: 'r2',
    title: 'Actual A result',
  }
  f.store.claimToolCall('call-A', 'hash-A', { messageId: 'assistant-A', toolName: 'remember_memory' })
  f.store.claimToolCall('unknown-A', 'hash-unknown', { messageId: 'assistant-A', toolName: 'remember_memory' })
  f.store.claimToolCall('proposal-A', 'hash-proposal', { messageId: 'assistant-A', toolName: 'remember_memory' })
  f.store.finishToolCall('proposal-A', { saved: false, proposed: true, proposalId: 'proposal-A' })
  f.store.claimToolCall('declined-B', 'hash-declined', { messageId: 'assistant-B', toolName: 'remember_memory' })
  f.store.finishToolCall('declined-B', { saved: false, reason: 'user-declined' })
  f.store.finishToolCall('call-A', saved)
  const expected = [
    {
      id: 'call-A',
      kind: 'saved-page',
      spaceId: 'personal',
      slug: 'result-a',
      revision: 'r2',
      title: 'Actual A result',
    },
  ]
  assert.deepEqual(f.store.hostTaskResults('action-A'), expected)
  assert.deepEqual(f.store.hostTaskResults('action-B'), [])
  assert.throws(
    () => f.store.claimToolCall('call-A', 'hash-A', { messageId: 'assistant-B', toolName: 'remember_memory' }),
    /binding-mismatch/
  )
  f.reopen()
  assert.deepEqual(f.store.hostTaskResults('action-A'), expected)
  assert.deepEqual(f.store.hostTaskResults('action-B'), [])
  assert.equal(f.read("SELECT message_id FROM assistant_tool_call WHERE id='call-A'")[0].message_id, 'assistant-A')
})

test('supplied call bindings cannot borrow an existing other-message or legacy unbound receipt', (t) => {
  const f = fixture(t)
  const a = f.store.start('A', 'codex')
  const b = f.store.start('B', 'codex')
  f.store.claimToolCall('bound', 'hash', { messageId: a.id, toolName: 'remember_memory' })
  assert.throws(
    () => f.store.claimToolCall('bound', 'hash', { messageId: b.id, toolName: 'remember_memory' }),
    /binding-mismatch/
  )
  f.store.claimToolCall('legacy', 'hash')
  assert.throws(
    () => f.store.claimToolCall('legacy', 'hash', { messageId: a.id, toolName: 'remember_memory' }),
    /binding-mismatch/
  )
  assert.deepEqual(f.store.claimToolCall('legacy', 'hash'), { existing: true, result: null })
  assert.equal(f.read("SELECT message_id FROM assistant_tool_call WHERE id='legacy'")[0].message_id, null)
})

test('policy reset invalidates only nonterminal task intents and never erases their historical receipts', (t) => {
  const f = fixture(t)
  const a = f.store.createHostTaskIntent(envelope('A'))
  f.store.acknowledgeHostTaskSession('action-A', receipt(a))
  f.store.recordHostTaskOutcome('action-A', outcome())
  f.store.createHostTaskIntent(envelope('B'))
  f.store.resetContext()
  assert.equal(f.store.getHostTaskIntent('action-A')?.invalidated, false)
  assert.equal(f.store.getHostTaskIntent('action-B')?.invalidated, true)
  assert.deepEqual(f.store.getHostTaskIntent('action-A')?.outcome, outcome())
  assert(f.store.getHostTaskIntent('action-A')?.sessionReceipt)
})

test('invalidated intent rejects all new private outcomes but accepts exact empty Stop metadata without reviving it', (t) => {
  const f = fixture(t)
  const intent = f.store.createHostTaskIntent(envelope())
  f.store.acknowledgeHostTaskSession('action-A', receipt(intent))
  f.store.resetContext()
  const before = f.read('SELECT * FROM assistant_task_run')
  const beforeMessages = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  for (const value of [
    outcome(),
    outcome('stopped'),
    { ...outcome('stopped'), response: '' },
    { ...outcome(), response: '', steps: [] },
  ])
    assert.throws(() => f.store.recordHostTaskOutcome('action-A', value), /host-task-context-invalidated/)
  assert.deepEqual(f.read('SELECT * FROM assistant_task_run'), before)
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), beforeMessages)
  const stopped = { ...outcome('stopped'), response: '', steps: [] }
  const recorded = f.store.recordHostTaskOutcome('action-A', stopped)
  assert.equal(recorded.invalidated, true)
  assert.deepEqual(recorded.outcome, stopped)
  assert.equal(f.store.get('assistant-A')?.status, 'cancelled')
  assert.equal(f.store.get('assistant-A')?.error, 'assistant-host-context-invalidated')
  assert.equal(f.store.get('assistant-A')?.text, '')
  assert.deepEqual(f.store.get('assistant-A')?.steps, [])
  const saved = f.read('SELECT * FROM assistant_task_run')
  f.reopen()
  assert.deepEqual(f.store.recordHostTaskOutcome('action-A', stopped), recorded)
  assert.deepEqual(f.read('SELECT * FROM assistant_task_run'), saved)
  assert.throws(() => f.store.start('', 'codex', 'assistant-A'), /not-retryable/)
})

test('existing source IDs and caller data remain detached from immutable stored intent', (t) => {
  const f = fixture(t)
  const input = envelope()
  const withSource = {
    ...input,
    taskDefinition: {
      ...input.taskDefinition,
      sources: [
        {
          id: 'task-A:source:manual',
          kind: 'manual',
          label: 'User instruction',
          detail: 'Explicit requested action',
          workdayId: null,
          conversationReference: null,
          conversationActionId: null,
          conversationStartTime: null,
          observedAt: input.startedAt,
          confidence: null,
        },
      ],
    },
  }
  const created = f.store.createHostTaskIntent(withSource)
  withSource.taskDefinition.sources[0].detail = 'Changed original caller object'
  created.envelope.preparedInput.prompt = 'Changed returned object'
  assert.equal(
    f.store.getHostTaskIntent('action-A')?.envelope.taskDefinition.sources[0].detail,
    'Explicit requested action'
  )
  assert.equal(f.store.getHostTaskIntent('action-A')?.envelope.preparedInput.prompt, input.preparedInput.prompt)
  assert.equal(f.store.getHostTaskIntent('missing'), null)
  for (const operation of [
    () => f.store.acknowledgeHostTaskSession('missing', {}),
    () => f.store.recordHostTaskOutcome('missing', outcome()),
    () => f.store.acknowledgeHostTaskOutcome('missing', {}),
    () => f.store.hostTaskResults('missing'),
  ])
    assert.throws(operation, /host-task-intent-not-found/)
})

test('immutable task intent cannot claim an already owned legacy host job', (t) => {
  const f = fixture(t)
  const legacy = f.store.start('Legacy host instruction', 'codex')
  const legacyBinding = {
    jobId: 'job-A',
    messageId: legacy.id,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 0,
    phase: 'completed' as const,
    connection: 'connected' as const,
  }
  f.store.persistHostRun(legacyBinding, { text: 'Legacy completed', status: 'completed', steps: [] })
  const beforeLegacy = f.read('SELECT * FROM assistant_host_run')
  const beforeMessages = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  assert.throws(() => f.store.createHostTaskIntent(envelope('A')), /host-task-binding-conflict/)
  assert.deepEqual(f.read('SELECT * FROM assistant_task_run'), [])
  assert.deepEqual(f.read('SELECT * FROM assistant_host_run'), beforeLegacy)
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), beforeMessages)
})

test('legacy host binding cannot claim a reserved task job or message, while exact binding remains supported', (t) => {
  const f = fixture(t)
  const legacy = f.store.start('Legacy host instruction', 'codex')
  const legacyBinding = {
    jobId: 'job-A',
    messageId: legacy.id,
    endpoint: 'tcp://127.0.0.1:47833',
    cursor: 0,
    phase: 'completed' as const,
    connection: 'connected' as const,
  }
  const beforeLegacy = f.read('SELECT * FROM assistant_host_run')
  f.store.createHostTaskIntent(envelope('B'))
  const beforeTaskMessages = f.read('SELECT * FROM assistant_message ORDER BY sequence')
  for (const binding of [
    { ...legacyBinding, jobId: 'job-B' },
    { ...legacyBinding, jobId: 'unrelated-job', messageId: 'assistant-B' },
  ])
    assert.throws(
      () => f.store.persistHostRun(binding, { text: 'Wrong owner', status: 'completed', steps: [] }),
      /host-task-binding-conflict/
    )
  assert.deepEqual(f.read('SELECT * FROM assistant_host_run'), beforeLegacy)
  assert.deepEqual(f.read('SELECT * FROM assistant_message ORDER BY sequence'), beforeTaskMessages)
  f.store.persistHostRun(
    { ...legacyBinding, jobId: 'job-B', messageId: 'assistant-B' },
    { text: 'Exact B binding', status: 'completed', steps: [] }
  )
  assert.equal(f.store.hostRun()?.jobId, 'job-B')
  assert.equal(f.store.hostRun()?.messageId, 'assistant-B')
})
