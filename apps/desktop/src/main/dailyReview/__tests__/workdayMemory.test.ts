import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { DailyReviewSession, DayAnalysisProvenance } from '@remember/shared'
import { EvidenceStore } from '../evidenceStore'
import { restoreInlineWorkdayMemory } from '../workdayMemory'

test('separates analysis lineage from frequent day writes without losing it across edits, old writers, restart or deletion', () => {
  const path = join(tmpdir(), `remember-memory-${randomUUID()}.sqlite`)
  let store = new EvidenceStore(path)
  const db = new DatabaseSync(path)
  try {
    const provenance: DayAnalysisProvenance = {
      version: 1,
      workdayId: 'day',
      startedAt: 1000,
      coveredThrough: 2000,
      rawEvidenceIds: Array.from({ length: 2000 }, (_, i) => `context-${i}`),
      rawSources: Array.from({ length: 2000 }, (_, i) => ({
        kind: 'context',
        sourceId: `context-${i}`,
        workdayId: 'day',
        revision: `revision-${i}`,
      })),
      taskIds: [],
      agentMessages: [],
      wikiPages: [],
    }
    const session: DailyReviewSession = {
      id: 'day',
      startedAt: 1000,
      endedAt: null,
      activeDurationMs: 0,
      moments: [],
      contextMoments: [],
      appActivity: [],
      refresh: { status: 'idle', reason: null, targetThrough: null, error: null, progress: null, run: null },
      memory: {
        analysisProvenance: provenance,
        summary: 'Analysis',
        currentFocus: null,
        outcomes: [],
        decisions: [],
        openLoops: [],
        projectAttention: [],
        conversations: [],
        knowledgeSuggestions: [],
        timeline: [],
        refreshedAt: 2000,
        coveredThrough: 2000,
      },
    }
    store.upsertSession(session)
    assert.ok(String(db.prepare('SELECT memory_json FROM workday').get()?.memory_json).length < 1000)
    assert.deepEqual(store.readSessions()[0]?.memory, session.memory)
    // Monitor the provenance table itself across independent main-store commits.
    db.exec(
      'CREATE TABLE provenance_writes(n INTEGER); CREATE TRIGGER track_provenance_insert AFTER INSERT ON workday_analysis_provenance BEGIN INSERT INTO provenance_writes VALUES(1); END; CREATE TRIGGER track_provenance_update AFTER UPDATE ON workday_analysis_provenance BEGIN INSERT INTO provenance_writes VALUES(1); END;'
    )
    assert.ok(session.memory)
    const memory = session.memory
    store.upsertSession({
      ...session,
      activeDurationMs: 500,
      memory: {
        ...session.memory,
        conversations: [
          { startTime: '00:00', endTime: '00:01', title: 'Saved conversation', description: '', notes: 'Final note' },
        ],
      },
    })
    assert.equal(db.prepare('SELECT count(*) AS n FROM provenance_writes').get()?.n, 0)
    assert.deepEqual(store.readSessions()[0]?.memory?.analysisProvenance, provenance)
    db.exec("CREATE TRIGGER reject_day_write BEFORE UPDATE ON workday BEGIN SELECT RAISE(ABORT, 'blocked-write'); END;")
    assert.throws(
      () =>
        store.upsertSession({
          ...session,
          memory: { ...memory, analysisProvenance: { ...provenance, taskIds: ['new-task'] } },
        }),
      /blocked-write/
    )
    assert.equal(db.prepare('SELECT count(*) AS n FROM workday_analysis_provenance').get()?.n, 1)
    assert.deepEqual(store.readSessions()[0]?.memory?.analysisProvenance, provenance)
    db.exec('DROP TRIGGER reject_day_write')
    // Mutating content without changing its object identity must also be persisted.
    const firstSource = provenance.rawSources[0]
    assert.ok(firstSource)
    firstSource.revision = 'new-revision'
    store.upsertSession(session)
    assert.equal(db.prepare('SELECT count(*) AS n FROM workday_analysis_provenance').get()?.n, 1)
    assert.equal(store.readSessions()[0]?.memory?.analysisProvenance?.rawSources[0]?.revision, 'new-revision')
    store.close()
    store = new EvidenceStore(path)
    assert.deepEqual(store.readSessions()[0]?.memory, session.memory)
    // Older writers still provide inline provenance; it wins over a retained reference.
    const persisted = JSON.parse(String(db.prepare('SELECT memory_json FROM workday').get()?.memory_json))
    db.prepare('UPDATE workday SET memory_json=?').run(
      JSON.stringify({ ...persisted, analysisProvenance: { ...provenance, taskIds: ['old-writer-task'] } })
    )
    assert.deepEqual(store.readSessions()[0]?.memory?.analysisProvenance?.taskIds, ['old-writer-task'])
    store.upsertSession(session)
    store.close()
    assert.equal(restoreInlineWorkdayMemory(db), 1)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 16)
    assert.deepEqual(
      JSON.parse(String(db.prepare('SELECT memory_json FROM workday').get()?.memory_json)),
      session.memory
    )
    assert.equal(restoreInlineWorkdayMemory(db), 0)
    store = new EvidenceStore(path)
    assert.deepEqual(store.readSessions()[0]?.memory, session.memory)
    store.upsertSession(session)
    store.deleteSession('day')
    assert.equal(db.prepare('SELECT count(*) AS n FROM workday_analysis_provenance').get()?.n, 0)
  } finally {
    store.close()
    db.close()
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
  }
})
