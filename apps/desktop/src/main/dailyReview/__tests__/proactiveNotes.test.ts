import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, test } from 'node:test'
import type { DictationNote } from '@remember/shared'
import { EvidenceStore } from '../evidenceStore'
import { type ProactiveCommit, ProactiveStore } from '../proactiveStore'

const NOW = 1_800_000_000_000
const ID = '87ed5d70-7907-407a-b976-3e2150771025'
type Snapshot =
  | {
      state: 'available'
      epoch: string
      sequence: number
      notes: {
        note: DictationNote
        incarnation: string
        revision: number
        contentHash: string
        completedAt: number | null
      }[]
      tombstones: Record<string, { incarnation: string; revision: number; deletedAt: number }>
    }
  | { state: 'missing' }
  | { state: 'unavailable'; reason: 'not-ready' | 'invalid' | 'unreadable' }

function snapshot(): Extract<Snapshot, { state: 'available' }> {
  const text = 'The release checklist is missing its rollback link.'
  return {
    state: 'available',
    epoch: '7ff720e5-1829-44df-a1e0-e5c937991685',
    sequence: 1,
    notes: [
      {
        note: {
          id: ID,
          text,
          status: 'completed',
          createdAt: NOW - 30_000,
          durationMs: 4_000,
          error: null,
          hasAudio: false,
        },
        incarnation: '83f27963-bc40-4ee8-a51e-4d6519fb3efb',
        revision: 1,
        contentHash: createHash('sha256').update(text).digest('hex'),
        completedAt: NOW,
      },
    ],
    tombstones: {},
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'remember-note-projection-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'evidence.sqlite')
  const evidence = new EvidenceStore(file)
  cleanups.push(() => evidence.close())
  let db = new DatabaseSync(file)
  let current: Snapshot = snapshot()
  let store = new ProactiveStore(db, { noteSnapshot: () => current })
  cleanups.push(() => db.close())
  const generation = store.configureConsumer(true, NOW - 1)
  return {
    evidence,
    generation,
    get db() {
      return db
    },
    get store() {
      return store
    },
    get current() {
      return current
    },
    set current(value: Snapshot) {
      current = value
    },
    reopen() {
      db.close()
      db = new DatabaseSync(file)
      store = new ProactiveStore(db, { noteSnapshot: () => current })
    },
    batch(at = NOW + 1) {
      return store.batch(
        at,
        () => true,
        () => true
      )
    },
    rows(table: string) {
      return db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...row }))
    },
  }
}

function input(f: ReturnType<typeof fixture>, kind: ProactiveCommit['decision']['kind'] = 'offer'): ProactiveCommit {
  const sources = f.batch()
  return {
    consumerGeneration: f.generation,
    sources,
    decision: {
      id: 'note-decision',
      kind,
      text: 'Check the rollback link.',
      topicKey: 'release-link',
      sourceIds: sources.map((source) => source.evidenceId),
      supportingQuotes: sources.map((source) => ({ sourceId: source.evidenceId, quote: source.text })),
      createdAt: NOW + 1,
      expiresAt: NOW + 60_000,
      policyToken: 'note-policy',
      conversationGeneration: 0,
    },
  }
}

test('saved Note projects exact source identity and unknown provenance without a fake Day or speech', () => {
  const f = fixture()
  assert.equal(f.store.hasNoteSources(), false)
  assert.equal(f.store.notesAvailable(), true)
  f.store.reconcileNotes(NOW)
  const [source] = f.batch()
  assert.equal(source?.kind, 'note')
  assert.equal(source?.evidenceId, `note:${ID}`)
  assert.equal(source?.sourceId, ID)
  assert.equal(source?.workdayId, '')
  assert.equal(source?.source, 'saved-note')
  assert.deepEqual(source?.provenance, { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'saved-note' })
  assert.equal(source?.observedAt, NOW)
  assert.equal(f.store.hasNoteSources(), true)
  assert.deepEqual(f.rows('workday'), [])
  assert.deepEqual(f.rows('speech_segment'), [])
  assert.deepEqual(f.rows('ambient_task_evidence'), [])
  assert.doesNotMatch(JSON.stringify(f.rows('proactive_note_source')), /release checklist/)
})

test('duplicate reconciliation and reopen preserve one event and original timestamps', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  const first = f.batch()
  const rows = f.rows('proactive_event')
  f.store.reconcileNotes(NOW + 10)
  f.reopen()
  f.store.reconcileNotes(NOW + 20)
  assert.deepEqual(f.rows('proactive_event'), rows)
  assert.deepEqual(f.batch(), first)
})

for (const variant of ['legacy', 'processing', 'failed', 'empty'] as const) {
  test(`${variant} Note records metadata without an analysis event`, () => {
    const f = fixture()
    const value = snapshot()
    const note = value.notes[0]!
    if (variant === 'legacy') note.completedAt = null
    else if (variant === 'empty') note.note.text = ''
    else note.note.status = variant
    f.current = value
    f.store.reconcileNotes(NOW)
    assert.equal(f.store.hasNoteSources(), true)
    assert.deepEqual(f.rows('proactive_event'), [])
    assert.deepEqual(f.batch(), [])
  })
}

test('canonical deletion before SQLite reconciliation immediately refuses the old reference', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  const source = f.batch()[0]!
  f.current = {
    ...snapshot(),
    sequence: 2,
    notes: [],
    tombstones: { [ID]: { incarnation: snapshot().notes[0]!.incarnation, revision: 2, deletedAt: NOW + 2 } },
  }
  assert.equal(f.store.resolve(source), null)
  assert.throws(
    () => f.store.commit({ ...input(f), sources: [source] }),
    /proactive-source-changed|invalid-proactive-decision/
  )
  f.store.reconcileNotes(NOW + 2)
  assert.equal(f.store.hasNoteSources(), true)
  assert.deepEqual(f.batch(), [])
})

test('status/revision changes and supported re-add cannot revive an old reference', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  const source = f.batch()[0]!
  const changed = snapshot()
  changed.sequence++
  changed.notes[0]!.revision++
  changed.notes[0]!.note.status = 'processing'
  f.current = changed
  assert.equal(f.store.resolve(source), null)
  f.store.reconcileNotes(NOW + 1)
  const added = snapshot()
  added.sequence = 3
  added.notes[0]!.incarnation = '9ad962fe-1b9a-4974-b731-75b562d6c279'
  added.notes[0]!.completedAt = NOW + 2
  f.current = added
  f.store.reconcileNotes(NOW + 2)
  assert.equal(f.store.resolve(source), null)
  assert.notEqual(f.batch(NOW + 3)[0]?.eventRevision, source.eventRevision)
})

for (const state of ['missing', 'unavailable'] as const) {
  test(`${state} canonical history defers pending event and decision without consuming or invalidating`, () => {
    const f = fixture()
    f.store.reconcileNotes(NOW)
    const source = f.batch()[0]!
    const event = f.rows('proactive_event')
    f.current = state === 'missing' ? { state } : { state, reason: 'unreadable' }
    assert.equal(f.store.notesAvailable(), false)
    f.store.reconcileNotes(NOW + 1)
    assert.equal(f.store.resolve(source), null)
    assert.deepEqual(f.batch(), [])
    assert.deepEqual(f.rows('proactive_considered'), [])
    f.current = snapshot()
    const decision = f.store.commit(input(f))
    f.current = state === 'missing' ? { state } : { state, reason: 'invalid' }
    assert.deepEqual(f.store.pendingDeliveries(NOW + 2), [])
    assert.equal(f.store.get(decision.id)?.invalidatedAt, null)
    f.current = snapshot()
    f.store.reconcileNotes(NOW + 3)
    assert.deepEqual(f.rows('proactive_event'), event)
    assert.equal(f.store.pendingDeliveries(NOW + 3)[0]?.id, decision.id)
  })
}

test('a read outage after the initial snapshot refuses commit without consuming the event', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  const available = snapshot()
  let calls = 0
  const store = new ProactiveStore(f.db, {
    noteSnapshot: () => (++calls === 1 ? available : { state: 'unavailable', reason: 'unreadable' }),
  })
  const sources = store.batch(
    NOW + 1,
    () => true,
    () => true
  )
  assert.equal(sources.length, 1)
  assert.throws(() => store.commit({ ...input(f), sources }), /proactive-source-changed/)
  assert.deepEqual(
    store.batch(
      NOW + 1,
      () => true,
      () => true
    ),
    []
  )
  assert.deepEqual(f.rows('proactive_considered'), [])
})

for (const behavior of ['ABORT', 'IGNORE'] as const) {
  for (const table of ['proactive_note_source', 'proactive_event']) {
    test(`projection/event transaction rolls back ${behavior} on ${table}`, () => {
      const f = fixture()
      f.db.exec(
        `CREATE TRIGGER cut BEFORE INSERT ON ${table} BEGIN SELECT RAISE(${behavior}${behavior === 'ABORT' ? ", 'note-cut'" : ''}); END`
      )
      assert.throws(() => f.store.reconcileNotes(NOW), /note-cut|proactive-write-not-persisted/)
      assert.deepEqual(f.rows('proactive_note_source'), [])
      assert.deepEqual(f.rows('proactive_event'), [])
    })
  }
}

test('Note batches do not mix with capture batches and Note prepare is refused', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  assert.throws(() => f.store.commit(input(f, 'prepare')), /invalid-proactive-decision/)
  assert.deepEqual(f.rows('proactive_decision'), [])
  const source = f.batch()[0]!
  const mixed = input(f)
  mixed.sources.push({
    ...source,
    kind: 'context',
    sourceId: 'capture',
    evidenceId: 'capture',
    eventId: 'capture-event',
    workdayId: 'day',
  })
  assert.throws(() => f.store.commit(mixed), /invalid-proactive-decision/)
})

test('legacy Task apply rejects Note sources even with an empty Task plan', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  const commit = input(f)
  assert.throws(
    () =>
      f.evidence.applyAnalyzedWorkItems({
        workdayId: '',
        plan: { proposed: [], changes: [] },
        conversations: [],
        analysisStartedAt: NOW,
        observedAt: NOW + 1,
        proactiveBatch: commit,
      }),
    /proactive-note-task-authority/
  )
  assert.deepEqual(f.rows('work_item'), [])
  assert.deepEqual(f.rows('work_item_fact'), [])
  assert.deepEqual(f.rows('proactive_decision'), [])
})

test('reopen and duplicate delivery preserve the same decision and message receipt without Task writes', () => {
  const f = fixture()
  f.store.reconcileNotes(NOW)
  const saved = f.store.commit(input(f))
  f.store.acknowledgeDelivery(saved.id, saved.inputHash, 'message-note', NOW + 2)
  f.reopen()
  f.store.reconcileNotes(NOW + 3)
  f.store.acknowledgeDelivery(saved.id, saved.inputHash, 'message-note', NOW + 4)
  assert.equal(f.store.get(saved.id)?.deliveredMessageId, 'message-note')
  assert.deepEqual(f.batch(), [])
  assert.deepEqual(f.store.pendingDeliveries(NOW + 5), [])
  assert.deepEqual(f.rows('work_item'), [])
  assert.deepEqual(f.rows('work_item_fact'), [])
})

test('completion predating consent is not made fresh by a later first reconciliation', () => {
  const f = fixture()
  f.store.configureConsumer(false, NOW)
  f.store.configureConsumer(true, NOW + 10)
  f.store.reconcileNotes(NOW + 11)
  assert.deepEqual(f.batch(NOW + 12), [])
  assert.deepEqual(f.rows('proactive_decision'), [])
})

test('default broker is unavailable before history initialization', () => {
  const f = fixture()
  assert.equal(f.evidence.proactive.notesAvailable(), false)
  assert.equal(f.evidence.proactive.reconcileNotes(NOW), false)
  assert.equal(f.evidence.proactive.hasNoteSources(), false)
})

test('valid empty history persists prior-history handshake; missing cannot erase it', () => {
  const f = fixture()
  f.current = { ...snapshot(), notes: [] }
  f.store.reconcileNotes(NOW)
  assert.equal(f.store.hasNoteSources(), true)
  f.current = { state: 'missing' }
  f.reopen()
  f.store.reconcileNotes(NOW + 1)
  assert.equal(f.store.hasNoteSources(), true)
  assert.deepEqual(f.rows('proactive_event'), [])
})

for (const table of ['proactive_note_source', 'proactive_note_state']) {
  test(`ignored metadata UPDATE rolls back revision and event for ${table}`, () => {
    const f = fixture()
    f.store.reconcileNotes(NOW)
    const initialRows = f.rows('proactive_note_source')
    const initialEvents = f.rows('proactive_event')
    const changed = snapshot()
    changed.sequence++
    changed.notes[0]!.revision++
    f.current = changed
    f.db.exec(`CREATE TRIGGER cut BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`)
    assert.throws(() => f.store.reconcileNotes(NOW + 1), /proactive-write-not-persisted/)
    assert.deepEqual(f.rows('proactive_note_source'), initialRows)
    assert.deepEqual(f.rows('proactive_event'), initialEvents)
  })
}
