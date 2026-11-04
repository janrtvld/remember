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
  type HostTaskActionReview,
  HostTaskActionService,
  type HostTaskActionView,
} from '../src/main/hostTaskActionService'
import {
  type HostTaskPrepared,
  type HostTaskRouterDescriptor,
  type HostTaskRouterInput,
  validateHostTaskPrepared,
} from '../src/main/hostTaskExecutionProtocol'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../src/main/hostTaskProtocol'
import {
  createHostTaskServiceTransport,
  type HostTaskRawTransport,
  type HostTaskSnapshot,
} from '../src/main/hostTaskServiceTransport'
import { ResidentAgentStore, type ResidentTaskExecution } from '../src/main/residentAgentStore'

type Tables = Record<string, Record<string, unknown>[]>
type PreparedAction = { envelope: HostTaskEnvelopeV1; prepared: HostTaskPrepared }
type Config = { root: string; profile: string; registry: string; actions: { A: PreparedAction; B: PreparedAction } }
type SourceState = 'valid' | 'unavailable' | 'invalidated'
type RawChild = { request(op: string, payload?: Record<string, unknown>): Promise<unknown>; close(): void }
type RawRouter = HostTaskRawTransport & { close(): Promise<void> }
type Child = {
  process: ChildProcess
  pid: number
  kind: string
  directory: string
  exited: boolean
  code: number | null
  signal: string | null
}
type Control = { id: number; op: string; actionId?: string; suffix?: 'A' | 'B'; handle?: string }
type Reply = { id: number; result?: unknown; error?: string }
type StoreReadback = {
  resident: Tables
  evidence: Tables
  executions: { A: ResidentTaskExecution | null; B: ResidentTaskExecution | null }
}
type FakeInput = {
  signal: AbortSignal
  remote: unknown
  report(type: 'status' | 'reasoning', id: string, text: string): void
  onThread(threadId: string): void
  onCheckpoint(value: unknown): void
  tools: {
    name: string
    call(
      input: unknown,
      context: { threadId: string; turnId: string; callId: string; signal: AbortSignal }
    ): Promise<unknown>
  }[]
}

const script = fileURLToPath(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const targetId = 'synthetic-service-target'
const targetEpoch = 'synthetic-service-epoch-1'
const policyFingerprint = 'synthetic-service-policy-1'
const source = { spaceId: 'personal', slug: 'synthetic-service-source', revision: 'r1', explicit: true }
const secret = 'SYNTHETIC-E075-NEW-PRIVATE-COMPLETION'
const fixture = {
  repeatedReports: 120,
  repeatedId: 'repeated-status',
  reviewTtlMs: 300000,
  toolName: 'remember_memory' as const,
  reviewInput: {
    action: 'qa_review',
    question: 'Approve this isolated synthetic review; it performs no memory write.',
  },
}
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8'))
const saveJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

function validateFixture() {
  assert.equal(fixture.repeatedReports, 120)
  assert(fixture.repeatedReports > 100)
  assert.equal(fixture.reviewTtlMs, 300000)
  assert.equal(fixture.toolName, 'remember_memory')
  assert.deepEqual(Object.keys(fixture.reviewInput).sort(), ['action', 'question'])
  assert.equal(fixture.reviewInput.action, 'qa_review')
  assert(fixture.reviewInput.question.length > 0 && fixture.reviewInput.question.length <= 2000)
  assert(!fixture.reviewInput.question.includes(secret))
  assert.notEqual(repeatedText(0), repeatedText(fixture.repeatedReports - 1))
  return {
    fixture,
    mode: 'static fixture validation only; no stores, sockets, child processes or providers',
    scenarios: [
      'accepted-submit-ack-loss',
      'waiting-review-exit93',
      'stale-opaque-review',
      'completed-withheld-and-release',
      'terminal-receiver-restart',
      'historical-A-vs-B',
      'exact-B-stop',
      'unchanged-human-tasks',
    ],
  }
}

function ledger(root: string, type: string, values: Record<string, unknown> = {}) {
  appendFileSync(
    join(root, 'events.jsonl'),
    `${JSON.stringify({ at: Date.now(), pid: process.pid, type, ...values })}\n`
  )
}
function events(root: string): Record<string, unknown>[] {
  const file = join(root, 'events.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}
function repeatedText(index: number) {
  return `Synthetic progress update ${index + 1} of ${fixture.repeatedReports}.`
}

function readTables(file: string): Tables {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => {
          const table = String(row.name)
          assert.match(table, /^[a-z_]+$/)
          const columns = db.prepare(`PRAGMA table_info("${table}")`).all()
          assert(columns.length > 0)
          const primary = columns.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk))
          const other = columns.filter((c) => Number(c.pk) === 0).sort((a, b) => Number(a.cid) - Number(b.cid))
          const order = [...primary, ...other].map((c) => `"${String(c.name).replaceAll('"', '""')}"`).join(', ')
          return [table, JSON.parse(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all()))]
        })
    )
  } finally {
    db.close()
  }
}
function row(tables: Tables, table: string, field: string, value: string) {
  const matches = tables[table].filter((r) => r[field] === value)
  assert.equal(matches.length, 1, `One ${table}.${field}=${value}`)
  return matches[0]
}
function captureDatabases(config: Config) {
  const directory = join(config.root, 'exit93-raw-before-reopen')
  mkdirSync(directory, { mode: 0o700 })
  const files: { source: string; name: string; bytes: number; sha256: string }[] = []
  for (const [parent, name] of [
    [config.profile, 'conversation.sqlite'],
    [config.profile, 'evidence.sqlite'],
    [config.registry, 'registry-v2.sqlite'],
  ]) {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(parent, name + suffix)
      if (!existsSync(path)) continue
      const destination = join(directory, name + suffix)
      copyFileSync(path, destination)
      const data = readFileSync(destination)
      files.push({
        source: path,
        name: name + suffix,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      })
    }
  }
  saveJson(join(directory, 'manifest.json'), {
    at: Date.now(),
    boundary:
      'After receiver exit93 and before receiver/store reopen; existing WAL and SHM copied. Coordinator remains alive.',
    files,
  })
}

let wireId = 0
async function connectPersistent(
  root: string,
  descriptor: HostTaskRouterDescriptor,
  actor: string,
  dropAcceptedAck = false
): Promise<RawChild> {
  const path = join(descriptor.directory, 'client.sock')
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  let connected = false
  let closed = false
  let buffer = ''
  let pending: {
    id: number
    op: string
    resolve(value: unknown): void
    reject(error: Error): void
    timer: NodeJS.Timeout
  } | null = null
  const fail = (error: Error) => {
    if (pending) {
      const current = pending
      pending = null
      clearTimeout(current.timer)
      current.reject(error)
    }
  }
  socket.on('error', (error) => fail(error))
  socket.on('close', () => {
    closed = true
    fail(Error('qa-child-connection-closed'))
  })
  socket.on('data', (data: string) => {
    buffer += data
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
      fail(Error('qa-child-response-too-large'))
      socket.destroy()
      return
    }
    const end = buffer.indexOf('\n')
    if (end < 0) return
    const text = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    const current = pending
    if (!current) {
      socket.destroy(Error('qa-child-unsolicited-response'))
      return
    }
    pending = null
    clearTimeout(current.timer)
    try {
      assert.equal(buffer, '', 'One complete response per sequential RPC')
      const message = JSON.parse(text) as { id: number; result?: unknown; error?: string }
      assert.equal(message.id, current.id)
      if (message.error) throw Error(message.error)
      assert(Object.hasOwn(message, 'result'))
      ledger(root, 'child-response', {
        actor,
        jobId: descriptor.assignment.jobId,
        requestId: current.id,
        op: current.op,
        result: message.result,
      })
      if (
        dropAcceptedAck &&
        current.op === 'submit' &&
        descriptor.assignment.jobId === 'job-A' &&
        !existsSync(join(root, 'accepted-submit-ack-dropped.json'))
      ) {
        const receipt = message.result as { created: boolean; job: { id: string; inputHash: string } }
        assert.equal(receipt.created, true)
        assert.equal(receipt.job.id, descriptor.assignment.jobId)
        assert.equal(receipt.job.inputHash, descriptor.inputHash)
        const proof = {
          at: Date.now(),
          pid: process.pid,
          actor,
          descriptor,
          receipt,
          stage: 'Successful child submit response received; intentionally not delivered to router/service',
        }
        writeFileSync(join(root, 'accepted-submit-ack-dropped.json'), `${JSON.stringify(proof, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
        ledger(root, 'accepted-submit-ack-dropped', proof)
        current.reject(Error('qa-accepted-submit-ack-lost'))
        socket.destroy()
      } else current.resolve(message.result)
    } catch (error) {
      current.reject(Error(errorText(error)))
      socket.destroy()
    }
  })
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Error('qa-child-connect-timeout'))
    }, 5000)
    socket.once('connect', () => {
      clearTimeout(timer)
      connected = true
      done()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  ledger(root, 'child-connected-before-return', { actor, jobId: descriptor.assignment.jobId, path })
  return {
    request(op, payload = {}) {
      if (!connected || closed || socket.destroyed) return Promise.reject(Error('qa-child-not-connected'))
      if (pending) return Promise.reject(Error('qa-child-concurrent-request'))
      const id = ++wireId
      const text = `${JSON.stringify({ id, op, ...payload })}\n`
      if (Buffer.byteLength(text) > 70000) return Promise.reject(Error('qa-child-request-too-large'))
      return new Promise((resolveRequest, reject) => {
        pending = {
          id,
          op,
          resolve: resolveRequest,
          reject,
          timer: setTimeout(() => {
            fail(Error('qa-child-response-timeout'))
            socket.destroy()
          }, 10000),
        }
        ledger(root, 'child-request-written', { actor, jobId: descriptor.assignment.jobId, id, op, payload })
        // The connection already exists; there is no await or queue before this write.
        socket.write(text)
      })
    },
    close() {
      socket.destroy()
    },
  }
}

async function directSnapshot(config: Config, suffix: 'A' | 'B') {
  const descriptor = config.actions[suffix].prepared.descriptor
  const child = await connectPersistent(config.root, descriptor, 'parent-readback')
  try {
    const hello = (await child.request('hello')) as { sessionId: string; jobId: string | null; workspace: string }
    assert.equal(hello.workspace, descriptor.workspace)
    let afterSeq = 0
    const all: HostTaskSnapshot['events'] = []
    for (let page = 0; page < 110; page++) {
      const snapshot = (await child.request('snapshot', { afterSeq })) as HostTaskSnapshot
      assert.equal(snapshot.sessionId, hello.sessionId)
      if (snapshot.job) {
        assert.equal(snapshot.job.id, descriptor.assignment.jobId)
        assert.equal(snapshot.job.inputHash, descriptor.inputHash)
      }
      for (const event of snapshot.events) {
        assert(event.seq > afterSeq)
        afterSeq = event.seq
        all.push(event)
      }
      if (snapshot.events.length < 100) return { ...snapshot, events: all }
    }
    throw Error('qa-parent-journal-limit')
  } finally {
    child.close()
  }
}

async function coordinatorChild(root: string, suffix: 'A' | 'B') {
  const config = readJson<Config>(join(root, 'config.json'))
  const descriptor = config.actions[suffix].prepared.descriptor
  const { createCoordinator } = await import(join(repository, 'experiments/always-on-agent/coordinator.mjs'))
  let release: (() => void) | null = null
  const coordinator = await createCoordinator({
    directory: descriptor.directory,
    nativeClient: true,
    driver: {
      async runCodexWorker(input: FakeInput) {
        const threadId = `thread-service-${suffix}`
        const turnId = `turn-service-${suffix}`
        ledger(root, 'fake-provider-invoked', { suffix, jobId: descriptor.assignment.jobId, threadId, turnId })
        input.onThread(threadId)
        input.onCheckpoint({ computer: input.remote, threadId, turnId: null, previousTurnId: null })
        input.onCheckpoint({ computer: input.remote, threadId, turnId, previousTurnId: null })
        const count = suffix === 'A' ? fixture.repeatedReports : 2
        for (let i = 0; i < count; i++) input.report('status', fixture.repeatedId, repeatedText(i))
        input.report('reasoning', 'before-review', `Synthetic ${suffix} waits for explicit review.`)
        try {
          assert.equal(input.tools.length, 1)
          assert.equal(input.tools[0].name, fixture.toolName)
          const result = await input.tools[0].call(fixture.reviewInput, {
            threadId,
            turnId,
            callId: `call-service-${suffix}`,
            signal: input.signal,
          })
          ledger(root, 'fake-review-returned', { suffix, result })
          assert.deepEqual(result, { approved: true })
          await new Promise<void>((done, reject) => {
            const abort = () => {
              release = null
              reject(Error('agent-cancelled'))
            }
            release = () => {
              input.signal.removeEventListener('abort', abort)
              release = null
              done()
            }
            input.signal.addEventListener('abort', abort, { once: true })
            if (input.signal.aborted) abort()
            ledger(root, 'fake-awaiting-parent-finish', { suffix })
          })
          assert.equal(suffix, 'A', 'Only A receives explicit completion; B must Stop')
          input.report('status', 'completion-private', secret)
          const response = `${secret}: accepted synthetic A completion, no real effect.`
          ledger(root, 'fake-provider-returned', { suffix, response, threadId })
          return { response, threadId }
        } finally {
          input.onCheckpoint(null)
        }
      },
      async stopCodexRemoteCheckpoint(checkpoint: unknown) {
        ledger(root, 'fake-checkpoint-stop', { suffix, checkpoint })
      },
    },
  })
  process.on('message', async (raw) => {
    const command = raw as Control
    try {
      if (command.op === 'finish') {
        assert(release, 'Fake provider is waiting for parent finish')
        release()
        process.send?.({ id: command.id, result: true })
      } else if (command.op === 'close') {
        const snapshot = await directSnapshot(config, suffix)
        saveJson(join(root, `coordinator-${suffix}-cleanup-before.json`), snapshot)
        if (snapshot.job && !['completed', 'stopped'].includes(snapshot.job.phase)) {
          ledger(root, 'cleanup-stopping-owned-job', { suffix, job: snapshot.job })
          const child = await connectPersistent(root, descriptor, 'cleanup')
          try {
            await child.request('stop', { jobId: descriptor.assignment.jobId })
          } finally {
            child.close()
          }
        }
        await coordinator.close()
        ledger(root, 'coordinator-closed', { suffix })
        process.exit(0)
      } else throw Error('qa-coordinator-command-invalid')
    } catch (error) {
      process.send?.({ id: command.id, error: errorText(error) })
    }
  })
  process.send?.({ ready: true, pid: process.pid, socketPath: coordinator.socketPath })
}

async function receiverChild(root: string) {
  const config = readJson<Config>(join(root, 'config.json'))
  const resident = new ResidentAgentStore(join(config.profile, 'conversation.sqlite'))
  const evidence = new EvidenceStore(join(config.profile, 'evidence.sqlite'))
  const { openTaskServiceTransport } = await import(
    join(repository, 'experiments/always-on-agent/task-service-transport.mjs')
  )
  const raw = openTaskServiceTransport({
    directory: config.registry,
    targetId,
    targetEpoch,
    connectChild: (descriptor: HostTaskRouterDescriptor) => connectPersistent(root, descriptor, 'receiver', true),
  }) as RawRouter
  const service = new HostTaskActionService({
    resident,
    evidence,
    transport: createHostTaskServiceTransport(raw),
    readContext: () => ({ policyFingerprint, target: { targetId, targetEpoch, root: config.registry } }),
    validateSources: async (refs, signal) => {
      if (signal.aborted) throw Error('qa-validation-aborted')
      assert.deepEqual(refs, [source])
      const state = readJson<{ state: SourceState }>(join(root, 'source-state.json')).state
      assert(['valid', 'unavailable', 'invalidated'].includes(state))
      ledger(root, 'synthetic-source-validation', { refs, state })
      return state
    },
  })
  let busy = false
  const inspect = (): StoreReadback => ({
    resident: readTables(join(config.profile, 'conversation.sqlite')),
    evidence: readTables(join(config.profile, 'evidence.sqlite')),
    executions: { A: resident.hostTaskExecution('action-A'), B: resident.hostTaskExecution('action-B') },
  })
  process.on('message', async (message) => {
    const command = message as Control
    if (busy) {
      process.send?.({ id: command.id, error: 'qa-receiver-concurrent-command' })
      return
    }
    busy = true
    try {
      ledger(root, 'receiver-command', { command })
      let result: unknown
      if (command.op === 'start') {
        assert(command.suffix)
        const action = config.actions[command.suffix]
        result = await service.start(action.envelope, action.prepared)
      } else if (command.op === 'resume') {
        assert(command.actionId)
        result = await service.resume(command.actionId)
      } else if (command.op === 'answer') {
        assert(command.actionId && command.handle)
        result = await service.answer(command.actionId, command.handle, { approved: true })
      } else if (command.op === 'stop') {
        assert(command.actionId)
        result = await service.stop(command.actionId)
      } else if (command.op === 'inspect') result = inspect()
      else if (command.op === 'cut93') {
        ledger(root, 'forced-exit', {
          code: 93,
          stage: 'waiting observer after explicit accepted-job resume',
          readback: inspect(),
        })
        process.exit(93)
      } else if (command.op === 'close') {
        service.dispose()
        await raw.close()
        resident.close()
        evidence.close()
        ledger(root, 'receiver-closed')
        process.exit(0)
      } else throw Error('qa-receiver-command-invalid')
      ledger(root, 'receiver-command-result', { id: command.id, op: command.op, result })
      process.send?.({ id: command.id, result })
    } catch (error) {
      ledger(root, 'receiver-command-error', { id: command.id, op: command.op, error: errorText(error) })
      process.send?.({ id: command.id, error: errorText(error) })
    } finally {
      busy = false
    }
  })
  process.send?.({ ready: true, pid: process.pid })
}

function providerInput(): HostTaskRouterInput {
  return {
    prompt: 'Perform only the isolated E075 synthetic qa_review and wait for the parent fixture.',
    systemPrompt: 'Local fake provider only. No commands, Wiki reads or writes, model calls or external effects.',
    model: 'fake-model',
    effort: 'low',
    threadId: null,
    reviewTtlMs: fixture.reviewTtlMs,
    tools: [
      {
        name: fixture.toolName,
        description: 'Synthetic qa_review only; no memory actions or effects.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'question'],
          properties: { action: { const: 'qa_review' }, question: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    ],
  }
}
function makeEnvelope(
  item: ReturnType<EvidenceStore['createWorkItem']>,
  descriptor: HostTaskRouterDescriptor,
  input: HostTaskRouterInput,
  suffix: 'A' | 'B'
): HostTaskEnvelopeV1 {
  const { reviewTtlMs: _ttl, ...preparedInput } = input
  return {
    version: 1,
    actionId: `action-${suffix}`,
    workItemId: item.id,
    sessionId: `session-${suffix}`,
    jobId: `job-${suffix}`,
    userMessageId: `user-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    provider: 'codex',
    instruction: `Explicit synthetic Task ${suffix}; keep the human Task open.`,
    targetId,
    taskDefinition: hostTaskDefinition(item),
    policyFingerprint,
    sources: [source],
    startedAt: Date.now(),
    preparedInput: { ...preparedInput, workspace: descriptor.workspace },
  }
}
function assertReview(review: HostTaskActionReview, action: PreparedAction, snapshot: HostTaskSnapshot) {
  assert(snapshot.job)
  assert.equal(snapshot.requests.length, 1)
  const request = snapshot.requests[0]
  assert.equal(review.actionId, action.envelope.actionId)
  assert.equal(review.messageId, action.envelope.assistantMessageId)
  assert.equal(review.jobId, action.envelope.jobId)
  assert.equal(review.threadId, snapshot.job.threadId)
  assert.equal(review.turnId, snapshot.job.turnId)
  assert.equal(review.sessionId, snapshot.sessionId)
  assert.equal(review.requestId, request.id)
  assert.equal(review.expiresAt, request.payload.expiresAt)
  assert.equal(review.question, fixture.reviewInput.question)
  assert(review.expiresAt > Date.now())
  assert.equal(request.method, 'client-tool')
  assert.equal(request.payload.tool, fixture.toolName)
  assert.deepEqual(request.payload.input, fixture.reviewInput)
}
function assertRepeatedProjection(view: HostTaskActionView, snapshot: HostTaskSnapshot) {
  const reports = snapshot.events.filter((e) => e.type === 'worker-report' && e.payload.id === fixture.repeatedId)
  assert.equal(reports.length, fixture.repeatedReports)
  const observation = view.execution.observation
  assert(observation?.kind === 'host' && observation.delivery.kind === 'content')
  const steps = observation.delivery.steps.filter((step) => step.id === fixture.repeatedId)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].kind, 'status')
  assert.equal(steps[0].at, reports[0].createdAt)
  assert.equal(steps[0].text, repeatedText(fixture.repeatedReports - 1))
}
function aTerminal(readback: StoreReadback) {
  const execution = readback.executions.A
  assert(execution?.intent.outcome && execution.intent.outcomeReceipt && execution.terminal)
  const intent = row(readback.resident, 'assistant_task_run', 'action_id', 'action-A')
  return {
    outcome: execution.intent.outcome,
    outcomeJson: intent.outcome_json,
    outcomeHash: intent.outcome_hash,
    receipt: execution.intent.outcomeReceipt,
    terminal: execution.terminal,
    terminalReceivedAt: execution.terminalReceivedAt,
    message: row(readback.resident, 'assistant_message', 'id', 'assistant-A'),
    sources: execution.sources,
  }
}

async function main() {
  const fixtureProof = validateFixture()
  const root = mkdtempSync('/private/tmp/e075-')
  const profile = join(root, 'profile')
  const registry = join(root, 'host')
  mkdirSync(profile, { mode: 0o700 })
  mkdirSync(registry, { mode: 0o700 })
  const children: Child[] = []
  let config: Config | null = null
  let initialTaskRows: Record<string, unknown>[] = []
  let commandId = 0
  const proof: { status: string; checks: string[]; [key: string]: unknown } = {
    status: 'running',
    root,
    pid: process.pid,
    checks: [],
    boundary:
      'Actual local coordinator/receiver processes, real stores, unused action service and guarded frozen router; two explicitly started fake providers. Synthetic source dependency and qa_review. No product UI, native app, Mini, model, cloud, capture, audio or memory effect.',
  }
  const save = () => saveJson(join(root, 'report.json'), proof)
  const check = (label: string) => {
    proof.checks.push(label)
    save()
  }
  save()
  saveJson(join(root, 'fixture-validation.json'), fixtureProof)

  async function waitForExit(child: Child, timeout = 10000) {
    const end = Date.now() + timeout
    while (!child.exited && Date.now() < end) await delay(20)
    assert(child.exited, `Owned ${child.kind} PID${child.pid} must exit`)
  }
  async function launch(kind: '--coordinator-child' | '--receiver-child', suffix?: 'A' | 'B') {
    const childProcess = fork(script, [kind, root, ...(suffix ? [suffix] : [])], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    assert(childProcess.pid)
    const child: Child = {
      process: childProcess,
      pid: childProcess.pid,
      kind: suffix ? `${kind}-${suffix}` : kind,
      directory: root,
      exited: false,
      code: null,
      signal: null,
    }
    children.push(child)
    const log = join(root, `process-${child.pid}.log`)
    writeFileSync(log, '', { mode: 0o600 })
    childProcess.stdout?.on('data', (data: Buffer) => appendFileSync(log, data))
    childProcess.stderr?.on('data', (data: Buffer) => appendFileSync(log, data))
    childProcess.on('exit', (code, signal) => {
      child.exited = true
      child.code = code
      child.signal = signal
      ledger(root, 'owned-process-exit', { childPid: child.pid, kind: child.kind, code, signal })
    })
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => finish(Error('qa-child-ready-timeout')), 10000)
      const message = (input: unknown) => {
        const value = input as { ready?: boolean; pid?: number }
        if (value.ready) {
          if (value.pid !== child.pid) finish(Error('qa-child-ready-pid-mismatch'))
          else finish()
        }
      }
      const exit = () => finish(Error(`qa-child-exited-before-ready:${child.pid}`))
      const finish = (error?: Error) => {
        clearTimeout(timer)
        childProcess.off('message', message)
        childProcess.off('exit', exit)
        if (error) reject(error)
        else done()
      }
      childProcess.on('message', message)
      childProcess.once('exit', exit)
    })
    ledger(root, 'owned-process-ready', { childPid: child.pid, kind: child.kind })
    save()
    return child
  }
  async function rpc<T>(child: Child, op: string, payload: Omit<Partial<Control>, 'id' | 'op'> = {}): Promise<T> {
    assert(child.process.connected && !child.exited)
    const id = ++commandId
    return new Promise((done, reject) => {
      const timer = setTimeout(() => finish(Error(`qa-control-timeout:${op}`)), 30000)
      const receive = (input: unknown) => {
        const reply = input as Reply
        if (reply.id !== id) return
        saveJson(join(root, `control-${String(id).padStart(3, '0')}-${op}.json`), {
          childPid: child.pid,
          command: { id, op, ...payload },
          reply,
        })
        finish(reply.error ? Error(reply.error) : undefined, reply.result as T)
      }
      const exit = () => finish(Error(`qa-control-process-exited:${op}`))
      const finish = (error?: Error, result?: T) => {
        clearTimeout(timer)
        child.process.off('message', receive)
        child.process.off('exit', exit)
        if (error) reject(error)
        else done(result as T)
      }
      child.process.on('message', receive)
      child.process.once('exit', exit)
      child.process.send({ id, op, ...payload })
    })
  }
  async function rejected(child: Child, op: string, payload: Omit<Partial<Control>, 'id' | 'op'>, pattern: RegExp) {
    await assert.rejects(rpc(child, op, payload), (error: unknown) => {
      assert(error instanceof Error)
      assert.match(error.message, pattern)
      return true
    })
  }
  async function closeReceiver(child: Child) {
    child.process.send({ id: ++commandId, op: 'close' })
    await waitForExit(child)
    assert.equal(child.code, 0)
    assert.equal(child.signal, null)
  }
  async function waitLedger(type: string, suffix: string) {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      const entry = events(root).find((event) => event.type === type && event.suffix === suffix)
      if (entry) return entry
      await delay(20)
    }
    throw Error(`qa-ledger-timeout:${type}:${suffix}`)
  }
  const countSubmit = () =>
    events(root).filter((event) => event.type === 'child-request-written' && event.op === 'submit').length
  const countInvoke = (suffix: string) =>
    events(root).filter((event) => event.type === 'fake-provider-invoked' && event.suffix === suffix).length
  function setSource(state: SourceState) {
    saveJson(join(root, 'source-state.json'), { state })
    ledger(root, 'source-state-set', { state })
  }

  try {
    const resident = new ResidentAgentStore(join(profile, 'conversation.sqlite'))
    const evidence = new EvidenceStore(join(profile, 'evidence.sqlite'))
    const { openJobRouterV2 } = await import(join(repository, 'experiments/always-on-agent/job-router-v2.mjs'))
    const preparation = openJobRouterV2({
      directory: registry,
      targetId,
      targetEpoch,
      connectChild: async () => {
        throw Error('qa-prepare-must-not-connect')
      },
    }) as { request(input: string): Promise<unknown>; close(): void }
    const actions: Partial<Config['actions']> = {}
    try {
      for (const suffix of ['A', 'B'] as const) {
        const item = evidence.createWorkItem(
          `Synthetic service Task ${suffix}`,
          'Keep this human Task open and unchanged.'
        )
        const input = providerInput()
        const assignment = {
          jobId: `job-${suffix}`,
          messageId: `assistant-${suffix}`,
          workItemId: item.id,
          sessionId: `session-${suffix}`,
        }
        const descriptor = (await preparation.request(
          JSON.stringify({ op: 'prepare', assignment, input })
        )) as HostTaskRouterDescriptor
        const envelope = makeEnvelope(item, descriptor, input, suffix)
        const prepared: HostTaskPrepared = { version: 1, descriptor, input }
        validateHostTaskPrepared(envelope, prepared)
        actions[suffix] = { envelope, prepared }
        saveJson(join(root, `prepared-${suffix}.json`), actions[suffix])
        assert.equal(resident.hostTaskExecution(envelope.actionId), null)
      }
      assert(actions.A && actions.B)
      config = { root, profile, registry, actions: { A: actions.A, B: actions.B } }
      saveJson(join(root, 'config.json'), config)
      initialTaskRows = readTables(join(profile, 'evidence.sqlite')).work_item
      saveJson(join(root, 'initial-stores.json'), {
        resident: readTables(join(profile, 'conversation.sqlite')),
        evidence: readTables(join(profile, 'evidence.sqlite')),
      })
    } finally {
      preparation.close()
      resident.close()
      evidence.close()
    }
    setSource('valid')
    for (const action of Object.values(config.actions))
      mkdirSync(action.prepared.descriptor.directory, { recursive: true, mode: 0o700 })
    const hostA = await launch('--coordinator-child', 'A')
    const hostB = await launch('--coordinator-child', 'B')
    const first = await launch('--receiver-child')
    assert.equal(countSubmit(), 0)
    await rejected(first, 'start', { suffix: 'A' }, /^qa-accepted-submit-ack-lost$/)
    assert.equal(countSubmit(), 1)
    assert.equal(countInvoke('A'), 1)
    saveJson(join(root, 'lost-ack-service-readback.json'), await rpc(first, 'inspect'))
    const acceptedA = await directSnapshot(config, 'A')
    assert.equal(acceptedA.pid, hostA.pid)
    assert.equal(acceptedA.job?.phase, 'waiting')
    assert.equal(acceptedA.requests.length, 1)
    assert(acceptedA.events.length > 100)
    saveJson(join(root, 'accepted-A-after-lost-ack.json'), acceptedA)
    const beforeCut = await rpc<HostTaskActionView>(first, 'resume', { actionId: 'action-A' })
    assert.equal(countSubmit(), 1)
    assert.equal(countInvoke('A'), 1)
    assert.equal(beforeCut.reviews.length, 1)
    const oldHandle = beforeCut.reviews[0]
    assertReview(oldHandle, config.actions.A, acceptedA)
    assertRepeatedProjection(beforeCut, acceptedA)
    saveJson(join(root, 'review-before-exit93.json'), {
      view: beforeCut,
      snapshot: acceptedA,
      actualSubmitCount: countSubmit(),
      providerInvocations: countInvoke('A'),
    })
    first.process.send({ id: ++commandId, op: 'cut93' })
    await waitForExit(first)
    assert.equal(first.code, 93)
    assert.equal(first.signal, null)
    captureDatabases(config)
    check(
      'Exactly one successful accepted submit ACK lost; explicit resume shows >100 events and one updated report before waiting-review receiver exit93'
    )

    const second = await launch('--receiver-child')
    const resumed = await rpc<HostTaskActionView>(second, 'resume', { actionId: 'action-A' })
    assert.equal(resumed.reviews.length, 1)
    const handle = resumed.reviews[0]
    assert.notEqual(handle.id, oldHandle.id)
    assertReview(handle, config.actions.A, acceptedA)
    assertRepeatedProjection(resumed, acceptedA)
    assert.equal(countSubmit(), 1)
    assert.equal(countInvoke('A'), 1)
    await rejected(second, 'answer', { actionId: 'action-A', handle: oldHandle.id }, /review|handle/)
    await rejected(second, 'answer', { actionId: 'action-B', handle: handle.id }, /review|handle|busy|not-found/)
    await rejected(second, 'answer', { actionId: 'action-A', handle: `${handle.id}-forged` }, /review|handle/)
    assert.equal(
      events(root).filter((event) => event.type === 'child-request-written' && event.op === 'reply').length,
      0
    )
    await rpc<HostTaskActionView>(second, 'answer', { actionId: 'action-A', handle: handle.id })
    await waitLedger('fake-awaiting-parent-finish', 'A')
    assert.equal(
      events(root).filter((event) => event.type === 'fake-review-returned' && event.suffix === 'A').length,
      1
    )
    await rejected(second, 'answer', { actionId: 'action-A', handle: handle.id }, /review|handle/)
    const repliesA = events(root).filter(
      (event) => event.type === 'child-request-written' && event.op === 'reply' && event.jobId === 'job-A'
    )
    assert.equal(repliesA.length, 1)
    assert.deepEqual((repliesA[0].payload as Record<string, unknown>).result, {
      success: true,
      output: { approved: true },
    })
    saveJson(join(root, 'review-after-reopen.json'), {
      oldHandle,
      newHandle: handle,
      immutableSnapshot: acceptedA,
      resolvedWireReply: repliesA[0],
    })
    check(
      'Receiver restart creates a fresh exact review handle; old/forged/wrong-action answers rejected and one explicit synthetic approval forwarded'
    )

    setSource('unavailable')
    await rpc(hostA, 'finish')
    await waitLedger('fake-provider-returned', 'A')
    let completedA = await directSnapshot(config, 'A')
    for (let attempt = 0; completedA.job?.phase !== 'completed' && attempt < 100; attempt++) {
      await delay(20)
      completedA = await directSnapshot(config, 'A')
    }
    assert.equal(completedA.job?.phase, 'completed')
    assert(completedA.result)
    const completedResponse = completedA.result.response
    assert(completedResponse.includes(secret))
    saveJson(join(root, 'actual-A-completion.json'), completedA)
    const held = await rpc<HostTaskActionView>(second, 'resume', { actionId: 'action-A' })
    assert.equal(held.execution.state, 'completed')
    assert.equal(held.execution.intent.outcome, null)
    assert.equal(held.execution.intent.outcomeReceipt, null)
    assert(held.execution.terminal)
    assert.equal(held.issue, 'host-task-context-unavailable')
    assert.equal(held.execution.observation?.kind, 'host')
    assert(held.execution.observation?.kind === 'host')
    assert.deepEqual(held.execution.observation.delivery, { kind: 'withheld', reason: 'context-unavailable' })
    const heldRows = await rpc<StoreReadback>(second, 'inspect')
    assert(
      !JSON.stringify(heldRows).includes(secret),
      'No new private sentinel in either product store or persisted execution'
    )
    assert.deepEqual(heldRows.evidence.work_item, initialTaskRows)
    await rejected(second, 'start', { suffix: 'B' }, /host-task-action-busy/)
    const absentB = await directSnapshot(config, 'B')
    assert.equal(absentB.pid, hostB.pid)
    assert.equal(absentB.job, null)
    assert.equal(countInvoke('B'), 0)
    assert.equal(countSubmit(), 1)
    saveJson(join(root, 'completed-withheld.json'), { view: held, rows: heldRows, hostA: completedA, hostB: absentB })
    check(
      'New private terminal answer and step withheld under source-unavailable; no private store import and explicit B blocked'
    )

    setSource('valid')
    const released = await rpc<HostTaskActionView>(second, 'resume', { actionId: 'action-A' })
    assert.equal(released.execution.state, 'completed')
    assert(released.execution.intent.outcome && released.execution.intent.outcomeReceipt)
    assert.equal(released.execution.intent.outcome.response, completedResponse)
    assert.equal(released.execution.terminalReceivedAt, held.execution.terminalReceivedAt)
    assert.deepEqual(released.execution.terminal, held.execution.terminal)
    assertRepeatedProjection(released, completedA)
    assert.equal(released.execution.intent.outcome.steps.filter((step) => step.text === secret).length, 1)
    assert.equal(countSubmit(), 1)
    assert.equal(countInvoke('A'), 1)
    const releasedRows = await rpc<StoreReadback>(second, 'inspect')
    const terminalA = aTerminal(releasedRows)
    assert.equal(terminalA.outcomeHash, hash(terminalA.outcome))
    assert.deepEqual(releasedRows.evidence.work_item, initialTaskRows)
    saveJson(join(root, 'A-released.json'), { view: released, rows: releasedRows, terminalA })
    await closeReceiver(second)
    const third = await launch('--receiver-child')
    await rpc<HostTaskActionView>(third, 'resume', { actionId: 'action-A' })
    const afterRestart = await rpc<StoreReadback>(third, 'inspect')
    assert.deepEqual(aTerminal(afterRestart), terminalA)
    assert.equal(countSubmit(), 1)
    assert.equal(countInvoke('A'), 1)
    saveJson(join(root, 'A-terminal-after-receiver-restart.json'), afterRestart)
    check(
      'Restored source access reconstructs exact A journal projection; terminal receipt time and outcome bytes survive another receiver restart without submit replay'
    )

    let viewB = await rpc<HostTaskActionView>(third, 'start', { suffix: 'B' })
    for (let attempt = 0; viewB.reviews.length === 0 && attempt < 30; attempt++) {
      await delay(20)
      viewB = await rpc<HostTaskActionView>(third, 'resume', { actionId: 'action-B' })
    }
    assert.equal(viewB.reviews.length, 1)
    assert.equal(countSubmit(), 2)
    assert.equal(countInvoke('A'), 1)
    assert.equal(countInvoke('B'), 1)
    const beforeHistorical = await directSnapshot(config, 'B')
    assert.equal(beforeHistorical.job?.phase, 'waiting')
    assertReview(viewB.reviews[0], config.actions.B, beforeHistorical)
    const stopsBefore = events(root).filter(
      (event) => event.type === 'child-request-written' && event.op === 'stop' && event.jobId === 'job-B'
    ).length
    await rejected(third, 'answer', { actionId: 'action-A', handle: handle.id }, /review|handle|busy/)
    await rejected(third, 'answer', { actionId: 'action-B', handle: handle.id }, /review|handle/)
    await rejected(third, 'stop', { actionId: 'action-A' }, /host-task-action-busy/)
    const afterHistorical = await directSnapshot(config, 'B')
    assert.deepEqual(afterHistorical.job, beforeHistorical.job)
    assert.deepEqual(afterHistorical.requests, beforeHistorical.requests)
    assert.equal(
      events(root).filter(
        (event) => event.type === 'child-request-written' && event.op === 'stop' && event.jobId === 'job-B'
      ).length,
      stopsBefore
    )
    assert.deepEqual(aTerminal(await rpc<StoreReadback>(third, 'inspect')), terminalA)
    saveJson(join(root, 'historical-A-controls-during-B.json'), {
      viewB,
      beforeHistorical,
      afterHistorical,
      oldHandle: handle,
    })
    const stoppedB = await rpc<HostTaskActionView>(third, 'stop', { actionId: 'action-B' })
    assert.equal(stoppedB.execution.state, 'stopped')
    assert.equal(stoppedB.execution.intent.outcome?.status, 'stopped')
    assert(stoppedB.execution.intent.outcomeReceipt)
    assert.notEqual(stoppedB.execution.terminal?.stopReason, 'request-expired')
    const terminalB = await directSnapshot(config, 'B')
    assert.equal(terminalB.job?.phase, 'stopped')
    assert.equal(terminalB.requests.length, 0)
    assert(!terminalB.events.some((event) => event.type === 'review-expiry'))
    assert.equal(
      events(root).filter((event) => event.type === 'fake-review-returned' && event.suffix === 'B').length,
      0
    )
    const beforeFinal = await rpc<StoreReadback>(third, 'inspect')
    assert.deepEqual(aTerminal(beforeFinal), terminalA)
    assert.deepEqual(beforeFinal.evidence.work_item, initialTaskRows)
    saveJson(join(root, 'B-exact-stop.json'), { view: stoppedB, host: terminalB, rows: beforeFinal })
    await closeReceiver(third)
    const fourth = await launch('--receiver-child')
    await rpc(fourth, 'resume', { actionId: 'action-A' })
    await rpc(fourth, 'resume', { actionId: 'action-B' })
    const finalRows = await rpc<StoreReadback>(fourth, 'inspect')
    assert.deepEqual(finalRows, beforeFinal)
    assert.equal(countSubmit(), 2)
    assert.equal(countInvoke('A'), 1)
    assert.equal(countInvoke('B'), 1)
    const finalA = await directSnapshot(config, 'A')
    const finalB = await directSnapshot(config, 'B')
    assert.equal(finalA.job?.phase, 'completed')
    assert.equal(finalB.job?.phase, 'stopped')
    assert.equal(finalA.events.filter((event) => event.type === 'driver-invoked').length, 1)
    assert.equal(finalB.events.filter((event) => event.type === 'driver-invoked').length, 1)
    assert.equal(finalA.events.filter((event) => event.type === 'request-resolved').length, 1)
    assert.deepEqual(finalRows.evidence.work_item, initialTaskRows)
    saveJson(join(root, 'final-receiver-reopen.json'), {
      rows: finalRows,
      hostA: finalA,
      hostB: finalB,
      actualSubmits: countSubmit(),
    })
    check(
      'Only explicit B starts after delivered A; stale A controls cannot affect B, exact B Stop and final receiver reopen preserve both outcomes and human Task rows'
    )
    await closeReceiver(fourth)
    proof.status = 'passed'
    proof.measurements = {
      actualSubmits: countSubmit(),
      fakeInvocationsA: countInvoke('A'),
      fakeInvocationsB: countInvoke('B'),
      acceptedSubmitAckDrops: events(root).filter((event) => event.type === 'accepted-submit-ack-dropped').length,
      AOutcomeHash: terminalA.outcomeHash,
      AFirstTerminalReceivedAt: held.execution.terminalReceivedAt,
      AHostDurationMs: terminalA.outcome.durationMs,
      receiverPidCount: children.filter((child) => child.kind === '--receiver-child').length,
    }
    assert.equal(
      proof.measurements && (proof.measurements as { acceptedSubmitAckDrops: number }).acceptedSubmitAckDrops,
      1
    )
  } catch (error) {
    proof.status = 'failed'
    proof.error = errorText(error)
    proof.stack = error instanceof Error ? error.stack : null
  } finally {
    const cleanupErrors: string[] = []
    // Detach owned receivers first; the separate parent-owned coordinators close afterwards.
    const cleanupOrder = [
      ...children.filter((child) => child.kind === '--receiver-child'),
      ...children.filter((child) => child.kind !== '--receiver-child'),
    ]
    for (const child of cleanupOrder) {
      if (child.exited) continue
      try {
        if (child.process.connected) child.process.send({ id: ++commandId, op: 'close' })
        await waitForExit(child, 10000)
        if (child.code !== 0) cleanupErrors.push(`Unexpected cleanup exit ${child.pid}: ${child.code}/${child.signal}`)
      } catch (error) {
        cleanupErrors.push(errorText(error))
        child.process.kill('SIGTERM')
        try {
          await waitForExit(child, 1000)
        } catch {
          child.process.kill('SIGKILL')
          await waitForExit(child, 1000).catch((failure) => cleanupErrors.push(errorText(failure)))
        }
      }
    }
    proof.children = children.map(({ process: _process, ...child }) => child)
    proof.cleanupErrors = cleanupErrors
    proof.sockets = config
      ? Object.values(config.actions).map((action) => ({
          path: join(action.prepared.descriptor.directory, 'client.sock'),
          exists: existsSync(join(action.prepared.descriptor.directory, 'client.sock')),
        }))
      : []
    if (
      cleanupErrors.length ||
      children.some((child) => !child.exited) ||
      (proof.sockets as { exists: boolean }[]).some((socket) => socket.exists)
    )
      proof.status = 'failed'
    save()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
    if (proof.status !== 'passed') process.exitCode = 1
  }
}

const [mode, directory, suffix] = process.argv.slice(2)
if (mode === '--validate-fixture' && process.argv.length === 3)
  process.stdout.write(`${JSON.stringify(validateFixture(), null, 2)}\n`)
else if (mode === '--coordinator-child' && directory && (suffix === 'A' || suffix === 'B') && process.argv.length === 5)
  await coordinatorChild(resolve(directory), suffix)
else if (mode === '--receiver-child' && directory && process.argv.length === 4) await receiverChild(resolve(directory))
else if (mode === '--run' && process.argv.length === 3) await main()
else throw Error('Use --run for the isolated local process proof, or --validate-fixture for static fixture checks only')
