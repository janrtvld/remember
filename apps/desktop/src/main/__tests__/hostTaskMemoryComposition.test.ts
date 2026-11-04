import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { WikiSpace } from '@remember/shared'
import { EvidenceStore } from '../dailyReview/evidenceStore'
import {
  createKnowledgePageAt,
  initializeKnowledgeStore,
  listKnowledgePagesAt,
  personalWikiDirectory,
  saveKnowledgePageAt,
} from '../dailyReview/knowledgeStore'
import { HostTaskActionService, type HostTaskMemoryExecutor } from '../hostTaskActionService'
import type { HostTaskPrepared } from '../hostTaskExecutionProtocol'
import { HostTaskMemoryAdapter } from '../hostTaskMemoryAdapter'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../hostTaskProtocol'
import type {
  HostTaskRequest,
  HostTaskRouterResult,
  HostTaskServiceTransport,
  HostTaskSnapshot,
} from '../hostTaskServiceTransport'
import { ResidentAgentStore } from '../residentAgentStore'
import { closeWikiHistoryStore } from '../wikiHistoryStore'

const hash = (v: unknown) => createHash('sha256').update(canonicalHostTaskJson(v)).digest('hex')
const copy = <T>(v: T): T => JSON.parse(canonicalHostTaskJson(v))
function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync('/private/tmp/e077-composition-')
  initializeKnowledgeStore(directory)
  const wiki = personalWikiDirectory()
  let resident = new ResidentAgentStore(join(directory, 'assistant.sqlite'), { now: () => 2000 })
  const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
  const target = { targetId: 'synthetic', targetEpoch: 'epoch-1', root: '/private/tmp/e077-unit-host' }
  let sourceState: 'valid' | 'unavailable' | 'invalidated' = 'valid'
  const calls: string[] = [],
    wires: unknown[] = [],
    observedRefs: unknown[] = []
  const prepareds = new Map<string, HostTaskPrepared>(),
    jobs = new Map<string, HostTaskSnapshot>()
  const initialRequests = new Map<string, HostTaskRequest[]>(),
    followups = new Map<string, HostTaskRequest[]>()
  let snapshots = 0,
    saves = 0,
    answers = 0,
    asks = 0,
    adapterDisposals = 0
  const answer: 'accept' | 'decline' = 'accept'
  let askHook: ((signal: AbortSignal) => Promise<'accept' | 'decline'>) | null = null
  let replyHook: (() => void) | null = null,
    stopHook: (() => boolean) | null = null
  let sourceHook: (() => void) | null = null
  let lastAskSignal: AbortSignal | null = null
  const space: WikiSpace = {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'book',
    color: 'slate',
    maintenanceMode: 'auto',
  }
  const result = (p: HostTaskPrepared): HostTaskRouterResult => {
    const snapshot = jobs.get(p.descriptor.assignment.jobId) ?? null
    const state = snapshot?.job?.phase ?? 'reserved'
    assert(
      state === 'reserved' || state === 'waiting' || state === 'running' || state === 'completed' || state === 'stopped'
    )
    return {
      descriptor: copy(p.descriptor),
      state,
      snapshot: snapshot ? copy(snapshot) : null,
    }
  }
  function event(snapshot: HostTaskSnapshot) {
    snapshot.events.push({
      seq: (snapshot.events.at(-1)?.seq ?? 0) + 1,
      type: 'client-attached',
      payload: {},
      createdAt: 1200,
    })
  }
  const transport: HostTaskServiceTransport = {
    async prepare(assignment) {
      calls.push('prepare')
      const p = prepareds.get(assignment.jobId)
      assert(p)
      return copy(p.descriptor)
    },
    async register(p) {
      calls.push('register')
      return copy(p.descriptor)
    },
    async submit(p, guard) {
      calls.push('submit')
      ;(await guard())()
      const id = p.descriptor.assignment.jobId
      jobs.set(id, {
        sessionId: `coordinator-${id}`,
        pid: 1,
        job: {
          id,
          inputHash: p.descriptor.inputHash,
          spec: { ...p.input, workspace: p.descriptor.workspace },
          phase: 'waiting',
          threadId: `thread-${id}`,
          turnId: `turn-${id}`,
          createdAt: 1000,
          updatedAt: 1100,
        },
        events: [
          {
            seq: 1,
            type: 'worker-report',
            payload: { id: 'progress', type: 'status', text: 'Synthetic progress' },
            createdAt: 1100,
          },
        ],
        requests: copy(initialRequests.get(id) ?? []),
        result: null,
      })
      return result(p)
    },
    async snapshot(p, afterSeq) {
      calls.push(`snapshot:${afterSeq}`)
      snapshots++
      const snap = jobs.get(p.descriptor.assignment.jobId)
      if (snap) event(snap)
      const r = result(p)
      if (r.snapshot) r.snapshot.events = r.snapshot.events.filter((e) => e.seq > afterSeq)
      return r
    },
    async reply(p, value, guard) {
      calls.push('reply')
      const final = await guard()
      const snap = jobs.get(p.descriptor.assignment.jobId)
      assert(snap?.job)
      assert.deepEqual(
        snap.requests.find((r) => r.id === value.requestId),
        value.expectedReview.request
      )
      final()
      answers++
      wires.push(copy(value.result))
      snap.requests = followups.get(snap.job.id) ?? []
      followups.delete(snap.job.id)
      if (!snap.requests.length) {
        snap.job.phase = 'completed'
        snap.job.updatedAt = 1300
        assert(snap.job.threadId)
        snap.result = { response: 'Host completed after tool', threadId: snap.job.threadId }
      }
      event(snap)
      replyHook?.()
      return result(p)
    },
    async stop(p) {
      calls.push('stop')
      const snap = jobs.get(p.descriptor.assignment.jobId)
      assert(snap?.job)
      if (stopHook?.() !== false && snap.job.phase !== 'completed') {
        snap.job.phase = 'stopped'
        snap.job.updatedAt = 1300
        snap.requests = []
        event(snap)
      }
      return result(p)
    },
    async cancelUnsubmitted(p) {
      calls.push('cancel')
      return {
        descriptor: copy(p.descriptor),
        state: 'cancelled-unsubmitted',
        snapshot: null,
        cancellation: { kind: 'unsubmitted', at: 2000 },
      }
    },
    dispose() {
      calls.push('transport-dispose')
    },
  }
  function taskRow(id: string) {
    const db = new DatabaseSync(join(directory, 'evidence.sqlite'), { readOnly: true })
    try {
      return { ...db.prepare('SELECT * FROM work_item WHERE id = ?').get(id) }
    } finally {
      db.close()
    }
  }
  const readContext = () => ({ target, policyFingerprint: 'policy-1' })
  const validateSources = async (refs: HostTaskEnvelopeV1['sources']) => {
    observedRefs.push(copy(refs))
    sourceHook?.()
    if (sourceState !== 'valid') return sourceState
    const pages = listKnowledgePagesAt(wiki)
    return refs.every((ref) => pages.some((p) => p.slug === ref.slug && p.revision === ref.revision))
      ? ('valid' as const)
      : ('invalidated' as const)
  }
  const adapters: HostTaskMemoryAdapter[] = [],
    services: HostTaskActionService[] = []
  function adapter(): HostTaskMemoryExecutor {
    const memory = new HostTaskMemoryAdapter({
      resident,
      evidence,
      transport,
      readContext,
      validateSources,
      personal: {
        space: () => copy(space),
        pages: () => listKnowledgePagesAt(wiki),
        pagePermitted: () => true,
        save: (input) => {
          saves++
          return saveKnowledgePageAt(wiki, input)
        },
      },
      ask: async (_review, signal) => {
        asks++
        lastAskSignal = signal
        return askHook ? askHook(signal) : answer
      },
      now: () => 2000,
    })
    adapters.push(memory)
    return {
      execute: (...args) => memory.execute(...args),
      reply: (...args) => memory.reply(...args),
      dispose() {
        adapterDisposals++
        calls.push('adapter-dispose')
        memory.dispose()
      },
    }
  }
  function service(memoryExecutor?: HostTaskMemoryExecutor) {
    const service = new HostTaskActionService({
      resident,
      evidence,
      transport,
      readContext,
      validateSources,
      now: () => 2000,
      ...(memoryExecutor ? { memoryExecutor } : {}),
    })
    services.push(service)
    return service
  }
  function input(id = 'A', action = 'read') {
    const item = evidence.createWorkItem(`Synthetic ${id}`, 'Do not complete this task')
    const page = createKnowledgePageAt(wiki, {
      spaceId: 'personal',
      category: 'documents',
      slug: `documents/${id.toLowerCase()}`,
      title: `Synthetic ${id}`,
      content: `Original ${id}.`,
    }).find((p) => p.slug === `documents/${id.toLowerCase()}`)
    assert(page?.revision)
    const jobId = `job-${id}`,
      directory = `${target.root}/jobs/${createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`
    const provider = {
      prompt: `Synthetic ${id}`,
      systemPrompt: 'No external effect',
      model: 'fake',
      effort: 'low' as const,
      threadId: null,
      tools: [{ name: 'remember_memory' as const, description: 'Synthetic', inputSchema: { type: 'object' } }],
    }
    const envelope: HostTaskEnvelopeV1 = {
      version: 1,
      actionId: `action-${id}`,
      workItemId: item.id,
      sessionId: `session-${id}`,
      jobId,
      userMessageId: `user-${id}`,
      assistantMessageId: `assistant-${id}`,
      provider: 'codex',
      instruction: `Explicit ${id}`,
      targetId: target.targetId,
      taskDefinition: hostTaskDefinition(item),
      policyFingerprint: 'policy-1',
      sources: [{ spaceId: 'personal', slug: page.slug, revision: page.revision, explicit: true }],
      startedAt: 1000,
      preparedInput: { ...provider, workspace: `${directory}/workspace` },
    }
    const providerInput = { ...provider, reviewTtlMs: 300000 }
    const prepared: HostTaskPrepared = {
      version: 1,
      input: providerInput,
      descriptor: {
        version: 2,
        ...target,
        assignment: {
          jobId,
          messageId: envelope.assistantMessageId,
          workItemId: item.id,
          sessionId: envelope.sessionId,
        },
        directory,
        workspace: envelope.preparedInput.workspace,
        inputHash: hash({ ...providerInput, workspace: envelope.preparedInput.workspace }),
      },
    }
    prepareds.set(jobId, prepared)
    const request = (kind: string, number = 1): HostTaskRequest => ({
      id: `request-${id}-${number}`,
      sessionId: `coordinator-${jobId}`,
      status: 'pending',
      method: 'client-tool',
      payload: {
        threadId: `thread-${jobId}`,
        turnId: `turn-${jobId}`,
        callId: `call-${id}-${number}`,
        tool: 'remember_memory',
        expiresAt: 9000,
        input:
          kind === 'read'
            ? { action: kind, spaceId: 'personal', slug: page.slug }
            : kind === 'patch'
              ? {
                  action: kind,
                  spaceId: 'personal',
                  slug: page.slug,
                  expectedRevision: page.revision,
                  before: page.content,
                  after: `Reviewed ${id}.`,
                  summary: 'Reviewed change',
                }
              : { action: kind, question: 'Synthetic approval?' },
      },
    })
    initialRequests.set(jobId, [request(action)])
    return { envelope, prepared, page, request, initialTask: taskRow(item.id) }
  }
  t.after(() => {
    for (const s of services) {
      try {
        s.dispose()
      } catch {}
    }
    for (const a of adapters) a.dispose()
    resident.close()
    evidence.close()
    closeWikiHistoryStore()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    evidence,
    taskRow,
    transport,
    calls,
    wires,
    observedRefs,
    input,
    service,
    adapter,
    jobs,
    initialRequests,
    followups,
    get resident() {
      return resident
    },
    get counts() {
      return { snapshots, saves, answers, asks, adapterDisposals }
    },
    get lastAskSignal() {
      return lastAskSignal
    },
    ask(fn: typeof askHook) {
      askHook = fn
    },
    replyHook(fn: typeof replyHook) {
      replyHook = fn
    },
    stopHook(fn: typeof stopHook) {
      stopHook = fn
    },
    sourceHook(fn: typeof sourceHook) {
      sourceHook = fn
    },
    sources(value: typeof sourceState) {
      sourceState = value
    },
    page(slug: string) {
      return listKnowledgePagesAt(wiki).find((p) => p.slug === slug)
    },
    reopen() {
      resident.close()
      resident = new ResidentAgentStore(join(directory, 'assistant.sqlite'), { now: () => 5000 })
    },
  }
}

test('opt-in absence retains synthetic qa_review and opt-in excludes its second review owner', async (t) => {
  const f = fixture(t),
    a = f.input('A', 'qa_review'),
    plain = f.service()
  assert.equal((await plain.start(a.envelope, a.prepared)).reviews.length, 1)
  await plain.stop(a.envelope.actionId)
  const b = f.input('B', 'qa_review'),
    enabled = f.service(f.adapter())
  const view = await enabled.start(b.envelope, b.prepared)
  assert.equal(view.reviews.length, 0)
  assert.equal(view.issue, 'host-task-effect-unsupported')
  assert.equal(f.counts.answers, 0)
})

test('committed exact waiting observation precedes one executor and same signal reply; successor waits for explicit resume', async (t) => {
  const f = fixture(t),
    a = f.input(),
    next = a.request('patch', 2)
  f.followups.set(a.envelope.jobId, [next])
  const memory = f.adapter()
  let executes = 0
  let signal: AbortSignal | undefined
  const service = f.service({
    async execute(id, request, abort) {
      executes++
      signal = abort
      const e = f.resident.hostTaskExecution(id)
      assert.equal(e?.state, 'waiting')
      assert.equal(e?.observation?.kind, 'host')
      assert.deepEqual(request, a.request('read'))
      assert.equal(e?.intent.envelope.assistantMessageId, a.envelope.assistantMessageId)
      return memory.execute(id, request, abort)
    },
    reply(id, token, abort) {
      assert.equal(abort, signal)
      return memory.reply(id, token, abort)
    },
    dispose() {
      memory.dispose()
    },
  })
  const view = await service.start(a.envelope, a.prepared)
  assert.equal(executes, 1)
  assert.equal(f.counts.answers, 1)
  assert.equal(f.counts.saves, 0)
  assert.equal(view.execution.state, 'waiting')
  assert.equal(view.execution.intent.outcome, null)
  assert.equal(view.reviews.length, 0)
  assert.equal(view.issue, undefined)
  assert.deepEqual(f.taskRow(a.envelope.workItemId), a.initialTask)
})

test('failed waiting observation transaction invokes zero executors', async (t) => {
  const f = fixture(t),
    a = f.input()
  let executions = 0
  const db = new DatabaseSync(join(f.directory, 'assistant.sqlite'))
  db.exec(
    "CREATE TRIGGER block_wait BEFORE UPDATE ON assistant_task_execution WHEN NEW.state='waiting' BEGIN SELECT RAISE(IGNORE); END"
  )
  const service = f.service({
    async execute() {
      executions++
      return { status: 'no-longer-pending' }
    },
    async reply() {
      throw Error('not called')
    },
    dispose() {},
  })
  await assert.rejects(service.start(a.envelope, a.prepared), /write-not-persisted/)
  assert.equal(executions, 0)
  db.close()
})

for (const variant of ['unsupported', 'multiple', 'wrong-session', 'expired', 'extra-input'])
  test(`candidate ${variant} has no memory execution or synthetic approval`, async (t) => {
    const f = fixture(t),
      a = f.input()
    let executions = 0
    const request = a.request('read')
    if (variant === 'unsupported') request.payload.input = { action: 'ensure', content: 'Forbidden' }
    if (variant === 'wrong-session') request.sessionId = 'other-session'
    if (variant === 'expired') request.payload.expiresAt = 2000
    if (variant === 'extra-input') request.payload.input = { ...(request.payload.input as object), extra: 'unknown' }
    f.initialRequests.set(a.envelope.jobId, variant === 'multiple' ? [request, a.request('patch', 2)] : [request])
    const service = f.service({
      async execute() {
        executions++
        return { status: 'no-longer-pending' }
      },
      async reply() {
        throw Error('not called')
      },
      dispose() {},
    })
    if (variant === 'wrong-session') {
      await assert.rejects(service.start(a.envelope, a.prepared), /host-task-transport-invalid/)
      assert.equal(executions, 0)
      return
    }
    const view = await service.start(a.envelope, a.prepared)
    assert.equal(executions, 0)
    assert.equal(view.reviews.length, 0)
    assert.equal(view.issue, 'host-task-effect-unsupported')
  })

test('real read then reviewed patch advances only A and fresh terminal authorization sees r2', async (t) => {
  const f = fixture(t),
    a = f.input(),
    b = f.input('B')
  f.resident.createPreparedHostTaskIntent(b.envelope, b.prepared)
  // B is only used as an isolation reference; durable unresolved admission is tested separately.
  f.resident.commitHostTaskObservation(b.envelope.actionId, {
    version: 1,
    kind: 'cancelled-unsubmitted',
    preparedHash: hash(b.prepared),
    cancellation: { kind: 'unsubmitted', at: 2000 },
  })
  f.resident.recordMemorySources(a.envelope.sources)
  f.followups.set(a.envelope.jobId, [a.request('patch', 2)])
  const service = f.service(f.adapter())
  await service.start(a.envelope, a.prepared)
  const view = await service.resume(a.envelope.actionId)
  assert.equal(f.counts.saves, 1)
  assert.equal(f.counts.asks, 1)
  assert.equal(f.counts.answers, 2)
  assert.equal(view.execution.intent.outcome?.response, 'Host completed after tool')
  const saved = f.page(a.page.slug)
  assert(saved?.revision)
  assert.notEqual(saved.revision, a.page.revision)
  assert.equal(saved.content, 'Reviewed A.')
  assert.equal(view.execution.sources[0]?.revision, saved.revision)
  assert.deepEqual(f.resident.hostTaskExecution(b.envelope.actionId)?.sources, b.envelope.sources)
  assert.deepEqual(f.resident.memorySources(), a.envelope.sources)
  assert.equal(f.resident.hostTaskResults(a.envelope.actionId).length, 1)
  assert.deepEqual(f.evidence.getWorkItem(a.envelope.workItemId)?.lifecycle, 'open')
  // A session/history changes legitimately, so compare the immutable human definition fields.
  const current = f.evidence.getWorkItem(a.envelope.workItemId)
  assert(current)
  assert.deepEqual(hostTaskDefinition(current), a.envelope.taskDefinition)
})

test('accepted reply ACK error drains once without reexecution and exposes stable issue', async (t) => {
  const f = fixture(t),
    a = f.input()
  let executions = 0
  const memory = f.adapter()
  f.replyHook(() => {
    throw Error('synthetic accepted reply ACK lost')
  })
  const service = f.service({
    execute(...args) {
      executions++
      return memory.execute(...args)
    },
    reply: (...args) => memory.reply(...args),
    dispose: () => memory.dispose(),
  })
  const view = await service.start(a.envelope, a.prepared)
  assert.equal(executions, 1)
  assert.equal(f.counts.answers, 1)
  assert.equal(view.execution.state, 'completed')
  assert.equal(view.issue, 'host-task-memory-request-failed')
  await service.resume(a.envelope.actionId)
  assert.equal(executions, 1)
  assert.equal(f.counts.answers, 1)
})

test('executor failure with unchanged pending request never loops or fabricates reply', async (t) => {
  const f = fixture(t),
    a = f.input('A', 'patch')
  let executes = 0
  const service = f.service({
    async execute() {
      executes++
      throw Error('memory-write-outcome-unknown-read-before-retrying')
    },
    async reply() {
      throw Error('not called')
    },
    dispose() {},
  })
  const view = await service.start(a.envelope, a.prepared)
  assert.equal(executes, 1)
  assert.equal(view.issue, 'host-task-memory-request-failed')
  assert.equal(view.execution.state, 'waiting')
  assert.equal(f.counts.answers, 0)
})

test('source unavailable after real save withholds completion and blocks B until explicit r2 release', async (t) => {
  const f = fixture(t),
    a = f.input('A', 'patch'),
    b = f.input('B'),
    service = f.service(f.adapter())
  f.replyHook(() => f.sources('unavailable'))
  const held = await service.start(a.envelope, a.prepared)
  assert.equal(f.counts.saves, 1)
  assert.equal(held.issue, 'host-task-context-unavailable')
  assert.equal(held.execution.state, 'completed')
  assert.equal(held.execution.intent.outcome, null)
  const received = held.execution.terminalReceivedAt
  await assert.rejects(service.start(b.envelope, b.prepared), /busy/)
  f.sources('valid')
  f.replyHook(null)
  const released = await service.resume(a.envelope.actionId)
  assert.equal(released.execution.terminalReceivedAt, received)
  assert.equal(released.execution.intent.outcome?.response, 'Host completed after tool')
  assert.equal(f.counts.saves, 1)
  assert.equal(f.counts.answers, 1)
  service.dispose()
  f.reopen()
  const reopened = f.service(f.adapter())
  const stored = await reopened.resume(a.envelope.actionId)
  assert.equal(stored.execution.terminalReceivedAt, received)
  assert.equal(f.counts.saves, 1)
})

for (const control of ['stop', 'dispose', 'invalidate'])
  test(`${control} aborts shared held review; late accept never writes or replies`, async (t) => {
    const f = fixture(t),
      a = f.input('A', 'patch'),
      entered = deferred<void>(),
      hold = deferred<'accept' | 'decline'>()
    f.ask(async (signal) => {
      assert(!signal.aborted)
      entered.resolve()
      return hold.promise
    })
    const service = f.service(f.adapter()),
      running = service.start(a.envelope, a.prepared)
    const error = running.then(
      () => null,
      (e) => e
    )
    await Promise.race([entered.promise, running])
    assert.equal(f.counts.asks, 1)
    if (control === 'stop') assert.equal((await service.stop(a.envelope.actionId)).execution.state, 'stopped')
    else if (control === 'dispose') service.dispose()
    else {
      const before = f.calls.length
      service.invalidate(a.envelope.actionId)
      assert.equal(f.resident.hostTaskExecution(a.envelope.actionId)?.intent.invalidated, true)
      assert.equal(f.calls.length, before)
    }
    assert.equal(f.lastAskSignal?.aborted, true)
    hold.resolve('accept')
    assert.match(String(await error), /cancelled|disposed/)
    assert.equal(f.counts.saves, 0)
    assert.equal(f.counts.answers, 0)
    const db = new DatabaseSync(join(f.directory, 'assistant.sqlite'), { readOnly: true })
    const rows = db.prepare('SELECT result_json FROM assistant_tool_call').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.result_json, null)
    db.close()
    if (control === 'dispose') {
      assert.equal(f.calls.filter((c) => c === 'stop').length, 0)
      assert(f.calls.indexOf('adapter-dispose') < f.calls.indexOf('transport-dispose'))
    }
  })

test('unconfirmed Stop readback never executes a valid pending request', async (t) => {
  const f = fixture(t),
    a = f.input(),
    service = f.service(f.adapter())
  f.followups.set(a.envelope.jobId, [a.request('patch', 2)])
  await service.start(a.envelope, a.prepared)
  f.stopHook(() => false)
  const view = await service.stop(a.envelope.actionId)
  assert.equal(view.execution.state, 'waiting')
  assert.equal(f.counts.saves, 0)
  assert.equal(f.counts.asks, 0)
  assert.equal(f.counts.answers, 1)
})

test('dispose still detaches transport when executor cleanup throws and does not retry cleanup', (t) => {
  const f = fixture(t),
    service = f.service({
      async execute() {
        return { status: 'no-longer-pending' }
      },
      async reply() {
        return { status: 'no-longer-pending' }
      },
      dispose() {
        f.calls.push('throwing-adapter-dispose')
        throw Error('cleanup-failed')
      },
    })
  assert.throws(() => service.dispose(), /cleanup-failed/)
  assert.deepEqual(f.calls, ['throwing-adapter-dispose', 'transport-dispose'])
  service.dispose()
  assert.equal(f.calls.length, 2)
})

test('invalidate missing/disposed refuses mutation; historical A invalidation cannot abort B', async (t) => {
  const f = fixture(t),
    a = f.input(),
    service = f.service(f.adapter())
  await assert.rejects(async () => service.invalidate('missing'), /execution-not-found/)
  await service.start(a.envelope, a.prepared)
  const b = f.input('B', 'patch'),
    entered = deferred<void>(),
    hold = deferred<'accept' | 'decline'>()
  f.ask(async () => {
    entered.resolve()
    return hold.promise
  })
  const running = service.start(b.envelope, b.prepared)
  await Promise.race([entered.promise, running])
  assert.equal(f.counts.asks, 1)
  service.invalidate(a.envelope.actionId)
  assert.equal(f.lastAskSignal?.aborted, false)
  assert.equal(f.resident.hostTaskExecution(b.envelope.actionId)?.intent.invalidated, false)
  hold.resolve('decline')
  await running
  service.dispose()
  assert.throws(() => service.invalidate(b.envelope.actionId), /disposed/)
})

test('failed durable invalidation still aborts held work and reports no persisted latch', async (t) => {
  const f = fixture(t),
    a = f.input('A', 'patch'),
    entered = deferred<void>(),
    hold = deferred<'accept' | 'decline'>()
  f.ask(async () => {
    entered.resolve()
    return hold.promise
  })
  const service = f.service(f.adapter()),
    running = service.start(a.envelope, a.prepared),
    error = running.then(
      () => null,
      (e) => e
    )
  await Promise.race([entered.promise, running])
  assert.equal(f.counts.asks, 1)
  const db = new DatabaseSync(join(f.directory, 'assistant.sqlite'))
  db.exec('CREATE TRIGGER block_latch BEFORE UPDATE ON assistant_task_run BEGIN SELECT RAISE(IGNORE); END')
  const before = f.calls.length
  assert.throws(() => service.invalidate(a.envelope.actionId), /write-not-persisted/)
  assert.equal(f.calls.length, before)
  assert.equal(f.resident.hostTaskExecution(a.envelope.actionId)?.intent.invalidated, false)
  assert.equal(f.lastAskSignal?.aborted, true)
  hold.resolve('accept')
  assert.match(String(await error), /cancelled/)
  assert.equal(f.counts.saves, 0)
  db.close()
})
