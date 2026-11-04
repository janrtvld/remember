import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  AssistantConversation,
  AssistantTaskAction,
  AssistantTaskDraft,
  WikiPage,
  WorkItem,
} from '@remember/shared'
import {
  type HostTaskActionDependencies,
  HostTaskActionService,
  type HostTaskActionView,
} from './hostTaskActionService'
import { type HostTaskPrepared, type HostTaskRouterInput, validateHostTaskPrepared } from './hostTaskExecutionProtocol'
import { HostTaskMemoryAdapter, type HostTaskMemoryDependencies } from './hostTaskMemoryAdapter'
import {
  canonicalHostTaskJson,
  type HostTaskEnvelopeV1,
  hostTaskDefinition,
  hostTaskDefinitionHash,
  validateHostTaskEnvelope,
} from './hostTaskProtocol'
import type { HostTaskRequest } from './hostTaskServiceTransport'
import type { ResidentTaskExecution } from './residentAgentStore'

export interface HostTaskRuntimeManifest {
  version: 1
  targetId: string
  targetEpoch: string
  root: string
  source: { spaceId: 'personal'; slug: string }
  computerExecutionKey: string
  slots: Array<{ jobId: string; directory: string; workspace: string; endpoint: string }>
}
export interface HostTaskRuntimeDependencies
  extends Omit<HostTaskActionDependencies, 'memoryExecutor' | 'onAdmission' | 'onChange'> {
  manifest: HostTaskRuntimeManifest
  taskPermitted(item: WorkItem): boolean
  personal: HostTaskMemoryDependencies['personal']
  ask: HostTaskMemoryDependencies['ask']
  providerInput(input: { instruction: string; item: WorkItem; page: WikiPage }): HostTaskRouterInput
  changed(): void
  pollIntervalMs?: number
}
const same = (a: unknown, b: unknown) => canonicalHostTaskJson(a) === canonicalHostTaskJson(b)
const copy = <T>(value: T): T => structuredClone(value)
function invalidManifest(): never {
  throw new Error('host-task-manifest-invalid')
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidManifest()
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalidManifest()
  return record
}
function identity(value: unknown, max = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Identity strings must not contain controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}
export function validateHostTaskRuntimeManifest(raw: unknown): HostTaskRuntimeManifest {
  const m = object(raw, ['version', 'targetId', 'targetEpoch', 'root', 'source', 'computerExecutionKey', 'slots'])
  if (
    m.version !== 1 ||
    !identity(m.targetId) ||
    !identity(m.targetEpoch) ||
    !identity(m.computerExecutionKey, 4000) ||
    !identity(m.root, 1000) ||
    !path.isAbsolute(m.root) ||
    path.normalize(m.root) !== m.root ||
    m.root.endsWith('/')
  )
    invalidManifest()
  const source = object(m.source, ['spaceId', 'slug'])
  if (
    source.spaceId !== 'personal' ||
    !identity(source.slug, 300) ||
    !/^[a-z0-9]+(?:[a-z0-9/-]*[a-z0-9])?$/.test(source.slug) ||
    ['index', 'log'].includes(source.slug)
  )
    invalidManifest()
  if (!Array.isArray(m.slots) || m.slots.length !== 2) invalidManifest()
  const jobs = new Set<string>(),
    endpoints = new Set<string>()
  for (const value of m.slots) {
    const slot = object(value, ['jobId', 'directory', 'workspace', 'endpoint'])
    if (!identity(slot.jobId) || jobs.has(slot.jobId) || !identity(slot.endpoint)) invalidManifest()
    const match = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(slot.endpoint)
    if (!match || Number(match[1]) > 65535 || endpoints.has(slot.endpoint)) invalidManifest()
    const directory = `${m.root}/jobs/${createHash('sha256').update(slot.jobId).digest('hex').slice(0, 24)}`
    if (slot.directory !== directory || slot.workspace !== `${directory}/workspace`) invalidManifest()
    jobs.add(slot.jobId)
    endpoints.add(slot.endpoint)
  }
  return copy(raw as HostTaskRuntimeManifest)
}
type Draft = {
  value: AssistantTaskDraft
  context: ReturnType<HostTaskActionDependencies['readContext']>
  createdAt: number
}
type Flight = { actionId: string; done: Promise<void> }
type Admission = {
  text: string
  promise: Promise<AssistantConversation>
  resolve(value: AssistantConversation): void
  reject(error: unknown): void
}

export class HostTaskRuntime {
  private readonly manifest: HostTaskRuntimeManifest
  private readonly service: HostTaskActionService
  private readonly now: () => number
  private drafts = new Map<string, Draft>()
  private admissions = new Map<string, Admission>()
  private statuses = new Map<string, { connection: AssistantTaskAction['connection']; issue?: string }>()
  private attempted = new Set<string>()
  private lease: string | null = null
  private flight: Flight | null = null
  private preparing: string | null = null
  private reviewAction: string | null = null
  private disposed = false
  private generation = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private invalidationStops: Promise<unknown>[] = []
  private failedInvalidations = new Set<string>()

  constructor(private dependencies: HostTaskRuntimeDependencies) {
    this.manifest = validateHostTaskRuntimeManifest(dependencies.manifest)
    this.now = dependencies.now ?? Date.now
    const memory = new HostTaskMemoryAdapter({
      ...dependencies,
      ask: async (review, signal) => {
        this.reviewAction = review.actionId
        this.statuses.set(review.actionId, { connection: 'connected' })
        this.changed()
        try {
          return await dependencies.ask(review, signal)
        } finally {
          if (this.reviewAction === review.actionId) this.reviewAction = null
          this.changed()
        }
      },
    })
    this.service = new HostTaskActionService({
      ...dependencies,
      memoryExecutor: {
        execute: (actionId, request, signal) => {
          this.attempted.add(this.requestKey(actionId, request))
          return memory.execute(actionId, request, signal)
        },
        reply: (...args) => memory.reply(...args),
        dispose: () => memory.dispose(),
      },
      onAdmission: (actionId) => {
        this.preparing = null
        this.admissions.get(actionId)?.resolve(this.snapshot())
      },
      onChange: () => this.changed(),
    })
    const interval = dependencies.pollIntervalMs ?? 750
    if (interval > 0) {
      this.timer = setInterval(() => {
        void this.poll()
      }, interval)
      this.timer.unref()
    }
  }
  private alive() {
    if (this.disposed) throw new Error('host-task-runtime-disposed')
  }
  private changed() {
    if (!this.disposed) this.dependencies.changed()
  }
  private execution(actionId: string): ResidentTaskExecution {
    const e = this.dependencies.resident.hostTaskExecution(actionId)
    if (
      !e ||
      !this.manifest.slots.some((slot) => slot.jobId === e.intent.envelope.jobId) ||
      e.prepared.descriptor.targetId !== this.manifest.targetId ||
      e.prepared.descriptor.targetEpoch !== this.manifest.targetEpoch ||
      e.prepared.descriptor.root !== this.manifest.root
    )
      throw new Error('host-task-action-not-found')
    return e
  }
  private bound(input: { actionId: string; messageId: string }) {
    this.alive()
    const e = this.execution(input.actionId)
    if (e.intent.envelope.assistantMessageId !== input.messageId) throw new Error('host-task-message-mismatch')
    return e
  }
  private context() {
    const context = this.dependencies.readContext()
    if (
      !same(context.target, {
        targetId: this.manifest.targetId,
        targetEpoch: this.manifest.targetEpoch,
        root: this.manifest.root,
      })
    )
      throw new Error('host-task-target-changed')
    return copy(context)
  }
  private current(workItemId: string) {
    const item = this.dependencies.evidence.getWorkItem(workItemId)
    if (!item || item.lifecycle !== 'open' || !this.dependencies.taskPermitted(item))
      throw new Error('host-task-draft-stale')
    const space = copy(this.dependencies.personal.space())
    const page = this.dependencies.personal.pages().find((p) => p.slug === this.manifest.source.slug)
    if (
      space.id !== 'personal' ||
      space.maintenanceMode !== 'auto' ||
      !page?.revision ||
      !this.dependencies.personal.pagePermitted(page)
    )
      throw new Error('host-task-draft-stale')
    return { item: copy(item), page: copy(page) }
  }
  draft(workItemId: string): AssistantTaskDraft {
    this.alive()
    const context = this.context(),
      { item, page } = this.current(workItemId)
    const value: AssistantTaskDraft = {
      token: randomUUID(),
      workItemId,
      definitionHash: hostTaskDefinitionHash(hostTaskDefinition(item)),
      title: item.title,
      text: [item.title, item.description].filter(Boolean).join('\n\n'),
      source: { spaceId: 'personal', slug: page.slug, title: page.title, revision: page.revision! },
    }
    if (this.drafts.size >= 64) this.drafts.delete(this.drafts.keys().next().value as string)
    this.drafts.set(value.token, { value: copy(value), context, createdAt: this.now() })
    return value
  }
  private validateDraft(draft: Draft) {
    if (this.now() - draft.createdAt > 10 * 60_000) throw new Error('host-task-draft-expired')
    const context = this.context(),
      current = this.current(draft.value.workItemId)
    if (
      !same(context, draft.context) ||
      hostTaskDefinitionHash(hostTaskDefinition(current.item)) !== draft.value.definitionHash ||
      current.page.revision !== draft.value.source.revision
    )
      throw new Error('host-task-draft-stale')
    return current
  }
  async send(input: { token: string; text: string }): Promise<AssistantConversation> {
    this.alive()
    if (!identity(input.token) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000)
      throw new Error('host-task-input-invalid')
    const previous = this.admissions.get(input.token)
    if (previous) {
      if (previous.text !== input.text) throw new Error('host-task-send-conflict')
      return this.dependencies.resident.getHostTaskIntent(input.token)?.sessionReceipt
        ? this.snapshot()
        : previous.promise
    }
    const existing = this.dependencies.resident.hostTaskExecution(input.token)
    if (existing) {
      this.execution(input.token)
      if (existing.intent.envelope.instruction !== input.text) throw new Error('host-task-send-conflict')
      return this.snapshot()
    }
    const draft = this.drafts.get(input.token)
    if (!draft) throw new Error('host-task-draft-expired')
    if (this.preparing || this.flight || this.dependencies.resident.unresolvedHostTaskExecutions().length)
      throw new Error('host-task-action-busy')
    const current = this.validateDraft(draft)
    const slot = this.manifest.slots.find((s) => !this.dependencies.resident.hostTaskExecutionForJob(s.jobId))
    if (!slot) throw new Error('host-task-slots-exhausted')
    this.preparing = input.token
    const generation = this.generation
    let resolve!: Admission['resolve'], reject!: Admission['reject']
    const promise = new Promise<AssistantConversation>((yes, no) => {
      resolve = yes
      reject = no
    })
    this.admissions.set(input.token, { text: input.text, promise, resolve, reject })
    const launch = async () => {
      const provider = copy(this.dependencies.providerInput({ instruction: input.text, ...current }))
      const assignment = {
        jobId: slot.jobId,
        messageId: randomUUID(),
        workItemId: current.item.id,
        sessionId: randomUUID(),
      }
      const descriptor = await this.dependencies.transport.prepare(assignment, provider)
      this.alive()
      if (this.generation !== generation) throw new Error('host-task-draft-stale')
      const latest = this.validateDraft(draft)
      if (descriptor.directory !== slot.directory || descriptor.workspace !== slot.workspace)
        throw new Error('host-task-prepared-mismatch')
      const { reviewTtlMs: _ttl, ...preparedInput } = provider
      const envelope: HostTaskEnvelopeV1 = {
        version: 1,
        actionId: input.token,
        workItemId: latest.item.id,
        sessionId: assignment.sessionId,
        jobId: slot.jobId,
        userMessageId: randomUUID(),
        assistantMessageId: assignment.messageId,
        provider: 'codex',
        instruction: input.text,
        targetId: this.manifest.targetId,
        taskDefinition: hostTaskDefinition(latest.item),
        policyFingerprint: draft.context.policyFingerprint,
        sources: [{ spaceId: 'personal', slug: latest.page.slug, revision: latest.page.revision!, explicit: true }],
        startedAt: this.now(),
        preparedInput: { ...preparedInput, workspace: slot.workspace },
      }
      validateHostTaskEnvelope(envelope)
      const prepared: HostTaskPrepared = { version: 1, input: provider, descriptor }
      validateHostTaskPrepared(envelope, prepared)
      this.lease = input.token
      return this.service.start(envelope, prepared)
    }
    this.launch(input.token, launch).then(() => {
      if (!this.dependencies.resident.hostTaskExecution(input.token)) this.admissions.delete(input.token)
    })
    return promise
  }
  private requestKey(actionId: string, request: HostTaskRequest) {
    return canonicalHostTaskJson([actionId, request])
  }
  private launch(actionId: string, operation: () => Promise<HostTaskActionView>): Promise<void> {
    const flight: Flight = { actionId, done: Promise.resolve() }
    this.flight = flight
    this.statuses.set(actionId, { connection: 'connecting' })
    this.changed()
    flight.done = Promise.resolve()
      .then(operation)
      .then(
        (view) => {
          if (this.flight !== flight || this.disposed) return
          this.statuses.set(actionId, { connection: 'connected', ...(view.issue ? { issue: view.issue } : {}) })
          if (
            view.issue ||
            view.execution.intent.invalidated ||
            view.execution.cancellation ||
            view.execution.intent.outcome
          )
            this.lease = null
          this.admissions.get(actionId)?.resolve(this.snapshot())
        },
        (_error: unknown) => {
          this.admissions.get(actionId)?.reject(_error)
          if (this.flight !== flight || this.disposed) return
          this.lease = null
          this.statuses.set(actionId, { connection: 'disconnected', issue: 'host-task-operation-unconfirmed' })
        }
      )
      .finally(() => {
        if (this.flight === flight) this.flight = null
        if (this.preparing === actionId) this.preparing = null
        this.changed()
      })
    return flight.done
  }
  private async poll() {
    if (this.disposed || this.flight || this.preparing) return
    const actionId = this.lease
    if (!actionId) return
    let next: HostTaskRequest | undefined
    await this.launch(actionId, async () => {
      const view = await this.service.reconcile(actionId)
      next = view.pendingMemoryRequest
      return view
    })
    if (
      !this.disposed &&
      this.lease === actionId &&
      next &&
      !this.attempted.has(this.requestKey(actionId, next)) &&
      !this.dependencies.resident.hasUnresolvedHostTaskMemoryClaim(actionId)
    ) {
      this.attempted.add(this.requestKey(actionId, next))
      void this.launch(actionId, () => this.service.resume(actionId))
    }
  }
  private action(e: ResidentTaskExecution): AssistantTaskAction {
    const { actionId, assistantMessageId: messageId, workItemId } = e.intent.envelope
    const runtime = this.statuses.get(actionId)
    const withheld = e.observation?.kind === 'host' && e.observation.delivery.kind === 'withheld'
    const uncertainClaim =
      this.dependencies.resident.hasUnresolvedHostTaskMemoryClaim(actionId) && this.reviewAction !== actionId
    let state: AssistantTaskAction['state']
    if (e.cancellation) state = 'cancelled'
    else if (e.intent.outcome) state = e.intent.outcome.status === 'completed' ? 'completed' : 'stopped'
    else if (withheld) state = 'withheld'
    else if (uncertainClaim) state = 'claimed-unknown'
    else if (this.reviewAction === actionId) state = 'waiting'
    else if (e.state === 'prepared' || e.state === 'registered') state = 'prepared'
    else if (runtime?.issue || !runtime || e.state === 'recovery-required' || e.state === 'dispatch-intent')
      state = 'unknown'
    else state = e.state === 'waiting' ? 'waiting' : 'running'
    const message = this.dependencies.resident.get(messageId)
    const stoppedReason =
      state === 'stopped'
        ? e.terminal?.stopReason === 'request-expired' || message?.error === 'assistant-host-request-expired'
          ? 'assistant-host-request-expired'
          : message?.status === 'cancelled' && message.error === 'assistant-host-context-invalidated'
            ? 'assistant-host-context-invalidated'
            : undefined
        : undefined
    const issue = stoppedReason ?? runtime?.issue
    const terminal = ['completed', 'stopped', 'cancelled'].includes(state)
    const allowedControls: AssistantTaskAction['allowedControls'] = terminal
      ? e.intent.outcome && !e.intent.outcomeReceipt
        ? ['check']
        : []
      : e.state === 'prepared' || e.state === 'registered'
        ? ['cancel']
        : this.flight?.actionId === actionId
          ? ['stop']
          : ['check', 'stop']
    return {
      actionId,
      messageId,
      workItemId,
      state,
      connection: runtime?.connection ?? 'disconnected',
      allowedControls,
      ...(issue ? { issue } : {}),
    }
  }
  snapshot(before?: string): AssistantConversation {
    const base = this.dependencies.resident.conversation(null, before)
    const { hostJob: _hostJob, ...conversation } = base
    const unresolved = this.dependencies.resident
      .unresolvedHostTaskExecutions()
      .filter((e) => this.manifest.slots.some((s) => s.jobId === e.intent.envelope.jobId))
    const active = unresolved[0] ? this.action(unresolved[0]) : null
    return {
      ...conversation,
      execution: 'remote',
      remoteRecoveryRequired: false,
      remoteRecoveryMessageId: null,
      taskActionsEnabled: true,
      activeTaskAction: active,
      activeTurnId: active?.messageId ?? null,
      messages: base.messages.map((message) => {
        const e = this.dependencies.resident.hostTaskExecutionForMessage(message.id)
        return e && this.manifest.slots.some((s) => s.jobId === e.intent.envelope.jobId)
          ? { ...message, taskAction: this.action(e) }
          : message
      }),
    }
  }
  async control(input: {
    actionId: string
    messageId: string
    command: 'check' | 'stop' | 'cancel'
  }): Promise<AssistantConversation> {
    const e = this.bound(input)
    if (!['check', 'stop', 'cancel'].includes(input.command)) throw new Error('host-task-control-invalid')
    if (e.cancellation || (e.intent.outcome && e.intent.outcomeReceipt)) return this.snapshot()
    this.lease = null
    if (input.command === 'cancel' && !['prepared', 'registered'].includes(e.state))
      throw new Error('host-task-control-invalid')
    if (this.failedInvalidations.has(input.actionId)) {
      this.service.invalidate(input.actionId)
      this.failedInvalidations.delete(input.actionId)
    }
    if (input.command !== 'check') await this.launch(input.actionId, () => this.service.stop(input.actionId))
    else {
      if (this.flight) throw new Error('host-task-action-busy')
      const unknown = this.dependencies.resident.hasUnresolvedHostTaskMemoryClaim(input.actionId)
      void this.launch(input.actionId, () =>
        unknown ? this.service.reconcile(input.actionId) : this.service.resume(input.actionId)
      )
    }
    return this.snapshot()
  }
  async recover(): Promise<void> {
    this.alive()
    this.lease = null
    if (this.flight) throw new Error('host-task-action-busy')
    for (const e of this.dependencies.resident.unresolvedHostTaskExecutions()) {
      this.execution(e.intent.envelope.actionId)
      if (this.failedInvalidations.has(e.intent.envelope.actionId)) continue
      await this.launch(e.intent.envelope.actionId, () => this.service.reconcile(e.intent.envelope.actionId))
    }
  }
  invalidate(): void {
    this.alive()
    this.generation++
    this.drafts.clear()
    this.lease = null
    let failure: unknown
    for (const e of this.dependencies.resident.unresolvedHostTaskExecutions()) {
      const actionId = e.intent.envelope.actionId
      try {
        this.service.invalidate(actionId)
        this.failedInvalidations.delete(actionId)
      } catch (error) {
        failure ??= error
        this.failedInvalidations.add(actionId)
      }
      const stopped = this.launch(actionId, async () => {
        if (!this.failedInvalidations.has(actionId)) return this.service.stop(actionId)
        // Stop the exact job, but a failed durable privacy latch cannot authorize importing its reply.
        await this.dependencies.transport.stop(e.prepared)
        return { execution: this.execution(actionId), reviews: [], issue: 'host-task-invalidation-unconfirmed' }
      })
      this.invalidationStops.push(stopped)
    }
    this.changed()
    if (failure) throw failure
  }
  async prepareForDeletion(): Promise<void> {
    this.invalidate()
    await Promise.all(this.invalidationStops)
    this.invalidationStops = []
    if (this.dependencies.resident.unresolvedHostTaskExecutions().length) throw new Error('host-task-stop-unconfirmed')
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.lease = null
    this.drafts.clear()
    clearInterval(this.timer)
    this.service.dispose()
  }
}
export const createHostTaskRuntime = (dependencies: HostTaskRuntimeDependencies) => new HostTaskRuntime(dependencies)
