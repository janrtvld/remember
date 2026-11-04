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
import type { HostTaskPrepared } from '../hostTaskExecutionProtocol'
import { canonicalHostTaskJson } from '../hostTaskProtocol'
import {
  createHostTaskRuntime,
  type HostTaskRuntimeDependencies,
  validateHostTaskRuntimeManifest,
} from '../hostTaskRuntime'
import type {
  HostTaskRequest,
  HostTaskRouterResult,
  HostTaskServiceTransport,
  HostTaskSnapshot,
} from '../hostTaskServiceTransport'
import { ResidentAgentStore } from '../residentAgentStore'
import { closeWikiHistoryStore } from '../wikiHistoryStore'

const copy = <T>(value: T): T => structuredClone(value)
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const root = '/private/tmp/e078-unit-host'
const manifest = () => ({
  version: 1 as const,
  targetId: 'target',
  targetEpoch: 'epoch',
  root,
  source: { spaceId: 'personal' as const, slug: 'documents/owned' },
  computerExecutionKey: 'remote-config',
  slots: ['job-a', 'job-b'].map((jobId, index) => {
    const directory = `${root}/jobs/${createHash('sha256').update(jobId).digest('hex').slice(0, 24)}`
    return { jobId, directory, workspace: `${directory}/workspace`, endpoint: `tcp://127.0.0.1:${48001 + index}` }
  }),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert(predicate(), 'condition must settle')
}
function fixture(t: { after(fn: () => void): void }, interval = 0) {
  const directory = mkdtempSync('/private/tmp/e078-unit-')
  initializeKnowledgeStore(directory)
  const wiki = personalWikiDirectory()
  const resident = new ResidentAgentStore(join(directory, 'assistant.sqlite'))
  const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
  const space: WikiSpace = {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'book',
    color: 'slate',
    maintenanceMode: 'auto',
  }
  createKnowledgePageAt(wiki, {
    spaceId: 'personal',
    slug: 'documents/owned',
    category: 'documents',
    title: 'Owned',
    content: 'Original.',
  })
  const item = evidence.createWorkItem('Synthetic task', 'Update the selected source')
  let contextError = false
  let policy = 'policy-1',
    mode: 'valid' | 'unavailable' | 'invalidated' = 'valid',
    permitted = true
  let asks = 0,
    saves = 0,
    replies = 0,
    submits = 0,
    stops = 0,
    prepares = 0,
    disposals = 0
  const asksGate = deferred<'accept' | 'decline'>()
  let askSignal: AbortSignal | undefined
  const prepareds = new Map<string, HostTaskPrepared>(),
    jobs = new Map<string, HostTaskSnapshot>()
  let action: 'read' | 'patch' = 'patch',
    lostReply = false,
    followup = false,
    stopCompletes = false,
    stopExpired = false
  let afterReply: (() => void) | null = null,
    registerGate: Promise<void> | null = null
  let submitGate: Promise<void> | null = null
  const result = (p: HostTaskPrepared): HostTaskRouterResult => {
    const snapshot = jobs.get(p.descriptor.assignment.jobId) ?? null
    const state = snapshot?.job?.phase ?? 'reserved'
    assert(
      state === 'reserved' || state === 'waiting' || state === 'running' || state === 'completed' || state === 'stopped'
    )
    return { descriptor: copy(p.descriptor), state, snapshot: copy(snapshot) }
  }
  const transport: HostTaskServiceTransport = {
    async prepare(assignment, input) {
      prepares++
      const slot = manifest().slots.find((s) => s.jobId === assignment.jobId)
      assert(slot)
      const p: HostTaskPrepared = {
        version: 1,
        input: copy(input),
        descriptor: {
          version: 2,
          targetId: 'target',
          targetEpoch: 'epoch',
          root,
          assignment: copy(assignment),
          directory: slot.directory,
          workspace: slot.workspace,
          inputHash: hash({ ...input, workspace: slot.workspace }),
        },
      }
      prepareds.set(assignment.jobId, p)
      return copy(p.descriptor)
    },
    async register(p) {
      if (registerGate) await registerGate
      return copy(p.descriptor)
    },
    async submit(p, guard) {
      ;(await guard())()
      submits++
      if (submitGate) await submitGate
      const jobId = p.descriptor.assignment.jobId,
        page = listKnowledgePagesAt(wiki).find((p) => p.slug === 'documents/owned')
      assert(page?.revision)
      const request: HostTaskRequest = {
        id: `request-${jobId}`,
        sessionId: `coordinator-${jobId}`,
        status: 'pending',
        method: 'client-tool',
        payload: {
          expiresAt: Date.now() + 300000,
          threadId: `thread-${jobId}`,
          turnId: `turn-${jobId}`,
          callId: `call-${jobId}`,
          tool: 'remember_memory',
          input:
            action === 'read'
              ? { action: 'read', spaceId: 'personal', slug: page.slug }
              : {
                  action: 'patch',
                  spaceId: 'personal',
                  slug: page.slug,
                  expectedRevision: page.revision,
                  before: 'Original.',
                  after: 'Updated.',
                  summary: 'Synthetic update',
                },
        },
      }
      jobs.set(jobId, {
        sessionId: request.sessionId,
        pid: 1,
        job: {
          id: jobId,
          inputHash: p.descriptor.inputHash,
          spec: { ...p.input, workspace: p.descriptor.workspace },
          phase: 'waiting',
          threadId: request.payload.threadId!,
          turnId: request.payload.turnId!,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        events: [],
        requests: [request],
        result: null,
      })
      return result(p)
    },
    async snapshot(p, afterSeq) {
      const s = jobs.get(p.descriptor.assignment.jobId)
      if (s)
        s.events.push({
          seq: (s.events.at(-1)?.seq ?? 0) + 1,
          type: 'client-attached',
          payload: {},
          createdAt: Date.now(),
        })
      const r = result(p)
      if (r.snapshot) r.snapshot.events = r.snapshot.events.filter((e) => e.seq > afterSeq)
      return r
    },
    async reply(p, _input, guard) {
      ;(await guard())()
      replies++
      const s = jobs.get(p.descriptor.assignment.jobId)
      assert(s?.job)
      if (followup && replies === 1) {
        const page = listKnowledgePagesAt(wiki).find((p) => p.slug === 'documents/owned')
        assert(page?.revision)
        const old = s.requests[0]
        assert(old)
        s.requests = [
          {
            ...old,
            id: 'request-patch',
            payload: {
              ...old.payload,
              callId: 'call-patch',
              input: {
                action: 'patch',
                spaceId: 'personal',
                slug: page.slug,
                expectedRevision: page.revision,
                before: 'Original.',
                after: 'Updated.',
                summary: 'Update',
              },
            },
          },
        ]
      } else {
        s.requests = []
        s.job.phase = 'completed'
        s.job.updatedAt = Date.now()
        s.result = { response: 'Verified result.', threadId: s.job.threadId! }
      }
      afterReply?.()
      if (lostReply) throw new Error('synthetic-lost-ack')
      return result(p)
    },
    async stop(p) {
      stops++
      const s = jobs.get(p.descriptor.assignment.jobId)
      if (s?.job) {
        s.job.phase = stopCompletes ? 'completed' : 'stopped'
        if (stopExpired) s.job.stopReason = 'request-expired'
        s.job.updatedAt = Date.now()
        s.requests = []
        if (stopCompletes) s.result = { response: 'Private late response.', threadId: s.job.threadId! }
      }
      return result(p)
    },
    async cancelUnsubmitted(p) {
      return {
        descriptor: copy(p.descriptor),
        state: 'cancelled-unsubmitted',
        snapshot: null,
        cancellation: { kind: 'unsubmitted', at: Date.now() },
      }
    },
    dispose() {
      disposals++
    },
  }
  const deps: HostTaskRuntimeDependencies = {
    resident,
    evidence,
    transport,
    manifest: manifest(),
    pollIntervalMs: interval,
    readContext: () => {
      if (contextError) throw new Error('cloud-analysis-consent-required')
      return { policyFingerprint: policy, target: { targetId: 'target', targetEpoch: 'epoch', root } }
    },
    validateSources: async (refs) =>
      mode === 'valid'
        ? refs.every((ref) =>
            listKnowledgePagesAt(wiki).some((p) => p.slug === ref.slug && p.revision === ref.revision)
          )
          ? 'valid'
          : 'invalidated'
        : mode,
    taskPermitted: () => permitted,
    personal: {
      space: () => copy(space),
      pages: () => listKnowledgePagesAt(wiki),
      pagePermitted: () => true,
      save(input) {
        saves++
        return saveKnowledgePageAt(wiki, input)
      },
    },
    ask: async (_review, signal) => {
      asks++
      askSignal = signal
      return asksGate.promise
    },
    providerInput: ({ instruction }) => ({
      prompt: instruction,
      systemPrompt: 'Synthetic local proof',
      model: 'fake',
      effort: 'low',
      threadId: null,
      reviewTtlMs: 300000,
      tools: [{ name: 'remember_memory', description: 'Synthetic read/patch', inputSchema: { type: 'object' } }],
    }),
    changed() {},
  }
  let runtime = createHostTaskRuntime(deps)
  t.after(() => {
    runtime.dispose()
    resident.close()
    evidence.close()
    closeWikiHistoryStore()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    deps,
    resident,
    evidence,
    item,
    space,
    jobs,
    asksGate,
    get runtime() {
      return runtime
    },
    reopen() {
      runtime.dispose()
      runtime = createHostTaskRuntime(deps)
      return runtime
    },
    stats: () => ({ asks, saves, replies, submits, stops, prepares, disposals }),
    get signal() {
      return askSignal
    },
    denyContext() {
      contextError = true
    },
    setPolicy(v: string) {
      policy = v
    },
    setMode(v: typeof mode) {
      mode = v
    },
    setPermitted(v: boolean) {
      permitted = v
    },
    setAction(v: typeof action) {
      action = v
    },
    setStopExpired() {
      stopExpired = true
    },
    setStopCompletes() {
      stopCompletes = true
    },
    setLostReply() {
      lostReply = true
    },
    setFollowup() {
      followup = true
    },
    afterReply(fn: () => void) {
      afterReply = fn
    },
    setRegisterGate(p: Promise<void>) {
      registerGate = p
    },
    setSubmitGate(p: Promise<void>) {
      submitGate = p
    },
  }
}

test('manifest is detached and rejects aliases, target paths, duplicate slots and extra fields', () => {
  const m = manifest(),
    validated = validateHostTaskRuntimeManifest(m)
  assert.deepEqual(validated, m)
  m.slots[0].workspace = 'changed'
  assert.notEqual(validated.slots[0].workspace, 'changed')
  for (const bad of [
    { ...manifest(), extra: true },
    { ...manifest(), slots: [manifest().slots[0], manifest().slots[0]] },
    { ...manifest(), slots: manifest().slots.map((s) => ({ ...s, endpoint: 'tcp://localhost:1234' })) },
    { ...manifest(), root: '/private/tmp/../escape' },
  ])
    assert.throws(() => validateHostTaskRuntimeManifest(bad), /manifest-invalid/)
})
test('draft has no execution effects and policy/source/mode changes deny sending', async (t) => {
  const f = fixture(t),
    draft = f.runtime.draft(f.item.id)
  assert.equal(draft.source.slug, 'documents/owned')
  assert.equal(f.resident.conversation(null).messages.length, 0)
  assert.equal(f.stats().prepares, 0)
  f.setPolicy('policy-2')
  await assert.rejects(f.runtime.send({ token: draft.token, text: draft.text }), /draft-stale/)
  assert.equal(f.stats().submits, 0)
})
test('Send acknowledges durable admission before held review, deduplicates token and exact Stop aborts', async (t) => {
  const f = fixture(t),
    draft = f.runtime.draft(f.item.id)
  const [first, duplicate] = await Promise.all([
    f.runtime.send({ token: draft.token, text: draft.text }),
    f.runtime.send({ token: draft.token, text: draft.text }),
  ])
  assert.equal(first.messages.length, 2)
  assert.deepEqual(
    first.messages.map((m) => m.id),
    duplicate.messages.map((m) => m.id)
  )
  await until(() => f.stats().asks === 1)
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  assert.equal(a.state, 'waiting')
  assert.equal(a.connection, 'connected')
  assert.equal(f.stats().submits, 1)
  await assert.rejects(f.runtime.send({ token: draft.token, text: 'Different' }), /conflict/)
  const d2 = f.runtime.draft(f.item.id)
  await assert.rejects(f.runtime.send({ token: d2.token, text: d2.text }), /busy/)
  await f.runtime.control({ ...a, command: 'stop' })
  assert.equal(f.signal?.aborted, true)
  f.asksGate.resolve('accept')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.stats().saves, 0)
  assert.equal(f.stats().stops, 1)
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.state, 'stopped')
})
test('restart is read-only and NULL write claim remains unknown until explicit Stop', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.reopen()
  await f.runtime.recover()
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  assert.equal(a.state, 'claimed-unknown')
  await f.runtime.control({ ...a, command: 'check' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.stats().asks, 1)
  assert.equal(f.stats().saves, 0)
  assert.equal(f.stats().submits, 1)
  const same = await f.runtime.send({ token: d.token, text: d.text })
  assert.equal(same.messages.length, 2)
  await f.runtime.control({ ...a, command: 'stop' })
})

test('edited Task, changed source, denied provenance and Auto mode all invalidate drafts before any prepare', async (t) => {
  const f = fixture(t)
  let d = f.runtime.draft(f.item.id)
  f.evidence.updateWorkItem(f.item.id, 'Changed task', 'Changed instruction')
  await assert.rejects(f.runtime.send({ token: d.token, text: d.text }), /draft-stale/)
  d = f.runtime.draft(f.item.id)
  const page = f.deps.personal.pages().find((p) => p.slug === d.source.slug)
  assert(page)
  f.deps.personal.save({
    spaceId: 'personal',
    slug: page.slug,
    title: page.title,
    content: 'Manual change.',
    expectedRevision: page.revision!,
  })
  await assert.rejects(f.runtime.send({ token: d.token, text: d.text }), /draft-stale/)
  d = f.runtime.draft(f.item.id)
  f.space.maintenanceMode = 'suggest'
  await assert.rejects(f.runtime.send({ token: d.token, text: d.text }), /draft-stale/)
  f.space.maintenanceMode = 'auto'
  d = f.runtime.draft(f.item.id)
  f.setPermitted(false)
  await assert.rejects(f.runtime.send({ token: d.token, text: d.text }), /draft-stale/)
  assert.equal(f.stats().prepares, 0)
  assert.equal(f.resident.conversation(null).messages.length, 0)
})
test('active explicit Send advances read to one reviewed patch, persists results and keeps historical A controls away from B', async (t) => {
  const f = fixture(t, 10)
  f.setAction('read')
  f.setFollowup()
  const d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.asksGate.resolve('accept')
  await until(() => f.runtime.snapshot().messages[1].taskAction?.state === 'completed')
  assert.equal(f.stats().replies, 2)
  assert.equal(f.stats().saves, 1)
  assert.equal(f.runtime.snapshot().messages[1].results?.length, 1)
  const a = f.runtime.snapshot().messages[1].taskAction
  assert(a)
  const row = f.resident.getHostTaskIntent(a.actionId)
  assert(row?.outcome)
  const timing = copy(row.outcome)
  const replay = await f.runtime.send({ token: d.token, text: d.text })
  assert.equal(replay.messages[1].taskAction?.state, 'completed')
  const b = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: b.token, text: b.text })
  await f.runtime.control({ ...a, command: 'stop' })
  assert.equal(f.stats().stops, 0)
  await until(() => f.runtime.snapshot().messages[3]?.taskAction?.state === 'completed')
  assert.equal(f.stats().submits, 2)
  assert.deepEqual(f.resident.getHostTaskIntent(a.actionId)?.outcome, timing)
  const json = JSON.stringify(f.runtime.snapshot())
  assert(!json.includes('tcp://'))
  assert(!json.includes('policy-1'))
  assert(!json.includes('systemPrompt'))
  assert(!('hostJob' in f.runtime.snapshot()))
  f.reopen()
  await f.runtime.recover()
  assert.equal(f.stats().submits, 2)
  assert.equal(f.runtime.snapshot().messages[1].results?.length, 1)
  const exhausted = f.runtime.draft(f.item.id)
  await assert.rejects(f.runtime.send({ token: exhausted.token, text: exhausted.text }), /slots-exhausted/)
})
test('withheld completion stays blocked during read-only recovery and releases only by explicit Check', async (t) => {
  const f = fixture(t, 10)
  f.afterReply(() => f.setMode('unavailable'))
  const d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.asksGate.resolve('accept')
  await until(() => f.runtime.snapshot().activeTaskAction?.state === 'withheld')
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  assert.equal(f.runtime.snapshot().messages[1].text, '')
  const time = f.resident.hostTaskExecution(a.actionId)?.terminalReceivedAt
  assert(time)
  f.setMode('valid')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(f.runtime.snapshot().activeTaskAction?.state, 'withheld')
  f.reopen()
  await f.runtime.recover()
  assert.equal(f.runtime.snapshot().activeTaskAction?.state, 'withheld')
  await f.runtime.control({ ...a, command: 'check' })
  await until(() => f.runtime.snapshot().messages[1].taskAction?.state === 'completed')
  assert.equal(f.resident.hostTaskExecution(a.actionId)?.terminalReceivedAt, time)
  assert.equal(f.stats().saves, 1)
  assert.equal(f.stats().replies, 1)
})
test('synchronous invalidation aborts pending review, and deletion waits for exact Stop without importing late approval', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.setPolicy('revoked')
  f.runtime.invalidate()
  assert.equal(f.signal?.aborted, true)
  f.asksGate.resolve('accept')
  await until(() => f.runtime.snapshot().activeTaskAction === null)
  assert.equal(f.stats().saves, 0)
  assert.equal(f.stats().replies, 0)
  assert.equal(f.resident.hostTaskExecution(d.token)?.intent.invalidated, true)
  await f.runtime.prepareForDeletion()
  assert.equal(f.stats().stops, 1)
})
test('explicit cancellation during held registration is an unused tombstone, not remote Stop', async (t) => {
  const f = fixture(t),
    gate = deferred<void>()
  f.setRegisterGate(gate.promise)
  const d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  await f.runtime.control({ ...a, command: 'cancel' })
  gate.resolve()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.state, 'cancelled')
  assert.equal(f.stats().submits, 0)
  assert.equal(f.stats().stops, 0)
  assert.equal(f.stats().saves, 0)
})

test('completed outcome with missing Evidence ACK remains checkable, and Check only projects metadata', async (t) => {
  const f = fixture(t)
  f.setAction('read')
  const original = f.evidence.applyHostTaskOutcome.bind(f.evidence)
  f.evidence.applyHostTaskOutcome = () => {
    throw new Error('synthetic-projection-unavailable')
  }
  const d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => Boolean(f.resident.hostTaskExecution(d.token)?.intent.outcome))
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  assert.equal(a.state, 'completed')
  assert.deepEqual(a.allowedControls, ['check'])
  f.evidence.applyHostTaskOutcome = original
  await f.runtime.control({ ...a, command: 'check' })
  await until(() => f.runtime.snapshot().activeTaskAction === null)
  assert.equal(f.stats().submits, 1)
  assert.equal(f.stats().replies, 1)
  assert.equal(f.stats().saves, 0)
})
test('restart of a prepared action retains known unused state and exact Cancel control', async (t) => {
  const f = fixture(t),
    gate = deferred<void>()
  f.setRegisterGate(gate.promise)
  const d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  f.reopen()
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  assert.equal(a.state, 'prepared')
  assert.deepEqual(a.allowedControls, ['cancel'])
  await f.runtime.control({ ...a, command: 'cancel' })
  gate.resolve()
  assert.equal(f.stats().submits, 0)
})

test('failed durable invalidation still aborts review and exact Stop cannot import an unlatched completion', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  const db = new DatabaseSync(join(f.directory, 'assistant.sqlite'))
  db.exec(
    "CREATE TRIGGER fail_invalidation BEFORE UPDATE OF invalidated ON assistant_task_run BEGIN SELECT RAISE(ABORT,'synthetic-latch-failure'); END"
  )
  db.close()
  f.setStopCompletes()
  assert.throws(() => f.runtime.invalidate(), /synthetic-latch-failure/)
  assert.equal(f.signal?.aborted, true)
  await until(() => f.stats().stops === 1)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(f.runtime.snapshot().messages[1].text, '')
  assert.equal(f.resident.hostTaskExecution(d.token)?.intent.outcome, null)
  f.asksGate.resolve('accept')
  assert.equal(f.stats().saves, 0)
})

test('consent revocation that makes native context unavailable still records confirmed sanitized Stop', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.denyContext()
  f.runtime.invalidate()
  assert.equal(f.signal?.aborted, true)
  await until(() => f.stats().stops === 1)
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.state, 'stopped')
  assert.equal(f.runtime.snapshot().messages[1].text, '')
  assert.equal(f.stats().saves, 0)
  f.asksGate.resolve('accept')
})

test('confirmed expiry and consent Stop reasons survive a new runtime owner, with expiry taking precedence', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.setStopExpired()
  f.denyContext()
  f.runtime.invalidate()
  await until(() => f.runtime.snapshot().activeTaskAction === null)
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.issue, 'assistant-host-request-expired')
  f.reopen()
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.issue, 'assistant-host-request-expired')
  f.asksGate.resolve('decline')
})
test('stored consent Stop is visible after restart', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  f.runtime.invalidate()
  await until(() => f.runtime.snapshot().activeTaskAction === null)
  f.reopen()
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.issue, 'assistant-host-context-invalidated')
  f.asksGate.resolve('decline')
})

test('an older confirmed manual Stop is never relabelled by a later intent invalidation', async (t) => {
  const f = fixture(t),
    d = f.runtime.draft(f.item.id)
  await f.runtime.send({ token: d.token, text: d.text })
  await until(() => f.stats().asks === 1)
  const a = f.runtime.snapshot().activeTaskAction
  assert(a)
  await f.runtime.control({ ...a, command: 'stop' })
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.state, 'stopped')
  assert.equal(f.stats().stops, 1)
  f.resident.invalidateHostTaskAction(d.token)
  f.reopen()
  assert.equal(f.runtime.snapshot().messages[1].taskAction?.issue, undefined)
  f.asksGate.resolve('decline')
})
