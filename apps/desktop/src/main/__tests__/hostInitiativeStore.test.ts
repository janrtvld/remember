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

test('grant revoke/regrant increments generation even at same clock', (t) => {
  const f = setup(t),
    g = f.grant()
  assert.equal(g.generation, 1)
  f.api.revokeGrant(g.id, g.generation, NOW)
  assert.equal(f.grant().generation, 3)
  assert.throws(() => f.api.revokeGrant(g.id, g.generation, NOW), /grant-conflict/)
})
test('admission preserves delivered reason without Task/session/user row and consumes once', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW)
  assert.equal(a.state, 'prepared')
  assert.equal(f.api.grant('grant-1')?.remainingJobs, 1)
  assert.deepEqual(f.api.admit(i.envelope, i.prepared, i.current, NOW), a)
  assert.equal(f.store.conversation(null).messages.length, 1)
  assert.equal(f.store.get(f.messageId)?.text, f.decision.text)
  assert.equal(f.store.unresolvedHostTaskExecutions().length, 0)
})
test('wrong grant or source and old sequence refuse before intent', (t) => {
  const f = setup(t),
    i = f.inputs()
  for (const change of [
    { authority: { ...i.envelope.authority, grantId: 'missing' } },
    { sourceRefs: { ...i.envelope.sourceRefs, evidence: [{ ...source, sourceId: 'other' }] } },
  ]) {
    const bad = { ...i.envelope, ...change }
    assert.throws(() => f.api.admit(bad, buildInitiativePrepared(bad), i.current, NOW))
  }
  assert.throws(
    () =>
      f.api.admit(
        i.envelope,
        i.prepared,
        { ...i.current, sourceSequences: [{ eventId: source.eventId, sequence: 10 }] },
        NOW
      ),
    /source/
  )
  assert.equal(f.api.action('action-1'), null)
  assert.equal(f.api.grant('grant-1')?.remainingJobs, 2)
})
test('decision mutation, conversation change and expiry refuse', (t) => {
  const f = setup(t),
    i = f.inputs()
  assert.throws(
    () =>
      f.api.admit(i.envelope, i.prepared, { ...i.current, decision: { ...i.current.decision, text: 'forged' } }, NOW),
    /decision/
  )
  assert.throws(() => f.api.admit(i.envelope, i.prepared, i.current, NOW + 60001), /decision/)
  f.store.noteConversationInput()
  assert.throws(() => f.api.admit(i.envelope, i.prepared, i.current, NOW), /decision/)
})
test('zero-row budget mutation rolls back intent', (t) => {
  const f = setup(t),
    i = f.inputs(),
    db = new DatabaseSync(f.file)
  db.exec(
    'CREATE TRIGGER ignore_budget BEFORE UPDATE OF remaining_jobs ON assistant_standing_grant BEGIN SELECT RAISE(IGNORE); END'
  )
  assert.throws(() => f.api.admit(i.envelope, i.prepared, i.current, NOW), /write-not-persisted/)
  assert.equal(f.api.action('action-1'), null)
  assert.equal(f.api.grant('grant-1')?.remainingJobs, 2)
  db.close()
})
test('prepared reopen preserves metadata; dispatch CAS permits only first attempt', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW)
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: () => NOW })
  assert.deepEqual(reopened.initiatives.action(a.envelope.actionId), a)
  assert.equal(reopened.initiatives.markDispatch(a.envelope.actionId, a.preparedHash, NOW), true)
  assert.equal(reopened.initiatives.markDispatch(a.envelope.actionId, a.preparedHash, NOW), false)
  assert.throws(() => reopened.initiatives.cancelUnsubmitted(a.envelope.actionId, a.preparedHash, NOW), /dispatch/)
  reopened.close()
})
test('reset latches action and grant, regrant never revives old action', (t) => {
  const f = setup(t),
    i = f.inputs()
  f.api.admit(i.envelope, i.prepared, i.current, NOW)
  f.store.resetContext()
  assert.equal(f.api.action('action-1')?.invalidated, true)
  assert.equal(f.api.grant('grant-1')?.enabled, false)
  f.grant()
  assert.throws(() => f.api.markDispatch('action-1', f.api.action('action-1')!.preparedHash, NOW), /invalidated/)
})
test('owned message refuses generic mutation/retry and prompt history', (t) => {
  const f = setup(t),
    i = f.inputs()
  f.api.admit(i.envelope, i.prepared, i.current, NOW)
  assert.equal(f.api.ownsMessage(f.messageId), true)
  assert.equal(
    f.store.history().some((m) => m.id === f.messageId),
    false
  )
  assert.throws(() => f.store.update(f.messageId, { text: 'mutated', steps: [], status: 'failed' }))
  assert.throws(() => f.store.start('', 'codex', f.messageId), /not-retryable/)
})
test('descriptor, prompt packet and unknown authority fields refuse', (t) => {
  const f = setup(t),
    i = f.inputs()
  assert.throws(() =>
    buildInitiativePrepared({ ...i.envelope, authority: { ...i.envelope.authority, workItemId: 'fake' } })
  )
  assert.throws(() =>
    buildInitiativePrepared({ ...i.envelope, preparedInput: { ...i.envelope.preparedInput, prompt: '{}' } })
  )
  assert.throws(() =>
    f.api.admit(
      i.envelope,
      { ...i.prepared, descriptor: { ...i.prepared.descriptor, workspace: '/private/tmp/wrong' } },
      i.current,
      NOW
    )
  )
})

function taskInput() {
  const root = '/private/tmp/task-cross',
    directory = `${root}/jobs/${createHash('sha256').update('task-job').digest('hex').slice(0, 24)}`
  const envelope = {
    version: 1 as const,
    actionId: 'task-action',
    workItemId: 'task-1',
    sessionId: 'task-session',
    jobId: 'task-job',
    userMessageId: 'task-user',
    assistantMessageId: 'task-assistant',
    provider: 'codex' as const,
    instruction: 'Explicit task',
    targetId: 'mini-1',
    policyFingerprint: 'policy-1',
    sources: [],
    startedAt: NOW,
    preparedInput: {
      prompt: 'Task prompt',
      systemPrompt: 'Task system',
      model: 'fake-model',
      effort: 'low',
      threadId: null,
      tools: [],
      workspace: `${directory}/workspace`,
    },
    taskDefinition: {
      version: 1 as const,
      id: 'task-1',
      title: 'Task',
      description: '',
      prompt: '',
      aiSuggestion: null,
      context: '',
      returnPoint: { lastMove: '', unresolved: '', nextMove: '' },
      lifecycle: 'open' as const,
      status: 'todo' as const,
      priority: 'none' as const,
      dueAt: null,
      sources: [],
    },
  }
  const { workspace, ...input } = envelope.preparedInput
  const routerInput = { ...input, reviewTtlMs: 300000 }
  const prepared = {
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
test('cross-kind slot is enforced synchronously in both admission orders', (t) => {
  const first = setup(t),
    i = first.inputs(),
    task = taskInput()
  first.api.admit(i.envelope, i.prepared, i.current, NOW)
  assert.throws(() => first.store.createPreparedHostTaskIntent(task.envelope, task.prepared), /slot-occupied/)
  const second = setup(t),
    other = second.inputs()
  second.store.createPreparedHostTaskIntent(task.envelope, task.prepared)
  assert.throws(() => second.api.admit(other.envelope, other.prepared, other.current, NOW), /slot-occupied/)
})
test('legacy Task admission also cannot bypass an initiative slot', (t) => {
  const f = setup(t),
    i = f.inputs(),
    task = taskInput()
  f.api.admit(i.envelope, i.prepared, i.current, NOW)
  assert.throws(() => f.store.createHostTaskIntent(task.envelope), /slot-occupied/)
})
test('withheld completion stores no new private event/result text and keeps slot', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW),
    c = completion(i.prepared)
  f.api.markDispatch('action-1', a.preparedHash, NOW)
  const withheld = f.api.observe('action-1', c.observation, 'withheld', null, NOW + 20)
  assert.equal(withheld.result, null)
  assert.equal(withheld.terminalReceivedAt, NOW + 20)
  assert.equal(f.api.unresolved().length, 1)
  const db = new DatabaseSync(f.file)
  assert.equal(
    JSON.stringify(db.prepare('SELECT * FROM assistant_initiative_action').all()).includes('withheld-nonce-43'),
    false
  )
  db.close()
  const published = f.api.observe('action-1', c.observation, 'publish', c.result, NOW + 30)
  assert.equal(published.terminalReceivedAt, NOW + 20)
  assert.deepEqual(published.result, c.result)
  assert.equal(f.api.unresolved().length, 0)
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: () => NOW + 40 })
  assert.deepEqual(reopened.initiatives.action('action-1'), published)
  reopened.close()
})
test('same cursor payload conflict and zero-row observation roll back all state', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW),
    c = completion(i.prepared)
  f.api.markDispatch('action-1', a.preparedHash, NOW)
  const before = f.api.observe('action-1', c.observation, 'withheld', null, NOW + 20)
  assert.throws(() => f.api.observe('action-1', { ...c.observation, error: 'changed' }, 'metadata', null, NOW + 21))
  const db = new DatabaseSync(f.file)
  db.exec(
    'CREATE TRIGGER ignore_observation BEFORE UPDATE OF observation_json ON assistant_initiative_action BEGIN SELECT RAISE(IGNORE); END'
  )
  assert.throws(() => f.api.observe('action-1', c.observation, 'publish', c.result, NOW + 22), /write-not-persisted/)
  assert.deepEqual(f.api.action('action-1'), before)
  db.close()
})
test('revocation prevents new result import and does not call a completed write undone', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW),
    c = completion(i.prepared)
  f.api.markDispatch('action-1', a.preparedHash, NOW)
  f.api.revokeGrant('grant-1', 1, NOW + 10)
  assert.throws(() => f.api.observe('action-1', c.observation, 'publish', c.result, NOW + 20), /withheld|invalidated/)
  const metadata = f.api.observe('action-1', c.observation, 'metadata', null, NOW + 20)
  assert.equal(metadata.terminal?.phase, 'completed')
  assert.equal(metadata.result, null)
  assert.equal(f.api.unresolved().length, 1)
})
test('generic tool result cannot be attached to owned initiative message', (t) => {
  const f = setup(t),
    i = f.inputs()
  f.api.admit(i.envelope, i.prepared, i.current, NOW)
  assert.throws(
    () =>
      f.store.claimToolCall('foreign-tool', 'a'.repeat(64), { messageId: f.messageId, toolName: 'remember_memory' }),
    /owned/
  )
})

test('terminal reconnect may refresh only transport session, keeping result and terminal time', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW),
    c = completion(i.prepared)
  f.api.markDispatch('action-1', a.preparedHash, NOW)
  const first = f.api.observe('action-1', c.observation, 'publish', c.result, NOW + 20)
  assert.throws(
    () =>
      f.api.observe(
        'action-1',
        { ...c.observation, execution: { ...c.observation.execution, pid: 124 } },
        'publish',
        c.result,
        NOW + 21
      ),
    /cursor-conflict/
  )
  const next = f.api.observe(
    'action-1',
    { ...c.observation, sessionId: 'coordinator-reopened' },
    'publish',
    c.result,
    NOW + 22
  )
  assert.equal(next.terminalReceivedAt, first.terminalReceivedAt)
  assert.equal(next.resultHash, first.resultHash)
  assert.deepEqual(next.result, first.result)
})
test('second initiative cannot occupy unresolved slot; old cancelled descriptor cannot dispatch', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW)
  const decision = { ...f.decision, id: 'decision-2', deliveredMessageId: null }
  const messageId = f.store.appendProactiveInitiative(decision)!
  const { deliveredMessageId: _d, invalidatedAt: _i, ...payload } = decision
  const next = {
    ...i.envelope,
    actionId: 'action-2',
    jobId: 'job-2',
    assistantMessageId: messageId,
    authority: { ...i.envelope.authority, decisionId: decision.id, decisionPayloadHash: hash(payload) },
  }
  const prepared = buildInitiativePrepared(next),
    current = { ...i.current, decision: { ...decision, deliveredMessageId: messageId } }
  assert.throws(() => f.api.admit(next, prepared, current, NOW), /slot-occupied/)
  f.api.cancelUnsubmitted('action-1', a.preparedHash, NOW)
  f.api.admit(next, prepared, current, NOW)
  assert.equal(f.api.markDispatch('action-1', a.preparedHash, NOW), false)
  assert.equal(f.api.action('action-2')?.state, 'prepared')
  assert.equal(f.api.grant('grant-1')?.remainingJobs, 0)
})
test('zero-row dispatch and reset cannot acknowledge an unpersisted change', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW),
    db = new DatabaseSync(f.file)
  db.exec(
    'CREATE TRIGGER ignore_dispatch BEFORE UPDATE OF state ON assistant_initiative_action BEGIN SELECT RAISE(IGNORE); END'
  )
  assert.throws(() => f.api.markDispatch('action-1', a.preparedHash, NOW), /write-not-persisted/)
  assert.equal(f.api.action('action-1')?.state, 'prepared')
  db.exec(
    'DROP TRIGGER ignore_dispatch; CREATE TRIGGER ignore_revoke BEFORE UPDATE OF invalidated ON assistant_initiative_action BEGIN SELECT RAISE(IGNORE); END'
  )
  assert.throws(() => f.store.resetContext(), /write-not-persisted/)
  assert.equal(f.api.grant('grant-1')?.enabled, true)
  assert.equal(f.api.action('action-1')?.invalidated, false)
  assert.equal(f.store.proactiveConversationGeneration(), 0)
  db.close()
})
test('unknown cannot become running or permit reserved cancellation; clocks never clamp', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW)
  f.api.markDispatch('action-1', a.preparedHash, NOW)
  const observation = {
    version: 1,
    sessionId: 'session-1',
    descriptor: i.prepared.descriptor,
    phase: 'unknown',
    createdAt: NOW,
    updatedAt: NOW + 2,
    cursor: 1,
    events: [],
    execution: null,
    permission: null,
    writeIntent: null,
    receipt: null,
    completion: null,
    error: 'interrupted',
  }
  f.api.observe('action-1', observation, 'metadata', null, NOW + 3)
  assert.throws(
    () =>
      f.api.observe(
        'action-1',
        { ...observation, phase: 'executing', updatedAt: NOW + 3, cursor: 2, error: null },
        'metadata',
        null,
        NOW + 4
      ),
    /unknown-no-replay/
  )
  assert.throws(() => f.api.cancelUnsubmitted('action-1', a.preparedHash, NOW + 4), /dispatch/)
  assert.throws(
    () => f.api.observe('action-1', { ...observation, updatedAt: NOW + 1, cursor: 2 }, 'metadata', null, NOW + 4),
    /clock-regression/
  )
})

test('grant pins real context fingerprint across reopen and requires it explicitly', (t) => {
  const f = setup(t)
  const value = { ...scope, contextFingerprint: 'account-settings-context-1' }
  const grant = f.api.createGrant(value, NOW, 'context-grant')
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: () => NOW })
  try {
    assert.equal(reopened.initiatives.grant(grant.id)?.scope.contextFingerprint, value.contextFingerprint)
    assert.equal(reopened.initiatives.grant(grant.id)?.scopeHash, grant.scopeHash)
    const { contextFingerprint: _ignored, ...missing } = value
    assert.throws(() => reopened.initiatives.createGrant(missing, NOW, 'missing-context'))
    assert.throws(() => reopened.initiatives.createGrant({ ...value, contextFingerprint: '' }, NOW, 'empty-context'))
  } finally {
    reopened.close()
  }
})

for (const operation of ['pause', 'replace'] as const) {
  test(`RPA4 ${operation} preserves published completed result but invalidates unfinished actions`, (t) => {
    const f = setup(t),
      i = f.inputs(),
      a = f.api.admit(i.envelope, i.prepared, i.current, NOW)
    const c = completion(i.prepared)
    f.api.markDispatch('action-1', a.preparedHash, NOW)
    const completed = f.api.observe('action-1', c.observation, 'publish', c.result, NOW + 20)
    if (operation === 'pause') f.api.pauseGrant('grant-1', 1, NOW + 21)
    else f.api.createGrant(scope, NOW + 21, 'grant-1')
    assert.deepEqual(f.api.action('action-1'), completed)
    f.store.close()
    const reopened = new ResidentAgentStore(f.file, { now: () => NOW + 22 })
    assert.deepEqual(reopened.initiatives.action('action-1'), completed)
    reopened.initiatives.revokeGrant('grant-1', reopened.initiatives.grant('grant-1')!.generation, NOW + 23)
    assert.equal(reopened.initiatives.action('action-1')?.invalidated, true)
    assert.equal(reopened.initiatives.action('action-1')?.result, null)
    reopened.initiatives.createGrant(scope, NOW + 24, 'grant-1')
    assert.equal(reopened.initiatives.action('action-1')?.invalidated, true)
    reopened.close()
    const pending = setup(t),
      p = pending.inputs()
    pending.api.admit(p.envelope, p.prepared, p.current, NOW)
    if (operation === 'pause') pending.api.pauseGrant('grant-1', 1, NOW + 21)
    else pending.api.createGrant(scope, NOW + 21, 'grant-1')
    assert.equal(pending.api.action('action-1')?.invalidated, true)
    assert.throws(
      () => pending.api.markDispatch('action-1', pending.api.action('action-1')!.preparedHash, NOW + 22),
      /invalidated/
    )
  })
}

test('RPA4 pause never preserves unpublished completion and zero-row pause rolls back', (t) => {
  const f = setup(t),
    i = f.inputs(),
    a = f.api.admit(i.envelope, i.prepared, i.current, NOW)
  const c = completion(i.prepared)
  f.api.markDispatch('action-1', a.preparedHash, NOW)
  const withheld = f.api.observe('action-1', c.observation, 'withheld', null, NOW + 20)
  const db = new DatabaseSync(f.file)
  db.exec(
    'CREATE TRIGGER ignore_pause BEFORE UPDATE OF invalidated ON assistant_initiative_action BEGIN SELECT RAISE(IGNORE); END'
  )
  assert.throws(() => f.api.pauseGrant('grant-1', 1, NOW + 21), /write-not-persisted/)
  assert.deepEqual(f.api.action('action-1'), withheld)
  assert.equal(f.api.grant('grant-1')?.enabled, true)
  db.exec('DROP TRIGGER ignore_pause')
  db.close()
  f.api.pauseGrant('grant-1', 1, NOW + 22)
  assert.equal(f.api.action('action-1')?.invalidated, true)
  assert.throws(() => f.api.observe('action-1', c.observation, 'publish', c.result, NOW + 23), /withheld|invalidated/)
})
