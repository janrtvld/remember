import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { createCoordinator } from './coordinator.mjs'

let nextId = 0
async function rpc(path, request) {
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  let buffer = ''
  try {
    await once(socket, 'connect')
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test-rpc-timeout')), 3000)
      socket.once('error', reject)
      socket.on('data', (data) => {
        buffer += data
        if (!buffer.includes('\n')) return
        clearTimeout(timer)
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
        if (response.error) reject(new Error(response.error))
        else resolve(response.result)
      })
      socket.write(`${JSON.stringify({ id: ++nextId, ...request })}\n`)
    })
  } finally {
    socket.destroy()
  }
}

async function fixture(t) {
  const directory = mkdtempSync('/private/tmp/remember-native-host-test-')
  let options, finish, fail
  let calls = 0
  const terminal = new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const coordinator = await createCoordinator({
    directory,
    nativeClient: true,
    driver: {
      runCodexWorker(input) {
        calls++
        options = input
        input.onThread('native-thread')
        const checkpoint = { computer: input.remote, threadId: 'native-thread', turnId: null, previousTurnId: null }
        input.onCheckpoint(checkpoint)
        input.onCheckpoint({ ...checkpoint, turnId: 'native-turn' })
        input.signal.addEventListener(
          'abort',
          () => {
            input.onCheckpoint(null)
            fail(new Error('agent-cancelled'))
          },
          { once: true }
        )
        return terminal
      },
      async stopCodexRemoteCheckpoint() {},
    },
  })
  t.after(async () => {
    const snapshot = await rpc(coordinator.socketPath, { op: 'snapshot' }).catch(() => null)
    if (snapshot?.job && !['completed', 'stopped', 'recovery-required'].includes(snapshot.job.phase)) {
      await rpc(coordinator.socketPath, { op: 'stop' }).catch(() => {})
    }
    await coordinator.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    rpc: (request) => rpc(coordinator.socketPath, request),
    spec: {
      prompt: 'Synthetic native request',
      model: 'fake-model',
      effort: 'low',
      workspace: join(directory, 'workspace'),
      systemPrompt: 'Synthetic native policy',
      threadId: null,
      tools: [{ name: 'remember_memory', description: 'Synthetic memory tool', inputSchema: { type: 'object' } }],
    },
    get options() {
      return options
    },
    get calls() {
      return calls
    },
    complete() {
      options.onCheckpoint(null)
      finish({ response: 'Native fixture final result', threadId: 'native-thread' })
    },
  }
}

test('native handshake, bounded capabilities and client-tool identity match the declared contract', async (t) => {
  const f = await fixture(t)
  const hello = await f.rpc({ op: 'hello' })
  assert.equal(hello.nativeClient, true)
  assert.equal(hello.protocol, 'remember-host-job-v1')
  assert.equal(hello.workspace, f.spec.workspace)
  assert.equal(hello.jobId, null)
  await assert.rejects(
    f.rpc({
      op: 'submit',
      jobId: 'native-job',
      spec: { ...f.spec, tools: [{ ...f.spec.tools[0], name: 'arbitrary_tool' }] },
    }),
    /invalid-native-spec/
  )
  assert.equal(f.calls, 0)
  assert.equal((await f.rpc({ op: 'snapshot' })).job, null)
  await f.rpc({ op: 'submit', jobId: 'native-job', spec: f.spec })
  assert.equal(f.calls, 1)
  assert.equal((await f.rpc({ op: 'hello' })).jobId, 'native-job')
  assert.equal(f.options.systemPrompt, f.spec.systemPrompt)
  assert.equal(f.options.effort, f.spec.effort)
  const tool = f.options.tools[0].call(
    { action: 'read', slug: 'synthetic-page' },
    {
      threadId: 'native-thread',
      turnId: 'native-turn',
      callId: 'native-call',
      signal: f.options.signal,
    }
  )
  const state = await f.rpc({ op: 'snapshot' })
  const request = state.requests[0]
  assert.equal(request.method, 'client-tool')
  assert.equal(request.payload.tool, 'remember_memory')
  assert.equal(request.payload.callId, 'native-call')
  assert.equal(request.payload.threadId, 'native-thread')
  assert.equal(request.payload.turnId, 'native-turn')
  assert.deepEqual(request.payload.input, { action: 'read', slug: 'synthetic-page' })
  assert.equal(Object.hasOwn(request.payload, 'sourceRevision'), false)
  await assert.rejects(
    f.rpc({ op: 'reply', requestId: request.id, sessionId: state.sessionId, result: { success: true } }),
    /invalid-client-tool-result/
  )
  await assert.rejects(
    f.rpc({ op: 'reply', requestId: request.id, sessionId: 'expired-session', result: { success: true, output: {} } }),
    /review-expired/
  )
  await f.rpc({
    op: 'reply',
    requestId: request.id,
    sessionId: state.sessionId,
    result: { success: true, output: { revision: 'revision-1' } },
  })
  assert.deepEqual(await tool, { revision: 'revision-1' })
  await assert.rejects(
    f.rpc({ op: 'reply', requestId: request.id, sessionId: state.sessionId, result: { success: true, output: {} } }),
    /review-expired/
  )
})

test('native final snapshot retains the result even after its event cursor was consumed', async (t) => {
  const f = await fixture(t)
  await f.rpc({ op: 'submit', jobId: 'native-job', spec: f.spec })
  f.complete()
  const state = await f.rpc({ op: 'snapshot' })
  assert.equal(state.job.phase, 'completed')
  assert.equal(state.result.response, 'Native fixture final result')
  const resultEvent = state.events.find(({ type }) => type === 'result-persisted')
  assert(resultEvent)
  const after = await f.rpc({ op: 'snapshot', afterSeq: resultEvent.seq + 100 })
  assert.deepEqual(after.events, [])
  assert.deepEqual(after.result, state.result)
  assert.equal((await f.rpc({ op: 'submit', jobId: 'native-job', spec: f.spec })).created, false)
  assert.equal(f.calls, 1)
})

test('native provider review validates the current action and a record-shaped answer before forwarding', async (t) => {
  const f = await fixture(t)
  await f.rpc({ op: 'submit', jobId: 'native-job', spec: f.spec })
  const review = f.options
    .ask(
      {
        title: 'Synthetic approval',
        detail: 'Review exact synthetic work',
        fields: [],
        actions: [
          { id: 'accept', label: 'Allow' },
          { id: 'decline', label: 'Decline' },
        ],
      },
      f.options.signal
    )
    .catch((error) => ({ error: error.message }))
  const state = await f.rpc({ op: 'snapshot' })
  const request = state.requests[0]
  assert.equal(request.method, 'provider-approval')
  const reply = { op: 'reply', requestId: request.id, sessionId: state.sessionId }
  await assert.rejects(
    f.rpc({ ...reply, result: { id: 'local-review', action: 'invented', values: {} } }),
    /invalid-provider-review/
  )
  for (const values of [[], { field: 1 }, { field: 'x'.repeat(10_001) }]) {
    await assert.rejects(
      f.rpc({ ...reply, result: { id: 'local-review', action: 'accept', values } }),
      /invalid-provider-review/
    )
  }
  assert.equal((await f.rpc({ op: 'snapshot' })).requests.length, 1)
  const decision = { id: 'local-review', action: 'decline', values: {} }
  await f.rpc({ ...reply, result: decision })
  assert.deepEqual(await review, decision)
  assert.equal((await f.rpc({ op: 'snapshot' })).requests.length, 0)
})
