import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { DayMemory } from '@remember/shared'
import { EvidenceStore } from '../evidenceStore'
import { PROACTIVE_DAY_REVIEW_INTERVAL_MS, type ProactiveCommit, type ProactiveSource } from '../proactiveStore'

function fixture(t: { after(fn: () => void): void }, hour = 10) {
  const directory = mkdtempSync('/private/tmp/remember-day-schedule-')
  const file = join(directory, 'evidence.sqlite')
  let store = new EvidenceStore(file)
  const db = new DatabaseSync(file)
  const now = new Date(2026, 9, 28, hour).getTime()
  store.upsertSession({
    id: 'day',
    localDay: '2026-10-28',
    startedAt: now - 60_000,
    endedAt: null,
    activeDurationMs: 0,
    moments: [],
    appActivity: [],
    contextMoments: [],
    memory: {
      summary: '',
      currentFocus: '',
      outcomes: [],
      decisions: [],
      openLoops: [],
      refreshedAt: now,
      coveredThrough: now,
    } as unknown as DayMemory,
    refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
  })
  const task = store.createWorkItem('Prepare the agreed proposal', 'Compare the two known options.')
  store.proactive.configureConsumer(true, now)
  t.after(() => {
    store.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    get store() {
      return store
    },
    db,
    now,
    task,
    review(at = now) {
      const source = store.proactive.reconcileDayReview(store.listWorkItems(), at)
      assert(source)
      return source
    },
    reopen() {
      store.close()
      store = new EvidenceStore(file)
    },
    commit(source: ProactiveSource, at: number, followUps: ProactiveCommit['decision']['followUps'] = []) {
      return store.proactive.commit({
        consumerGeneration: store.proactive.generation(),
        sources: [source],
        decision: {
          id: `decision:${source.eventId}:${at}`,
          kind: 'silent',
          text: '',
          topicKey: '',
          sourceIds: [],
          supportingQuotes: [],
          createdAt: at,
          expiresAt: at + 120_000,
          policyToken: 'policy',
          conversationGeneration: 0,
          taskIds: [],
          followUps,
        },
      })
    },
  }
}

test('scheduled review survives restart and consumes an unchanged state only once per due slot', (t) => {
  const f = fixture(t)
  assert.equal(f.store.proactive.dayReviewDue(f.now), true)
  const first = f.review()
  assert.equal(f.store.proactive.dayReviewDue(f.now + 1), false)
  f.reopen()
  assert.equal(f.review(f.now + 5 * 60_000).eventId, first.eventId)
  const completedAt = f.now + 5 * 60_000
  f.commit(first, completedAt)
  f.reopen()
  assert.equal(f.store.proactive.dayReviewDue(completedAt + PROACTIVE_DAY_REVIEW_INTERVAL_MS - 1), false)
  const second = f.review(completedAt + PROACTIVE_DAY_REVIEW_INTERVAL_MS)
  assert.notEqual(second.eventId, first.eventId)
  assert.equal(JSON.parse(second.text).tasks[0].id, f.task.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM proactive_day_review').get()?.count, 2)
})

test('an ordinary pending Day assessment satisfies a due review without a second source', (t) => {
  const f = fixture(t)
  const ordinary = f.store.proactive.reconcileDaySync('day', f.store.listWorkItems(), f.now)
  assert(ordinary)
  assert.equal(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), f.now), null)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM proactive_day_review').get()?.count, 0)
  f.reopen()
  assert.equal(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), f.now + 5 * 60_000), null)
  const pending = f.store.proactive.batch(
    f.now + 5 * 60_000,
    () => true,
    () => true
  )
  assert.deepEqual(
    pending.map((source) => source.eventId),
    [ordinary.eventId]
  )
  f.commit(ordinary, f.now + 5 * 60_000)
  assert.equal(f.store.proactive.dayReviewDue(f.now + 10 * 60_000), false)
  const next = f.review(f.now + 5 * 60_000 + PROACTIVE_DAY_REVIEW_INTERVAL_MS)
  assert.notEqual(next.eventId, ordinary.eventId)
})

test('an excluded ordinary Day assessment does not block later scheduled reconsideration', (t) => {
  const f = fixture(t)
  assert(f.store.proactive.reconcileDaySync('day', f.store.listWorkItems(), f.now))
  assert.equal(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), f.now), null)
  assert.deepEqual(
    f.store.proactive.batch(
      f.now,
      () => true,
      () => false
    ),
    []
  )
  assert(f.store.proactive.reconcileDayReview(f.store.listWorkItems(), f.now + 5 * 60_000))
})

test('night, due milestones and disable/regrant use durable clock and generation fences', (t) => {
  const f = fixture(t, 21)
  f.store.updateWorkItemMetadata(f.task.id, { status: 'todo', priority: 'high', dueAt: f.now + 60 * 60_000 })
  const source = f.review()
  f.commit(source, f.now)
  assert.equal(f.store.proactive.dayReviewDue(f.now + 60 * 60_000), false)
  const morning = new Date(2026, 9, 29, 8).getTime()
  assert.equal(f.store.proactive.dayReviewDue(morning), true)
  f.store.proactive.configureConsumer(false, morning)
  assert.equal(f.store.proactive.dayReviewDue(morning), false)
  f.store.proactive.configureConsumer(true, morning)
  assert.throws(() => f.commit(source, morning), /proactive-source-changed/)
  assert(f.review(morning))
})

test('future follow-up memory survives reopen, respects current access and drops completed Tasks', (t) => {
  const f = fixture(t)
  const source = f.review()
  f.commit(source, f.now, [
    {
      taskId: f.task.id,
      note: 'Check whether the two options are ready to compare.',
      nextReviewAt: f.now + 4 * 60 * 60_000,
    },
  ])
  f.reopen()
  const remembered = f.store.proactive.recentDayAssessments(f.now + 1, () => true)
  assert.equal(remembered.length, 1)
  assert.equal(remembered[0].followUps[0].taskId, f.task.id)
  assert.deepEqual(
    f.store.proactive.recentDayAssessments(f.now + 1, () => false),
    []
  )
  f.store.setWorkItemLifecycle(f.task.id, 'completed')
  assert.deepEqual(
    f.store.proactive.recentDayAssessments(f.now + 2, () => true),
    []
  )
  const next = f.review(f.now + PROACTIVE_DAY_REVIEW_INTERVAL_MS)
  f.commit(next, f.now + PROACTIVE_DAY_REVIEW_INTERVAL_MS)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM proactive_follow_up').get()?.count, 0)
})

test('history source-read reuse never survives a source deletion between invocations', (t) => {
  const f = fixture(t)
  f.store.appendContextMoment(
    'day',
    {
      id: 'raw-source',
      timestamp: f.now - 1,
      text: 'Prepare the agreed proposal.',
      appName: 'Editor',
      windowTitle: 'Proposal',
      textSource: 'accessibility',
      trigger: 'content-change',
      monitorName: '',
      screenshotPath: '',
    },
    null,
    'example.editor'
  )
  const memory = JSON.parse(String(f.db.prepare('SELECT memory_json FROM workday WHERE id=?').get('day')?.memory_json))
  memory.analysisProvenance = {
    version: 1,
    workdayId: 'day',
    startedAt: f.now - 60_000,
    coveredThrough: f.now,
    rawEvidenceIds: ['raw-source'],
    rawSources: f.store.proactive.dayAnalysisSources('day', ['raw-source']),
    taskIds: [],
    wikiPages: [],
    agentMessages: [],
  }
  f.db.prepare('UPDATE workday SET memory_json=? WHERE id=?').run(JSON.stringify(memory), 'day')
  const source = f.store.proactive.reconcileDaySync('day', f.store.listWorkItems(), f.now)
  assert(source)
  f.commit(source, f.now, [
    { taskId: f.task.id, note: 'Review the proposal later.', nextReviewAt: f.now + 4 * 60 * 60_000 },
  ])
  const read = () =>
    f.store.proactive.recentDayAssessments(
      f.now + 1,
      (entry) => f.store.proactive.daySourceEvidence(entry)?.length === 1
    )
  assert.equal(read().length, 1)
  f.db.prepare('DELETE FROM context_evidence WHERE id=?').run('raw-source')
  assert.deepEqual(read(), [])
})

test('Day commit rejects invented task identities and extra follow-up authority', (t) => {
  const f = fixture(t)
  const source = f.review()
  for (const followUp of [
    { taskId: 'missing', note: 'Do work', nextReviewAt: f.now + 4 * 60 * 60_000 },
    { taskId: f.task.id, note: 'Do work', nextReviewAt: f.now - 1 },
    { taskId: f.task.id, note: 'Do work', nextReviewAt: f.now + 4 * 60 * 60_000, execute: true },
  ])
    assert.throws(() => f.commit(source, f.now, [followUp]), /invalid-proactive-day-metadata/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM proactive_decision').get()?.count, 0)
  assert.equal(f.db.prepare('SELECT decision_id FROM proactive_day_review').get()?.decision_id, null)
})

test('expired and excluded pending reviews get fresh attempts without resurrecting the old event', (t) => {
  const f = fixture(t)
  const first = f.review()
  f.reopen()
  const afterSleep = f.now + 25 * 60 * 60_000
  const second = f.review(afterSleep)
  assert.notEqual(second.eventId, first.eventId)
  assert.equal(second.observedAt, afterSleep)
  f.store.proactive.batch(
    afterSleep,
    () => true,
    () => false
  )
  const third = f.review(afterSleep + 5 * 60_000)
  assert.notEqual(third.eventId, second.eventId)
  assert.equal(third.observedAt, afterSleep + 5 * 60_000)
  f.commit(third, afterSleep + 5 * 60_000)
  f.reopen()
  assert.equal(f.store.proactive.dayReviewDue(afterSleep + 10 * 60_000), false)
})

test('a lost next-review write rolls back the decision and considered receipt', (t) => {
  const f = fixture(t)
  const source = f.review()
  f.db.exec('CREATE TRIGGER drop_schedule BEFORE UPDATE ON proactive_day_schedule BEGIN SELECT RAISE(IGNORE); END;')
  assert.throws(() => f.commit(source, f.now), /proactive-write-not-persisted/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM proactive_decision').get()?.count, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM proactive_considered').get()?.count, 0)
  assert.equal(f.db.prepare('SELECT decision_id FROM proactive_day_review').get()?.decision_id, null)
})
