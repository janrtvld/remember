import assert from 'node:assert/strict'
import { type ChildProcess, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { EvidenceStore } from '../src/main/dailyReview/evidenceStore'
import {
  canonicalHostTaskJson,
  type HostTaskEnvelopeV1,
  type HostTaskOutcome,
  hostTaskDefinition,
  hostTaskSessionReceipt,
  validateHostTaskEnvelope,
} from '../src/main/hostTaskProtocol'
import { ResidentAgentStore } from '../src/main/residentAgentStore'

type Assignment = { jobId: string; messageId: string; workItemId: string; sessionId: string }
type RouterInput = {
  prompt: string
  systemPrompt: string
  model: string
  effort: 'low'
  threadId: null
  tools: []
  reviewTtlMs: number
}
type Descriptor = {
  version: 2
  targetId: string
  targetEpoch: string
  root: string
  assignment: Assignment
  directory: string
  workspace: string
  inputHash: string
}
type HostSnapshot = {
  sessionId: string
  job: {
    id: string
    inputHash: string
    spec: RouterInput & { workspace: string }
    phase: string
    threadId: string | null
    turnId: string | null
    createdAt: number
    updatedAt: number
  } | null
  requests: { id: string; sessionId: string; status: string; payload: Record<string, unknown> }[]
  events: unknown[]
}
type RouterState = {
  descriptor: Descriptor
  state: string
  snapshot: HostSnapshot | null
  cancellation?: { kind: 'unsubmitted'; at: number }
}
type WireRequest = { op: string; [key: string]: unknown }
type Row = Record<string, unknown>
type Tables = Record<string, Row[]>
type Child = { process: ChildProcess; pid: number; kind: string; directory: string; exited: boolean }
type LedgerEntry = { at: number; pid: number; type: string; [key: string]: unknown }
type FakeInput = {
  prompt: string
  remote: unknown
  signal: AbortSignal
  onThread(threadId: string): void
  onCheckpoint(value: unknown): void
  ask(request: unknown, signal: AbortSignal): Promise<unknown>
}

const script = fileURLToPath(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const targetId = 'synthetic-local-target'
const targetEpoch = 'synthetic-epoch-1'
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const saveJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

function ledger(directory: string, type: string, value: Record<string, unknown> = {}) {
  appendFileSync(
    join(directory, 'events.jsonl'),
    `${JSON.stringify({ at: Date.now(), pid: process.pid, type, ...value })}\n`
  )
}

function entries(directory: string, file = 'events.jsonl'): LedgerEntry[] {
  const path = join(directory, file)
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}

function readTables(file: string): Tables {
  if (!existsSync(file)) return {}
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    return Object.fromEntries(
      names.map((row) => {
        assert.equal(typeof row.name, 'string')
        const name = String(row.name)
        assert.match(name, /^[a-z_]+$/)
        const values = JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())) as Row[]
        values.sort((a, b) => canonicalHostTaskJson(a).localeCompare(canonicalHostTaskJson(b)))
        return [name, values]
      })
    )
  } finally {
    db.close()
  }
}

function stores(directory: string) {
  const resident = new ResidentAgentStore(join(directory, 'conversation.sqlite'))
  const evidence = new EvidenceStore(join(directory, 'evidence.sqlite'))
  return {
    resident,
    evidence,
    close() {
      resident.close()
      evidence.close()
    },
  }
}

function storeRows(directory: string) {
  return {
    resident: readTables(join(directory, 'conversation.sqlite')),
    evidence: readTables(join(directory, 'evidence.sqlite')),
  }
}

function preserveCutFiles(directory: string, registry: string) {
  const output = join(directory, 'cut-raw-before-reopen')
  mkdirSync(output, { mode: 0o700 })
  const files: { name: string; bytes: number; sha256: string }[] = []
  for (const source of [
    join(directory, 'conversation.sqlite'),
    join(directory, 'evidence.sqlite'),
    join(registry, 'registry-v2.sqlite'),
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${source}${suffix}`
      if (!existsSync(path)) continue
      const name = `${source.slice(source.lastIndexOf('/') + 1)}${suffix}`
      const destination = join(output, name)
      copyFileSync(path, destination)
      const bytes = readFileSync(destination)
      files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  saveJson(join(output, 'manifest.json'), {
    at: Date.now(),
    boundary: 'Exact synthetic DB/WAL/SHM files after router exit, before any reopen; parent store writes are paused.',
    files,
  })
}

let socketRequestId = 0
async function childRpc(path: string, op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  try {
    return await new Promise((done, reject) => {
      let settled = false
      let text = ''
      const finish = (error: Error | null, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else done(result)
      }
      const timer = setTimeout(() => finish(Error('probe-child-rpc-timeout')), 5000)
      socket.once('error', (error) => finish(error))
      socket.once('close', () => finish(Error('probe-child-rpc-closed')))
      socket.on('data', (data) => {
        text += data
        if (text.length > 256000) return finish(Error('probe-child-response-too-large'))
        const end = text.indexOf('\n')
        if (end < 0) return
        try {
          const message = JSON.parse(text.slice(0, end))
          finish(message.error ? Error(String(message.error)) : null, message.result)
        } catch (error) {
          finish(Error(errorText(error)))
        }
      })
      socket.once('connect', () => socket.write(`${JSON.stringify({ id: ++socketRequestId, op, ...payload })}\n`))
    })
  } finally {
    socket.destroy()
  }
}

async function routerChild(directory: string) {
  const { openJobRouterV2 } = await import(join(repository, 'experiments/always-on-agent/job-router-v2.mjs'))
  const router = openJobRouterV2({
    directory,
    targetId,
    targetEpoch,
    connectChild: async (descriptor: Descriptor) => {
      ledger(directory, 'child-connect', { assignment: descriptor.assignment })
      return {
        request: (op: string, payload: Record<string, unknown> = {}) => {
          ledger(directory, 'child-request', { assignment: descriptor.assignment, op })
          return childRpc(join(descriptor.directory, 'client.sock'), op, payload)
        },
        async close() {},
      }
    },
  })
  let fault: 'hold-register' | 'exit-register' | null = null
  let held: { id: number; result: unknown } | null = null
  process.on('message', async (raw) => {
    const message = raw as { id: number; op: string; fault?: typeof fault; request?: WireRequest }
    try {
      if (message.op === 'exit-prepared') {
        ledger(directory, 'forced-exit', { stage: 'after-prepare-before-local-intent', code: 81 })
        process.exit(81)
      }
      if (message.op === 'close') {
        await router.close()
        process.exit(0)
      }
      if (message.op === 'configure') {
        fault = message.fault ?? null
        process.send?.({ id: message.id, result: true })
        return
      }
      if (message.op === 'release') {
        assert(held)
        ledger(directory, 'register-ack-released', { id: held.id })
        process.send?.(held)
        held = null
        process.send?.({ id: message.id, result: true })
        return
      }
      assert(message.request)
      ledger(directory, 'request', { id: message.id, request: message.request })
      const result = await router.request(JSON.stringify(message.request))
      ledger(directory, 'response', { id: message.id, result })
      if (message.request.op === 'register' && fault) {
        const activeFault = fault
        fault = null
        if (activeFault === 'exit-register') {
          ledger(directory, 'forced-exit', { stage: 'after-register-before-ack', code: 82, result })
          process.exit(82)
        }
        held = { id: message.id, result }
        ledger(directory, 'register-ack-held', { id: message.id })
        process.send?.({ held: message.id })
        return
      }
      process.send?.({ id: message.id, result })
    } catch (error) {
      ledger(directory, 'request-error', { id: message.id, error: errorText(error) })
      process.send?.({ id: message.id, error: errorText(error) })
    }
  })
  process.send?.({ ready: true, pid: process.pid })
}

async function coordinatorChild(directory: string) {
  const { createCoordinator } = await import(join(repository, 'experiments/always-on-agent/coordinator.mjs'))
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(
      join(directory, 'fake-provider.jsonl'),
      `${JSON.stringify({ type, pid: process.pid, at: Date.now(), ...extra })}\n`
    )
  const coordinator = await createCoordinator({
    directory,
    nativeClient: true,
    driver: {
      async runCodexWorker(input: FakeInput) {
        log('invocation', { prompt: input.prompt })
        const suffix = createHash('sha256').update(input.prompt).digest('hex').slice(0, 12)
        const threadId = `thread-${suffix}`
        const turnId = `turn-${suffix}`
        input.onThread(threadId)
        input.onCheckpoint({ computer: input.remote, threadId, turnId: null, previousTurnId: null })
        input.onCheckpoint({ computer: input.remote, threadId, turnId, previousTurnId: null })
        const cancelled = new Promise<never>((_, reject) => {
          input.signal.addEventListener(
            'abort',
            () => {
              log('abort')
              input.onCheckpoint(null)
              reject(Error('agent-cancelled'))
            },
            { once: true }
          )
        })
        const requested = input.ask(
          {
            title: `Synthetic review ${suffix}`,
            fields: [],
            actions: [
              { id: 'accept', label: 'Accept' },
              { id: 'decline', label: 'Decline' },
            ],
          },
          input.signal
        )
        const answer = await Promise.race([requested, cancelled])
        log('review-answer', { answer })
        input.onCheckpoint(null)
        return { response: 'Unexpected review acceptance', threadId }
      },
      async stopCodexRemoteCheckpoint(checkpoint: unknown) {
        log('recovery-stop', { checkpoint })
      },
    },
  })
  process.on('message', async (raw) => {
    if ((raw as { op: string }).op !== 'close') return
    try {
      await coordinator.close()
      process.exit(0)
    } catch (error) {
      process.send?.({ closeError: errorText(error) })
    }
  })
  process.send?.({ ready: true, pid: process.pid, socketPath: coordinator.socketPath })
}

function routerInput(suffix: string): RouterInput {
  return {
    prompt: `Synthetic explicit action ${suffix}`,
    systemPrompt: 'Local synthetic admission experiment only',
    model: 'fake-model',
    effort: 'low',
    threadId: null,
    tools: [],
    reviewTtlMs: 300000,
  }
}

function envelope(
  item: ReturnType<EvidenceStore['createWorkItem']>,
  descriptor: Descriptor,
  input: RouterInput,
  policyFingerprint: string,
  suffix: string
): HostTaskEnvelopeV1 {
  const { reviewTtlMs, ...prepared } = input
  assert.equal(reviewTtlMs, 300000)
  return {
    version: 1,
    actionId: `action-${suffix}`,
    workItemId: item.id,
    sessionId: descriptor.assignment.sessionId,
    jobId: descriptor.assignment.jobId,
    userMessageId: `user-${suffix}`,
    assistantMessageId: descriptor.assignment.messageId,
    provider: 'codex',
    instruction: `Explicit synthetic task ${suffix}; do not complete the human Task`,
    targetId: descriptor.targetId,
    taskDefinition: hostTaskDefinition(item),
    policyFingerprint,
    sources: [],
    startedAt: Date.now(),
    preparedInput: { ...prepared, workspace: descriptor.workspace },
  }
}

async function main() {
  const root = mkdtempSync('/private/tmp/e073-')
  const proof: {
    status: string
    root: string
    pid: number
    boundary: string
    checks: string[]
    [key: string]: unknown
  } = {
    status: 'running',
    root,
    pid: process.pid,
    boundary:
      'Real local stores and separate router/coordinator processes with fake providers. Harness admission guards only; synthetic policy; metadata receipt does not prove execution. No product adapter, native, model, Mini, cloud, capture or user data.',
    checks: [],
  }
  const children: Child[] = []
  const descriptors: Descriptor[] = []
  const cases: Record<string, unknown>[] = []
  const storeState: { current: ReturnType<typeof stores> | null } = { current: null }
  const save = () => saveJson(join(root, 'report.json'), { ...proof, cases, descriptors })
  const check = (label: string, condition: unknown) => {
    assert(condition, label)
    proof.checks.push(label)
    save()
  }
  const record = (type: string, value: Record<string, unknown>) => ledger(root, type, value)
  let serial = 0

  async function launch(kind: '--router-child' | '--coordinator-child', directory: string): Promise<Child> {
    const child = fork(script, [kind, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    assert(child.pid)
    const entry: Child = { process: child, pid: child.pid, kind, directory, exited: false }
    children.push(entry)
    const log = join(root, `process-${entry.pid}.log`)
    writeFileSync(log, '', { mode: 0o600 })
    child.stdout?.on('data', (data: Buffer) => appendFileSync(log, data))
    child.stderr?.on('data', (data: Buffer) => appendFileSync(log, data))
    child.on('exit', (code, signal) => {
      entry.exited = true
      record('process-exit', { pid: entry.pid, code, signal })
      save()
    })
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => finish(Error('probe-child-ready-timeout')), 5000)
      const onExit = () => finish(Error('probe-child-exited-before-ready'))
      const onMessage = (raw: unknown) => {
        const message = raw as { ready?: boolean }
        if (message.ready) {
          record('process-ready', { kind, directory, pid: entry.pid, message })
          finish()
        }
      }
      const finish = (error?: Error) => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        if (error) reject(error)
        else done()
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
    })
    return entry
  }

  function call<T>(child: Child, request: WireRequest, control = false): Promise<T> {
    const id = ++serial
    record('ipc-call', { pid: child.pid, id, control, request })
    return new Promise<T>((done, reject) => {
      let settled = false
      const finish = (error: Error | null, result?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.process.off('message', onMessage)
        child.process.off('exit', onExit)
        record('ipc-result', { pid: child.pid, id, error: error?.message ?? null, result: result ?? null })
        if (error) reject(error)
        else done(result as T)
      }
      const timer = setTimeout(() => finish(Error('probe-router-timeout')), 10000)
      const onExit = () => finish(Error('probe-router-exited'))
      const onMessage = (raw: unknown) => {
        const response = raw as { id?: number; result?: T; error?: string }
        if (response.id === id) finish(response.error ? Error(response.error) : null, response.result)
      }
      child.process.on('message', onMessage)
      child.process.once('exit', onExit)
      child.process.send(control ? { ...request, id } : { op: 'request', id, request }, (error) => {
        if (error) finish(error)
      })
    })
  }

  async function waitFor(label: string, predicate: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return
      await delay(25)
    }
    throw Error(`probe-wait-timeout:${label}`)
  }
  async function closeChild(child: Child) {
    if (child.exited) return
    child.process.send({ op: 'close' })
    await waitFor(`close-${child.pid}`, () => child.exited)
    const exit = entries(root).find((entry) => entry.type === 'process-exit' && entry.pid === child.pid)
    assert.equal(exit?.code, 0)
    assert.equal(exit?.signal, null)
  }

  async function runCase(name: 'prepare-cut' | 'register-lost' | 'task' | 'policy') {
    const directory = join(root, name)
    const registry = join(directory, 'r')
    mkdirSync(registry, { recursive: true, mode: 0o700 })
    let s = stores(directory)
    storeState.current = s
    let router = await launch('--router-child', registry)
    let policy = 'synthetic-policy-1'
    const taskA = s.evidence.createWorkItem(`Synthetic ${name} A`, 'Keep human task open')
    const taskB = s.evidence.createWorkItem(`Synthetic ${name} B`, 'Only an explicit later action may run')
    const initialRows = storeRows(directory)
    saveJson(join(directory, 'initial-store-rows.json'), initialRows)
    let expectedTaskRows = initialRows.evidence.work_item
    const assignment: Assignment = {
      jobId: `job-${name}-a`,
      messageId: `assistant-${name}-a`,
      workItemId: taskA.id,
      sessionId: `session-${name}-a`,
    }
    const input = routerInput(`${name}-a`)
    const prepared = await call<Descriptor>(router, { op: 'prepare', assignment, input })
    assert.deepEqual(await call(router, { op: 'prepare', assignment, input }), prepared)
    descriptors.push(prepared)
    assert.equal(prepared.targetId, targetId)
    assert.equal(prepared.targetEpoch, targetEpoch)
    assert.equal(prepared.root, registry)
    assert(Buffer.byteLength(join(prepared.directory, 'client.sock')) < 100)
    assert.equal(
      prepared.inputHash,
      createHash('sha256')
        .update(canonicalHostTaskJson({ ...input, workspace: prepared.workspace }))
        .digest('hex')
    )
    check(
      `${name}: prepare has stable identity and zero registry rows`,
      (readTables(join(registry, 'registry-v2.sqlite')).router_job ?? []).length === 0
    )
    check(
      `${name}: prepare creates no job directory or child connection`,
      !existsSync(prepared.directory) && !entries(registry).some((entry) => entry.type === 'child-connect')
    )
    saveJson(join(directory, 'prepared.json'), { prepared, input, assignment })
    const result: Record<string, unknown> = { name, directory, prepared, input, assignment }
    cases.push(result)
    save()
    try {
      if (name === 'prepare-cut') {
        const oldPid = router.pid
        await assert.rejects(call(router, { op: 'exit-prepared' }, true), /probe-router-exited/)
        const exit = entries(root).find((entry) => entry.type === 'process-exit' && entry.pid === oldPid)
        assert.equal(exit?.code, 81)
        assert.equal(exit?.signal, null)
        preserveCutFiles(directory, registry)
        saveJson(join(directory, 'after-cut-before-reopen.json'), {
          registry: readTables(join(registry, 'registry-v2.sqlite')),
          stores: storeRows(directory),
          exit,
        })
        router = await launch('--router-child', registry)
        assert.deepEqual(await call(router, { op: 'prepare', assignment, input }), prepared)
        assert.deepEqual(storeRows(directory), initialRows)
        check(
          'prepare-cut: actual process exit leaves zero intents/sessions/registrations',
          (readTables(join(registry, 'registry-v2.sqlite')).router_job ?? []).length === 0 &&
            !existsSync(prepared.directory)
        )
        result.cutExit = exit
        return
      }

      const a = envelope(taskA, prepared, input, policy, `${name}-a`)
      s.resident.createHostTaskIntent(a)
      s.resident.acknowledgeHostTaskSession(a.actionId, s.evidence.acceptHostTaskSession(a))
      assert.deepEqual(s.resident.getHostTaskIntent(a.actionId)?.sessionReceipt, hostTaskSessionReceipt(a))
      result.envelopeA = a
      saveJson(join(directory, 'before-register.json'), {
        stores: storeRows(directory),
        registry: readTables(join(registry, 'registry-v2.sqlite')),
        a,
      })
      check(
        `${name}: durable intent and exact receiver ACK precede registration`,
        (readTables(join(registry, 'registry-v2.sqlite')).router_job ?? []).length === 0
      )
      await call(router, { op: 'configure', fault: name === 'register-lost' ? 'exit-register' : 'hold-register' }, true)
      const registering = call<Descriptor>(router, { op: 'register', assignment, input, prepared })
      // Cleanup may happen before the held response is awaited; its rejection is still recorded by call().
      void registering.catch(() => {})
      if (name === 'register-lost') {
        const oldPid = router.pid
        await assert.rejects(registering, /probe-router-exited/)
        const exit = entries(root).find((entry) => entry.type === 'process-exit' && entry.pid === oldPid)
        assert.equal(exit?.code, 82)
        assert.equal(exit?.signal, null)
        preserveCutFiles(directory, registry)
        const afterCut = {
          registry: readTables(join(registry, 'registry-v2.sqlite')),
          stores: storeRows(directory),
          exit,
        }
        saveJson(join(directory, 'after-cut-before-reopen.json'), afterCut)
        assert.equal(afterCut.registry.router_job?.[0]?.dispatch_state, 'reserved')
        router = await launch('--router-child', registry)
        const reserved = await call<RouterState>(router, { op: 'snapshot', assignment })
        assert.equal(reserved.state, 'reserved')
        assert.equal(reserved.snapshot, null)
        assert.deepEqual(reserved.descriptor, prepared)
        result.cutExit = exit
        result.recoveryObservation = reserved
      } else {
        await waitFor('register-ack-held', () => entries(registry).some((entry) => entry.type === 'register-ack-held'))
        saveJson(join(directory, 'held-before-change.json'), {
          registry: readTables(join(registry, 'registry-v2.sqlite')),
          stores: storeRows(directory),
        })
        if (name === 'task') {
          s.evidence.updateWorkItem(
            taskA.id,
            'Explicit user edit during registration',
            'New definition must not dispatch old prepared input'
          )
        } else {
          policy = 'synthetic-policy-2'
          s.resident.resetContext()
        }
        expectedTaskRows = storeRows(directory).evidence.work_item
        saveJson(join(directory, 'held-after-change.json'), { policy, stores: storeRows(directory) })
        await call(router, { op: 'release' }, true)
        assert.deepEqual(await registering, prepared)
        const taskState = s.evidence.validateHostTaskForDispatch(
          a.actionId,
          validateHostTaskEnvelope(a).envelopeHash
        ).state
        const invalidated = s.resident.getHostTaskIntent(a.actionId)?.invalidated
        const allowed = taskState === 'current' && policy === a.policyFingerprint && invalidated === false
        result.guard = {
          taskState,
          savedPolicy: a.policyFingerprint,
          currentPolicy: policy,
          invalidated,
          allowed,
          boundary: 'Harness current guard on real Task definition and synthetic policy; not product authorization.',
        }
        save()
        assert.equal(allowed, false)
        assert.equal(taskState, name === 'task' ? 'changed' : 'current')
        assert.equal(invalidated, name === 'policy')
      }
      check(
        `${name}: zero submit and zero child connection before exact cancellation`,
        !entries(registry).some(
          (entry) =>
            entry.type === 'child-connect' ||
            (entry.type === 'request' && (entry.request as WireRequest).op === 'submit')
        )
      )
      result.admissionSubmitRequests = entries(registry).filter(
        (entry) => entry.type === 'request' && (entry.request as WireRequest).op === 'submit'
      ).length
      const cancelRequest = { op: 'cancel-unsubmitted', assignment, inputHash: prepared.inputHash }
      const cancelled = await call<RouterState>(router, cancelRequest)
      assert.equal(cancelled.state, 'cancelled-unsubmitted')
      assert.equal(cancelled.snapshot, null)
      assert.deepEqual(cancelled.descriptor, prepared)
      assert.equal(cancelled.cancellation?.kind, 'unsubmitted')
      assert.equal(typeof cancelled.cancellation?.at, 'number')
      assert.deepEqual(await call(router, cancelRequest), cancelled)
      result.cancellation = cancelled
      const cancelledRows = storeRows(directory)
      assert.equal(s.resident.getHostTaskIntent(a.actionId)?.outcome, null)
      assert.equal(s.resident.get(a.assistantMessageId)?.error, 'assistant-host-task-not-submitted')
      assert.equal(s.evidence.getWorkItem(taskA.id)?.agentSessions[0]?.status, 'running')
      check(
        `${name}: unused cancellation is not fabricated remote Stop/outcome`,
        cancelledRows.evidence.work_item_fact?.filter(
          (row) => row.agent_session_id === a.sessionId && row.type !== 'agent_started'
        ).length === 0
      )
      saveJson(join(directory, 'cancelled-before-reopen.json'), {
        stores: cancelledRows,
        registry: readTables(join(registry, 'registry-v2.sqlite')),
        cancelled,
      })
      await closeChild(router)
      s.close()
      s = stores(directory)
      storeState.current = s
      router = await launch('--router-child', registry)
      assert.deepEqual(await call(router, { op: 'snapshot', assignment }), cancelled)
      assert.deepEqual(storeRows(directory), cancelledRows)
      assert.deepEqual(await call(router, { op: 'register', assignment, input, prepared }), prepared)
      record('adversarial-cancelled-controls-start', { jobId: assignment.jobId })
      await assert.rejects(call(router, { op: 'submit', assignment }), /router-reservation-cancelled/)
      await assert.rejects(call(router, { op: 'stop', assignment }), /router-reservation-cancelled/)
      await assert.rejects(
        call(router, {
          op: 'reply',
          assignment,
          requestId: 'old-request',
          sessionId: 'old-host-session',
          result: { action: 'accept', values: {} },
        }),
        /router-reservation-cancelled/
      )
      record('adversarial-cancelled-controls-end', { jobId: assignment.jobId })
      const rejectedSubmitCount = entries(registry).filter(
        (entry) => entry.type === 'request' && (entry.request as WireRequest).op === 'submit'
      ).length
      assert.equal(rejectedSubmitCount, 1)
      result.rejectedAdversarialSubmitRequests = rejectedSubmitCount
      check(
        `${name}: tombstone survives real router restart and forbids all execution controls`,
        !entries(registry).some((entry) => entry.type === 'child-connect')
      )
      if (name === 'register-lost') {
        assert.deepEqual(storeRows(directory).evidence.work_item, expectedTaskRows)
        check('register-lost: full original Task rows unchanged after recovery and cancellation', true)
        return
      }

      const assignmentB: Assignment = {
        jobId: `job-${name}-b`,
        messageId: `assistant-${name}-b`,
        workItemId: taskB.id,
        sessionId: `session-${name}-b`,
      }
      const inputB = routerInput(`${name}-b`)
      const preparedB = await call<Descriptor>(router, { op: 'prepare', assignment: assignmentB, input: inputB })
      descriptors.push(preparedB)
      assert(Buffer.byteLength(join(preparedB.directory, 'client.sock')) < 100)
      const b = envelope(taskB, preparedB, inputB, policy, `${name}-b`)
      result.envelopeB = b
      s.resident.createHostTaskIntent(b)
      s.resident.acknowledgeHostTaskSession(b.actionId, s.evidence.acceptHostTaskSession(b))
      assert.deepEqual(
        await call(router, { op: 'register', assignment: assignmentB, input: inputB, prepared: preparedB }),
        preparedB
      )
      const coordinator = await launch('--coordinator-child', preparedB.directory)
      const bGuard = s.evidence.validateHostTaskForDispatch(b.actionId, validateHostTaskEnvelope(b).envelopeHash)
      assert.equal(bGuard.state, 'current')
      assert.equal(s.resident.getHostTaskIntent(b.actionId)?.invalidated, false)
      assert.equal(b.policyFingerprint, policy)
      await call(router, { op: 'submit', assignment: assignmentB })
      let waiting: RouterState | null = null
      await waitFor('successor-review', async () => {
        waiting = await call<RouterState>(router, { op: 'snapshot', assignment: assignmentB })
        return waiting.state === 'waiting' && waiting.snapshot?.requests.length === 1
      })
      assert(waiting)
      const pendingB = waiting as RouterState
      assert.equal(pendingB.snapshot?.job?.id, b.jobId)
      assert.equal(pendingB.snapshot?.job?.inputHash, preparedB.inputHash)
      assert.deepEqual(pendingB.snapshot?.job?.spec, { ...inputB, workspace: b.preparedInput.workspace })
      result.waitingB = pendingB
      assert.deepEqual(await call(router, cancelRequest), cancelled)
      assert.deepEqual(await call(router, { op: 'register', assignment, input, prepared }), prepared)
      await assert.rejects(call(router, { op: 'stop', assignment }), /router-reservation-cancelled/)
      const actualReviewB = pendingB.snapshot?.requests[0]
      assert(actualReviewB)
      await assert.rejects(
        call(router, {
          op: 'reply',
          assignment,
          requestId: actualReviewB.id,
          sessionId: actualReviewB.sessionId,
          result: { action: 'accept', values: {} },
        }),
        /router-reservation-cancelled/
      )
      const stillB = await call<RouterState>(router, { op: 'snapshot', assignment: assignmentB })
      assert.equal(stillB.state, 'waiting')
      assert.deepEqual(stillB.snapshot?.requests, pendingB.snapshot?.requests)
      check(`${name}: historical A cancellation cannot answer or Stop B`, true)
      const stopped = await call<RouterState>(router, { op: 'stop', assignment: assignmentB })
      assert.equal(stopped.state, 'stopped')
      assert.equal(stopped.snapshot?.job?.id, b.jobId)
      assert.equal(stopped.snapshot?.requests.length, 0)
      assert(stopped.snapshot?.job)
      const outcome: HostTaskOutcome = {
        version: 1,
        status: 'stopped',
        response: '',
        steps: [],
        completedAt: stopped.snapshot.job.updatedAt,
        durationMs: stopped.snapshot.job.updatedAt - b.startedAt,
      }
      s.resident.recordHostTaskOutcome(b.actionId, outcome)
      s.resident.acknowledgeHostTaskOutcome(b.actionId, s.evidence.applyHostTaskOutcome(b, outcome))
      result.stoppedB = stopped
      result.outcomeB = outcome
      assert.equal(s.resident.getHostTaskIntent(a.actionId)?.outcome, null)
      assert.deepEqual(storeRows(directory).evidence.work_item, expectedTaskRows)
      const provider = entries(preparedB.directory, 'fake-provider.jsonl')
      const finalMetadata = storeRows(directory)
      assert.equal(finalMetadata.resident.assistant_tool_call?.length, 0)
      assert.equal(finalMetadata.resident.assistant_host_run?.length, 0)
      assert.equal(finalMetadata.evidence.work_item_agent_session?.length, 2)
      assert.equal(finalMetadata.evidence.work_item_fact?.filter((row) => row.type === 'agent_started').length, 2)
      assert.equal(
        finalMetadata.evidence.work_item_fact?.filter(
          (row) => row.type === 'agent_failed' && row.agent_session_id === b.sessionId
        ).length,
        1
      )
      assert.equal(provider.filter((entry) => entry.type === 'invocation').length, 1)
      assert.equal(provider.filter((entry) => entry.type === 'abort').length, 1)
      assert.equal(provider.filter((entry) => ['review-answer', 'recovery-stop'].includes(entry.type)).length, 0)
      assert.equal(entries(prepared.directory, 'fake-provider.jsonl').length, 0)
      check(`${name}: explicit B invoked once and exact local coordinator Stop aborted once`, true)
      saveJson(join(directory, 'final-before-reopen.json'), {
        stores: storeRows(directory),
        registry: readTables(join(registry, 'registry-v2.sqlite')),
        provider,
      })
      const finalRows = storeRows(directory)
      s.close()
      s = stores(directory)
      storeState.current = s
      assert.deepEqual(storeRows(directory), finalRows)
      assert.deepEqual(s.resident.getHostTaskIntent(b.actionId)?.outcome, outcome)
      await closeChild(coordinator)
      check(`${name}: full Task rows preserved except the explicit Task edit`, true)
    } finally {
      saveJson(join(directory, 'final-store-rows.json'), storeRows(directory))
      saveJson(join(directory, 'final-registry-rows.json'), readTables(join(registry, 'registry-v2.sqlite')))
      result.finalIntents = s.resident
        .conversation(null)
        .messages.map((message) => ({ id: message.id, status: message.status, error: message.error }))
      s.close()
      storeState.current = null
      if (!router.exited) await closeChild(router)
      save()
    }
  }

  try {
    save()
    process.stdout.write(`${JSON.stringify({ status: 'running', report: join(root, 'report.json') })}\n`)
    for (const name of ['prepare-cut', 'register-lost', 'task', 'policy'] as const) await runCase(name)
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = error instanceof Error ? error.stack : String(error)
  } finally {
    const cleanupErrors: { pid: number; error: string }[] = []
    if (storeState.current) {
      try {
        storeState.current.close()
      } catch (error) {
        cleanupErrors.push({ pid: process.pid, error: errorText(error) })
      }
      storeState.current = null
    }
    for (const child of children.filter((entry) => !entry.exited)) {
      try {
        await closeChild(child)
      } catch (error) {
        cleanupErrors.push({ pid: child.pid, error: errorText(error) })
        child.process.kill('SIGTERM')
        try {
          await waitFor(`owned-child-${child.pid}`, () => child.exited)
        } catch {
          child.process.kill('SIGKILL')
          try {
            await waitFor(`owned-child-force-${child.pid}`, () => child.exited)
          } catch (finalError) {
            cleanupErrors.push({ pid: child.pid, error: errorText(finalError) })
          }
        }
      }
    }
    proof.cleanupErrors = cleanupErrors
    proof.children = children.map(({ process: _process, ...child }) => child)
    proof.socketReadback = descriptors.map((descriptor) => ({
      jobId: descriptor.assignment.jobId,
      socketPath: join(descriptor.directory, 'client.sock'),
      exists: existsSync(join(descriptor.directory, 'client.sock')),
    }))
    if (
      cleanupErrors.length ||
      children.some((child) => !child.exited) ||
      descriptors.some((descriptor) => existsSync(join(descriptor.directory, 'client.sock')))
    ) {
      proof.status = 'failed'
      proof.cleanupFailure = true
    }
    save()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
    if (proof.status !== 'passed') process.exitCode = 1
  }
}

const [mode, directory] = process.argv.slice(2)
if (mode === '--router-child' && directory && process.argv.length === 4) await routerChild(resolve(directory))
else if (mode === '--coordinator-child' && directory && process.argv.length === 4)
  await coordinatorChild(resolve(directory))
else if (mode === '--run' && process.argv.length === 3) await main()
else throw Error('Use --run for this isolated local admission experiment')
