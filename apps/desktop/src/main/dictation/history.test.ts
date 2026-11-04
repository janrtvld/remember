import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { createDictationHistory } from './history'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'dictation-history-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('retains completed notes and separate audio across restart, and recovers interrupted work', (t) => {
  const directory = fixture(t)
  const store = createDictationHistory(directory)
  const first = store.add(Buffer.from('first recording'), 1000, 1200)
  store.update(first.id, { text: 'Eerste notitie', status: 'completed' })
  const second = store.add(Buffer.from('second recording'), 2000, 2400)
  const restored = createDictationHistory(directory)
  assert.deepEqual(
    restored.list().map((note) => [note.id, note.status, note.error]),
    [
      [second.id, 'failed', 'interrupted'],
      [first.id, 'completed', null],
    ]
  )
  assert.equal(restored.find(first.id)?.text, 'Eerste notitie')
  assert.equal(restored.find(second.id)?.durationMs, 2400)
  assert.equal(restored.audio(first.id)?.toString(), 'first recording')
  restored.update(second.id, { text: 'Hersteld', status: 'completed', error: null })
  assert.equal(createDictationHistory(directory).list().length, 2)
  restored.remove(first.id)
  assert.equal(existsSync(join(directory, 'notes', `${first.id}.wav`)), false)
  assert.deepEqual(
    createDictationHistory(directory)
      .list()
      .map((note) => note.text),
    ['Hersteld']
  )
})

test('imports the previous completed dictation once and does not resurrect a deleted note', (t) => {
  const directory = fixture(t)
  writeFileSync(join(directory, 'last-result.json'), JSON.stringify({ text: 'Bestaande dictatie', pending: false }))
  writeFileSync(join(directory, 'last-recording.wav'), 'legacy audio')
  const store = createDictationHistory(directory)
  assert.equal(store.list()[0]?.text, 'Bestaande dictatie')
  assert.equal(store.audio('legacy')?.toString(), 'legacy audio')
  store.remove('legacy')
  assert.deepEqual(createDictationHistory(directory).list(), [])
})

test('preserves pending legacy audio as a retryable note', (t) => {
  const directory = fixture(t)
  writeFileSync(join(directory, 'last-result.json'), JSON.stringify({ text: '', pending: true }))
  writeFileSync(join(directory, 'last-recording.wav'), 'unfinished audio')
  const store = createDictationHistory(directory)
  assert.deepEqual(
    store.list().map((note) => [note.status, note.error, note.hasAudio]),
    [['failed', 'interrupted', true]]
  )
  assert.equal(store.audio('legacy')?.toString(), 'unfinished audio')
})

test('rejects path traversal and refuses to overwrite unreadable history', (t) => {
  const directory = fixture(t)
  const store = createDictationHistory(directory)
  assert.throws(() => store.audio('../last-recording'), /invalid-dictation-note/)
  assert.throws(() => store.remove('../last-result'), /invalid-dictation-note/)
  const file = join(directory, 'history.json')
  writeFileSync(file, '{broken')
  assert.throws(() => createDictationHistory(directory).add(Buffer.from('audio'), 1000, 200))
  assert.equal(readFileSync(file, 'utf8'), '{broken')
})
