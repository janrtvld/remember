import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const JOURNAL_LIMITS = Object.freeze({
  specBytes: 64 * 1024,
  eventBytes: 16 * 1024,
  requestBytes: 32 * 1024,
  resultBytes: 64 * 1024,
  maxEvents: 10_000,
  maxRequests: 128,
  maxPendingRequests: 16,
  readEvents: 100,
})

const phases = new Set([
  'thread-start-intent',
  'thread-bound',
  'turn-start-intent',
  'running',
  'waiting',
  'completed',
  'recovery-required',
  'stopped',
])
const terminal = new Set(['completed', 'stopped'])
const transitions = {
  'thread-start-intent': ['thread-bound', 'recovery-required', 'stopped'],
  'thread-bound': ['turn-start-intent', 'recovery-required', 'stopped'],
  'turn-start-intent': ['running', 'recovery-required', 'stopped'],
  running: ['waiting', 'completed', 'recovery-required', 'stopped'],
  waiting: ['running', 'completed', 'recovery-required', 'stopped'],
  'recovery-required': ['completed', 'stopped'],
  completed: [],
  stopped: [],
}

function identifier(value, name, maximum = 200) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Journal identifiers must reject ASCII control characters.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`invalid-${name}`)
  }
  return value
}

function encode(value, maximum) {
  const seen = new Set()
  let remaining = maximum
  let nodes = 0
  function reserve(size) {
    remaining -= size
    if (remaining < 0) throw new Error('journal-payload-too-large')
  }
  function stringSize(text) {
    if (Buffer.byteLength(text) > remaining) throw new Error('journal-payload-too-large')
    reserve(Buffer.byteLength(JSON.stringify(text)))
  }
  function canonical(input, depth) {
    if (++nodes > 10_000) throw new Error('journal-payload-too-many-values')
    if (depth > 20) throw new Error('journal-payload-too-deep')
    if (typeof input === 'string') {
      stringSize(input)
      return input
    }
    if (input === null || typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))) {
      reserve(JSON.stringify(input).length)
      return input
    }
    if (typeof input !== 'object' || seen.has(input)) throw new Error('invalid-journal-json')
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      throw new Error('invalid-journal-json')
    }
    seen.add(input)
    reserve(2)
    let result
    if (Array.isArray(input)) {
      reserve(Math.max(0, input.length - 1))
      result = Array.from(input, (entry) => canonical(entry, depth + 1))
    } else {
      const keys = Object.keys(input).sort()
      reserve(Math.max(0, keys.length - 1))
      result = Object.fromEntries(
        keys.map((key) => {
          stringSize(key)
          reserve(1)
          return [key, canonical(input[key], depth + 1)]
        })
      )
    }
    seen.delete(input)
    return result
  }
  const text = JSON.stringify(canonical(value, 0))
  if (Buffer.byteLength(text) > maximum) throw new Error('journal-payload-too-large')
  return text
}

function jobValue(row) {
  return row
    ? {
        id: row.id,
        inputHash: row.input_hash,
        spec: JSON.parse(row.spec_json),
        phase: row.phase,
        threadId: row.thread_id,
        turnId: row.turn_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null
}

function requestValue(row) {
  return row
    ? {
        id: row.id,
        sessionId: row.session_id,
        method: row.method,
        payload: JSON.parse(row.payload_json),
        status: row.status,
        result: row.result_json === null ? null : JSON.parse(row.result_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null
}

function eventValue(row) {
  return { seq: row.seq, type: row.type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }
}

/** One bounded experimental job. This journal never starts a provider operation. */
export function openJournal(file, { now = Date.now } = {}) {
  if (typeof file !== 'string' || !file.startsWith('/')) throw new Error('journal-absolute-path-required')
  const directory = dirname(file)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(file)
  chmodSync(file, 0o600)
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS journal_meta (id INTEGER PRIMARY KEY CHECK(id = 1), session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL UNIQUE,
      input_hash TEXT NOT NULL, spec_json TEXT NOT NULL, phase TEXT NOT NULL,
      thread_id TEXT, turn_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_request (
      session_id TEXT NOT NULL, id TEXT NOT NULL, method TEXT NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'expired')),
      result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, id)
    );
    CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event BEGIN
      SELECT RAISE(ABORT, 'journal-events-append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event BEGIN
      SELECT RAISE(ABORT, 'journal-events-append-only');
    END;
  `)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600)
  }

  const sessionId = randomUUID()
  let closed = false
  const getJob = () => jobValue(database.prepare('SELECT * FROM job WHERE singleton = 1').get())
  const stamp = () => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid-journal-clock')
    return value
  }
  function assertSession() {
    if (closed) throw new Error('journal-closed')
    if (database.prepare('SELECT session_id FROM journal_meta WHERE id = 1').get()?.session_id !== sessionId) {
      throw new Error('journal-session-expired')
    }
  }
  function transaction(callback, checkSession = true) {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (checkSession) assertSession()
      const result = callback()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  function append(type, payload, at = stamp()) {
    identifier(type, 'event-type', 100)
    const text = encode(payload, JOURNAL_LIMITS.eventBytes)
    if (database.prepare('SELECT COUNT(*) AS count FROM event').get().count >= JOURNAL_LIMITS.maxEvents) {
      throw new Error('journal-event-limit')
    }
    const row = database
      .prepare('INSERT INTO event(type, payload_json, created_at) VALUES (?, ?, ?) RETURNING *')
      .get(type, text, at)
    return eventValue(row)
  }
  function pending() {
    return database
      .prepare("SELECT * FROM server_request WHERE status = 'pending' ORDER BY created_at, id")
      .all()
      .map(requestValue)
  }
  function expirePending(at, reason) {
    const requests = pending()
    database.prepare("UPDATE server_request SET status = 'expired', updated_at = ? WHERE status = 'pending'").run(at)
    if (requests.length)
      append('requests-expired', { reason, requests: requests.map(({ id, sessionId }) => ({ id, sessionId })) }, at)
  }
  function transitionInside({ phase, threadId, turnId }, at = stamp()) {
    if (!phases.has(phase)) throw new Error('invalid-job-phase')
    const job = getJob()
    if (!job) throw new Error('journal-job-missing')
    if (threadId !== undefined) identifier(threadId, 'thread-id')
    if (turnId !== undefined) identifier(turnId, 'turn-id')
    if (job.threadId && threadId !== undefined && job.threadId !== threadId) throw new Error('journal-thread-conflict')
    if (job.turnId && turnId !== undefined && job.turnId !== turnId) throw new Error('journal-turn-conflict')
    const nextThread = threadId ?? job.threadId
    const nextTurn = turnId ?? job.turnId
    if (phase !== job.phase && !transitions[job.phase]?.includes(phase)) throw new Error('invalid-job-transition')
    if (terminal.has(job.phase) && (nextThread !== job.threadId || nextTurn !== job.turnId)) {
      throw new Error('journal-terminal-immutable')
    }
    if (nextTurn && !nextThread) throw new Error('journal-thread-required')
    if (nextTurn && ['thread-start-intent', 'thread-bound', 'turn-start-intent'].includes(phase)) {
      throw new Error('journal-turn-before-running')
    }
    if (['thread-bound', 'turn-start-intent', 'running', 'waiting', 'completed'].includes(phase) && !nextThread) {
      throw new Error('journal-thread-required')
    }
    if (['running', 'waiting', 'completed'].includes(phase) && !nextTurn) throw new Error('journal-turn-required')
    if (['running', 'completed'].includes(phase) && pending().length) throw new Error('journal-pending-requests')
    if (phase === job.phase && nextThread === job.threadId && nextTurn === job.turnId) return job
    if (['recovery-required', 'stopped'].includes(phase)) expirePending(at, phase)
    database
      .prepare('UPDATE job SET phase = ?, thread_id = ?, turn_id = ?, updated_at = ? WHERE singleton = 1')
      .run(phase, nextThread, nextTurn, at)
    append('job-transition', { from: job.phase, phase, threadId: nextThread, turnId: nextTurn }, at)
    return getJob()
  }

  try {
    transaction(() => {
      const at = stamp()
      database
        .prepare(`INSERT INTO journal_meta(id, session_id) VALUES(1, ?)
        ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id`)
        .run(sessionId)
      expirePending(at, 'coordinator-restart')
      const job = getJob()
      if (job && !terminal.has(job.phase) && job.phase !== 'recovery-required') {
        transitionInside({ phase: 'recovery-required' }, at)
      }
    }, false)
  } catch (error) {
    database.close()
    throw error
  }

  return {
    sessionId,
    getJob,
    submit({ id, spec }) {
      identifier(id, 'job-id')
      const text = encode(spec, JOURNAL_LIMITS.specBytes)
      const hash = createHash('sha256').update(text).digest('hex')
      return transaction(() => {
        const existing = getJob()
        if (existing) {
          if (existing.id !== id) throw new Error('journal-single-job-only')
          if (existing.inputHash !== hash) throw new Error('journal-input-conflict')
          return { created: false, job: existing }
        }
        const at = stamp()
        database
          .prepare(`INSERT INTO job(singleton, id, input_hash, spec_json, phase, created_at, updated_at)
          VALUES (1, ?, ?, ?, 'thread-start-intent', ?, ?)`)
          .run(id, hash, text, at, at)
        append('job-submitted', { id, inputHash: hash, phase: 'thread-start-intent' }, at)
        return { created: true, job: getJob() }
      })
    },
    transition(input) {
      return transaction(() => transitionInside(input))
    },
    appendEvent(type, payload) {
      return transaction(() => append(type, payload))
    },
    events({ afterSeq = 0, limit = JOURNAL_LIMITS.readEvents } = {}) {
      if (
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > JOURNAL_LIMITS.readEvents
      ) {
        throw new Error('invalid-journal-event-range')
      }
      return database
        .prepare('SELECT * FROM event WHERE seq > ? ORDER BY seq LIMIT ?')
        .all(afterSeq, limit)
        .map(eventValue)
    },
    putRequest({ id, method, payload }) {
      identifier(id, 'request-id')
      identifier(method, 'request-method')
      const text = encode(payload, JOURNAL_LIMITS.requestBytes)
      return transaction(() => {
        const row = database.prepare('SELECT * FROM server_request WHERE session_id = ? AND id = ?').get(sessionId, id)
        if (row) {
          if (row.method !== method || row.payload_json !== text) throw new Error('journal-request-conflict')
          return requestValue(row)
        }
        if (!['running', 'waiting'].includes(getJob()?.phase)) throw new Error('journal-request-outside-running-turn')
        if (
          pending().length >= JOURNAL_LIMITS.maxPendingRequests ||
          database.prepare('SELECT COUNT(*) AS count FROM server_request').get().count >= JOURNAL_LIMITS.maxRequests
        ) {
          throw new Error('journal-request-limit')
        }
        const at = stamp()
        database
          .prepare(`INSERT INTO server_request(session_id, id, method, payload_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
          .run(sessionId, id, method, text, at, at)
        append('request-pending', { id, sessionId, method }, at)
        transitionInside({ phase: 'waiting' }, at)
        return requestValue(
          database.prepare('SELECT * FROM server_request WHERE session_id = ? AND id = ?').get(sessionId, id)
        )
      })
    },
    latestEvent(type) {
      identifier(type, 'event-type', 100)
      const row = database.prepare('SELECT * FROM event WHERE type = ? ORDER BY seq DESC LIMIT 1').get(type)
      return row ? eventValue(row) : null
    },
    pendingRequests: pending,
    expireRequest({ id, sessionId: requestSession, reason }) {
      identifier(id, 'request-id')
      identifier(reason, 'request-expiry-reason')
      return transaction(() => {
        if (requestSession !== sessionId) throw new Error('journal-request-session-expired')
        const row = database.prepare('SELECT * FROM server_request WHERE session_id = ? AND id = ?').get(sessionId, id)
        if (!row) throw new Error('journal-request-missing')
        if (row.status !== 'pending') return requestValue(row)
        const at = stamp()
        database
          .prepare("UPDATE server_request SET status = 'expired', updated_at = ? WHERE session_id = ? AND id = ?")
          .run(at, sessionId, id)
        append('request-expired', { id, sessionId, reason }, at)
        if (!pending().length && getJob()?.phase === 'waiting') transitionInside({ phase: 'running' }, at)
        return requestValue(
          database.prepare('SELECT * FROM server_request WHERE session_id = ? AND id = ?').get(sessionId, id)
        )
      })
    },
    resolveRequest({ id, sessionId: requestSession, result }) {
      identifier(id, 'request-id')
      const text = encode(result, JOURNAL_LIMITS.resultBytes)
      return transaction(() => {
        if (requestSession !== sessionId) throw new Error('journal-request-session-expired')
        const row = database.prepare('SELECT * FROM server_request WHERE session_id = ? AND id = ?').get(sessionId, id)
        if (!row || row.status === 'expired') throw new Error('journal-request-expired')
        if (row.status === 'resolved') {
          if (row.result_json !== text) throw new Error('journal-request-result-conflict')
          return requestValue(row)
        }
        if (!['running', 'waiting'].includes(getJob()?.phase)) throw new Error('journal-request-outside-running-turn')
        const at = stamp()
        database
          .prepare(
            "UPDATE server_request SET status = 'resolved', result_json = ?, updated_at = ? WHERE session_id = ? AND id = ?"
          )
          .run(text, at, sessionId, id)
        append('request-resolved', { id, sessionId }, at)
        if (!pending().length) transitionInside({ phase: 'running' }, at)
        return requestValue(
          database.prepare('SELECT * FROM server_request WHERE session_id = ? AND id = ?').get(sessionId, id)
        )
      })
    },
    close() {
      if (closed) return
      closed = true
      database.close()
    },
  }
}
