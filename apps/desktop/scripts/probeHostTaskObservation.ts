import assert from 'node:assert/strict'
import { type ChildProcess, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { AgentTurnStep } from '@remember/shared'
import { EvidenceStore } from '../src/main/dailyReview/evidenceStore'
import {
  type HostTaskHostObservation,
  type HostTaskPrepared,
  type HostTaskRouterDescriptor,
  type HostTaskRouterInput,
  validateHostTaskObservation,
} from '../src/main/hostTaskExecutionProtocol'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../src/main/hostTaskProtocol'
import { ResidentAgentStore, type SavedMemoryReceipt } from '../src/main/residentAgentStore'

type JournalEvent = { seq: number; type: string; createdAt: number; payload: Record<string, unknown> }
type HostSnapshot = {
  sessionId: string
  pid: number
  job: {
    id: string
    inputHash: string
    phase: HostTaskHostObservation['job']['phase']
    threadId: string | null
    turnId: string | null
    createdAt: number
    updatedAt: number
    stopReason?: 'request-expired'
  } | null
  events: JournalEvent[]
  result: { response: string; threadId: string } | null
}
type Router = { request(input: string): Promise<unknown>; close(): Promise<void> }
type RouterResult = { descriptor: HostTaskRouterDescriptor; state: string; snapshot: HostSnapshot | null }
type Child = {
  process: ChildProcess
  pid: number
  kind: string
  directory: string
  exited: boolean
  code: number | null
  signal: string | null
}
type ReceiverRequest = {
  cut: 90 | 91 | 92
  profile: string
  actionId: string
  observation: HostTaskHostObservation
}
type FakeInput = {
  prompt: string
  remote: unknown
  signal: AbortSignal
  report(type: 'status' | 'reasoning', id: string, text: string): void
  onThread(threadId: string): void
  onCheckpoint(value: unknown): void
}

const script = fileURLToPath(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const targetId = 'synthetic-local-target'
const targetEpoch = 'synthetic-epoch-1'
const source = { spaceId: 'personal', slug: 'synthetic-decision', revision: 'r1', explicit: true }
const answer = 'Synthetic completed answer E074; no real task or page was executed.'
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const delay = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const saveJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

function ledger(directory: string, type: string, value: Record<string, unknown> = {}) {
  appendFileSync(
    join(directory, 'events.jsonl'),
    `${JSON.stringify({ at: Date.now(), pid: process.pid, type, ...value })}\n`
  )
}

function events(directory: string): Record<string, unknown>[] {
  const file = join(directory, 'events.jsonl')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
}

function readTables(file: string): Record<string, Record<string, unknown>[]> {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    return Object.fromEntries(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => {
          const table = String(row.name)
          assert.match(table, /^[a-z_]+$/)
          const columns = database.prepare(`PRAGMA table_info("${table}")`).all()
          assert(columns.length > 0)
          const keys = columns.filter((column) => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk))
          const remaining = columns
            .filter((column) => Number(column.pk) === 0)
            .sort((a, b) => Number(a.cid) - Number(b.cid))
          const order = [...keys, ...remaining]
            .map((column) => `"${String(column.name).replaceAll('"', '""')}"`)
            .join(', ')
          return [
            table,
            JSON.parse(JSON.stringify(database.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all())),
          ]
        })
    )
  } finally {
    database.close()
  }
}

function captureCut(profile: string, root: string, cut: number) {
  const directory = join(root, `cut-${cut}-raw-before-reopen`)
  mkdirSync(directory, { mode: 0o700 })
  const files = []
  for (const name of ['conversation.sqlite', 'evidence.sqlite']) {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(profile, `${name}${suffix}`)
      if (!existsSync(path)) continue
      const destination = join(directory, `${name}${suffix}`)
      copyFileSync(path, destination)
      const bytes = readFileSync(destination)
      files.push({
        name: `${name}${suffix}`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  saveJson(join(directory, 'manifest.json'), {
    at: Date.now(),
    boundary: 'Copied after owned receiver exit and before any store or SQLite reopen; include WAL for recovery.',
    files,
  })
}

function openStores(directory: string, now?: () => number) {
  const resident = new ResidentAgentStore(join(directory, 'conversation.sqlite'), now ? { now } : {})
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

let socketSerial = 0
async function socketRequest(path: string, op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const socket = createConnection(path)
  socket.setEncoding('utf8')
  try {
    return await new Promise((done, reject) => {
      let settled = false
      let buffered = ''
      const id = ++socketSerial
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else done(value)
      }
      const timer = setTimeout(() => finish(Error('observation-rpc-timeout')), 5000)
      socket.once('error', (error) => finish(error))
      socket.once('close', () => finish(Error('observation-rpc-closed')))
      socket.on('data', (data) => {
        buffered += data
        if (buffered.length > 2 * 1024 * 1024) return finish(Error('observation-rpc-oversize'))
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        try {
          const message = JSON.parse(buffered.slice(0, newline))
          assert.equal(message.id, id)
          finish(message.error ? Error(String(message.error)) : null, message.result)
        } catch (error) {
          finish(Error(errorText(error)))
        }
      })
      socket.once('connect', () => socket.write(`${JSON.stringify({ id, op, ...payload })}\n`))
    })
  } finally {
    socket.destroy()
  }
}

async function coordinatorChild(directory: string) {
  const { createCoordinator } = await import(join(repository, 'experiments/always-on-agent/coordinator.mjs'))
  let release: (() => void) | null = null
  const coordinator = await createCoordinator({
    directory,
    nativeClient: true,
    driver: {
      async runCodexWorker(input: FakeInput) {
        ledger(directory, 'fake-invocation', { prompt: input.prompt })
        const threadId = 'thread-observation-A'
        input.onThread(threadId)
        input.onCheckpoint({ computer: input.remote, threadId, turnId: null, previousTurnId: null })
        input.onCheckpoint({ computer: input.remote, threadId, turnId: 'turn-observation-A', previousTurnId: null })
        input.report('status', 'first-step', 'Synthetic first step before receiver disconnect.')
        await new Promise<void>((done, reject) => {
          const abort = () => {
            release = null
            ledger(directory, 'fake-abort')
            input.onCheckpoint(null)
            reject(Error('agent-cancelled'))
          }
          release = () => {
            input.signal.removeEventListener('abort', abort)
            release = null
            ledger(directory, 'fake-release')
            done()
          }
          input.signal.addEventListener('abort', abort, { once: true })
          if (input.signal.aborted) abort()
        })
        input.report('reasoning', 'second-step', 'Synthetic second step after explicit harness release.')
        input.onCheckpoint(null)
        ledger(directory, 'fake-return', { response: answer, threadId })
        return { response: answer, threadId }
      },
      async stopCodexRemoteCheckpoint(checkpoint: unknown) {
        ledger(directory, 'fake-stop-checkpoint', { checkpoint })
      },
    },
  })
  process.on('message', async (raw) => {
    const message = raw as { id: number; op: string }
    try {
      if (message.op === 'release') {
        assert(release, 'Fake provider must be waiting for explicit release')
        release()
        process.send?.({ id: message.id, result: true })
      } else if (message.op === 'close') {
        const snapshot = (await socketRequest(coordinator.socketPath, 'snapshot')) as HostSnapshot
        if (snapshot.job && !['completed', 'stopped'].includes(snapshot.job.phase)) {
          ledger(directory, 'cleanup-stop', { jobId: snapshot.job.id })
          await socketRequest(coordinator.socketPath, 'stop')
        }
        await coordinator.close()
        process.exit(0)
      } else throw Error('unknown-coordinator-control')
    } catch (error) {
      process.send?.({ id: message.id, error: errorText(error) })
    }
  })
  process.send?.({ ready: true, pid: process.pid, socketPath: coordinator.socketPath })
}

async function receiverChild(root: string) {
  process.once('message', () => {
    const request = JSON.parse(readFileSync(join(root, 'receiver-request.json'), 'utf8')) as ReceiverRequest
    const { cut, profile, actionId, observation } = request
    const stores = openStores(profile, () => {
      const value = Date.now()
      ledger(root, 'receiver-clock-sample', { cut, actionId, source: 'Date.now in isolated receiver', value })
      return value
    })
    try {
      if (cut === 90) {
        // Test-only access to an exclusively synthetic store; no production fault hook.
        const database = (stores.resident as unknown as { database: DatabaseSync }).database
        database.function('e074_exit90', (id: unknown, status: unknown, text: unknown, cursor: unknown) => {
          ledger(root, 'forced-exit', {
            code: 90,
            stage: 'inside-transaction-after-message-update',
            id,
            status,
            text,
            cursor,
          })
          process.exit(90)
        })
        const messageId = stores.resident.getHostTaskIntent(actionId)?.envelope.assistantMessageId
        assert(messageId)
        assert.match(messageId, /^[A-Za-z0-9_-]+$/)
        assert.match(actionId, /^[A-Za-z0-9_-]+$/)
        database.exec(`CREATE TEMP TRIGGER e074_cut AFTER UPDATE ON assistant_message
          WHEN NEW.id = '${messageId}' AND NEW.status = 'completed'
          BEGIN SELECT e074_exit90(NEW.id, NEW.status, NEW.text,
            (SELECT cursor FROM assistant_task_execution WHERE action_id = '${actionId}')); END`)
      }
      if (cut === 90 || cut === 91) {
        const committed = stores.resident.commitHostTaskObservation(actionId, observation)
        ledger(root, 'terminal-committed', { cut, committed })
        if (cut === 90) throw Error('exit90-trigger-did-not-run')
        ledger(root, 'forced-exit', { code: 91, stage: 'after-resident-commit-before-evidence-projection' })
        process.exit(91)
      }
      const intent = stores.resident.getHostTaskIntent(actionId)
      assert(intent?.outcome)
      assert.equal(intent.outcomeReceipt, null)
      const receipt = stores.evidence.applyHostTaskOutcome(intent.envelope, intent.outcome)
      ledger(root, 'forced-exit', { code: 92, stage: 'after-evidence-commit-before-resident-ack', receipt })
      process.exit(92)
    } catch (error) {
      ledger(root, 'receiver-error', { cut, error: errorText(error) })
      stores.close()
      process.exit(1)
    }
  })
  process.send?.({ ready: true, pid: process.pid })
}

function providerInput(suffix: string): HostTaskRouterInput {
  return {
    prompt: `Synthetic observation task ${suffix}`,
    systemPrompt: 'Isolated fake provider only; no external commands or memory tools.',
    model: 'fake-model',
    effort: 'low',
    threadId: null,
    tools: [],
    reviewTtlMs: 300000,
  }
}

function makeEnvelope(
  item: ReturnType<EvidenceStore['createWorkItem']>,
  prepared: HostTaskPrepared,
  suffix: string,
  startedAt = Date.now()
): HostTaskEnvelopeV1 {
  const { reviewTtlMs, ...input } = prepared.input
  assert.equal(reviewTtlMs, 300000)
  const descriptor = prepared.descriptor
  return {
    version: 1,
    actionId: `action-${suffix}`,
    workItemId: item.id,
    sessionId: descriptor.assignment.sessionId,
    jobId: descriptor.assignment.jobId,
    userMessageId: `user-${suffix}`,
    assistantMessageId: descriptor.assignment.messageId,
    provider: 'codex',
    instruction: `Explicit synthetic action ${suffix}; preserve the human Task.`,
    targetId,
    taskDefinition: hostTaskDefinition(item),
    policyFingerprint: 'synthetic-policy-1',
    sources: [{ ...source }],
    startedAt,
    preparedInput: { ...input, workspace: descriptor.workspace },
  }
}

function observation(
  prepared: HostTaskPrepared,
  snapshot: HostSnapshot,
  collected: Map<number, JournalEvent>
): HostTaskHostObservation {
  assert(snapshot.job)
  const ordered = [...collected.values()].sort((a, b) => a.seq - b.seq)
  const reports = ordered.filter((event) => event.type === 'worker-report')
  const steps: AgentTurnStep[] = reports.map((event) => {
    assert(event.payload.type === 'status' || event.payload.type === 'reasoning')
    assert.equal(typeof event.payload.id, 'string')
    assert.equal(typeof event.payload.text, 'string')
    return {
      id: String(event.payload.id),
      kind: event.payload.type,
      text: String(event.payload.text),
      at: event.createdAt,
    }
  })
  const response = snapshot.result?.response ?? ''
  if (snapshot.job.phase === 'completed') {
    assert(snapshot.result)
    assert.equal(snapshot.result.threadId, snapshot.job.threadId)
  } else assert.equal(snapshot.result, null)
  return {
    version: 1,
    kind: 'host',
    preparedHash: hash(prepared),
    coordinatorSessionId: snapshot.sessionId,
    cursor: ordered.at(-1)?.seq ?? 0,
    job: {
      jobId: snapshot.job.id,
      inputHash: snapshot.job.inputHash,
      phase: snapshot.job.phase,
      threadId: snapshot.job.threadId,
      turnId: snapshot.job.turnId,
      createdAt: snapshot.job.createdAt,
      updatedAt: snapshot.job.updatedAt,
      stopReason: snapshot.job.stopReason ?? null,
    },
    terminalResultHash: snapshot.job.phase === 'completed' ? hash({ response, threadId: snapshot.job.threadId }) : null,
    delivery: { kind: 'content', response, steps },
  }
}

async function main() {
  const root = mkdtempSync('/private/tmp/e074-')
  const profile = join(root, 'profile')
  const registry = join(root, 'host')
  mkdirSync(profile, { mode: 0o700 })
  mkdirSync(registry, { mode: 0o700 })
  const proof: { status: string; checks: string[]; [key: string]: unknown } = {
    status: 'running',
    root,
    pid: process.pid,
    checks: [],
    boundary:
      'Actual local coordinator and receiver processes, real SQLite stores, one fake provider. Synthetic task/source receipts and separately labelled clock/state fixtures. No real provider, native app, Mini, cloud, capture or product adapter.',
  }
  const children: Child[] = []
  const descriptors: HostTaskRouterDescriptor[] = []
  let current: ReturnType<typeof openStores> | null = null
  let router: Router | null = null
  const save = () => saveJson(join(root, 'report.json'), proof)
  const check = (label: string, condition: unknown) => {
    assert(condition, label)
    proof.checks.push(label)
    save()
  }
  const reopen = (now?: () => number) => {
    current?.close()
    current = openStores(profile, now)
    return current
  }
  const closeStores = () => {
    current?.close()
    current = null
  }

  async function launch(kind: '--coordinator-child' | '--receiver-child', directory: string) {
    const process = fork(script, [kind, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    assert(process.pid)
    const child: Child = { process, pid: process.pid, kind, directory, exited: false, code: null, signal: null }
    children.push(child)
    const log = join(root, `process-${child.pid}.log`)
    writeFileSync(log, '', { mode: 0o600 })
    process.stdout?.on('data', (data: Buffer) => appendFileSync(log, data))
    process.stderr?.on('data', (data: Buffer) => appendFileSync(log, data))
    process.on('exit', (code, signal) => {
      child.exited = true
      child.code = code
      child.signal = signal
      ledger(root, 'process-exit', { pid: child.pid, code, signal })
    })
    await new Promise<void>((done, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        process.off('message', onMessage)
        process.off('exit', onExit)
        process.off('error', onError)
        if (error) reject(error)
        else done()
      }
      const onMessage = (value: unknown) => {
        if ((value as { ready?: boolean }).ready) {
          ledger(root, 'process-ready', { pid: child.pid, kind, directory, value })
          finish()
        }
      }
      const onExit = () => finish(Error('observation-child-exited-before-ready'))
      const onError = (error: Error) => finish(error)
      const timer = setTimeout(() => finish(Error('observation-child-ready-timeout')), 5000)
      process.on('message', onMessage)
      process.once('exit', onExit)
      process.once('error', onError)
    })
    return child
  }

  const waitForExit = async (child: Child, milliseconds = 5000) => {
    const end = Date.now() + milliseconds
    while (!child.exited && Date.now() < end) await delay(20)
    assert(child.exited, `Owned process ${child.pid} must exit`)
  }

  async function receiverCut(cut: 90 | 91 | 92, value: HostTaskHostObservation) {
    closeStores()
    saveJson(join(root, 'receiver-request.json'), {
      cut,
      profile,
      actionId: 'action-A',
      observation: value,
    } satisfies ReceiverRequest)
    copyFileSync(join(root, 'receiver-request.json'), join(root, `receiver-request-${cut}.json`))
    const child = await launch('--receiver-child', root)
    child.process.send({ op: 'commit' })
    await waitForExit(child)
    assert.equal(child.code, cut, `Exact receiver exit${cut}`)
    assert.equal(child.signal, null)
    captureCut(profile, root, cut)
    ledger(root, 'cut-captured-before-reopen', { cut, receiverPid: child.pid })
    check(`Receiver ${cut} exited at its declared stage and raw WAL was captured before reopen`, true)
  }

  async function prepare(stores: ReturnType<typeof openStores>, suffix: string, startedAt?: number) {
    assert(router)
    const item = stores.evidence.createWorkItem(`Synthetic task ${suffix}`, 'Human task must stay open.')
    const input = providerInput(suffix)
    const assignment = {
      jobId: `job-${suffix}`,
      messageId: `assistant-${suffix}`,
      workItemId: item.id,
      sessionId: `session-${suffix}`,
    }
    const descriptor = (await router.request(
      JSON.stringify({ op: 'prepare', assignment, input })
    )) as HostTaskRouterDescriptor
    assert.deepEqual(descriptor.assignment, assignment)
    const prepared: HostTaskPrepared = { version: 1, descriptor, input }
    const envelope = makeEnvelope(item, prepared, suffix, startedAt)
    stores.resident.createPreparedHostTaskIntent(envelope, prepared)
    stores.resident.acknowledgeHostTaskSession(envelope.actionId, stores.evidence.acceptHostTaskSession(envelope))
    descriptors.push(descriptor)
    saveJson(join(root, `prepared-${suffix}.json`), { envelope, prepared })
    return { envelope, prepared, item }
  }

  save()
  try {
    const { openJobRouterV2 } = await import(join(repository, 'experiments/always-on-agent/job-router-v2.mjs'))
    router = openJobRouterV2({
      directory: registry,
      targetId,
      targetEpoch,
      connectChild: async (descriptor: HostTaskRouterDescriptor) => {
        ledger(root, 'router-child-connect', { assignment: descriptor.assignment })
        return {
          request: (op: string, payload: Record<string, unknown> = {}) => {
            ledger(root, 'router-child-request', { assignment: descriptor.assignment, op, payload })
            return socketRequest(join(descriptor.directory, 'client.sock'), op, payload)
          },
          async close() {},
        }
      },
    }) as Router
    const stores = reopen()
    const a = await prepare(stores, 'A')
    const b = await prepare(stores, 'B')
    const taskRowsBefore = readTables(join(profile, 'evidence.sqlite')).work_item
    stores.resident.recordMemorySources([{ ...source }])
    const binding = {
      actionId: a.envelope.actionId,
      messageId: a.envelope.assistantMessageId,
      toolName: 'remember_memory' as const,
    }
    stores.resident.claimToolCall('saved-A', 'synthetic-verified-receipt-A', binding)
    stores.resident.claimToolCall('late-A', 'synthetic-unfinished-receipt-A', binding)
    const saved: SavedMemoryReceipt = {
      kind: 'saved-page',
      saved: true,
      proposed: false,
      spaceId: source.spaceId,
      slug: source.slug,
      revision: 'r2',
      title: 'Synthetic decision',
    }
    assert.throws(
      () => stores.resident.finishToolCall('saved-A', saved, { actionId: b.envelope.actionId, expectedRevision: 'r1' }),
      /host-task|source/
    )
    assert.throws(
      () =>
        stores.resident.finishToolCall('saved-A', saved, { actionId: a.envelope.actionId, expectedRevision: 'stale' }),
      /host-task|source/
    )
    for (const [index, result] of [
      { saved: false, proposed: true },
      { saved: false, error: 'uncertain' },
    ].entries()) {
      stores.resident.claimToolCall(`non-saved-${index}`, `synthetic-${index}`, binding)
      stores.resident.finishToolCall(`non-saved-${index}`, result)
    }
    assert.deepEqual(stores.resident.taskMemorySources(a.envelope.actionId), [source])
    stores.resident.finishToolCall('saved-A', saved, { actionId: a.envelope.actionId, expectedRevision: 'r1' })
    assert.deepEqual(stores.resident.taskMemorySources(a.envelope.actionId), [{ ...source, revision: 'r2' }])
    assert.deepEqual(stores.resident.taskMemorySources(b.envelope.actionId), [source])
    assert.deepEqual(stores.resident.memorySources(), [source])
    assert.deepEqual(stores.resident.getHostTaskIntent(a.envelope.actionId)?.envelope.sources, [source])
    assert.deepEqual(stores.resident.getHostTaskIntent(b.envelope.actionId)?.envelope.sources, [source])
    assert.equal(stores.resident.hostTaskResults(a.envelope.actionId).length, 1)
    assert.deepEqual(stores.resident.hostTaskResults(b.envelope.actionId), [])
    const sourceRows = readTables(join(profile, 'conversation.sqlite'))
    saveJson(join(root, 'source-isolation-before-reopen.json'), sourceRows)
    const sourceReopen = reopen()
    sourceReopen.resident.finishToolCall('saved-A', saved, { actionId: a.envelope.actionId, expectedRevision: 'r1' })
    assert.deepEqual(readTables(join(profile, 'conversation.sqlite')), sourceRows)
    check(
      'Synthetic verified receipt advances only action A; B, global sources and immutable envelopes stay r1; duplicate reopen is unchanged',
      true
    )

    const registered = await router.request(
      JSON.stringify({
        op: 'register',
        assignment: a.prepared.descriptor.assignment,
        input: a.prepared.input,
        prepared: a.prepared.descriptor,
      })
    )
    assert.deepEqual(registered, a.prepared.descriptor)
    sourceReopen.resident.commitHostTaskObservation(a.envelope.actionId, {
      version: 1,
      kind: 'admission',
      preparedHash: hash(a.prepared),
      state: 'registered',
    })
    sourceReopen.resident.commitHostTaskObservation(a.envelope.actionId, {
      version: 1,
      kind: 'admission',
      preparedHash: hash(a.prepared),
      state: 'dispatch-intent',
    })
    const coordinator = await launch('--coordinator-child', a.prepared.descriptor.directory)
    await router.request(JSON.stringify({ op: 'submit', assignment: a.prepared.descriptor.assignment }))
    const collected = new Map<number, JournalEvent>()
    let cursor = 0
    async function snapshot() {
      assert(router)
      for (let page = 0; page < 110; page++) {
        const suppliedAfterSeq = cursor
        const state = (await router.request(
          JSON.stringify({ op: 'snapshot', assignment: a.prepared.descriptor.assignment, afterSeq: suppliedAfterSeq })
        )) as RouterResult
        assert(state.snapshot)
        assert.equal(state.snapshot.pid, coordinator.pid)
        let previous = cursor
        for (const event of state.snapshot.events) {
          assert(event.seq > previous, 'Journal pages must be strictly ordered after the supplied cursor')
          previous = event.seq
          const prior = collected.get(event.seq)
          if (prior) assert.deepEqual(event, prior)
          collected.set(event.seq, event)
        }
        cursor = previous
        ledger(root, 'snapshot-page', {
          suppliedAfterSeq,
          cursor,
          snapshot: state.snapshot,
        })
        if (state.snapshot.events.length < 100) return state.snapshot
      }
      throw Error('observation-event-drain-limit')
    }
    let runningSnapshot: HostSnapshot | null = null
    for (let attempt = 0; attempt < 100; attempt++) {
      runningSnapshot = await snapshot()
      if (
        runningSnapshot.job?.phase === 'running' &&
        [...collected.values()].some((event) => event.type === 'worker-report')
      )
        break
      await delay(20)
    }
    assert.equal(runningSnapshot?.job?.phase, 'running')
    const running = observation(a.prepared, runningSnapshot, collected)
    assert.equal(running.delivery.kind, 'content')
    assert(running.delivery.kind === 'content')
    assert.equal(running.delivery.steps.length, 1)
    sourceReopen.resident.commitHostTaskObservation(a.envelope.actionId, running)
    const beforeCut = readTables(join(profile, 'conversation.sqlite'))
    const beforeProjection = readTables(join(profile, 'evidence.sqlite'))
    saveJson(join(root, 'running-before-cuts.json'), { running, resident: beforeCut, evidence: beforeProjection })
    closeStores()
    coordinator.process.send({ id: 1, op: 'release' })
    let completedSnapshot = runningSnapshot
    for (let attempt = 0; attempt < 100; attempt++) {
      completedSnapshot = await snapshot()
      if (completedSnapshot.job?.phase === 'completed') break
      await delay(20)
    }
    assert.equal(completedSnapshot.job?.phase, 'completed')
    const completed = observation(a.prepared, completedSnapshot, collected)
    assert(completed.delivery.kind === 'content')
    assert.equal(completed.delivery.response, answer)
    assert.equal(completed.delivery.steps.length, 2)
    assert.deepEqual(completed.delivery.steps[0], running.delivery.steps[0])
    const completionEvents = [...collected.values()].filter(
      (event) => event.type === 'job-transition' && event.payload.phase === 'completed'
    )
    const resultEvents = [...collected.values()].filter((event) => event.type === 'result-persisted')
    assert.equal(resultEvents.length, 1)
    assert.equal(completionEvents.length, 1)
    assert(resultEvents[0].seq < completionEvents[0].seq)
    saveJson(join(root, 'actual-host-completion.json'), {
      completedSnapshot,
      completed,
      events: [...collected.values()],
      clockSource: 'Host journal Date.now; no clock injection',
    })
    check(
      'One actual fake-provider completion has two accumulated reports and result-persisted precedes confirmed completed',
      true
    )

    await receiverCut(90, completed)
    const after90 = reopen()
    assert.deepEqual(readTables(join(profile, 'conversation.sqlite')), beforeCut)
    assert.deepEqual(readTables(join(profile, 'evidence.sqlite')), beforeProjection)
    assert.equal(after90.resident.hostTaskExecution(a.envelope.actionId)?.terminal, null)
    const cut90 = events(root).find((event) => event.type === 'forced-exit' && event.code === 90)
    assert.equal(cut90?.cursor, completed.cursor)
    assert.equal(cut90?.text, answer)
    assert.equal(cut90?.status, 'completed')
    saveJson(join(root, 'after-exit90-recovery.json'), {
      resident: readTables(join(profile, 'conversation.sqlite')),
      evidence: readTables(join(profile, 'evidence.sqlite')),
    })
    check(
      'Exit90 observed uncommitted execution and message writes; reopen restores exact previous running rows with no terminal outcome',
      true
    )

    await receiverCut(91, completed)
    const after91 = reopen()
    const committed = after91.resident.hostTaskExecution(a.envelope.actionId)
    assert(committed?.intent.outcome)
    assert(committed.terminal)
    assert.equal(committed.cursor, completed.cursor)
    assert.deepEqual(committed.observation, completed)
    assert.equal(committed.intent.outcome.response, answer)
    assert.deepEqual(committed.intent.outcome.steps, completed.delivery.steps)
    assert.equal(committed.intent.outcome.completedAt, committed.terminalReceivedAt)
    assert.equal(committed.intent.outcome.durationMs, completed.job.updatedAt - completed.job.createdAt)
    assert.equal(committed.terminal.hostCreatedAt, completed.job.createdAt)
    assert.equal(committed.terminal.hostTerminalAt, completed.job.updatedAt)
    assert.equal(committed.intent.outcomeReceipt, null)
    assert.deepEqual(readTables(join(profile, 'evidence.sqlite')), beforeProjection)
    const clockSample = events(root).filter((event) => event.type === 'receiver-clock-sample' && event.cut === 91)
    assert.equal(clockSample.length, 1)
    assert.equal(committed.terminalReceivedAt, clockSample[0].value)
    const outcome = committed.intent.outcome
    const message = after91.resident.get(a.envelope.assistantMessageId)
    const terminal = committed.terminal
    const outcomeHash = hash(outcome)
    const storedOutcome = readTables(join(profile, 'conversation.sqlite')).assistant_task_run.find(
      (row) => row.action_id === a.envelope.actionId
    )
    assert(storedOutcome)
    const outcomeBytes = { json: storedOutcome.outcome_json, hash: storedOutcome.outcome_hash }
    assert.equal(outcomeBytes.hash, outcomeHash)
    saveJson(join(root, 'after-exit91-recovery.json'), {
      committed,
      message,
      resident: readTables(join(profile, 'conversation.sqlite')),
      evidence: readTables(join(profile, 'evidence.sqlite')),
    })
    check(
      'Exit91 reopens one atomic completed observation/message/outcome before Evidence projection; local receipt is sampled once and host duration retained',
      true
    )

    await receiverCut(92, completed)
    const after92 = reopen()
    assert.equal(after92.resident.getHostTaskIntent(a.envelope.actionId)?.outcomeReceipt, null)
    const projectedBefore = readTables(join(profile, 'evidence.sqlite'))
    const receipt = after92.evidence.applyHostTaskOutcome(a.envelope, outcome)
    assert.equal(receipt.outcomeHash, outcomeHash)
    assert.deepEqual(readTables(join(profile, 'evidence.sqlite')), projectedBefore)
    after92.resident.acknowledgeHostTaskOutcome(a.envelope.actionId, receipt)
    assert.equal(
      projectedBefore.work_item_agent_session.filter(
        (row) => row.id === a.envelope.sessionId && row.status === 'completed'
      ).length,
      1
    )
    assert.equal(
      projectedBefore.work_item_fact.filter((row) => row.id === `host-task:${a.envelope.actionId}:terminal`).length,
      1
    )
    assert.deepEqual(projectedBefore.work_item, taskRowsBefore)
    saveJson(join(root, 'after-exit92-redelivery.json'), {
      receipt,
      resident: readTables(join(profile, 'conversation.sqlite')),
      evidence: projectedBefore,
    })
    check(
      'Exit92 redelivers metadata without duplicate session/fact, records exact ACK and never changes human Task rows',
      true
    )

    const afterCompletion = await snapshot()
    const replay = observation(a.prepared, afterCompletion, collected)
    assert(replay.cursor > completionEvents[0].seq)
    const reconnect = await snapshot()
    assert(reconnect.events.every((event) => event.seq > replay.cursor))
    assert(
      !reconnect.events.some(
        (event) =>
          event.type === 'worker-report' ||
          event.type === 'result-persisted' ||
          (event.type === 'job-transition' && event.payload.phase === 'completed')
      )
    )
    const replayWithLaterCursor = observation(a.prepared, reconnect, collected)
    assert(replayWithLaterCursor.cursor > replay.cursor)
    let replayClockSamples = 0
    const replayStores = reopen(() => {
      replayClockSamples++
      return outcome.completedAt + 86400000
    })
    replayStores.resident.commitHostTaskObservation(a.envelope.actionId, replayWithLaterCursor)
    assert.equal(replayClockSamples, 0)
    assert.deepEqual(replayStores.resident.getHostTaskIntent(a.envelope.actionId)?.outcome, outcome)
    assert.deepEqual(replayStores.resident.get(a.envelope.assistantMessageId), message)
    assert.deepEqual(replayStores.resident.hostTaskExecution(a.envelope.actionId)?.terminal, terminal)
    assert.equal(
      replayStores.resident.hostTaskExecution(a.envelope.actionId)?.terminalReceivedAt,
      committed.terminalReceivedAt
    )
    assert.equal(hash(replayStores.resident.getHostTaskIntent(a.envelope.actionId)?.outcome), outcomeHash)
    const replayRow = readTables(join(profile, 'conversation.sqlite')).assistant_task_run.find(
      (row) => row.action_id === a.envelope.actionId
    )
    assert(replayRow)
    assert.deepEqual({ json: replayRow.outcome_json, hash: replayRow.outcome_hash }, outcomeBytes)
    assert.deepEqual(replayStores.evidence.applyHostTaskOutcome(a.envelope, outcome), receipt)
    assert.deepEqual(readTables(join(profile, 'evidence.sqlite')), projectedBefore)
    assert.equal(replayStores.resident.hostTaskExecution(b.envelope.actionId)?.state, 'prepared')
    assert(
      !events(root).some(
        (event) =>
          event.type === 'router-child-connect' && (event.assignment as { jobId?: string }).jobId === b.envelope.jobId
      )
    )
    assert.equal(events(a.prepared.descriptor.directory).filter((event) => event.type === 'fake-invocation').length, 1)
    saveJson(join(root, 'terminal-cursor-redelivery.json'), {
      requestedAfterSeq: replay.cursor,
      reconnect,
      replayWithLaterCursor,
      preservedTerminal: terminal,
      outcome,
      outcomeHash,
      outcomeBytes,
      replayClockSamples,
    })
    check(
      'Reconnect beyond terminal event preserves full earlier steps/result/host times and pinned outcome without clock resample or second provider; B remains prepared only',
      true
    )

    replayStores.resident.resetContext()
    const invalidatedBefore = readTables(join(profile, 'conversation.sqlite'))
    replayStores.resident.finishToolCall('saved-A', saved, { actionId: a.envelope.actionId, expectedRevision: 'r1' })
    assert.throws(
      () =>
        replayStores.resident.finishToolCall(
          'late-A',
          { ...saved, revision: 'r3' },
          { actionId: a.envelope.actionId, expectedRevision: 'r2' }
        ),
      /context-invalidated/
    )
    assert.throws(
      () => replayStores.resident.recordTaskMemorySources(a.envelope.actionId, [{ ...source, revision: 'r3' }]),
      /context-invalidated/
    )
    assert.deepEqual(readTables(join(profile, 'conversation.sqlite')), invalidatedBefore)
    check(
      'Terminal invalidation retains committed history and duplicates but blocks late new private receipt/source advancement',
      true
    )

    closeStores()
    const contrastDirectory = join(root, 'synthetic-clock-and-withheld')
    mkdirSync(contrastDirectory, { mode: 0o700 })
    let clientNow = completed.job.createdAt + 7 * 86400000
    let samples = 0
    const contrasts = openStores(contrastDirectory, () => {
      samples++
      return clientNow
    })
    try {
      const c = await prepare(contrasts, 'Clock', clientNow - 500)
      for (const state of ['registered', 'dispatch-intent'])
        contrasts.resident.commitHostTaskObservation(c.envelope.actionId, {
          version: 1,
          kind: 'admission',
          preparedHash: hash(c.prepared),
          state,
        })
      const offset: HostTaskHostObservation = {
        ...completed,
        preparedHash: hash(c.prepared),
        job: { ...completed.job, jobId: c.envelope.jobId, inputHash: c.prepared.descriptor.inputHash },
      }
      const offsetResult = contrasts.resident.commitHostTaskObservation(c.envelope.actionId, offset)
      assert.equal(offsetResult.intent.outcome?.completedAt, clientNow)
      assert.equal(offsetResult.intent.outcome?.durationMs, outcome.durationMs)
      const sampleCount = samples
      clientNow += 86400000
      contrasts.resident.commitHostTaskObservation(c.envelope.actionId, {
        ...offset,
        cursor: offset.cursor + 1,
        coordinatorSessionId: 'synthetic-reconnect-session',
      })
      const offsetReplaySamples = samples - sampleCount
      assert.equal(offsetReplaySamples, 0)
      assert.deepEqual(contrasts.resident.getHostTaskIntent(c.envelope.actionId)?.outcome, offsetResult.intent.outcome)
      const d = await prepare(contrasts, 'Withheld', clientNow - 500)
      for (const state of ['registered', 'dispatch-intent'])
        contrasts.resident.commitHostTaskObservation(d.envelope.actionId, {
          version: 1,
          kind: 'admission',
          preparedHash: hash(d.prepared),
          state,
        })
      const privateResponse = 'SYNTHETIC-WITHHELD-PRIVATE-NONCE-E074'
      const content: HostTaskHostObservation = {
        ...completed,
        preparedHash: hash(d.prepared),
        job: { ...completed.job, jobId: d.envelope.jobId, inputHash: d.prepared.descriptor.inputHash },
        terminalResultHash: hash({ response: privateResponse, threadId: completed.job.threadId }),
        delivery: { kind: 'content', response: privateResponse, steps: completed.delivery.steps },
      }
      const withheld = { ...content, delivery: { kind: 'withheld' as const, reason: 'context-unavailable' as const } }
      const held = contrasts.resident.commitHostTaskObservation(d.envelope.actionId, withheld)
      assert.equal(held.intent.outcome, null)
      assert(held.terminal)
      const heldRows = readTables(join(contrastDirectory, 'conversation.sqlite'))
      assert(!JSON.stringify(heldRows).includes(privateResponse))
      saveJson(join(root, 'withheld-metadata-only.json'), {
        boundary: 'Synthetic delivery contrast; not a real access outage',
        held,
        heldRows,
      })
      const withheldSamples = samples
      clientNow += 1000
      const released = contrasts.resident.commitHostTaskObservation(d.envelope.actionId, content)
      const withheldReleaseSamples = samples - withheldSamples
      assert.equal(withheldReleaseSamples, 0)
      assert.equal(released.terminalReceivedAt, held.terminalReceivedAt)
      assert.equal(released.intent.outcome?.completedAt, held.terminalReceivedAt)
      const e = await prepare(contrasts, 'ClockRegression', clientNow + 1)
      for (const state of ['registered', 'dispatch-intent'])
        contrasts.resident.commitHostTaskObservation(e.envelope.actionId, {
          version: 1,
          kind: 'admission',
          preparedHash: hash(e.prepared),
          state,
        })
      const regressionBefore = readTables(join(contrastDirectory, 'conversation.sqlite'))
      assert.throws(
        () =>
          contrasts.resident.commitHostTaskObservation(e.envelope.actionId, {
            ...completed,
            preparedHash: hash(e.prepared),
            job: { ...completed.job, jobId: e.envelope.jobId, inputHash: e.prepared.descriptor.inputHash },
          }),
        /host-task-received-at-invalid/
      )
      assert.deepEqual(readTables(join(contrastDirectory, 'conversation.sqlite')), regressionBefore)
      saveJson(join(root, 'clock-contrasts.json'), {
        boundary:
          'Synthetic client envelope/receiver clocks only; original host times copied from actual A completion; no OS clock changes and no Clock/Withheld provider started.',
        hostCreatedAt: completed.job.createdAt,
        hostTerminalAt: completed.job.updatedAt,
        offsetResult,
        offsetReplaySamples,
        withheldReleaseSamples,
        rejectedClockSamples: samples - withheldSamples,
        held,
        released,
        rejectedStartedAt: e.envelope.startedAt,
        rejectedNow: clientNow,
      })
      check(
        'Separate synthetic clock offset uses host duration and pinned local completion; withheld metadata omits private text and releases without resampling; backwards client receipt rejects',
        true
      )
    } finally {
      contrasts.close()
    }

    const stateDirectory = join(root, 'synthetic-result-persisted-only')
    mkdirSync(stateDirectory, { mode: 0o700 })
    const { openJournal } = await import(join(repository, 'experiments/always-on-agent/journal.mjs'))
    const journal = openJournal(join(stateDirectory, 'job.sqlite'))
    try {
      journal.submit({
        id: a.envelope.jobId,
        spec: { ...a.prepared.input, workspace: a.prepared.descriptor.workspace },
      })
      journal.transition({ phase: 'thread-bound', threadId: 'fixture-thread' })
      journal.transition({ phase: 'turn-start-intent' })
      journal.transition({ phase: 'running', turnId: 'fixture-turn' })
      journal.appendEvent('result-persisted', {
        result: { response: 'Synthetic persisted result without completion', threadId: 'fixture-thread' },
      })
      assert.equal(journal.getJob().phase, 'running')
      const fixtureEvents = journal.events({ afterSeq: 0 }) as JournalEvent[]
      const fixtureObservation = observation(
        a.prepared,
        {
          sessionId: journal.sessionId,
          pid: process.pid,
          job: journal.getJob(),
          events: fixtureEvents,
          result: null,
        },
        new Map(fixtureEvents.map((event) => [event.seq, event]))
      )
      const validatedFixture = validateHostTaskObservation(a.envelope, a.prepared, fixtureObservation)
      assert.equal(validatedFixture.terminal, null)
      assert.equal(fixtureObservation.terminalResultHash, null)
      saveJson(join(root, 'result-persisted-not-terminal.json'), {
        boundary: 'Direct synthetic journal fixture, not a provider-crash measurement',
        job: journal.getJob(),
        events: fixtureEvents,
        observation: fixtureObservation,
        terminal: validatedFixture.terminal,
      })
      check(
        'Separate journal fixture has result-persisted while phase remains running; it is not reported as completion',
        true
      )
    } finally {
      journal.close()
    }
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = errorText(error)
    proof.stack = error instanceof Error ? error.stack : null
  } finally {
    closeStores()
    const cleanupErrors: string[] = []
    try {
      await router?.close()
    } catch (error) {
      cleanupErrors.push(errorText(error))
    }
    for (const child of children) {
      if (child.exited) continue
      try {
        if (child.process.connected) child.process.send({ id: 9999, op: 'close' })
        await waitForExit(child, 3000)
        if (child.code !== 0) cleanupErrors.push(`Unexpected cleanup exit ${child.pid}: ${child.code}/${child.signal}`)
      } catch (error) {
        cleanupErrors.push(errorText(error))
        child.process.kill('SIGTERM')
        try {
          await waitForExit(child, 1000)
        } catch {
          child.process.kill('SIGKILL')
          await waitForExit(child).catch((failure) => cleanupErrors.push(errorText(failure)))
        }
      }
    }
    proof.children = children.map(({ process: _process, ...child }) => child)
    proof.cleanupErrors = cleanupErrors
    proof.sockets = descriptors.map((descriptor) => ({
      path: join(descriptor.directory, 'client.sock'),
      exists: existsSync(join(descriptor.directory, 'client.sock')),
    }))
    if (
      cleanupErrors.length ||
      children.some((child) => !child.exited) ||
      descriptors.some((descriptor) => existsSync(join(descriptor.directory, 'client.sock')))
    )
      proof.status = 'failed'
    save()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
    if (proof.status !== 'passed') process.exitCode = 1
  }
}

const [mode, directory] = process.argv.slice(2)
if (mode === '--coordinator-child' && directory && process.argv.length === 4) await coordinatorChild(resolve(directory))
else if (mode === '--receiver-child' && directory && process.argv.length === 4) await receiverChild(resolve(directory))
else if (mode === '--run' && process.argv.length === 3) await main()
else throw Error('Use --run for this isolated local observation experiment')
