import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { SaveWikiPageInput, WikiPage, WikiSpace } from '@remember/shared'
import { EvidenceStore } from '../dailyReview/evidenceStore'
import {
  createKnowledgePageAt,
  initializeKnowledgeStore,
  listKnowledgePagesAt,
  personalWikiDirectory,
  saveKnowledgePageAt,
} from '../dailyReview/knowledgeStore'
import type { HostTaskPrepared } from '../hostTaskExecutionProtocol'
import {
  HostTaskMemoryAdapter,
  type HostTaskMemoryDependencies,
  type HostTaskMemoryReview,
} from '../hostTaskMemoryAdapter'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../hostTaskProtocol'
import type { HostTaskRequest, HostTaskRouterResult, HostTaskServiceTransport } from '../hostTaskServiceTransport'
import { ResidentAgentStore } from '../residentAgentStore'
import { closeWikiHistoryStore } from '../wikiHistoryStore'

const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const target = { targetId: 'synthetic', targetEpoch: 'epoch-1', root: '/private/tmp/e076-unit-host' }
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(t: { after(fn: () => void): void }, sharedSpace = false) {
  const profile = mkdtempSync('/private/tmp/e076-memory-')
  initializeKnowledgeStore(profile)
  const wikiDirectory = personalWikiDirectory()
  const foundPage = createKnowledgePageAt(wikiDirectory, {
    spaceId: 'personal',
    category: 'documents',
    slug: 'documents/a',
    title: 'Synthetic A',
    content: 'Original synthetic decision.',
  }).find((p) => p.slug === 'documents/a')
  assert(foundPage?.revision)
  const pageA = foundPage
  const initialRevision = foundPage.revision
  createKnowledgePageAt(wikiDirectory, {
    spaceId: 'personal',
    category: 'documents',
    slug: 'documents/private',
    title: 'Unselected',
    content: 'Do not forward this page.',
  })
  let resident = new ResidentAgentStore(join(profile, 'assistant.sqlite'))
  const evidence = new EvidenceStore(join(profile, 'evidence.sqlite'))
  const space: WikiSpace = {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'book',
    color: 'slate',
    maintenanceMode: 'auto',
  }
  let policy = 'policy-1',
    contextTarget = { ...target },
    now = 2000
  let sourceState: 'valid' | 'invalidated' | 'unavailable' = 'valid'
  let permitted = true,
    approval: 'accept' | 'decline' = 'accept',
    saves = 0,
    answers = 0,
    snapshots = 0
  let loseReply = false,
    absent = false
  let sourceHook: ((signal: AbortSignal) => Promise<void>) | null = null
  let askHook: ((review: Readonly<HostTaskMemoryReview>, signal: AbortSignal) => Promise<'accept' | 'decline'>) | null =
    null
  let saveHook: ((input: SaveWikiPageInput) => WikiPage[]) | null = null
  let replyHook: (() => void) | null = null
  let claimHook: (() => void) | null = null
  let snapshotHook: (() => Promise<void>) | null = null
  let permissionHook: (() => void) | null = null
  const reviews: Readonly<HostTaskMemoryReview>[] = []
  const wire: unknown[] = []
  const inputs = new Map<string, { envelope: HostTaskEnvelopeV1; prepared: HostTaskPrepared }>()
  function seed(id: string) {
    const item = evidence.createWorkItem(`Synthetic ${id}`, 'Human task remains unchanged')
    const directory = `${target.root}/jobs/${createHash('sha256').update(`job-${id}`).digest('hex').slice(0, 24)}`
    const provider = {
      prompt: `Synthetic ${id}`,
      systemPrompt: 'Synthetic local only',
      model: 'fake',
      effort: 'low' as const,
      threadId: null,
      tools: [{ name: 'remember_memory' as const, description: 'Synthetic memory', inputSchema: { type: 'object' } }],
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
      policyFingerprint: policy,
      sources: [{ spaceId: 'personal', slug: pageA.slug, revision: initialRevision, explicit: true }],
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
    resident.createPreparedHostTaskIntent(envelope, prepared)
    resident.acknowledgeHostTaskSession(envelope.actionId, evidence.acceptHostTaskSession(envelope))
    for (const state of ['registered', 'dispatch-intent'] as const)
      resident.commitHostTaskObservation(envelope.actionId, {
        version: 1,
        kind: 'admission',
        preparedHash: hash(prepared),
        state,
      })
    resident.commitHostTaskObservation(envelope.actionId, {
      version: 1,
      kind: 'host',
      preparedHash: hash(prepared),
      coordinatorSessionId: 'coordinator-1',
      cursor: 1,
      job: {
        jobId: envelope.jobId,
        inputHash: prepared.descriptor.inputHash,
        phase: 'waiting',
        threadId: `thread-${id}`,
        turnId: `turn-${id}`,
        createdAt: 1000,
        updatedAt: 1500,
        stopReason: null,
      },
      terminalResultHash: null,
      delivery: { kind: 'content', response: '', steps: [] },
    })
    inputs.set(envelope.actionId, { envelope, prepared })
    return envelope
  }
  const A = seed('A'),
    B = seed('B')
  resident.recordMemorySources([{ spaceId: 'personal', slug: pageA.slug, revision: initialRevision, explicit: false }])
  const initialTaskRows = JSON.stringify([evidence.getWorkItem(A.workItemId), evidence.getWorkItem(B.workItemId)])
  const patch = () => ({
    action: 'patch',
    spaceId: 'personal',
    slug: pageA.slug,
    expectedRevision: pageA.revision,
    before: 'Original synthetic decision.',
    after: 'Reviewed synthetic decision.',
    summary: 'Synthetic reviewed update',
  })
  let request: HostTaskRequest = {
    id: 'request-1',
    sessionId: 'coordinator-1',
    status: 'pending',
    method: 'client-tool',
    payload: {
      expiresAt: 9000,
      threadId: 'thread-A',
      turnId: 'turn-A',
      callId: 'call-1',
      tool: 'remember_memory',
      input: patch(),
    },
  }
  function result(prepared: HostTaskPrepared): HostTaskRouterResult {
    const id = prepared.descriptor.assignment.jobId.slice(4)
    return {
      descriptor: structuredClone(prepared.descriptor),
      state: 'waiting',
      snapshot: {
        sessionId: request.sessionId,
        pid: 1,
        job: {
          id: prepared.descriptor.assignment.jobId,
          inputHash: prepared.descriptor.inputHash,
          spec: { ...prepared.input, workspace: prepared.descriptor.workspace },
          phase: 'waiting',
          threadId: `thread-${id}`,
          turnId: `turn-${id}`,
          createdAt: 1000,
          updatedAt: 1500,
        },
        events: [],
        requests: absent ? [] : [structuredClone(request)],
        result: null,
      },
    }
  }
  const transport: Pick<HostTaskServiceTransport, 'snapshot' | 'reply'> = {
    async snapshot(prepared) {
      snapshots++
      await snapshotHook?.()
      return result(prepared)
    },
    async reply(prepared, value, guard) {
      const final = await guard()
      replyHook?.()
      assert(
        !absent && canonicalHostTaskJson(value.expectedReview.request) === canonicalHostTaskJson(request),
        'synthetic-current-request-mismatch'
      )
      assert.equal(value.expectedReview.threadId, request.payload.threadId)
      assert.equal(value.expectedReview.turnId, request.payload.turnId)
      final()
      answers++
      wire.push(structuredClone(value.result))
      absent = true
      if (loseReply) throw new Error('synthetic-accepted-reply-ack-lost')
      return result(prepared)
    },
  }
  const adapters: HostTaskMemoryAdapter[] = []
  function adapter() {
    const dependencies: HostTaskMemoryDependencies = {
      resident: {
        hostTaskExecution: (id) => resident.hostTaskExecution(id),
        claimToolCall: (...args) => {
          const value = resident.claimToolCall(...args)
          claimHook?.()
          return value
        },
        finishToolCall: (...args) => resident.finishToolCall(...args),
      },
      evidence,
      transport,
      readContext: () => ({ policyFingerprint: policy, target: contextTarget }),
      validateSources: async (_refs, abort) => {
        await sourceHook?.(abort)
        return sourceState
      },
      personal: {
        space: () => (sharedSpace ? space : structuredClone(space)),
        pages: () => listKnowledgePagesAt(wikiDirectory),
        save: (input) => {
          saves++
          return saveHook ? saveHook(input) : saveKnowledgePageAt(wikiDirectory, input)
        },
        pagePermitted: () => {
          permissionHook?.()
          return permitted
        },
      },
      ask: async (review, abort) => {
        reviews.push(structuredClone(review))
        return askHook ? askHook(review, abort) : approval
      },
      now: () => now,
    }
    const value = new HostTaskMemoryAdapter(dependencies)
    adapters.push(value)
    return value
  }
  function rows() {
    const db = new DatabaseSync(join(profile, 'assistant.sqlite'), { readOnly: true })
    try {
      return db.prepare('SELECT * FROM assistant_tool_call ORDER BY rowid').all()
    } finally {
      db.close()
    }
  }
  t.after(() => {
    adapters.forEach((a) => {
      a.dispose()
    })
    resident.close()
    evidence.close()
    closeWikiHistoryStore()
    rmSync(profile, { recursive: true, force: true })
  })
  return {
    A,
    B,
    profile,
    wikiDirectory,
    pageA,
    space,
    reviews,
    wire,
    adapter,
    patch,
    rows,
    get resident() {
      return resident
    },
    evidence,
    get request() {
      return request
    },
    setRequest(value: HostTaskRequest) {
      request = structuredClone(value)
    },
    get counts() {
      return { saves, answers, snapshots, reviews: reviews.length, claims: rows().length }
    },
    page() {
      const page = listKnowledgePagesAt(wikiDirectory).find((p) => p.slug === pageA.slug)
      assert(page)
      return page
    },
    readRequest() {
      request.payload.input = { action: 'read', spaceId: 'personal', slug: pageA.slug }
      return structuredClone(request)
    },
    policy(value: string) {
      policy = value
    },
    target(value: typeof target) {
      contextTarget = value
    },
    source(value: typeof sourceState) {
      sourceState = value
    },
    permission(value: boolean) {
      permitted = value
    },
    clock(value: number) {
      now = value
    },
    approve(value: typeof approval) {
      approval = value
    },
    onAsk(value: typeof askHook) {
      askHook = value
    },
    onSource(value: typeof sourceHook) {
      sourceHook = value
    },
    onSave(value: typeof saveHook) {
      saveHook = value
    },
    onReply(value: typeof replyHook) {
      replyHook = value
    },
    onClaim(value: typeof claimHook) {
      claimHook = value
    },
    onPermission(value: typeof permissionHook) {
      permissionHook = value
    },
    onSnapshot(value: typeof snapshotHook) {
      snapshotHook = value
    },
    loseAck() {
      loseReply = true
    },
    absent() {
      absent = true
    },
    reopen() {
      adapters.forEach((a) => {
        a.dispose()
      })
      resident.close()
      resident = new ResidentAgentStore(join(profile, 'assistant.sqlite'))
    },
    unchangedTasks() {
      assert.equal(
        JSON.stringify([evidence.getWorkItem(A.workItemId), evidence.getWorkItem(B.workItemId)]),
        initialTaskRows
      )
    },
  }
}
async function execute(f: ReturnType<typeof fixture>, adapter = f.adapter()) {
  const value = await adapter.execute(f.A.actionId, structuredClone(f.request), signal())
  assert.equal(value.status, 'ready')
  assert(value.status === 'ready')
  return { adapter, replyId: value.replyId }
}

test('selected A read has bounded source-linked output only at guarded reply and leaves every source/task unchanged', async (t) => {
  const f = fixture(t),
    a = f.adapter(),
    before = canonicalHostTaskJson([
      f.resident.hostTaskExecution(f.A.actionId),
      f.resident.hostTaskExecution(f.B.actionId),
      f.resident.memorySources(),
    ])
  const ready = await a.execute(f.A.actionId, f.readRequest(), signal())
  assert(ready.status === 'ready')
  assert.deepEqual(Object.keys(ready).sort(), ['replyId', 'status'])
  assert.deepEqual(await a.reply(f.A.actionId, ready.replyId, signal()), { status: 'replied' })
  const result = f.wire[0] as { success: boolean; output: Record<string, unknown> }
  assert.equal(result.success, true)
  assert.equal(result.output.content, f.pageA.content)
  assert.equal(result.output.revision, f.pageA.revision)
  assert.equal(result.output.slug, f.pageA.slug)
  assert(!JSON.stringify(result).includes('Do not forward'))
  assert.equal(
    canonicalHostTaskJson([
      f.resident.hostTaskExecution(f.A.actionId),
      f.resident.hostTaskExecution(f.B.actionId),
      f.resident.memorySources(),
    ]),
    before
  )
  assert.equal(f.counts.claims, 0)
  assert.equal(f.counts.saves, 0)
  f.unchangedTasks()
})
for (const status of ['invalidated', 'unavailable'] as const)
  test(`${status} source does not yield private read or reply`, async (t) => {
    const f = fixture(t)
    f.source(status)
    await assert.rejects(f.adapter().execute(f.A.actionId, f.readRequest(), signal()), /host-task-memory-/)
    assert.equal(f.counts.answers, 0)
    assert.equal(f.counts.saves, 0)
    assert.equal(f.counts.claims, 0)
  })
test('reviewed real patch saves once, atomically advances only A, and receipt survives reopen on its message', async (t) => {
  const f = fixture(t),
    beforeB = canonicalHostTaskJson(f.resident.hostTaskExecution(f.B.actionId)),
    beforeGlobal = canonicalHostTaskJson(f.resident.memorySources())
  const { adapter, replyId } = await execute(f)
  assert.equal(f.counts.saves, 1)
  assert.equal(f.reviews.length, 1)
  assert.equal(f.reviews[0]?.before, f.patch().before)
  assert.equal(f.reviews[0]?.after, f.patch().after)
  const page = f.page()
  assert.equal(page.content, 'Reviewed synthetic decision.')
  assert.notEqual(page.revision, f.pageA.revision)
  assert.equal(f.resident.hostTaskExecution(f.A.actionId)?.sources[0]?.revision, page.revision)
  assert.equal(f.resident.hostTaskExecution(f.A.actionId)?.intent.envelope.sources[0]?.revision, f.pageA.revision)
  assert.equal(canonicalHostTaskJson(f.resident.hostTaskExecution(f.B.actionId)), beforeB)
  assert.equal(canonicalHostTaskJson(f.resident.memorySources()), beforeGlobal)
  await adapter.reply(f.A.actionId, replyId, signal())
  f.reopen()
  assert.equal(f.resident.get(f.A.assistantMessageId)?.results?.[0]?.revision, page.revision)
  assert.deepEqual(f.resident.get(f.B.assistantMessageId)?.results, [])
  f.unchangedTasks()
})
test('decline is durable but never a saved result or effect', async (t) => {
  const f = fixture(t)
  f.approve('decline')
  const { adapter, replyId } = await execute(f)
  await adapter.reply(f.A.actionId, replyId, signal())
  assert.equal(f.counts.saves, 0)
  assert.equal(f.rows().length, 1)
  assert.deepEqual(JSON.parse(String(f.rows()[0]?.result_json)), { saved: false, reason: 'user-declined' })
  assert.deepEqual(f.resident.hostTaskResults(f.A.actionId), [])
  assert.equal(f.page().revision, f.pageA.revision)
})
test('Suggest and unsupported shapes fail before claims, reviews and real effects', async (t) => {
  const f = fixture(t),
    a = f.adapter()
  f.space.maintenanceMode = 'suggest'
  await assert.rejects(a.execute(f.A.actionId, f.request, signal()), /host-task-memory-/)
  f.space.maintenanceMode = 'auto'
  for (const input of [
    { action: 'ensure', spaceId: 'personal', title: 'No' },
    { ...f.patch(), extra: true },
    { ...f.patch(), after: undefined },
    { ...f.patch(), spaceId: 'other' },
    { action: 'search', spaceId: 'personal', query: 'No' },
  ]) {
    const req = { ...f.request, payload: { ...f.request.payload, input } }
    f.setRequest(req)
    await assert.rejects(a.execute(f.A.actionId, req, signal()), /host-task-/)
  }
  assert.equal(f.counts.claims, 0)
  assert.equal(f.counts.reviews, 0)
  assert.equal(f.counts.saves, 0)
})
for (const change of ['policy', 'target', 'task', 'source', 'mode', 'ttl', 'request', 'latch'] as const)
  test(`review-time ${change} change prevents save and reply`, async (t) => {
    const f = fixture(t)
    f.onAsk(async () => {
      if (change === 'policy') f.policy('policy-revoked')
      if (change === 'target') f.target({ ...target, targetEpoch: 'epoch-2' })
      if (change === 'task')
        f.evidence.updateWorkItem(f.A.workItemId, 'Changed human Task', 'Human task remains unchanged')
      if (change === 'source')
        saveKnowledgePageAt(f.wikiDirectory, {
          spaceId: 'personal',
          slug: f.pageA.slug,
          expectedRevision: f.pageA.revision,
          strictRevision: true,
          title: f.pageA.title,
          content: 'External newer source.',
        })
      if (change === 'mode') f.space.maintenanceMode = 'suggest'
      if (change === 'ttl') f.clock(9001)
      if (change === 'request') f.request.payload.input = { ...f.patch(), after: 'Unreviewed alternative' }
      if (change === 'latch') {
        f.policy('revoked')
        f.resident.invalidateHostTaskAction(f.A.actionId)
        f.policy('policy-1')
      }
      return 'accept'
    })
    await assert.rejects(execute(f), /host-task-memory-/)
    assert.equal(f.counts.saves, 0)
    assert.equal(f.counts.answers, 0)
    assert.equal(f.rows()[0]?.result_json, null)
  })
test('claim-before-effect interruption remains unknown after reopen, without another review or save', async (t) => {
  const f = fixture(t)
  f.onClaim(() => {
    throw new Error('synthetic-cut-after-claim')
  })
  await assert.rejects(execute(f), /synthetic-cut-after-claim/)
  assert.equal(f.rows()[0]?.result_json, null)
  f.onClaim(null)
  f.reopen()
  await assert.rejects(execute(f), /memory-write-outcome-unknown/)
  assert.equal(f.counts.claims, 1)
  assert.equal(f.counts.saves, 0)
  assert.equal(f.counts.reviews, 0)
})
test('actual save before receipt interruption retains changed file and NULL claim; reopen never reexecutes', async (t) => {
  const f = fixture(t)
  f.onSave((input) => {
    saveKnowledgePageAt(f.wikiDirectory, input)
    throw new Error('synthetic-cut-after-save')
  })
  await assert.rejects(execute(f), /memory-write-outcome-unknown/)
  assert.equal(f.page().content, 'Reviewed synthetic decision.')
  assert.equal(f.rows()[0]?.result_json, null)
  assert.equal(f.resident.hostTaskExecution(f.A.actionId)?.sources[0]?.revision, f.pageA.revision)
  f.onSave(null)
  f.reopen()
  await assert.rejects(execute(f), /memory-write-outcome-unknown|host-task-memory-source/)
  assert.equal(f.counts.saves, 1)
  assert.equal(f.counts.reviews, 1)
  assert.deepEqual(f.resident.hostTaskResults(f.A.actionId), [])
})
for (const mismatch of ['slug', 'revision', 'content', 'proposed'] as const)
  test(`unverified ${mismatch} return cannot manufacture saved receipt`, async (t) => {
    const f = fixture(t)
    f.onSave((input) => {
      const real = saveKnowledgePageAt(f.wikiDirectory, input)
      if (mismatch === 'proposed') return { proposed: true, id: 'fake-proposal' } as unknown as WikiPage[]
      return real.map((p) =>
        p.slug !== f.pageA.slug ? p : { ...p, [mismatch]: mismatch === 'revision' ? f.pageA.revision : 'incorrect' }
      )
    })
    await assert.rejects(execute(f), /memory-write-outcome-unknown/)
    assert.equal(f.counts.saves, 1)
    assert.equal(f.rows()[0]?.result_json, null)
    assert.deepEqual(f.resident.hostTaskResults(f.A.actionId), [])
    assert.equal(f.resident.hostTaskExecution(f.A.actionId)?.sources[0]?.revision, f.pageA.revision)
  })
test('verified receipt replay uses current r2 and original r1 request; no new save/review after reopen', async (t) => {
  const f = fixture(t)
  await execute(f)
  const oldReceipt = f.rows()[0]?.result_json
  f.reopen()
  const { adapter, replyId } = await execute(f)
  await adapter.reply(f.A.actionId, replyId, signal())
  assert.equal(f.counts.saves, 1)
  assert.equal(f.counts.reviews, 1)
  assert.equal(f.rows()[0]?.result_json, oldReceipt)
  f.unchangedTasks()
})
test('accepted resolved reply with lost ACK yields absent, never another reply or save', async (t) => {
  const f = fixture(t)
  const { adapter, replyId } = await execute(f)
  f.loseAck()
  await assert.rejects(adapter.reply(f.A.actionId, replyId, signal()), /synthetic-accepted-reply-ack-lost/)
  f.reopen()
  assert.deepEqual(await f.adapter().execute(f.A.actionId, f.request, signal()), { status: 'no-longer-pending' })
  assert.equal(f.counts.answers, 1)
  assert.equal(f.counts.saves, 1)
})
test('changed delivery session/TTL/payload shares stable claim identity and cannot repeat saved effect', async (t) => {
  const f = fixture(t)
  await execute(f)
  const first = structuredClone(f.request)
  for (const changed of [
    { ...first, id: 'request-2' },
    { ...first, sessionId: 'coordinator-2' },
    { ...first, payload: { ...first.payload, expiresAt: 9500 } },
    { ...first, payload: { ...first.payload, input: { ...f.patch(), after: 'Different' } } },
  ]) {
    f.setRequest(changed)
    await assert.rejects(
      f.adapter().execute(f.A.actionId, changed, signal()),
      /host-task-memory-|assistant-tool-call-mismatch/
    )
  }
  assert.equal(f.counts.saves, 1)
  assert.equal(f.counts.claims, 1)
  assert.equal(f.counts.reviews, 1)
})
test('SQL failure in receipt/source bridge rolls both back while actual Wiki effect remains uncertain', async (t) => {
  const f = fixture(t)
  const database = (f.resident as unknown as { database: DatabaseSync }).database
  database.exec(
    'CREATE TEMP TRIGGER prevent_source BEFORE UPDATE ON assistant_task_memory_source BEGIN SELECT RAISE(IGNORE); END'
  )
  await assert.rejects(execute(f), /memory-write-outcome-unknown/)
  assert.equal(f.counts.saves, 1)
  assert.equal(f.rows()[0]?.result_json, null)
  assert.equal(f.resident.hostTaskExecution(f.A.actionId)?.sources[0]?.revision, f.pageA.revision)
  database.exec('DROP TRIGGER prevent_source')
  f.reopen()
  await assert.rejects(execute(f), /memory-write-outcome-unknown|host-task-memory-source/)
  assert.equal(f.counts.saves, 1)
})
test('mutation after execute and final reply guard cannot change or send the reviewed result', async (t) => {
  const f = fixture(t),
    { adapter, replyId } = await execute(f)
  f.onReply(() => f.policy('revoked-at-send'))
  await assert.rejects(adapter.reply(f.A.actionId, replyId, signal()), /host-task-memory-/)
  assert.equal(f.counts.answers, 0)
  assert.equal(f.counts.saves, 1)
  await assert.rejects(adapter.reply(f.B.actionId, replyId, signal()), /host-task-memory-/)
})
test('caller input mutation during held snapshot never changes the captured command', async (t) => {
  const f = fixture(t),
    hold = deferred<void>(),
    a = f.adapter(),
    req = structuredClone(f.request)
  f.onSnapshot(() => hold.promise)
  const running = a.execute(f.A.actionId, req, signal())
  ;(req.payload.input as Record<string, unknown>).after = 'Caller mutated after await'
  hold.resolve()
  const ready = await running
  assert.equal(ready.status, 'ready')
  assert.equal(f.page().content, 'Reviewed synthetic decision.')
})
test('dispose while review awaits prevents save/reply even if review ignores abort and later accepts', async (t) => {
  const f = fixture(t),
    started = deferred<void>(),
    hold = deferred<'accept'>(),
    a = f.adapter()
  f.onAsk(async () => {
    started.resolve()
    return hold.promise
  })
  const running = a.execute(f.A.actionId, f.request, signal())
  await Promise.race([started.promise, running])
  a.dispose()
  hold.resolve('accept')
  await assert.rejects(running, /host-task-memory-/)
  assert.equal(f.counts.saves, 0)
  assert.equal(f.counts.answers, 0)
})
test('actual storage CRLF/trimming normalization is verified without accepting arbitrary altered content', async (t) => {
  const f = fixture(t)
  f.request.payload.input = { ...f.patch(), after: '  Reviewed\r\nsynthetic.  ' }
  await execute(f)
  assert.equal(f.page().content, 'Reviewed\nsynthetic.')
  assert.equal(f.resident.hostTaskResults(f.A.actionId).length, 1)
})

test('a read reply handle retains its own source snapshot after a later verified own patch', async (t) => {
  const f = fixture(t),
    a = f.adapter(),
    oldRequest = f.readRequest()
  const oldRead = await a.execute(f.A.actionId, oldRequest, signal())
  assert(oldRead.status === 'ready')
  f.setRequest({
    ...oldRequest,
    id: 'request-patch',
    payload: { ...oldRequest.payload, callId: 'call-patch', input: f.patch() },
  })
  await execute(f, a)
  f.setRequest(oldRequest)
  await assert.rejects(a.reply(f.A.actionId, oldRead.replyId, signal()), /host-task-memory-source-snapshot-changed/)
  assert.equal(f.counts.answers, 0)
  assert.equal(f.counts.saves, 1)
})
test('request changed during initial source await cannot create an obsolete claim or review', async (t) => {
  const f = fixture(t)
  f.onSource(async () => {
    f.request.payload.input = { ...f.patch(), after: 'New unreviewed command' }
  })
  await assert.rejects(execute(f), /host-task-memory-request-invalid/)
  assert.equal(f.counts.reviews, 0)
  assert.equal(f.counts.claims, 0)
  assert.equal(f.counts.saves, 0)
})
test('request changed during final effect source await is checked again before the synchronous writer', async (t) => {
  const f = fixture(t)
  let count = 0
  f.onSource(async () => {
    if (++count === 3) f.request.payload.input = { ...f.patch(), after: 'New command at effect boundary' }
  })
  await assert.rejects(execute(f), /host-task-memory-request-invalid/)
  assert.equal(f.counts.saves, 0)
  assert.equal(f.counts.answers, 0)
  assert.equal(f.rows()[0]?.result_json, null)
})

test('read publication cannot stamp old content with an own revision advanced during its final snapshot await', async (t) => {
  const f = fixture(t),
    a = f.adapter(),
    old = f.readRequest(),
    reached = deferred<void>(),
    hold = deferred<void>()
  let snapshots = 0
  f.onSnapshot(async () => {
    if (++snapshots === 3) {
      reached.resolve()
      await hold.promise
    }
  })
  const reading = a.execute(f.A.actionId, old, signal())
  await reached.promise
  f.setRequest({
    ...old,
    id: 'new-patch-request',
    payload: { ...old.payload, callId: 'new-patch-call', input: f.patch() },
  })
  await execute(f)
  f.setRequest(old)
  hold.resolve()
  await assert.rejects(reading, /host-task-memory-source-snapshot-changed/)
  assert.equal(f.counts.saves, 1)
  assert.equal(f.counts.answers, 0)
})

test('saved receipt publication pins its own r2 even if another verified call advances A to r3', async (t) => {
  const f = fixture(t),
    a = f.adapter(),
    old = structuredClone(f.request),
    reached = deferred<void>(),
    hold = deferred<void>()
  let held = false
  f.onSnapshot(async () => {
    if (!held && f.counts.saves === 1) {
      held = true
      reached.resolve()
      await hold.promise
    }
  })
  const saving = a.execute(f.A.actionId, old, signal())
  await reached.promise
  const r2 = f.page()
  f.setRequest({
    ...old,
    id: 'next-patch-request',
    payload: {
      ...old.payload,
      callId: 'next-patch-call',
      input: { ...f.patch(), expectedRevision: r2.revision, before: r2.content, after: 'Third revision' },
    },
  })
  await execute(f)
  f.setRequest(old)
  hold.resolve()
  await assert.rejects(saving, /host-task-memory-source-snapshot-changed/)
  assert.equal(f.counts.saves, 2)
  assert.equal(f.counts.answers, 0)
  assert.equal(f.resident.hostTaskResults(f.A.actionId).length, 2)
})

for (const sharedSpace of [false, true])
  test(`synchronous final permission mode change denies save (shared object: ${sharedSpace})`, async (t) => {
    const f = fixture(t, sharedSpace)
    let permissionCalls = 0
    f.onPermission(() => {
      if (++permissionCalls === 15) f.space.maintenanceMode = 'suggest'
    })
    const error = await execute(f).then(
      () => null,
      (error) => error
    )
    assert.equal(permissionCalls, 15)
    assert.equal(f.counts.saves, 0)
    assert.match(String(error), /host-task-memory-mode-changed/)
    assert.equal(f.page().revision, f.pageA.revision)
    assert.equal(f.rows()[0]?.result_json, null)
  })
