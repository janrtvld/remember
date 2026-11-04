import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createCoordinator } from './coordinator.mjs'
import { openJobRouterV2 } from './job-router-v2.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let rpcId = 0
async function rpc(path, op, payload = {}) {
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  try {
    await once(socket, 'connect')
    return await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('test-rpc-timeout'))
      }, 3000)
      socket.once('close', () => {
        clearTimeout(timer)
        reject(new Error('test-rpc-closed'))
      })
      socket.on('data', (data) => {
        buffer += data
        if (!buffer.includes('\n')) return
        clearTimeout(timer)
        const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        if (message.error) reject(new Error(message.error))
        else resolve(message.result)
      })
      socket.write(`${JSON.stringify({ ...payload, op, id: ++rpcId })}\n`)
    })
  } finally {
    socket.destroy()
  }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}
function fakeDriver(id) {
  let options
  let calls = 0
  const done = deferred()
  const checkpoint = {
    computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47831/', workspace: '/fake' },
    threadId: `thread-${id}`,
    turnId: `turn-${id}`,
    previousTurnId: null,
    commandItemIds: [`command-${id}`],
  }
  return {
    get calls() {
      return calls
    },
    driver: {
      runCodexWorker(input) {
        calls++
        options = input
        input.onThread(checkpoint.threadId)
        input.onCheckpoint({ ...checkpoint, turnId: null, commandItemIds: [] })
        input.onCheckpoint(checkpoint)
        input.signal.addEventListener(
          'abort',
          () => {
            input.onCheckpoint(null)
            done.reject(new Error('agent-cancelled'))
          },
          { once: true }
        )
        return done.promise
      },
      async stopCodexRemoteCheckpoint() {},
    },
    complete(text = `result-${id}`) {
      options.onCheckpoint(null)
      done.resolve({ response: text, threadId: checkpoint.threadId })
    },
    tool() {
      const result = options.tools[0].call(
        { action: 'read', slug: `page-${id}` },
        { ...checkpoint, callId: `call-${id}`, signal: options.signal }
      )
      result.catch(() => {})
      return result
    },
  }
}
function assignment(id) {
  return { jobId: `job-${id}`, messageId: `message-${id}`, workItemId: `task-${id}`, sessionId: `session-${id}` }
}
const input = () => ({
  prompt: 'Explicit synthetic task',
  model: 'fake-model',
  systemPrompt: 'No external access.',
  effort: 'low',
  threadId: null,
  reviewTtlMs: 300000,
  tools: [{ name: 'remember_memory', description: 'Synthetic read only.', inputSchema: { type: 'object' } }],
})
async function fixture(t) {
  const directory = mkdtempSync('/private/tmp/r7-')
  const children = new Map()
  const calls = []
  let connections = 0
  let connectGate = null
  let transform = (_op, value) => value
  let unavailable = false
  let connectFailure = false
  let lostAck = false
  const connectChild = async (descriptor) => {
    connections++
    if (connectGate) await connectGate.promise
    if (connectFailure) throw new Error('synthetic-before-dispatch-crash')
    if (unavailable) throw new Error('synthetic-unavailable')
    const id = descriptor.assignment.jobId
    if (!children.has(id)) {
      mkdirSync(descriptor.directory, { recursive: true })
      const fake = fakeDriver(id)
      const coordinator = await createCoordinator({
        directory: descriptor.directory,
        driver: fake.driver,
        nativeClient: true,
      })
      children.set(id, { fake, coordinator })
    }
    const child = children.get(id)
    return {
      async request(op, payload) {
        calls.push({ jobId: id, op, payload })
        const value = await rpc(child.coordinator.socketPath, op, payload)
        if (op === lostAck) {
          lostAck = false
          throw new Error(`synthetic-lost-${op}-ack`)
        }
        return transform(op, value, descriptor)
      },
      close() {},
    }
  }
  const replacedRouters = []
  let router = openJobRouterV2({ directory, targetId: 'mini-test', targetEpoch: 'epoch-1', connectChild })
  t.after(async () => {
    router.close()
    for (const previous of replacedRouters) previous.close()
    for (const child of children.values()) {
      await rpc(child.coordinator.socketPath, 'stop').catch(() => {})
      await child.coordinator.close()
    }
    rmSync(directory, { recursive: true, force: true })
  })
  const request = (op, data = {}) => router.request(JSON.stringify({ op, ...data }))
  return {
    directory,
    get connections() {
      return connections
    },
    holdConnect(gate) {
      connectGate = gate
    },
    replaceOwner() {
      replacedRouters.push(router)
      router = openJobRouterV2({ directory, targetId: 'mini-test', targetEpoch: 'epoch-1', connectChild })
    },
    connectChild,
    children,
    calls,
    request,
    prepare: (id, extra = {}) => request('prepare', { assignment: assignment(id), input: input(), ...extra }),
    async register(id, extra = {}) {
      const payload = { assignment: assignment(id), input: input(), ...extra }
      const prepared = await request('prepare', payload)
      return request('register', { ...payload, prepared })
    },
    job: (op, id, extra = {}) => request(op, { assignment: assignment(id), ...extra }),
    reopen() {
      router.close()
      router = openJobRouterV2({ directory, targetId: 'mini-test', targetEpoch: 'epoch-1', connectChild })
    },
    raw: (text) => router.request(text),
    read(sql) {
      const db = new DatabaseSync(join(directory, 'registry-v2.sqlite'), { readOnly: true })
      try {
        return JSON.parse(JSON.stringify(db.prepare(sql).all()))
      } finally {
        db.close()
      }
    },
    setTransform(value) {
      transform = value
    },
    setUnavailable(value) {
      unavailable = value
    },
    failConnect(value) {
      connectFailure = value
    },
    loseAck(op = 'submit') {
      lostAck = op
    },
  }
}
async function until(check) {
  for (let i = 0; i < 150; i++) {
    const value = await check()
    if (value) return value
    await pause(10)
  }
  throw new Error('test-state-timeout')
}
async function finish(f, id) {
  f.children.get(`job-${id}`).fake.complete()
  return until(async () => {
    const value = await f.job('snapshot', id)
    return value.state === 'completed' && value
  })
}

test('existing single-job architecture baseline: terminal A does not permit B on the same endpoint', async (t) => {
  const directory = mkdtempSync('/private/tmp/r7-old-')
  const fake = fakeDriver('old')
  const coordinator = await createCoordinator({ directory, driver: fake.driver, nativeClient: true })
  t.after(async () => {
    await coordinator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const spec = { ...input(), workspace: join(directory, 'workspace') }
  await rpc(coordinator.socketPath, 'submit', { jobId: 'job-A', spec })
  fake.complete()
  await until(async () => (await rpc(coordinator.socketPath, 'snapshot')).job.phase === 'completed')
  await assert.rejects(rpc(coordinator.socketPath, 'submit', { jobId: 'job-B', spec }), /journal-single-job-only/)
  assert.equal(fake.calls, 1)
  assert.equal((await rpc(coordinator.socketPath, 'snapshot')).job.id, 'job-A')
})

test('R1 completed A then explicit B retains exact descriptors, independent workspaces, cursors and results', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  assert.deepEqual(await f.register('A'), a)
  await f.job('submit', 'A')
  const resultA = await finish(f, 'A')
  const b = await f.register('B')
  assert.notEqual(a.directory, b.directory)
  assert.equal(a.workspace, join(a.directory, 'workspace'))
  assert.equal(b.workspace, join(b.directory, 'workspace'))
  await f.job('submit', 'B')
  const historic = await f.job('snapshot', 'A', { afterSeq: resultA.snapshot.events.at(-1).seq })
  assert.equal(historic.snapshot.result.response, 'result-job-A')
  assert.equal(historic.snapshot.job.id, 'job-A')
  assert.equal((await f.job('snapshot', 'B')).snapshot.job.id, 'job-B')
  assert.equal((await f.job('snapshot', 'B')).snapshot.result, null)
  assert.equal(f.children.get('job-A').fake.calls, 1)
  assert.equal(f.children.get('job-B').fake.calls, 1)
})

test('R2 stopped A permits B without reviving A; Stop A cannot stop active B', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await f.job('submit', 'A')
  assert.equal((await f.job('stop', 'A')).state, 'stopped')
  await f.register('B')
  await f.job('submit', 'B')
  assert.equal((await f.job('stop', 'A')).state, 'stopped')
  assert.equal((await f.job('snapshot', 'B')).state, 'running')
  assert.equal(f.calls.filter((call) => call.jobId === 'job-B' && call.op === 'stop').length, 0)
  assert.equal((await f.job('stop', 'B')).state, 'stopped')
})

test('R3 reserved, running and unreachable previous jobs never release the sequential slot', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await assert.rejects(f.register('B'), /router-active-job/)
  await f.job('submit', 'A')
  await assert.rejects(f.register('B'), /router-active-job/)
  f.setUnavailable(true)
  await assert.rejects(f.register('B'), /synthetic-unavailable/)
  f.setUnavailable(false)
  assert.equal(f.children.size, 1)
})

test('R4 lost successful submit ACK never resubmits; input and message/session assignment conflicts reject', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  f.loseAck()
  await assert.rejects(f.job('submit', 'A'), /synthetic-lost-submit-ack/)
  f.reopen()
  assert.deepEqual(await f.register('A'), a)
  assert.equal((await f.job('submit', 'A')).state, 'running')
  assert.equal(f.calls.filter((call) => call.op === 'submit').length, 1)
  assert.equal(f.children.get('job-A').fake.calls, 1)
  await assert.rejects(f.register('A', { input: { ...input(), prompt: 'Different task' } }), /router-input-conflict/)
  await assert.rejects(
    f.register('A', { assignment: { ...assignment('A'), messageId: 'other-message' } }),
    /router-assignment-conflict/
  )
  await finish(f, 'A')
  await assert.rejects(
    f.register('B', { assignment: { ...assignment('B'), messageId: assignment('A').messageId } }),
    /router-assignment-conflict/
  )
  await assert.rejects(
    f.register('B', { assignment: { ...assignment('B'), sessionId: assignment('A').sessionId } }),
    /router-assignment-conflict/
  )
})

test('R5 persisted intent before child connection failure stays uncertain after reopen, with no first or repeated dispatch', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  f.failConnect(true)
  await assert.rejects(f.job('submit', 'A'), /synthetic-before-dispatch-crash/)
  f.reopen()
  f.failConnect(false)
  assert.equal((await f.job('submit', 'A')).state, 'recovery-required')
  assert.equal((await f.job('snapshot', 'A')).snapshot.job, null)
  await assert.rejects(f.register('B'), /router-active-job/)
  await assert.rejects(f.job('stop', 'A'), /router-start-unconfirmed/)
  assert.equal(f.calls.filter((call) => call.op === 'submit').length, 0)
  assert.equal(f.children.get('job-A').fake.calls, 0)
})

test('R6 wrong assignment, missing job and cross-job/current-session reviews never reach child B', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await f.job('submit', 'A')
  const pendingA = f.children.get('job-A').fake.tool()
  const a = await until(async () => {
    const v = await f.job('snapshot', 'A')
    return v.snapshot.requests.length && v
  })
  await f.job('stop', 'A')
  await assert.rejects(pendingA)
  await f.register('B')
  await f.job('submit', 'B')
  const pendingB = f.children.get('job-B').fake.tool()
  const b = await until(async () => {
    const v = await f.job('snapshot', 'B')
    return v.snapshot.requests.length && v
  })
  const baseReplies = f.calls.filter((call) => call.op === 'reply').length
  await assert.rejects(f.request('stop'), /router-invalid-request/)
  await assert.rejects(f.job('stop', 'unknown'), /router-job-missing/)
  await assert.rejects(
    f.request('stop', { assignment: { ...assignment('A'), jobId: 'job-B' } }),
    /router-assignment-conflict/
  )
  await assert.rejects(
    f.job('reply', 'B', {
      requestId: a.snapshot.requests[0].id,
      sessionId: a.snapshot.sessionId,
      result: { success: true, output: {} },
    }),
    /router-review-invalid/
  )
  await assert.rejects(
    f.job('reply', 'B', {
      requestId: b.snapshot.requests[0].id,
      sessionId: 'old-session',
      result: { success: true, output: {} },
    }),
    /router-review-invalid/
  )
  assert.equal(f.calls.filter((call) => call.op === 'reply').length, baseReplies)
  await f.job('reply', 'B', {
    requestId: b.snapshot.requests[0].id,
    sessionId: b.snapshot.sessionId,
    result: { success: true, output: { exact: 'B' } },
  })
  assert.deepEqual(await pendingB, { exact: 'B' })
  assert.equal((await f.job('snapshot', 'B')).state, 'running')
})

test('R7 cursors and pending identities remain explicit; malformed cursor never reaches child', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await f.job('submit', 'A')
  const first = await f.job('snapshot', 'A')
  const end = first.snapshot.events.at(-1).seq
  const later = await f.job('snapshot', 'A', { afterSeq: end })
  assert.ok(later.snapshot.events.every((event) => event.seq > end))
  for (const afterSeq of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.job('snapshot', 'A', { afterSeq }), /router-invalid-request/)
  // Cursors are per caller, not global: another reader may start at zero.
  assert.ok((await f.job('snapshot', 'A', { afterSeq: 0 })).snapshot.events.length > 0)
})

test('R8 child job/hash/workspace/session mismatches block terminal admission, replies and Stop', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await f.job('submit', 'A')
  await finish(f, 'A')
  const mutations = [
    (op, value) => (op === 'hello' ? { ...value, workspace: '/wrong' } : value),
    (op, value) => (op === 'hello' ? { ...value, jobId: 'different' } : value),
    (op, value) => (op === 'hello' ? { ...value, jobId: null } : value),
    (op, value) => (op === 'hello' ? { ...value, singleJob: 'true' } : value),
    (op, value) => (op === 'snapshot' ? { ...value, job: { ...value.job, id: 'different' } } : value),
    (op, value) =>
      op === 'snapshot'
        ? { ...value, job: { ...value.job, inputHash: createHash('sha256').update('wrong').digest('hex') } }
        : value,
    (op, value) => (op === 'snapshot' ? { ...value, sessionId: 'changed-after-hello' } : value),
  ]
  for (const mutate of mutations) {
    f.setTransform(mutate)
    const count = f.calls.filter((call) => call.op === 'stop').length
    await assert.rejects(f.job('stop', 'A'), /router-child-/)
    await assert.rejects(f.register('B'), /router-child-/)
    assert.equal(f.calls.filter((call) => call.op === 'stop').length, count)
  }
  f.setTransform((_op, value) => value)
  assert.equal((await f.register('B')).assignment.jobId, 'job-B')
})

test('R9 reopen preserves all descriptors and terminal results; reservations and reads do not dispatch', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  await f.job('submit', 'A')
  await finish(f, 'A')
  const b = await f.register('B')
  f.reopen()
  assert.deepEqual(await f.register('A'), a)
  assert.deepEqual(await f.register('B'), b)
  assert.equal((await f.job('snapshot', 'B')).state, 'reserved')
  assert.equal((await f.job('snapshot', 'A')).snapshot.result.response, 'result-job-A')
  assert.equal(f.calls.filter((call) => call.op === 'submit').length, 1)
  assert.equal(f.children.get('job-B')?.fake.calls ?? 0, 0)
})

test('R10 serialized boundary rejects malformed/unknown/oversized/path-like input before child side effects', async (t) => {
  const f = await fixture(t)
  for (const raw of [
    'null',
    '[]',
    '{',
    JSON.stringify({ op: 'unknown' }),
    JSON.stringify({ op: 'register', assignment: assignment('A'), input: input(), extra: true }),
    ' '.repeat(70001),
  ])
    await assert.rejects(f.raw(raw), /router-invalid-request|router-request-too-large/)
  for (const key of Object.keys(assignment('A'))) {
    await assert.rejects(
      f.register('A', { assignment: { ...assignment('A'), [key]: '../escape' } }),
      /router-invalid-request/
    )
  }
  await assert.rejects(f.register('A', { input: { ...input(), workspace: '/escape' } }), /router-invalid-request/)
  await assert.rejects(f.register('A', { input: { ...input(), prompt: 'a'.repeat(30001) } }), /router-invalid-request/)
  await assert.rejects(
    f.register('A', { input: { ...input(), prompt: '漢'.repeat(30000) } }),
    /router-request-too-large/
  )
  await assert.rejects(
    f.register('A', { input: { ...input(), tools: [{ name: 'shell', description: '', inputSchema: {} }] } }),
    /router-invalid-request/
  )
  assert.equal(f.calls.length, 0)
  assert.equal((await f.register('A')).assignment.jobId, 'job-A')
})

test('validated registration filesystem failure retains its reservation and explicit same-input register repairs only its directory', async (t) => {
  const f = await fixture(t)
  writeFileSync(join(f.directory, 'jobs'), 'synthetic obstruction')
  await assert.rejects(f.register('A'), /ENOTDIR/)
  assert.equal(f.calls.length, 0)
  rmSync(join(f.directory, 'jobs'))
  const restored = await f.register('A')
  assert.equal(existsSync(restored.directory), true)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.job('submit', 'A')).state, 'running')
})

test('lost successful Stop ACK stays uncertain to caller, then exact terminal read permits B without reexecuting A', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await f.job('submit', 'A')
  f.loseAck('stop')
  await assert.rejects(f.job('stop', 'A'), /synthetic-lost-stop-ack/)
  f.reopen()
  assert.equal((await f.job('snapshot', 'A')).state, 'stopped')
  await f.register('B')
  await f.job('submit', 'B')
  assert.equal(f.calls.filter((call) => call.jobId === 'job-A' && call.op === 'submit').length, 1)
  assert.equal((await f.job('snapshot', 'B')).state, 'running')
})

test('actual coordinator deadline evidence remains scoped to expired A after B starts, including past-cursor reads', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t)
  await f.register('A', { input: { ...input(), reviewTtlMs: 5000 } })
  await f.job('submit', 'A')
  const pending = f.children.get('job-A').fake.tool()
  const before = await f.job('snapshot', 'A')
  const review = before.snapshot.requests[0]
  now = review.payload.expiresAt
  t.mock.timers.tick(5000)
  await assert.rejects(pending, /review-expired|worker-ended/)
  const expired = await f.job('snapshot', 'A')
  assert.equal(expired.state, 'stopped')
  assert.equal(expired.snapshot.job.stopReason, 'request-expired')
  const cursor = expired.snapshot.events.at(-1).seq
  await f.register('B')
  await f.job('submit', 'B')
  f.reopen()
  const history = await f.job('snapshot', 'A', { afterSeq: cursor })
  assert.equal(history.snapshot.job.stopReason, 'request-expired')
  assert.equal(
    history.snapshot.events.some((event) => event.type === 'review-expiry'),
    false
  )
  assert.equal((await f.job('snapshot', 'B')).snapshot.job.stopReason, undefined)
  await assert.rejects(
    f.job('reply', 'A', {
      requestId: review.id,
      sessionId: before.snapshot.sessionId,
      result: { success: true, output: {} },
    }),
    /router-review-invalid/
  )
  assert.equal(f.calls.filter((call) => call.op === 'reply').length, 0)
})

test('concurrent serialized registration and submit preserve one reservation and one dispatch', async (t) => {
  const f = await fixture(t)
  const registered = await Promise.allSettled([f.register('A'), f.register('B')])
  assert.equal(registered[0].status, 'fulfilled')
  assert.equal(registered[1].status, 'rejected')
  assert.match(registered[1].reason.message, /router-active-job/)
  const results = await Promise.all([f.job('submit', 'A'), f.job('submit', 'A')])
  assert.ok(results.every((value) => value.snapshot.job.id === 'job-A'))
  assert.equal(f.calls.filter((call) => call.op === 'submit').length, 1)
})

test('V2 prepare repeats byte-identically without rows, directories, metadata mutation or child connections', async (t) => {
  const f = await fixture(t)
  const files = readdirSync(f.directory).sort()
  const metadata = f.read('SELECT * FROM router_meta')
  const a = await f.prepare('A')
  assert.deepEqual(await f.prepare('A'), a)
  assert.equal(a.version, 2)
  assert.equal(a.targetId, 'mini-test')
  assert.equal(a.targetEpoch, 'epoch-1')
  assert.equal(a.root, f.directory)
  assert.deepEqual(a.assignment, assignment('A'))
  assert.equal(a.workspace, join(a.directory, 'workspace'))
  assert.equal(f.connections, 0)
  assert.deepEqual(f.read('SELECT * FROM router_job'), [])
  assert.deepEqual(f.read('SELECT * FROM router_meta'), metadata)
  assert.deepEqual(readdirSync(f.directory).sort(), files)
  assert.equal(existsSync(a.directory), false)
  assert.deepEqual(await f.request('register', { assignment: assignment('A'), input: input(), prepared: a }), a)
  const row = f.read('SELECT * FROM router_job')[0]
  assert.equal(a.inputHash, createHash('sha256').update(row.spec_json).digest('hex'))
  assert.equal(JSON.parse(row.spec_json).workspace, a.workspace)
  assert.equal(JSON.parse(row.spec_json).reviewTtlMs, input().reviewTtlMs)
})

test('V2 prepare remains read-only while A runs and B cannot yet register', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  await f.job('submit', 'A')
  const connections = f.connections
  const rows = f.read('SELECT * FROM router_job')
  const b = await f.prepare('B')
  assert.equal(f.connections, connections)
  assert.deepEqual(f.read('SELECT * FROM router_job'), rows)
  assert.equal(existsSync(b.directory), false)
  await assert.rejects(
    f.request('register', { assignment: assignment('B'), input: input(), prepared: b }),
    /router-active-job/
  )
})

test('V2 mismatched reopen cannot alter target metadata or fence the existing owner', async (t) => {
  const f = await fixture(t)
  const a = await f.prepare('A')
  const before = f.read('SELECT * FROM router_meta')
  for (const change of [{ targetId: 'different-target' }, { targetEpoch: 'epoch-2' }]) {
    assert.throws(
      () =>
        openJobRouterV2({
          directory: f.directory,
          targetId: 'mini-test',
          targetEpoch: 'epoch-1',
          connectChild: f.connectChild,
          ...change,
        }),
      /router-target-mismatch/
    )
    assert.deepEqual(f.read('SELECT * FROM router_meta'), before)
    assert.deepEqual(await f.prepare('A'), a)
  }
  f.reopen()
  assert.deepEqual(await f.prepare('A'), a)
})

test('V2 exact prepared descriptor rejects target/root/hash/input/assignment/extrakey changes before writes', async (t) => {
  const f = await fixture(t)
  const a = await f.prepare('A')
  const payload = { assignment: assignment('A'), input: input(), prepared: a }
  for (const change of [
    { version: 1 },
    { targetId: 'other' },
    { targetEpoch: 'old' },
    { root: '/wrong-root' },
    { directory: '/wrong-child' },
    { workspace: '/wrong-workspace' },
    { inputHash: '0'.repeat(64) },
    { assignment: assignment('B') },
    { extra: true },
  ])
    await assert.rejects(
      f.request('register', { ...payload, prepared: { ...a, ...change } }),
      /router-prepared-mismatch|router-invalid-request/
    )
  await assert.rejects(
    f.request('register', { ...payload, input: { ...input(), prompt: 'changed after preparation' } }),
    /router-prepared-mismatch/
  )
  await assert.rejects(f.request('register', { ...payload, assignment: assignment('B') }), /router-prepared-mismatch/)
  await assert.rejects(f.request('register', { assignment: assignment('A'), input: input() }), /router-invalid-request/)
  assert.deepEqual(f.read('SELECT * FROM router_job'), [])
  assert.equal(existsSync(a.directory), false)
  assert.equal(f.connections, 0)
})

test('V2 cancellation tombstone is stable across restart and every historical A operation leaves B untouched', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const cancel = () => f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash })
  const cancelled = await cancel()
  assert.equal(cancelled.state, 'cancelled-unsubmitted')
  assert.deepEqual(cancelled.cancellation, {
    kind: 'unsubmitted',
    at: f.read('SELECT cancelled_at FROM router_job')[0].cancelled_at,
  })
  assert.equal(cancelled.snapshot, null)
  assert.equal(f.connections, 0)
  const before = f.read('SELECT * FROM router_job')
  f.reopen()
  assert.deepEqual(await cancel(), cancelled)
  assert.deepEqual(await f.job('snapshot', 'A'), cancelled)
  assert.deepEqual(await f.register('A'), a)
  assert.deepEqual(f.read('SELECT * FROM router_job'), before)
  await f.register('B')
  await f.job('submit', 'B')
  const connections = f.connections
  const current = f.read("SELECT * FROM router_job WHERE job_id='job-B'")
  for (const op of ['submit', 'stop', 'reply'])
    await assert.rejects(
      f.job(op, 'A', op === 'reply' ? { requestId: 'stale-request', sessionId: 'stale-session', result: {} } : {}),
      /router-reservation-cancelled/
    )
  assert.deepEqual(await cancel(), cancelled)
  assert.deepEqual(await f.job('snapshot', 'A'), cancelled)
  assert.deepEqual(await f.register('A'), a)
  assert.equal(f.connections, connections)
  assert.deepEqual(f.read("SELECT * FROM router_job WHERE job_id='job-B'"), current)
  assert.equal(f.children.has('job-A'), false)
  assert.equal(f.children.get('job-B').fake.calls, 1)
})

test('V2 cancellation winning the serialized race permanently prevents first submit', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const results = await Promise.allSettled([
    f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash }),
    f.job('submit', 'A'),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /router-reservation-cancelled/)
  assert.equal(f.connections, 0)
  assert.equal(f.children.size, 0)
  assert.equal(f.read('SELECT dispatch_state FROM router_job')[0].dispatch_state, 'cancelled-unsubmitted')
  await f.register('B')
})

test('V2 submit winning the serialized race refuses cancellation and retains exactly one dispatch', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const results = await Promise.allSettled([
    f.job('submit', 'A'),
    f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash }),
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /router-cancel-not-unsubmitted/)
  assert.equal(f.read('SELECT dispatch_state FROM router_job')[0].dispatch_state, 'dispatch-intent')
  assert.equal(f.children.get('job-A').fake.calls, 1)
  assert.equal((await f.job('snapshot', 'A')).state, 'running')
})

test('V2 unknown dispatch boundary cannot be cancelled despite no provider having started', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  f.failConnect(true)
  await assert.rejects(f.job('submit', 'A'), /synthetic-before-dispatch-crash/)
  const count = f.connections
  await assert.rejects(f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash }), /router-cancel-not-unsubmitted/)
  assert.equal(f.connections, count)
  assert.equal(f.children.size, 0)
  f.reopen()
  f.failConnect(false)
  await assert.rejects(f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash }), /router-cancel-not-unsubmitted/)
  assert.equal((await f.job('snapshot', 'A')).state, 'recovery-required')
  await assert.rejects(f.register('B'), /router-active-job/)
})

test('V2 cancellation malformed/hash/assignment mismatches leave the original reservation unchanged', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const before = f.read('SELECT * FROM router_job')
  for (const extra of [
    {},
    { inputHash: 'wrong' },
    { inputHash: '0'.repeat(64) },
    { inputHash: a.inputHash, extra: true },
  ])
    await assert.rejects(f.job('cancel-unsubmitted', 'A', extra), /router-invalid-request|router-input-conflict/)
  await assert.rejects(
    f.request('cancel-unsubmitted', {
      assignment: { ...assignment('A'), messageId: 'other-message' },
      inputHash: a.inputHash,
    }),
    /router-assignment-conflict/
  )
  assert.deepEqual(f.read('SELECT * FROM router_job'), before)
  assert.equal(f.connections, 0)
})

test('V2 owner replacement during held child connection fences old submit without forwarding it', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  const gate = deferred()
  f.holdConnect(gate)
  const pending = f.job('submit', 'A')
  await until(async () => f.connections === 1)
  f.replaceOwner()
  f.holdConnect(null)
  gate.resolve()
  await assert.rejects(pending, /router-session-expired/)
  assert.equal(f.calls.filter((call) => call.op === 'submit').length, 0)
  assert.equal((await f.job('snapshot', 'A')).state, 'recovery-required')
  assert.equal(f.children.get('job-A').fake.calls, 0)
})

test('V2 copied registry cannot silently retarget its canonical root or replace stored owner', async (t) => {
  const f = await fixture(t)
  await f.register('A')
  const metadata = f.read('SELECT * FROM router_meta')
  const other = mkdtempSync('/private/tmp/r7-copy-')
  t.after(() => rmSync(other, { recursive: true, force: true }))
  const source = new DatabaseSync(join(f.directory, 'registry-v2.sqlite'), { readOnly: true })
  try {
    await backup(source, join(other, 'registry-v2.sqlite'))
  } finally {
    source.close()
  }
  assert.throws(
    () =>
      openJobRouterV2({
        directory: other,
        targetId: 'mini-test',
        targetEpoch: 'epoch-1',
        connectChild: f.connectChild,
      }),
    /router-target-mismatch/
  )
  const copied = new DatabaseSync(join(other, 'registry-v2.sqlite'), { readOnly: true })
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(copied.prepare('SELECT * FROM router_meta').all())), metadata)
  } finally {
    copied.close()
  }
  assert.equal((await f.job('snapshot', 'A')).state, 'reserved')
  assert.equal(f.connections, 0)
})

test('V2 historical duplicate registration still validates prepared descriptor before returning', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  await f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash })
  const rows = f.read('SELECT * FROM router_job')
  await assert.rejects(
    f.request('register', {
      assignment: assignment('A'),
      input: input(),
      prepared: { ...a, targetEpoch: 'old-epoch' },
    }),
    /router-prepared-mismatch/
  )
  assert.deepEqual(f.read('SELECT * FROM router_job'), rows)
  assert.equal(f.connections, 0)
})

test('V2 held connection exposes durable dispatch intent before cancellation is queued and refused', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const gate = deferred()
  f.holdConnect(gate)
  const pending = f.job('submit', 'A')
  await until(async () => f.connections === 1)
  assert.equal(f.read('SELECT dispatch_state FROM router_job')[0].dispatch_state, 'dispatch-intent')
  assert.equal(f.children.size, 0)
  const cancellation = f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash })
  cancellation.catch(() => {})
  gate.resolve()
  assert.equal((await pending).state, 'running')
  await assert.rejects(cancellation, /router-cancel-not-unsubmitted/)
  assert.equal(f.children.get('job-A').fake.calls, 1)
})

test('V2 cancelled tombstones keep counting toward the existing 32-job bound', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 32; index++) {
    const id = `bounded-${index}`
    const prepared = await f.register(id)
    await f.job('cancel-unsubmitted', id, { inputHash: prepared.inputHash })
  }
  assert.equal(f.read('SELECT * FROM router_job').length, 32)
  assert(f.read('SELECT dispatch_state FROM router_job').every((row) => row.dispatch_state === 'cancelled-unsubmitted'))
  const next = await f.prepare('limit')
  await assert.rejects(
    f.request('register', { assignment: assignment('limit'), input: input(), prepared: next }),
    /router-job-limit/
  )
  assert.equal(existsSync(next.directory), false)
  assert.equal(f.connections, 0)
})

test('V2 cancellation requires one changed CAS row and leaves reservation intact when a write is ignored', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const db = new DatabaseSync(join(f.directory, 'registry-v2.sqlite'))
  try {
    db.exec('CREATE TRIGGER ignore_cancel BEFORE UPDATE OF cancelled_at ON router_job BEGIN SELECT RAISE(IGNORE); END')
  } finally {
    db.close()
  }
  await assert.rejects(f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash }), /router-cancel-not-unsubmitted/)
  const row = f.read('SELECT dispatch_state,cancelled_at FROM router_job')[0]
  assert.equal(row.dispatch_state, 'reserved')
  assert.equal(row.cancelled_at, null)
  assert.equal(f.connections, 0)
})

test('V2 submission requires one changed CAS row before any child connection', async (t) => {
  const f = await fixture(t)
  const a = await f.register('A')
  const db = new DatabaseSync(join(f.directory, 'registry-v2.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER ignore_submit BEFORE UPDATE OF dispatch_state ON router_job WHEN NEW.dispatch_state='dispatch-intent' BEGIN SELECT RAISE(IGNORE); END"
    )
  } finally {
    db.close()
  }
  await assert.rejects(f.job('submit', 'A'), /router-submit-intent-not-persisted/)
  assert.equal(f.read('SELECT dispatch_state FROM router_job')[0].dispatch_state, 'reserved')
  assert.equal(f.connections, 0)
  assert.equal(f.children.size, 0)
  assert.equal(f.calls.length, 0)
  const cancelled = await f.job('cancel-unsubmitted', 'A', { inputHash: a.inputHash })
  assert.equal(cancelled.state, 'cancelled-unsubmitted')
  assert.equal(f.connections, 0)
})
