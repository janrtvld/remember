import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import type { DailyReviewSession, DayMemory } from '@remember/shared'
import { EvidenceStore } from '../evidenceStore'
import { ProactiveDaySources } from '../proactiveDaySources'
import { ProactiveDayStorage } from '../proactiveDayStorage'
import type { ProactiveCommit, ProactiveSource } from '../proactiveStore'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function required<T>(value: T | null): T {
  assert.ok(value)
  return value
}

test('Day projections are shared only for one synchronous source validation and revocation stays fresh', () => {
  const f = fixture()
  const source = required(f.sync())
  let reads = 0
  let available = true
  const days = new ProactiveDaySources(f.db, {
    resolve: () => {
      reads++
      return available ? [] : null
    },
    collect: () => [],
  })
  days.withReads(() => {
    const first = required(days.resolve(source.sourceId))
    assert.strictEqual(days.resolve(source.sourceId), first)
    assert.strictEqual(days.provenance(source.sourceId), days.provenance(source.sourceId))
    assert.equal(reads, 1)
  })
  available = false
  assert.equal(
    days.withReads(() => days.resolve(source.sourceId)),
    null
  )
  assert.equal(reads, 2)
  assert.throws(() => days.withReads(() => Promise.resolve()), /must-be-synchronous/)
  available = true
  assert(days.withReads(() => days.resolve(source.sourceId)))
  f.db.prepare('UPDATE evidence_privacy SET revision=revision+1 WHERE id=1').run()
  assert.equal(
    days.withReads(() => days.resolve(source.sourceId)),
    null
  )
})

test('cached context rows recheck edits, app metadata, deletion and recreation independently of other writes', () => {
  const f = fixture()
  const references = f.store.proactive.dayAnalysisSources(f.day.id, ['source'])
  const original = required(f.store.proactive.dayAnalysisSourceEvidence(references))
  const read = () => f.store.proactive.dayAnalysisSourcesPermitted(references, 'allowed', () => true)
  assert.equal(read(), true)
  f.db.prepare('UPDATE workday SET active_duration_ms=active_duration_ms+1 WHERE id=?').run(f.day.id)
  assert.equal(read(), true)
  f.db.prepare("UPDATE context_evidence SET text='Changed private source' WHERE id='source'").run()
  assert.equal(read(), false)
  f.db.prepare('UPDATE context_evidence SET text=? WHERE id=?').run(original[0].text, 'source')
  assert.equal(read(), true)
  f.db.prepare("UPDATE application SET display_name='Changed app' WHERE bundle_id='com.example.editor'").run()
  assert.equal(read(), false)
  f.db.prepare("UPDATE application SET display_name='Editor' WHERE bundle_id='com.example.editor'").run()
  assert.equal(read(), true)
  f.db.exec("CREATE TEMP TABLE retained_context AS SELECT * FROM context_evidence WHERE id='source'")
  f.db.prepare("DELETE FROM context_evidence WHERE id='source'").run()
  assert.equal(read(), false)
  f.db.exec('INSERT INTO context_evidence SELECT * FROM retained_context')
  assert.equal(read(), true)
  f.db.prepare("UPDATE context_evidence SET window_title='Password' WHERE id='source'").run()
  assert.equal(read(), false)
})

test('compact admission reuses unchanged context policy outcomes but rechecks policy and offline intervals', () => {
  const f = fixture()
  const references = f.store.proactive.dayAnalysisSources(f.day.id, ['source'])
  let checks = 0
  const accept = () => {
    checks++
    return true
  }
  const read = () => f.store.proactive.dayAnalysisSourcesPermitted(references, 'allowed', accept)
  assert(read())
  assert(read())
  assert.equal(checks, 1)
  f.db.prepare('UPDATE workday SET active_duration_ms=active_duration_ms+1 WHERE id=?').run(f.day.id)
  assert(read())
  assert.equal(checks, 1)
  assert.equal(
    f.store.proactive.dayAnalysisSourcesPermitted(references, 'excluded', () => false),
    false
  )
  assert(read())
  assert.equal(checks, 2)
  f.db.prepare('INSERT INTO offline_period(id,started_at,ended_at) VALUES(?,?,NULL)').run('offline', f.now - 6_000)
  assert.equal(read(), false)
  f.db.prepare("DELETE FROM offline_period WHERE id='offline'").run()
  assert(read())
  assert.equal(checks, 2)
})

test('cached context revisions never alias another evidence kind with the same source ID', () => {
  const f = fixture()
  const references = f.store.proactive.dayAnalysisSources(f.day.id, ['source'])
  assert(f.store.proactive.dayAnalysisSourcesPermitted(references, 'allowed', () => true))
  f.db
    .prepare(
      "INSERT INTO audio_evidence(id,workday_id,source,started_at,duration_ms,status,transcript) VALUES(?,?,'microphone',?,1000,'ready','A distinct recording')"
    )
    .run('source', f.day.id, f.now - 2000)
  const collected = f.store.proactive.dayAnalysisSources(f.day.id, ['source', 'audio:source'])
  assert.equal(collected.length, 2)
  assert.notEqual(collected[0].revision, collected[1].revision)
  assert(f.store.proactive.dayAnalysisSourceEvidence(collected))
})

test('cooperative source warming grants no authority across its yield and stops on disposal', async () => {
  const f = fixture()
  const source = required(f.sync())
  const signal = new AbortController()
  const warming = f.store.proactive.warmDaySource(source.sourceId, 'allowed', () => true, signal.signal)
  f.db.prepare("UPDATE context_evidence SET text='Changed while warming yielded' WHERE id='source'").run()
  await warming
  assert.equal(f.store.proactive.resolve(source), null)
  const canceled = new AbortController()
  const pending = f.store.proactive.warmDaySource(source.sourceId, 'allowed', () => true, canceled.signal)
  canceled.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('retained projection caches detect direct edits and recreation without trusting an unchanged semantic revision', () => {
  const f = fixture()
  const source = required(f.sync())
  const read = () => f.store.proactive.resolve(source)
  assert(read())
  f.db.exec('CREATE TEMP TABLE retained_projection AS SELECT * FROM proactive_day_source')
  f.db
    .prepare("UPDATE proactive_day_source SET snapshot_json=json_set(snapshot_json,'$.text','Changed body') WHERE id=?")
    .run(source.sourceId)
  assert.equal(read(), null)
  f.db.prepare('DELETE FROM proactive_day_source WHERE id=?').run(source.sourceId)
  assert.equal(read(), null)
  f.db.exec('INSERT INTO proactive_day_source SELECT * FROM retained_projection')
  assert.deepEqual(read(), source)
  f.db.prepare("UPDATE context_evidence SET text='Revoked contributing context' WHERE id='source'").run()
  assert.equal(read(), null)
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-day-sync-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(file)
  cleanups.push(() => store.close())
  const db = new DatabaseSync(file)
  cleanups.push(() => db.close())
  const now = Date.now()
  const day: DailyReviewSession & { memory: DayMemory } = {
    id: 'day',
    startedAt: now - 3_600_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    contextMoments: [],
    appActivity: [],
    memory: {
      summary: 'Twee van de drie sollicitaties zijn voorbereid.',
      currentFocus: 'Derde passende vacature zoeken',
      outcomes: ['Twee concepten klaar'],
      decisions: ['Deze week drie sollicitaties indienen'],
      openLoops: ['Derde sollicitatie'],
      conversations: [],
      timeline: [],
      knowledgeSuggestions: [],
      refreshedAt: now,
      coveredThrough: now,
    },
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  }
  store.upsertSession(day)
  store.proactive.configureConsumer(true, now - 1_000)
  store.appendContextMoment(
    'day',
    {
      id: 'source',
      timestamp: now - 5_000,
      text: 'Raw private body should not be copied into the compact projection.',
      appName: 'Editor',
      windowTitle: 'Applications',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null,
    'com.example.editor'
  )
  const task = store.createWorkItem('Derde sollicitatie indienen', 'Kies een passende vacature voor vrijdag.')
  day.memory.analysisProvenance = {
    version: 1,
    workdayId: day.id,
    startedAt: day.startedAt,
    coveredThrough: now,
    rawEvidenceIds: ['source'],
    rawSources: store.proactive.dayAnalysisSources(day.id, ['source']),
    taskIds: [],
    agentMessages: [],
    wikiPages: [],
  }
  return {
    get store() {
      return store
    },
    db,
    day,
    now,
    task,
    sync(at = now) {
      store.upsertSession(day)
      return store.proactive.reconcileDaySync(day.id, store.listWorkItems(), at)
    },
    reopen() {
      store.close()
      store = new EvidenceStore(file)
    },
  }
}

function decision(f: ReturnType<typeof fixture>, source: ProactiveSource): ProactiveCommit {
  return {
    consumerGeneration: f.store.proactive.generation(),
    sources: [source],
    decision: {
      id: 'day-decision',
      kind: 'offer',
      text: 'Ik kan passende vacatures voor de derde sollicitatie zoeken.',
      topicKey: `task:${f.task.id}`,
      taskIds: [f.task.id],
      followUps: [],
      sourceIds: [source.evidenceId],
      supportingQuotes: [{ sourceId: source.evidenceId, quote: 'Derde sollicitatie indienen' }],
      createdAt: f.now + 300_000,
      expiresAt: f.now + 360_000,
      policyToken: 'current',
      conversationGeneration: 0,
    },
  }
}

test('large Day provenance is shared while pending, delivered and retry references survive compaction and restart', () => {
  const f = fixture()
  const provenance = required(f.day.memory.analysisProvenance ?? null)
  provenance.rawEvidenceIds = Array.from({ length: 4_000 }, (_, i) => `historical-evidence-${i}`)
  const source = required(f.sync())
  const storage = new ProactiveDayStorage(f.db)
  const stored = String(
    f.db.prepare('SELECT snapshot_json FROM proactive_day_source WHERE id=?').get(source.sourceId)?.snapshot_json
  )
  assert.ok(stored.length < 20_000)
  assert.deepEqual(f.store.proactive.daySourceProvenance(source), provenance)
  const saved = f.store.proactive.commit(decision(f, source))
  assert.equal(f.store.proactive.pendingDeliveries(f.now + 300_000).length, 1)
  assert.deepEqual(f.store.proactive.commit(decision(f, source)), saved)
  f.day.memory.summary = 'A later completed summary.'
  f.day.memory.refreshedAt += 300_000
  const next = required(f.sync(f.now + 300_000))
  assert.notEqual(next.sourceId, source.sourceId)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM proactive_day_payload').get()?.n, 1)
  assert.deepEqual(f.store.proactive.resolve(source), source)
  f.db.exec('BEGIN IMMEDIATE')
  storage.restoreInline()
  f.db.exec('COMMIT')
  assert.ok(
    String(
      f.db.prepare('SELECT snapshot_json FROM proactive_day_source WHERE id=?').get(source.sourceId)?.snapshot_json
    ).length > 90_000
  )
  assert.equal(storage.compactBatch(), 2)
  assert.equal(storage.compactBatch(), 0)
  assert.deepEqual(f.store.proactive.resolve(source), source)
  f.store.proactive.acknowledgeDelivery(saved.id, saved.inputHash, 'delivered-message', f.now + 300_001)
  f.reopen()
  assert.equal(f.store.proactive.get(saved.id)?.deliveredMessageId, 'delivered-message')
  assert.deepEqual(f.store.proactive.resolve(source), source)
  f.db.prepare("UPDATE context_evidence SET text='Revoked original evidence' WHERE id='source'").run()
  assert.equal(f.store.proactive.resolve(source), null)
})

test('Day payload migration isolates failed rows and prevents mutation or deletion of shared provenance', () => {
  const f = fixture()
  required(f.day.memory.analysisProvenance ?? null).rawEvidenceIds = Array.from(
    { length: 4_000 },
    (_, i) => `evidence-${i}`
  )
  const source = required(f.sync())
  const storage = new ProactiveDayStorage(f.db)
  assert.throws(() => f.db.exec("UPDATE proactive_day_payload SET compressed_json=x'00'"), /payload-immutable/)
  assert.throws(() => f.db.exec('DELETE FROM proactive_day_payload'), /payload-referenced/)
  f.db.exec('BEGIN IMMEDIATE')
  storage.restoreInline()
  f.db.exec('COMMIT')
  f.db.exec(
    "CREATE TRIGGER reject_compaction BEFORE UPDATE ON proactive_day_source BEGIN SELECT RAISE(ABORT,'failed-compaction'); END"
  )
  assert.equal(storage.compactBatch(), 1)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM proactive_day_payload').get()?.n, 0)
  assert.deepEqual(f.store.proactive.resolve(source), source)
  f.db.exec('DROP TRIGGER reject_compaction')
  f.db.exec('BEGIN IMMEDIATE')
  storage.restoreInline()
  f.db.exec('COMMIT')
  assert.equal(storage.compactBatch(), 1)
  assert.deepEqual(f.store.proactive.resolve(source), source)
  f.store.deleteSession(f.day.id)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM proactive_day_payload').get()?.n, 0)
})

test('a broken historical payload cannot roll back new Day publication or block later compaction', () => {
  const f = fixture()
  required(f.day.memory.analysisProvenance ?? null).rawEvidenceIds = Array.from(
    { length: 4_000 },
    (_, i) => `evidence-${i}`
  )
  const historical = required(f.sync())
  const stored = JSON.parse(
    String(
      f.db.prepare('SELECT snapshot_json FROM proactive_day_source WHERE id=?').get(historical.sourceId)?.snapshot_json
    )
  )
  stored.provenance = { _payloadRef: 'f'.repeat(64) }
  f.db
    .prepare('UPDATE proactive_day_source SET snapshot_json=? WHERE id=?')
    .run(JSON.stringify(stored), historical.sourceId)
  f.db.exec('DELETE FROM proactive_day_storage_migration')
  f.day.memory.summary = 'A new completed Day state.'
  f.day.memory.refreshedAt += 1
  const current = required(f.sync(f.now + 1))
  assert.notEqual(current.sourceId, historical.sourceId)
  assert.deepEqual(f.store.proactive.resolve(current), current)
  assert.equal(new ProactiveDayStorage(f.db).compactBatch(), 1)
  assert.equal(new ProactiveDayStorage(f.db).compactBatch(), 0)
  f.reopen()
  assert.deepEqual(f.store.proactive.resolve(current), current)
  assert.equal(new ProactiveDayStorage(f.db).compactBatch(), 0)
})

test('failed maintenance checkpoint writes leave new Day publication intact', () => {
  const f = fixture()
  required(f.sync())
  f.db.exec('DELETE FROM proactive_day_storage_migration')
  f.db.exec(
    "CREATE TRIGGER reject_storage_checkpoint BEFORE INSERT ON proactive_day_storage_migration BEGIN SELECT RAISE(ABORT,'failed-checkpoint'); END"
  )
  f.day.memory.summary = 'A fresh Day whose publication must survive maintenance failure.'
  f.day.memory.refreshedAt += 1
  const source = required(f.sync(f.now + 1))
  assert.deepEqual(f.store.proactive.resolve(source), source)
  assert.equal(f.db.prepare('SELECT id FROM proactive_day_storage_migration').get(), undefined)
  f.db.exec('DROP TRIGGER reject_storage_checkpoint')
})

test('completed Day storage migration is durable and its checkpoint follows the caller transaction', () => {
  const f = fixture()
  required(f.sync())
  const storage = new ProactiveDayStorage(f.db)
  assert.equal(storage.compactBatch(), 0)
  f.db.exec('BEGIN IMMEDIATE')
  storage.restoreInline()
  f.db.exec('COMMIT')
  f.db.exec('BEGIN IMMEDIATE')
  assert.equal(storage.compactBatch(), 1)
  f.db.exec('ROLLBACK')
  assert.equal(f.db.prepare('SELECT id FROM proactive_day_storage_migration').get(), undefined)
  assert.equal(storage.compactBatch(), 1)
  f.reopen()
  assert.equal(f.db.prepare('SELECT id FROM proactive_day_storage_migration').get()?.id, 1)
})

test('taskless Day offers persist contextual assessment memory without creating Tasks', () => {
  const f = fixture()
  f.db.prepare('DELETE FROM work_item WHERE id=?').run(f.task.id)
  const source = required(f.sync())
  const input = decision(f, source)
  input.decision.taskIds = []
  input.decision.topicKey = 'context:sollicitatie-verhaal'
  input.decision.supportingQuotes = [
    { sourceId: source.evidenceId, quote: 'Twee van de drie sollicitaties zijn voorbereid.' },
  ]
  input.decision.text = 'Zal ik de twee concepten in een kort verhaal samenbrengen?'
  const saved = f.store.proactive.commit(input)
  assert.deepEqual(f.store.listWorkItems(), [])
  f.store.proactive.acknowledgeDelivery(saved.id, saved.inputHash, 'message', input.decision.createdAt)
  f.reopen()
  const assessments = f.store.proactive.recentDayAssessments(input.decision.createdAt, () => true)
  assert.equal(assessments.length, 1)
  assert.equal(assessments[0]?.topicKey, 'context:sollicitatie-verhaal')
  assert.equal(assessments[0]?.delivered, true)
  assert.deepEqual(assessments[0]?.taskIds, [])
  assert.throws(
    () =>
      f.store.proactive.commit({
        ...input,
        decision: { ...input.decision, id: 'bad-topic', topicKey: 'task:invented' },
      }),
    /invalid-proactive-day-metadata/
  )
  assert.throws(
    () =>
      f.store.proactive.commit({
        ...input,
        decision: {
          ...input.decision,
          id: 'bad-quote',
          supportingQuotes: [{ sourceId: source.evidenceId, quote: 'derived-day-state' }],
        },
      }),
    /invalid-proactive-day-metadata/
  )
  f.store.deleteSession('day')
  assert.deepEqual(
    f.store.proactive.recentDayAssessments(input.decision.createdAt, () => true),
    []
  )
})

test('completed sync produces a compact durable source once across unchanged sync and restart', () => {
  const f = fixture()
  const source = f.sync()
  assert.ok(source)
  assert.equal(source.kind, 'day')
  assert.equal(source.provenance.inputRoute, 'day-sync')
  assert.equal(source.text.includes('Raw private body'), false)
  assert.deepEqual(f.store.proactive.daySourceTaskIds(source), [f.task.id])
  assert.equal(f.store.proactive.daySourceEvidence(source)?.[0]?.bundleId, 'com.example.editor')
  assert.equal(JSON.parse(source.text).changesSincePreviousSync.firstSnapshot, true)
  f.store.proactive.commit(decision(f, source))
  f.day.memory.refreshedAt += 600_000
  f.day.memory.coveredThrough += 600_000
  assert.equal(f.sync(f.now + 600_000)?.eventId, source.eventId)
  f.reopen()
  assert.equal(
    f.store.proactive.reconcileDaySyncs(f.store.listWorkItems(), f.now + 600_000)[0]?.eventId,
    source.eventId
  )
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM proactive_event WHERE kind='day'").get()?.n, 1)
  assert.deepEqual(
    f.store.proactive.batch(
      f.now + 600_000,
      (kind) => kind === 'day',
      () => true
    ),
    []
  )
})

test('new Day state preserves history while new task edits prevent stale publication', () => {
  const f = fixture()
  const previous = required(f.sync())
  f.day.memory.summary = 'Twee sollicitaties ingediend; een derde vacature wordt bekeken.'
  f.day.memory.refreshedAt += 300_000
  const next = required(f.sync(f.now + 300_000))
  assert.notEqual(next.eventId, previous.eventId)
  assert.ok(f.store.proactive.resolve(previous))
  assert.equal(f.store.proactive.daySourceCurrent(previous), false)
  assert.equal(f.store.proactive.daySourceCurrent(next), true)
  assert.deepEqual(JSON.parse(next.text).changesSincePreviousSync.changedDayFields, ['summary'])
  f.store.setWorkItemLifecycle(f.task.id, 'completed')
  assert.ok(f.store.proactive.resolve(next), 'an ordinary task edit does not erase historical context')
  assert.equal(f.store.proactive.daySourceCurrent(next), false)
  assert.throws(() => f.store.proactive.commit(decision(f, next)), /invalid-proactive-day-metadata/)
})

test('deleting a contributing source invalidates retained Day projections', () => {
  const f = fixture()
  const source = required(f.sync())
  f.db.prepare('DELETE FROM context_evidence WHERE id = ?').run('source')
  assert.equal(f.store.proactive.resolve(source), null)
  assert.equal(f.store.proactive.daySourceEvidence(source), null)
})

test('day freshness accommodates configured sync cadence and source/event commit is atomic', () => {
  const f = fixture()
  const source = required(f.sync())
  assert.equal(
    f.store.proactive.batch(
      f.now + 600_000,
      (kind) => kind === 'day',
      () => true
    )[0]?.eventId,
    source.eventId
  )
  f.db.exec(
    "CREATE TRIGGER reject_day_event BEFORE INSERT ON proactive_event WHEN NEW.kind = 'day' BEGIN SELECT RAISE(ABORT, 'injected-cut'); END"
  )
  f.day.memory.summary = 'Nieuwe inhoud'
  f.day.memory.refreshedAt += 900_000
  assert.throws(() => f.sync(f.now + 900_000), /injected-cut/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_day_source').get()?.n, 1)
  assert.equal(
    f.store.proactive.batch(
      f.now + 24 * 60 * 60_000 + 1,
      (kind) => kind === 'day',
      () => true
    ).length,
    0
  )
})

test('only post-enable completed syncs are reconciled and excluded tasks stay out of the payload', () => {
  const f = fixture()
  f.store.proactive.configureConsumer(false, f.now + 1)
  f.store.proactive.configureConsumer(true, f.now + 2)
  assert.equal(f.sync(f.now + 3), null)
  f.day.memory.refreshedAt += 10
  f.day.refresh.status = 'refreshing'
  assert.equal(f.sync(f.now + 10), null)
  f.day.refresh.status = 'idle'
  f.store.upsertSession(f.day)
  const source = required(f.store.proactive.reconcileDaySync(f.day.id, [], f.now + 10))
  assert.equal(source.text.includes(f.task.title), false)
  assert.deepEqual(f.store.proactive.daySourceTaskIds(source), [])
})

test('a legacy Day without synthesis lineage exposes admitted Tasks but omits the generated summary', () => {
  const f = fixture()
  delete f.day.memory.analysisProvenance
  const source = required(f.sync())
  assert.equal(JSON.parse(source.text).day.summary, '')
  assert.equal(JSON.parse(source.text).tasks[0].title, f.task.title)
  assert.equal(f.store.proactive.daySourceProvenance(source), null)
})

test('same semantic state can acquire fresh valid lineage without resurrecting a revoked snapshot', () => {
  const f = fixture()
  const previous = required(f.sync())
  f.store.proactive.commit(decision(f, previous))
  f.db.prepare('DELETE FROM context_evidence WHERE id = ?').run('source')
  f.store.appendContextMoment(
    f.day.id,
    {
      id: 'replacement-source',
      timestamp: f.now + 400_000,
      text: 'The same application state was independently observed again.',
      appName: 'Editor',
      windowTitle: 'Applications',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null,
    'com.example.editor'
  )
  f.day.memory.refreshedAt = f.now + 400_000
  f.day.memory.coveredThrough = f.now + 400_000
  const provenance = required(f.day.memory.analysisProvenance ?? null)
  provenance.rawEvidenceIds = ['replacement-source']
  provenance.rawSources = f.store.proactive.dayAnalysisSources(f.day.id, provenance.rawEvidenceIds)
  const next = required(f.sync(f.now + 400_000))
  assert.notEqual(next.sourceId, previous.sourceId)
  assert.equal(next.contentKey, previous.contentKey)
  assert.equal(f.store.proactive.resolve(previous), null)
  assert.ok(f.store.proactive.resolve(next))
  assert.equal(f.sync(f.now + 400_001)?.sourceId, next.sourceId)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_day_source').get()?.n, 2)
  assert.deepEqual(
    f.store.proactive
      .batch(
        f.now + 400_001,
        (kind) => kind === 'day',
        () => true
      )
      .map((source) => source.sourceId),
    [next.sourceId]
  )
})

test('Remember surface evidence does not establish a user commitment; later human adoption remains available', () => {
  const f = fixture()
  f.store.appendContextMoment(
    f.day.id,
    {
      id: 'own-output',
      timestamp: f.now - 1_000,
      text: 'Remember generated a suggestion. No human request is recorded.',
      appName: 'Remember QA',
      windowTitle: 'Remember QA',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null,
    'computer.remember.qa'
  )
  f.db
    .prepare("UPDATE work_item_source SET kind='observed',workday_id=?,observed_at=? WHERE work_item_id=?")
    .run(f.day.id, f.now - 1_000, f.task.id)
  f.db.prepare("UPDATE work_item_fact SET actor='system' WHERE work_item_id=?").run(f.task.id)
  const source = required(f.sync())
  const task = JSON.parse(source.text).tasks[0]
  assert.equal(task.userOwned, false)
  assert.equal(task.proactiveEligible, false)
  assert.equal(task.uncertainty, 'self-observation-without-user-adoption')
  assert.deepEqual(task.sourceOrigins, ['remember'])
  assert.equal(task.sourceExcerpts[0].evidenceId, 'own-output')
  f.store.updateWorkItem(f.task.id, f.task.title, 'Ik wil deze concrete stap zelf afronden.')
  const adopted = required(f.sync())
  assert.equal(JSON.parse(adopted.text).tasks[0].userOwned, true)
  assert.equal(JSON.parse(adopted.text).tasks[0].proactiveEligible, true)
  f.db.prepare("UPDATE context_evidence SET text='Changed source' WHERE id='own-output'").run()
  assert.equal(f.store.proactive.resolve(adopted), null, 'quoted task evidence is independently revocable')
})

test('live completion observations prevent reminders and participate in current and historical validation', () => {
  const f = fixture()
  const before = required(f.sync())
  const observedAt = Math.max(f.now, f.task.updatedAt) + 1
  f.db
    .prepare(`INSERT INTO work_item_observation
    (id,work_item_id,kind,summary,confidence,workday_id,observed_at,dismissed_at,dedupe_key)
    VALUES ('completion',?,'completion_candidate','A submission confirmation was displayed.',1,?,?,NULL,'completion')`)
    .run(f.task.id, f.day.id, observedAt)
  assert.equal(f.store.proactive.daySourceCurrent(before), false)
  const source = required(f.sync(observedAt + 1))
  const task = JSON.parse(source.text).tasks[0]
  assert.equal(task.lifecycle, 'open')
  assert.equal(task.proactiveEligible, false)
  assert.equal(task.uncertainty, 'completion-observed-but-lifecycle-open')
  assert.equal(task.observations[0].kind, 'completion_candidate')
  assert.equal(source.text.includes('A submission confirmation was displayed.'), false)
  assert.equal('summary' in task.observations[0], false)
  f.db.prepare("UPDATE work_item_observation SET summary='Corrected observation' WHERE id='completion'").run()
  assert.equal(f.store.proactive.resolve(source), null)
})

test('projection prioritizes human priority and due dates while keeping bounded actionable context', () => {
  const f = fixture()
  const first = f.store.createWorkItem('First important task', 'A concrete human action.')
  const due = f.store.createWorkItem('Due important task', 'Another concrete human action.')
  f.store.updateWorkItemMetadata(first.id, { status: 'todo', priority: 'high', dueAt: null })
  f.store.updateWorkItemMetadata(due.id, { status: 'todo', priority: 'high', dueAt: f.now + 60_000 })
  for (let i = 0; i < 25; i++) f.store.createWorkItem(`Other task ${i}`, 'Long context '.repeat(200))
  const source = required(f.sync())
  const payload = JSON.parse(source.text)
  assert.equal(payload.tasks[0].id, due.id)
  assert.equal(payload.tasks[1].id, first.id)
  assert.equal(payload.tasks[0].description, 'Another concrete human action.')
  assert.equal('returnPoint' in payload.tasks[0], false)
  assert.equal(payload.tasks[0].userFacts[0].type, 'edited')
  assert.ok(source.text.length < 48_000)
  assert.ok(JSON.stringify(payload.tasks).length < 24_000)
  assert.ok(payload.omittedTaskCount > 0)
})

test('scheduled reviews keep original Day age and use fresh Task checks with separate immutable slots', () => {
  const f = fixture()
  const initial = required(f.sync())
  const clock = new Date(f.now + 2 * 24 * 60 * 60_000)
  clock.setHours(14, 0, 0, 0)
  const at = clock.getTime()
  const source = required(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), at))
  const payload = JSON.parse(source.text)
  assert.equal(source.observedAt, at)
  assert.equal(source.provenance.inputRoute, 'day-review')
  assert.equal(payload.refreshedAt, f.now)
  assert.equal(payload.taskStateCheckedAt, at)
  assert.equal(payload.daySummaryOmitted, true)
  assert.equal(payload.day.summary, '')
  assert.equal(f.store.proactive.daySourceProvenance(source), null)
  assert.notEqual(source.sourceId, initial.sourceId)
  const commit = decision(f, source)
  commit.decision.createdAt = at + 1_000
  commit.decision.expiresAt = at + 60_000
  f.store.proactive.commit(commit)
  const next = required(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), at + 3 * 60 * 60_000 + 1_000))
  assert.notEqual(next.sourceId, source.sourceId)
  assert.notEqual(next.contentKey, source.contentKey)
  assert.equal(f.store.proactive.resolve(source)?.sourceId, source.sourceId)
})

test('a considered review is the same semantic checkpoint for later sync and restart', () => {
  const f = fixture()
  f.store.upsertSession(f.day)
  const clock = new Date(f.now + 24 * 60 * 60_000)
  clock.setHours(10, 0, 0, 0)
  const at = clock.getTime()
  f.day.memory.refreshedAt = at
  f.day.memory.coveredThrough = at
  f.store.upsertSession(f.day)
  const reviewed = required(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), at))
  const commit = decision(f, reviewed)
  commit.decision.createdAt = at + 1_000
  commit.decision.expiresAt = at + 60_000
  f.store.proactive.commit(commit)
  f.reopen()
  assert.equal(
    f.store.proactive.reconcileDaySync(f.day.id, f.store.listWorkItems(), at + 2_000)?.sourceId,
    reviewed.sourceId
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM proactive_day_source').get()?.n, 1)
  f.db.prepare("DELETE FROM context_evidence WHERE id='source'").run()
  assert.equal(f.store.proactive.reconcileDaySync(f.day.id, f.store.listWorkItems(), at + 3_000), null)
  assert.equal(f.store.proactive.resolve(reviewed), null, 'a semantic checkpoint never revives deleted evidence')
})

test('admitted Day projection includes bounded project estimates with coverage, not measured hours', () => {
  const f = fixture()
  f.day.memory.projectAttention = [{ project: 'Woub', durationMinutes: 75, description: 'Estimated' }]
  const source = required(f.sync())
  const value = JSON.parse(source.text)
  assert.deepEqual(value.day.projectAttention, {
    basis: 'model-estimated-project-attention-not-measured-work-hours',
    coverageThrough: f.now,
    refreshedAt: f.now,
    projects: [{ project: 'Woub', durationMinutes: 75 }],
  })
  f.day.memory.analysisProvenance = undefined
  f.day.memory.refreshedAt += 1
  const legacy = required(f.sync(f.now + 1))
  assert.equal(JSON.parse(legacy.text).day.projectAttention, undefined)
})

test('older projections remain current without gaining newly exposed project estimates', () => {
  const f = fixture()
  const source = required(f.sync())
  f.day.memory.projectAttention = [{ project: 'Woub', durationMinutes: 75, description: 'Estimated' }]
  f.store.upsertSession(f.day)
  assert.equal(f.store.proactive.daySourceCurrent(source), true)
  assert.equal(JSON.parse(source.text).day.projectAttention, undefined)
  f.day.memory.summary = 'Changed summary'
  f.store.upsertSession(f.day)
  assert.equal(f.store.proactive.daySourceCurrent(source), false)
})

test('a later Day sync does not replace the snapshot selected at the start of a chat turn', () => {
  const f = fixture()
  const first = required(f.sync())
  f.day.memory.summary = 'A newer summary'
  f.day.memory.refreshedAt = f.now + 1000
  const second = required(f.sync(f.now + 1000))
  assert.equal(f.store.proactive.latestDaySync(f.day.id)?.sourceId, second.sourceId)
  assert.equal(f.store.proactive.latestDaySync(f.day.id, f.now)?.sourceId, first.sourceId)
  assert.equal(f.store.proactive.latestDaySync(f.day.id, f.now - 1), null)
  f.db.prepare('DELETE FROM context_evidence WHERE id = ?').run('source')
  assert.equal(f.store.proactive.latestDaySync(f.day.id, f.now), null)
})

test('batched Day context validation keeps revision, day identity and offline checks', () => {
  const f = fixture()
  const sources = f.store.proactive.dayAnalysisSources(f.day.id, ['source'])
  assert.equal(f.store.proactive.dayAnalysisSourceEvidence(sources)?.length, 1)
  assert.equal(f.store.proactive.dayAnalysisSourceEvidence([{ ...sources[0], workdayId: 'other-day' }]), null)
  assert.equal(f.store.proactive.dayAnalysisSourceEvidence([{ ...sources[0], sourceId: 'missing' }]), null)
  f.db.prepare('UPDATE context_evidence SET window_title = ? WHERE id = ?').run('Changed title', 'source')
  assert.equal(f.store.proactive.dayAnalysisSourceEvidence(sources), null)
  const current = f.store.proactive.dayAnalysisSources(f.day.id, ['source'])
  assert.equal(f.store.proactive.dayAnalysisSourceEvidence(current)?.length, 1)
  f.store.beginOfflinePeriod(f.now - 10_000)
  assert.equal(f.store.proactive.dayAnalysisSourceEvidence(current), null)
})
