import assert from 'node:assert/strict'
import { type ChildProcess, fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { WikiPage, WikiSpace } from '@remember/shared'
import { EvidenceStore } from '../src/main/dailyReview/evidenceStore'
import {
  createKnowledgePageAt,
  initializeKnowledgeStore,
  listKnowledgePagesAt,
  personalWikiDirectory,
  saveKnowledgePageAt,
} from '../src/main/dailyReview/knowledgeStore'
import { HostTaskActionService, type HostTaskActionView } from '../src/main/hostTaskActionService'
import {
  type HostTaskPrepared,
  type HostTaskRouterDescriptor,
  type HostTaskRouterInput,
  validateHostTaskPrepared,
} from '../src/main/hostTaskExecutionProtocol'
import { HostTaskMemoryAdapter, type HostTaskMemoryReview } from '../src/main/hostTaskMemoryAdapter'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../src/main/hostTaskProtocol'
import {
  createHostTaskServiceTransport,
  type HostTaskRawTransport,
  type HostTaskSnapshot,
} from '../src/main/hostTaskServiceTransport'
import { ResidentAgentStore, type ResidentTaskExecution } from '../src/main/residentAgentStore'
import { closeWikiHistoryStore, getWikiPageHistory } from '../src/main/wikiHistoryStore'

type Suffix = 'A' | 'B'
type CaseId = 'stop' | 'dispose' | 'positive'
type Action = { envelope: HostTaskEnvelopeV1; prepared: HostTaskPrepared }
type Config = { root: string; caseId: CaseId; profile: string; registry: string; actions: Record<Suffix, Action> }
type Tables = Record<string, Record<string, unknown>[]>
type RawChild = { request(op: string, payload?: Record<string, unknown>): Promise<unknown>; close(): void }
type RawRouter = HostTaskRawTransport & { close(): Promise<void> }
type Readback = {
  resident: Tables
  evidence: Tables
  wiki: Tables
  pages: WikiPage[]
  A: ResidentTaskExecution | null
  B: ResidentTaskExecution | null
  global: ReturnType<ResidentAgentStore['memorySources']>
  resultLookup: Record<Suffix, 'intent-not-created' | 'queried'>
  resultsA: ReturnType<ResidentAgentStore['hostTaskResults']>
  resultsB: ReturnType<ResidentAgentStore['hostTaskResults']>
}
type Child = {
  process: ChildProcess
  pid: number
  root: string
  kind: 'receiver' | 'coordinator'
  suffix?: Suffix
  exited: boolean
  code: number | null
  signal: string | null
}
type Control = { id: number; op: string; suffix?: Suffix; actionId?: string; handle?: string }
type Review = { id: string; review: HostTaskMemoryReview; aborted: boolean; answered: boolean }
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
const targetId = 'synthetic-composition-target'
const targetEpoch = 'synthetic-composition-epoch-1'
const policyFingerprint = 'synthetic-composition-policy-1'
const original = 'SYNTHETIC_A_OLD_VALUE'
const replacement = 'SYNTHETIC_A_REVIEWED_VALUE'
const unrelated = 'SYNTHETIC_B_PRIVATE_CONTROL'
const globalControl = 'SYNTHETIC_GLOBAL_CONTROL'
const secret = 'SYNTHETIC-E077-PRIVATE-TERMINAL-ANSWER'
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8'))
const saveJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const space = (): WikiSpace => ({
  id: 'personal',
  name: 'Synthetic Personal',
  description: '',
  icon: 'book',
  color: 'slate',
  provider: 'local',
  maintenanceMode: 'auto',
  status: 'ready',
  webUrl: null,
  lastSyncedAt: null,
  error: null,
})

function ledger(root: string, type: string, detail: Record<string, unknown> = {}) {
  appendFileSync(
    join(root, 'events.jsonl'),
    `${JSON.stringify({ at: Date.now(), pid: process.pid, type, ...detail })}\n`
  )
}
function events(root: string) {
  return existsSync(join(root, 'events.jsonl'))
    ? readFileSync(join(root, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}
function rows(path: string): Tables {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row) => {
          const table = String(row.name)
          assert.match(table, /^[a-z_]+$/)
          const columns = db.prepare(`PRAGMA table_info("${table}")`).all()
          const order = [
            ...columns.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)),
            ...columns.filter((c) => Number(c.pk) === 0).sort((a, b) => Number(a.cid) - Number(b.cid)),
          ]
            .map((c) => `"${String(c.name).replaceAll('"', '""')}"`)
            .join(', ')
          assert(order)
          return [table, plain(db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).all())]
        })
    )
  } finally {
    db.close()
  }
}
function rawCopy(config: Config, name: string) {
  const dest = join(config.root, name)
  mkdirSync(dest, { mode: 0o700 })
  const files: { source: string; name: string; bytes: number; sha256: string }[] = []
  const copy = (path: string, name: string) => {
    if (!existsSync(path)) return
    const target = join(dest, name)
    mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 })
    copyFileSync(path, target)
    const bytes = readFileSync(target)
    files.push({ source: path, name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const path of [
    join(config.profile, 'conversation.sqlite'),
    join(config.profile, 'evidence.sqlite'),
    join(config.profile, 'daily-review/wiki.sqlite'),
    join(config.registry, 'registry-v2.sqlite'),
    ...Object.values(config.actions).map((action) => join(action.prepared.descriptor.directory, 'job.sqlite')),
  ])
    for (const suffix of ['', '-wal', '-shm']) copy(path + suffix, relative(config.root, path + suffix))
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) copy(path, relative(config.root, path))
      else throw Error('qa-unexpected-wiki-file')
    }
  }
  walk(join(config.profile, 'daily-review/wiki'))
  saveJson(join(dest, 'manifest.json'), {
    coordinatorCopyBoundary:
      'Coordinator may remain alive: copied job files are diagnostics, not an atomic SQLite backup. Actual protocol snapshots are retained separately.',
    at: Date.now(),
    beforeProductReadOrReopen: true,
    files,
  })
  return { directory: dest, files }
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
    payload: Record<string, unknown>
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
        current.op === 'reply' &&
        (current.payload.result as { output?: { kind?: string } })?.output?.kind === 'saved-page' &&
        descriptor.assignment.jobId === 'job-A' &&
        !existsSync(join(root, 'accepted-reply-ack-dropped.json'))
      ) {
        const receipt = message.result as { id: string; sessionId: string; status: string }
        assert.equal(receipt.id, current.payload.requestId)
        assert.equal(receipt.sessionId, current.payload.sessionId)
        assert.equal(receipt.status, 'resolved')
        const proof = {
          at: Date.now(),
          pid: process.pid,
          actor,
          descriptor,
          receipt,
          stage: 'Actual coordinator resolved reply receipt received; intentionally not delivered to router/service',
        }
        writeFileSync(join(root, 'accepted-reply-ack-dropped.json'), `${JSON.stringify(proof, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
        ledger(root, 'accepted-reply-ack-dropped', proof)
        current.reject(Error('qa-accepted-reply-ack-lost'))
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
          payload: structuredClone(payload),
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

function snapshotRead(config: Config, resident: ResidentAgentStore): Readback {
  const pages = listKnowledgePagesAt(personalWikiDirectory())
  const intentA = resident.getHostTaskIntent('action-A')
  const intentB = resident.getHostTaskIntent('action-B')
  return {
    resident: rows(join(config.profile, 'conversation.sqlite')),
    evidence: rows(join(config.profile, 'evidence.sqlite')),
    wiki: rows(join(config.profile, 'daily-review/wiki.sqlite')),
    pages,
    A: resident.hostTaskExecution('action-A'),
    B: resident.hostTaskExecution('action-B'),
    global: resident.memorySources(),
    resultLookup: { A: intentA ? 'queried' : 'intent-not-created', B: intentB ? 'queried' : 'intent-not-created' },
    resultsA: intentA ? resident.hostTaskResults('action-A') : [],
    resultsB: intentB ? resident.hostTaskResults('action-B') : [],
  }
}
function inputFor(suffix: Suffix): HostTaskRouterInput {
  return {
    prompt: `Explicit synthetic Task ${suffix}: use existing Personal memory read and reviewed patch.`,
    systemPrompt: 'Local deterministic provider fixture. No external commands or model.',
    model: 'fake-model',
    effort: 'low',
    threadId: null,
    reviewTtlMs: 300000,
    tools: [
      {
        name: 'remember_memory',
        description: 'Read or reviewed patch of the explicitly selected existing Personal page.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['read', 'patch'] } },
          required: ['action'],
        },
      },
    ],
  }
}
async function seed(root: string, caseId: CaseId): Promise<Config> {
  const profile = join(root, 'profile'),
    registry = join(root, 'host')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(registry, { mode: 0o700 })
  initializeKnowledgeStore(profile)
  for (const [slug, content] of [
    ['a', original],
    ['b', unrelated],
    ['global', globalControl],
  ])
    createKnowledgePageAt(personalWikiDirectory(), {
      spaceId: 'personal',
      category: 'projects',
      slug: `projects/${slug}`,
      title: `Synthetic ${slug}`,
      content: `Bounded synthetic page.\n\n${content}`,
    })
  const pages = listKnowledgePagesAt(personalWikiDirectory()).filter((p) => p.slug !== 'index')
  assert.equal(pages.length, 3)
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
  }) as { request(text: string): Promise<unknown>; close(): void }
  try {
    const actions: Partial<Record<Suffix, Action>> = {}
    for (const suffix of ['A', 'B'] as const) {
      const item = evidence.createWorkItem(
        `Synthetic composition ${suffix}`,
        'Keep this human Task open and unchanged.'
      )
      const page = pages.find((p) => p.slug === `projects/${suffix.toLowerCase()}`)
      assert(page?.revision)
      const input = inputFor(suffix)
      const assignment = {
        jobId: `job-${suffix}`,
        messageId: `assistant-${suffix}`,
        workItemId: item.id,
        sessionId: `session-${suffix}`,
      }
      const descriptor = (await preparation.request(
        JSON.stringify({ op: 'prepare', assignment, input })
      )) as HostTaskRouterDescriptor
      const { reviewTtlMs: _ttl, ...providerInput } = input
      const envelope: HostTaskEnvelopeV1 = {
        version: 1,
        actionId: `action-${suffix}`,
        workItemId: item.id,
        sessionId: assignment.sessionId,
        jobId: assignment.jobId,
        userMessageId: `user-${suffix}`,
        assistantMessageId: assignment.messageId,
        provider: 'codex',
        instruction: `Explicit synthetic instruction ${suffix}`,
        targetId,
        taskDefinition: hostTaskDefinition(item),
        policyFingerprint,
        sources: [{ spaceId: 'personal', slug: page.slug, revision: page.revision, explicit: true }],
        startedAt: Date.now(),
        preparedInput: { ...providerInput, workspace: descriptor.workspace },
      }
      const prepared: HostTaskPrepared = { version: 1, descriptor, input }
      validateHostTaskPrepared(envelope, prepared)
      actions[suffix] = { envelope, prepared }
      assert.equal(resident.hostTaskExecution(envelope.actionId), null)
      assert.equal(resident.getHostTaskIntent(envelope.actionId), null)
    }
    assert(actions.A && actions.B)
    const global = pages.find((p) => p.slug === 'projects/global')
    assert(global?.revision)
    resident.recordMemorySources([
      { spaceId: 'personal', slug: global.slug, revision: global.revision, explicit: true },
    ])
    const config: Config = { root, caseId, profile, registry, actions: { A: actions.A, B: actions.B } }
    saveJson(join(root, 'config.json'), config)
    saveJson(join(root, 'source-state.json'), { state: 'valid' })
    const initial = snapshotRead(config, resident)
    assert.deepEqual(initial.resident.assistant_task_run, [])
    assert.deepEqual(initial.resident.assistant_tool_call, [])
    assert.deepEqual(initial.resultLookup, { A: 'intent-not-created', B: 'intent-not-created' })
    saveJson(join(root, 'initial-readback.json'), initial)
    ledger(root, 'fixture-seeded', { caseId, syntheticPermission: true, executionCreated: false })
    return config
  } finally {
    preparation.close()
    resident.close()
    evidence.close()
    closeWikiHistoryStore()
  }
}

async function coordinatorChild(config: Config, suffix: Suffix) {
  const descriptor = config.actions[suffix].prepared.descriptor
  const { createCoordinator } = await import(join(repository, 'experiments/always-on-agent/coordinator.mjs'))
  mkdirSync(descriptor.directory, { recursive: true, mode: 0o700 })
  ledger(config.root, 'owned-coordinator-directory-provisioned', { suffix, directory: descriptor.directory })
  let release: (() => void) | null = null
  const coordinator = await createCoordinator({
    directory: descriptor.directory,
    nativeClient: true,
    driver: {
      async runCodexWorker(input: FakeInput) {
        const threadId = `thread-composition-${suffix}`,
          turnId = `turn-composition-${suffix}`
        ledger(config.root, 'fake-provider-invoked', { suffix, jobId: descriptor.assignment.jobId, threadId, turnId })
        input.onThread(threadId)
        input.onCheckpoint({ computer: input.remote, threadId, turnId: null, previousTurnId: null })
        input.onCheckpoint({ computer: input.remote, threadId, turnId, previousTurnId: null })
        try {
          assert.equal(input.tools.length, 1)
          assert.equal(input.tools[0].name, 'remember_memory')
          input.report('status', 'read-start', `Read synthetic ${suffix} source.`)
          const source = config.actions[suffix].envelope.sources[0]
          const read = (await input.tools[0].call(
            { action: 'read', spaceId: 'personal', slug: source.slug },
            { threadId, turnId, callId: `call-${suffix}-read`, signal: input.signal }
          )) as { slug: string; revision: string; content: string }
          ledger(config.root, 'fake-read-returned', { suffix, result: read })
          assert.equal(read.slug, source.slug)
          assert.equal(read.revision, source.revision)
          assert(read.content.includes(suffix === 'A' ? original : unrelated))
          assert(!read.content.includes(globalControl))
          const patch = {
            action: 'patch',
            spaceId: 'personal',
            slug: source.slug,
            expectedRevision: read.revision,
            before: suffix === 'A' ? original : unrelated,
            after: suffix === 'A' ? replacement : 'SYNTHETIC_B_MUST_NOT_SAVE',
            summary: `Synthetic reviewed ${suffix} replacement`,
          }
          ledger(config.root, 'fake-patch-requested', { suffix, input: patch })
          const result = await input.tools[0].call(patch, {
            threadId,
            turnId,
            callId: `call-${suffix}-patch`,
            signal: input.signal,
          })
          ledger(config.root, 'fake-patch-returned', { suffix, result })
          assert.equal(config.caseId, 'positive')
          assert.equal(suffix, 'A')
          assert.equal((result as { kind?: string }).kind, 'saved-page')
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
            ledger(config.root, 'fake-awaiting-parent-finish', { suffix })
          })
          input.report('status', 'private-completion', secret)
          const response = `${secret}: completed synthetic A after the actual Personal receipt.`
          ledger(config.root, 'fake-provider-returned', { suffix, response })
          return { response, threadId }
        } finally {
          input.onCheckpoint(null)
        }
      },
      async stopCodexRemoteCheckpoint(checkpoint: unknown) {
        ledger(config.root, 'fake-checkpoint-stop', { suffix, checkpoint })
      },
    },
  })
  process.on('message', async (raw) => {
    const command = raw as Control
    try {
      if (command.op === 'finish') {
        assert(release)
        release()
        process.send?.({ id: command.id, result: true })
      } else if (command.op === 'close') {
        const snapshot = await directSnapshot(config, suffix)
        saveJson(join(config.root, `coordinator-${suffix}-cleanup-before.json`), snapshot)
        if (snapshot.job && !['completed', 'stopped'].includes(snapshot.job.phase)) {
          ledger(config.root, 'cleanup-stopping-owned-job', { suffix, job: snapshot.job })
          const child = await connectPersistent(config.root, descriptor, 'cleanup')
          try {
            const stopped = await child.request('stop')
            saveJson(join(config.root, `coordinator-${suffix}-cleanup-stop.json`), stopped)
            assert.equal((stopped as { id: string }).id, descriptor.assignment.jobId)
            assert(['completed', 'stopped'].includes((stopped as { phase: string }).phase))
          } finally {
            child.close()
          }
        }
        await coordinator.close()
        ledger(config.root, 'coordinator-closed', { suffix })
        process.exit(0)
      } else throw Error('qa-coordinator-command-invalid')
    } catch (error) {
      process.send?.({ id: command.id, error: errorText(error) })
    }
  })
  process.send?.({ ready: true, pid: process.pid, socketPath: coordinator.socketPath })
}

async function receiver(config: Config) {
  initializeKnowledgeStore(config.profile)
  const resident = new ResidentAgentStore(join(config.profile, 'conversation.sqlite'))
  const evidence = new EvidenceStore(join(config.profile, 'evidence.sqlite'))
  const { openTaskServiceTransport } = await import(
    join(repository, 'experiments/always-on-agent/task-service-transport.mjs')
  )
  const raw = openTaskServiceTransport({
    directory: config.registry,
    targetId,
    targetEpoch,
    connectChild: (descriptor: HostTaskRouterDescriptor) => {
      assert.deepEqual(
        descriptor,
        config.actions[descriptor.assignment.jobId === 'job-A' ? 'A' : 'B'].prepared.descriptor
      )
      return connectPersistent(config.root, descriptor, 'receiver', config.caseId === 'positive')
    },
  }) as RawRouter
  const port = createHostTaskServiceTransport(raw)
  const reviews = new Map<string, Review & { resolve(answer: 'accept' | 'decline'): void }>()
  const context = () => ({ policyFingerprint, target: { targetId, targetEpoch, root: config.registry } })
  const validateSources = async (refs: HostTaskEnvelopeV1['sources'], signal: AbortSignal) => {
    assert(!signal.aborted)
    const status = readJson<{ state: 'valid' | 'unavailable' | 'invalidated' }>(
      join(config.root, 'source-state.json')
    ).state
    assert(['valid', 'unavailable', 'invalidated'].includes(status))
    const pages = listKnowledgePagesAt(personalWikiDirectory())
    const valid = refs.every(
      (ref) =>
        ref.spaceId === 'personal' && pages.some((page) => page.slug === ref.slug && page.revision === ref.revision)
    )
    ledger(config.root, 'source-validation', { refs, status, actualRevisionsValid: valid, permission: 'synthetic' })
    return status === 'valid' && !valid ? 'invalidated' : status
  }
  const adapter = new HostTaskMemoryAdapter({
    resident,
    evidence,
    transport: port,
    readContext: context,
    validateSources,
    personal: {
      space,
      pages: () => listKnowledgePagesAt(personalWikiDirectory()),
      pagePermitted: (page) => ['projects/a', 'projects/b'].includes(page.slug),
      save(input) {
        assert.equal(input.spaceId, 'personal')
        assert.equal(input.strictRevision, true)
        assert(['projects/a', 'projects/b'].includes(input.slug))
        ledger(config.root, 'real-save-entry', { input })
        const pages = saveKnowledgePageAt(personalWikiDirectory(), input)
        const page = pages.find((p) => p.slug === input.slug)
        assert(page)
        ledger(config.root, 'real-save-return', { page, history: getWikiPageHistory('personal', input.slug) })
        return pages
      },
    },
    ask(review, signal) {
      const id = randomUUID()
      return new Promise((resolve) => {
        const entry = {
          id,
          review: structuredClone(review),
          aborted: signal.aborted,
          answered: false,
          resolve: (answer: 'accept' | 'decline') => {
            entry.answered = true
            ledger(config.root, 'review-resolved-locally', {
              id,
              actionId: review.actionId,
              aborted: entry.aborted,
              answer,
            })
            resolve(answer)
          },
        }
        reviews.set(id, entry)
        signal.addEventListener(
          'abort',
          () => {
            entry.aborted = true
            ledger(config.root, 'review-aborted', { id, actionId: review.actionId })
          },
          { once: true }
        )
        ledger(config.root, 'review-shown', { id, review })
        process.send?.({ review: { id, review: entry.review, aborted: entry.aborted, answered: false } })
      })
    },
  })
  const service = new HostTaskActionService({
    resident,
    evidence,
    transport: port,
    readContext: context,
    validateSources,
    memoryExecutor: {
      async execute(actionId, request, signal) {
        ledger(config.root, 'executor-execute-entry', { actionId, request })
        try {
          const result = await adapter.execute(actionId, request, signal)
          ledger(config.root, 'executor-execute-return', { actionId, result })
          return result
        } catch (error) {
          ledger(config.root, 'executor-execute-error', { actionId, error: errorText(error) })
          throw error
        }
      },
      async reply(actionId, replyId, signal) {
        ledger(config.root, 'executor-reply-entry', { actionId, replyId })
        try {
          const result = await adapter.reply(actionId, replyId, signal)
          ledger(config.root, 'executor-reply-return', { actionId, result })
          return result
        } catch (error) {
          ledger(config.root, 'executor-reply-error', { actionId, error: errorText(error) })
          throw error
        }
      },
      dispose() {
        ledger(config.root, 'executor-dispose')
        adapter.dispose()
      },
    },
  })
  let active: Promise<void> | null = null
  let disposed = false
  const settle = async () => {
    if (active) await active
    await new Promise<void>((done) => setImmediate(done))
  }
  const handle = async (command: Control) => {
    try {
      ledger(config.root, 'receiver-command', { command })
      let result: unknown
      if (command.op === 'start') {
        assert(command.suffix)
        const action = config.actions[command.suffix]
        result = await service.start(action.envelope, action.prepared)
      } else if (command.op === 'resume') {
        assert(command.actionId)
        result = await service.resume(command.actionId)
      } else if (command.op === 'stop') {
        assert(command.actionId)
        result = await service.stop(command.actionId)
      } else if (command.op === 'inspect') result = snapshotRead(config, resident)
      else if (command.op === 'reviews') result = [...reviews.values()].map(({ resolve: _resolve, ...entry }) => entry)
      else if (command.op === 'approve') {
        assert(command.handle)
        const entry = reviews.get(command.handle)
        if (!entry) throw Error('qa-review-not-found')
        entry.resolve('accept')
        result = { resolved: true, aborted: entry.aborted }
      } else if (command.op === 'dispose') {
        service.dispose()
        disposed = true
        ledger(config.root, 'service-disposed')
        await settle()
        result = { disposed: true }
      } else if (command.op === 'close') {
        if (!disposed) service.dispose()
        disposed = true
        await settle()
        await raw.close()
        resident.close()
        evidence.close()
        closeWikiHistoryStore()
        ledger(config.root, 'receiver-closed')
        process.exit(0)
      } else throw Error('qa-command-invalid')
      ledger(config.root, 'receiver-result', { id: command.id, op: command.op, result })
      process.send?.({ id: command.id, result })
    } catch (error) {
      ledger(config.root, 'receiver-error', { id: command.id, op: command.op, error: errorText(error) })
      process.send?.({ id: command.id, error: errorText(error) })
    }
  }
  process.on('message', (value) => {
    const command = value as Control
    if (['start', 'resume'].includes(command.op)) {
      const pending = handle(command)
      if (!active) {
        active = pending
        void pending.finally(() => {
          if (active === pending) active = null
        })
      }
    } else void handle(command)
  })
  process.send?.({ ready: true, pid: process.pid })
}

function validateFixture() {
  assert.notEqual(original, replacement)
  assert(![original, replacement, unrelated, globalControl].includes(secret))
  return {
    executed: false,
    cases: ['stop pending review', 'dispose pending review', 'positive A/B, actual reply ACK loss, withheld release'],
    expectedCoordinators: 4,
    expectedReceiverLifetimes: 7,
    actual: [
      'action service + memory adapter',
      'Personal file/history writer',
      'Resident/Evidence stores',
      'frozen router/transport',
      'local coordinator/journal',
    ],
    synthetic: ['provider contents', 'source permission/availability', 'late review promise'],
    excluded: ['native', 'model', 'Mini', 'cloud', 'capture', 'audio', 'UI approval token claim'],
  }
}
function invariant(initial: Readback, current: Readback) {
  assert.deepEqual(current.evidence.work_item, initial.evidence.work_item)
  assert.deepEqual(current.evidence.work_item_source, initial.evidence.work_item_source)
  assert.deepEqual(current.global, initial.global)
  for (const slug of ['projects/b', 'projects/global'])
    assert.deepEqual(
      current.pages.find((p) => p.slug === slug),
      initial.pages.find((p) => p.slug === slug)
    )
  assert.deepEqual(current.resultsB, [])
}
function toolClaim(current: Readback, suffix: Suffix) {
  const found = current.resident.assistant_tool_call.filter((row) => row.message_id === `assistant-${suffix}`)
  assert.equal(found.length, 1)
  return found[0]
}
function terminal(current: Readback, suffix: Suffix) {
  const e = current[suffix]
  assert(e?.terminal && e.intent.outcome && e.intent.outcomeReceipt)
  const row = current.resident.assistant_task_run.find((r) => r.action_id === `action-${suffix}`)
  assert(row)
  return {
    terminal: e.terminal,
    terminalReceivedAt: e.terminalReceivedAt,
    outcome: e.intent.outcome,
    outcomeReceipt: e.intent.outcomeReceipt,
    outcomeJson: row.outcome_json,
    outcomeHash: row.outcome_hash,
    sources: e.sources,
    results: suffix === 'A' ? current.resultsA : current.resultsB,
  }
}
function oneWikiRevision(initial: Readback, current: Readback) {
  const page = current.pages.find((p) => p.slug === 'projects/a')
  assert(page?.revision)
  for (const table of Object.keys(initial.wiki))
    if (!['wiki_page', 'wiki_page_revision'].includes(table)) assert.deepEqual(current.wiki[table], initial.wiki[table])
  const before = initial.wiki.wiki_page.find((r) => r.slug === 'projects/a')
  assert(before)
  assert.deepEqual(
    current.wiki.wiki_page.find((r) => r.id === before.id),
    { ...before, head_revision_id: page.revision }
  )
  assert.deepEqual(
    current.wiki.wiki_page.filter((r) => r.id !== before.id),
    initial.wiki.wiki_page.filter((r) => r.id !== before.id)
  )
  for (const old of initial.wiki.wiki_page_revision)
    assert.deepEqual(
      current.wiki.wiki_page_revision.find((r) => r.id === old.id),
      old
    )
  const oldIds = new Set(initial.wiki.wiki_page_revision.map((r) => r.id))
  const added = current.wiki.wiki_page_revision.filter((r) => !oldIds.has(r.id))
  assert.equal(added.length, 1)
  assert.equal(current.wiki.wiki_page_revision.length, initial.wiki.wiki_page_revision.length + 1)
  assert.equal(added[0].id, page.revision)
  assert.equal(added[0].parent_revision_id, before.head_revision_id)
  assert.equal(added[0].content, page.content)
  assert.equal(added[0].status, 'committed')
}

async function main() {
  const root = mkdtempSync('/private/tmp/e077-')
  const proof: { status: string; checks: string[]; [key: string]: unknown } = {
    status: 'running',
    root,
    pid: process.pid,
    checks: [],
    boundary: { ...validateFixture(), executed: true },
  }
  const children: Child[] = []
  const configs: Config[] = []
  let commandId = 0
  const report = () => saveJson(join(root, 'report.json'), proof)
  const check = (message: string) => {
    proof.checks.push(message)
    report()
  }
  report()
  const count = (config: Config, type: string, suffix?: Suffix) =>
    events(config.root).filter(
      (e) => e.type === type && (!suffix || e.suffix === suffix || e.actionId === `action-${suffix}`)
    ).length
  const wireCount = (config: Config, op: string, suffix?: Suffix) =>
    events(config.root).filter(
      (e) => e.type === 'child-request-written' && e.op === op && (!suffix || e.jobId === `job-${suffix}`)
    ).length
  async function waitExit(child: Child, timeout = 10000) {
    const until = Date.now() + timeout
    while (!child.exited && Date.now() < until) await delay(10)
    assert(child.exited, `Owned ${child.kind} ${child.pid} must exit`)
  }
  async function launch(config: Config, kind: 'receiver' | 'coordinator', suffix?: Suffix) {
    const p = fork(script, [`--${kind}`, config.root, ...(suffix ? [suffix] : [])], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    assert(p.pid)
    const child: Child = {
      process: p,
      pid: p.pid,
      root: config.root,
      kind,
      ...(suffix ? { suffix } : {}),
      exited: false,
      code: null,
      signal: null,
    }
    children.push(child)
    const log = join(config.root, `process-${p.pid}.log`)
    writeFileSync(log, '', { mode: 0o600 })
    p.stdout?.on('data', (b: Buffer) => appendFileSync(log, b))
    p.stderr?.on('data', (b: Buffer) => appendFileSync(log, b))
    p.on('exit', (code, signal) => {
      child.exited = true
      child.code = code
      child.signal = signal
      ledger(config.root, 'owned-process-exit', { childPid: child.pid, kind, suffix, code, signal })
    })
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => finish(Error('qa-ready-timeout')), 10000)
      const receive = (raw: unknown) => {
        const value = raw as { ready?: boolean; pid?: number }
        if (value.ready) finish(value.pid === child.pid ? undefined : Error('qa-ready-pid-mismatch'))
      }
      const exit = () => finish(Error('qa-exit-before-ready'))
      const finish = (error?: Error) => {
        clearTimeout(timer)
        p.off('message', receive)
        p.off('exit', exit)
        if (error) reject(error)
        else done()
      }
      p.on('message', receive)
      p.once('exit', exit)
    })
    return child
  }
  function rpc<T>(child: Child, op: string, payload: Omit<Partial<Control>, 'id' | 'op'> = {}): Promise<T> {
    assert(!child.exited && child.process.connected)
    const id = ++commandId
    return new Promise((done, reject) => {
      const timer = setTimeout(() => finish(Error(`qa-control-timeout:${op}`)), 30000)
      const receive = (raw: unknown) => {
        const value = raw as { id?: number; result?: T; error?: string }
        if (value.id !== id) return
        saveJson(join(child.root, `control-${id}-${op}.json`), {
          command: { id, op, ...payload },
          reply: value,
          pid: child.pid,
        })
        finish(value.error ? Error(value.error) : undefined, value.result)
      }
      const exit = () => finish(Error(`qa-control-exit:${op}`))
      const finish = (error?: Error, value?: T) => {
        clearTimeout(timer)
        child.process.off('message', receive)
        child.process.off('exit', exit)
        if (error) reject(error)
        else done(value as T)
      }
      child.process.on('message', receive)
      child.process.once('exit', exit)
      child.process.send({ id, op, ...payload })
    })
  }
  const result = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error: errorText(error) })
    )
  async function close(child: Child) {
    child.process.send({ id: ++commandId, op: 'close' })
    await waitExit(child)
    assert.equal(child.code, 0)
    assert.equal(child.signal, null)
  }
  async function waitLedger(config: Config, type: string, suffix: Suffix) {
    const until = Date.now() + 10000
    while (Date.now() < until) {
      const entry = events(config.root).find((e) => e.type === type && e.suffix === suffix)
      if (entry) return entry
      await delay(10)
    }
    throw Error(`qa-ledger-timeout:${type}:${suffix}`)
  }
  async function waitSnapshot(config: Config, suffix: Suffix, predicate: (s: HostTaskSnapshot) => boolean) {
    const until = Date.now() + 10000
    while (Date.now() < until) {
      const snapshot = await directSnapshot(config, suffix)
      if (predicate(snapshot)) return snapshot
      await delay(10)
    }
    throw Error(`qa-snapshot-timeout:${suffix}`)
  }
  async function startAndRead(config: Config, child: Child, suffix: Suffix) {
    await rpc<HostTaskActionView>(child, 'start', { suffix })
    if (count(config, 'fake-read-returned', suffix) === 0) {
      await waitSnapshot(
        config,
        suffix,
        (s) => s.requests.length === 1 && (s.requests[0].payload.input as { action?: string })?.action === 'read'
      )
      await rpc<HostTaskActionView>(child, 'resume', { actionId: `action-${suffix}` })
    }
    await waitLedger(config, 'fake-read-returned', suffix)
    const pending = await waitSnapshot(
      config,
      suffix,
      (s) => s.requests.length === 1 && (s.requests[0].payload.input as { action?: string })?.action === 'patch'
    )
    assert.equal(count(config, 'fake-provider-invoked', suffix), 1)
    saveJson(join(config.root, `${suffix}-patch-pending-before-execute.json`), pending)
    return pending
  }
  async function beginReview(config: Config, child: Child, suffix: Suffix, snapshot: HostTaskSnapshot) {
    const before = count(config, 'review-shown')
    const pending = result(rpc<HostTaskActionView>(child, 'resume', { actionId: `action-${suffix}` }))
    const until = Date.now() + 10000
    while (count(config, 'review-shown') === before && Date.now() < until) await delay(10)
    assert.equal(count(config, 'review-shown'), before + 1)
    const list = await rpc<Review[]>(child, 'reviews')
    const review = list.findLast((r) => r.review.actionId === `action-${suffix}`)
    assert(review)
    const request = snapshot.requests[0]
    assert(request)
    const value = review.review
    assert.equal(value.actionId, `action-${suffix}`)
    assert.equal(value.messageId, `assistant-${suffix}`)
    assert.equal(value.jobId, `job-${suffix}`)
    assert.equal(value.threadId, snapshot.job?.threadId)
    assert.equal(value.turnId, snapshot.job?.turnId)
    assert.equal(value.sessionId, snapshot.sessionId)
    assert.equal(value.requestId, request.id)
    assert.equal(value.callId, request.payload.callId)
    assert.equal(value.expiresAt, request.payload.expiresAt)
    assert(value.expiresAt > Date.now())
    assert.equal(value.slug, config.actions[suffix].envelope.sources[0].slug)
    assert.equal(value.revision, config.actions[suffix].envelope.sources[0].revision)
    assert.equal(value.mode, 'auto')
    assert.equal(value.contentAfter, value.contentBefore.replace(value.before, value.after))
    saveJson(join(config.root, `${suffix}-review.json`), review)
    return { review, pending }
  }
  function noEffects(config: Config, initial: Readback, current: Readback) {
    invariant(initial, current)
    assert.deepEqual(current.pages, initial.pages)
    assert.deepEqual(current.wiki, initial.wiki)
    assert.equal(count(config, 'real-save-entry'), 0)
    assert.equal(count(config, 'real-save-return'), 0)
    assert.equal(toolClaim(current, 'A').result_json, null)
    assert.deepEqual(current.A?.sources, config.actions.A.envelope.sources)
    assert.deepEqual(current.resultsA, [])
  }
  function abortBeforeStop(config: Config, id: string, suffix: Suffix) {
    const list = events(config.root)
    const abort = list.findIndex((e) => e.type === 'review-aborted' && e.id === id)
    const stop = list.findIndex(
      (e) => e.type === 'child-request-written' && e.op === 'stop' && e.jobId === `job-${suffix}`
    )
    assert(abort >= 0 && stop > abort, 'Review abort must precede exact remote Stop')
  }
  function actualStopped(snapshot: HostTaskSnapshot, pendingSnapshot: HostTaskSnapshot) {
    const request = pendingSnapshot.requests[0]
    assert(request)
    assert.equal(pendingSnapshot.requests.length, 1)
    assert.equal(snapshot.job?.phase, 'stopped')
    assert.equal(snapshot.job.stopReason, undefined)
    assert.equal(snapshot.sessionId, pendingSnapshot.sessionId)
    assert.equal(snapshot.requests.length, 0)
    assert(!snapshot.events.some((e) => e.type === 'review-expiry'))
    assert.equal(snapshot.events.filter((e) => e.type === 'driver-invoked').length, 1)
    assert.equal(snapshot.events.filter((e) => e.type === 'request-pending').length, 2)
    assert.equal(snapshot.events.filter((e) => e.type === 'request-resolved').length, 1)
    const stops = snapshot.events.filter((e) => e.type === 'stop-requested')
    const expired = snapshot.events.filter((e) => e.type === 'request-expired')
    assert.equal(stops.length, 1)
    assert.equal(expired.length, 1)
    assert.deepEqual(expired[0].payload, {
      id: request.id,
      sessionId: pendingSnapshot.sessionId,
      reason: 'upstream-request-resolved-or-cancelled',
    })
    assert(stops[0].seq < expired[0].seq)
    assert(stops[0].createdAt < request.payload.expiresAt)
    assert(expired[0].createdAt < request.payload.expiresAt)
    assert(snapshot.job.updatedAt < request.payload.expiresAt)
    assert(!snapshot.events.some((e) => e.type === 'requests-expired'))
  }
  try {
    for (const caseId of ['stop', 'dispose', 'positive'] as const) {
      const directory = join(root, caseId)
      mkdirSync(directory, { mode: 0o700 })
      const config = await seed(directory, caseId)
      configs.push(config)
      const initial = readJson<Readback>(join(directory, 'initial-readback.json'))
      const hostA = await launch(config, 'coordinator', 'A')
      const hostB = caseId === 'positive' ? await launch(config, 'coordinator', 'B') : null
      const first = await launch(config, 'receiver')
      const pendingA = await startAndRead(config, first, 'A')
      const afterRead = await rpc<Readback>(first, 'inspect')
      invariant(initial, afterRead)
      assert.equal(afterRead.resident.assistant_tool_call.length, 0)
      const { review, pending } = await beginReview(config, first, 'A', pendingA)
      const claimed = await rpc<Readback>(first, 'inspect')
      noEffects(config, initial, claimed)
      assert.equal(count(config, 'executor-execute-entry', 'A'), 2)
      if (caseId === 'stop' || caseId === 'dispose') {
        if (caseId === 'stop') {
          const stopped = await rpc<HostTaskActionView>(first, 'stop', { actionId: 'action-A' })
          assert.equal(stopped.execution.state, 'stopped')
          assert(stopped.execution.intent.outcomeReceipt)
          assert.equal((await pending).error, 'host-task-operation-cancelled')
          abortBeforeStop(config, review.id, 'A')
        } else {
          await rpc(first, 'dispose')
          assert.equal((await pending).error, 'host-task-action-disposed')
          assert.equal(wireCount(config, 'stop'), 0)
        }
        const late = await rpc<{ aborted: boolean }>(first, 'approve', { handle: review.id })
        assert.equal(late.aborted, true)
        const after = await rpc<Readback>(first, 'inspect')
        noEffects(config, initial, after)
        assert.equal(count(config, 'executor-execute-entry', 'A'), 2)
        assert.equal(count(config, 'executor-reply-entry', 'A'), 1)
        const beforeQuit = await directSnapshot(config, 'A')
        if (caseId === 'stop') actualStopped(beforeQuit, pendingA)
        else {
          assert.equal(beforeQuit.job?.phase, 'waiting')
          assert.deepEqual(beforeQuit.requests, pendingA.requests)
          assert(beforeQuit.requests[0].payload.expiresAt > Date.now())
          assert(!beforeQuit.events.some((e) => e.type === 'review-expiry'))
        }
        saveJson(join(directory, 'before-receiver-quit.json'), { readback: after, host: beforeQuit, review })
        await close(first)
        rawCopy(config, 'raw-first-receiver-exit-before-reopen')
        const second = await launch(config, 'receiver')
        const resumed = await rpc<HostTaskActionView>(second, 'resume', { actionId: 'action-A' })
        if (caseId === 'stop') {
          assert.equal(resumed.execution.state, 'stopped')
          assert.deepEqual(terminal(await rpc(second, 'inspect'), 'A'), terminal(after, 'A'))
        } else {
          assert.equal(resumed.issue, 'host-task-memory-request-failed')
          assert.equal(count(config, 'review-shown'), 1)
          const unknown = await rpc<Readback>(second, 'inspect')
          noEffects(config, initial, unknown)
          const host = await directSnapshot(config, 'A')
          assert.equal(host.job?.phase, 'waiting')
          assert.deepEqual(host.requests, pendingA.requests)
          saveJson(join(directory, 'unknown-claim-after-reopen.json'), { view: resumed, readback: unknown, host })
          const before = count(config, 'executor-execute-entry', 'A')
          const stopped = await rpc<HostTaskActionView>(second, 'stop', { actionId: 'action-A' })
          assert.equal(stopped.execution.state, 'stopped')
          assert.equal(count(config, 'executor-execute-entry', 'A'), before)
        }
        const final = await rpc<Readback>(second, 'inspect')
        noEffects(config, initial, final)
        const host = await directSnapshot(config, 'A')
        actualStopped(host, pendingA)
        assert.equal(wireCount(config, 'submit', 'A'), 1)
        assert.equal(wireCount(config, 'stop', 'A'), 1)
        assert.equal(wireCount(config, 'reply', 'A'), 1)
        assert.equal(count(config, 'fake-patch-returned', 'A'), 0)
        saveJson(join(directory, 'final-readback.json'), { readback: final, host })
        await close(second)
        rawCopy(config, 'raw-final-receiver-exit')
        await close(hostA)
        check(
          `${caseId}: real pending review shares abort; NULL claim never replays, exact Stop distinguished from quit`
        )
      } else {
        await rpc(first, 'approve', { handle: review.id })
        const attempt = await pending
        assert.equal(attempt.error, null)
        assert.equal(attempt.value?.issue, 'host-task-memory-request-failed')
        await waitLedger(config, 'fake-awaiting-parent-finish', 'A')
        assert.equal(count(config, 'accepted-reply-ack-dropped'), 1)
        assert.equal(count(config, 'executor-execute-entry', 'A'), 2)
        assert.equal(count(config, 'executor-reply-entry', 'A'), 2)
        const saved = await rpc<Readback>(first, 'inspect')
        invariant(initial, saved)
        oneWikiRevision(initial, saved)
        assert.equal(count(config, 'real-save-entry'), 1)
        assert.equal(count(config, 'real-save-return'), 1)
        const page = saved.pages.find((p) => p.slug === 'projects/a')
        assert(page?.revision)
        assert.equal(
          page.content,
          initial.pages.find((p) => p.slug === 'projects/a')?.content.replace(original, replacement)
        )
        assert.equal(saved.A?.sources[0].revision, page.revision)
        assert.deepEqual(saved.A?.intent.envelope.sources, config.actions.A.envelope.sources)
        const receipt = JSON.parse(String(toolClaim(saved, 'A').result_json))
        assert.deepEqual(receipt, {
          kind: 'saved-page',
          saved: true,
          proposed: false,
          spaceId: 'personal',
          slug: page.slug,
          revision: page.revision,
          title: page.title,
        })
        assert.equal(saved.resultsA.length, 1)
        assert.equal(saved.resultsA[0].revision, page.revision)
        const accepted = await directSnapshot(config, 'A')
        assert.equal(accepted.requests.length, 0)
        assert.equal(accepted.events.filter((e) => e.type === 'request-resolved').length, 2)
        saveJson(join(directory, 'saved-and-ack-lost.json'), { readback: saved, host: accepted, receipt })
        saveJson(join(directory, 'source-state.json'), { state: 'unavailable' })
        ledger(directory, 'fixture-source-state', { state: 'unavailable' })
        await rpc(hostA, 'finish')
        const completed = await waitSnapshot(config, 'A', (s) => s.job?.phase === 'completed')
        const held = await rpc<HostTaskActionView>(first, 'resume', { actionId: 'action-A' })
        assert.equal(held.issue, 'host-task-context-unavailable')
        assert.equal(held.execution.state, 'completed')
        assert.equal(
          held.execution.observation?.kind === 'host' ? held.execution.observation.delivery.kind : null,
          'withheld'
        )
        assert.equal(held.execution.intent.outcome, null)
        assert.equal(held.execution.intent.outcomeReceipt, null)
        assert(held.execution.terminal && held.execution.terminalReceivedAt)
        const heldRows = await rpc<Readback>(first, 'inspect')
        assert(!JSON.stringify(heldRows.resident).includes(secret))
        const blocked = await result(rpc(first, 'start', { suffix: 'B' }))
        assert.equal(blocked.error, 'host-task-action-busy')
        assert.equal((await rpc<Readback>(first, 'inspect')).B, null)
        assert.equal(wireCount(config, 'submit', 'B'), 0)
        assert.equal(count(config, 'executor-execute-entry', 'A'), 2)
        saveJson(join(directory, 'A-withheld.json'), { view: held, readback: heldRows, host: completed, blocked })
        await close(first)
        rawCopy(config, 'raw-withheld-receiver-exit-before-reopen')
        const second = await launch(config, 'receiver')
        const heldAgain = await rpc<HostTaskActionView>(second, 'resume', { actionId: 'action-A' })
        assert.deepEqual(heldAgain.execution.terminal, held.execution.terminal)
        assert.equal(heldAgain.execution.terminalReceivedAt, held.execution.terminalReceivedAt)
        assert.equal(heldAgain.execution.intent.outcome, null)
        assert(!JSON.stringify((await rpc<Readback>(second, 'inspect')).resident).includes(secret))
        saveJson(join(directory, 'source-state.json'), { state: 'valid' })
        ledger(directory, 'fixture-source-state', { state: 'valid' })
        const released = await rpc<HostTaskActionView>(second, 'resume', { actionId: 'action-A' })
        assert.equal(released.execution.intent.outcome?.response, completed.result?.response)
        assert(released.execution.intent.outcomeReceipt)
        assert.deepEqual(released.execution.terminal, held.execution.terminal)
        assert.equal(released.execution.terminalReceivedAt, held.execution.terminalReceivedAt)
        const delivered = await rpc<Readback>(second, 'inspect')
        invariant(initial, delivered)
        oneWikiRevision(initial, delivered)
        const finalA = terminal(delivered, 'A')
        assert.equal(finalA.outcomeHash, hash(finalA.outcome))
        saveJson(join(directory, 'A-released.json'), { view: released, readback: delivered, terminal: finalA })
        await close(second)
        rawCopy(config, 'raw-released-receiver-exit-before-reopen')
        const third = await launch(config, 'receiver')
        await rpc(third, 'resume', { actionId: 'action-A' })
        assert.deepEqual(terminal(await rpc(third, 'inspect'), 'A'), finalA)
        const pendingB = await startAndRead(config, third, 'B')
        const reviewB = await beginReview(config, third, 'B', pendingB)
        const beforeHistory = await directSnapshot(config, 'B')
        const historicalResume = await rpc<HostTaskActionView>(third, 'resume', { actionId: 'action-A' }).then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error: errorText(error) })
        )
        // The helper must not block historical readback at its own concurrency boundary.
        if (historicalResume.error) assert.equal(historicalResume.error, 'host-task-action-busy')
        const historicalStop = await result(rpc(third, 'stop', { actionId: 'action-A' }))
        assert.equal(historicalStop.error, 'host-task-action-busy')
        const staleApproval = await result(rpc(third, 'approve', { handle: review.id }))
        assert.equal(staleApproval.error, 'qa-review-not-found')
        const afterHistory = await directSnapshot(config, 'B')
        assert.deepEqual(afterHistory.job, beforeHistory.job)
        assert.deepEqual(afterHistory.requests, beforeHistory.requests)
        assert.deepEqual(terminal(await rpc(third, 'inspect'), 'A'), finalA)
        saveJson(join(directory, 'historical-A-controls.json'), {
          historicalResume,
          historicalStop,
          staleApproval,
          staleApprovalBoundary:
            'Old process-local review resolver is absent; not a production UIhandle rejection claim',
          beforeHistory,
          afterHistory,
        })
        const beforeStop = count(config, 'executor-execute-entry', 'B')
        const stopped = await rpc<HostTaskActionView>(third, 'stop', { actionId: 'action-B' })
        assert.equal(stopped.execution.state, 'stopped')
        assert.equal((await reviewB.pending).error, 'host-task-operation-cancelled')
        abortBeforeStop(config, reviewB.review.id, 'B')
        await rpc(third, 'approve', { handle: reviewB.review.id })
        assert.equal(count(config, 'executor-execute-entry', 'B'), beforeStop)
        const final = await rpc<Readback>(third, 'inspect')
        invariant(initial, final)
        oneWikiRevision(initial, final)
        assert.deepEqual(terminal(final, 'A'), finalA)
        assert.equal(toolClaim(final, 'B').result_json, null)
        assert.deepEqual(final.B?.sources, config.actions.B.envelope.sources)
        assert.equal(count(config, 'real-save-entry'), 1)
        assert.equal(count(config, 'real-save-return'), 1)
        const hostBFinal = await directSnapshot(config, 'B')
        actualStopped(hostBFinal, pendingB)
        const hostAFinal = await directSnapshot(config, 'A')
        assert.equal(hostAFinal.job?.phase, 'completed')
        assert.equal(hostAFinal.events.filter((e) => e.type === 'request-resolved').length, 2)
        assert.equal(hostBFinal.events.filter((e) => e.type === 'request-resolved').length, 1)
        assert.equal(wireCount(config, 'submit'), 2)
        assert.equal(wireCount(config, 'reply', 'A'), 2)
        assert.equal(wireCount(config, 'reply', 'B'), 1)
        assert.equal(wireCount(config, 'stop', 'A'), 0)
        assert.equal(wireCount(config, 'stop', 'B'), 1)
        saveJson(join(directory, 'final-readback.json'), {
          readback: final,
          hostA: hostAFinal,
          hostB: hostBFinal,
          terminalA: finalA,
        })
        await close(third)
        rawCopy(config, 'raw-final-receiver-exit')
        await close(hostA)
        assert(hostB)
        await close(hostB)
        check(
          'positive: actual saved receipt + accepted reply ACK loss, withheld/released pinned A, explicit independent B exact Stop'
        )
      }
    }
    assert.equal(children.filter((c) => c.kind === 'coordinator').length, 4)
    assert.equal(children.filter((c) => c.kind === 'receiver').length, 7)
    assert(children.every((c) => c.exited && c.code === 0 && c.signal === null))
    assert.equal(
      configs.reduce((sum, c) => sum + count(c, 'fake-provider-invoked'), 0),
      4
    )
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = errorText(error)
    proof.stack = error instanceof Error ? error.stack : null
  } finally {
    const cleanupErrors: string[] = []
    for (const child of [
      ...children.filter((c) => c.kind === 'receiver'),
      ...children.filter((c) => c.kind === 'coordinator'),
    ]) {
      if (child.exited) continue
      try {
        if (child.process.connected) child.process.send({ id: ++commandId, op: 'close' })
        await waitExit(child)
        if (child.code !== 0) cleanupErrors.push(`Unexpected ${child.pid} exit:${child.code}/${child.signal}`)
      } catch (error) {
        cleanupErrors.push(errorText(error))
        child.process.kill('SIGTERM')
        try {
          await waitExit(child, 1000)
        } catch {
          child.process.kill('SIGKILL')
          await waitExit(child, 1000).catch((e) => cleanupErrors.push(errorText(e)))
        }
      }
    }
    proof.children = children.map(({ process: _process, ...child }) => child)
    proof.cleanupErrors = cleanupErrors
    proof.sockets = children
      .filter((c) => c.kind === 'coordinator')
      .map((c) => {
        const config = configs.find((x) => x.root === c.root)
        assert(config && c.suffix)
        const path = join(config.actions[c.suffix].prepared.descriptor.directory, 'client.sock')
        return { path, exists: existsSync(path) }
      })
    if (
      cleanupErrors.length ||
      children.some((c) => !c.exited) ||
      (proof.sockets as { exists: boolean }[]).some((s) => s.exists)
    )
      proof.status = 'failed'
    report()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
    if (proof.status !== 'passed') process.exitCode = 1
  }
}

const [mode, directory, suffix] = process.argv.slice(2)
if (mode === '--validate-fixture' && process.argv.length === 3)
  process.stdout.write(`${JSON.stringify(validateFixture(), null, 2)}\n`)
else if (mode === '--receiver' && directory && process.argv.length === 4)
  await receiver(readJson<Config>(join(directory, 'config.json')))
else if (mode === '--coordinator' && directory && (suffix === 'A' || suffix === 'B') && process.argv.length === 5)
  await coordinatorChild(readJson<Config>(join(directory, 'config.json')), suffix)
else if (mode === '--run' && process.argv.length === 3) await main()
else
  throw Error(
    'Use --run for the isolated local composition process proof or --validate-fixture for static coverage; no implicit execution'
  )
