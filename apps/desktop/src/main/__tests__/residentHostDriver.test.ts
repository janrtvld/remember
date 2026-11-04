import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { type TestContext, test } from 'node:test'
import type { ResidentHostRun } from '../residentAgentStore'
import { createResidentHostDriver } from '../residentHostDriver'

type Request = { id: number; op: string; [key: string]: unknown }
type Input = Parameters<ReturnType<typeof createResidentHostDriver>['run']>[0]
type ToolContext = Parameters<Input['tools'][number]['call']>[1]

const workspace = '/mini/workspace'
const hello = { protocol: 'remember-host-job-v1', nativeClient: true, singleJob: true, jobId: null, workspace }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function snapshot(phase = 'completed', extras: Record<string, unknown> = {}) {
  return {
    sessionId: 'host-session-1',
    job: { id: 'message-1', phase, threadId: 'thread-1', turnId: 'provider-turn-1' },
    requests: [],
    events: [],
    result: phase === 'completed' ? { response: 'Verified saved host result', threadId: 'thread-1' } : null,
    ...extras,
  }
}

function toolRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    sessionId: 'host-session-1',
    method: 'client-tool',
    payload: {
      expiresAt: Date.now() + 10_000,
      tool: 'remember_memory',
      input: { action: 'read' },
      threadId: 'thread-1',
      turnId: 'provider-turn-1',
      callId: 'provider-call-1',
    },
    ...overrides,
  }
}

async function host(t: TestContext, handle: (request: Request, socket: Socket) => unknown | Promise<unknown>) {
  const requests: Request[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n')
        const request = JSON.parse(buffer.slice(0, end)) as Request
        buffer = buffer.slice(end + 1)
        requests.push(request)
        void Promise.resolve()
          .then(() => handle(request, socket))
          .then(
            (result) => {
              if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
            },
            (error) => {
              if (!socket.destroyed)
                socket.write(`${JSON.stringify({ id: request.id, error: String(error.message) })}\n`)
            }
          )
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  return { endpoint: `tcp://127.0.0.1:${address.port}`, requests }
}

function normal(request: Request, current = snapshot()) {
  if (request.op === 'hello') return hello
  if (request.op === 'submit') return { created: true, job: current.job }
  if (request.op === 'snapshot') return current
  if (request.op === 'reply') return { status: 'resolved' }
  throw new Error(`Unexpected test operation ${request.op}`)
}

function makeInput(endpoint: string, overrides: Partial<Input> = {}) {
  const bindings: ResidentHostRun[] = []
  const updates: Parameters<Input['onUpdate']>[0][] = []
  const threads: string[] = []
  const input: Input = {
    turnId: 'message-1',
    prompt: 'Synthetic user instruction',
    instruction: 'Synthetic user instruction',
    threadId: null,
    hostRun: null,
    onHostRun: (binding) => bindings.push(structuredClone(binding)),
    onThread: (id) => threads.push(id),
    onUpdate: (update) => updates.push(update),
    computer: { kind: 'remote', endpoint: 'ws://127.0.0.1:47831/', workspace },
    model: 'fake-model',
    effort: 'low',
    instructions: 'Synthetic policy',
    tools: [],
    ask: async () => {
      throw new Error('Unexpected approval')
    },
    assertAvailable() {},
    ...overrides,
  }
  return { input, bindings, updates, threads, endpoint }
}

function resume(endpoint: string, cursor = 0): ResidentHostRun {
  return { jobId: 'message-1', messageId: 'message-1', endpoint, cursor, phase: 'running', connection: 'disconnected' }
}

function memoryTool(call: Input['tools'][number]['call']): Input['tools'][number] {
  return { name: 'remember_memory', description: 'Synthetic local tool', inputSchema: { type: 'object' }, call }
}

test('fresh submit persists its intent before the host sees work, then stores the verified result and identity', async (t) => {
  let input: ReturnType<typeof makeInput>
  const fixture = await host(t, (request) => {
    if (request.op === 'submit') {
      assert.equal(input.bindings.length, 1)
      assert.equal(input.bindings[0].phase, 'starting')
      assert.equal(input.bindings[0].jobId, 'message-1')
      assert.equal(input.bindings[0].cursor, 0)
      const spec = request.spec as Record<string, unknown>
      assert.equal(spec.prompt, input.input.prompt)
      assert.equal(spec.systemPrompt, input.input.instructions)
      assert.equal(spec.workspace, workspace)
    }
    return normal(request)
  })
  input = makeInput(fixture.endpoint)
  const result = await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(result.response, 'Verified saved host result')
  assert.equal(result.provider, 'codex')
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(input.bindings.at(-1)?.phase, 'completed')
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['hello', 'submit', 'snapshot']
  )
})

test('invalid or oversized fresh specifications never create a binding or reach submit', async (t) => {
  const tool = memoryTool(async () => ({}))
  const invalidInputs: Partial<Input>[] = [
    { prompt: 'x'.repeat(30_001) },
    { instructions: 'x'.repeat(20_001) },
    { model: 'INVALID MODEL' },
    { effort: 'invented' },
    { threadId: 'x'.repeat(201) },
    { tools: [{ ...tool, name: 'arbitrary_tool' }] },
    { tools: [tool, tool] },
    { tools: [{ ...tool, description: 'x'.repeat(4001) }] },
    { prompt: '界'.repeat(30_000) },
    { prompt: '\u0001'.repeat(30_000) },
  ]
  for (const invalidInput of invalidInputs) {
    const fixture = await host(t, (request) => normal(request))
    const input = makeInput(fixture.endpoint, invalidInput)
    await assert.rejects(
      createResidentHostDriver(fixture.endpoint).run(input.input),
      /host-(invalid-spec|spec-too-large)/
    )
    assert.equal(input.bindings.length, 0, 'Preflight failure must not leave an unconfirmed local job')
    assert.equal(fixture.requests.filter(({ op }) => op === 'submit').length, 0)
  }
})

test('maximum prompt and instruction lengths remain accepted when their serialized payload fits', async (t) => {
  const fixture = await host(t, (request) => normal(request))
  const input = makeInput(fixture.endpoint, {
    prompt: 'x'.repeat(30_000),
    instructions: 'y'.repeat(20_000),
  })
  const result = await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(result.response, 'Verified saved host result')
  assert.equal(fixture.requests.filter(({ op }) => op === 'submit').length, 1)
  assert.equal(input.bindings.at(-1)?.phase, 'completed')
})

test('an occupied single-job host rejects fresh work before creating a local binding', async (t) => {
  const fixture = await host(t, () => ({ ...hello, jobId: 'existing-host-job' }))
  const input = makeInput(fixture.endpoint)
  await assert.rejects(createResidentHostDriver(fixture.endpoint).run(input.input), /host-single-job-only/)
  assert.equal(input.bindings.length, 0)
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['hello']
  )
})

test('detaching before hello completes cannot bind or submit work after the reply arrives', async (t) => {
  const reachedHello = deferred<void>()
  const releaseHello = deferred<void>()
  const fixture = await host(t, async (request) => {
    if (request.op === 'hello') {
      reachedHello.resolve()
      await releaseHello.promise
    }
    return normal(request)
  })
  const input = makeInput(fixture.endpoint)
  const driver = createResidentHostDriver(fixture.endpoint)
  const rejected = assert.rejects(driver.run(input.input), /host-client-detached/)
  await reachedHello.promise
  driver.detach(input.input.turnId)
  releaseHello.resolve()
  await rejected
  assert.equal(input.bindings.length, 0)
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['hello']
  )
})

test('resume uses the saved cursor without submit, including a final result whose event is already behind the cursor', async (t) => {
  const fixture = await host(t, (request) => {
    if (request.op === 'snapshot') assert.equal(request.afterSeq, 150)
    return normal(request)
  })
  const input = makeInput(fixture.endpoint, { hostRun: resume(fixture.endpoint, 150) })
  const result = await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(result.response, 'Verified saved host result')
  assert.equal(input.bindings.at(-1)?.cursor, 150)
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['hello', 'snapshot']
  )
  assert.equal(input.updates.at(-1)?.text, result.response)
})

test('resumed event pages advance the durable cursor before reading the next page', async (t) => {
  let page = 0
  let input: ReturnType<typeof makeInput>
  const fixture = await host(t, (request) => {
    if (request.op !== 'snapshot') return normal(request)
    if (page++ === 0)
      return snapshot('completed', {
        events: Array.from({ length: 100 }, (_, index) => ({
          seq: index + 1,
          type: 'checkpoint',
          payload: {},
          createdAt: 100,
        })),
      })
    assert.equal(request.afterSeq, 100)
    assert.equal(input.bindings.at(-1)?.cursor, 100)
    return snapshot()
  })
  input = makeInput(fixture.endpoint, { hostRun: resume(fixture.endpoint) })
  await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(page, 2)
  assert.equal(fixture.requests.filter(({ op }) => op === 'submit').length, 0)
})

test('a pending tool is called once with exact provider identity and replied to in its current host session', async (t) => {
  let replied = false
  let calls = 0
  const contexts: ToolContext[] = []
  const request = toolRequest()
  const fixture = await host(t, (message) => {
    if (message.op === 'reply') {
      assert.equal(message.requestId, request.id)
      assert.equal(message.sessionId, request.sessionId)
      assert.deepEqual(message.result, { success: true, output: { revision: 'source-v1' } })
      replied = true
    }
    return normal(message, replied ? snapshot() : snapshot('waiting', { requests: [request] }))
  })
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    tools: [
      memoryTool(async (_input, context) => {
        calls++
        contexts.push(context)
        return { revision: 'source-v1' }
      }),
    ],
  })
  await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(calls, 1)
  assert.equal(contexts[0].threadId, 'thread-1')
  assert.equal(contexts[0].turnId, 'provider-turn-1')
  assert.equal(contexts[0].callId, 'provider-call-1')
  assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 1)
})

test('expired and previous-session tool requests never execute locally or receive a reply', async (t) => {
  let snapshots = 0
  let calls = 0
  const expired = toolRequest()
  expired.payload.expiresAt = Date.now() - 1
  const fixture = await host(t, (request) => {
    if (request.op === 'snapshot')
      return ++snapshots === 1
        ? snapshot('waiting', { requests: [expired, toolRequest({ id: 'old', sessionId: 'old-session' })] })
        : snapshot()
    return normal(request)
  })
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    tools: [
      memoryTool(async () => {
        calls++
        return {}
      }),
    ],
  })
  await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(calls, 0)
  assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 0)
})

test('multibyte tool replies resolve within the byte budget and oversized output becomes one explicit tool error', async (t) => {
  const overhead = Buffer.byteLength(JSON.stringify({ success: true, output: { content: '' } }))
  const available = 64 * 1024 - overhead
  const exactBoundary = '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3)
  for (const [content, oversized] of [
    ['界'.repeat(6000), false],
    [exactBoundary, false],
    [`${exactBoundary}x`, true],
  ] as const) {
    let replied = false
    let calls = 0
    const request = toolRequest({ id: 'r'.repeat(200) })
    const fixture = await host(t, (message) => {
      if (message.op === 'reply') {
        assert.equal(message.requestId, request.id)
        assert.equal(message.sessionId, request.sessionId)
        assert(Buffer.byteLength(JSON.stringify(message.result)) <= 64 * 1024)
        assert(Buffer.byteLength(`${JSON.stringify(message)}\n`) <= 70_000, 'Frame includes identities and delimiters')
        assert.deepEqual(
          message.result,
          oversized
            ? { success: false, error: 'remember-tool-result-too-large' }
            : { success: true, output: { content } }
        )
        replied = true
      }
      return normal(message, replied ? snapshot() : snapshot('waiting', { requests: [request] }))
    })
    const input = makeInput(fixture.endpoint, {
      hostRun: resume(fixture.endpoint),
      tools: [
        memoryTool(async () => {
          calls += 1
          return { content }
        }),
      ],
    })
    await createResidentHostDriver(fixture.endpoint).run(input.input)
    assert.equal(calls, 1)
    assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 1)
    assert.equal(input.bindings.at(-1)?.phase, 'completed', 'The request resolves rather than stranding the host')
    assert(!input.bindings.some(({ connection }) => connection === 'disconnected'))
  }
})

test('tool identity from another provider turn must never authorize a local tool call', async (t) => {
  let snapshots = 0
  let calls = 0
  const wrong = toolRequest()
  wrong.payload.turnId = 'another-turn'
  const fixture = await host(t, (request) => {
    if (request.op === 'snapshot') return ++snapshots === 1 ? snapshot('waiting', { requests: [wrong] }) : snapshot()
    return normal(request)
  })
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    tools: [
      memoryTool(async () => {
        calls++
        return {}
      }),
    ],
  })
  await createResidentHostDriver(fixture.endpoint)
    .run(input.input)
    .catch(() => {})
  assert.equal(calls, 0, 'A different provider turn cannot own the local memory operation')
  assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 0)
})

test('request expiry aborts pending local work and never sends a late tool result', async (t) => {
  let snapshots = 0
  let aborted = false
  const request = toolRequest()
  request.payload.expiresAt = Date.now() + 80
  const fixture = await host(t, (message) => {
    if (message.op === 'snapshot') return ++snapshots === 1 ? snapshot('waiting', { requests: [request] }) : snapshot()
    return normal(message)
  })
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    tools: [
      memoryTool(
        async (_input, { signal }) =>
          new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
                resolve({ tooLate: true })
              },
              { once: true }
            )
          )
      ),
    ],
  })
  await createResidentHostDriver(fixture.endpoint).run(input.input)
  assert.equal(aborted, true)
  assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 0)
})

test('detach aborts local review and closes the client without submitting Stop or a late reply', async (t) => {
  const started = deferred<AbortSignal>()
  const fixture = await host(t, (request) => normal(request, snapshot('waiting', { requests: [toolRequest()] })))
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    tools: [
      memoryTool(async (_input, { signal }) => {
        started.resolve(signal)
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
        )
      }),
    ],
  })
  const driver = createResidentHostDriver(fixture.endpoint)
  const rejected = assert.rejects(driver.run(input.input), /host-client-detached/)
  const signal = await started.promise
  driver.detach(input.input.turnId)
  await rejected
  assert.equal(signal.aborted, true)
  assert.equal(input.bindings.at(-1)?.connection, 'disconnected')
  assert.equal(fixture.requests.filter(({ op }) => op === 'stop' || op === 'reply').length, 0)
})

test('explicit Stop is sent only after the host snapshot matches the owned job', async (t) => {
  for (const matches of [false, true]) {
    const fixture = await host(t, (request) => {
      if (request.op === 'stop') return { phase: 'stopped' }
      return snapshot('running', {
        job: {
          id: matches ? 'message-1' : 'someone-elses-job',
          phase: 'running',
          threadId: 'thread-1',
          turnId: 'provider-turn-1',
        },
      })
    })
    const driver = createResidentHostDriver(fixture.endpoint)
    if (matches) await driver.stop(resume(fixture.endpoint))
    else await assert.rejects(driver.stop(resume(fixture.endpoint)), /host-stop-unconfirmed/)
    assert.equal(fixture.requests.filter(({ op }) => op === 'stop').length, matches ? 1 : 0)
  }
})

test('Stop racing with completion returns only the final snapshot result of the same job', async (t) => {
  for (const validResult of [false, true]) {
    let stopped = false
    const fixture = await host(t, (request) => {
      if (request.op === 'stop') {
        stopped = true
        return { phase: 'completed' }
      }
      return stopped ? snapshot('completed', validResult ? {} : { result: null }) : snapshot('running')
    })
    const driver = createResidentHostDriver(fixture.endpoint)
    if (validResult)
      assert.deepEqual(await driver.stop(resume(fixture.endpoint)), {
        phase: 'completed',
        response: 'Verified saved host result',
      })
    else await assert.rejects(driver.stop(resume(fixture.endpoint)), /host-result-unconfirmed/)
    assert.deepEqual(
      fixture.requests.map(({ op }) => op),
      ['snapshot', 'stop', 'snapshot']
    )
  }
})

test('unsupported capability and unknown start acceptance never fall back to fresh work', async (t) => {
  for (const capabilities of [
    { nativeClient: false },
    { nativeClient: 'false' },
    { singleJob: 1 },
    { workspace: '/other' },
  ]) {
    const unsupported = await host(t, () => ({ ...hello, ...capabilities }))
    const bad = makeInput(unsupported.endpoint)
    await assert.rejects(createResidentHostDriver(unsupported.endpoint).run(bad.input), /unsupported-host-capability/)
    assert.equal(bad.bindings.length, 0)
    assert.deepEqual(
      unsupported.requests.map(({ op }) => op),
      ['hello']
    )
  }

  const fixture = await host(t, (request, socket) => {
    if (request.op === 'submit') {
      socket.destroy()
      return null
    }
    if (request.op === 'snapshot') return snapshot('running', { job: null })
    return normal(request)
  })
  const fresh = makeInput(fixture.endpoint)
  const driver = createResidentHostDriver(fixture.endpoint)
  await assert.rejects(driver.run(fresh.input), /disconnected/)
  assert.equal(fresh.bindings.at(-1)?.phase, 'starting')
  assert.equal(fresh.bindings.at(-1)?.connection, 'disconnected')
  const savedBinding = fresh.bindings.at(-1)
  assert(savedBinding)
  const retry = makeInput(fixture.endpoint, { hostRun: savedBinding })
  await assert.rejects(driver.run(retry.input), /host-start-unconfirmed/)
  assert.equal(fixture.requests.filter(({ op }) => op === 'submit').length, 1)
})

test('policy revoked while hello is pending prevents submit entirely', async (t) => {
  let available = true
  const fixture = await host(t, (request) => {
    if (request.op === 'hello') available = false
    return normal(request)
  })
  const input = makeInput(fixture.endpoint, {
    assertAvailable() {
      if (!available) throw new Error('policy-revoked')
    },
  })
  await assert.rejects(createResidentHostDriver(fixture.endpoint).run(input.input), /policy-revoked/)
  assert.equal(fixture.requests.filter(({ op }) => op === 'submit').length, 0)
})

test('policy revoked while snapshot is pending cannot publish or complete its result', async (t) => {
  let available = true
  const fixture = await host(t, (request) => {
    if (request.op === 'snapshot') available = false
    return normal(request)
  })
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    assertAvailable() {
      if (!available) throw new Error('policy-revoked')
    },
  })
  await assert.rejects(createResidentHostDriver(fixture.endpoint).run(input.input), /policy-revoked/)
  assert.equal(input.updates.length, 0)
  assert.equal(
    input.bindings.some(({ phase }) => phase === 'completed'),
    false
  )
})

test('policy failure after a local tool result prevents the reply from being forwarded', async (t) => {
  let available = true
  const fixture = await host(t, (request) => normal(request, snapshot('waiting', { requests: [toolRequest()] })))
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    assertAvailable() {
      if (!available) throw new Error('policy-revoked')
    },
    tools: [
      memoryTool(async () => {
        available = false
        return { saved: true }
      }),
    ],
  })
  await assert.rejects(createResidentHostDriver(fixture.endpoint).run(input.input), /policy-revoked/)
  assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 0)
})

test('a changed host session aborts an existing local review even if a request id is reused', async (t) => {
  let snapshots = 0
  let aborted = false
  let continuedWithStaleReview = false
  const request = toolRequest()
  const fixture = await host(t, (message) => {
    if (message.op === 'snapshot') {
      snapshots++
      if (snapshots === 1) return snapshot('waiting', { requests: [request] })
      if (snapshots === 2)
        return snapshot('waiting', {
          sessionId: 'host-session-2',
          requests: [{ ...request, sessionId: 'host-session-2' }],
        })
      continuedWithStaleReview = !aborted
      return snapshot()
    }
    return normal(message)
  })
  const input = makeInput(fixture.endpoint, {
    hostRun: resume(fixture.endpoint),
    tools: [
      memoryTool(
        async (_input, { signal }) =>
          new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
                resolve({ cancelled: true })
              },
              { once: true }
            )
          )
      ),
    ],
  })
  await assert.rejects(createResidentHostDriver(fixture.endpoint).run(input.input), /host-recovery-required/)
  assert.equal(input.bindings.at(-1)?.phase, 'recovery-required')
  assert.equal(aborted, true)
  assert.equal(
    continuedWithStaleReview,
    false,
    'The old local review must be cancelled before further polling or completion'
  )
  assert.equal(fixture.requests.filter(({ op }) => op === 'reply').length, 0)
})

test('deadline stop reason survives a passed event cursor without converting recovery into a confirmed Stop', async (t) => {
  for (const phase of ['stopped', 'recovery-required']) {
    const fixture = await host(t, (request) =>
      normal(
        request,
        snapshot(phase, {
          job: { ...snapshot(phase).job, stopReason: 'request-expired' },
        })
      )
    )
    const input = makeInput(fixture.endpoint, { hostRun: resume(fixture.endpoint, 500) })
    await assert.rejects(
      createResidentHostDriver(fixture.endpoint).run(input.input),
      phase === 'stopped' ? /agent-cancelled/ : /host-recovery-required/
    )
    assert.equal(input.bindings.at(-1)?.phase, phase)
    assert.equal(input.bindings.at(-1)?.stopReason, 'request-expired')
    assert.equal(input.bindings.at(-1)?.cursor, 500)
    assert.equal(fixture.requests.filter(({ op }) => op === 'submit' || op === 'reply' || op === 'stop').length, 0)
  }
})

test('unknown host stop reasons fail before updates or terminal binding changes', async (t) => {
  const fixture = await host(t, (request) =>
    normal(
      request,
      snapshot('stopped', {
        job: { ...snapshot('stopped').job, stopReason: 'inferred-from-model-text' },
        events: [
          {
            seq: 1,
            type: 'worker-report',
            createdAt: 1,
            payload: { type: 'response', id: 'private', text: 'Must not import' },
          },
        ],
      })
    )
  )
  const input = makeInput(fixture.endpoint, { hostRun: resume(fixture.endpoint) })
  await assert.rejects(createResidentHostDriver(fixture.endpoint).run(input.input), /invalid-host-stop-reason/)
  assert.equal(input.bindings.at(-1)?.phase, 'running')
  assert.deepEqual(input.updates, [])
})

test('confirmed Stop receipt carries an actual deadline reason and rejects an unknown one', async (t) => {
  for (const reason of ['request-expired', 'invented']) {
    const fixture = await host(t, (request) =>
      request.op === 'stop' ? { ...snapshot('stopped').job, stopReason: reason } : snapshot('running')
    )
    const stopped = createResidentHostDriver(fixture.endpoint).stop(resume(fixture.endpoint))
    if (reason === 'request-expired')
      assert.deepEqual(await stopped, { phase: 'stopped', stopReason: 'request-expired' })
    else await assert.rejects(stopped, /invalid-host-stop-reason/)
  }
})

test('a newly observed deadline reason is reported before a failed Stop without confirming termination', async (t) => {
  const observed: string[] = []
  const fixture = await host(t, (request) => {
    if (request.op === 'stop') throw new Error('provider-stop-unreachable')
    return snapshot('recovery-required', {
      job: { ...snapshot('recovery-required').job, stopReason: 'request-expired' },
    })
  })
  const binding = resume(fixture.endpoint, 500)
  assert.equal(binding.stopReason, undefined)
  await assert.rejects(
    createResidentHostDriver(fixture.endpoint).stop(binding, (reason) => observed.push(reason)),
    /provider-stop-unreachable/
  )
  assert.deepEqual(observed, ['request-expired'])
  assert.equal(binding.phase, 'running', 'Observing a reason does not confirm termination')
  assert.deepEqual(
    fixture.requests.map(({ op }) => op),
    ['snapshot', 'stop']
  )
})
