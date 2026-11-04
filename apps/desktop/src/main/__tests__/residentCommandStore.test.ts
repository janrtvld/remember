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

const computer = {
  kind: 'remote' as const,
  endpoint: 'ws://127.0.0.1:47831/',
  workspace: '/private/tmp/rpa7-own',
  displayHost: 'mini.local',
}
const patch = { text: 'Done', steps: [], status: 'completed' as const }
const checkpoint = (messageId: string) => ({
  messageId,
  computer: { ...computer },
  threadId: 'thread-1',
  turnId: 'turn-1',
  previousTurnId: null,
})
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
  let store = new ResidentAgentStore(file, { now: () => NOW })
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
  const messageId = store.appendProactiveInitiative(decision)
  assert(messageId)
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
  return {
    file,
    get store() {
      return store
    },
    api,
    grant,
    inputs,
    decision,
    messageId,
    reopen() {
      store.close()
      store = new ResidentAgentStore(file, { now: () => NOW })
    },
    sql(sql: string) {
      const db = new DatabaseSync(file)
      try {
        db.exec(sql)
      } finally {
        db.close()
      }
    },
    rows(table: string) {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))
      } finally {
        db.close()
      }
    },
  }
}

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

test('reservation atomically owns immutable target, instruction, messages and history exclusion before checkpoint', (t) => {
  const f = setup(t),
    target = { ...computer },
    a = f.store.startCommand('  Do this only  ', target, false, 'My Mini')
  target.workspace = '/changed'
  assert.equal(a.instruction, 'Do this only')
  assert.equal(a.command.state, 'reserved')
  assert.equal(a.command.computer.workspace, computer.workspace)
  assert.equal(a.command.instructionHash, createHash('sha256').update(a.instruction).digest('hex'))
  assert.equal(f.store.get(a.id)?.command?.targetLabel, 'My Mini')
  assert.equal(
    f.store.history().some((x) => x.id === a.id || x.id === a.command.userMessageId),
    false
  )
  assert.throws(() => f.store.startCommand('B', computer), /effect-slot-occupied/)
  f.reopen()
  assert.deepEqual(f.store.command(a.id), a.command)
  assert.equal(f.store.unresolvedCommands().length, 1)
})
test('command before briefing and Task blocks both without consuming grant or Task writes', (t) => {
  const f = setup(t),
    i = f.inputs()
  f.store.startCommand('A', computer)
  assert.throws(() => f.api.admit(i.envelope, i.prepared, i.current, NOW), /effect-slot-occupied/)
  assert.throws(() => f.store.createHostTaskIntent(envelope()), /effect-slot-occupied/)
  assert.equal(f.api.grant('grant-1')?.remainingJobs, 2)
  assert.equal(f.rows('assistant_task_run').length, 0)
})
test('briefing and Task and legacy checkpoint each block command before creating messages', (t) => {
  const f = setup(t),
    i = f.inputs()
  f.api.admit(i.envelope, i.prepared, i.current, NOW)
  const count = f.rows('assistant_message').length
  assert.throws(() => f.store.startCommand('A', computer), /effect-slot-occupied/)
  assert.equal(f.rows('assistant_message').length, count)
  f.api.cancelUnsubmitted(
    i.envelope.actionId,
    createHash('sha256').update(canonicalHostTaskJson(i.prepared)).digest('hex'),
    NOW
  )
  f.store.createHostTaskIntent(envelope())
  assert.throws(() => f.store.startCommand('A', computer), /effect-slot-occupied/)
})
test('legacy remote checkpoint blocks command; command blocks foreign legacy checkpoint', (t) => {
  const f = setup(t),
    old = f.store.start('Legacy', 'codex')
  f.store.setRemoteRun(checkpoint(old.id))
  assert.throws(() => f.store.startCommand('A', computer), /effect-slot-occupied/)
  f.store.setRemoteRun(null)
  const a = f.store.startCommand('A', computer)
  assert.throws(() => f.store.setRemoteRun(checkpoint(old.id)), /effect-slot-occupied/)
  assert.throws(() => f.store.setRemoteRun(checkpoint(a.id)), /command-owned/)
})
test('dispatch unknown survives reopen and cannot cancel as unsubmitted or restart', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  f.reopen()
  assert.equal(f.store.command(a.id)?.state, 'unknown')
  assert.equal(f.store.get(a.id)?.command?.canStop, false)
  assert.throws(() => f.store.markCommandDispatch(a.id), /dispatch/)
  assert.throws(() => f.store.finishCommand(a.id, { ...patch, status: 'cancelled' }, 'unsubmitted'), /dispatch/)
  assert.throws(() => f.store.startCommand('B', computer), /effect-slot-occupied/)
  assert.throws(() => f.store.start('', 'codex', a.id), /not-retryable/)
})
test('exact checkpoint target/thread/turn remains pinned; null retains identity and proves settled only after checkpoint', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  assert.throws(() => f.store.recordCommandCheckpoint(a.id, null), /checkpoint/)
  const cp = checkpoint(a.id)
  f.store.recordCommandCheckpoint(a.id, cp)
  cp.computer.workspace = '/changed'
  assert.equal(f.store.command(a.id)?.checkpoint?.computer.workspace, computer.workspace)
  for (const bad of [
    { ...checkpoint(a.id), threadId: 'other' },
    { ...checkpoint(a.id), turnId: 'other' },
    { ...checkpoint(a.id), messageId: 'other' },
    { ...checkpoint(a.id), computer: { ...computer, workspace: '/other' } },
  ])
    assert.throws(() => f.store.recordCommandCheckpoint(a.id, bad), /checkpoint/)
  f.store.recordCommandCheckpoint(a.id, null)
  assert.equal(f.store.command(a.id)?.checkpoint?.turnId, 'turn-1')
  assert.equal(f.store.command(a.id)?.settled, true)
})
test('terminal receipt and message commit once, duplicate time stable, different terminal rejected and exact slot released', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  f.store.recordCommandCheckpoint(a.id, checkpoint(a.id))
  assert.throws(() => f.store.finishCommand(a.id, patch, 'completed'), /unconfirmed/)
  f.store.recordCommandCheckpoint(a.id, null)
  const done = f.store.finishCommand(a.id, patch, 'completed'),
    rows = f.rows('assistant_message')
  assert.deepEqual(f.store.finishCommand(a.id, patch, 'completed'), done)
  assert.deepEqual(f.rows('assistant_message'), rows)
  assert.equal(f.store.remoteRun(), null)
  assert.throws(() => f.store.finishCommand(a.id, { ...patch, text: 'different' }, 'completed'), /conflict/)
  const b = f.store.startCommand('B', computer)
  f.store.requestCommandStop(a.id)
  assert.equal(f.store.command(b.id)?.stopRequested, false)
  f.reopen()
  assert.deepEqual(f.store.command(a.id), done)
})
test('context reset latches command and checkpoint and blocks publication while retaining exact Stop', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  f.store.recordCommandCheckpoint(a.id, checkpoint(a.id))
  f.store.resetContext()
  assert.equal(f.store.command(a.id)?.contextInvalidated, true)
  assert.equal(f.store.remoteRun()?.contextInvalidated, true)
  assert.throws(() => f.store.updateCommand(a.id, { ...patch, status: 'streaming' }), /invalidated/)
  f.store.recordCommandCheckpoint(a.id, null)
  assert.throws(() => f.store.finishCommand(a.id, patch, 'completed'), /invalidated/)
  f.store.finishCommand(a.id, { text: '', steps: [], status: 'cancelled' }, 'stopped')
  assert.equal(f.store.unresolvedCommands().length, 0)
})
test('generic mutators cannot overwrite either command message, checkpoint or terminal', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  for (const id of [a.id, a.command.userMessageId]) assert.throws(() => f.store.update(id, patch), /command-owned/)
  assert.throws(() => f.store.updateCommand(a.id, patch), /patch/)
  f.store.finishCommand(a.id, { text: '', steps: [], status: 'cancelled' }, 'unsubmitted')
  assert.throws(() => f.store.recordCommandCheckpoint(a.id, checkpoint(a.id)), /terminal/)
})
test('zero-row reservation, dispatch, checkpoint, terminal and reset writes roll back atomically', (t) => {
  const f = setup(t),
    count = f.rows('assistant_message').length
  f.sql(`CREATE TRIGGER ignore_reservation BEFORE INSERT ON assistant_command BEGIN SELECT RAISE(IGNORE); END`)
  assert.throws(() => f.store.startCommand('A', computer), /write-not-persisted/)
  assert.equal(f.rows('assistant_message').length, count)
  f.sql('DROP TRIGGER ignore_reservation')
  const a = f.store.startCommand('A', computer)
  f.sql(`CREATE TRIGGER ignore_command_update BEFORE UPDATE ON assistant_command BEGIN SELECT RAISE(IGNORE); END`)
  assert.throws(() => f.store.markCommandDispatch(a.id), /write-not-persisted/)
  assert.equal(f.store.command(a.id)?.state, 'reserved')
  assert.throws(() => f.store.resetContext(), /write-not-persisted/)
  assert.equal(f.store.command(a.id)?.contextInvalidated, false)
  f.sql('DROP TRIGGER ignore_command_update')
  f.store.markCommandDispatch(a.id)
  f.sql(`CREATE TRIGGER ignore_checkpoint BEFORE INSERT ON assistant_remote_run BEGIN SELECT RAISE(IGNORE); END`)
  assert.throws(() => f.store.recordCommandCheckpoint(a.id, checkpoint(a.id)), /write-not-persisted/)
  assert.equal(f.store.command(a.id)?.checkpoint, null)
  f.sql('DROP TRIGGER ignore_checkpoint')
  f.store.recordCommandCheckpoint(a.id, checkpoint(a.id))
  f.store.recordCommandCheckpoint(a.id, null)
  f.sql(`CREATE TRIGGER ignore_message BEFORE UPDATE ON assistant_message BEGIN SELECT RAISE(IGNORE); END`)
  assert.throws(() => f.store.finishCommand(a.id, patch, 'completed'), /write-not-persisted/)
  assert.equal(f.store.command(a.id)?.state, 'running')
  assert.ok(f.store.remoteRun())
})
test('malformed local target and instruction refuse without rows; reserved Stop is durable and blocks dispatch', (t) => {
  const f = setup(t),
    count = f.rows('assistant_message').length
  assert.throws(() => f.store.startCommand('', computer))
  assert.throws(() => f.store.startCommand('A', { kind: 'local' } as never))
  assert.equal(f.rows('assistant_message').length, count)
  const a = f.store.startCommand('A', computer)
  f.store.requestCommandStop(a.id)
  f.reopen()
  assert.equal(f.store.command(a.id)?.stopRequested, true)
  assert.throws(() => f.store.markCommandDispatch(a.id), /stop/)
  f.store.finishCommand(a.id, { text: '', steps: [], status: 'cancelled' }, 'unsubmitted')
  assert.equal(f.store.command(a.id)?.state, 'cancelled')
})

test('restart after invalidation retains unknown control and withholds previous progress without startup failure', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  f.store.recordCommandCheckpoint(a.id, checkpoint(a.id))
  f.store.updateCommand(a.id, { text: 'Earlier private progress', steps: [], status: 'streaming' })
  f.store.resetContext()
  f.reopen()
  assert.equal(f.store.command(a.id)?.state, 'unknown')
  assert.equal(f.store.get(a.id)?.text, '')
  assert.equal(f.store.command(a.id)?.contextInvalidated, true)
})
test('foreign legacy host binding cannot take a command slot before checkpoint', (t) => {
  const f = setup(t),
    old = f.store.start('Old', 'codex')
  f.store.startCommand('A', computer)
  assert.throws(
    () =>
      f.store.persistHostRun(
        {
          messageId: old.id,
          jobId: 'foreign',
          endpoint: 'ws://127.0.0.1:47000',
          cursor: 0,
          phase: 'running',
          connection: 'connected',
        },
        { text: '', steps: [], status: 'streaming' }
      ),
    /effect-slot-occupied/
  )
  assert.equal(f.store.hostRun(), null)
})

test('ignored mirrored checkpoint reset rolls back the durable command latch too', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  f.store.recordCommandCheckpoint(a.id, checkpoint(a.id))
  const before = f.store.command(a.id)
  f.sql(`CREATE TRIGGER ignore_remote_reset BEFORE UPDATE ON assistant_remote_run BEGIN SELECT RAISE(IGNORE); END`)
  assert.throws(() => f.store.resetContext(), /write-not-persisted/)
  assert.deepEqual(f.store.command(a.id), before)
  assert.equal(f.store.remoteRun()?.contextInvalidated, undefined)
})
test('ignored terminal receipt or checkpoint delete never publishes partial completion', (t) => {
  const f = setup(t),
    a = f.store.startCommand('A', computer)
  f.store.markCommandDispatch(a.id)
  f.store.recordCommandCheckpoint(a.id, checkpoint(a.id))
  f.store.recordCommandCheckpoint(a.id, null)
  const before = f.store.command(a.id),
    message = f.store.get(a.id)
  for (const trigger of [
    `CREATE TRIGGER ignore_terminal BEFORE UPDATE OF terminal_json ON assistant_command BEGIN SELECT RAISE(IGNORE); END`,
    `CREATE TRIGGER ignore_terminal BEFORE DELETE ON assistant_remote_run BEGIN SELECT RAISE(IGNORE); END`,
  ]) {
    f.sql(trigger)
    assert.throws(() => f.store.finishCommand(a.id, patch, 'completed'), /write-not-persisted/)
    assert.deepEqual(f.store.command(a.id), before)
    assert.deepEqual(f.store.get(a.id), message)
    assert.ok(f.store.remoteRun())
    f.sql('DROP TRIGGER ignore_terminal')
  }
})
