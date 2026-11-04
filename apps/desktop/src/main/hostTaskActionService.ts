import { randomUUID } from 'node:crypto'
import type { EvidenceStore } from './dailyReview/evidenceStore'
import { type HostTaskPrepared, validateHostTaskPrepared } from './hostTaskExecutionProtocol'
import {
  canonicalHostTaskJson,
  type HostTaskEnvelopeV1,
  hostTaskDefinition,
  hostTaskDefinitionHash,
  validateHostTaskEnvelope,
} from './hostTaskProtocol'
import {
  accumulateHostSnapshot,
  type HostTaskProjection,
  type HostTaskRequest,
  type HostTaskRouterResult,
  type HostTaskServiceTransport,
} from './hostTaskServiceTransport'
import type { ResidentAgentStore, ResidentTaskExecution } from './residentAgentStore'

export interface HostTaskActionContext {
  policyFingerprint: string
  target: { targetId: string; targetEpoch: string; root: string }
}
export interface HostTaskActionReview {
  id: string
  actionId: string
  messageId: string
  jobId: string
  threadId: string
  turnId: string
  sessionId: string
  requestId: string
  expiresAt: number
  question: string
}
export interface HostTaskActionView {
  execution: ResidentTaskExecution
  reviews: HostTaskActionReview[]
  issue?: string
  pendingMemoryRequest?: HostTaskRequest
}
export interface HostTaskMemoryExecutor {
  execute(
    actionId: string,
    request: HostTaskRequest,
    signal: AbortSignal
  ): Promise<{ status: 'ready'; replyId: string } | { status: 'no-longer-pending' }>
  reply(
    actionId: string,
    replyId: string,
    signal: AbortSignal
  ): Promise<{ status: 'replied' } | { status: 'no-longer-pending' }>
  dispose(): void
}
export interface HostTaskActionDependencies {
  resident: ResidentAgentStore
  evidence: EvidenceStore
  transport: HostTaskServiceTransport
  readContext(): HostTaskActionContext
  validateSources(
    refs: HostTaskEnvelopeV1['sources'],
    signal: AbortSignal
  ): Promise<'valid' | 'unavailable' | 'invalidated'>
  now?: () => number
  memoryExecutor?: HostTaskMemoryExecutor
  onAdmission?(actionId: string): void
  onChange?(actionId: string): void
}
type Operation = { actionId: string; controller: AbortController }
type BoundReview = { view: HostTaskActionReview; request: HostTaskRequest }
type SourceStatus = 'valid' | 'unavailable' | 'invalidated'
const same = (a: unknown, b: unknown) => canonicalHostTaskJson(a) === canonicalHostTaskJson(b)

export class HostTaskActionService {
  private operation: Operation | null = null
  private slot: string | null = null
  private disposed = false
  private handles = new Map<string, BoundReview>()
  private now: () => number

  constructor(private dependencies: HostTaskActionDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  private alive(op: Operation) {
    if (this.disposed) throw new Error('host-task-action-disposed')
    if (op.controller.signal.aborted || this.operation !== op) throw new Error('host-task-operation-cancelled')
  }

  private begin(actionId: string, stop = false): Operation {
    if (this.disposed) throw new Error('host-task-action-disposed')
    const unsettled = this.dependencies.resident.unresolvedHostTaskExecutions()
    if ((this.slot && this.slot !== actionId) || unsettled.some((e) => e.intent.envelope.actionId !== actionId))
      throw new Error('host-task-action-busy')
    if (this.operation) {
      if (!stop || this.operation.actionId !== actionId) throw new Error('host-task-action-busy')
      this.operation.controller.abort()
    }
    const op = { actionId, controller: new AbortController() }
    this.operation = op
    this.slot = actionId
    return op
  }

  private end(op: Operation) {
    if (this.operation !== op) return
    this.operation = null
    const execution = this.dependencies.resident.hostTaskExecution(op.actionId)
    if (!execution || execution.cancellation || (execution.intent.outcome && execution.intent.outcomeReceipt))
      this.slot = null
  }

  private execution(actionId: string) {
    const execution = this.dependencies.resident.hostTaskExecution(actionId)
    if (!execution) throw new Error('host-task-execution-not-found')
    return execution
  }

  private syncContext(op: Operation, envelope: HostTaskEnvelopeV1, prepared: HostTaskPrepared) {
    this.alive(op)
    const execution = this.dependencies.resident.hostTaskExecution(envelope.actionId)
    if (execution?.intent.invalidated) throw new Error('host-task-context-invalidated')
    const context = this.dependencies.readContext()
    if (
      !same(context.target, {
        targetId: prepared.descriptor.targetId,
        targetEpoch: prepared.descriptor.targetEpoch,
        root: prepared.descriptor.root,
      }) ||
      context.policyFingerprint !== envelope.policyFingerprint
    )
      throw new Error('host-task-context-invalidated')
    if (execution?.intent.sessionReceipt) {
      if (
        this.dependencies.evidence.validateHostTaskForDispatch(envelope.actionId, execution.intent.envelopeHash)
          .state !== 'current'
      )
        throw new Error('host-task-context-invalidated')
    } else {
      const item = this.dependencies.evidence.getWorkItem(envelope.workItemId)
      if (
        !item ||
        item.lifecycle !== 'open' ||
        hostTaskDefinitionHash(hostTaskDefinition(item)) !== hostTaskDefinitionHash(envelope.taskDefinition)
      )
        throw new Error('host-task-context-invalidated')
    }
  }

  private sources(envelope: HostTaskEnvelopeV1) {
    return this.dependencies.resident.hostTaskExecution(envelope.actionId)?.sources ?? envelope.sources
  }

  private async sourceCheck(op: Operation, refs: HostTaskEnvelopeV1['sources']): Promise<SourceStatus> {
    this.alive(op)
    const validation = new AbortController()
    let abort: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<SourceStatus>((resolve, reject) => {
      abort = () => {
        reject(new Error(this.disposed ? 'host-task-action-disposed' : 'host-task-operation-cancelled'))
        validation.abort()
      }
      op.controller.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => {
        resolve('unavailable')
        validation.abort()
      }, 10_000)
    })
    try {
      const result = await Promise.race([
        this.dependencies.validateSources(structuredClone(refs), validation.signal),
        bounded,
      ])
      this.alive(op)
      if (!['valid', 'unavailable', 'invalidated'].includes(result))
        throw new Error('host-task-source-response-invalid')
      return result
    } finally {
      clearTimeout(timer)
      op.controller.signal.removeEventListener('abort', abort)
    }
  }

  private async guard(op: Operation, envelope: HostTaskEnvelopeV1, prepared: HostTaskPrepared) {
    this.syncContext(op, envelope, prepared)
    const refs = this.sources(envelope)
    const result = await this.sourceCheck(op, refs)
    const final = () => {
      this.syncContext(op, envelope, prepared)
      if (!same(refs, this.sources(envelope))) throw new Error('host-task-source-snapshot-changed')
      if (result !== 'valid') throw new Error(`host-task-context-${result}`)
    }
    final()
    return final
  }

  private async contextStatus(
    op: Operation,
    execution: ResidentTaskExecution
  ): Promise<{ state: SourceStatus; final?: () => void }> {
    try {
      const final = await this.guard(op, execution.intent.envelope, execution.prepared)
      final()
      return { state: 'valid', final }
    } catch (error) {
      this.alive(op)
      if (error instanceof Error && error.message === 'host-task-context-invalidated') return { state: 'invalidated' }
      if (
        error instanceof Error &&
        ['host-task-context-unavailable', 'host-task-source-snapshot-changed'].includes(error.message)
      )
        return { state: 'unavailable' }
      throw error
    }
  }

  private projectOutcome(actionId: string) {
    const e = this.execution(actionId)
    if (e.intent.outcome && !e.intent.outcomeReceipt)
      this.dependencies.resident.acknowledgeHostTaskOutcome(
        actionId,
        this.dependencies.evidence.applyHostTaskOutcome(e.intent.envelope, e.intent.outcome)
      )
  }

  private view(actionId: string, issue?: string): HostTaskActionView {
    return { execution: this.execution(actionId), reviews: this.reviews(actionId), ...(issue ? { issue } : {}) }
  }

  async start(input: unknown, supplied: unknown): Promise<HostTaskActionView> {
    const { envelope } = validateHostTaskEnvelope(input)
    const { prepared } = validateHostTaskPrepared(envelope, supplied)
    if (this.dependencies.resident.hostTaskExecution(envelope.actionId))
      throw new Error('host-task-start-already-prepared')
    const op = this.begin(envelope.actionId)
    let stage: 'preparing' | 'prepared' | 'registering' | 'registered' | 'dispatch' = 'preparing'
    try {
      ;(await this.guard(op, envelope, prepared))()
      const descriptor = await this.dependencies.transport.prepare(prepared.descriptor.assignment, prepared.input)
      this.alive(op)
      if (!same(descriptor, prepared.descriptor)) throw new Error('host-task-prepared-mismatch')
      ;(await this.guard(op, envelope, prepared))()
      this.dependencies.resident.createPreparedHostTaskIntent(envelope, prepared)
      stage = 'prepared'
      this.dependencies.resident.acknowledgeHostTaskSession(
        envelope.actionId,
        this.dependencies.evidence.acceptHostTaskSession(envelope)
      )
      this.dependencies.onAdmission?.(envelope.actionId)
      this.dependencies.onChange?.(envelope.actionId)
      ;(await this.guard(op, envelope, prepared))()
      stage = 'registering'
      const registered = await this.dependencies.transport.register(prepared)
      this.alive(op)
      if (!same(registered, prepared.descriptor)) throw new Error('host-task-prepared-mismatch')
      this.dependencies.resident.commitHostTaskObservation(envelope.actionId, {
        version: 1,
        kind: 'admission',
        preparedHash: this.execution(envelope.actionId).preparedHash,
        state: 'registered',
      })
      stage = 'registered'
      ;(await this.guard(op, envelope, prepared))()
      this.dependencies.resident.commitHostTaskObservation(envelope.actionId, {
        version: 1,
        kind: 'admission',
        preparedHash: this.execution(envelope.actionId).preparedHash,
        state: 'dispatch-intent',
      })
      stage = 'dispatch'
      await this.dependencies.transport.submit(prepared, () => this.guard(op, envelope, prepared))
      this.alive(op)
      return await this.observe(op)
    } catch (error) {
      if (
        !this.disposed &&
        this.operation === op &&
        !op.controller.signal.aborted &&
        error instanceof Error &&
        error.message === 'host-task-context-invalidated'
      ) {
        const execution = this.dependencies.resident.hostTaskExecution(envelope.actionId)
        if (execution) {
          this.dependencies.resident.invalidateHostTaskAction(envelope.actionId)
          this.handles.clear()
          if (stage === 'prepared') {
            this.dependencies.resident.commitHostTaskObservation(envelope.actionId, {
              version: 1,
              kind: 'cancelled-unsubmitted',
              preparedHash: execution.preparedHash,
              cancellation: { kind: 'unsubmitted', at: this.now() },
            })
          } else if (stage === 'registered') {
            const cancelled = await this.dependencies.transport.cancelUnsubmitted(prepared)
            this.alive(op)
            this.acceptCancellation(execution, cancelled)
          } else if (stage === 'dispatch') {
            await this.dependencies.transport.stop(prepared).catch(() => undefined)
            this.alive(op)
          }
        }
      }
      throw error
    } finally {
      this.end(op)
    }
  }

  private acceptCancellation(execution: ResidentTaskExecution, result: HostTaskRouterResult) {
    if (
      !same(result.descriptor, execution.prepared.descriptor) ||
      result.state !== 'cancelled-unsubmitted' ||
      result.snapshot !== null ||
      !result.cancellation
    )
      throw new Error('host-task-cancellation-unconfirmed')
    this.dependencies.resident.commitHostTaskObservation(execution.intent.envelope.actionId, {
      version: 1,
      kind: 'cancelled-unsubmitted',
      preparedHash: execution.preparedHash,
      cancellation: result.cancellation,
    })
  }

  private async drain(op: Operation, execution: ResidentTaskExecution) {
    let projection: HostTaskProjection | null = null
    const prior = execution.observation
    if (prior?.kind === 'host' && prior.delivery.kind === 'content')
      projection = { observation: prior, requests: [], cursor: prior.cursor, sessionChanged: false, drained: true }
    for (let page = 0; page < 110; page++) {
      const afterSeq = projection?.cursor ?? 0
      const result = await this.dependencies.transport.snapshot(execution.prepared, afterSeq)
      this.alive(op)
      if (!same(result.descriptor, execution.prepared.descriptor)) throw new Error('host-task-prepared-mismatch')
      if (result.state === 'cancelled-unsubmitted') return { result, projection: null }
      if (!result.snapshot) return { result, projection: null }
      projection = accumulateHostSnapshot(execution.prepared, projection, result.snapshot, afterSeq)
      if (projection.sessionChanged) this.handles.clear()
      if (result.snapshot.events.length < 100) return { result, projection }
    }
    throw new Error('host-task-journal-limit')
  }

  private async observe(op: Operation, mayStop = true, mayProcessMemory = true): Promise<HostTaskActionView> {
    let execution = this.execution(op.actionId)
    if (execution.cancellation) return this.view(op.actionId)
    const { result, projection } = await this.drain(op, execution)
    if (result.state === 'cancelled-unsubmitted') {
      this.acceptCancellation(execution, result)
      this.handles.clear()
      return this.view(op.actionId)
    }
    if (!projection?.observation) {
      this.handles.clear()
      return this.view(op.actionId, 'host-task-start-unconfirmed')
    }
    const validation = await this.contextStatus(op, execution)
    this.alive(op)
    let state = validation.state
    try {
      this.syncContext(op, execution.intent.envelope, execution.prepared)
      validation.final?.()
    } catch (error) {
      this.alive(op)
      if (error instanceof Error && error.message === 'host-task-context-invalidated') state = 'invalidated'
      else if (error instanceof Error && error.message === 'host-task-source-snapshot-changed') state = 'unavailable'
      else throw error
    }
    if (state === 'invalidated') {
      this.dependencies.resident.invalidateHostTaskAction(op.actionId)
      this.handles.clear()
      if (mayStop && !['completed', 'stopped'].includes(projection.observation.job.phase)) {
        await this.dependencies.transport.stop(execution.prepared)
        this.alive(op)
        return this.observe(op, false, false)
      }
    }
    execution = this.execution(op.actionId)
    const observation = projection.observation
    const sanitizedStop = state === 'invalidated' && observation.job.phase === 'stopped'
    const delivery =
      state === 'valid'
        ? observation.delivery
        : sanitizedStop
          ? { kind: 'content' as const, response: '', steps: [] }
          : {
              kind: 'withheld' as const,
              reason: state === 'invalidated' ? ('context-invalidated' as const) : ('context-unavailable' as const),
            }
    this.dependencies.resident.commitHostTaskObservation(op.actionId, { ...observation, delivery })
    this.projectOutcome(op.actionId)
    this.dependencies.onChange?.(op.actionId)
    const memory = this.dependencies.memoryExecutor
    this.refreshReviews(op.actionId, state === 'valid' && !memory ? projection : null)
    const request = state === 'valid' && memory ? this.memoryRequest(projection) : null
    if (memory && request && mayProcessMemory) {
      let failed = false
      try {
        validation.final?.()
        this.syncContext(op, execution.intent.envelope, execution.prepared)
        const executed = await memory.execute(op.actionId, structuredClone(request), op.controller.signal)
        this.alive(op)
        if (executed.status === 'ready' && typeof executed.replyId === 'string' && executed.replyId.length > 0) {
          const replied = await memory.reply(op.actionId, executed.replyId, op.controller.signal)
          this.alive(op)
          if (!['replied', 'no-longer-pending'].includes(replied.status))
            throw new Error('host-task-memory-response-invalid')
        } else if (executed.status !== 'no-longer-pending') {
          throw new Error('host-task-memory-response-invalid')
        }
      } catch {
        this.alive(op)
        failed = true
      }
      // Each explicit call owns one attempt; reconciliation never executes a successor or retries an uncertain effect.
      const current = await this.observe(op, mayStop, false)
      return failed ? { ...current, issue: current.issue ?? 'host-task-memory-request-failed' } : current
    }
    const unsupported =
      state === 'valid' &&
      (memory ? projection.requests.length > 0 && !request : projection.requests.some((r) => !this.reviewQuestion(r)))
    const view = this.view(
      op.actionId,
      unsupported
        ? 'host-task-effect-unsupported'
        : state === 'unavailable'
          ? 'host-task-context-unavailable'
          : undefined
    )
    return request ? { ...view, pendingMemoryRequest: request } : view
  }

  async reconcile(actionId: string): Promise<HostTaskActionView> {
    const execution = this.execution(actionId)
    if (execution.observation?.kind === 'host' && execution.observation.delivery.kind === 'withheld')
      return this.view(actionId, 'host-task-context-unavailable')
    return this.resumeOperation(actionId, false)
  }

  async resume(actionId: string): Promise<HostTaskActionView> {
    return this.resumeOperation(actionId, true)
  }

  private async resumeOperation(actionId: string, mayProcessMemory: boolean): Promise<HostTaskActionView> {
    const e = this.execution(actionId)
    if (e.cancellation || (e.intent.outcome && e.intent.outcomeReceipt)) return this.view(actionId)
    const op = this.begin(actionId)
    try {
      this.projectOutcome(actionId)
      if (e.intent.outcome) return this.view(actionId)
      if (e.state === 'prepared' || e.state === 'registered') return this.view(actionId, 'host-task-not-submitted')
      return await this.observe(op, true, mayProcessMemory)
    } finally {
      this.end(op)
    }
  }

  async stop(actionId: string): Promise<HostTaskActionView> {
    const op = this.begin(actionId, true)
    this.handles.clear()
    try {
      const e = this.execution(actionId)
      if (e.cancellation || e.intent.outcome) {
        this.projectOutcome(actionId)
        return this.view(actionId)
      }
      if (e.state === 'prepared' || e.state === 'registered') {
        let cancelled: HostTaskRouterResult
        try {
          cancelled = await this.dependencies.transport.cancelUnsubmitted(e.prepared)
        } catch (error) {
          this.alive(op)
          if (e.state !== 'prepared' || !(error instanceof Error) || error.message !== 'router-job-missing') throw error
          // Local prepared ownership has never crossed the durable submit-intent boundary.
          cancelled = {
            descriptor: e.prepared.descriptor,
            state: 'cancelled-unsubmitted',
            snapshot: null,
            cancellation: { kind: 'unsubmitted', at: this.now() },
          }
        }
        this.alive(op)
        this.acceptCancellation(e, cancelled)
        return this.view(actionId)
      }
      await this.dependencies.transport.stop(e.prepared)
      this.alive(op)
      return await this.observe(op, false, false)
    } finally {
      this.end(op)
    }
  }

  private memoryRequest(projection: HostTaskProjection): HostTaskRequest | null {
    const observation = projection.observation
    if (!observation || observation.job.phase !== 'waiting' || projection.requests.length !== 1) return null
    const request = projection.requests[0]
    if (
      !request ||
      request.method !== 'client-tool' ||
      request.status !== 'pending' ||
      request.payload.tool !== 'remember_memory' ||
      request.sessionId !== observation.coordinatorSessionId ||
      !observation.job.threadId ||
      !observation.job.turnId ||
      request.payload.threadId !== observation.job.threadId ||
      request.payload.turnId !== observation.job.turnId ||
      !request.payload.callId ||
      request.payload.expiresAt <= this.now()
    )
      return null
    const input = request.payload.input
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const value = input as Record<string, unknown>
    const fields =
      value.action === 'read'
        ? ['action', 'spaceId', 'slug']
        : ['action', 'spaceId', 'slug', 'expectedRevision', 'before', 'after', 'summary']
    if (
      !['read', 'patch'].includes(String(value.action)) ||
      value.spaceId !== 'personal' ||
      Object.keys(value).length !== fields.length ||
      fields.some((field) => typeof value[field] !== 'string')
    )
      return null
    return structuredClone(request)
  }

  private reviewQuestion(request: HostTaskRequest): string | null {
    const input = request.payload.input
    if (
      request.method !== 'client-tool' ||
      request.payload.tool !== 'remember_memory' ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input)
    )
      return null
    const value = input as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'action,question' ||
      value.action !== 'qa_review' ||
      typeof value.question !== 'string' ||
      !value.question.trim() ||
      value.question.length > 2000
    )
      return null
    return value.question
  }

  private refreshReviews(actionId: string, projection: HostTaskProjection | null) {
    const previous = this.handles
    this.handles = new Map()
    if (!projection?.observation || projection.observation.job.phase !== 'waiting') return
    const e = this.execution(actionId),
      job = projection.observation.job
    for (const request of projection.requests) {
      const question = this.reviewQuestion(request)
      if (
        !question ||
        request.payload.expiresAt <= this.now() ||
        !job.threadId ||
        !job.turnId ||
        request.payload.threadId !== job.threadId ||
        request.payload.turnId !== job.turnId ||
        request.sessionId !== projection.observation.coordinatorSessionId
      )
        continue
      const old = [...previous.values()].find(
        (entry) => entry.view.actionId === actionId && same(entry.request, request)
      )
      const view: HostTaskActionReview = {
        id: old?.view.id ?? randomUUID(),
        actionId,
        messageId: e.intent.envelope.assistantMessageId,
        jobId: job.jobId,
        threadId: job.threadId,
        turnId: job.turnId,
        sessionId: request.sessionId,
        requestId: request.id,
        expiresAt: request.payload.expiresAt,
        question,
      }
      this.handles.set(view.id, { view, request: structuredClone(request) })
    }
  }

  reviews(actionId: string): HostTaskActionReview[] {
    return [...this.handles.values()]
      .filter((h) => h.view.actionId === actionId && h.view.expiresAt > this.now())
      .map((h) => structuredClone(h.view))
  }

  async answer(actionId: string, handleId: string, answer: { approved: boolean }): Promise<HostTaskActionView> {
    const approved = answer.approved
    const bound = this.handles.get(handleId)
    if (!bound || bound.view.actionId !== actionId || bound.view.expiresAt <= this.now())
      throw new Error('host-task-review-invalid')
    if (canonicalHostTaskJson(answer) !== canonicalHostTaskJson({ approved }) || typeof approved !== 'boolean')
      throw new Error('host-task-review-invalid')
    const op = this.begin(actionId)
    this.handles.delete(handleId)
    try {
      const e = this.execution(actionId)
      const check = async () => {
        const final = await this.guard(op, e.intent.envelope, e.prepared)
        return () => {
          final()
          if (bound.view.expiresAt <= this.now()) throw new Error('host-task-review-invalid')
        }
      }
      ;(await check())()
      const result = await this.dependencies.transport.snapshot(e.prepared, 0)
      this.alive(op)
      if (
        !same(result.descriptor, e.prepared.descriptor) ||
        !result.snapshot ||
        result.snapshot.sessionId !== bound.view.sessionId ||
        !result.snapshot.requests.some((r) => same(r, bound.request)) ||
        result.snapshot.job?.threadId !== bound.view.threadId ||
        result.snapshot.job.turnId !== bound.view.turnId
      )
        throw new Error('host-task-review-invalid')
      await this.dependencies.transport.reply(
        e.prepared,
        {
          sessionId: bound.view.sessionId,
          requestId: bound.view.requestId,
          result: { success: true, output: { approved } },
          expectedReview: {
            request: structuredClone(bound.request),
            threadId: bound.view.threadId,
            turnId: bound.view.turnId,
          },
        },
        check
      )
      this.alive(op)
      return await this.observe(op)
    } catch (error) {
      if (
        !this.disposed &&
        this.operation === op &&
        error instanceof Error &&
        error.message === 'host-task-context-invalidated'
      ) {
        this.dependencies.resident.invalidateHostTaskAction(actionId)
        await this.dependencies.transport.stop(this.execution(actionId).prepared).catch(() => undefined)
      }
      throw error
    } finally {
      this.end(op)
    }
  }

  invalidate(actionId: string): void {
    if (this.disposed) throw new Error('host-task-action-disposed')
    this.execution(actionId)
    try {
      this.dependencies.resident.invalidateHostTaskAction(actionId)
    } finally {
      if (this.operation?.actionId === actionId) this.operation.controller.abort()
      for (const [id, handle] of this.handles) {
        if (handle.view.actionId === actionId) this.handles.delete(id)
      }
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.operation?.controller.abort()
    this.operation = null
    this.handles.clear()
    try {
      this.dependencies.memoryExecutor?.dispose()
    } finally {
      this.dependencies.transport.dispose()
    }
  }
}
