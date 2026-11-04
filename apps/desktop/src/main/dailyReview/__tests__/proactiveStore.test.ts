import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import type { DailyReviewSession } from '@remember/shared'
import { EvidenceStore } from '../evidenceStore'
import type { ProactiveCommit, ProactiveSource } from '../proactiveStore'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-proactive-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(file)
  cleanups.push(() => store.close())
  const db = new DatabaseSync(file)
  cleanups.push(() => db.close())
  const now = Date.now()
  const day: DailyReviewSession = {
    id: 'day',
    startedAt: now - 60_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    contextMoments: [],
    appActivity: [],
    memory: null,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(day)
  return {
    get store() {
      return store
    },
    db,
    now,
    reopen() {
      store.close()
      store = new EvidenceStore(file)
    },
  }
}

function context(
  store: EvidenceStore,
  id = 'screen',
  text = 'Atlas compile error: missing route handler.',
  at = Date.now()
) {
  store.appendContextMoment(
    'day',
    {
      id,
      timestamp: at,
      text,
      appName: 'Editor',
      windowTitle: 'Atlas',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null,
    'com.test.editor'
  )
}

function setup() {
  const f = fixture()
  const generation = f.store.proactive.configureConsumer(true, f.now - 1)
  context(f.store, 'screen', undefined, f.now)
  return {
    ...f,
    get store() {
      return f.store
    },
    generation,
  }
}

function batch(f: ReturnType<typeof fixture>) {
  return f.store.proactive.batch(
    f.now + 20_000,
    () => true,
    () => true
  )
}
function commit(
  sources: ProactiveSource[],
  consumerGeneration: number,
  now: number,
  kind: ProactiveCommit['decision']['kind'] = 'offer'
): ProactiveCommit {
  return {
    consumerGeneration,
    sources,
    decision: {
      id: 'decision-a',
      kind,
      text: kind === 'silent' ? '' : 'Ik kan de ontbrekende handler met je nalopen.',
      topicKey: 'atlas-error',
      sourceIds: kind === 'silent' ? [] : sources.map((source) => source.evidenceId),
      createdAt: now + 20_000,
      supportingQuotes:
        kind === 'silent' ? [] : sources.map((source) => ({ sourceId: source.evidenceId, quote: source.text })),
      expiresAt: now + 80_000,
      policyToken: 'policy-1',
      conversationGeneration: 0,
    },
  }
}

test('source and proactive event are atomic; the legacy consumer remains untouched', () => {
  const f = setup()
  const sources = batch(f)
  assert.equal(sources.length, 1)
  assert.ok(sources[0]?.eventRevision)
  const before = f.db.prepare('SELECT * FROM ambient_task_evidence').all()
  f.store.proactive.commit(commit(sources, f.generation, f.now))
  assert.deepEqual(f.db.prepare('SELECT * FROM ambient_task_evidence').all(), before)
  assert.equal(batch(f).length, 0)
  f.db.exec(
    "CREATE TRIGGER reject_proactive_event BEFORE INSERT ON proactive_event BEGIN SELECT RAISE(ABORT, 'injected-event-cut'); END"
  )
  assert.throws(() => context(f.store, 'rollback-screen', 'New unique context.'), /injected-event-cut/)
  assert.equal(f.db.prepare("SELECT id FROM context_evidence WHERE id = 'rollback-screen'").get(), undefined)
})

test('durable queue scan can pass held and future events without changing their authority or dropping them', () => {
  const f = setup()
  const fence = f.db.prepare('SELECT after_sequence FROM proactive_consumer').get()?.after_sequence
  const held = batch(f)
  context(f.store, 'later', 'A different source waiting for availability.', f.now + 1)
  f.db.prepare("UPDATE proactive_event SET available_at=? WHERE source_id='later'").run(f.now + 60_000)
  assert.deepEqual(
    batch(f).map((source) => source.eventId),
    held.map((source) => source.eventId)
  )
  f.store.proactive.commit(commit(held, f.generation, f.now, 'silent'))
  assert.equal(batch(f).length, 0)
  const progress = f.db.prepare('SELECT after_sequence,scan_after_sequence FROM proactive_consumer').get()
  assert.equal(progress?.after_sequence, fence)
  assert.equal(
    progress?.scan_after_sequence,
    f.db.prepare('SELECT MAX(sequence) AS head FROM proactive_event').get()?.head
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_queue').get()?.n, 1)
  f.reopen()
  const future = f.store.proactive.batch(
    f.now + 70_000,
    () => true,
    () => true
  )
  assert.deepEqual(
    future.map((source) => source.sourceId),
    ['later']
  )
  const receipt = commit(future, f.generation, f.now + 50_000, 'silent')
  receipt.decision.id = 'later-decision'
  f.store.proactive.commit(receipt)
  assert.equal(
    f.store.proactive.batch(
      f.now + 71_000,
      () => true,
      () => true
    ).length,
    0
  )
  assert.equal(f.db.prepare('SELECT after_sequence FROM proactive_consumer').get()?.after_sequence, fence)
  context(f.store, 'new-head', 'A new journal event after the scan reached its previous head.', f.now + 72_000)
  assert.deepEqual(
    f.store.proactive
      .batch(
        f.now + 80_000,
        () => true,
        () => true
      )
      .map((source) => source.sourceId),
    ['new-head']
  )
})

test('queue checkpoint and receipt advancement roll back if pending work cannot be retained or removed', () => {
  const f = setup()
  f.db.exec('CREATE TRIGGER reject_queue BEFORE INSERT ON proactive_queue BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => batch(f), /write-not-persisted/)
  assert.equal(f.db.prepare('SELECT scan_after_sequence FROM proactive_consumer').get()?.scan_after_sequence, 0)
  f.db.exec('DROP TRIGGER reject_queue')
  const sources = batch(f)
  assert.equal(sources.length, 1)
  f.db.exec('CREATE TRIGGER retain_queue BEFORE DELETE ON proactive_queue BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => f.store.proactive.commit(commit(sources, f.generation, f.now, 'silent')), /write-not-persisted/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_considered').get()?.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_queue').get()?.n, 1)
  f.db.exec('DROP TRIGGER retain_queue')
  f.store.proactive.commit(commit(sources, f.generation, f.now, 'silent'))
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_queue').get()?.n, 0)
})

test('queue reconstruction and older-writer receipts preserve pending work across restart', () => {
  const f = setup()
  const source = batch(f)[0]
  f.db.exec('DROP TABLE proactive_queue')
  f.reopen()
  assert.deepEqual(
    batch(f).map((entry) => entry.eventId),
    [source.eventId]
  )
  f.db
    .prepare('INSERT INTO proactive_considered(consumer,event_id,decision_id,state,at) VALUES(?,?,NULL,?,?)')
    .run('proactive-rpa1.v1', source.eventId, 'excluded', f.now)
  f.reopen()
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_queue').get()?.n, 0)
  assert.equal(batch(f).length, 0)
})

test('a failed queue clear cannot partially revoke the consumer generation', () => {
  const f = setup()
  batch(f)
  f.db.exec('CREATE TRIGGER retain_pending BEFORE DELETE ON proactive_queue BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => f.store.proactive.configureConsumer(false, f.now + 1), /write-not-persisted/)
  assert.equal(f.store.proactive.generation(), f.generation)
  assert.equal(batch(f).length, 1)
})

test('metadata revisions invalidate old refs and remain separate event rows', () => {
  const f = setup()
  const first = batch(f)[0]!
  f.db.prepare('UPDATE context_evidence SET window_title = ? WHERE id = ?').run('Different project', 'screen')
  assert.equal(f.store.proactive.resolve(first), null)
  f.store.proactive.enqueue('context', 'screen', 'day', f.now + 1)
  const next = batch(f)[0]!
  assert.notEqual(next.eventRevision, first.eventRevision)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_event').get()?.n, 2)
  assert.throws(() => f.store.proactive.commit(commit([first], f.generation, f.now)), /proactive-source-changed/)
})

test('silent decisions and same-content duplicates survive reopen without legacy ACK', () => {
  const f = setup()
  const sources = batch(f)
  f.store.proactive.commit(commit(sources, f.generation, f.now, 'silent'))
  context(f.store, 'duplicate', undefined, f.now + 2)
  f.reopen()
  assert.equal(
    f.store.proactive.batch(
      f.now + 30_000,
      () => true,
      () => true
    ).length,
    0
  )
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 30_000).length, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_considered').get()?.n, 2)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ambient_task_evidence WHERE completed_at IS NULL').get()?.n, 2)
})

test('delivery ACK is exact and immutable over reopen', () => {
  const f = setup()
  const value = f.store.proactive.commit(commit(batch(f), f.generation, f.now))
  f.reopen()
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 30_000)[0]?.inputHash, value.inputHash)
  assert.throws(
    () => f.store.proactive.acknowledgeDelivery(value.id, 'wrong', 'message-a', f.now + 30_000),
    /proactive-delivery-conflict/
  )
  f.store.proactive.acknowledgeDelivery(value.id, value.inputHash, 'message-a', f.now + 30_000)
  f.store.proactive.acknowledgeDelivery(value.id, value.inputHash, 'message-a', f.now + 31_000)
  assert.throws(
    () => f.store.proactive.acknowledgeDelivery(value.id, value.inputHash, 'message-b', f.now + 31_000),
    /proactive-delivery-conflict/
  )
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 31_000).length, 0)
})

test('conflicting duplicate decision, zero-row decision and zero-row considered writes roll back', () => {
  const f = setup()
  const input = commit(batch(f), f.generation, f.now)
  f.db.exec('CREATE TRIGGER ignore_considered BEFORE INSERT ON proactive_considered BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => f.store.proactive.commit(input), /proactive-write-not-persisted/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_decision').get()?.n, 0)
  f.db.exec('DROP TRIGGER ignore_considered')
  f.db.exec('CREATE TRIGGER ignore_decision BEFORE INSERT ON proactive_decision BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => f.store.proactive.commit(input), /proactive-write-not-persisted/)
  f.db.exec('DROP TRIGGER ignore_decision')
  const first = f.store.proactive.commit(input)
  assert.equal(f.store.proactive.commit(input).inputHash, first.inputHash)
  assert.throws(
    () => f.store.proactive.commit({ ...input, decision: { ...input.decision, text: 'Different' } }),
    /proactive-decision-conflict/
  )
})

test('disable/regrant, invalidation and canonical deletion cannot revive pending decisions', () => {
  const f = setup()
  const input = commit(batch(f), f.generation, f.now)
  f.store.proactive.commit(input)
  f.store.proactive.configureConsumer(false, f.now + 30_000)
  const generation = f.store.proactive.configureConsumer(true, f.now + 31_000)
  assert.ok(generation > f.generation)
  assert.throws(
    () => f.store.proactive.commit({ ...input, decision: { ...input.decision, id: 'late' } }),
    /proactive-generation-changed/
  )
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 32_000).length, 0)
  context(f.store, 'new', 'A new issue.', f.now + 33_000)
  f.store.deleteSession('day')
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 34_000).length, 0)
})

test('expired and pre-enablement events cannot create fresh delivery', () => {
  const f = fixture()
  context(f.store)
  f.store.proactive.configureConsumer(true, Date.now() + 1)
  assert.equal(batch(f).length, 0)
  const g = setup()
  g.store.proactive.commit(commit(batch(g), g.generation, g.now))
  assert.equal(g.store.proactive.pendingDeliveries(g.now + 90_000).length, 0)
})

test('Task observation and proactive decision rollback together', () => {
  const f = setup()
  const input = commit(batch(f), f.generation, f.now)
  const task = {
    title: 'Fix the handler',
    description: 'Investigate the missing Atlas handler.',
    source: { kind: 'task' as const, evidenceId: 'screen', label: 'Atlas', detail: 'Explicitly owned follow-up.' },
  }
  f.db.exec(
    "CREATE TRIGGER reject_decision BEFORE INSERT ON proactive_decision BEGIN SELECT RAISE(ABORT, 'injected-decision-cut'); END"
  )
  assert.throws(
    () =>
      f.store.applyAnalyzedWorkItems({
        workdayId: 'day',
        plan: { proposed: [task], changes: [] },
        conversations: [],
        analysisStartedAt: f.now,
        observedAt: f.now + 20_000,
        proactiveBatch: input,
      }),
    /injected-decision-cut/
  )
  assert.equal(f.store.listWorkItems().length, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_considered').get()?.n, 0)
  f.db.exec('DROP TRIGGER reject_decision')
  assert.equal(
    f.store.applyAnalyzedWorkItems({
      workdayId: 'day',
      plan: { proposed: [task], changes: [] },
      conversations: [],
      analysisStartedAt: f.now,
      observedAt: f.now + 20_000,
      proactiveBatch: input,
    }).created,
    1
  )
})

test('model closure is an observation; ordinary Day fallback preserves the human Task row', () => {
  const f = fixture()
  const item = f.store.createWorkItem('Original title', 'Human definition')
  const before = f.db.prepare('SELECT * FROM work_item WHERE id = ?').get(item.id)
  const result = f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan: {
      proposed: [],
      changes: [{ id: item.id, title: item.title, type: 'completed', reason: 'Observed sent confirmation.' }],
    },
    conversations: [],
    analysisStartedAt: Date.now() + 100,
    observedAt: Date.now() + 200,
  })
  assert.equal(result.closed, 0)
  assert.deepEqual(f.db.prepare('SELECT * FROM work_item WHERE id = ?').get(item.id), before)
  assert.ok(
    f.store.getWorkItem(item.id)?.observations.some((entry) => entry.summary.includes('Observed sent confirmation.'))
  )
})

test('model proposal never renames an existing Task or reopens a closed Task', () => {
  const f = setup()
  const item = f.store.createWorkItem('Original title', 'Human definition')
  const proposal = {
    id: item.id,
    title: 'Model replacement',
    description: 'Model description',
    source: { kind: 'task' as const, evidenceId: 'screen', label: 'Atlas', detail: 'Observed update.' },
  }
  f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan: { proposed: [proposal], changes: [] },
    conversations: [],
    analysisStartedAt: Date.now() + 100,
    observedAt: Date.now() + 200,
  })
  assert.equal(f.store.getWorkItem(item.id)?.title, 'Original title')
  f.store.setWorkItemLifecycle(item.id, 'completed')
  const before = f.db.prepare('SELECT * FROM work_item WHERE id = ?').get(item.id)
  f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan: { proposed: [proposal], changes: [] },
    conversations: [],
    analysisStartedAt: Date.now() + 300,
    observedAt: Date.now() + 400,
  })
  assert.deepEqual(f.db.prepare('SELECT * FROM work_item WHERE id = ?').get(item.id), before)
})

test('late linked media metadata changes the speech revision without changing text', () => {
  const f = fixture()
  f.store.proactive.configureConsumer(true, f.now - 1)
  const moment = {
    id: 'audio',
    sessionId: 'day',
    source: 'microphone' as const,
    startedAt: f.now - 10_000,
    durationMs: 10_000,
    status: 'ready' as const,
    transcript: 'Ik stuur het voorstel.',
  }
  f.store.appendAudioMoment(moment)
  f.store.appendSpeechSegments([
    {
      id: 'speech',
      workdayId: 'day',
      chunkId: 'audio',
      source: 'microphone',
      startedAt: f.now - 9000,
      endedAt: f.now,
      text: moment.transcript,
      detectedLanguage: 'nl',
      acceptedLanguage: 'nl',
      rejectionReason: null,
    },
  ])
  const first = batch(f)[0]!
  assert.deepEqual(first.provenance, { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'microphone' })
  f.store.appendAudioMoment({
    ...moment,
    mediaPlayback: { isPlaying: true, bundleIdentifier: 'com.test.player', applicationName: 'Test player' },
  })
  const second = batch(f)[0]!
  assert.equal(f.store.proactive.resolve(first), null)
  assert.equal(second.revision, first.revision)
  assert.notEqual(second.eventRevision, first.eventRevision)
  assert.equal(second.provenance.mediaPlayback, 'recorded')
  assert.equal(second.provenance.speaker, 'unknown')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_event').get()?.n, 2)
})

test('own output and stale accepted events are acknowledged without interpretation', () => {
  const f = setup()
  f.db.prepare('UPDATE application SET display_name = ?, bundle_id = ?').run('Remember', 'computer.remember.qa')
  f.store.proactive.enqueue('context', 'screen', 'day')
  context(f.store, 'old', 'Old request', f.now - 180_000)
  assert.equal(batch(f).length, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_decision').get()?.n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_considered').get()?.n, 3)
})

test('unsupported quote, mutated source and already-considered alias cannot commit', () => {
  const f = setup()
  const input = commit(batch(f), f.generation, f.now)
  assert.throws(
    () =>
      f.store.proactive.commit({
        ...input,
        decision: { ...input.decision, supportingQuotes: [{ sourceId: 'screen', quote: 'invented quote' }] },
      }),
    /invalid-proactive-decision/
  )
  assert.throws(
    () =>
      f.store.proactive.commit({ ...input, sources: input.sources.map((source) => ({ ...source, text: 'Forged.' })) }),
    /invalid-proactive-decision|proactive-source-changed/
  )
  f.store.proactive.commit(input)
  assert.throws(
    () => f.store.proactive.commit({ ...input, decision: { ...input.decision, id: 'alias' } }),
    /proactive-source-already-considered/
  )
})

test('zero-row policy invalidation and delivery ACK fail closed and roll back', () => {
  const f = setup()
  const value = f.store.proactive.commit(commit(batch(f), f.generation, f.now))
  f.db.exec('CREATE TRIGGER ignore_delivery BEFORE UPDATE ON proactive_decision BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(
    () => f.store.proactive.acknowledgeDelivery(value.id, value.inputHash, 'message', f.now + 30_000),
    /proactive-write-not-persisted/
  )
  assert.throws(() => f.store.proactive.invalidate(f.now + 30_000), /proactive-write-not-persisted/)
  assert.equal(f.store.proactive.generation(), f.generation)
  assert.equal(f.store.proactive.get(value.id)?.deliveredMessageId, null)
  f.db.exec('DROP TRIGGER ignore_delivery')
  f.store.proactive.invalidate(f.now + 31_000)
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 32_000).length, 0)
})

test('a model-created Task title becomes stable while new grounded context may be added', () => {
  const f = setup()
  const task = {
    title: 'Original model title',
    description: 'Investigate the handler.',
    source: { kind: 'task' as const, evidenceId: 'screen', label: 'Atlas', detail: 'Concrete initial evidence.' },
  }
  f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan: { proposed: [task], changes: [] },
    conversations: [],
    analysisStartedAt: f.now,
    observedAt: f.now + 10,
  })
  const created = f.store.listWorkItems()[0]!
  assert.equal(created.userEditedTitle, false)
  f.store.applyAnalyzedWorkItems({
    workdayId: 'day',
    plan: {
      proposed: [{ ...task, id: created.id, title: 'Unasked rename', context: 'Additional observed context.' }],
      changes: [],
    },
    conversations: [],
    analysisStartedAt: f.now + 20,
    observedAt: f.now + 30,
  })
  const updated = f.store.getWorkItem(created.id)!
  assert.equal(updated.title, created.title)
  assert.equal(updated.context, 'Additional observed context.')
})

test('parser-style silent decision with no topic or quotes commits once', () => {
  const f = setup()
  const input = commit(batch(f), f.generation, f.now, 'silent')
  input.decision.topicKey = ''
  const saved = f.store.proactive.commit(input)
  assert.equal(saved.kind, 'silent')
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 25_000).length, 0)
  assert.equal(batch(f).length, 0)
})

test('enablement sequence fence excludes earlier events even in the same millisecond', () => {
  const f = fixture()
  context(f.store, 'same-millisecond', undefined, f.now)
  f.db.prepare('UPDATE proactive_event SET accepted_at = ?').run(f.now)
  f.store.proactive.configureConsumer(true, f.now)
  assert.equal(batch(f).length, 0)
})

test('same-clock revoke/regrant and invalidation fence held sources from batch and direct commit', () => {
  for (const transition of ['regrant', 'invalidate']) {
    const f = setup()
    f.db.prepare('UPDATE proactive_event SET accepted_at = ?, available_at = ?').run(f.now, f.now)
    const held = commit(batch(f), f.generation, f.now)
    assert.equal(held.sources.length, 1)
    if (transition === 'regrant') {
      f.store.proactive.configureConsumer(false, f.now)
      f.store.proactive.configureConsumer(true, f.now)
    } else f.store.proactive.invalidate(f.now)
    assert.equal(batch(f).length, 0)
    assert.throws(() => f.store.proactive.commit(held), /proactive-generation-changed/)
    held.consumerGeneration = f.store.proactive.generation()
    assert.throws(() => f.store.proactive.commit(held), /proactive-source-changed/)
    f.reopen()
    assert.equal(batch(f).length, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_decision').get()?.n, 0)
  }
})

test('invalid decision rolls back otherwise valid Task extraction and requires a transaction', () => {
  const f = setup()
  const input = commit(batch(f), f.generation, f.now)
  const task = {
    title: 'Fix the handler',
    description: 'Investigate it.',
    source: { kind: 'task' as const, evidenceId: 'screen', label: 'Atlas', detail: 'Concrete owned work.' },
  }
  assert.throws(() => f.store.proactive.commitInTransaction(input), /proactive-transaction-required/)
  input.decision.supportingQuotes = [{ sourceId: 'screen', quote: 'A forged quote.' }]
  assert.throws(
    () =>
      f.store.applyAnalyzedWorkItems({
        workdayId: 'day',
        plan: { proposed: [task], changes: [] },
        conversations: [],
        analysisStartedAt: f.now,
        observedAt: f.now + 20_000,
        proactiveBatch: input,
      }),
    /invalid-proactive-decision/
  )
  assert.equal(f.store.listWorkItems().length, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_considered').get()?.n, 0)
})

test('ineligible delivery skips source hydration but validates changed sources before delivery', () => {
  const f = setup()
  const decision = f.store.proactive.commit(commit(batch(f), f.generation, f.now))
  f.db.prepare('UPDATE context_evidence SET text = ? WHERE id = ?').run('Changed source content.', 'screen')
  assert.deepEqual(
    f.store.proactive.pendingDeliveries(f.now + 30_000, () => false),
    []
  )
  assert.equal(f.store.proactive.get(decision.id)?.invalidatedAt, null)
  assert.deepEqual(
    f.store.proactive.pendingDeliveries(f.now + 31_000, () => true),
    []
  )
  assert.equal(f.store.proactive.get(decision.id)?.invalidatedAt, f.now + 31_000)
})

test('expired delivery is invalidated before eligibility or source hydration', () => {
  const f = setup()
  const decision = f.store.proactive.commit(commit(batch(f), f.generation, f.now))
  assert.deepEqual(
    f.store.proactive.pendingDeliveries(f.now + 90_000, () => {
      assert.fail('Expired decisions must not run delivery or source checks')
    }),
    []
  )
  assert.equal(f.store.proactive.get(decision.id)?.invalidatedAt, f.now + 90_000)
})
