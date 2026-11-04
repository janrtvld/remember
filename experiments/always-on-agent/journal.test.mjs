import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { JOURNAL_LIMITS, openJournal } from './journal.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-e06-journal-'))
  const file = join(directory, 'journal.sqlite')
  const journals = []
  t.after(() => {
    for (const journal of journals) journal.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    file,
    open(options) {
      const journal = openJournal(file, options)
      journals.push(journal)
      return journal
    },
  }
}

function running(journal) {
  journal.submit({ id: 'job-1', spec: { prompt: 'Synthetic local test', workspace: '/tmp/probe' } })
  journal.transition({ phase: 'thread-bound', threadId: 'thread-1' })
  journal.transition({ phase: 'turn-start-intent' })
  return journal.transition({ phase: 'running', turnId: 'turn-1' })
}

test('same id and canonical spec returns existing without an event or new start intent; conflicting work rejects', (t) => {
  const journal = fixture(t).open({ now: () => 100 })
  const first = journal.submit({ id: 'job-1', spec: { b: [2, 1], a: 'hello' } })
  const duplicate = journal.submit({ id: 'job-1', spec: { a: 'hello', b: [2, 1] } })
  assert.equal(first.created, true)
  assert.deepEqual(duplicate, { created: false, job: first.job })
  assert.equal(journal.events().length, 1)
  assert.throws(() => journal.submit({ id: 'job-1', spec: { a: 'changed' } }), /input-conflict/)
  assert.throws(() => journal.submit({ id: 'job-2', spec: { b: [2, 1], a: 'hello' } }), /single-job/)
  assert.equal(journal.events().length, 1)
})

test('restart preserves bound identity, expires review, and cannot silently start or answer the prior request', (t) => {
  const f = fixture(t)
  let journal = f.open({ now: () => 100 })
  running(journal)
  const request = journal.putRequest({
    id: '7',
    method: 'approval',
    payload: { command: 'write file', turnId: 'turn-1' },
  })
  const oldSession = journal.sessionId
  assert.equal(journal.getJob().phase, 'waiting')
  journal.close()
  journal = f.open({ now: () => 200 })
  assert.notEqual(journal.sessionId, oldSession)
  assert.equal(journal.getJob().phase, 'recovery-required')
  assert.equal(journal.getJob().threadId, 'thread-1')
  assert.equal(journal.getJob().turnId, 'turn-1')
  assert.deepEqual(journal.pendingRequests(), [])
  assert.throws(
    () => journal.resolveRequest({ id: request.id, sessionId: oldSession, result: { decision: 'accept' } }),
    /session-expired/
  )
  assert.throws(() => journal.transition({ phase: 'running' }), /invalid-job-transition/)
  assert.throws(() => journal.transition({ phase: 'turn-start-intent' }), /invalid-job-transition/)
  assert.equal(
    journal.submit({ id: 'job-1', spec: { workspace: '/tmp/probe', prompt: 'Synthetic local test' } }).created,
    false
  )
  assert.equal(journal.getJob().phase, 'recovery-required')
  const db = new DatabaseSync(f.file)
  assert.equal(db.prepare('SELECT status FROM server_request').get().status, 'expired')
  db.close()
})

test('an older open coordinator cannot mutate after another session takes ownership', (t) => {
  const f = fixture(t)
  const old = f.open()
  running(old)
  const request = old.putRequest({ id: 'approval-1', method: 'approval', payload: { permission: 'write' } })
  const current = f.open()
  assert.throws(() => old.resolveRequest({ ...request, result: { decision: 'accept' } }), /journal-session-expired/)
  assert.throws(() => old.appendEvent('late-completion', {}), /journal-session-expired/)
  assert.throws(() => old.transition({ phase: 'completed' }), /journal-session-expired/)
  assert.equal(current.getJob().phase, 'recovery-required')
})

test('request receipts are idempotent and payload/decision conflicts fail; unresolved reviews block completion', (t) => {
  const journal = fixture(t).open()
  running(journal)
  const input = { id: 'approval-1', method: 'approval', payload: { cwd: '/tmp/probe', command: 'write' } }
  const request = journal.putRequest(input)
  const before = journal.events().length
  assert.deepEqual(journal.putRequest({ ...input, payload: { command: 'write', cwd: '/tmp/probe' } }), request)
  assert.equal(journal.events().length, before)
  assert.throws(() => journal.putRequest({ ...input, payload: { command: 'other' } }), /request-conflict/)
  assert.throws(() => journal.transition({ phase: 'completed' }), /pending-requests/)
  assert.throws(() => journal.transition({ phase: 'running' }), /pending-requests/)
  const answer = { id: request.id, sessionId: journal.sessionId, result: { decision: 'decline' } }
  const resolved = journal.resolveRequest(answer)
  const count = journal.events().length
  assert.deepEqual(journal.resolveRequest(answer), resolved)
  assert.equal(journal.events().length, count)
  assert.throws(() => journal.resolveRequest({ ...answer, result: { decision: 'accept' } }), /result-conflict/)
  assert.equal(journal.getJob().phase, 'running')
  assert.deepEqual(journal.pendingRequests(), [])
})

test('Stop expires pending reviews and terminal identity/results survive restart without extra events', (t) => {
  const f = fixture(t)
  let journal = f.open()
  running(journal)
  const request = journal.putRequest({ id: 'review', method: 'remember_memory', payload: { action: 'patch' } })
  const stopped = journal.transition({ phase: 'stopped' })
  assert.deepEqual(journal.pendingRequests(), [])
  assert.throws(() => journal.resolveRequest({ ...request, result: { saved: true } }), /request-expired/)
  assert.throws(() => journal.transition({ phase: 'running' }), /invalid-job-transition/)
  const count = journal.events().length
  journal.close()
  journal = f.open()
  assert.deepEqual(journal.getJob(), stopped)
  assert.equal(journal.events().length, count)
  assert.deepEqual(journal.transition({ phase: 'stopped' }), stopped)
})

test('identity binding is immutable and completed requires an actual bound turn', (t) => {
  const journal = fixture(t).open()
  journal.submit({ id: 'job-1', spec: {} })
  assert.throws(() => journal.transition({ phase: 'thread-bound' }), /thread-required/)
  journal.transition({ phase: 'thread-bound', threadId: 'thread-1' })
  assert.throws(() => journal.transition({ phase: 'turn-start-intent', threadId: 'other' }), /thread-conflict/)
  journal.transition({ phase: 'turn-start-intent' })
  assert.throws(() => journal.transition({ phase: 'running' }), /turn-required/)
  journal.transition({ phase: 'running', turnId: 'turn-1' })
  assert.throws(() => journal.transition({ phase: 'running', turnId: 'other' }), /turn-conflict/)
  journal.transition({ phase: 'completed' })
  assert.throws(() => journal.transition({ phase: 'running' }), /invalid-job-transition/)
})

test('events are ordered, cursor-paged, bounded and append-only even through SQL', (t) => {
  const f = fixture(t)
  const journal = f.open({ now: () => 123 })
  journal.submit({ id: 'job-1', spec: {} })
  for (let i = 0; i < 5; i++) journal.appendEvent('delta', { i })
  const first = journal.events({ afterSeq: 0, limit: 3 })
  const second = journal.events({ afterSeq: first.at(-1).seq, limit: 3 })
  assert.deepEqual(
    [...first, ...second].map(({ seq }) => seq),
    [1, 2, 3, 4, 5, 6]
  )
  assert.deepEqual(
    second.map(({ payload }) => payload.i),
    [2, 3, 4]
  )
  assert.throws(() => journal.events({ limit: 101 }), /invalid-journal-event-range/)
  assert.throws(() => journal.events({ afterSeq: -1 }), /invalid-journal-event-range/)
  const db = new DatabaseSync(f.file)
  assert.throws(() => db.exec('DELETE FROM event'), /append-only/)
  assert.throws(() => db.exec("UPDATE event SET type = 'changed'"), /append-only/)
  db.close()
})

test('payload and pending request bounds reject without partially committing state', (t) => {
  const journal = fixture(t).open()
  assert.throws(
    () => journal.submit({ id: 'job-1', spec: { text: 'x'.repeat(JOURNAL_LIMITS.specBytes) } }),
    /payload-too-large/
  )
  assert.equal(journal.getJob(), null)
  running(journal)
  const before = journal.events().length
  assert.throws(
    () => journal.appendEvent('large', { text: 'x'.repeat(JOURNAL_LIMITS.eventBytes) }),
    /payload-too-large/
  )
  assert.throws(() => journal.appendEvent('bad', { value: undefined }), /invalid-journal-json/)
  assert.equal(journal.events().length, before)
  for (let i = 0; i < JOURNAL_LIMITS.maxPendingRequests; i++) {
    journal.putRequest({ id: `request-${i}`, method: 'approval', payload: { i } })
  }
  assert.throws(() => journal.putRequest({ id: 'too-many', method: 'approval', payload: {} }), /request-limit/)
  assert.equal(journal.pendingRequests().length, JOURNAL_LIMITS.maxPendingRequests)
})

test('client tool results accept multibyte pages through exactly 64 KiB and reject larger receipts atomically', (t) => {
  const f = fixture(t)
  const journal = f.open()
  running(journal)
  assert.equal(JOURNAL_LIMITS.resultBytes, 64 * 1024)
  const multibyte = { success: true, output: { content: '界'.repeat(6000) } }
  const overhead = Buffer.byteLength(JSON.stringify({ success: true, output: { content: '' } }))
  const available = JOURNAL_LIMITS.resultBytes - overhead
  const boundary = {
    success: true,
    output: { content: '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3) },
  }
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), JOURNAL_LIMITS.resultBytes)
  for (const [index, result] of [multibyte, boundary].entries()) {
    const request = journal.putRequest({ id: `valid-${index}`, method: 'client-tool', payload: { action: 'read' } })
    const answer = { id: request.id, sessionId: journal.sessionId, result }
    const resolved = journal.resolveRequest(answer)
    assert.equal(resolved.status, 'resolved')
    assert.deepEqual(resolved.result, result)
    assert.deepEqual(journal.resolveRequest(answer), resolved, 'Large receipts remain idempotent')
    assert.deepEqual(journal.pendingRequests(), [])
  }
  const pending = journal.putRequest({ id: 'oversized', method: 'client-tool', payload: { action: 'read' } })
  const before = journal.events().length
  const above = { ...boundary, output: { content: `${boundary.output.content}x` } }
  assert.throws(
    () => journal.resolveRequest({ id: pending.id, sessionId: journal.sessionId, result: above }),
    /payload-too-large/
  )
  assert.equal(journal.events().length, before)
  assert.equal(journal.getJob().phase, 'waiting')
  assert.equal(journal.pendingRequests()[0].id, pending.id)
  const boundedFailure = { success: false, error: 'remember-tool-result-too-large' }
  journal.resolveRequest({ id: pending.id, sessionId: journal.sessionId, result: boundedFailure })
  assert.deepEqual(journal.pendingRequests(), [])
  journal.transition({ phase: 'completed' })
  journal.close()
  const restarted = f.open()
  assert.equal(restarted.getJob().phase, 'completed')
  const database = new DatabaseSync(f.file)
  assert.deepEqual(
    JSON.parse(database.prepare("SELECT result_json FROM server_request WHERE id = 'valid-1'").get().result_json),
    boundary
  )
  database.close()
})

test('SQLite uses FULL/WAL and private files', (t) => {
  const f = fixture(t)
  const journal = f.open()
  journal.submit({ id: 'job-1', spec: {} })
  const db = new DatabaseSync(f.file)
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2)
  db.close()
  for (const suffix of ['', '-wal', '-shm']) assert.equal(statSync(f.file + suffix).mode & 0o777, 0o600)
})

test('committed start intent and review survive abrupt process exit but reopen never executes them', (t) => {
  const f = fixture(t)
  const script = `
    import { openJournal } from ${JSON.stringify(new URL('./journal.mjs', import.meta.url).href)};
    const journal = openJournal(${JSON.stringify(f.file)});
    journal.submit({id:'job-crash',spec:{prompt:'synthetic'}});
    journal.transition({phase:'thread-bound',threadId:'thread-crash'});
    journal.transition({phase:'turn-start-intent'});
    journal.transition({phase:'running',turnId:'turn-crash'});
    journal.putRequest({id:'approval',method:'approval',payload:{command:'must not replay'}});
    process.exit(0);
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const journal = f.open()
  assert.equal(journal.getJob().phase, 'recovery-required')
  assert.equal(journal.getJob().turnId, 'turn-crash')
  assert.deepEqual(journal.pendingRequests(), [])
  assert.equal(journal.events().filter(({ type }) => type === 'job-submitted').length, 1)
  assert.equal(journal.events().filter(({ type }) => type === 'request-resolved').length, 0)
})

for (const phase of ['thread-start-intent', 'thread-bound', 'turn-start-intent']) {
  test(`restart after ${phase} retains intent without creating another start`, (t) => {
    const f = fixture(t)
    let journal = f.open()
    journal.submit({ id: 'job-1', spec: { prompt: 'once' } })
    if (phase !== 'thread-start-intent') journal.transition({ phase: 'thread-bound', threadId: 'thread-1' })
    if (phase === 'turn-start-intent') journal.transition({ phase })
    journal.close()
    journal = f.open()
    const restored = journal.getJob()
    assert.equal(restored.phase, 'recovery-required')
    assert.equal(restored.threadId, phase === 'thread-start-intent' ? null : 'thread-1')
    assert.equal(restored.turnId, null)
    assert.equal(journal.submit({ id: 'job-1', spec: { prompt: 'once' } }).created, false)
    assert.equal(journal.events().filter(({ type }) => type === 'job-submitted').length, 1)
    assert.throws(() => journal.transition({ phase: 'completed' }), /required/)
  })
}

test('event capacity failure rolls back the associated job transition atomically', (t) => {
  const f = fixture(t)
  const journal = f.open()
  running(journal)
  const before = journal.getJob()
  const db = new DatabaseSync(f.file)
  const count = db.prepare('SELECT COUNT(*) AS count FROM event').get().count
  db.exec('BEGIN IMMEDIATE')
  const insert = db.prepare("INSERT INTO event(type, payload_json, created_at) VALUES('bounded-fixture', '{}', 0)")
  for (let i = count; i < JOURNAL_LIMITS.maxEvents; i++) insert.run()
  db.exec('COMMIT')
  assert.throws(() => journal.transition({ phase: 'completed' }), /event-limit/)
  assert.deepEqual(journal.getJob(), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM event').get().count, JOURNAL_LIMITS.maxEvents)
  db.close()
})

test('single request expiry is durable and idempotent, retaining waiting until the last pending review expires', (t) => {
  const f = fixture(t)
  const journal = f.open()
  running(journal)
  const first = journal.putRequest({ id: 'first', method: 'approval', payload: { action: 'first' } })
  journal.putRequest({ id: 'second', method: 'approval', payload: { action: 'second' } })
  const input = { id: first.id, sessionId: journal.sessionId, reason: 'upstream-request-resolved' }
  const expired = journal.expireRequest(input)
  assert.equal(expired.status, 'expired')
  assert.equal(expired.result, null)
  assert.equal(journal.getJob().phase, 'waiting')
  assert.deepEqual(
    journal.pendingRequests().map(({ id }) => id),
    ['second']
  )
  const eventCount = journal.events().length
  assert.deepEqual(journal.expireRequest(input), expired)
  assert.equal(journal.events().length, eventCount)
  assert.throws(
    () => journal.resolveRequest({ id: first.id, sessionId: journal.sessionId, result: { decision: 'accept' } }),
    /request-expired/
  )
  journal.expireRequest({ ...input, id: 'second' })
  assert.equal(journal.getJob().phase, 'running')
  assert.deepEqual(journal.pendingRequests(), [])
  assert.equal(journal.events().filter(({ type }) => type === 'request-resolved').length, 0)
  assert.equal(journal.events().filter(({ type }) => type === 'request-expired').length, 2)
  const db = new DatabaseSync(f.file)
  assert.deepEqual(
    db
      .prepare('SELECT status, result_json FROM server_request ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { status: 'expired', result_json: null },
      { status: 'expired', result_json: null },
    ]
  )
  db.close()
})

test('request expiry rejects an old session and oversized reason, and never rewrites a completed receipt', (t) => {
  const f = fixture(t)
  let journal = f.open()
  running(journal)
  const request = journal.putRequest({ id: 'review', method: 'approval', payload: {} })
  const receipt = journal.resolveRequest({
    id: request.id,
    sessionId: journal.sessionId,
    result: { decision: 'decline' },
  })
  const count = journal.events().length
  assert.deepEqual(
    journal.expireRequest({ id: request.id, sessionId: journal.sessionId, reason: 'late-upstream-abort' }),
    receipt
  )
  assert.equal(journal.events().length, count)
  assert.throws(
    () => journal.expireRequest({ id: request.id, sessionId: journal.sessionId, reason: 'x'.repeat(201) }),
    /invalid-request-expiry-reason/
  )
  const oldSession = journal.sessionId
  journal.close()
  journal = f.open()
  assert.throws(
    () => journal.expireRequest({ id: request.id, sessionId: oldSession, reason: 'old-process' }),
    /session-expired/
  )
  assert.equal(journal.getJob().phase, 'recovery-required')
})
