import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_REQUEST = 70_000
const MAX_SPEC = 65_536
const MAX_RESPONSE = 2 * 1024 * 1024
const ASSIGNMENT_KEYS = ['jobId', 'messageId', 'workItemId', 'sessionId']
const INPUT_KEYS = ['prompt', 'model', 'systemPrompt', 'effort', 'threadId', 'reviewTtlMs', 'tools']
const TERMINAL = new Set(['completed', 'stopped'])
const PHASES = new Set([
  'thread-start-intent',
  'thread-bound',
  'turn-start-intent',
  'running',
  'waiting',
  'recovery-required',
  ...TERMINAL,
])

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
}
function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function invalid() {
  throw new Error('router-invalid-request')
}
function canonical(value) {
  let nodes = 0
  function visit(item, depth) {
    if (++nodes > 10_000 || depth > 20) invalid()
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, visit(item[key], depth + 1)])
      )
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      return item
    invalid()
  }
  return JSON.stringify(visit(value, 0))
}
function parseRequest(text) {
  if (typeof text !== 'string') invalid()
  if (Buffer.byteLength(text) > MAX_REQUEST) throw new Error('router-request-too-large')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    invalid()
  }
  const keys = {
    prepare: ['op', 'assignment', 'input'],
    register: ['op', 'assignment', 'input', 'prepared'],
    'cancel-unsubmitted': ['op', 'assignment', 'inputHash'],
    submit: ['op', 'assignment'],
    snapshot: ['op', 'assignment', ...(Object.hasOwn(value ?? {}, 'afterSeq') ? ['afterSeq'] : [])],
    reply: ['op', 'assignment', 'requestId', 'sessionId', 'result'],
    stop: ['op', 'assignment'],
  }
  if (!value || !Object.hasOwn(keys, value.op) || !exact(value, keys[value.op])) invalid()
  if (!exact(value.assignment, ASSIGNMENT_KEYS) || !ASSIGNMENT_KEYS.every((key) => identifier(value.assignment[key])))
    invalid()
  if (
    value.op === 'snapshot' &&
    value.afterSeq !== undefined &&
    (!Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0)
  )
    invalid()
  if (value.op === 'reply' && (!boundedString(value.requestId, 200) || !boundedString(value.sessionId, 200))) invalid()
  if (
    value.op === 'cancel-unsubmitted' &&
    (typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputHash))
  )
    invalid()
  if (
    value.op === 'register' &&
    !exact(value.prepared, [
      'version',
      'targetId',
      'targetEpoch',
      'root',
      'assignment',
      'directory',
      'workspace',
      'inputHash',
    ])
  )
    invalid()
  if (value.op === 'register' || value.op === 'prepare') {
    const input = value.input
    if (
      !exact(input, INPUT_KEYS) ||
      typeof input.prompt !== 'string' ||
      input.prompt.length > 30_000 ||
      typeof input.systemPrompt !== 'string' ||
      input.systemPrompt.length > 20_000 ||
      typeof input.model !== 'string' ||
      !/^[a-z0-9.-]{1,80}$/.test(input.model) ||
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.effort) ||
      (input.threadId !== null && !boundedString(input.threadId, 200)) ||
      !Number.isInteger(input.reviewTtlMs) ||
      input.reviewTtlMs < 5000 ||
      input.reviewTtlMs > 300_000 ||
      !Array.isArray(input.tools) ||
      input.tools.length > 1 ||
      input.tools.some(
        (tool) =>
          !exact(tool, ['name', 'description', 'inputSchema']) ||
          tool.name !== 'remember_memory' ||
          typeof tool.description !== 'string' ||
          tool.description.length > 4000 ||
          !tool.inputSchema ||
          typeof tool.inputSchema !== 'object' ||
          Array.isArray(tool.inputSchema)
      )
    )
      invalid()
  }
  canonical(value)
  return value
}
function descriptor(row, target) {
  return {
    version: 2,
    ...target,
    assignment: JSON.parse(row.assignment_json),
    directory: row.directory,
    workspace: row.workspace,
    inputHash: row.input_hash,
  }
}
function jsonResponse(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    throw new Error('router-child-invalid-response')
  }
  if (!text || Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('router-child-invalid-response')
  return JSON.parse(text)
}

/** Isolated routing experiment. The injected transport, not this registry, owns child processes. */
export function openJobRouterV2({ directory, targetId, targetEpoch, connectChild }) {
  if (
    typeof directory !== 'string' ||
    !directory.startsWith('/') ||
    !identifier(targetId) ||
    !identifier(targetEpoch) ||
    typeof connectChild !== 'function'
  )
    invalid()
  directory = realpathSync(directory)
  const target = { targetId, targetEpoch, root: directory }
  const file = join(directory, 'registry-v2.sqlite')
  const database = new DatabaseSync(file)
  const owner = randomUUID()
  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS router_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL,
        target_id TEXT NOT NULL, target_epoch TEXT NOT NULL, root TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS router_job (
        job_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, work_item_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, assignment_json TEXT NOT NULL,
        input_json TEXT NOT NULL, spec_json TEXT NOT NULL, directory TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL UNIQUE,
        dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('reserved','dispatch-intent','cancelled-unsubmitted')),
        created_at INTEGER NOT NULL, cancelled_at INTEGER
      );
      BEGIN IMMEDIATE;`)
    try {
      const previous = database.prepare('SELECT * FROM router_meta WHERE id=1').get()
      if (
        previous &&
        (previous.target_id !== targetId || previous.target_epoch !== targetEpoch || previous.root !== directory)
      )
        throw new Error('router-target-mismatch')
      database
        .prepare(`INSERT INTO router_meta(id,session_id,target_id,target_epoch,root) VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id`)
        .run(owner, targetId, targetEpoch, directory)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    chmodSync(directory, 0o700)
    for (const suffix of ['', '-wal', '-shm']) chmodSync(file + suffix, 0o600)
  } catch (error) {
    database.close()
    throw error
  }
  let closed = false
  let queued = 0
  let tail = Promise.resolve()
  function assertOwner() {
    if (closed) throw new Error('router-closed')
    if (database.prepare('SELECT session_id FROM router_meta WHERE id=1').get()?.session_id !== owner)
      throw new Error('router-session-expired')
  }
  function transaction(callback) {
    database.exec('BEGIN IMMEDIATE')
    try {
      assertOwner()
      const result = callback()
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  function lookup(assignment) {
    const row = database.prepare('SELECT * FROM router_job WHERE job_id=?').get(assignment.jobId)
    if (!row) throw new Error('router-job-missing')
    if (row.assignment_json !== canonical(assignment)) throw new Error('router-assignment-conflict')
    return row
  }
  function checkJob(job, row) {
    if (
      !job ||
      job.id !== row.job_id ||
      job.inputHash !== row.input_hash ||
      canonical(job.spec) !== row.spec_json ||
      !PHASES.has(job.phase)
    )
      throw new Error('router-child-job-mismatch')
    if (
      ['running', 'waiting', 'completed'].includes(job.phase) &&
      (!boundedString(job.threadId, 200) || !boundedString(job.turnId, 200))
    )
      throw new Error('router-child-job-mismatch')
    if (job.stopReason !== undefined && job.stopReason !== 'request-expired')
      throw new Error('router-child-invalid-reason')
  }
  async function withChild(row, callback) {
    const child = await connectChild(descriptor(row, target))
    try {
      assertOwner()
      const hello = jsonResponse(await child.request('hello'))
      assertOwner()
      if (
        hello?.protocol !== 'remember-host-job-v1' ||
        hello.singleJob !== true ||
        hello.nativeClient !== true ||
        hello.workspace !== row.workspace ||
        !boundedString(hello.sessionId, 200) ||
        (hello.jobId !== null && hello.jobId !== row.job_id)
      )
        throw new Error('router-child-hello-mismatch')
      return await callback(child, hello)
    } finally {
      await child.close()
    }
  }
  async function readSnapshot(child, hello, row, afterSeq = 0, submitted = false) {
    assertOwner()
    const snapshot = jsonResponse(await child.request('snapshot', { afterSeq }))
    assertOwner()
    if (
      !snapshot ||
      snapshot.sessionId !== hello.sessionId ||
      !Array.isArray(snapshot.events) ||
      snapshot.events.length > 100 ||
      !Array.isArray(snapshot.requests) ||
      snapshot.requests.length > 16
    )
      throw new Error('router-child-snapshot-mismatch')
    if (snapshot.job !== null) {
      if (hello.jobId === null && !submitted) throw new Error('router-child-hello-mismatch')
      checkJob(snapshot.job, row)
    } else if (hello.jobId !== null) throw new Error('router-child-job-mismatch')
    let cursor = afterSeq
    for (const event of snapshot.events) {
      if (!Number.isSafeInteger(event?.seq) || event.seq <= cursor || !boundedString(event.type, 100))
        throw new Error('router-child-event-order')
      cursor = event.seq
    }
    const ids = new Set()
    for (const request of snapshot.requests) {
      if (
        !snapshot.job ||
        !boundedString(request?.id, 200) ||
        ids.has(request.id) ||
        request.sessionId !== snapshot.sessionId ||
        request.status !== 'pending' ||
        !['client-tool', 'provider-approval'].includes(request.method) ||
        !Number.isSafeInteger(request.payload?.expiresAt)
      )
        throw new Error('router-child-request-mismatch')
      if (
        request.method === 'client-tool' &&
        (request.payload.threadId !== snapshot.job.threadId ||
          request.payload.turnId !== snapshot.job.turnId ||
          !boundedString(request.payload.callId, 200))
      )
        throw new Error('router-child-request-mismatch')
      ids.add(request.id)
    }
    if (
      snapshot.job?.phase === 'completed' &&
      (typeof snapshot.result?.response !== 'string' || snapshot.result.threadId !== snapshot.job.threadId)
    )
      throw new Error('router-child-result-mismatch')
    if (TERMINAL.has(snapshot.job?.phase) && snapshot.requests.length) throw new Error('router-child-request-mismatch')
    return snapshot
  }
  function wrap(row, snapshot) {
    if (row.dispatch_state === 'cancelled-unsubmitted')
      return {
        descriptor: descriptor(row, target),
        state: 'cancelled-unsubmitted',
        snapshot: null,
        cancellation: { kind: 'unsubmitted', at: row.cancelled_at },
      }
    const phase = snapshot?.job?.phase
    const state = !phase
      ? row.dispatch_state === 'reserved'
        ? 'reserved'
        : 'recovery-required'
      : ['running', 'waiting', 'completed', 'stopped'].includes(phase)
        ? phase
        : 'recovery-required'
    return { descriptor: descriptor(row, target), state, snapshot }
  }
  function observe(row, afterSeq = 0) {
    if (row.dispatch_state === 'reserved' || row.dispatch_state === 'cancelled-unsubmitted')
      return Promise.resolve(wrap(row, null))
    return withChild(row, async (child, hello) => wrap(row, await readSnapshot(child, hello, row, afterSeq)))
  }
  function prepare(assignment, input) {
    const childDirectory = join(
      directory,
      'jobs',
      createHash('sha256').update(assignment.jobId).digest('hex').slice(0, 24)
    )
    if (Buffer.byteLength(join(childDirectory, 'client.sock')) > 100) throw new Error('router-child-path-too-long')
    const workspace = join(childDirectory, 'workspace')
    const spec = { ...input, workspace }
    const specText = canonical(spec)
    if (
      Buffer.byteLength(specText) > MAX_SPEC ||
      Buffer.byteLength(JSON.stringify({ op: 'submit', id: Number.MAX_SAFE_INTEGER, jobId: assignment.jobId, spec })) +
        1 >
        MAX_REQUEST
    )
      throw new Error('router-request-too-large')
    return {
      descriptor: descriptor(
        {
          assignment_json: canonical(assignment),
          directory: childDirectory,
          workspace,
          input_hash: createHash('sha256').update(specText).digest('hex'),
        },
        target
      ),
      specText,
    }
  }
  async function register(message) {
    const { assignment, input } = message
    const prepared = prepare(assignment, input)
    if (canonical(message.prepared) !== canonical(prepared.descriptor)) throw new Error('router-prepared-mismatch')
    const { directory: childDirectory, workspace } = prepared.descriptor
    const { specText } = prepared
    const existing = database.prepare('SELECT * FROM router_job WHERE job_id=?').get(assignment.jobId)
    if (existing) {
      lookup(assignment)
      if (existing.input_json !== canonical(input)) throw new Error('router-input-conflict')
      if (existing.dispatch_state === 'reserved') mkdirSync(existing.directory, { recursive: true, mode: 0o700 })
      return descriptor(existing, target)
    }
    if (
      database
        .prepare('SELECT job_id FROM router_job WHERE message_id=? OR session_id=?')
        .get(assignment.messageId, assignment.sessionId)
    )
      throw new Error('router-assignment-conflict')
    const last = database.prepare('SELECT * FROM router_job ORDER BY rowid DESC LIMIT 1').get()
    if (last) {
      const current = await observe(last)
      if (!TERMINAL.has(current.state) && current.state !== 'cancelled-unsubmitted')
        throw new Error('router-active-job')
    }
    transaction(() => {
      if (database.prepare('SELECT count(*) AS count FROM router_job').get().count >= 32)
        throw new Error('router-job-limit')
      database
        .prepare(`INSERT INTO router_job(job_id,message_id,work_item_id,session_id,input_hash,assignment_json,input_json,spec_json,directory,workspace,dispatch_state,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?)`)
        .run(
          assignment.jobId,
          assignment.messageId,
          assignment.workItemId,
          assignment.sessionId,
          createHash('sha256').update(specText).digest('hex'),
          canonical(assignment),
          canonical(input),
          specText,
          childDirectory,
          workspace,
          Date.now()
        )
    })
    mkdirSync(childDirectory, { recursive: true, mode: 0o700 })
    return descriptor(lookup(assignment), target)
  }
  async function handle(message) {
    assertOwner()
    if (message.op === 'prepare') return prepare(message.assignment, message.input).descriptor
    if (message.op === 'register') return register(message)
    let row = lookup(message.assignment)
    if (message.op === 'snapshot') return observe(row, message.afterSeq ?? 0)
    if (message.op === 'cancel-unsubmitted') {
      transaction(() => {
        row = lookup(message.assignment)
        if (row.input_hash !== message.inputHash) throw new Error('router-input-conflict')
        if (row.dispatch_state === 'cancelled-unsubmitted') return
        if (row.dispatch_state !== 'reserved') throw new Error('router-cancel-not-unsubmitted')
        const changed = database
          .prepare(
            "UPDATE router_job SET dispatch_state='cancelled-unsubmitted',cancelled_at=? WHERE job_id=? AND dispatch_state='reserved'"
          )
          .run(Date.now(), row.job_id)
        if (Number(changed.changes) !== 1) throw new Error('router-cancel-not-unsubmitted')
      })
      return wrap(lookup(message.assignment), null)
    }
    if (row.dispatch_state === 'cancelled-unsubmitted') throw new Error('router-reservation-cancelled')
    if (message.op === 'submit') {
      if (row.dispatch_state !== 'reserved') return observe(row)
      transaction(() => {
        const changed = database
          .prepare(
            "UPDATE router_job SET dispatch_state='dispatch-intent' WHERE job_id=? AND dispatch_state='reserved'"
          )
          .run(row.job_id)
        if (Number(changed.changes) !== 1) throw new Error('router-submit-intent-not-persisted')
      })
      row = lookup(message.assignment)
      return withChild(row, async (child, hello) => {
        const before = await readSnapshot(child, hello, row)
        if (before.job !== null) throw new Error('router-child-not-empty')
        assertOwner()
        const receipt = jsonResponse(
          await child.request('submit', { jobId: row.job_id, spec: JSON.parse(row.spec_json) })
        )
        assertOwner()
        if (receipt?.created !== true) throw new Error('router-child-submit-unconfirmed')
        checkJob(receipt.job, row)
        return wrap(row, await readSnapshot(child, hello, row, 0, true))
      })
    }
    if (row.dispatch_state === 'reserved') throw new Error('router-start-unconfirmed')
    return withChild(row, async (child, hello) => {
      const snapshot = await readSnapshot(child, hello, row)
      if (!snapshot.job) throw new Error('router-start-unconfirmed')
      if (message.op === 'reply') {
        const request = snapshot.requests.find((entry) => entry.id === message.requestId)
        if (message.sessionId !== snapshot.sessionId || !request || request.payload.expiresAt <= Date.now())
          throw new Error('router-review-invalid')
        assertOwner()
        const receipt = jsonResponse(
          await child.request('reply', {
            requestId: message.requestId,
            sessionId: message.sessionId,
            result: message.result,
          })
        )
        assertOwner()
        if (
          receipt?.id !== message.requestId ||
          receipt.sessionId !== snapshot.sessionId ||
          receipt.status !== 'resolved'
        )
          throw new Error('router-child-reply-unconfirmed')
      } else {
        assertOwner()
        const receipt = jsonResponse(await child.request('stop'))
        assertOwner()
        checkJob(receipt, row)
        if (!TERMINAL.has(receipt.phase)) throw new Error('router-child-stop-unconfirmed')
      }
      return wrap(row, await readSnapshot(child, hello, row))
    })
  }
  return {
    async request(text) {
      const message = parseRequest(text)
      assertOwner()
      if (queued >= 32) throw new Error('router-queue-full')
      queued++
      const next = tail.then(() => handle(message))
      tail = next.catch(() => {})
      try {
        return await next
      } finally {
        queued--
      }
    },
    close() {
      if (closed) return
      if (queued) throw new Error('router-busy')
      closed = true
      database.close()
    },
  }
}
