import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import type { DictationNote } from '@remember/shared'
import { createDictationHistory } from './history'
import {
  getDictationHistorySnapshot,
  publishDictationHistoryChange,
  registerDictationHistorySource,
  subscribeDictationHistoryChanges,
} from './historySource'

const noteId = '9b779364-fb49-4b5c-a14a-3917780e5b15'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'dictation-source-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, file: join(directory, 'history.json') }
}

function note(patch: Partial<DictationNote> = {}): DictationNote {
  return {
    id: noteId,
    createdAt: 100,
    durationMs: 20,
    text: 'Old note',
    status: 'completed',
    error: null,
    hasAudio: false,
    ...patch,
  }
}

test('snapshot is unavailable before explicit initialization, then detached and read-only', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  assert.deepEqual(store.snapshot(), { state: 'unavailable', reason: 'not-ready' })
  assert.equal(existsSync(file), false)
  store.initialize()
  const bytes = readFileSync(file, 'utf8')
  const first = store.snapshot()
  assert.equal(first.state, 'available')
  if (first.state !== 'available') throw new Error('snapshot-required')
  assert.equal(first.sequence, 0)
  first.tombstones[noteId] = { incarnation: 'mutated', revision: 1, deletedAt: 1 }
  store.initialize()
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.deepEqual(store.snapshot(), { ...first, tombstones: {} })
})

test('legacy migration and last-result import remain historical even when completed', (t) => {
  const { directory, file } = fixture(t)
  writeFileSync(file, JSON.stringify({ version: 1, notes: [note()] }))
  const store = createDictationHistory(directory)
  store.initialize()
  const snapshot = store.snapshot()
  assert.equal(snapshot.state, 'available')
  if (snapshot.state !== 'available') throw new Error('snapshot-required')
  assert.equal(snapshot.notes[0]?.completedAt, null)
  assert.deepEqual(snapshot.notes[0]?.note, note())
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
})

test('completion time is committed once; completed edits do not retime; retry and failure revoke it', (t) => {
  const { directory, file } = fixture(t)
  let now = 200
  const store = createDictationHistory(directory, { now: () => now })
  const added = store.add(Buffer.from('fixture'), 100, 20)
  store.update(added.id, { status: 'completed', text: 'First' })
  const completed = store.snapshot()
  if (completed.state !== 'available') throw new Error('snapshot-required')
  assert.equal(completed.notes[0]?.completedAt, 200)
  const bytes = readFileSync(file, 'utf8')
  now = 300
  store.update(added.id, { status: 'completed', text: 'First' })
  assert.equal(readFileSync(file, 'utf8'), bytes)
  store.update(added.id, { text: 'Edited' })
  const edited = store.snapshot()
  if (edited.state !== 'available') throw new Error('snapshot-required')
  assert.equal(edited.notes[0]?.completedAt, 200)
  assert.equal(edited.notes[0]?.revision, (completed.notes[0]?.revision ?? 0) + 1)
  store.update(added.id, { status: 'processing' })
  assert.equal(source(store).completedAt, null)
  now = 400
  store.update(added.id, { status: 'completed' })
  assert.equal(source(store).completedAt, 400)
  store.update(added.id, { status: 'failed', error: 'transcription' })
  assert.equal(source(store).completedAt, null)
})

function source(store: ReturnType<typeof createDictationHistory>) {
  const snapshot = store.snapshot()
  if (snapshot.state !== 'available' || !snapshot.notes[0]) throw new Error('snapshot-required')
  return snapshot.notes[0]
}

test('fresh reads detect canonical removal and refuse writes from old in-memory data', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  const added = store.add(Buffer.from('fixture'), 100, 20)
  store.update(added.id, { status: 'completed', text: 'Private' })
  const saved = readFileSync(file, 'utf8')
  rmSync(file)
  assert.deepEqual(store.snapshot(), { state: 'missing' })
  assert.throws(() => store.update(added.id, { text: 'Cache must not revive' }), /dictation-history-missing/)
  assert.equal(existsSync(file), false)
  writeFileSync(file, saved)
  assert.equal(source(store).note.text, 'Private')
})

test('prior source receipts prevent missing history from importing legacy text again', (t) => {
  const { directory, file } = fixture(t)
  writeFileSync(join(directory, 'last-result.json'), JSON.stringify({ text: 'Deleted private note', pending: false }))
  const store = createDictationHistory(directory)
  assert.throws(() => store.initialize({ hasPriorNoteSources: true }), /dictation-history-missing/)
  assert.deepEqual(store.snapshot(), { state: 'missing' })
  assert.throws(() => store.list(), /dictation-history-missing/)
  assert.equal(existsSync(file), false)
})

test('metadata missing after legacy rollback creates a new historical epoch on reopen', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  const added = store.add(Buffer.from('fixture'), 100, 20)
  store.update(added.id, { status: 'completed', text: 'Kept by old build' })
  const before = store.snapshot()
  if (before.state !== 'available') throw new Error('snapshot-required')
  writeFileSync(file, JSON.stringify({ version: 1, notes: store.list() }))
  assert.deepEqual(store.snapshot(), { state: 'unavailable', reason: 'invalid' })
  const reopened = createDictationHistory(directory)
  reopened.initialize({ hasPriorNoteSources: true })
  const after = reopened.snapshot()
  if (after.state !== 'available') throw new Error('snapshot-required')
  assert.notEqual(after.epoch, before.epoch)
  assert.equal(after.notes[0]?.completedAt, null)
})

test('startup interrupted recovery updates only changed revisions and does not retime completed notes', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory, { now: () => 200 })
  const first = store.add(Buffer.from('first'), 100, 20)
  store.update(first.id, { status: 'completed', text: 'Done' })
  const second = store.add(Buffer.from('second'), 150, 20)
  const before = store.snapshot()
  if (before.state !== 'available') throw new Error('snapshot-required')
  const reopened = createDictationHistory(directory)
  reopened.initialize()
  const after = reopened.snapshot()
  if (after.state !== 'available') throw new Error('snapshot-required')
  assert.deepEqual(
    after.notes.find((entry) => entry.note.id === first.id),
    before.notes.find((entry) => entry.note.id === first.id)
  )
  const interrupted = after.notes.find((entry) => entry.note.id === second.id)
  assert.equal(interrupted?.note.status, 'failed')
  assert.equal(interrupted?.note.error, 'interrupted')
  assert.equal(interrupted?.completedAt, null)
  assert.equal(after.sequence, before.sequence + 1)
  const bytes = readFileSync(file, 'utf8')
  createDictationHistory(directory).initialize()
  assert.equal(readFileSync(file, 'utf8'), bytes)
})

test('delete and supported same-ID re-add retain a tombstone and use a new incarnation', (t) => {
  const { directory } = fixture(t)
  const store = createDictationHistory(directory, { newId: () => noteId, now: () => 200 })
  store.add(Buffer.from('first'), 100, 20)
  store.update(noteId, { status: 'completed', text: 'Same' })
  const before = source(store)
  assert.throws(() => store.add(Buffer.from('collision'), 100, 20), /dictation-note-exists/)
  assert.equal(store.audio(noteId)?.toString(), 'first')
  store.remove(noteId)
  store.add(Buffer.from('second'), 100, 20)
  store.update(noteId, { status: 'completed', text: 'Same' })
  const after = store.snapshot()
  if (after.state !== 'available') throw new Error('snapshot-required')
  assert.notEqual(after.notes[0]?.incarnation, before.incarnation)
  assert.equal(after.tombstones[noteId]?.incarnation, before.incarnation)
  assert.equal(after.tombstones[noteId]?.revision, before.revision + 1)
  assert.equal(after.tombstones[noteId]?.deletedAt, 200)
  assert.deepEqual(createDictationHistory(directory).list(), store.list())
})

test('unknown or corrupt metadata cannot be partially accepted or repaired by a writer', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  const added = store.add(Buffer.from('fixture'), 100, 20)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const corruptions = [
    (value: typeof saved) => {
      value.sourceState.version = 2
    },
    (value: typeof saved) => {
      value.notes.push(value.notes[0])
    },
    (value: typeof saved) => {
      value.notes[0].text = 'Unbound mutation'
    },
    (value: typeof saved) => {
      delete value.sourceState.entries[added.id]
    },
    (value: typeof saved) => {
      value.sourceState.entries[added.id].revision = 0
    },
    (value: typeof saved) => {
      value.sourceState.entries[added.id].completedAt = 100
    },
    (value: typeof saved) => {
      value.sourceState.extra = true
    },
  ]
  for (const corrupt of corruptions) {
    const changed = structuredClone(saved)
    corrupt(changed)
    const bytes = JSON.stringify(changed)
    writeFileSync(file, bytes)
    assert.deepEqual(store.snapshot(), { state: 'unavailable', reason: 'invalid' })
    assert.throws(() => store.update(added.id, { status: 'completed' }), /invalid-dictation-history/)
    assert.equal(readFileSync(file, 'utf8'), bytes)
  }
})

test('reads are detached and returned note edits never alter the canonical file', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  const added = store.add(Buffer.from('fixture'), 100, 20)
  const bytes = readFileSync(file, 'utf8')
  added.text = 'Changed return value'
  const found = store.find(added.id)
  if (!found) throw new Error('note-required')
  found.text = 'Changed find'
  source(store).note.status = 'completed'
  assert.equal(readFileSync(file, 'utf8'), bytes)
  assert.equal(store.find(added.id)?.text, '')
})

test('postcommit notifications see durable data, isolate listener errors, and exclude no-op or failed writes', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  store.initialize()
  let notifications = 0
  const observed: { state: string; sequence: number }[] = []
  const oldError = console.error
  console.error = () => undefined
  t.after(() => {
    console.error = oldError
  })
  const removeThrower = store.subscribe(() => {
    throw new Error('listener-failed')
  })
  const unsubscribe = store.subscribe(() => {
    notifications++
    observed.push({
      state: store.snapshot().state,
      sequence: JSON.parse(readFileSync(file, 'utf8')).sourceState.sequence,
    })
  })
  const added = store.add(Buffer.from('fixture'), 100, 20)
  store.update(added.id, { text: '' })
  assert.equal(notifications, 1)
  assert.deepEqual(observed, [{ state: 'available', sequence: 1 }])
  mkdirSync(`${file}.tmp`)
  assert.throws(() => store.update(added.id, { text: 'Not saved' }))
  assert.equal(notifications, 1)
  assert.equal(store.find(added.id)?.text, '')
  rmSync(`${file}.tmp`, { recursive: true })
  removeThrower()
  unsubscribe()
  store.update(added.id, { text: 'Saved' })
  assert.equal(notifications, 1)
})

test('canonical unreadable JSON is not an empty or missing authority', (t) => {
  const { directory, file } = fixture(t)
  const store = createDictationHistory(directory)
  writeFileSync(file, '{broken')
  assert.throws(() => store.initialize(), /invalid-dictation-history/)
  assert.deepEqual(store.snapshot(), { state: 'unavailable', reason: 'invalid' })
  assert.equal(readFileSync(file, 'utf8'), '{broken')
})

test('legacy status and error must be exact primitive values, never coerced arrays', (t) => {
  const { directory, file } = fixture(t)
  for (const patch of [{ status: ['completed'] }, { error: ['interrupted'] }]) {
    const bytes = JSON.stringify({ version: 1, notes: [{ ...note(), ...patch }] })
    writeFileSync(file, bytes)
    const store = createDictationHistory(directory)
    assert.throws(() => store.initialize(), /invalid-dictation-history/)
    assert.deepEqual(store.snapshot(), { state: 'unavailable', reason: 'invalid' })
    assert.equal(readFileSync(file, 'utf8'), bytes)
  }
})

test('global broker is unavailable before/after owner, reads freshly, and isolates observer failures', (t) => {
  assert.deepEqual(getDictationHistorySnapshot(), { state: 'unavailable', reason: 'not-ready' })
  let changes = 0
  let reads = 0
  const oldError = console.error
  console.error = () => undefined
  t.after(() => {
    console.error = oldError
  })
  const unsubscribeThrower = subscribeDictationHistoryChanges(() => {
    throw new Error('listener-failed')
  })
  const unsubscribe = subscribeDictationHistoryChanges(() => {
    changes++
  })
  const release = registerDictationHistorySource(() => {
    reads++
    return { state: 'missing' }
  })
  assert.equal(changes, 1)
  assert.deepEqual(getDictationHistorySnapshot(), { state: 'missing' })
  assert.deepEqual(getDictationHistorySnapshot(), { state: 'missing' })
  assert.equal(reads, 2)
  assert.throws(() => registerDictationHistorySource(() => ({ state: 'missing' })), /dictation-history-owner-exists/)
  publishDictationHistoryChange()
  assert.equal(changes, 2)
  release()
  release()
  assert.equal(changes, 3)
  assert.deepEqual(getDictationHistorySnapshot(), { state: 'unavailable', reason: 'not-ready' })
  unsubscribeThrower()
  unsubscribe()
})
