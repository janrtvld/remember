import { createHash, randomUUID } from 'node:crypto'
import { redactSensitiveCaptureText, type SaveWikiPageInput, type WikiPage, type WikiSpace } from '@remember/shared'
import type { EvidenceStore } from './dailyReview/evidenceStore'
import { preserveManagedWikiMetadata } from './dailyReview/knowledgeStore'
import type { HostTaskActionContext } from './hostTaskActionService'
import { canonicalHostTaskJson, type HostTaskEnvelopeV1 } from './hostTaskProtocol'
import type { HostTaskRequest, HostTaskServiceTransport } from './hostTaskServiceTransport'
import type { ResidentAgentStore, ResidentTaskExecution, SavedMemoryReceipt } from './residentAgentStore'
import { createWikiCliRequestHandler, parseWikiCliRequest } from './wikiCliProtocol'

export interface HostTaskMemoryReview {
  actionId: string
  messageId: string
  jobId: string
  threadId: string
  turnId: string
  sessionId: string
  requestId: string
  callId: string
  expiresAt: number
  requestHash: string
  spaceId: 'personal'
  slug: string
  revision: string
  mode: 'auto'
  before: string
  after: string
  summary: string
  contentBefore: string
  contentAfter: string
}
export interface HostTaskMemoryDependencies {
  resident: Pick<ResidentAgentStore, 'hostTaskExecution' | 'claimToolCall' | 'finishToolCall'>
  evidence: Pick<EvidenceStore, 'validateHostTaskForDispatch'>
  transport: Pick<HostTaskServiceTransport, 'snapshot' | 'reply'>
  readContext(): HostTaskActionContext
  validateSources(
    refs: HostTaskEnvelopeV1['sources'],
    signal: AbortSignal
  ): Promise<'valid' | 'unavailable' | 'invalidated'>
  personal: {
    space(): WikiSpace
    pages(): WikiPage[]
    save(input: SaveWikiPageInput): WikiPage[]
    pagePermitted(page: WikiPage): boolean
  }
  ask(review: Readonly<HostTaskMemoryReview>, signal: AbortSignal): Promise<'accept' | 'decline'>
  now?: () => number
}
export type HostTaskMemoryExecution = { status: 'ready'; replyId: string } | { status: 'no-longer-pending' }
export type HostTaskMemoryReply = { status: 'replied' } | { status: 'no-longer-pending' }

type MemoryInput =
  | { action: 'read'; spaceId: 'personal'; slug: string }
  | {
      action: 'patch'
      spaceId: 'personal'
      slug: string
      expectedRevision: string
      before: string
      after: string
      summary: string
    }
type Binding = {
  actionId: string
  execution: ResidentTaskExecution
  request: HostTaskRequest
  input: MemoryInput
  threadId: string
  turnId: string
  callId: string
  callKey: string
  requestHash: string
}
type Operation = { controller: AbortController; release(): void }
type Reply = { binding: Binding; result: unknown; sources: HostTaskEnvelopeV1['sources'] }
const copy = <T>(value: T): T => JSON.parse(canonicalHostTaskJson(value))
const same = (a: unknown, b: unknown) => canonicalHostTaskJson(a) === canonicalHostTaskJson(b)
const hash = (value: unknown) => createHash('sha256').update(canonicalHostTaskJson(value)).digest('hex')
function fail(reason: string): never {
  throw new Error(`host-task-memory-${reason}`)
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in identity and revision strings.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}
function memoryInput(value: unknown): MemoryInput {
  const input = copy(value) as Record<string, unknown>
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 20000)
    fail('input-invalid')
  const fields =
    input.action === 'read'
      ? ['action', 'spaceId', 'slug']
      : ['action', 'spaceId', 'slug', 'expectedRevision', 'before', 'after', 'summary']
  if (
    !['read', 'patch'].includes(String(input.action)) ||
    Object.keys(input).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(input, key))
  )
    fail('input-invalid')
  if (
    input.spaceId !== 'personal' ||
    !text(input.slug, 300) ||
    !/^[a-z0-9]+(?:[a-z0-9/-]*[a-z0-9])?$/.test(input.slug) ||
    ['index', 'log'].includes(input.slug)
  )
    fail('scope-invalid')
  if (
    input.action === 'patch' &&
    (!text(input.expectedRevision, 200) ||
      !text(input.summary, 500) ||
      typeof input.before !== 'string' ||
      input.before.length === 0 ||
      typeof input.after !== 'string' ||
      input.before === input.after)
  )
    fail('input-invalid')
  return input as MemoryInput
}

export class HostTaskMemoryAdapter {
  private operation: Operation | null = null
  private disposed = false
  private replies = new Map<string, Reply>()
  private reads = new Map<string, { pages: number; characters: number }>()
  private now: () => number

  constructor(private dependencies: HostTaskMemoryDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  private begin(signal: AbortSignal): Operation {
    if (this.disposed) fail('disposed')
    if (signal.aborted) fail('cancelled')
    if (this.operation) fail('busy')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const operation = { controller, release: () => signal.removeEventListener('abort', abort) }
    this.operation = operation
    return operation
  }
  private end(operation: Operation) {
    operation.release()
    if (this.operation === operation) this.operation = null
  }
  private alive(operation: Operation) {
    if (this.disposed) fail('disposed')
    if (operation.controller.signal.aborted || this.operation !== operation) fail('cancelled')
  }
  private execution(actionId: string) {
    const execution = this.dependencies.resident.hostTaskExecution(actionId)
    if (!execution) fail('action-missing')
    return execution
  }
  private capture(actionId: string, value: HostTaskRequest): Binding {
    const request = copy(value)
    if (
      !request ||
      request.method !== 'client-tool' ||
      request.status !== 'pending' ||
      !text(request.id, 200) ||
      !text(request.sessionId, 200) ||
      request.payload?.tool !== 'remember_memory'
    )
      fail('request-invalid')
    const payload = request.payload
    if (
      !text(payload.threadId, 200) ||
      !text(payload.turnId, 200) ||
      !text(payload.callId, 200) ||
      !Number.isSafeInteger(payload.expiresAt)
    )
      fail('request-invalid')
    const input = memoryInput(payload.input)
    const execution = this.execution(actionId)
    const original = execution.intent.envelope.sources.find(
      (source) => source.spaceId === 'personal' && source.slug === input.slug && source.explicit
    )
    if (!original) fail('scope-invalid')
    const callKey = canonicalHostTaskJson([
      'host-task-memory-v1',
      actionId,
      execution.intent.envelope.jobId,
      payload.threadId,
      payload.turnId,
      payload.callId,
    ])
    const requestHash = hash({
      envelopeHash: execution.intent.envelopeHash,
      preparedHash: execution.preparedHash,
      request,
      mode: input.action === 'patch' ? 'auto' : null,
      source: { spaceId: original.spaceId, slug: original.slug, explicit: original.explicit },
    })
    return {
      actionId,
      execution,
      request,
      input,
      threadId: payload.threadId,
      turnId: payload.turnId,
      callId: payload.callId,
      callKey,
      requestHash,
    }
  }
  private identity(operation: Operation, binding: Binding) {
    this.alive(operation)
    if (binding.request.payload.expiresAt <= this.now()) fail('request-expired')
    const e = this.execution(binding.actionId)
    if (e.intent.invalidated) fail('context-invalidated')
    if (e.cancellation || e.terminal || !e.intent.sessionReceipt || !['running', 'waiting'].includes(e.state))
      fail('action-inactive')
    if (
      e.intent.envelopeHash !== binding.execution.intent.envelopeHash ||
      e.preparedHash !== binding.execution.preparedHash
    )
      fail('binding-changed')
    if (
      e.observation?.kind !== 'host' ||
      e.observation.job.threadId !== binding.threadId ||
      e.observation.job.turnId !== binding.turnId
    )
      fail('request-invalid')
    const context = this.dependencies.readContext()
    if (
      context.policyFingerprint !== e.intent.envelope.policyFingerprint ||
      !same(context.target, {
        targetId: e.prepared.descriptor.targetId,
        targetEpoch: e.prepared.descriptor.targetEpoch,
        root: e.prepared.descriptor.root,
      })
    )
      fail('context-invalidated')
    if (
      this.dependencies.evidence.validateHostTaskForDispatch(binding.actionId, e.intent.envelopeHash).state !==
      'current'
    )
      fail('context-invalidated')
    return e
  }
  private local(operation: Operation, binding: Binding, refs: HostTaskEnvelopeV1['sources'], own?: WikiPage) {
    const e = this.identity(operation, binding)
    if (!same(e.sources, refs)) fail('source-snapshot-changed')
    const space = copy(this.dependencies.personal.space())
    if (space.id !== 'personal') fail('source-unavailable')
    if (binding.input.action === 'patch' && space.maintenanceMode !== 'auto') fail('mode-changed')
    const pages = this.dependencies.personal.pages()
    for (const source of refs) {
      const found = pages.filter((page) => page.slug === source.slug)
      if (source.spaceId !== 'personal' || found.length !== 1) fail('source-invalidated')
      const page = found[0]
      if (!page || !this.dependencies.personal.pagePermitted(page)) fail('source-unavailable')
      const ownTransition = own && source.slug === binding.input.slug && same(page, own)
      if (page.revision !== source.revision && !ownTransition) fail('source-invalidated')
    }
    const selected = pages.find((page) => page.slug === binding.input.slug)
    if (!selected || !refs.some((ref) => ref.slug === selected.slug && ref.spaceId === 'personal' && ref.explicit))
      fail('scope-invalid')
    // Dependency callbacks may synchronously revoke the action while reading local data.
    this.identity(operation, binding)
    if (!same(this.execution(binding.actionId).sources, refs)) fail('source-snapshot-changed')
    const finalSpace = this.dependencies.personal.space()
    if (!same(space, finalSpace)) fail('mode-changed')
    return copy(selected)
  }
  private async bounded<T>(
    operation: Operation,
    expiresAt: number,
    error: string,
    invoke: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.alive(operation)
    const child = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = () => {}
    const boundary = new Promise<T>((_resolve, reject) => {
      abort = () => {
        reject(new Error(this.disposed ? 'host-task-memory-disposed' : 'host-task-memory-cancelled'))
        child.abort()
      }
      operation.controller.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(
        () => {
          reject(new Error(`host-task-memory-${error}`))
          child.abort()
        },
        Math.max(0, expiresAt - this.now())
      )
    })
    try {
      const result = await Promise.race([boundary, invoke(child.signal)])
      this.alive(operation)
      return result
    } finally {
      clearTimeout(timer)
      operation.controller.signal.removeEventListener('abort', abort)
    }
  }
  private async pending(operation: Operation, binding: Binding) {
    this.alive(operation)
    const result = await this.bounded(
      operation,
      Math.min(binding.request.payload.expiresAt, this.now() + 10000),
      'request-unavailable',
      () => this.dependencies.transport.snapshot(binding.execution.prepared, 0)
    )
    this.alive(operation)
    const snapshot = result.snapshot,
      job = snapshot?.job
    if (
      !same(result.descriptor, binding.execution.prepared.descriptor) ||
      !snapshot ||
      !job ||
      job.id !== binding.execution.intent.envelope.jobId ||
      job.inputHash !== binding.execution.prepared.descriptor.inputHash ||
      !same(job.spec, {
        ...binding.execution.prepared.input,
        workspace: binding.execution.prepared.descriptor.workspace,
      }) ||
      job.threadId !== binding.threadId ||
      job.turnId !== binding.turnId ||
      snapshot.sessionId !== binding.request.sessionId
    )
      fail('request-invalid')
    const matches = snapshot.requests.filter((request) => request.id === binding.request.id)
    if (!matches.length) return false
    if (job.phase !== 'waiting' || matches.length !== 1 || !same(matches[0], binding.request)) fail('request-invalid')
    return true
  }
  private async authorize(operation: Operation, binding: Binding) {
    const refs = copy(this.identity(operation, binding).sources)
    this.local(operation, binding, refs)
    const status = await this.bounded(
      operation,
      Math.min(this.now() + 10000, binding.request.payload.expiresAt),
      'source-unavailable',
      (abort) => this.dependencies.validateSources(copy(refs), abort)
    )
    if (status !== 'valid') fail(status === 'invalidated' ? 'source-invalidated' : 'source-unavailable')
    const final = () => this.local(operation, binding, refs)
    final()
    return { refs, final }
  }
  private async authorizeCurrent(operation: Operation, binding: Binding) {
    const authorized = await this.authorize(operation, binding)
    if (!(await this.pending(operation, binding))) fail('request-not-pending')
    authorized.final()
    return authorized
  }
  private ready(binding: Binding, result: unknown, sources: HostTaskEnvelopeV1['sources']): HostTaskMemoryExecution {
    if (!same(sources, this.execution(binding.actionId).sources)) fail('source-snapshot-changed')
    const output = copy(result)
    if (Buffer.byteLength(JSON.stringify(output)) > 65536) fail('result-too-large')
    const replyId = randomUUID()
    this.replies.set(replyId, { binding, result: output, sources: copy(sources) })
    return { status: 'ready', replyId }
  }
  private expectedPage(page: WikiPage, input: Extract<MemoryInput, { action: 'patch' }>) {
    if (page.revision !== input.expectedRevision) fail('source-invalidated')
    if (page.content.split(input.before).length !== 2) fail('patch-not-unique')
    const content = preserveManagedWikiMetadata(
      `# ${page.title}\n\n${page.content}`,
      page.content.replace(input.before, () => input.after)
    )
      .replace(/\r\n/g, '\n')
      .trim()
    if (content === page.content) fail('patch-no-change')
    if (content.length > 500000) fail('input-invalid')
    return content
  }
  private existingResult(binding: Binding, result: unknown, page: WikiPage) {
    if (same(result, { saved: false, reason: 'user-declined' })) return result
    const saved = {
      kind: 'saved-page',
      saved: true,
      proposed: false,
      spaceId: 'personal',
      slug: page.slug,
      revision: page.revision,
      title: redactSensitiveCaptureText(page.title),
    }
    if (binding.input.action !== 'patch' || page.revision === binding.input.expectedRevision || !same(result, saved))
      fail('receipt-invalid')
    return result
  }

  async execute(actionId: string, request: HostTaskRequest, signal: AbortSignal): Promise<HostTaskMemoryExecution> {
    const operation = this.begin(signal)
    try {
      const binding = this.capture(actionId, request)
      // Absence is only a readback fact. It never authorizes a new call or a success reply.
      if (!(await this.pending(operation, binding))) return { status: 'no-longer-pending' }
      const authorized = await this.authorizeCurrent(operation, binding)
      const page = authorized.final()
      if (binding.input.action === 'read') {
        const budget = this.reads.get(actionId) ?? { pages: 0, characters: 0 }
        if (budget.pages >= 6 || budget.characters >= 12000) fail('read-budget')
        const wiki = createWikiCliRequestHandler({
          getSpaces: () => {
            authorized.final()
            return [this.dependencies.personal.space()]
          },
          listPages: async () => [authorized.final()],
          createPage: async () => fail('scope-invalid'),
          deletePage: async () => fail('scope-invalid'),
          proposePage: async () => fail('scope-invalid'),
          savePage: async () => fail('scope-invalid'),
        })
        const response = await wiki({ id: binding.callId, action: 'wiki.read', spaceId: 'personal', slug: page.slug })
        const current = authorized.final()
        if (!response.ok || !same(response.result, current)) fail('read-unverified')
        const content = redactSensitiveCaptureText(current.content.slice(0, Math.min(6000, 12000 - budget.characters)))
        this.reads.set(actionId, { pages: budget.pages + 1, characters: budget.characters + content.length })
        if (!(await this.pending(operation, binding))) return { status: 'no-longer-pending' }
        ;(await this.authorizeCurrent(operation, binding)).final()
        return this.ready(
          binding,
          {
            spaceId: 'personal',
            slug: current.slug,
            title: redactSensitiveCaptureText(current.title),
            revision: current.revision,
            content,
            truncated: content.length < current.content.length,
            url: `/wiki/page/?space=personal&slug=${encodeURIComponent(current.slug)}`,
          },
          authorized.refs
        )
      }
      const input = binding.input
      if (page.revision === input.expectedRevision) this.expectedPage(page, input)
      const claim = this.dependencies.resident.claimToolCall(binding.callKey, binding.requestHash, {
        actionId,
        messageId: binding.execution.intent.envelope.assistantMessageId,
        toolName: 'remember_memory',
      })
      if (claim.existing) {
        if (claim.result === null) throw new Error('memory-write-outcome-unknown-read-before-retrying')
        authorized.final()
        return this.ready(binding, this.existingResult(binding, claim.result, page), authorized.refs)
      }
      const expectedContent = this.expectedPage(page, input)
      const review: Readonly<HostTaskMemoryReview> = Object.freeze({
        actionId,
        messageId: binding.execution.intent.envelope.assistantMessageId,
        jobId: binding.execution.intent.envelope.jobId,
        threadId: binding.threadId,
        turnId: binding.turnId,
        sessionId: binding.request.sessionId,
        requestId: binding.request.id,
        callId: binding.callId,
        expiresAt: binding.request.payload.expiresAt,
        requestHash: binding.requestHash,
        spaceId: 'personal',
        slug: input.slug,
        revision: input.expectedRevision,
        mode: 'auto',
        before: input.before,
        after: input.after,
        summary: input.summary,
        contentBefore: page.content,
        contentAfter: expectedContent,
      })
      const answer = await this.bounded(operation, binding.request.payload.expiresAt, 'request-expired', (abort) =>
        this.dependencies.ask(review, abort)
      )
      if (answer !== 'accept' && answer !== 'decline') fail('answer-invalid')
      if (!(await this.pending(operation, binding))) return { status: 'no-longer-pending' }
      ;(await this.authorizeCurrent(operation, binding)).final()
      if (answer === 'decline') {
        const result = { saved: false, reason: 'user-declined' }
        this.dependencies.resident.finishToolCall(binding.callKey, result)
        return this.ready(binding, result, authorized.refs)
      }
      let effectStarted = false
      let receipt: SavedMemoryReceipt | null = null
      let receiptSources: HostTaskEnvelopeV1['sources'] | null = null
      const wiki = createWikiCliRequestHandler({
        getSpaces: () => {
          this.local(operation, binding, authorized.refs)
          return [this.dependencies.personal.space()]
        },
        listPages: async () => [this.local(operation, binding, authorized.refs)],
        createPage: async () => fail('scope-invalid'),
        deletePage: async () => fail('scope-invalid'),
        proposePage: async () => fail('mode-changed'),
        savePage: async (value) => {
          if (!(await this.pending(operation, binding))) fail('request-not-pending')
          const final = await this.authorizeCurrent(operation, binding)
          const current = final.final()
          if (
            !same(final.refs, authorized.refs) ||
            this.expectedPage(current, input) !== expectedContent ||
            value.spaceId !== 'personal' ||
            value.slug !== input.slug ||
            value.expectedRevision !== input.expectedRevision ||
            value.strictRevision !== true ||
            value.title !== page.title ||
            value.content !== page.content.replace(input.before, () => input.after)
          )
            fail('effect-invalid')
          final.final()
          effectStarted = true
          const pages = this.dependencies.personal.save(copy(value))
          if (!Array.isArray(pages)) fail('effect-unverified')
          const saved = pages.filter((candidate) => candidate.slug === input.slug)
          const actual = this.dependencies.personal.pages().filter((candidate) => candidate.slug === input.slug)
          const updated = saved[0],
            readback = actual[0]
          if (
            saved.length !== 1 ||
            actual.length !== 1 ||
            !updated ||
            !readback ||
            !text(updated.revision, 200) ||
            updated.revision === input.expectedRevision ||
            updated.title !== page.title ||
            updated.content !== expectedContent ||
            updated.revision !== readback.revision ||
            updated.title !== readback.title ||
            updated.content !== readback.content
          )
            fail('effect-unverified')
          this.local(operation, binding, authorized.refs, readback)
          const verified: SavedMemoryReceipt = {
            kind: 'saved-page',
            saved: true,
            proposed: false,
            spaceId: 'personal',
            slug: input.slug,
            revision: updated.revision,
            title: redactSensitiveCaptureText(updated.title),
          }
          this.dependencies.resident.finishToolCall(binding.callKey, verified, {
            actionId,
            expectedRevision: input.expectedRevision,
          })
          receiptSources = authorized.refs.map((source) =>
            source.spaceId === 'personal' && source.slug === input.slug
              ? { ...source, revision: verified.revision }
              : source
          )
          if (!same(receiptSources, this.execution(actionId).sources)) fail('source-snapshot-changed')
          receipt = verified
          return pages
        },
      })
      const response = await wiki(
        parseWikiCliRequest({ ...input, id: binding.callId, action: 'wiki.patch', client: 'Remember task agent' })
      )
      if (!receipt) {
        if (effectStarted) throw new Error('memory-write-outcome-unknown-read-before-retrying')
        throw new Error(response.ok ? 'host-task-memory-effect-unverified' : response.error)
      }
      if (!(await this.pending(operation, binding))) return { status: 'no-longer-pending' }
      ;(await this.authorizeCurrent(operation, binding)).final()
      if (!receiptSources) fail('receipt-invalid')
      return this.ready(binding, receipt, receiptSources)
    } finally {
      this.end(operation)
    }
  }

  async reply(actionId: string, replyId: string, signal: AbortSignal): Promise<HostTaskMemoryReply> {
    const value = this.replies.get(replyId)
    if (!value || value.binding.actionId !== actionId) fail('reply-invalid')
    const operation = this.begin(signal)
    this.replies.delete(replyId)
    try {
      const { binding } = value
      const sameSources = () => {
        if (!same(value.sources, this.execution(actionId).sources)) fail('source-snapshot-changed')
      }
      sameSources()
      if (!(await this.pending(operation, binding))) return { status: 'no-longer-pending' }
      ;(await this.authorizeCurrent(operation, binding)).final()
      sameSources()
      await this.dependencies.transport.reply(
        binding.execution.prepared,
        {
          sessionId: binding.request.sessionId,
          requestId: binding.request.id,
          result: { success: true, output: copy(value.result) },
          expectedReview: { request: copy(binding.request), threadId: binding.threadId, turnId: binding.turnId },
        },
        async () => {
          const current = await this.authorize(operation, binding)
          return () => {
            current.final()
            sameSources()
          }
        }
      )
      this.alive(operation)
      return { status: 'replied' }
    } finally {
      this.end(operation)
    }
  }
  dispose() {
    this.disposed = true
    this.operation?.controller.abort()
    this.replies.clear()
  }
}
