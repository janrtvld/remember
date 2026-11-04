import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { ProactiveDecision } from '../dailyReview/proactiveStore'
import {
  buildInitiativePrepared,
  type HostInitiativeEnvelopeV2,
  type StandingGrantScope,
} from '../hostInitiativeProtocol'
import { canonicalHostTaskJson } from '../hostTaskProtocol'
import { ResidentAgentStore } from '../residentAgentStore'
import type { BriefingReplyReference } from '../residentReplyContext'

const NOW = 1_800_000_000_000
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const source = {
  eventId: 'event-1',
  kind: 'context' as const,
  sourceId: 'source-1',
  evidenceId: 'context:source-1',
  workdayId: 'day-1',
  eventRevision: 'b'.repeat(64),
  revision: 'c'.repeat(64),
  contentKey: 'd'.repeat(64),
  observedAt: NOW,
  appName: 'Test Editor',
  windowTitle: 'Atlas',
  url: '',
}
const scope: StandingGrantScope = {
  version: 1,
  installationId: 'install-1',
  contextFingerprint: 'fixture-current-context',
  target: { targetId: 'mini-1', targetEpoch: 'epoch-1', root: '/private/tmp/rpa3-unit' },
  capability: 'private-briefing-v1',
  evidenceSourceIds: ['source-1'],
  afterSequence: 10,
  personalSources: [{ spaceId: 'personal', slug: 'atlas', revision: 'r1' }],
  model: 'fake-model',
  effort: 'low',
  maxInputBytes: 10000,
  maxOutputBytes: 10000,
  maxDurationMs: 60000,
  outputBasename: 'briefing.md',
  expiresAt: NOW + 120000,
  maxJobs: 2,
}
function setup(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync('/private/tmp/rpa3-store-')
  const file = join(directory, 'resident.sqlite')
  const store = new ResidentAgentStore(file, { now: () => NOW })
  t.after(() => {
    try {
      store.close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  })
  const decision: ProactiveDecision = {
    id: 'decision-1',
    kind: 'prepare',
    text: 'Ik bereid een Atlas briefing voor.',
    topicKey: 'atlas',
    sourceIds: [source.evidenceId],
    supportingQuotes: [{ sourceId: source.evidenceId, quote: 'Atlas besluit' }],
    createdAt: NOW,
    expiresAt: NOW + 60000,
    policyToken: 'policy-1',
    conversationGeneration: 0,
    inputHash: 'a'.repeat(64),
    sourceRefs: [source],
    consumerGeneration: 1,
    deletionRevision: 0,
    deliveredMessageId: null,
    invalidatedAt: null,
  }
  const messageId = store.appendProactiveInitiative(decision)!
  const api = store.initiatives
  const grant = () => api.createGrant(scope, NOW, 'grant-1')
  const inputs = () => {
    const g = grant()
    const { deliveredMessageId: _d, invalidatedAt: _i, ...payload } = decision
    const packet = {
      sources: [
        {
          sourceId: source.evidenceId,
          revision: createHash('sha256').update('Atlas besluit').digest('hex'),
          text: 'Atlas besluit',
        },
        {
          sourceId: 'personal:atlas',
          revision: createHash('sha256').update('Kies de deadline.').digest('hex'),
          text: 'Kies de deadline.',
        },
      ],
    }
    const envelope: HostInitiativeEnvelopeV2 = {
      version: 2,
      authority: {
        kind: 'initiative',
        decisionId: decision.id,
        decisionInputHash: decision.inputHash,
        decisionPayloadHash: hash(payload),
        grantId: g.id,
        grantGeneration: g.generation,
        grantScopeHash: g.scopeHash,
      },
      actionId: 'action-1',
      jobId: 'job-1',
      assistantMessageId: messageId,
      target: scope.target,
      policyFingerprint: 'policy-1',
      deletionRevision: 0,
      sourceRefs: { evidence: [source], personal: scope.personalSources },
      sourcePacketHash: hash(packet),
      startedAt: NOW,
      deadlineAt: NOW + 60000,
      capability: 'private-briefing-v1',
      preparedInput: {
        prompt: canonicalHostTaskJson(packet),
        systemPrompt: 'Synthesize only.',
        model: scope.model,
        effort: scope.effort,
        threadId: null,
        tools: [],
        maxInputBytes: scope.maxInputBytes,
        maxOutputBytes: scope.maxOutputBytes,
        maxDurationMs: scope.maxDurationMs,
      },
    }
    return {
      envelope,
      prepared: buildInitiativePrepared(envelope),
      current: {
        decision: { ...decision, deliveredMessageId: messageId },
        sourceSequences: [{ eventId: source.eventId, sequence: 11 }],
      },
    }
  }
  return { file, store, api, grant, inputs, decision, messageId }
}

function completion(prepared: ReturnType<typeof buildInitiativePrepared>) {
  const content = '# Atlas\nChoose the deadline.',
    contentHash = createHash('sha256').update(content).digest('hex')
  const receipt = {
    version: 1 as const,
    resultId: 'result-1',
    descriptorHash: hash(prepared.descriptor),
    actionId: prepared.descriptor.actionId,
    jobId: prepared.descriptor.jobId,
    inputHash: prepared.descriptor.inputHash,
    authorityHash: prepared.descriptor.authorityHash,
    basename: 'briefing.md' as const,
    contentHash,
    byteLength: Buffer.byteLength(content),
    createdAt: NOW + 10,
    verifiedAt: NOW + 11,
  }
  const observation = {
    version: 1 as const,
    sessionId: 'coordinator-1',
    descriptor: prepared.descriptor,
    phase: 'completed' as const,
    createdAt: NOW,
    updatedAt: NOW + 12,
    cursor: 3,
    events: [{ seq: 3, type: 'completed', at: NOW + 12, data: { privateText: 'withheld-nonce-43' } }],
    execution: {
      invocationId: 'actual-invocation',
      pid: 123,
      providerThreadId: 'actual-thread',
      exit: { code: 0, signal: null, at: NOW + 9 },
    },
    permission: null,
    writeIntent: { contentHash, byteLength: receipt.byteLength, createdAt: NOW + 10, state: 'verified' as const },
    receipt,
    completion: 'briefing' as const,
    error: null,
  }
  return { observation, result: { version: 1 as const, receipt, content } }
}

function fixture(t: { after(fn: () => void): void }) {
  const f = setup(t)
  const input = f.inputs()
  const admitted = f.api.admit(input.envelope, input.prepared, input.current, NOW)
  f.api.markDispatch(input.envelope.actionId, admitted.preparedHash, NOW)
  const completed = completion(input.prepared)
  const action = f.api.observe(input.envelope.actionId, completed.observation, 'publish', completed.result, NOW + 20)
  assert(action.resultHash)
  const reference: BriefingReplyReference = {
    actionId: input.envelope.actionId,
    messageId: f.messageId,
    resultId: completed.result.receipt.resultId,
    resultHash: action.resultHash,
  }
  const reply = f.store.start('Why this recommendation?', 'codex')
  return { ...f, reference, reply }
}

test('records exact ordinary assistant lineage and retains it after reopen without content', (t) => {
  const f = fixture(t)
  f.store.recordReplyContext(f.reply.id, [f.reference])
  f.store.update(f.reply.id, { text: 'Derived ordinary answer', status: 'completed', steps: [] })
  const db = new DatabaseSync(f.file)
  const rows = db.prepare('SELECT * FROM assistant_reply_context').all()
  assert.equal(rows.length, 1)
  assert.equal(JSON.stringify(rows).includes('Choose the deadline.'), false)
  assert.equal(JSON.stringify(rows).includes('Derived ordinary answer'), false)
  db.close()
  f.store.close()
  const restored = new ResidentAgentStore(f.file, { now: () => NOW + 30 })
  try {
    assert.deepEqual(restored.replyContext(f.reply.id), [f.reference])
    assert.equal(restored.get(f.reply.id)?.text, 'Derived ordinary answer')
  } finally {
    restored.close()
  }
})

test('returns detached values and snapshots caller references', (t) => {
  const f = fixture(t)
  const expected = { ...f.reference }
  const input = [{ ...f.reference }]
  f.store.recordReplyContext(f.reply.id, input)
  input[0]!.resultId = 'caller-mutation'
  input.push({ ...expected, actionId: 'foreign' })
  const read = f.store.replyContext(f.reply.id)
  assert(read[0] && 'resultId' in read[0])
  read[0].resultId = 'reader-mutation'
  read.pop()
  assert.deepEqual(f.store.replyContext(f.reply.id), [expected])
})

test('exact duplicate is a no-op while changed metadata conflicts', (t) => {
  const f = fixture(t)
  f.store.recordReplyContext(f.reply.id, [f.reference])
  const db = new DatabaseSync(f.file)
  db.exec(
    "CREATE TRIGGER no_insert BEFORE INSERT ON assistant_reply_context BEGIN SELECT RAISE(ABORT, 'unexpected-insert'); END"
  )
  db.exec(
    "CREATE TRIGGER no_update BEFORE UPDATE ON assistant_reply_context BEGIN SELECT RAISE(ABORT, 'unexpected-update'); END"
  )
  f.store.recordReplyContext(f.reply.id, [{ ...f.reference }])
  assert.throws(
    () => f.store.recordReplyContext(f.reply.id, [{ ...f.reference, resultId: 'changed' }]),
    /assistant-reply-context-conflict/
  )
  assert.deepEqual(f.store.replyContext(f.reply.id), [f.reference])
  db.close()
})

test('missing, user, proactive, initiative and Task-owned messages cannot receive lineage', (t) => {
  const f = fixture(t)
  const userId = f.store.get(f.reply.id)!.replyTo!
  for (const id of ['absent', userId, f.messageId]) {
    assert.throws(() => f.store.recordReplyContext(id, [f.reference]), /assistant-reply-context-message/)
  }
  const proactive = f.store.appendProactiveInitiative({ ...f.decision, id: 'plain-proactive' })!
  assert.throws(() => f.store.recordReplyContext(proactive, [f.reference]), /assistant-reply-context-message/)
  const task = f.store.start('Task reply ownership fixture', 'codex')
  const taskUser = f.store.get(task.id)!.replyTo!
  const db = new DatabaseSync(f.file)
  db.prepare(
    'INSERT INTO assistant_task_run(action_id,work_item_id,session_id,job_id,user_message_id,assistant_message_id,envelope_hash,envelope_json) VALUES (?,?,?,?,?,?,?,?)'
  ).run('owned-task', 'task', 'session', 'job', taskUser, task.id, 'hash', '{}')
  assert.throws(() => f.store.recordReplyContext(task.id, [f.reference]), /assistant-reply-context-message/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assistant_reply_context').get()?.n, 0)
  db.close()
})

test('Task suggestions and legacy host-owned messages are not ordinary replies', (t) => {
  const f = fixture(t)
  f.store.appendTaskSuggestion({
    eventId: 'suggestion',
    taskId: 'task',
    evidenceIds: ['source'],
    text: 'Suggested task',
    provider: 'codex',
    createdAt: NOW,
  })
  const db = new DatabaseSync(f.file)
  const suggestionId = String(db.prepare('SELECT message_id FROM assistant_task_suggestion').get()!.message_id)
  assert.throws(() => f.store.recordReplyContext(suggestionId, [f.reference]), /assistant-reply-context-message/)
  db.prepare('INSERT INTO assistant_host_run(job_id,message_id,binding) VALUES (?,?,?)').run(
    'legacy-job',
    f.reply.id,
    '{}'
  )
  assert.throws(() => f.store.recordReplyContext(f.reply.id, [f.reference]), /assistant-reply-context-message/)
  db.close()
})

for (const field of ['actionId', 'messageId', 'resultId', 'resultHash'] as const) {
  test(`rejects a foreign ${field} without recording lineage`, (t) => {
    const f = fixture(t)
    const value = field === 'resultHash' ? 'f'.repeat(64) : 'foreign'
    assert.throws(
      () => f.store.recordReplyContext(f.reply.id, [{ ...f.reference, [field]: value }]),
      /assistant-reply-context-reference/
    )
    assert.deepEqual(f.store.replyContext(f.reply.id), [])
  })
}

for (const mutation of [
  'invalidated=1',
  "publication_state='withheld'",
  "state='executing'",
  'terminal_json=NULL',
  'result_json=NULL',
  'result_hash=NULL',
  "terminal_json=json_set(terminal_json,'$.phase','stopped')",
  "terminal_json=json_set(terminal_json,'$.completion','silent')",
]) {
  test(`rejects unavailable result (${mutation})`, (t) => {
    const f = fixture(t)
    const db = new DatabaseSync(f.file)
    db.exec(`UPDATE assistant_initiative_action SET ${mutation}`)
    assert.throws(() => f.store.recordReplyContext(f.reply.id, [f.reference]), /assistant-reply-context-reference/)
    assert.deepEqual(f.store.replyContext(f.reply.id), [])
    db.close()
  })
}

test('pause preserves valid completed lineage admission, reset preserves the existing lineage', (t) => {
  const f = fixture(t)
  const grant = f.api.grant('grant-1')!
  f.api.pauseGrant(grant.id, grant.generation, NOW + 25)
  f.store.recordReplyContext(f.reply.id, [f.reference])
  f.store.resetContext()
  assert.deepEqual(f.store.replyContext(f.reply.id), [f.reference])
  assert.equal(f.api.action(f.reference.actionId)?.invalidated, true)
  const next = f.store.start('Another question', 'codex')
  assert.throws(() => f.store.recordReplyContext(next.id, [f.reference]), /assistant-reply-context-reference/)
  assert.throws(() => f.store.recordReplyContext(f.reply.id, [f.reference]), /assistant-reply-context-reference/)
})

test('bounds exact fields and duplicates before recording', (t) => {
  const f = fixture(t)
  const invalid: unknown[] = [
    [],
    null,
    {},
    [null],
    [f.reference, f.reference],
    Array.from({ length: 4 }, () => f.reference),
    [{ ...f.reference, actionId: '' }],
    [{ ...f.reference, actionId: 'x'.repeat(201) }],
    [{ ...f.reference, actionId: 'bad\nline' }],
    [{ ...f.reference, resultHash: 'F'.repeat(64) }],
    [{ ...f.reference, resultHash: 'abc' }],
    [{ ...f.reference, text: 'not metadata' }],
  ]
  for (const value of invalid)
    assert.throws(
      () => f.store.recordReplyContext(f.reply.id, value as BriefingReplyReference[]),
      /assistant-reply-context-invalid/
    )
  assert.deepEqual(f.store.replyContext(f.reply.id), [])
})

test('zero-row lineage insert fails and leaves no receipt or message mutation', (t) => {
  const f = fixture(t)
  const before = f.store.get(f.reply.id)
  const db = new DatabaseSync(f.file)
  db.exec('CREATE TRIGGER ignore_lineage BEFORE INSERT ON assistant_reply_context BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(
    () => f.store.recordReplyContext(f.reply.id, [f.reference]),
    /assistant-reply-context-write-not-persisted/
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assistant_reply_context').get()?.n, 0)
  assert.deepEqual(f.store.get(f.reply.id), before)
  db.exec('DROP TRIGGER ignore_lineage')
  f.store.recordReplyContext(f.reply.id, [f.reference])
  assert.deepEqual(f.store.replyContext(f.reply.id), [f.reference])
  db.close()
})

test('malformed persisted lineage fails closed instead of returning unguarded history', (t) => {
  const f = fixture(t)
  f.store.recordReplyContext(f.reply.id, [f.reference])
  const db = new DatabaseSync(f.file)
  db.prepare('UPDATE assistant_reply_context SET references_json=?').run('[]')
  assert.throws(() => f.store.replyContext(f.reply.id), /assistant-reply-context-invalid/)
  db.prepare('UPDATE assistant_reply_context SET references_json=?').run('{broken')
  assert.throws(() => f.store.replyContext(f.reply.id), /assistant-reply-context-invalid/)
  db.close()
})

function anotherResult(f: ReturnType<typeof fixture>, suffix: string): BriefingReplyReference {
  const decision = { ...f.decision, id: `decision-${suffix}` }
  const messageId = f.store.appendProactiveInitiative(decision)!
  const grant = f.api.createGrant(scope, NOW, `grant-${suffix}`)
  const previous = f.api.action(f.reference.actionId)!
  const { deliveredMessageId: _delivered, invalidatedAt: _invalidated, ...payload } = decision
  const envelope: HostInitiativeEnvelopeV2 = {
    ...previous.envelope,
    actionId: `action-${suffix}`,
    jobId: `job-${suffix}`,
    assistantMessageId: messageId,
    authority: {
      ...previous.envelope.authority,
      decisionId: decision.id,
      decisionPayloadHash: hash(payload),
      grantId: grant.id,
      grantGeneration: grant.generation,
      grantScopeHash: grant.scopeHash,
    },
  }
  const prepared = buildInitiativePrepared(envelope)
  const admitted = f.api.admit(
    envelope,
    prepared,
    {
      decision: { ...decision, deliveredMessageId: messageId },
      sourceSequences: [{ eventId: source.eventId, sequence: 11 }],
    },
    NOW
  )
  f.api.markDispatch(envelope.actionId, admitted.preparedHash, NOW)
  const done = completion(prepared)
  done.result.receipt.resultId = `result-${suffix}`
  const action = f.api.observe(envelope.actionId, done.observation, 'publish', done.result, NOW + 20)
  assert(action.resultHash)
  return {
    actionId: envelope.actionId,
    messageId,
    resultId: done.result.receipt.resultId,
    resultHash: action.resultHash,
  }
}

test('three exact results have canonical ordering independent of caller order', (t) => {
  const f = fixture(t)
  const second = anotherResult(f, '2')
  const third = anotherResult(f, '3')
  f.store.recordReplyContext(f.reply.id, [third, f.reference, second])
  assert.deepEqual(f.store.replyContext(f.reply.id), [f.reference, second, third])
  f.store.recordReplyContext(f.reply.id, [second, third, f.reference])
  assert.deepEqual(f.store.replyContext(f.reply.id), [f.reference, second, third])
})

for (const mutation of [
  "result_json=json_set(result_json,'$.content','tampered content')",
  "result_json=json_set(result_json,'$.receipt.actionId','foreign')",
]) {
  test(`stored result corruption is not accepted (${mutation})`, (t) => {
    const f = fixture(t)
    const db = new DatabaseSync(f.file)
    db.exec(`UPDATE assistant_initiative_action SET ${mutation}`)
    assert.throws(() => f.store.recordReplyContext(f.reply.id, [f.reference]), /assistant-reply-context-reference/)
    assert.deepEqual(f.store.replyContext(f.reply.id), [])
    db.close()
  })
}
