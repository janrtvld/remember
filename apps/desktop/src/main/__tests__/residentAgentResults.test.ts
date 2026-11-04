import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ResidentAgentStore, type SavedMemoryReceipt } from '../residentAgentStore'

const saved: SavedMemoryReceipt = {
  kind: 'saved-page',
  saved: true,
  proposed: false,
  spaceId: 'work',
  slug: 'projects/release',
  revision: 'revision-2',
  title: 'Release decision',
}

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-results-'))
  const file = join(directory, 'chat.sqlite')
  let store = new ResidentAgentStore(file)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    file,
    get store() {
      return store
    },
    reopen() {
      store.close()
      store = new ResidentAgentStore(file)
    },
  }
}

test('a saved receipt stays on its original assistant message across restart and a callback from a retry', (t) => {
  const f = fixture(t)
  const first = f.store.start('Save the decision', 'codex')
  const other = f.store.start('Other turn', 'codex')
  const callId = '["provider-thread","provider-call"]'
  f.store.claimToolCall(callId, 'request-hash', { messageId: first.id, toolName: 'remember_memory' })
  f.store.finishToolCall(callId, saved)
  f.store.finishToolCall(callId, { ...saved })
  f.store.update(first.id, { text: 'Done.', status: 'completed', steps: [] })
  f.store.update(other.id, {
    text: '[Invented page](/wiki/page/?space=fake&slug=made-up)',
    status: 'completed',
    steps: [],
  })
  const expected = [
    {
      id: callId,
      kind: 'saved-page',
      spaceId: saved.spaceId,
      slug: saved.slug,
      revision: saved.revision,
      title: saved.title,
    },
  ]
  assert.deepEqual(f.store.get(first.id)?.results, expected)
  assert.deepEqual(f.store.get(other.id)?.results, [])
  assert(
    f.store.history().every((entry) => entry.results?.length === 0),
    'Result metadata is not added to automatic model history'
  )
  f.reopen()
  assert.throws(
    () => f.store.claimToolCall(callId, 'request-hash', { messageId: other.id, toolName: 'remember_memory' }),
    /binding-mismatch/
  )
  assert.deepEqual(
    f.store.claimToolCall(callId, 'request-hash', { messageId: first.id, toolName: 'remember_memory' }),
    { existing: true, result: saved }
  )
  assert.deepEqual(f.store.conversation(null).messages.find((entry) => entry.id === first.id)?.results, expected)
  assert.deepEqual(f.store.get(other.id)?.results, [])
  assert.throws(() => f.store.finishToolCall(callId, { ...saved, revision: 'another-revision' }), /result-mismatch/)
  assert.throws(() => f.store.claimToolCall(callId, 'changed-request'), /call-mismatch/)
})

test('declined, proposed, stale, uncertain, malformed and wrong-kind receipts never project as saved results', (t) => {
  const f = fixture(t)
  const turn = f.store.start('Save it', 'codex')
  const invalid = [
    { saved: false, reason: 'user-declined' },
    { saved: false, proposed: true, spaceId: 'work', slug: 'release', proposalId: 'proposal' },
    { saved: false, error: 'wiki-page-conflict' },
    { ...saved, error: 'outcome-unknown' },
    { ...saved, kind: 'proposed-page' },
    { ...saved, proposed: true },
    { ...saved, revision: '' },
    { ...saved, revision: undefined },
    { ...saved, slug: ' ' },
    { ...saved, spaceId: 'work\nprivate' },
    { saved: true, proposed: false, spaceId: 'work', slug: 'release', revision: 'legacy-untyped' },
    'Saved [page](/wiki/page/?space=work&slug=release)',
  ]
  invalid.forEach((receipt, index) => {
    const id = `invalid-${index}`
    f.store.claimToolCall(id, id, { messageId: turn.id, toolName: 'remember_memory' })
    f.store.finishToolCall(id, receipt)
  })
  f.store.claimToolCall('uncertain', 'uncertain', { messageId: turn.id, toolName: 'remember_memory' })
  const database = new DatabaseSync(f.file)
  database
    .prepare(
      'INSERT INTO assistant_tool_call (id, request_hash, result_json, message_id, tool_name) VALUES (?, ?, ?, ?, ?)'
    )
    .run('wrong-tool', 'wrong-tool', JSON.stringify(saved), turn.id, 'another_tool')
  database.close()
  assert.deepEqual(f.store.get(turn.id)?.results, [])
  f.reopen()
  assert.deepEqual(f.store.get(turn.id)?.results, [])
})

test('only an existing assistant can receive a new association, and a valid receipt can fall back to its trusted slug', (t) => {
  const f = fixture(t)
  const turn = f.store.start('Save it', 'codex')
  const user = f.store.conversation(null).messages[0]
  assert(user)
  assert.throws(
    () => f.store.claimToolCall('missing', 'hash', { messageId: 'missing', toolName: 'remember_memory' }),
    /message-invalid/
  )
  assert.throws(
    () => f.store.claimToolCall('user', 'hash', { messageId: user.id, toolName: 'remember_memory' }),
    /message-invalid/
  )
  assert.throws(() => f.store.finishToolCall('missing', saved), /not-claimed/)
  f.store.claimToolCall('fallback', 'hash', { messageId: turn.id, toolName: 'remember_memory' })
  const { title: _title, ...withoutTitle } = saved
  f.store.finishToolCall('fallback', withoutTitle)
  assert.equal(f.store.get(turn.id)?.results?.[0]?.title, saved.slug)
})

test('migration preserves old receipts and uncertain claims without inventing a message association', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'remember-result-migration-'))
  const file = join(directory, 'chat.sqlite')
  const old = new DatabaseSync(file)
  old.exec('CREATE TABLE assistant_tool_call (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result_json TEXT)')
  old.prepare('INSERT INTO assistant_tool_call VALUES (?, ?, ?)').run('old-saved', 'hash', JSON.stringify(saved))
  old.prepare('INSERT INTO assistant_tool_call VALUES (?, ?, NULL)').run('old-unknown', 'hash')
  old.close()
  const store = new ResidentAgentStore(file)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const turn = store.start('Retry', 'codex')
  const binding = { messageId: turn.id, toolName: 'remember_memory' as const }
  assert.throws(() => store.claimToolCall('old-saved', 'hash', binding), /binding-mismatch/)
  assert.throws(() => store.claimToolCall('old-unknown', 'hash', binding), /binding-mismatch/)
  assert.deepEqual(store.claimToolCall('old-saved', 'hash'), { existing: true, result: saved })
  assert.deepEqual(store.claimToolCall('old-unknown', 'hash'), { existing: true, result: null })
  assert.deepEqual(store.get(turn.id)?.results, [])
  const database = new DatabaseSync(file)
  const receipts = database.prepare('SELECT * FROM assistant_tool_call ORDER BY id').all()
  assert(receipts.every((row) => row.message_id === null && row.tool_name === null))
  assert.equal(receipts[0]?.result_json, JSON.stringify(saved))
  database.close()
})
