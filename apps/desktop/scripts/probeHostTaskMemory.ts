import assert from 'node:assert/strict'
import { type ChildProcess, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { createConnection, createServer, type Socket } from 'node:net'
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
import {
  type HostTaskPrepared,
  type HostTaskRouterDescriptor,
  type HostTaskRouterInput,
  validateHostTaskPrepared,
} from '../src/main/hostTaskExecutionProtocol'
import {
  HostTaskMemoryAdapter,
  type HostTaskMemoryExecution,
  type HostTaskMemoryReview,
} from '../src/main/hostTaskMemoryAdapter'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1, hostTaskDefinition } from '../src/main/hostTaskProtocol'
import {
  createHostTaskServiceTransport,
  type HostTaskRawTransport,
  type HostTaskRequest,
  type HostTaskSnapshot,
} from '../src/main/hostTaskServiceTransport'
import { ResidentAgentStore } from '../src/main/residentAgentStore'
import { closeWikiHistoryStore, getWikiPageHistory } from '../src/main/wikiHistoryStore'

type CaseId = 'c1' | 'c2' | 'c3'
type Action = { envelope: HostTaskEnvelopeV1; prepared: HostTaskPrepared }
type Config = {
  root: string
  caseId: CaseId
  profile: string
  registry: string
  actions: { A: Action; B: Action }
  patch: HostTaskRequest
  read: HostTaskRequest
  initialPages: WikiPage[]
  hostCreatedAt: number
}
type Tables = Record<string, Record<string, unknown>[]>
type RawRouter = HostTaskRawTransport & { close(): Promise<void> }
type Readback = {
  resident: Tables
  evidence: Tables
  wiki: Tables
  pages: WikiPage[]
  A: ReturnType<ResidentAgentStore['hostTaskExecution']>
  B: ReturnType<ResidentAgentStore['hostTaskExecution']>
  global: ReturnType<ResidentAgentStore['memorySources']>
  resultsA: ReturnType<ResidentAgentStore['hostTaskResults']>
  resultsB: ReturnType<ResidentAgentStore['hostTaskResults']>
}
type Control = { id: number; op: string; request?: HostTaskRequest; replyId?: string }
type Child = {
  process: ChildProcess
  pid: number
  caseId: CaseId
  exited: boolean
  code: number | null
  signal: string | null
}

const script = fileURLToPath(import.meta.url)
const repository = fileURLToPath(new URL('../../../', import.meta.url))
const targetId = 'synthetic-memory-target'
const targetEpoch = 'synthetic-memory-epoch-1'
const policyFingerprint = 'synthetic-memory-policy-1'
const original = 'SYNTHETIC_A_OLD_VALUE'
const replacement = 'SYNTHETIC_A_REVIEWED_VALUE'
const unrelated = 'SYNTHETIC_B_PRIVATE_CONTROL'
const globalControl = 'SYNTHETIC_GLOBAL_CONTROL'
const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'))
const save = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
const errorText = (value: unknown) => (value instanceof Error ? value.message : String(value))
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
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
  save(join(dest, 'manifest.json'), { at: Date.now(), beforeProductReadOrReopen: true, files })
  return { directory: dest, files }
}

let wireId = 0
async function connectChild(config: Config, descriptor: HostTaskRouterDescriptor) {
  assert.deepEqual(descriptor, config.actions.A.prepared.descriptor)
  const socket = createConnection(join(descriptor.directory, 'client.sock'))
  socket.setEncoding('utf8')
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout } | null =
    null
  let buffer = ''
  const fail = (error: Error) => {
    if (!pending) return
    const old = pending
    pending = null
    clearTimeout(old.timer)
    old.reject(error)
  }
  socket.on('error', fail)
  socket.on('close', () => fail(Error('qa-reply-connection-closed')))
  socket.on('data', (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
      fail(Error('qa-response-too-large'))
      socket.destroy()
      return
    }
    const end = buffer.indexOf('\n')
    if (end < 0) return
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    const request = pending
    if (!request) {
      socket.destroy()
      return
    }
    pending = null
    clearTimeout(request.timer)
    try {
      assert.equal(buffer, '')
      const response = JSON.parse(line)
      assert.equal(response.id, request.id)
      if (response.error) throw Error(response.error)
      assert(Object.hasOwn(response, 'result'))
      request.resolve(response.result)
    } catch (error) {
      request.reject(Error(errorText(error)))
      socket.destroy()
    }
  })
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Error('qa-connect-timeout'))
    }, 5000)
    socket.once('connect', () => {
      clearTimeout(timer)
      done()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  ledger(config.root, 'connected-before-child-return', { path: join(descriptor.directory, 'client.sock') })
  return {
    request(op: string, payload: Record<string, unknown> = {}) {
      if (pending || socket.destroyed) return Promise.reject(Error('qa-child-unavailable'))
      const id = ++wireId
      const frame = `${JSON.stringify({ id, op, ...payload })}\n`
      if (Buffer.byteLength(frame) > 70000) return Promise.reject(Error('qa-request-too-large'))
      return new Promise<unknown>((resolveRequest, reject) => {
        pending = {
          id,
          resolve: resolveRequest,
          reject,
          timer: setTimeout(() => {
            fail(Error('qa-response-timeout'))
            socket.destroy()
          }, 10000),
        }
        ledger(config.root, 'wire-request', { id, op, payload })
        // The persistent connection is ready; no await or queue occurs before this write.
        socket.write(frame)
      })
    },
    close() {
      socket.destroy()
    },
  }
}
async function transport(config: Config) {
  const { openTaskServiceTransport } = await import(
    join(repository, 'experiments/always-on-agent/task-service-transport.mjs')
  )
  const raw = openTaskServiceTransport({
    directory: config.registry,
    targetId,
    targetEpoch,
    connectChild: (descriptor: HostTaskRouterDescriptor) => connectChild(config, descriptor),
  }) as RawRouter
  return { raw, port: createHostTaskServiceTransport(raw) }
}

async function openPeer(config: Config) {
  const descriptor = config.actions.A.prepared.descriptor
  mkdirSync(descriptor.directory, { recursive: true, mode: 0o700 })
  const sockets = new Set<Socket>()
  let job: HostTaskSnapshot['job'] = null
  let request: HostTaskRequest | null = null
  let loseNextAck = false
  let accepted = 0
  const sessionId = `synthetic-session-${config.caseId}`
  const state = () => ({ synthetic: true, noWorker: true, sessionId, job, request, accepted, loseNextAck })
  const persist = () => save(join(config.root, 'synthetic-peer-state.json'), state())
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 70000) {
        socket.destroy()
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      let id: number | null = null
      try {
        assert.equal(buffer, '')
        const input = JSON.parse(line)
        id = input.id
        assert(Number.isSafeInteger(id))
        let result: unknown
        if (input.op === 'hello')
          result = {
            protocol: 'remember-host-job-v1',
            nativeClient: true,
            singleJob: true,
            jobId: job?.id ?? null,
            workspace: descriptor.workspace,
            sessionId,
          }
        else if (input.op === 'snapshot')
          result = { sessionId, pid: process.pid, job, events: [], requests: request ? [request] : [], result: null }
        else if (input.op === 'submit') {
          assert.equal(job, null)
          assert.equal(input.jobId, descriptor.assignment.jobId)
          assert.deepEqual(input.spec, { ...config.actions.A.prepared.input, workspace: descriptor.workspace })
          const now = Date.now()
          job = {
            id: input.jobId,
            inputHash: descriptor.inputHash,
            spec: input.spec,
            phase: 'running',
            threadId: 'thread-A',
            turnId: 'turn-A',
            createdAt: config.hostCreatedAt,
            updatedAt: now,
          }
          persist()
          ledger(config.root, 'synthetic-fixture-admission', { job, noWorker: true })
          result = { created: true, job }
        } else if (input.op === 'reply') {
          assert(job && request)
          assert.equal(input.sessionId, sessionId)
          assert.equal(input.requestId, request.id)
          const resolved = request
          request = null
          job = { ...job, phase: 'running', updatedAt: Math.max(Date.now(), job.updatedAt) }
          accepted++
          const drop = loseNextAck
          loseNextAck = false
          const receipt = { id: resolved.id, sessionId: resolved.sessionId, status: 'resolved' }
          persist()
          save(join(config.root, `peer-accepted-${accepted}.json`), {
            acceptedAt: Date.now(),
            resolved,
            wire: input,
            state: state(),
            receipt,
            ackDropped: drop,
          })
          ledger(config.root, 'peer-accepted-reply', { requestId: resolved.id, result: input.result, ackDropped: drop })
          if (drop) {
            socket.destroy()
            return
          }
          result = receipt
        } else throw Error('qa-peer-unsupported-method')
        socket.write(`${JSON.stringify({ id, result })}\n`)
      } catch (error) {
        socket.write(`${JSON.stringify({ id, error: errorText(error) })}\n`)
      }
    })
  })
  const socketPath = join(descriptor.directory, 'client.sock')
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(socketPath, done)
  })
  persist()
  return {
    socketPath,
    setRequest(value: HostTaskRequest) {
      assert(job)
      assert.equal(request, null)
      assert.equal(value.sessionId, sessionId)
      request = structuredClone(value)
      job = { ...job, phase: 'waiting', updatedAt: Math.max(Date.now(), job.updatedAt) }
      persist()
      ledger(config.root, 'synthetic-pending-request-set', { request })
    },
    dropAck() {
      loseNextAck = true
      persist()
    },
    state,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
    },
  }
}

function snapshotRead(config: Config, resident: ResidentAgentStore): Readback {
  const pages = listKnowledgePagesAt(personalWikiDirectory())
  return {
    resident: rows(join(config.profile, 'conversation.sqlite')),
    evidence: rows(join(config.profile, 'evidence.sqlite')),
    wiki: rows(join(config.profile, 'daily-review/wiki.sqlite')),
    pages,
    A: resident.hostTaskExecution('action-A'),
    B: resident.hostTaskExecution('action-B'),
    global: resident.memorySources(),
    resultsA: resident.hostTaskResults('action-A'),
    resultsB: resident.hostTaskResults('action-B'),
  }
}
async function receiver(config: Config) {
  initializeKnowledgeStore(config.profile)
  const resident = new ResidentAgentStore(join(config.profile, 'conversation.sqlite'))
  const evidence = new EvidenceStore(join(config.profile, 'evidence.sqlite'))
  const { raw, port } = await transport(config)
  let allowCut = config.caseId !== 'c3'
  let pendingReview: { review: Readonly<HostTaskMemoryReview>; resolve(answer: 'accept' | 'decline'): void } | null =
    null
  const adapter = new HostTaskMemoryAdapter({
    resident: {
      hostTaskExecution: resident.hostTaskExecution.bind(resident),
      claimToolCall(...args) {
        ledger(config.root, 'claim-entry', { id: args[0], hash: args[1], binding: args[2] })
        const result = resident.claimToolCall(...args)
        ledger(config.root, 'claim-return', { id: args[0], result })
        if (allowCut && config.caseId === 'c1' && !result.existing) {
          allowCut = false
          save(join(config.root, 'cut94-before-exit.json'), {
            result,
            rows: rows(join(config.profile, 'conversation.sqlite')),
          })
          ledger(config.root, 'process-cut', { code: 94, boundary: 'after real claim before return/review/effect' })
          process.exit(94)
        }
        return result
      },
      finishToolCall(...args) {
        ledger(config.root, 'receipt-entry', { id: args[0], result: args[1], revision: args[2] })
        resident.finishToolCall(...args)
        ledger(config.root, 'receipt-return', { id: args[0], sources: resident.taskMemorySources('action-A') })
      },
    },
    evidence,
    transport: port,
    readContext: () => ({ policyFingerprint, target: { targetId, targetEpoch, root: config.registry } }),
    validateSources: async (refs, signal) => {
      assert(!signal.aborted)
      const pages = listKnowledgePagesAt(personalWikiDirectory())
      const current = refs.every((ref) =>
        pages.some((page) => ref.spaceId === 'personal' && page.slug === ref.slug && page.revision === ref.revision)
      )
      ledger(config.root, 'synthetic-permission-and-real-revision-check', {
        refs,
        current,
        permission: 'synthetic-allowed',
      })
      return current ? 'valid' : 'invalidated'
    },
    personal: {
      space,
      pages: () => listKnowledgePagesAt(personalWikiDirectory()),
      pagePermitted: (page) => page.slug === 'projects/a',
      save(input) {
        assert.equal(input.spaceId, 'personal')
        assert.equal(input.slug, 'projects/a')
        assert.equal(input.strictRevision, true)
        ledger(config.root, 'real-save-entry', { input })
        const saved = saveKnowledgePageAt(personalWikiDirectory(), input)
        const page = saved.find((value) => value.slug === input.slug)
        assert(page)
        ledger(config.root, 'real-save-return', {
          page,
          history: getWikiPageHistory('personal', input.slug),
          markdownHash: createHash('sha256')
            .update(readFileSync(join(personalWikiDirectory(), `${input.slug}.md`)))
            .digest('hex'),
        })
        if (allowCut && config.caseId === 'c2') {
          allowCut = false
          save(join(config.root, 'cut95-before-exit.json'), {
            page,
            history: getWikiPageHistory('personal', input.slug),
            resident: rows(join(config.profile, 'conversation.sqlite')),
            wiki: rows(join(config.profile, 'daily-review/wiki.sqlite')),
          })
          ledger(config.root, 'process-cut', {
            code: 95,
            boundary: 'after actual synchronous Wiki save before primitive return/receipt',
          })
          process.exit(95)
        }
        return saved
      },
    },
    ask(review, signal) {
      assert.equal(pendingReview, null)
      ledger(config.root, 'review-shown', { review })
      process.send?.({ review })
      return new Promise((resolveReview, reject) => {
        const abort = () => {
          pendingReview = null
          reject(Error('qa-review-aborted'))
        }
        pendingReview = {
          review,
          resolve(answer) {
            signal.removeEventListener('abort', abort)
            pendingReview = null
            ledger(config.root, 'review-answered', { requestHash: review.requestHash, answer })
            resolveReview(answer)
          },
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    },
  })
  let busy = false
  process.on('message', async (rawMessage) => {
    const command = rawMessage as Control
    if (command.op === 'approve') {
      try {
        assert(pendingReview)
        pendingReview.resolve('accept')
        process.send?.({ id: command.id, result: true })
      } catch (error) {
        process.send?.({ id: command.id, error: errorText(error) })
      }
      return
    }
    if (busy) {
      process.send?.({ id: command.id, error: 'qa-receiver-busy' })
      return
    }
    busy = true
    try {
      ledger(config.root, 'receiver-command', { command })
      let result: unknown
      if (command.op === 'execute') {
        assert(command.request)
        result = await adapter.execute('action-A', command.request, new AbortController().signal)
      } else if (command.op === 'reply') {
        assert(command.replyId)
        result = await adapter.reply('action-A', command.replyId, new AbortController().signal)
      } else if (command.op === 'inspect') result = snapshotRead(config, resident)
      else if (command.op === 'cut96') {
        ledger(config.root, 'process-cut', {
          code: 96,
          boundary: 'durable receipt and source revision before any reply',
        })
        process.exit(96)
      } else if (command.op === 'close') {
        adapter.dispose()
        await raw.close()
        resident.close()
        evidence.close()
        closeWikiHistoryStore()
        process.exit(0)
      } else throw Error('qa-invalid-command')
      ledger(config.root, 'receiver-result', { id: command.id, result })
      process.send?.({ id: command.id, result })
    } catch (error) {
      ledger(config.root, 'receiver-error', { id: command.id, error: errorText(error) })
      process.send?.({ id: command.id, error: errorText(error) })
    } finally {
      busy = false
    }
  })
  process.send?.({ ready: true, pid: process.pid })
}

function initialAction(
  configRoot: string,
  registry: string,
  item: ReturnType<EvidenceStore['createWorkItem']>,
  page: WikiPage,
  suffix: 'A' | 'B'
): Action {
  assert(page.revision)
  const directory = join(registry, 'jobs', createHash('sha256').update(`job-${suffix}`).digest('hex').slice(0, 24))
  const input: HostTaskRouterInput = {
    prompt: `Explicit synthetic memory Task ${suffix}`,
    systemPrompt: 'Synthetic request only; no provider.',
    model: 'fake-model',
    effort: 'low',
    threadId: null,
    tools: [
      {
        name: 'remember_memory',
        description: 'Bounded synthetic existing Personal read or reviewed patch.',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['read', 'patch'] } },
          required: ['action'],
        },
      },
    ],
    reviewTtlMs: 300000,
  }
  const { reviewTtlMs: _ttl, ...providerInput } = input
  const envelope: HostTaskEnvelopeV1 = {
    version: 1,
    actionId: `action-${suffix}`,
    workItemId: item.id,
    sessionId: `session-${suffix}`,
    jobId: `job-${suffix}`,
    userMessageId: `user-${suffix}`,
    assistantMessageId: `assistant-${suffix}`,
    provider: 'codex',
    instruction: `Explicit synthetic instruction ${suffix}`,
    targetId,
    taskDefinition: hostTaskDefinition(item),
    policyFingerprint,
    sources: [{ spaceId: 'personal', slug: page.slug, revision: page.revision, explicit: true }],
    startedAt: Date.now(),
    preparedInput: { ...providerInput, workspace: join(directory, 'workspace') },
  }
  const prepared: HostTaskPrepared = {
    version: 1,
    descriptor: {
      version: 2,
      targetId,
      targetEpoch,
      root: registry,
      assignment: {
        jobId: envelope.jobId,
        messageId: envelope.assistantMessageId,
        workItemId: envelope.workItemId,
        sessionId: envelope.sessionId,
      },
      directory,
      workspace: envelope.preparedInput.workspace,
      inputHash: hash({ ...input, workspace: envelope.preparedInput.workspace }),
    },
    input,
  }
  assert(configRoot === join(registry, '..'))
  validateHostTaskPrepared(envelope, prepared)
  return { envelope, prepared }
}
function seed(root: string, caseId: CaseId): Config {
  const profile = join(root, 'profile'),
    registry = join(root, 'host')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(registry, { mode: 0o700 })
  initializeKnowledgeStore(profile)
  for (const [suffix, content] of [
    ['a', original],
    ['b', unrelated],
    ['global', globalControl],
  ])
    createKnowledgePageAt(personalWikiDirectory(), {
      spaceId: 'personal',
      category: 'projects',
      slug: `projects/${suffix}`,
      title: `Synthetic ${suffix}`,
      content: `Bounded synthetic page.\n\n${content}`,
    })
  const pages = listKnowledgePagesAt(personalWikiDirectory()).filter((page) => page.slug !== 'index')
  assert.equal(pages.length, 3)
  const resident = new ResidentAgentStore(join(profile, 'conversation.sqlite'))
  const evidence = new EvidenceStore(join(profile, 'evidence.sqlite'))
  try {
    const action = (suffix: 'A' | 'B') => {
      const page = pages.find((candidate) => candidate.slug === `projects/${suffix.toLowerCase()}`)
      assert(page)
      const value = initialAction(
        root,
        registry,
        evidence.createWorkItem(`Synthetic ${suffix}`, 'Human Task stays open.'),
        page,
        suffix
      )
      resident.createPreparedHostTaskIntent(value.envelope, value.prepared)
      resident.acknowledgeHostTaskSession(value.envelope.actionId, evidence.acceptHostTaskSession(value.envelope))
      return value
    }
    const actions = { A: action('A'), B: action('B') }
    const globalPage = pages.find((page) => page.slug === 'projects/global')
    assert(globalPage?.revision)
    resident.recordMemorySources([
      { spaceId: 'personal', slug: globalPage.slug, revision: globalPage.revision, explicit: true },
    ])
    const request = (name: 'read' | 'patch'): HostTaskRequest => ({
      id: `request-${name}`,
      sessionId: `synthetic-session-${caseId}`,
      status: 'pending',
      method: 'client-tool',
      payload: {
        expiresAt: Date.now() + 300000,
        threadId: 'thread-A',
        turnId: 'turn-A',
        callId: `call-${name}`,
        tool: 'remember_memory',
        input:
          name === 'read'
            ? { action: 'read', spaceId: 'personal', slug: 'projects/a' }
            : {
                action: 'patch',
                spaceId: 'personal',
                slug: 'projects/a',
                expectedRevision: actions.A.envelope.sources[0].revision,
                before: original,
                after: replacement,
                summary: 'Synthetic reviewed replacement',
              },
      },
    })
    const config: Config = {
      root,
      caseId,
      profile,
      registry,
      actions,
      initialPages: pages,
      hostCreatedAt: Date.now(),
      read: request('read'),
      patch: request('patch'),
    }
    const preparedHash = resident.hostTaskExecution('action-A')?.preparedHash
    assert(preparedHash)
    resident.commitHostTaskObservation('action-A', { version: 1, kind: 'admission', preparedHash, state: 'registered' })
    resident.commitHostTaskObservation('action-A', {
      version: 1,
      kind: 'admission',
      preparedHash,
      state: 'dispatch-intent',
    })
    resident.commitHostTaskObservation('action-A', {
      version: 1,
      kind: 'host',
      preparedHash,
      coordinatorSessionId: config.patch.sessionId,
      cursor: 1,
      job: {
        jobId: 'job-A',
        inputHash: actions.A.prepared.descriptor.inputHash,
        phase: 'waiting',
        threadId: 'thread-A',
        turnId: 'turn-A',
        createdAt: config.hostCreatedAt,
        updatedAt: config.hostCreatedAt,
        stopReason: null,
      },
      terminalResultHash: null,
      delivery: { kind: 'content', response: '', steps: [] },
    })
    save(join(root, 'config.json'), config)
    save(join(root, 'initial-readback.json'), snapshotRead(config, resident))
    ledger(root, 'fixture-seeded', {
      syntheticHostState: true,
      providerCount: 0,
      rawTaskSource: 'real public store writers',
      wiki: 'production Personal primitives',
    })
    return config
  } finally {
    resident.close()
    evidence.close()
    closeWikiHistoryStore()
  }
}

function validateFixture() {
  assert(original && replacement)
  assert.notEqual(original, replacement)
  assert(!original.includes(unrelated) && !replacement.includes(globalControl))
  return {
    cases: [
      'c1: exit94 after durable claim',
      'c2: exit95 after actual Wiki save before receipt',
      'c3: exit96 durable receipt, still-pending duplicate, accepted reply lost ACK, resolved no replay',
    ],
    actual: [
      'Personal Markdown/history writer',
      'Wiki CLI handler inside adapter',
      'Resident/Evidence stores',
      'frozen transport facade',
      'local socket receipt/ACK loss',
    ],
    synthetic: ['host jobs/requests/times', 'source permission and context', 'review approval'],
    forbidden: ['provider', 'coordinator', 'model', 'native app', 'Mini', 'cloud', 'capture', 'audio'],
    executed: false,
  }
}

async function main() {
  const root = mkdtempSync('/private/tmp/e076-')
  const proof: { status: string; checks: string[]; [key: string]: unknown } = {
    status: 'running',
    root,
    pid: process.pid,
    checks: [],
    boundary: { ...validateFixture(), executed: true },
  }
  const children: Child[] = []
  const peers: Awaited<ReturnType<typeof openPeer>>[] = []
  let commandId = 0
  const report = () => save(join(root, 'report.json'), proof)
  report()
  const count = (config: Config, type: string) => events(config.root).filter((event) => event.type === type).length
  async function waitExit(child: Child) {
    const until = Date.now() + 10000
    while (!child.exited && Date.now() < until) await sleep(10)
    assert(child.exited, `Owned receiver ${child.pid} exited`)
  }
  async function launch(config: Config) {
    const processChild = fork(script, ['--receiver', config.root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    assert(processChild.pid)
    const child: Child = {
      process: processChild,
      pid: processChild.pid,
      caseId: config.caseId,
      exited: false,
      code: null,
      signal: null,
    }
    children.push(child)
    const log = join(config.root, `receiver-${child.pid}.log`)
    writeFileSync(log, '', { mode: 0o600 })
    processChild.stdout?.on('data', (data: Buffer) => appendFileSync(log, data))
    processChild.stderr?.on('data', (data: Buffer) => appendFileSync(log, data))
    processChild.on('exit', (code, signal) => {
      child.exited = true
      child.code = code
      child.signal = signal
      ledger(config.root, 'receiver-exit', { childPid: child.pid, code, signal })
    })
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => finish(Error('qa-ready-timeout')), 10000)
      const receive = (value: unknown) => {
        const message = value as { ready?: boolean; pid?: number }
        if (message.ready) finish(message.pid === child.pid ? undefined : Error('qa-ready-pid-mismatch'))
      }
      const exit = () => finish(Error('qa-exit-before-ready'))
      const finish = (error?: Error) => {
        clearTimeout(timer)
        processChild.off('message', receive)
        processChild.off('exit', exit)
        if (error) reject(error)
        else done()
      }
      processChild.on('message', receive)
      processChild.once('exit', exit)
    })
    return child
  }
  function rpc<T>(child: Child, op: string, payload: Partial<Control> = {}): Promise<T> {
    assert(!child.exited && child.process.connected)
    const id = ++commandId
    return new Promise((done, reject) => {
      const timer = setTimeout(() => finish(Error(`qa-command-timeout:${op}`)), 30000)
      const receive = (value: unknown) => {
        const reply = value as { id?: number; result?: T; error?: string }
        if (reply.id !== id) return
        save(join(root, child.caseId, `command-${id}-${op}.json`), {
          command: { ...payload, id, op },
          reply,
          childPid: child.pid,
        })
        finish(reply.error ? Error(reply.error) : undefined, reply.result)
      }
      const exit = () => finish(Error(`qa-receiver-exit:${child.code}`))
      const finish = (error?: Error, result?: T) => {
        clearTimeout(timer)
        child.process.off('message', receive)
        child.process.off('exit', exit)
        if (error) reject(error)
        else done(result as T)
      }
      child.process.on('message', receive)
      child.process.once('exit', exit)
      child.process.send({ ...payload, id, op })
    })
  }
  async function waitReview(child: Child) {
    return new Promise<HostTaskMemoryReview>((done, reject) => {
      const timer = setTimeout(() => finish(Error('qa-review-timeout')), 10000)
      const receive = (input: unknown) => {
        const value = input as { review?: HostTaskMemoryReview }
        if (value.review) finish(undefined, value.review)
      }
      const exit = () => finish(Error('qa-exit-before-review'))
      const finish = (error?: Error, value?: HostTaskMemoryReview) => {
        clearTimeout(timer)
        child.process.off('message', receive)
        child.process.off('exit', exit)
        if (error) reject(error)
        else {
          assert(value)
          done(value)
        }
      }
      child.process.on('message', receive)
      child.process.once('exit', exit)
    })
  }
  async function close(child: Child) {
    child.process.send({ id: ++commandId, op: 'close' })
    await waitExit(child)
    assert.equal(child.code, 0)
  }
  function invariant(initial: Readback, current: Readback) {
    assert.deepEqual(current.evidence.work_item, initial.evidence.work_item)
    assert.deepEqual(current.evidence.work_item_source, initial.evidence.work_item_source)
    assert.deepEqual(current.B, initial.B)
    assert.deepEqual(current.global, initial.global)
    assert.deepEqual(current.A?.intent.envelope, initial.A?.intent.envelope)
    assert.deepEqual(current.resultsB, [])
    for (const slug of ['projects/b', 'projects/global'])
      assert.deepEqual(
        current.pages.find((p) => p.slug === slug),
        initial.pages.find((p) => p.slug === slug)
      )
  }
  function claim(readback: Readback) {
    assert.equal(readback.resident.assistant_tool_call.length, 1)
    return readback.resident.assistant_tool_call[0]
  }
  function oneWikiRevision(initial: Readback, current: Readback, page: WikiPage) {
    for (const table of Object.keys(initial.wiki)) {
      if (table !== 'wiki_page' && table !== 'wiki_page_revision')
        assert.deepEqual(current.wiki[table], initial.wiki[table])
    }
    const oldPage = initial.wiki.wiki_page.find((row) => row.slug === 'projects/a')
    const newPage = current.wiki.wiki_page.find((row) => row.slug === 'projects/a')
    assert(oldPage && newPage)
    assert.deepEqual(newPage, { ...oldPage, head_revision_id: page.revision })
    assert.deepEqual(
      current.wiki.wiki_page.filter((row) => row.id !== oldPage.id),
      initial.wiki.wiki_page.filter((row) => row.id !== oldPage.id)
    )
    for (const previous of initial.wiki.wiki_page_revision)
      assert.deepEqual(
        current.wiki.wiki_page_revision.find((row) => row.id === previous.id),
        previous
      )
    const previousIds = new Set(initial.wiki.wiki_page_revision.map((row) => row.id))
    const added = current.wiki.wiki_page_revision.filter((row) => !previousIds.has(row.id))
    assert.equal(current.wiki.wiki_page_revision.length, initial.wiki.wiki_page_revision.length + 1)
    assert.equal(added.length, 1)
    assert.equal(added[0].id, page.revision)
    assert.equal(added[0].page_id, oldPage.id)
    assert.equal(added[0].parent_revision_id, oldPage.head_revision_id)
    assert.equal(added[0].title, page.title)
    assert.equal(added[0].content, page.content)
    assert.equal(added[0].operation, 'updated')
    assert.equal(added[0].status, 'committed')
  }
  try {
    for (const caseId of ['c1', 'c2', 'c3'] as const) {
      const directory = join(root, caseId)
      mkdirSync(directory, { mode: 0o700 })
      const config = seed(directory, caseId)
      const initial = json<Readback>(join(directory, 'initial-readback.json'))
      const peer = await openPeer(config)
      peers.push(peer)
      const setup = await transport(config)
      try {
        assert.deepEqual(
          await setup.port.prepare(config.actions.A.prepared.descriptor.assignment, config.actions.A.prepared.input),
          config.actions.A.prepared.descriptor
        )
        await setup.port.register(config.actions.A.prepared)
        await setup.port.submit(config.actions.A.prepared, async () => () => {})
      } finally {
        await setup.raw.close()
      }
      peer.setRequest(config.read)
      const first = await launch(config)
      const read = await rpc<HostTaskMemoryExecution>(first, 'execute', { request: config.read })
      assert.equal(read.status, 'ready')
      assert(read.status === 'ready')
      await rpc(first, 'reply', { replyId: read.replyId })
      const acceptedRead = json<{
        wire: { result: { success: boolean; output: { content: string; revision: string; slug: string } } }
      }>(join(directory, 'peer-accepted-1.json'))
      assert.equal(acceptedRead.wire.result.success, true)
      assert.equal(acceptedRead.wire.result.output.slug, 'projects/a')
      assert.equal(acceptedRead.wire.result.output.revision, config.actions.A.envelope.sources[0].revision)
      assert.equal(acceptedRead.wire.result.output.content, initial.pages.find((p) => p.slug === 'projects/a')?.content)
      assert(!JSON.stringify(acceptedRead).includes(unrelated) && !JSON.stringify(acceptedRead).includes(globalControl))
      const afterRead = await rpc<Readback>(first, 'inspect')
      invariant(initial, afterRead)
      assert.equal(afterRead.resident.assistant_tool_call.length, 0)
      assert.deepEqual(afterRead.A?.sources, initial.A?.sources)
      peer.setRequest(config.patch)
      const reviewPromise = caseId === 'c1' ? null : waitReview(first)
      const executionPromise = rpc<HostTaskMemoryExecution>(first, 'execute', { request: config.patch })
      // Attach an immediate rejection handler; exit cuts are expected but their exact errors are asserted below.
      const execution = executionPromise.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error: errorText(error) })
      )
      if (reviewPromise) {
        const review = await reviewPromise
        assert.equal(review.actionId, 'action-A')
        assert.equal(review.messageId, 'assistant-A')
        assert.equal(review.jobId, 'job-A')
        assert.equal(review.sessionId, config.patch.sessionId)
        assert.equal(review.requestId, config.patch.id)
        assert.equal(review.callId, config.patch.payload.callId)
        assert.equal(review.threadId, 'thread-A')
        assert.equal(review.turnId, 'turn-A')
        assert.equal(review.expiresAt, config.patch.payload.expiresAt)
        assert.equal(review.mode, 'auto')
        assert.equal(review.slug, 'projects/a')
        assert.equal(review.revision, config.actions.A.envelope.sources[0].revision)
        assert.equal(review.before, original)
        assert.equal(review.after, replacement)
        assert.equal(review.contentAfter, review.contentBefore.replace(original, replacement))
        save(join(directory, 'explicit-review.json'), review)
        await rpc(first, 'approve')
      }
      const firstResult = await execution
      if (caseId !== 'c3') {
        await waitExit(first)
        const code = caseId === 'c1' ? 94 : 95
        assert.equal(first.code, code)
        assert.equal(first.signal, null)
        assert.equal(firstResult.error, `qa-receiver-exit:${code}`)
        rawCopy(config, `raw-cut${code}-before-reopen`)
        const savedCount = caseId === 'c1' ? 0 : 1
        assert.equal(count(config, 'real-save-entry'), savedCount)
        assert.equal(count(config, 'real-save-return'), savedCount)
        assert.equal(count(config, 'receipt-return'), 0)
        const second = await launch(config)
        const repeated = await rpc(second, 'execute', { request: config.patch }).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error: errorText(error) })
        )
        assert(repeated.error, 'An uncertain original call must refuse execution; preserve actual reason')
        save(join(directory, 'uncertain-retry-result.json'), repeated)
        const after = await rpc<Readback>(second, 'inspect')
        invariant(initial, after)
        assert.equal(claim(after).result_json, null)
        assert.deepEqual(after.A?.sources, initial.A?.sources)
        assert.deepEqual(after.resultsA, [])
        const page = after.pages.find((p) => p.slug === 'projects/a')
        const before = initial.pages.find((p) => p.slug === 'projects/a')
        assert(page && before)
        if (caseId === 'c1') {
          assert.deepEqual(page, before)
          assert.deepEqual(after.wiki, initial.wiki)
          assert.equal(count(config, 'review-shown'), 0)
        } else {
          assert.equal(page.content, before.content.replace(original, replacement))
          assert.notEqual(page.revision, before.revision)
          oneWikiRevision(initial, after, page)
          assert.equal(count(config, 'review-shown'), 1)
        }
        assert.equal(count(config, 'real-save-entry'), savedCount)
        assert.equal(count(config, 'real-save-return'), savedCount)
        assert.equal(
          count(config, 'peer-accepted-reply'),
          1,
          'Only earlier read was replied; no uncertain write success'
        )
        save(join(directory, 'final-readback.json'), after)
        await close(second)
        proof.checks.push(
          `${caseId}: exit${code}, actual page/history and NULL claim preserved, explicit retry refused without second effect`
        )
      } else {
        assert.equal(firstResult.error, null)
        assert(firstResult.value?.status === 'ready')
        const oldReplyId = firstResult.value.replyId
        const saved = await rpc<Readback>(first, 'inspect')
        invariant(initial, saved)
        assert.equal(count(config, 'real-save-entry'), 1)
        assert.equal(count(config, 'real-save-return'), 1)
        assert.equal(count(config, 'receipt-return'), 1)
        const page = saved.pages.find((p) => p.slug === 'projects/a')
        assert(page?.revision)
        assert.equal(
          page.content,
          initial.pages.find((p) => p.slug === 'projects/a')?.content.replace(original, replacement)
        )
        assert.equal(saved.A?.sources[0].revision, page.revision)
        oneWikiRevision(initial, saved, page)
        const receipt = JSON.parse(String(claim(saved).result_json))
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
        save(join(directory, 'durable-saved-before-cut96.json'), { saved, oldReplyId, receipt })
        first.process.send({ id: ++commandId, op: 'cut96' })
        await waitExit(first)
        assert.equal(first.code, 96)
        rawCopy(config, 'raw-cut96-before-reopen')
        const second = await launch(config)
        const duplicate = await rpc<HostTaskMemoryExecution>(second, 'execute', { request: config.patch })
        assert(duplicate.status === 'ready')
        assert.notEqual(duplicate.replyId, oldReplyId)
        const replayed = await rpc<Readback>(second, 'inspect')
        assert.deepEqual(replayed, saved)
        assert.equal(count(config, 'real-save-entry'), 1)
        assert.equal(count(config, 'review-shown'), 1)
        save(join(directory, 'still-pending-duplicate.json'), {
          originalRequestStillHasOldRevision: config.patch,
          duplicate,
          readback: replayed,
        })
        peer.dropAck()
        const replyError = await rpc(second, 'reply', { replyId: duplicate.replyId }).then(() => null, errorText)
        assert.equal(replyError, 'qa-reply-connection-closed')
        assert.equal(peer.state().accepted, 2)
        assert.equal(peer.state().request, null)
        const acceptedPatch = json<{
          ackDropped: boolean
          wire: { result: { success: boolean; output: unknown } }
          state: { request: unknown }
        }>(join(directory, 'peer-accepted-2.json'))
        assert.equal(acceptedPatch.ackDropped, true)
        assert.equal(acceptedPatch.state.request, null)
        assert.deepEqual(acceptedPatch.wire.result, { success: true, output: receipt })
        await close(second)
        const third = await launch(config)
        assert.deepEqual(await rpc(third, 'execute', { request: config.patch }), { status: 'no-longer-pending' })
        const final = await rpc<Readback>(third, 'inspect')
        assert.deepEqual(final, saved)
        assert.equal(count(config, 'real-save-entry'), 1)
        assert.equal(count(config, 'real-save-return'), 1)
        assert.equal(count(config, 'review-shown'), 1)
        assert.equal(count(config, 'peer-accepted-reply'), 2)
        save(join(directory, 'final-readback.json'), final)
        await close(third)
        proof.checks.push(
          'c3: exact still-pending duplicate reuses durable A-r2 receipt; actual accepted reply loses ACK, resolved restart makes no new effect or reply'
        )
      }
      await peer.close()
      assert(!existsSync(peer.socketPath))
      report()
    }
    assert.equal(children.length, 7)
    assert.deepEqual(
      children.map((child) => child.code),
      [94, 0, 95, 0, 96, 0, 0]
    )
    assert(children.every((child) => child.exited && child.signal === null))
    assert.equal(peers.length, 3)
    assert(peers.every((peer) => !existsSync(peer.socketPath)))
    proof.status = 'passed'
  } catch (error) {
    proof.status = 'failed'
    proof.error = errorText(error)
    proof.stack = error instanceof Error ? error.stack : null
  } finally {
    const cleanupErrors: string[] = []
    for (const child of children) {
      if (child.exited) continue
      try {
        child.process.send({ id: ++commandId, op: 'close' })
        await waitExit(child)
        if (child.code !== 0) cleanupErrors.push(`Unexpected exit ${child.pid}:${child.code}`)
      } catch (error) {
        cleanupErrors.push(errorText(error))
        child.process.kill('SIGTERM')
        await waitExit(child).catch((failure) => cleanupErrors.push(errorText(failure)))
      }
    }
    for (const peer of peers) {
      if (!existsSync(peer.socketPath)) continue
      await peer.close().catch((error) => cleanupErrors.push(errorText(error)))
    }
    proof.children = children.map(({ process: _process, ...child }) => child)
    proof.sockets = peers.map((peer) => ({ path: peer.socketPath, exists: existsSync(peer.socketPath) }))
    proof.cleanupErrors = cleanupErrors
    if (
      cleanupErrors.length ||
      children.some((child) => !child.exited) ||
      peers.some((peer) => existsSync(peer.socketPath))
    )
      proof.status = 'failed'
    report()
    process.stdout.write(`${JSON.stringify({ status: proof.status, report: join(root, 'report.json') })}\n`)
    if (proof.status !== 'passed') process.exitCode = 1
  }
}

const [mode, path] = process.argv.slice(2)
if (mode === '--validate-fixture' && process.argv.length === 3)
  process.stdout.write(`${JSON.stringify(validateFixture(), null, 2)}\n`)
else if (mode === '--receiver' && path && process.argv.length === 4)
  await receiver(json<Config>(join(path, 'config.json')))
else if (mode === '--run' && process.argv.length === 3) await main()
else
  throw Error(
    'Use --run for the isolated process proof or --validate-fixture for static coverage; no implicit execution'
  )
