import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { EvidenceStore } from '../dailyReview/evidenceStore'
import { HostTaskActionService } from '../hostTaskActionService'
import type { HostTaskPrepared } from '../hostTaskExecutionProtocol'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../hostTaskProtocol'
import type {
  HostTaskGuard,
  HostTaskRouterResult,
  HostTaskServiceTransport,
  HostTaskSnapshot,
} from '../hostTaskServiceTransport'
import { ResidentAgentStore } from '../residentAgentStore'

const hash = (x: unknown) => createHash('sha256').update(canonicalHostTaskJson(x)).digest('hex')
const refs = [{ spaceId: 'personal', slug: 'synthetic', revision: 'r1', explicit: true }]
const target = { targetId: 'synthetic', targetEpoch: 'generation-1', root: '/private/tmp/e075-unit' }
function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
class FakeTransport implements HostTaskServiceTransport {
  calls: string[] = []
  submitted = 0
  answered = 0
  disposed = false
  lostSubmit = false
  loseRegister = false
  beforeFinal: (() => void) | null = null
  hook: (name: string) => Promise<void> = async () => {}
  snapshotValue: HostTaskSnapshot | null = null
  prepared: HostTaskPrepared | null = null
  state: HostTaskRouterResult['state'] = 'reserved'
  pages: HostTaskSnapshot[] | null = null
  async prepare(_assignment: HostTaskPrepared['descriptor']['assignment'], _input: HostTaskPrepared['input']) {
    this.calls.push('prepare')
    await this.hook('prepare')
    assert(this.prepared)
    return structuredClone(this.prepared.descriptor)
  }
  async register(p: HostTaskPrepared) {
    this.calls.push('register')
    await this.hook('register')
    if (this.loseRegister) throw Error('register-ack-lost')
    return structuredClone(p.descriptor)
  }
  result(p: HostTaskPrepared): HostTaskRouterResult {
    return {
      descriptor: structuredClone(p.descriptor),
      state: this.state,
      snapshot: structuredClone(this.snapshotValue),
    }
  }
  async snapshot(p: HostTaskPrepared, afterSeq: number) {
    this.calls.push(`snapshot:${afterSeq}`)
    await this.hook('snapshot')
    if (this.snapshotValue && !this.pages)
      this.snapshotValue.events.push({
        seq: (this.snapshotValue.events.at(-1)?.seq ?? 0) + 1,
        type: 'client-attached',
        payload: {},
        createdAt: 1100,
      })
    const result = this.result(p)
    if (this.pages)
      result.snapshot = structuredClone({
        ...this.pages[this.pages.length - 1],
        events: this.pages
          .flatMap((page) => page.events)
          .filter((event) => event.seq > afterSeq)
          .slice(0, 100),
      })
    else if (result.snapshot) result.snapshot.events = result.snapshot.events.filter((e) => e.seq > afterSeq)
    return result
  }
  async submit(p: HostTaskPrepared, guard: HostTaskGuard) {
    this.calls.push('submit')
    this.state = 'recovery-required'
    await this.hook('hello')
    await this.hook('pre-submit-snapshot')
    const final = await guard()
    this.beforeFinal?.()
    final()
    this.submitted++
    this.snapshotValue = makeSnapshot(p)
    this.state = 'waiting'
    if (this.lostSubmit) throw Error('submit-ack-lost')
    return this.result(p)
  }
  async reply(p: HostTaskPrepared, _reply: unknown, guard: HostTaskGuard) {
    this.calls.push('reply')
    await this.hook('reply-hello')
    const final = await guard()
    this.beforeFinal?.()
    final()
    this.answered++
    assert(this.snapshotValue)
    this.snapshotValue.requests = []
    this.snapshotValue.job!.phase = 'running'
    this.state = 'running'
    return this.result(p)
  }
  async stop(p: HostTaskPrepared) {
    this.calls.push('stop')
    await this.hook('stop')
    if (!this.snapshotValue) throw Error('router-start-unconfirmed')
    if (this.snapshotValue.job?.phase !== 'completed') {
      this.snapshotValue.job!.phase = 'stopped'
      this.snapshotValue.requests = []
      this.snapshotValue.events.push({
        seq: this.snapshotValue.events.length + 1,
        type: 'job-transition',
        payload: { phase: 'stopped' },
        createdAt: 1100,
      })
      this.state = 'stopped'
    }
    return this.result(p)
  }
  async cancelUnsubmitted(p: HostTaskPrepared): Promise<HostTaskRouterResult> {
    this.calls.push('cancel')
    if (this.state !== 'reserved') throw Error('router-cancel-not-unsubmitted')
    this.state = 'cancelled-unsubmitted'
    return { ...this.result(p), cancellation: { kind: 'unsubmitted', at: 1100 } }
  }
  dispose() {
    this.disposed = true
  }
}
function makeSnapshot(p: HostTaskPrepared): HostTaskSnapshot {
  return {
    sessionId: 'coordinator-1',
    pid: 123,
    job: {
      id: p.descriptor.assignment.jobId,
      inputHash: p.descriptor.inputHash,
      spec: { ...p.input, workspace: p.descriptor.workspace },
      phase: 'waiting',
      threadId: 'thread-1',
      turnId: 'turn-1',
      createdAt: 1000,
      updatedAt: 1100,
    },
    events: [
      {
        seq: 1,
        type: 'worker-report',
        payload: { id: 'step-1', type: 'status', text: 'Synthetic progress' },
        createdAt: 1050,
      },
    ],
    requests: [
      {
        id: 'request-1',
        sessionId: 'coordinator-1',
        status: 'pending',
        method: 'client-tool',
        payload: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'call-1',
          tool: 'remember_memory',
          input: { action: 'qa_review', question: 'Synthetic approval?' },
          expiresAt: 9000,
        },
      },
    ],
    result: null,
  }
}
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync('/private/tmp/e075-service-')
  let resident = new ResidentAgentStore(join(directory, 'assistant.sqlite'), { now: () => 2000 })
  const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
  const transport = new FakeTransport()
  let policyFingerprint = 'policy-1',
    targetValue = { ...target },
    sourceState: 'valid' | 'unavailable' | 'invalidated' = 'valid',
    now = 2000
  let sourceHook: ((signal?: AbortSignal) => Promise<void>) | null = null
  let sourceOverride: ((signal: AbortSignal) => Promise<'valid' | 'unavailable' | 'invalidated'>) | null = null
  let contextHook: (() => void) | null = null
  const services: HostTaskActionService[] = []
  function service() {
    const s = new HostTaskActionService({
      resident,
      evidence,
      transport,
      readContext: () => {
        contextHook?.()
        return { policyFingerprint, target: targetValue }
      },
      validateSources: (_refs, signal) =>
        sourceOverride ? sourceOverride(signal) : Promise.resolve(sourceHook?.(signal)).then(() => sourceState),
      now: () => now,
    })
    services.push(s)
    return s
  }
  t.after(() => {
    for (const service of services) service.dispose()
    resident.close()
    evidence.close()
    rmSync(directory, { recursive: true, force: true })
  })
  function input(id = 'A') {
    const item = evidence.createWorkItem(`Synthetic ${id}`, 'Do not complete the human Task')
    const directory = `${target.root}/jobs/${createHash('sha256').update(`job-${id}`).digest('hex').slice(0, 24)}`
    const provider = {
      prompt: `Synthetic ${id}`,
      systemPrompt: 'No real effects',
      model: 'fake',
      effort: 'low' as const,
      threadId: null,
      tools: [
        { name: 'remember_memory' as const, description: 'Synthetic review only', inputSchema: { type: 'object' } },
      ],
    }
    const envelope: HostTaskEnvelopeV1 = {
      version: 1,
      actionId: `action-${id}`,
      workItemId: item.id,
      sessionId: `session-${id}`,
      jobId: `job-${id}`,
      userMessageId: `user-${id}`,
      assistantMessageId: `assistant-${id}`,
      provider: 'codex',
      instruction: `Explicit ${id}`,
      targetId: target.targetId,
      taskDefinition: hostTaskDefinition(item),
      policyFingerprint: 'policy-1',
      sources: structuredClone(refs),
      startedAt: 1000,
      preparedInput: { ...provider, workspace: `${directory}/workspace` },
    }
    const input = { ...provider, reviewTtlMs: 300000 }
    const prepared: HostTaskPrepared = {
      version: 1,
      input,
      descriptor: {
        version: 2,
        ...target,
        assignment: {
          jobId: envelope.jobId,
          messageId: envelope.assistantMessageId,
          workItemId: item.id,
          sessionId: envelope.sessionId,
        },
        directory,
        workspace: envelope.preparedInput.workspace,
        inputHash: hash({ ...input, workspace: envelope.preparedInput.workspace }),
      },
    }
    transport.prepared = prepared
    return { envelope, prepared }
  }
  return {
    directory,
    evidence,
    transport,
    service,
    input,
    get resident() {
      return resident
    },
    policy(value: string) {
      policyFingerprint = value
    },
    target(value: typeof target) {
      targetValue = value
    },
    sources(value: typeof sourceState) {
      sourceState = value
    },
    validator(value: typeof sourceOverride) {
      sourceOverride = value
    },
    contextHook(value: typeof contextHook) {
      contextHook = value
    },
    sourceHook(value: typeof sourceHook) {
      sourceHook = value
    },
    time(value: number) {
      now = value
    },
    reopen() {
      resident.close()
      resident = new ResidentAgentStore(join(directory, 'assistant.sqlite'), { now: () => 2000 })
    },
  }
}

test('action-only invalidation and durable unresolved query never touch B or global memory', (t) => {
  const f = fixture(t),
    a = f.input(),
    b = f.input('B')
  f.resident.createPreparedHostTaskIntent(a.envelope, a.prepared)
  f.resident.createPreparedHostTaskIntent(b.envelope, b.prepared)
  f.resident.recordMemorySources(refs)
  assert.equal(f.resident.unresolvedHostTaskExecutions().length, 2)
  f.resident.invalidateHostTaskAction('action-A')
  assert.equal(f.resident.getHostTaskIntent('action-A')?.invalidated, true)
  assert.equal(f.resident.getHostTaskIntent('action-B')?.invalidated, false)
  assert.deepEqual(f.resident.memorySources(), refs)
  f.reopen()
  assert.equal(f.resident.unresolvedHostTaskExecutions().length, 2)
})
test('one slot is acquired before prepare await, and durable prepared work blocks a recreated service', async (t) => {
  const f = fixture(t),
    a = f.input(),
    b = f.input('B')
  f.transport.prepared = a.prepared
  const held = deferred()
  f.transport.hook = async (name) => {
    if (name === 'prepare') await held.promise
  }
  const s = f.service()
  const running = s.start(a.envelope, a.prepared)
  await assert.rejects(s.start(b.envelope, b.prepared), /busy/)
  held.resolve()
  await running
  assert.equal(f.transport.submitted, 1)
  s.dispose()
  f.reopen()
  const newer = f.service()
  await assert.rejects(newer.start(b.envelope, b.prepared), /busy/)
})
for (const stage of ['prepare', 'register', 'hello', 'pre-submit-snapshot', 'final'])
  test(`policy change during ${stage} blocks actual child submit`, async (t) => {
    const f = fixture(t),
      a = f.input(),
      s = f.service()
    if (stage === 'final') f.transport.beforeFinal = () => f.policy('changed')
    else
      f.transport.hook = async (name) => {
        if (name === stage) f.policy('changed')
      }
    await assert.rejects(s.start(a.envelope, a.prepared), /context-invalidated/)
    assert.equal(f.transport.submitted, 0)
    const e = f.resident.hostTaskExecution('action-A')
    if (['hello', 'pre-submit-snapshot', 'final'].includes(stage)) {
      assert.equal(e?.state, 'dispatch-intent')
      assert.equal(e?.cancellation, null)
    }
  })
test('Task definition and target changes are checked again after source awaits', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  f.sourceHook(async () => {
    f.evidence.updateWorkItem(a.envelope.workItemId, 'Changed human task', a.envelope.taskDefinition.description)
  })
  await assert.rejects(s.start(a.envelope, a.prepared), /context-invalidated/)
  assert.equal(f.transport.submitted, 0)
})
test('accepted lost submit ACK resumes exact job without another register or submit', async (t) => {
  const f = fixture(t),
    a = f.input()
  f.transport.lostSubmit = true
  const s = f.service()
  await assert.rejects(s.start(a.envelope, a.prepared), /ack-lost/)
  assert.equal(f.transport.submitted, 1)
  s.dispose()
  f.reopen()
  const next = f.service()
  const view = await next.resume('action-A')
  assert.equal(view.reviews.length, 1)
  assert.equal(f.transport.calls.filter((x) => x === 'submit').length, 1)
  assert.equal(f.transport.calls.filter((x) => x === 'register').length, 1)
})
test('prepared recovery never registers/submits and empty dispatch stays unresolved', async (t) => {
  const f = fixture(t),
    a = f.input(),
    b = f.input('B')
  f.resident.createPreparedHostTaskIntent(a.envelope, a.prepared)
  const s = f.service()
  await s.resume('action-A')
  assert.equal(f.transport.calls.length, 0)
  await assert.rejects(s.start(b.envelope, b.prepared), /busy/)
})
test('unavailable completion is withheld, source release rebuilds from zero and pins terminal time', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  const snap = f.transport.snapshotValue!
  snap.job!.phase = 'completed'
  snap.job!.updatedAt = 1200
  snap.requests = []
  snap.result = { response: 'Private final synthetic response', threadId: 'thread-1' }
  snap.events.push({
    seq: (snap.events.at(-1)?.seq ?? 0) + 1,
    type: 'worker-report',
    payload: { id: 'step-2', type: 'status', text: 'Final hidden step' },
    createdAt: 1150,
  })
  f.transport.state = 'completed'
  f.sources('unavailable')
  const held = await s.resume('action-A')
  assert.equal(held.execution.intent.outcome, null)
  assert.equal(held.execution.state, 'completed')
  assert(!JSON.stringify(held).includes('Private final synthetic response'))
  const at = held.execution.terminalReceivedAt
  f.sources('valid')
  const released = await s.resume('action-A')
  assert.equal(released.execution.intent.outcome?.response, snap.result.response)
  assert.equal(released.execution.intent.outcome?.steps.length, 2)
  assert.equal(released.execution.terminalReceivedAt, at)
  assert(f.transport.calls.filter((x) => x === 'snapshot:0').length >= 2)
  assert.equal(f.evidence.getWorkItem(a.envelope.workItemId)?.lifecycle, 'open')
})
test('invalidated context gates Stop returning completed and invalidates only this action', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  f.sources('invalidated')
  f.transport.hook = async (name) => {
    if (name === 'stop') {
      const snap = f.transport.snapshotValue!
      snap.job!.phase = 'completed'
      snap.result = { response: 'Forbidden late answer', threadId: 'thread-1' }
      snap.requests = []
      f.transport.state = 'completed'
    }
  }
  const view = await s.resume('action-A')
  assert.equal(view.execution.intent.invalidated, true)
  assert.equal(view.execution.state, 'completed')
  assert.equal(view.execution.intent.outcome, null)
  assert(!JSON.stringify(view).includes('Forbidden late answer'))
  assert.equal(f.transport.calls.filter((x) => x === 'stop').length, 1)
})
test('opaque reviews reject wrong IDs, expiry and session replacement; only explicit answer dispatches once', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  const initial = await s.start(a.envelope, a.prepared)
  const old = initial.reviews[0]
  assert(old)
  await assert.rejects(s.answer('action-A', 'wrong', { approved: true }), /review/)
  assert.equal(f.transport.answered, 0)
  f.transport.snapshotValue!.sessionId = 'coordinator-2'
  f.transport.snapshotValue!.requests[0].sessionId = 'coordinator-2'
  const changed = await s.resume('action-A')
  await assert.rejects(s.answer('action-A', old.id, { approved: true }), /review/)
  const fresh = changed.reviews[0]
  assert(fresh)
  f.time(9001)
  await assert.rejects(s.answer('action-A', fresh.id, { approved: true }), /review/)
  assert.equal(f.transport.answered, 0)
})
test('final reply guard rechecks policy after handshake and never answers on changed context', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service(),
    view = await s.start(a.envelope, a.prepared)
  f.transport.hook = async (name) => {
    if (name === 'reply-hello') f.policy('changed')
  }
  await assert.rejects(s.answer('action-A', view.reviews[0].id, { approved: true }), /context-invalidated/)
  assert.equal(f.transport.answered, 0)
})
test('unsupported real memory effect is refused without a handler or reply', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  f.transport.snapshotValue!.requests[0].payload.input = { action: 'ensure', content: 'Never write this' }
  const view = await s.resume('action-A')
  assert.equal(view.reviews.length, 0)
  assert.equal(view.issue, 'host-task-effect-unsupported')
  assert.equal(f.transport.answered, 0)
})
test('dispose during source await prevents later submit/publication and never stops accepted work', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service(),
    held = deferred()
  f.sourceHook(() => held.promise)
  const start = s.start(a.envelope, a.prepared)
  s.dispose()
  held.resolve()
  await assert.rejects(start, /disposed/)
  assert.equal(f.transport.submitted, 0)
  assert(!f.transport.calls.includes('stop'))
})

test('revocation latch survives same-fingerprint regrant while source validation waits', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  const held = deferred(),
    entered = deferred()
  f.sourceHook(async () => {
    entered.resolve()
    await held.promise
  })
  const resume = s.resume('action-A')
  await entered.promise
  f.policy('revoked')
  f.resident.invalidateHostTaskAction('action-A')
  f.policy('policy-1')
  held.resolve()
  const view = await resume
  assert.equal(view.execution.intent.invalidated, true)
  assert.equal(view.execution.state, 'stopped')
  assert.equal(f.transport.answered, 0)
})

test('Stop aborts an outstanding validator and reaches the exact transport before that validator settles', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  const held = deferred(),
    entered = deferred()
  let calls = 0
  f.sourceHook(async () => {
    if (++calls === 1) {
      entered.resolve()
      await held.promise
    }
  })
  const resume = s.resume('action-A')
  const cancelled = assert.rejects(resume, /operation-cancelled/)
  await entered.promise
  const stop = await s.stop('action-A')
  assert.equal(stop.execution.state, 'stopped')
  assert.equal(f.transport.calls.filter((x) => x === 'stop').length, 1)
  await cancelled
  held.resolve()
})

test('source projection changing during validation cannot authorize the old source snapshot', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  let once = true
  f.sourceHook(async () => {
    if (once) {
      once = false
      f.resident.recordTaskMemorySources('action-A', [{ ...refs[0], slug: 'new-reference' }])
    }
  })
  const view = await s.resume('action-A')
  assert.equal(view.issue, 'host-task-context-unavailable')
  assert.equal(view.reviews.length, 0)
  assert.equal(f.transport.answered, 0)
})

test('explicit answer resolves once; historical A controls cannot route to current B', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  const view = await s.start(a.envelope, a.prepared),
    handle = view.reviews[0]
  assert(handle)
  await s.answer('action-A', handle.id, { approved: false })
  assert.equal(f.transport.answered, 1)
  await assert.rejects(s.answer('action-A', handle.id, { approved: true }), /review/)
  await s.stop('action-A')
  const b = f.input('B')
  await s.start(b.envelope, b.prepared)
  const before = f.transport.calls.length
  await assert.rejects(s.stop('action-A'), /busy/)
  await assert.rejects(s.answer('action-A', handle.id, { approved: true }), /review/)
  assert.equal(f.transport.calls.length, before)
})

test('prepared invalidation rejects an ignored write without changing B', (t) => {
  const f = fixture(t),
    a = f.input(),
    b = f.input('B')
  f.resident.createPreparedHostTaskIntent(a.envelope, a.prepared)
  f.resident.createPreparedHostTaskIntent(b.envelope, b.prepared)
  const db = new DatabaseSync(join(f.directory, 'assistant.sqlite'))
  db.exec('CREATE TRIGGER block BEFORE UPDATE ON assistant_task_run BEGIN SELECT RAISE(IGNORE); END')
  assert.throws(() => f.resident.invalidateHostTaskAction('action-A'), /write-not-persisted/)
  assert.equal(f.resident.getHostTaskIntent('action-A')?.invalidated, false)
  assert.equal(f.resident.getHostTaskIntent('action-B')?.invalidated, false)
  db.close()
})

test('publication rechecks current policy in the synchronous commit seam after async validation resolves', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  const snap = f.transport.snapshotValue!
  snap.job!.phase = 'completed'
  snap.result = { response: 'Never import this after revoke', threadId: 'thread-1' }
  snap.requests = []
  f.transport.state = 'completed'
  let reads = 0
  f.contextHook(() => {
    if (++reads === 3) queueMicrotask(() => f.policy('revoked-after-validator'))
  })
  const view = await s.resume('action-A')
  assert.equal(view.execution.intent.outcome, null)
  assert.equal(view.execution.intent.invalidated, true)
  assert(!JSON.stringify(view).includes('Never import this after revoke'))
})

test('Stop result remains bounded when its new source validator never cooperates', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = deferred()
  f.sourceHook(async () => {
    entered.resolve()
    await new Promise<void>(() => {})
  })
  const stopping = s.stop('action-A')
  await entered.promise
  assert.equal(f.transport.calls.filter((x) => x === 'stop').length, 1)
  t.mock.timers.tick(10_000)
  const view = await stopping
  assert.equal(view.execution.state, 'stopped')
  assert.equal(view.execution.intent.outcome, null)
  assert.equal(view.issue, 'host-task-context-unavailable')
})

test('a paginated rebuild updates repeated report IDs without losing first timestamps or old reports', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  const snap = makeSnapshot(a.prepared)
  snap.job!.phase = 'completed'
  snap.job!.updatedAt = 1200
  snap.requests = []
  snap.result = { response: 'Paginated final', threadId: 'thread-1' }
  const events = Array.from({ length: 105 }, (_, i) => ({
    seq: i + 1,
    type: 'worker-report',
    payload: {
      id: i === 104 ? 'step-1' : `step-${i + 1}`,
      type: 'status',
      text: i === 104 ? 'Updated first report' : `Report ${i + 1}`,
    },
    createdAt: 1050 + i,
  }))
  f.transport.pages = [
    { ...snap, events: events.slice(0, 100) },
    { ...snap, events: events.slice(100) },
  ]
  f.transport.state = 'completed'
  f.sources('unavailable')
  await s.resume('action-A')
  f.sources('valid')
  const view = await s.resume('action-A')
  const steps = view.execution.intent.outcome?.steps
  assert(steps)
  assert.equal(steps.length, 104)
  assert.deepEqual(steps[0], { id: 'step-1', kind: 'status', text: 'Updated first report', at: 1050 })
  assert(f.transport.calls.includes('snapshot:100'))
  assert.equal(f.transport.submitted, 1)
})

test('Evidence projection ACK failure recovers metadata only without new execution or Task change', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  const before = f.evidence.getWorkItem(a.envelope.workItemId),
    snap = f.transport.snapshotValue!
  snap.job!.phase = 'completed'
  snap.requests = []
  snap.result = { response: 'Completed once', threadId: 'thread-1' }
  f.transport.state = 'completed'
  const db = new DatabaseSync(join(f.directory, 'assistant.sqlite'))
  db.exec(
    'CREATE TRIGGER block BEFORE UPDATE OF outcome_receipt_json ON assistant_task_run BEGIN SELECT RAISE(IGNORE); END'
  )
  await assert.rejects(s.resume('action-A'), /write-not-persisted/)
  assert.equal(f.resident.getHostTaskIntent('action-A')?.outcomeReceipt, null)
  assert.equal(f.resident.unresolvedHostTaskExecutions().length, 1)
  db.exec('DROP TRIGGER block')
  db.close()
  s.dispose()
  f.reopen()
  const calls = f.transport.calls.length
  const next = f.service(),
    view = await next.resume('action-A')
  assert(view.execution.intent.outcomeReceipt)
  assert.equal(f.transport.calls.length, calls)
  assert.equal(f.resident.unresolvedHostTaskExecutions().length, 0)
  const after = f.evidence.getWorkItem(a.envelope.workItemId)
  assert.equal(after?.title, before?.title)
  assert.equal(after?.status, before?.status)
  assert.equal(after?.lifecycle, before?.lifecycle)
  assert.equal(f.transport.submitted, 1)
})

test('an explicit answer is snapshotted before awaits and cannot be changed by the caller', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service(),
    view = await s.start(a.envelope, a.prepared)
  const entered = deferred(),
    held = deferred()
  f.transport.hook = async (name) => {
    if (name === 'snapshot') {
      entered.resolve()
      await held.promise
    }
  }
  let wire: unknown = null
  const original = f.transport.reply.bind(f.transport)
  f.transport.reply = async (p, reply, guard) => {
    wire = structuredClone(reply)
    return original(p, reply, guard)
  }
  const answer = { approved: false }
  const replying = s.answer('action-A', view.reviews[0].id, answer)
  await entered.promise
  answer.approved = true
  held.resolve()
  await replying
  assert.equal((wire as { result: { output: { approved: boolean } } } | null)?.result.output.approved, false)
})

test('explicit prepared Stop accepts only the exact missing-job result as local no-dispatch cancellation', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  f.resident.createPreparedHostTaskIntent(a.envelope, a.prepared)
  f.transport.cancelUnsubmitted = async () => {
    throw Error('router-job-missing')
  }
  const view = await s.stop('action-A')
  assert.equal(view.execution.state, 'cancelled-unsubmitted')
  assert.equal(view.execution.intent.outcome, null)
  assert.equal(f.resident.unresolvedHostTaskExecutions().length, 0)
  assert.equal(f.transport.submitted, 0)
})

test('prepared Stop network failure remains unresolved without a false tombstone', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  f.resident.createPreparedHostTaskIntent(a.envelope, a.prepared)
  f.transport.cancelUnsubmitted = async () => {
    throw Error('network-unavailable')
  }
  await assert.rejects(s.stop('action-A'), /network-unavailable/)
  assert.equal(f.resident.hostTaskExecution('action-A')?.state, 'prepared')
  assert.equal(f.resident.unresolvedHostTaskExecutions().length, 1)
})

test('a cooperative source validator abort at the deadline remains an unavailable result', async (t) => {
  const f = fixture(t),
    a = f.input(),
    s = f.service()
  await s.start(a.envelope, a.prepared)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = deferred()
  f.validator(
    (signal) =>
      new Promise((_, reject) => {
        entered.resolve()
        signal.addEventListener('abort', () => reject(Error('cooperative-abort-error')), { once: true })
      })
  )
  const stopped = s.stop('action-A')
  await entered.promise
  t.mock.timers.tick(10_000)
  const view = await stopped
  assert.equal(view.issue, 'host-task-context-unavailable')
  assert.equal(view.execution.intent.outcome, null)
})
