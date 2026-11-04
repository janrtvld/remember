import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { validateBriefingOutput } from '../proactive-agent/briefing-models/validateOutput.mjs'
import {
  BRIEFING_LIMITS,
  BRIEFING_PROTOCOL,
  canonicalBriefingJson,
  hashBriefingText,
  hashBriefingValue,
  validateBriefingDescriptor,
  validateBriefingObservation,
  validateBriefingResult,
  validateBriefingSlot,
  validateBriefingSpec,
} from './briefing-protocol.mjs'

const error = (reason) => {
  throw new Error(`briefing-${reason}`)
}
const exact = (v, keys) => {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    error('request-keys')
}
const escaped = (value) => value.replace(/[\\`*_{}[\]<>#+.!|~-]/g, '\\$&').replace(/\r?\n/g, ' ')
export function renderBriefingMarkdown(output) {
  if (output.kind === 'silent') return null
  const line = (item) =>
    `${escaped(item.text)}\n${item.quotes.map((q) => `> ${escaped(q.quote)} — ${escaped(q.sourceId)}`).join('\n')}\n`
  const b = output.briefing
  return `# ${escaped(b.title)}\n\n${line(output.reason)}\n## Decision\n\n${line(b.decision)}\n## Facts\n\n${b.facts.map(line).join('\n')}\n## Open points\n\n${b.openPoints.map(line).join('\n')}\n## Questions\n\n${b.questions.map(line).join('\n')}`
}
function identity(directory) {
  const s = lstatSync(directory)
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o077) !== 0
  )
    error('workspace-identity')
  return { dev: s.dev, ino: s.ino }
}
function sameIdentity(directory, pinned) {
  const s = identity(directory)
  if (s.dev !== pinned.dev || s.ino !== pinned.ino) error('workspace-replaced')
}
function validateDirectories(d) {
  let current = d.workspace
  while (current !== dirname(d.root)) {
    const s = lstatSync(current)
    if (s.isSymbolicLink() || !s.isDirectory() || realpathSync(current) !== current) error('directory-invalid')
    current = dirname(current)
  }
  identity(d.root)
  identity(d.directory)
  return identity(d.workspace)
}
function readFixed(d, pinned, receipt) {
  validateDirectories(d)
  sameIdentity(d.workspace, pinned)
  const fd = openSync(join(d.workspace, 'briefing.md'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o600 ||
      s.size !== receipt.byteLength ||
      s.size > BRIEFING_LIMITS.outputBytes
    )
      error('result-file-invalid')
    const content = readFileSync(fd, 'utf8')
    sameIdentity(d.workspace, pinned)
    return validateBriefingResult({ version: 1, receipt, content }, d)
  } finally {
    closeSync(fd)
  }
}

export function createBriefingHost({
  descriptor: inputDescriptor,
  slot: inputSlot,
  executor,
  clock = Date.now,
  monotonic = () => performance.now(),
  fault = () => {},
}) {
  let descriptor = inputDescriptor ? validateBriefingDescriptor(inputDescriptor) : null
  const slot = validateBriefingSlot(
    inputSlot ??
      Object.fromEntries(
        ['version', 'targetId', 'targetEpoch', 'root', 'directory', 'workspace', 'jobId'].map((k) => [
          k,
          descriptor?.[k],
        ])
      )
  )
  if (descriptor && Object.keys(slot).some((k) => slot[k] !== descriptor[k])) error('slot-descriptor-conflict')
  const pinned = validateDirectories(slot)
  const sessionId = randomUUID(),
    socketPath = join(slot.directory, 'briefing.sock')
  const dbPath = join(slot.directory, 'briefing.sqlite')
  const db = new DatabaseSync(dbPath)
  chmodSync(dbPath, 0o600)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK(id=1), descriptor TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS write_intent (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_event_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT,'immutable-event'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_event_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT,'immutable-event'); END;`)
  let closed = false,
    server = null,
    active = null,
    pendingContent = null,
    leaseStart = null,
    leaseTimer = null,
    lastMono = monotonic()
  const sockets = new Set()
  const own = () => {
    if (closed || db.prepare("SELECT value FROM metadata WHERE key='owner'").get()?.value !== sessionId)
      error('owner-lost')
  }
  const row = () => db.prepare('SELECT * FROM job WHERE id=1').get()
  const state = () => {
    const r = row()
    return r ? JSON.parse(r.state) : null
  }
  const changed = (result) => {
    if (result.changes !== 1) error('zero-row')
  }
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  const stamp = () => {
    const now = clock()
    if (!Number.isSafeInteger(now) || now < 0) error('clock-invalid')
    const s = state()
    if (s && now < s.updatedAt) error('clock-regression')
    return now
  }
  const tick = () => {
    const now = monotonic()
    if (!Number.isFinite(now) || now < lastMono) error('monotonic-regression')
    lastMono = now
    return now
  }
  const append = (type, data = {}, at = stamp()) => {
    if (db.prepare('SELECT COUNT(*) AS n FROM event').get().n >= BRIEFING_LIMITS.maxEvents) error('events-bound')
    changed(db.prepare('INSERT INTO event(type,at,data)VALUES(?,?,?)').run(type, at, canonicalBriefingJson(data)))
  }
  const save = (s, type, data = {}) => {
    own()
    changed(db.prepare('UPDATE job SET state=? WHERE id=1').run(canonicalBriefingJson(s)))
    append(type, data, s.updatedAt)
  }
  const mutate = (type, fn, data = {}) =>
    transaction(() => {
      own()
      const s = state()
      if (!s) error('job-missing')
      fn(s)
      save(s, type, data)
      return s
    })
  const clearLease = () => {
    clearTimeout(leaseTimer)
    leaseTimer = null
    leaseStart = null
    pendingContent = null
  }
  transaction(() => {
    const prior = db.prepare("SELECT value FROM metadata WHERE key='descriptor'").get()
    if (prior && descriptor && prior.value !== canonicalBriefingJson(descriptor))
      error('configured-descriptor-conflict')
    if (prior) descriptor = validateBriefingDescriptor(JSON.parse(prior.value))
    if (descriptor && Object.keys(slot).some((k) => slot[k] !== descriptor[k])) error('slot-descriptor-conflict')
    const oldSlot = db.prepare("SELECT value FROM metadata WHERE key='slot'").get()
    if (oldSlot && oldSlot.value !== canonicalBriefingJson(slot)) error('configured-slot-conflict')
    if (!oldSlot) changed(db.prepare("INSERT INTO metadata VALUES('slot',?)").run(canonicalBriefingJson(slot)))
    if (descriptor && !prior)
      changed(db.prepare("INSERT INTO metadata VALUES('descriptor',?)").run(canonicalBriefingJson(descriptor)))
    changed(
      db
        .prepare("INSERT INTO metadata VALUES('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(sessionId)
    )
    const s = state()
    if (s) {
      if (!['completed', 'stopped'].includes(s.phase)) {
        s.phase = 'unknown'
        s.error = 'host-restarted'
        s.permission = null
        s.completion = null
        s.updatedAt = stamp()
        save(s, 'recovery-required')
      } else append('session-opened', {}, s.updatedAt)
    }
  })
  const binding = (p) => {
    if (!descriptor || ['actionId', 'jobId', 'inputHash'].some((k) => p[k] !== descriptor[k])) error('binding-mismatch')
    if (!row()) error('job-missing')
  }
  const snapshot = (afterSeq) => {
    own()
    const s = state()
    if (!s) error('job-missing')
    const cursor = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM event').get().seq
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > cursor) error('cursor-invalid')
    const events = db
      .prepare('SELECT * FROM event WHERE seq>? ORDER BY seq')
      .all(afterSeq)
      .map((e) => ({ seq: e.seq, type: e.type, at: e.at, data: JSON.parse(e.data) }))
    return validateBriefingObservation({ version: 1, sessionId, descriptor, ...s, cursor, events }, descriptor)
  }
  const failJob = (reason) => {
    clearLease()
    try {
      mutate(
        'unknown',
        (s) => {
          if (['completed', 'stopped'].includes(s.phase)) return
          s.phase = 'unknown'
          s.error = reason
          s.permission = null
          s.completion = null
          s.updatedAt = stamp()
        },
        { reason }
      )
    } catch {}
  }
  const start = (spec) => {
    const controller = new AbortController()
    const operation = { controller, promise: null }
    const deadline = setTimeout(() => {
      controller.abort(new Error('briefing-host-timeout'))
      failJob('host-timeout')
    }, spec.preparedInput.maxDurationMs)
    active = operation
    operation.promise = (async () => {
      try {
        own()
        if (state().phase !== 'accepted') return
        mutate('executor-start-intent', (s) => {
          s.phase = 'executing'
          s.updatedAt = stamp()
        })
        const result = await executor.run(spec, {
          signal: controller.signal,
          onExecution: (execution) => {
            own()
            if (controller.signal.aborted && !execution.exit) return
            const current = state()
            if (
              current.phase !== 'executing' &&
              !(controller.signal.aborted && execution.exit && current.phase === 'unknown')
            )
              error('execution-phase')
            if (current.execution) {
              if (
                current.execution.invocationId !== execution.invocationId ||
                (current.execution.pid !== null && current.execution.pid !== execution.pid) ||
                (current.execution.providerThreadId !== null &&
                  current.execution.providerThreadId !== execution.providerThreadId) ||
                (current.execution.exit !== null &&
                  canonicalBriefingJson(current.execution.exit) !== canonicalBriefingJson(execution.exit))
              )
                error('execution-identity')
            }
            const candidate = { ...snapshot(0), execution }
            validateBriefingObservation(candidate, descriptor)
            mutate('execution-observed', (s) => {
              s.execution = JSON.parse(canonicalBriefingJson(execution))
              s.updatedAt = stamp()
            })
          },
        })
        own()
        if (controller.signal.aborted) return
        if (
          canonicalBriefingJson(result.execution) !== canonicalBriefingJson(state().execution) ||
          !result.execution.exit ||
          result.execution.exit.code !== 0 ||
          result.execution.exit.signal !== null ||
          !result.execution.providerThreadId
        )
          error('executor-exit-unconfirmed')
        if (result.usage)
          mutate(
            'inference-finished',
            (s) => {
              s.updatedAt = stamp()
            },
            { model: spec.preparedInput.model, effort: spec.preparedInput.effort, usage: result.usage }
          )
        const parsed = validateBriefingOutput(result.rawOutput, JSON.parse(spec.preparedInput.prompt))
        if (!parsed.valid) error('output-invalid')
        if (parsed.output.kind === 'silent') {
          mutate('completed', (s) => {
            s.phase = 'completed'
            s.completion = 'silent'
            s.updatedAt = stamp()
          })
          return
        }
        const content = renderBriefingMarkdown(parsed.output)
        if (Buffer.byteLength(content) > spec.preparedInput.maxOutputBytes) error('output-bound')
        const contentHash = hashBriefingText(content),
          byteLength = Buffer.byteLength(content),
          at = stamp()
        transaction(() => {
          own()
          const s = state()
          if (s.phase !== 'executing' || controller.signal.aborted) error('write-not-admitted')
          const intent = { contentHash, byteLength, createdAt: at, state: 'reserved' }
          changed(db.prepare('INSERT INTO write_intent(id,value)VALUES(1,?)').run(canonicalBriefingJson(intent)))
          s.writeIntent = intent
          s.updatedAt = at
          save(s, 'write-intent', { contentHash, byteLength })
        })
        fault('after-intent')
        leaseStart = tick()
        pendingContent = content
        mutate('write-permission-requested', (s) => {
          s.phase = 'awaiting-write-permission'
          s.updatedAt = stamp()
          s.permission = {
            requestId: randomUUID(),
            nonce: randomUUID(),
            sessionId,
            contentHash,
            byteLength,
            leaseMs: 3000,
            createdAt: s.updatedAt,
          }
        })
        leaseTimer = setTimeout(() => {
          failJob('write-lease-expired')
        }, 3000)
      } catch (e) {
        if (!controller.signal.aborted) failJob(e.message?.startsWith('briefing-') ? e.message : 'executor-failed')
      } finally {
        clearTimeout(deadline)
        if (active === operation) active = null
      }
    })()
  }
  const authorize = (p) => {
    binding(p)
    const s = state(),
      permission = s.permission
    if (
      s.phase !== 'awaiting-write-permission' ||
      !permission ||
      ['authorityHash'].some((k) => p[k] !== descriptor[k]) ||
      ['requestId', 'nonce', 'sessionId', 'contentHash'].some((k) => p[k] !== permission[k])
    )
      error('permission-mismatch')
    if (p.decision !== 'allow' && p.decision !== 'deny') error('permission-decision')
    if (p.decision === 'deny') {
      clearLease()
      mutate('permission-denied', (v) => {
        v.phase = 'stopped'
        v.permission = null
        v.error = 'permission-denied'
        v.updatedAt = stamp()
      })
      return snapshot(0)
    }
    const assertLease = () => {
      own()
      if (
        leaseStart === null ||
        pendingContent === null ||
        tick() - leaseStart >= 3000 ||
        state().phase !== 'awaiting-write-permission'
      )
        error('write-lease-expired')
    }
    try {
      assertLease()
      validateDirectories(descriptor)
      sameIdentity(descriptor.workspace, pinned)
      if (existsSync(join(descriptor.workspace, 'briefing.md'))) error('result-exists')
      const content = pendingContent
      if (hashBriefingText(content) !== permission.contentHash) error('write-content-mismatch')
      transaction(() => {
        assertLease()
        const current = state(),
          prior = canonicalBriefingJson(current.writeIntent)
        current.writeIntent.state = 'consumed'
        current.updatedAt = stamp()
        changed(
          db
            .prepare('UPDATE write_intent SET value=? WHERE id=1 AND value=?')
            .run(canonicalBriefingJson(current.writeIntent), prior)
        )
        save(current, 'write-consumed', { contentHash: permission.contentHash })
      })
      fault('before-file')
      assertLease()
      const fd = openSync(
        join(descriptor.workspace, 'briefing.md'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      )
      try {
        const buffer = Buffer.from(content)
        let offset = 0
        while (offset < buffer.length) {
          const n = writeSync(fd, buffer, offset, buffer.length - offset)
          if (n <= 0) error('write-incomplete')
          offset += n
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      fault('after-file')
      const receipt = {
        version: 1,
        resultId: randomUUID(),
        descriptorHash: hashBriefingValue(descriptor),
        actionId: descriptor.actionId,
        jobId: descriptor.jobId,
        inputHash: descriptor.inputHash,
        authorityHash: descriptor.authorityHash,
        basename: 'briefing.md',
        contentHash: permission.contentHash,
        byteLength: permission.byteLength,
        createdAt: state().writeIntent.createdAt,
        verifiedAt: stamp(),
      }
      readFixed(descriptor, pinned, receipt)
      transaction(() => {
        own()
        const current = state(),
          prior = canonicalBriefingJson(current.writeIntent)
        current.writeIntent.state = 'verified'
        current.receipt = receipt
        current.permission = null
        current.updatedAt = stamp()
        changed(
          db
            .prepare('UPDATE write_intent SET value=? WHERE id=1 AND value=?')
            .run(canonicalBriefingJson(current.writeIntent), prior)
        )
        save(current, 'result-verified', { resultId: receipt.resultId, contentHash: receipt.contentHash })
      })
      clearLease()
      fault('after-receipt')
      mutate('completed', (v) => {
        v.phase = 'completed'
        v.completion = 'briefing'
        v.updatedAt = stamp()
      })
      return snapshot(0)
    } catch (e) {
      failJob(e.message?.startsWith('briefing-') ? e.message : 'write-uncertain')
      throw e
    }
  }
  const request = async (method, input) => {
    own()
    const p = JSON.parse(canonicalBriefingJson(input))
    if (method === 'hello') {
      exact(p, [])
      return {
        protocol: BRIEFING_PROTOCOL,
        capability: 'private-briefing-v1',
        sessionId,
        targetId: slot.targetId,
        targetEpoch: slot.targetEpoch,
        directory: slot.directory,
        workspace: slot.workspace,
        jobId: slot.jobId,
      }
    }
    if (method === 'submit') {
      exact(p, ['descriptor', 'spec'])
      const d = validateBriefingDescriptor(p.descriptor, p.spec),
        spec = validateBriefingSpec(p.spec)
      if (
        Object.keys(slot).some((k) => slot[k] !== d[k]) ||
        (descriptor && canonicalBriefingJson(d) !== canonicalBriefingJson(descriptor))
      )
        error('submit-binding')
      const prior = row()
      if (prior) {
        if (prior.spec !== canonicalBriefingJson(spec)) error('submit-conflict')
        return snapshot(0)
      }
      transaction(() => {
        own()
        if (!db.prepare("SELECT value FROM metadata WHERE key='descriptor'").get())
          changed(db.prepare("INSERT INTO metadata VALUES('descriptor',?)").run(canonicalBriefingJson(d)))
        const at = stamp()
        const s = {
          phase: 'accepted',
          createdAt: at,
          updatedAt: at,
          execution: null,
          permission: null,
          writeIntent: null,
          receipt: null,
          completion: null,
          error: null,
        }
        changed(
          db
            .prepare('INSERT INTO job VALUES(1,?,?,?)')
            .run(canonicalBriefingJson(d), canonicalBriefingJson(spec), canonicalBriefingJson(s))
        )
        append('accepted', {}, at)
      })
      descriptor = d
      const accepted = snapshot(0)
      queueMicrotask(() => start(spec))
      return accepted
    }
    if (method === 'snapshot') {
      exact(p, ['actionId', 'jobId', 'inputHash', 'afterSeq'])
      binding(p)
      return snapshot(p.afterSeq)
    }
    if (method === 'authorize-write') {
      exact(p, [
        'actionId',
        'jobId',
        'inputHash',
        'authorityHash',
        'sessionId',
        'requestId',
        'nonce',
        'contentHash',
        'decision',
      ])
      return authorize(p)
    }
    if (method === 'read-result') {
      exact(p, ['actionId', 'jobId', 'inputHash', 'resultId'])
      binding(p)
      const s = state()
      if (!s.receipt || p.resultId !== s.receipt.resultId) error('result-missing')
      return readFixed(descriptor, pinned, s.receipt)
    }
    if (method === 'stop') {
      exact(p, ['actionId', 'jobId', 'inputHash'])
      binding(p)
      const s = state()
      if (['completed', 'stopped'].includes(s.phase)) return snapshot(0)
      clearLease()
      mutate('stop-requested', (v) => {
        v.permission = null
        v.updatedAt = stamp()
        v.error = 'stop-requested'
      })
      const operation = active
      operation?.controller.abort(new Error('briefing-stopped'))
      if (operation) {
        let stopTimer
        try {
          await Promise.race([
            operation.promise,
            new Promise((resolve) => {
              stopTimer = setTimeout(resolve, 3500)
            }),
          ])
        } finally {
          clearTimeout(stopTimer)
        }
      }
      const after = state()
      if (
        after.writeIntent?.state === 'consumed' ||
        (after.execution && !after.execution.exit) ||
        (s.phase === 'unknown' && !after.execution)
      ) {
        failJob('stop-unconfirmed')
        return snapshot(0)
      }
      mutate('stopped', (v) => {
        v.phase = 'stopped'
        v.completion = null
        v.error = 'stopped'
        v.updatedAt = stamp()
      })
      return snapshot(0)
    }
    error('method-forbidden')
  }
  return {
    request,
    socketPath,
    async listen() {
      own()
      if (server) error('already-listening')
      if (existsSync(socketPath)) error('socket-exists')
      server = createServer((socket) => {
        if (sockets.size >= 4) {
          socket.destroy()
          return
        }
        sockets.add(socket)
        let buffer = '',
          busy = false
        socket.setEncoding('utf8')
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        socket.on('data', (chunk) => {
          buffer += chunk
          if (Buffer.byteLength(buffer) > BRIEFING_LIMITS.rpcBytes) {
            socket.destroy()
            return
          }
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n')
            const line = buffer.slice(0, end)
            buffer = buffer.slice(end + 1)
            if (busy) {
              socket.destroy()
              return
            }
            busy = true
            void (async () => {
              let id = null
              try {
                const frame = JSON.parse(line)
                exact(frame, ['id', 'method', 'payload'])
                if (!Number.isSafeInteger(frame.id) || frame.id < 0) error('rpc-id')
                id = frame.id
                const result = await request(frame.method, frame.payload)
                socket.write(canonicalBriefingJson({ id, result }) + '\n')
              } catch (e) {
                socket.write(
                  JSON.stringify({
                    id,
                    error: { message: e.message?.startsWith('briefing-') ? e.message : 'briefing-operation-failed' },
                  }) + '\n'
                )
              } finally {
                busy = false
              }
            })()
          }
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      chmodSync(socketPath, 0o600)
      return socketPath
    },
    async close() {
      if (closed) return
      if (active) error('active-executor')
      clearLease()
      for (const socket of sockets) socket.destroy()
      if (server) await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
      server = null
      closed = true
      db.close()
      if (existsSync(socketPath)) rmSync(socketPath)
    },
  }
}
