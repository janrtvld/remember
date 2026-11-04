import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { createCoordinator } from './coordinator.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let requestId = 0

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function waitUntil(check, description, timeout = 3000) {
  const deadline = Date.now() + timeout
  do {
    const value = await check()
    if (value) return value
    await pause(10)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function rpc(socketPath, request) {
  const socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  let buffer = ''
  try {
    await once(socket, 'connect')
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test-rpc-timeout')), 3000)
      const finish = (callback, value) => {
        clearTimeout(timer)
        callback(value)
      }
      socket.once('error', (error) => finish(reject, error))
      socket.once('close', () => finish(reject, new Error('test-socket-closed')))
      socket.on('data', (data) => {
        buffer += data
        if (!buffer.includes('\n')) return
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        finish(response.error ? reject : resolve, response.error ? new Error(response.error) : response.result)
      })
      socket.write(`${JSON.stringify({ id: ++requestId, ...request })}\n`)
    })
  } finally {
    socket.destroy()
  }
}

function fakeDriver({ stopFails = false } = {}) {
  const invoked = deferred()
  const terminal = deferred()
  let options
  let calls = 0
  let aborted = false
  const stops = []
  const checkpoint = {
    computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47831/', workspace: '/unused-by-fake' },
    threadId: 'thread-e06',
    turnId: 'turn-e06',
    previousTurnId: null,
    commandItemIds: ['command-e06'],
  }
  const driver = {
    runCodexWorker(input) {
      options = input
      calls++
      options.onThread(checkpoint.threadId)
      options.onCheckpoint({ ...checkpoint, turnId: null, commandItemIds: [] })
      options.onCheckpoint(checkpoint)
      options.signal.addEventListener(
        'abort',
        () => {
          aborted = true
          if (!stopFails) options.onCheckpoint(null)
          terminal.reject(new Error('agent-cancelled'))
        },
        { once: true }
      )
      invoked.resolve()
      return terminal.promise
    },
    async stopCodexRemoteCheckpoint(value) {
      stops.push(value)
      if (stopFails) throw new Error('synthetic-stop-unconfirmed')
    },
  }
  return {
    driver,
    invoked: invoked.promise,
    stops,
    get calls() {
      return calls
    },
    get signal() {
      return options.signal
    },
    get aborted() {
      return aborted
    },
    complete(response = 'Synthetic result verified') {
      options.onCheckpoint(null)
      terminal.resolve({ response, threadId: checkpoint.threadId })
    },
    fail() {
      terminal.reject(new Error('synthetic-transport-loss'))
    },
    tool(signal = options.signal) {
      return options.tools[0].call(
        { nonce: 'synthetic-source' },
        {
          threadId: checkpoint.threadId,
          turnId: checkpoint.turnId,
          callId: 'call-e06',
          signal,
        }
      )
    },
    approval() {
      return options.ask({ title: 'Synthetic approval', fields: [], actions: [] }, options.signal)
    },
  }
}

async function fixture(t, options) {
  const directory = mkdtempSync('/private/tmp/remember-e06-coordinator-')
  const fake = fakeDriver(options)
  const coordinator = await createCoordinator({ directory, driver: fake.driver })
  let closed = false
  t.after(async () => {
    if (!closed) {
      const state = await rpc(coordinator.socketPath, { op: 'snapshot' }).catch(() => null)
      if (state?.job && !['completed', 'stopped', 'recovery-required'].includes(state.job.phase)) {
        await rpc(coordinator.socketPath, { op: 'stop' }).catch(() => {})
      }
      await coordinator.close().catch(() => {})
    }
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    fake,
    coordinator,
    spec: { prompt: 'Synthetic test only', model: 'fake-model', workspace: join(directory, 'workspace') },
    snapshot: () => rpc(coordinator.socketPath, { op: 'snapshot' }),
    async close() {
      await coordinator.close()
      closed = true
    },
  }
}

test('lost client submit ACK and duplicate submit never invoke a second worker; client detach does not abort', async (t) => {
  const f = await fixture(t)
  const socket = createConnection(f.coordinator.socketPath)
  socket.on('error', () => {})
  await once(socket, 'connect')
  // Intentionally do not consume the ACK. The driver proves the request was accepted.
  socket.write(`${JSON.stringify({ id: 1, op: 'submit', jobId: 'job-e06', spec: f.spec })}\n`)
  await f.fake.invoked
  socket.destroy()
  await waitUntil(
    async () => (await f.snapshot()).events.some(({ type }) => type === 'client-detached'),
    'client detach'
  )
  assert.equal(f.fake.signal.aborted, false)
  assert.equal(f.fake.calls, 1)
  const duplicate = await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  assert.equal(duplicate.created, false)
  assert.equal(f.fake.calls, 1)
  await assert.rejects(
    rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: { ...f.spec, prompt: 'Different work' } }),
    /input-conflict/
  )
  assert.equal(f.fake.calls, 1)
  assert.equal(f.fake.signal.aborted, false)
  f.fake.complete()
  const final = await waitUntil(async () => {
    const state = await f.snapshot()
    return state.job.phase === 'completed' && state
  }, 'completion after detach')
  assert.equal(final.events.filter(({ type }) => type === 'driver-invoked').length, 1)
  assert.equal(final.events.filter(({ type }) => type === 'result-persisted').length, 1)
})

test('an occupied Unix socket rejects a second coordinator before fencing the first journal', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  const before = await f.snapshot()
  const other = fakeDriver()
  await assert.rejects(createCoordinator({ directory: f.directory, driver: other.driver }), /EADDRINUSE/)
  assert.equal(other.calls, 0)
  assert.equal((await f.snapshot()).sessionId, before.sessionId)
  f.fake.complete()
  await waitUntil(async () => (await f.snapshot()).job.phase === 'completed', 'original coordinator can commit')
})

test('null and array client frames close only their socket while the active job keeps running', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  const before = await f.snapshot()
  for (const frame of ['null\n', '[{"id":1,"op":"stop"}]\n']) {
    const socket = createConnection(f.coordinator.socketPath)
    socket.on('error', () => {})
    await once(socket, 'connect')
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
    })
    const closed = once(socket, 'close')
    socket.write(frame)
    try {
      await Promise.race([
        closed,
        pause(1000).then(() => {
          throw new Error('invalid frame socket was not closed')
        }),
      ])
    } finally {
      socket.destroy()
    }
    assert.equal(received, '')
    const after = await f.snapshot()
    assert.equal(after.sessionId, before.sessionId)
    assert.equal(after.job.phase, 'running')
    assert.equal(f.fake.signal.aborted, false)
    assert.equal(f.fake.calls, 1)
  }
  f.fake.complete()
  await waitUntil(async () => (await f.snapshot()).job.phase === 'completed', 'job survives invalid frames')
})

test('current source review checks session, revision and result shape before forwarding exactly once', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  let forwarded = 0
  const answer = f.fake.tool().then((value) => {
    forwarded++
    return value
  })
  const state = await f.snapshot()
  assert.equal(state.job.phase, 'waiting')
  assert.equal(state.requests.length, 1)
  const request = state.requests[0]
  const reply = {
    op: 'reply',
    requestId: request.id,
    sessionId: state.sessionId,
    sourceRevision: request.payload.sourceRevision,
    result: { approved: true },
  }
  await assert.rejects(rpc(f.coordinator.socketPath, { ...reply, sessionId: 'previous-session' }), /review-expired/)
  await assert.rejects(rpc(f.coordinator.socketPath, { ...reply, sourceRevision: 'fixture-v0' }), /revision-conflict/)
  await assert.rejects(
    rpc(f.coordinator.socketPath, { ...reply, result: { approved: true, inventedPermission: true } }),
    /invalid-fixture-review/
  )
  assert.equal(forwarded, 0)
  assert.equal((await f.snapshot()).requests.length, 1)
  await rpc(f.coordinator.socketPath, reply)
  assert.deepEqual(await answer, { approved: true })
  assert.equal(forwarded, 1)
  assert.equal((await f.snapshot()).job.phase, 'running')
  await assert.rejects(rpc(f.coordinator.socketPath, reply), /review-expired/)
  assert.equal(forwarded, 1)
  f.fake.complete()
  await waitUntil(async () => (await f.snapshot()).job.phase === 'completed', 'completion after review')
})

test('provider approvals cannot be answered through the synthetic source-review operation', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  const pending = f.fake.approval()
  const rejected = assert.rejects(pending, /review-expired|worker-ended/)
  const state = await f.snapshot()
  const request = state.requests[0]
  await assert.rejects(
    rpc(f.coordinator.socketPath, {
      op: 'reply',
      requestId: request.id,
      sessionId: state.sessionId,
      sourceRevision: request.payload.sourceRevision,
      result: { approved: true },
    }),
    /provider-approval-requires-native-review/
  )
  await rpc(f.coordinator.socketPath, { op: 'stop' })
  await rejected
  assert.equal((await f.snapshot()).job.phase, 'stopped')
})

test('upstream request abort expires its durable review without approving or stopping the ongoing turn', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  const upstream = new AbortController()
  const review = f.fake.tool(upstream.signal)
  const rejected = assert.rejects(review, /review-expired/)
  const before = await f.snapshot()
  assert.equal(before.job.phase, 'waiting')
  const request = before.requests[0]
  upstream.abort()
  await rejected
  const after = await f.snapshot()
  assert.equal(after.job.phase, 'running')
  assert.deepEqual(after.requests, [])
  assert.equal(f.fake.signal.aborted, false)
  assert.equal(after.events.filter(({ type }) => type === 'review-forwarded').length, 0)
  assert.equal(
    after.events.filter(({ type, payload }) => type === 'request-expired' && payload.id === request.id).length,
    1
  )
  await assert.rejects(
    rpc(f.coordinator.socketPath, {
      op: 'reply',
      requestId: request.id,
      sessionId: before.sessionId,
      sourceRevision: request.payload.sourceRevision,
      result: { approved: true },
    }),
    /review-expired/
  )
  f.fake.complete()
  const final = await waitUntil(async () => {
    const state = await f.snapshot()
    return state.job.phase === 'completed' && state
  }, 'completed after upstream request resolution')
  assert.deepEqual(final.requests, [])
  assert.equal(final.events.filter(({ type }) => type === 'worker-ended').length, 0)
})

test('review TTL expires, stops the owned worker and rejects a later matching reply', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: { ...f.spec, reviewTtlMs: 5000 } })
  const rejected = assert.rejects(f.fake.tool(), /review-expired|worker-ended/)
  const state = await f.snapshot()
  const request = state.requests[0]
  await waitUntil(async () => (await f.snapshot()).job.phase === 'stopped', 'TTL confirmed stop', 6500)
  await rejected
  assert.equal(f.fake.aborted, true)
  await assert.rejects(
    rpc(f.coordinator.socketPath, {
      op: 'reply',
      requestId: request.id,
      sessionId: state.sessionId,
      sourceRevision: request.payload.sourceRevision,
      result: { approved: true },
    }),
    /review-expired/
  )
  assert.deepEqual((await f.snapshot()).requests, [])
})

test('an early review timer keeps the request pending until its actual deadline', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: { ...f.spec, reviewTtlMs: 5000 } })
  const rejected = assert.rejects(f.fake.tool(), /review-expired|worker-ended/)
  const before = await f.snapshot()
  const request = before.requests[0]
  assert.equal(request.payload.expiresAt, now + 5000)

  now = request.payload.expiresAt - 1
  t.mock.timers.tick(5000)
  const early = await f.snapshot()
  assert.equal(early.job.phase, 'waiting')
  assert.equal(early.requests.length, 1)
  assert.equal(early.requests[0].id, request.id)
  assert.equal(f.fake.signal.aborted, false)
  assert.equal(early.events.filter(({ type }) => type === 'review-expiry').length, 0)
  assert.equal(early.events.filter(({ type }) => type === 'request-expired').length, 0)

  now = request.payload.expiresAt
  t.mock.timers.tick(1)
  await rejected
  const final = await f.snapshot()
  assert.equal(final.job.phase, 'stopped')
  assert.equal(final.job.stopReason, 'request-expired')
  const cursor = final.events.at(-1).seq
  const afterCursor = await rpc(f.coordinator.socketPath, { op: 'snapshot', afterSeq: cursor })
  assert.equal(afterCursor.job.stopReason, 'request-expired')
  assert(!afterCursor.events.some(({ type }) => type === 'review-expiry'))
  assert.equal((await rpc(f.coordinator.socketPath, { op: 'stop' })).stopReason, 'request-expired')
  await f.close()
  const reopened = await createCoordinator({ directory: f.directory, driver: f.fake.driver })
  try {
    const restored = await rpc(reopened.socketPath, { op: 'snapshot', afterSeq: cursor })
    assert.equal(restored.job.phase, 'stopped')
    assert.equal(restored.job.stopReason, 'request-expired')
    assert.equal(f.fake.calls, 1)
  } finally {
    await reopened.close()
  }
  assert.equal(f.fake.signal.aborted, true)
  assert.deepEqual(final.requests, [])
  const expiry = final.events.filter(({ type }) => type === 'review-expiry')
  assert.equal(expiry.length, 1)
  assert.equal(expiry[0].createdAt, request.payload.expiresAt)
  assert.equal(f.fake.calls, 1)
})

test('completed result is recovered after coordinator reopen and repeated submit never starts the new driver', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  f.fake.complete('Result produced before client reconnect')
  const before = await waitUntil(async () => {
    const state = await f.snapshot()
    return state.job.phase === 'completed' && state
  }, 'completed before close')
  await f.close()
  const fake = fakeDriver()
  const reopened = await createCoordinator({ directory: f.directory, driver: fake.driver })
  try {
    const after = await rpc(reopened.socketPath, { op: 'snapshot' })
    assert.deepEqual(after.job, before.job)
    assert.deepEqual(
      after.events.filter(({ type }) => type === 'result-persisted'),
      before.events.filter(({ type }) => type === 'result-persisted')
    )
    const duplicate = await rpc(reopened.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
    assert.equal(duplicate.created, false)
    assert.equal(fake.calls, 0)
  } finally {
    await reopened.close()
  }
})

test('actual coordinator process loss expires pending review; restart invokes no driver and refuses old review', async (t) => {
  const directory = mkdtempSync('/private/tmp/remember-e06-coordinator-crash-')
  let reopened
  const script = `
    import { createCoordinator } from ${JSON.stringify(new URL('./coordinator.mjs', import.meta.url).href)};
    const driver = {runCodexWorker(options) {
      options.onThread('thread-crash');
      options.onCheckpoint({threadId:'thread-crash',turnId:null,previousTurnId:null});
      options.onCheckpoint({threadId:'thread-crash',turnId:'turn-crash',previousTurnId:null,commandItemIds:['owned-command']});
      return options.tools[0].call({nonce:'crash-review'}, {threadId:'thread-crash',turnId:'turn-crash',callId:'call-crash',signal:options.signal});
    }, async stopCodexRemoteCheckpoint() {throw new Error('must-not-stop-automatically')}};
    const coordinator = await createCoordinator({directory:${JSON.stringify(directory)},driver});
    process.stdout.write(JSON.stringify({socketPath:coordinator.socketPath})+'\\n');
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    if (reopened) await reopened.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  const address = await waitUntil(
    () => output.includes('\n') && JSON.parse(output.slice(0, output.indexOf('\n'))),
    `child ready: ${stderr}`
  )
  const spec = { prompt: 'Synthetic crash review', model: 'fake-model', workspace: join(directory, 'workspace') }
  await rpc(address.socketPath, { op: 'submit', jobId: 'job-crash', spec })
  const before = await rpc(address.socketPath, { op: 'snapshot' })
  assert.equal(before.job.phase, 'waiting')
  const request = before.requests[0]
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  // Only remove the socket belonging to this now-confirmed-dead test process.
  if (existsSync(address.socketPath)) unlinkSync(address.socketPath)
  const fake = fakeDriver()
  reopened = await createCoordinator({ directory, driver: fake.driver })
  const after = await rpc(reopened.socketPath, { op: 'snapshot' })
  assert.equal(after.job.phase, 'recovery-required')
  assert.equal(after.job.threadId, 'thread-crash')
  assert.equal(after.job.turnId, 'turn-crash')
  assert.deepEqual(after.requests, [])
  assert.notEqual(after.sessionId, before.sessionId)
  assert.equal(fake.calls, 0)
  await assert.rejects(
    rpc(reopened.socketPath, {
      op: 'reply',
      requestId: request.id,
      sessionId: before.sessionId,
      sourceRevision: request.payload.sourceRevision,
      result: { approved: true },
    }),
    /review-expired/
  )
  assert.equal((await rpc(reopened.socketPath, { op: 'submit', jobId: 'job-crash', spec })).created, false)
  assert.equal(fake.calls, 0)
})

test('Stop after an ended uncertain worker reconciles the exact checkpoint instead of awaiting its settled promise', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  f.fake.fail()
  await waitUntil(async () => (await f.snapshot()).job.phase === 'recovery-required', 'uncertain worker settled')
  const stopped = await rpc(f.coordinator.socketPath, { op: 'stop' })
  assert.equal(stopped.phase, 'stopped')
  assert.equal(f.fake.stops.length, 1)
  assert.equal(f.fake.stops[0].threadId, 'thread-e06')
  assert.equal(f.fake.stops[0].turnId, 'turn-e06')
  assert.deepEqual(f.fake.stops[0].commandItemIds, ['command-e06'])
})

test('restart with unacknowledged turn-start intent keeps Stop unconfirmed without provider Stop or replay', async (t) => {
  const directory = mkdtempSync('/private/tmp/remember-e06-start-acceptance-')
  let reopened
  const script = `
    import { createCoordinator } from ${JSON.stringify(new URL('./coordinator.mjs', import.meta.url).href)};
    const driver = {runCodexWorker(options) {
      options.onThread('thread-start-uncertain');
      options.onCheckpoint({threadId:'thread-start-uncertain',turnId:null,previousTurnId:'previous-turn',commandItemIds:[]});
      return new Promise(() => {});
    }, async stopCodexRemoteCheckpoint() {throw new Error('must-not-stop-automatically')}};
    const coordinator = await createCoordinator({directory:${JSON.stringify(directory)},driver});
    process.stdout.write(JSON.stringify({socketPath:coordinator.socketPath})+'\\n');
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.resume()
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    if (reopened) await reopened.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  })
  const address = await waitUntil(
    () => output.includes('\n') && JSON.parse(output.slice(0, output.indexOf('\n'))),
    'start-intent child ready'
  )
  const spec = { prompt: 'Synthetic pending start', model: 'fake-model', workspace: join(directory, 'workspace') }
  await rpc(address.socketPath, { op: 'submit', jobId: 'job-start-uncertain', spec })
  const before = await rpc(address.socketPath, { op: 'snapshot' })
  assert.equal(before.job.phase, 'turn-start-intent')
  assert.equal(before.job.turnId, null)
  assert.equal(before.events.filter(({ type }) => type === 'checkpoint').at(-1).payload.checkpoint.turnId, null)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  if (existsSync(address.socketPath)) unlinkSync(address.socketPath)
  const fake = fakeDriver()
  reopened = await createCoordinator({ directory, driver: fake.driver })
  const recovered = await rpc(reopened.socketPath, { op: 'snapshot' })
  assert.equal(recovered.job.phase, 'recovery-required')
  assert.equal(recovered.job.threadId, 'thread-start-uncertain')
  assert.equal(recovered.job.turnId, null)
  await assert.rejects(rpc(reopened.socketPath, { op: 'stop' }), /stop-unconfirmed-start-acceptance/)
  const afterStop = await rpc(reopened.socketPath, { op: 'snapshot' })
  assert.deepEqual(afterStop.job, recovered.job)
  assert.equal(afterStop.events.filter(({ type }) => type === 'stop-confirmed').length, 0)
  assert.equal((await rpc(reopened.socketPath, { op: 'submit', jobId: 'job-start-uncertain', spec })).created, false)
  assert.equal(fake.calls, 0)
  assert.deepEqual(fake.stops, [])
})

test('deadline reason does not confirm Stop when the provider cannot stop its exact checkpoint', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t, { stopFails: true })
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: { ...f.spec, reviewTtlMs: 5000 } })
  const rejected = assert.rejects(f.fake.tool(), /review-expired|worker-ended/)
  const before = await f.snapshot()
  now = before.requests[0].payload.expiresAt
  t.mock.timers.tick(5000)
  await rejected
  const after = await f.snapshot()
  assert.equal(after.job.phase, 'recovery-required')
  assert.equal(after.job.stopReason, 'request-expired')
  assert.equal(after.events.filter(({ type }) => type === 'stop-confirmed').length, 0)
  await assert.rejects(rpc(f.coordinator.socketPath, { op: 'stop' }), /synthetic-stop-unconfirmed/)
  assert.equal((await f.snapshot()).job.phase, 'recovery-required')
  assert.equal(f.fake.calls, 1)
})

test('manual Stop expires a pending request without inventing a deadline reason', async (t) => {
  const f = await fixture(t)
  await rpc(f.coordinator.socketPath, { op: 'submit', jobId: 'job-e06', spec: f.spec })
  const rejected = assert.rejects(f.fake.tool(), /review-expired|worker-ended/)
  const stopped = await rpc(f.coordinator.socketPath, { op: 'stop' })
  await rejected
  const state = await f.snapshot()
  assert.equal(stopped.phase, 'stopped')
  assert.equal(stopped.stopReason, undefined)
  assert.equal(state.job.stopReason, undefined)
  assert(state.events.some(({ type }) => type === 'request-expired'))
  assert(!state.events.some(({ type }) => type === 'review-expiry'))
})
