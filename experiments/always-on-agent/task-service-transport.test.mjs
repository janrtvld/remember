import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { test } from 'node:test'
import { openTaskServiceTransport } from './task-service-transport.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const directory = mkdtempSync('/private/tmp/e075-port-')
  const trace = []
  let job = null
  let requests = []
  let submitCount = 0
  let replyCount = 0
  const raw = openTaskServiceTransport({
    directory,
    targetId: 'local',
    targetEpoch: 'epoch-1',
    connectChild: async (descriptor) => {
      trace.push('connected')
      return {
        request(op, payload = {}) {
          trace.push(`wire:${op}`)
          if (op === 'hello')
            return Promise.resolve({
              protocol: 'remember-host-job-v1',
              singleJob: true,
              nativeClient: true,
              workspace: descriptor.workspace,
              jobId: job?.id ?? null,
              sessionId: 'coordinator-1',
            })
          if (op === 'snapshot')
            return Promise.resolve({ sessionId: 'coordinator-1', pid: 1, job, requests, events: [], result: null })
          if (op === 'submit') {
            submitCount++
            job = {
              id: payload.jobId,
              inputHash: descriptor.inputHash,
              spec: payload.spec,
              phase: 'waiting',
              threadId: 'thread-A',
              turnId: 'turn-A',
              createdAt: 100,
              updatedAt: 110,
            }
            return Promise.resolve({ created: true, job })
          }
          if (op === 'reply') {
            replyCount++
            const request = requests.find((entry) => entry.id === payload.requestId)
            requests = []
            return Promise.resolve({ ...request, status: 'resolved', result: payload.result })
          }
          if (op === 'stop') {
            job = { ...job, phase: 'stopped' }
            requests = []
            return Promise.resolve(job)
          }
          throw Error('unsupported-fake-op')
        },
        async close() {
          trace.push('closed')
        },
      }
    },
  })
  t.after(async () => {
    await raw.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const assignment = { jobId: 'job-A', messageId: 'assistant-A', workItemId: 'task-A', sessionId: 'session-A' }
  const input = {
    prompt: 'Synthetic',
    systemPrompt: 'Synthetic',
    model: 'fake-model',
    effort: 'low',
    threadId: null,
    tools: [],
    reviewTtlMs: 300000,
  }
  const descriptor = await raw.request(JSON.stringify({ op: 'prepare', assignment, input }))
  const prepared = { version: 1, descriptor, input }
  await raw.request(JSON.stringify({ op: 'register', assignment, input, prepared: descriptor }))
  return {
    raw,
    prepared,
    assignment,
    trace,
    submit: (guard) => raw.request(JSON.stringify({ op: 'submit', assignment }), { prepared, guard }),
    get submitCount() {
      return submitCount
    },
    get replyCount() {
      return replyCount
    },
    review(question = 'Synthetic?') {
      requests = [
        {
          id: 'review-A',
          sessionId: 'coordinator-1',
          status: 'pending',
          method: 'client-tool',
          payload: {
            tool: 'remember_memory',
            input: { action: 'qa_review', question },
            threadId: 'thread-A',
            turnId: 'turn-A',
            callId: 'call-A',
            expiresAt: Date.now() + 300000,
          },
        },
      ]
      return structuredClone(requests[0])
    },
  }
}

test('submit guard is after real router hello/snapshot and finalizer immediately precedes synchronous request write', async (t) => {
  const f = await fixture(t)
  await f.submit(async () => {
    assert.deepEqual(f.trace.slice(0, 3), ['connected', 'wire:hello', 'wire:snapshot'])
    f.trace.push('guard')
    await Promise.resolve()
    return () => {
      f.trace.push('finalize')
      queueMicrotask(() => f.trace.push('later-microtask'))
    }
  })
  assert.equal(f.submitCount, 1)
  assert(f.trace.indexOf('wire:submit') === f.trace.indexOf('finalize') + 1)
  assert(f.trace.indexOf('wire:submit') < f.trace.indexOf('later-microtask'))
})

test('finalizer rejects changes after async validation with no submit and no false unused cancellation', async (t) => {
  const f = await fixture(t)
  let valid = true
  await assert.rejects(
    f.submit(async () => {
      queueMicrotask(() => {
        valid = false
      })
      return () => {
        if (!valid) throw Error('context-changed')
      }
    }),
    /context-changed/
  )
  assert.equal(f.submitCount, 0)
  await assert.rejects(
    f.raw.request(
      JSON.stringify({ op: 'cancel-unsubmitted', assignment: f.assignment, inputHash: f.prepared.descriptor.inputHash })
    ),
    /router-cancel-not-unsubmitted/
  )
})

test('queued operations cannot replace a held operation guard, and replay submit never runs a new guard', async (t) => {
  const f = await fixture(t)
  const gate = deferred()
  const entered = deferred()
  let second = 0
  const first = f.submit(async () => {
    entered.resolve()
    await gate.promise
    return () => f.trace.push('first-final')
  })
  await entered.promise
  const replay = f.submit(async () => {
    second++
    return () => {}
  })
  gate.resolve()
  await first
  await replay
  assert.equal(f.submitCount, 1)
  assert.equal(second, 0)
  assert.equal(f.trace.filter((entry) => entry === 'first-final').length, 1)
})

test('missing/wrong binding refuses a guarded operation before child effects; caller mutation cannot retarget it', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.raw.request(JSON.stringify({ op: 'submit', assignment: f.assignment })),
    /transport-guard-required/
  )
  await assert.rejects(
    f.raw.request(JSON.stringify({ op: 'submit', assignment: f.assignment }), {
      prepared: {
        ...f.prepared,
        descriptor: { ...f.prepared.descriptor, assignment: { ...f.assignment, jobId: 'other' } },
      },
      guard: async () => () => {},
    }),
    /transport-binding-mismatch/
  )
  const prepared = structuredClone(f.prepared)
  const pending = f.raw.request(JSON.stringify({ op: 'submit', assignment: f.assignment }), {
    prepared,
    guard: async () => () => {},
  })
  prepared.descriptor.workspace = '/wrong'
  await pending
  assert.equal(f.submitCount, 1)
})

test('dispose while async guard is pending prevents final invocation and never stops accepted work', async (t) => {
  const f = await fixture(t)
  const gate = deferred()
  const entered = deferred()
  const pending = f.submit(async () => {
    entered.resolve()
    await gate.promise
    return () => f.trace.push('finalize')
  })
  await entered.promise
  f.raw.dispose()
  gate.resolve()
  await assert.rejects(pending, /transport-disposed/)
  assert.equal(f.submitCount, 0)
  assert(!f.trace.includes('wire:stop'))
  assert(!f.trace.includes('finalize'))
})

test('reply has its own exact bound one-shot final seam after current router review validation', async (t) => {
  const f = await fixture(t)
  await f.submit(async () => () => {})
  const expectedReview = { request: f.review(), threadId: 'thread-A', turnId: 'turn-A' }
  f.trace.length = 0
  const request = {
    op: 'reply',
    assignment: f.assignment,
    requestId: 'review-A',
    sessionId: 'coordinator-1',
    result: { success: true, output: { approved: true } },
  }
  await f.raw.request(JSON.stringify(request), {
    prepared: f.prepared,
    expectedReview,
    guard: async () => () => f.trace.push('reply-final'),
  })
  assert.equal(f.replyCount, 1)
  assert.equal(f.trace[f.trace.indexOf('reply-final') + 1], 'wire:reply')
  await assert.rejects(
    f.raw.request(JSON.stringify(request), { prepared: f.prepared, expectedReview, guard: async () => () => {} }),
    /router-review-invalid/
  )
  assert.equal(f.replyCount, 1)
})

test('same review ID/session with a changed current question cannot consume an earlier answer', async (t) => {
  const f = await fixture(t)
  await f.submit(async () => () => {})
  const request = f.review('Original question?')
  f.review('Changed question?')
  await assert.rejects(
    f.raw.request(
      JSON.stringify({
        op: 'reply',
        assignment: f.assignment,
        requestId: request.id,
        sessionId: request.sessionId,
        result: { success: true, output: { approved: true } },
      }),
      {
        prepared: f.prepared,
        expectedReview: { request, threadId: 'thread-A', turnId: 'turn-A' },
        guard: async () => () => {},
      }
    ),
    /transport-review-mismatch/
  )
  assert.equal(f.replyCount, 0)
})
