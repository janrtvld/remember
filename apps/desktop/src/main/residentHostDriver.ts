import { setTimeout as delay } from 'node:timers/promises'
import type {
  AgentInteraction,
  AgentInteractionAnswer,
  AgentTurnStep,
  AgentTurnUpdate,
  AssistantHostStopReason,
  RemoteAgentComputer,
} from '@remember/shared'
import { type CodexClientTool, callCodexClientTool } from './codexClientTools'
import type { ResidentHostRun } from './residentAgentStore'
import { connectResidentHost, type ResidentHostConnection } from './residentHostConnection'

const MAX_HOST_SPEC_BYTES = 64 * 1024
const MAX_HOST_RESULT_BYTES = 64 * 1024
const MAX_HOST_FRAME_BYTES = 70_000

function replyFrameBytes(requestId: string, sessionId: string, result: unknown) {
  return Buffer.byteLength(
    `${JSON.stringify({ requestId, sessionId, result, id: Number.MAX_SAFE_INTEGER, op: 'reply' })}\n`
  )
}

type HostRequest = {
  id: string
  sessionId: string
  method: 'client-tool' | 'provider-approval'
  payload: {
    expiresAt: number
    tool?: string
    input?: unknown
    threadId?: string
    turnId?: string
    callId?: string
    request?: Pick<AgentInteraction, 'title' | 'detail' | 'fields' | 'actions' | 'url'>
  }
}
type Snapshot = {
  sessionId: string
  job: {
    id: string
    phase: string
    threadId: string | null
    turnId: string | null
    stopReason?: AssistantHostStopReason
  } | null
  result?: { response: string; threadId: string } | null
  requests: HostRequest[]
  events: { seq: number; type: string; payload: Record<string, unknown>; createdAt: number }[]
}
type Input = {
  turnId: string
  prompt: string
  instruction: string
  threadId: string | null
  hostRun: ResidentHostRun | null
  onHostRun: (binding: ResidentHostRun) => void
  onThread: (id: string) => void
  onUpdate: (update: AgentTurnUpdate) => void
  computer: RemoteAgentComputer
  model: string
  effort: string
  instructions: string
  tools: CodexClientTool[]
  ask: (
    request: Pick<AgentInteraction, 'title' | 'detail' | 'fields' | 'actions' | 'url'>,
    signal: AbortSignal
  ) => Promise<AgentInteractionAnswer>
  assertAvailable: () => void
}

function prepareSubmission(input: Input) {
  let payload: {
    jobId: string
    spec: {
      workspace: string
      model: string
      effort: string
      prompt: string
      systemPrompt: string
      threadId: string | null
      reviewTtlMs: number
      tools: { name: string; description: string; inputSchema: object }[]
    }
  }
  try {
    payload = JSON.parse(
      JSON.stringify({
        jobId: input.turnId,
        spec: {
          workspace: input.computer.workspace,
          model: input.model,
          effort: input.effort,
          prompt: input.prompt,
          systemPrompt: input.instructions,
          threadId: input.threadId,
          reviewTtlMs: 300_000,
          tools: input.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      })
    )
  } catch {
    throw new Error('host-invalid-spec')
  }
  const { jobId, spec } = payload
  if (
    typeof jobId !== 'string' ||
    !jobId ||
    jobId !== jobId.trim() ||
    jobId.length > 200 ||
    [...jobId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    typeof spec.workspace !== 'string' ||
    typeof spec.prompt !== 'string' ||
    spec.prompt.length > 30_000 ||
    typeof spec.model !== 'string' ||
    !/^[a-z0-9.-]{1,80}$/.test(spec.model) ||
    typeof spec.systemPrompt !== 'string' ||
    spec.systemPrompt.length > 20_000 ||
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(spec.effort) ||
    (spec.threadId !== null && (typeof spec.threadId !== 'string' || spec.threadId.length > 200)) ||
    !Array.isArray(spec.tools) ||
    spec.tools.length > 1 ||
    spec.tools.some(
      (tool) =>
        tool?.name !== 'remember_memory' ||
        typeof tool.description !== 'string' ||
        tool.description.length > 4000 ||
        !tool.inputSchema ||
        typeof tool.inputSchema !== 'object'
    )
  )
    throw new Error('host-invalid-spec')

  // Mirror the coordinator journal bounds before recording an uncertain dispatch.
  let nodes = 0
  function validateDepth(value: unknown, depth: number) {
    if (++nodes > 10_000 || depth > 20) throw new Error('host-invalid-spec')
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) validateDepth(child, depth + 1)
    }
  }
  validateDepth(spec, 0)
  if (
    Buffer.byteLength(JSON.stringify(spec)) > MAX_HOST_SPEC_BYTES ||
    Buffer.byteLength(`${JSON.stringify({ ...payload, id: Number.MAX_SAFE_INTEGER, op: 'submit' })}\n`) >
      MAX_HOST_FRAME_BYTES
  )
    throw new Error('host-spec-too-large')
  return payload
}

function parseStopReason(value: unknown): AssistantHostStopReason | undefined {
  if (value === undefined || value === 'request-expired') return value
  throw new Error('invalid-host-stop-reason')
}

export function createResidentHostDriver(endpoint: string) {
  const active = new Map<string, AbortController>()

  async function run(input: Input) {
    const startedAt = Date.now()
    const controller = new AbortController()
    active.set(input.turnId, controller)
    let connection: ResidentHostConnection | null = null
    let binding: ResidentHostRun | null = input.hostRun
    let response = ''
    const steps: AgentTurnStep[] = []
    const pending = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
    const seen = new Set<string>()
    let requestFailure: Error | null = null
    let sessionId: string | null = null
    const save = (change: Partial<ResidentHostRun>) => {
      if (!binding) throw new Error('host-binding-missing')
      binding = { ...binding, ...change }
      input.onHostRun(binding)
    }
    const cancelReviews = () => {
      for (const item of pending.values()) {
        clearTimeout(item.timer)
        item.controller.abort()
      }
      pending.clear()
    }
    const handleRequest = (request: HostRequest, sessionId: string, job: NonNullable<Snapshot['job']>) => {
      if (seen.has(request.id)) return
      if (
        request.sessionId !== sessionId ||
        !Number.isSafeInteger(request.payload.expiresAt) ||
        request.payload.expiresAt <= Date.now()
      )
        return
      seen.add(request.id)
      const local = new AbortController()
      const signal = AbortSignal.any([controller.signal, local.signal])
      const timer = setTimeout(() => local.abort(), Math.min(300_000, request.payload.expiresAt - Date.now()))
      pending.set(request.id, { controller: local, timer })
      void (async () => {
        input.assertAvailable()
        let result: unknown
        if (request.method === 'client-tool') {
          const tool = input.tools.find((tool) => tool.name === request.payload.tool)
          const { threadId, turnId, callId } = request.payload
          if (
            !tool ||
            threadId !== job.threadId ||
            turnId !== job.turnId ||
            typeof callId !== 'string' ||
            !callId ||
            callId.length > 200
          )
            throw new Error('unsupported-host-client-tool')
          const called = await callCodexClientTool(tool, request.payload.input, { threadId, turnId, callId, signal })
          const text = called.contentItems[0]?.text ?? ''
          result = called.success ? { success: true, output: JSON.parse(text) } : { success: false, error: text }
          if (
            Buffer.byteLength(JSON.stringify(result)) > MAX_HOST_RESULT_BYTES ||
            replyFrameBytes(request.id, sessionId, result) > MAX_HOST_FRAME_BYTES
          )
            result = { success: false, error: 'remember-tool-result-too-large' }
        } else if (request.method === 'provider-approval' && request.payload.request) {
          result = await input.ask(request.payload.request, signal)
        } else throw new Error('unsupported-host-request')
        if (signal.aborted) return
        input.assertAvailable()
        if (!connection) throw new Error('host-client-detached')
        if (replyFrameBytes(request.id, sessionId, result) > MAX_HOST_FRAME_BYTES)
          throw new Error('host-reply-frame-too-large')
        await connection.request('reply', { requestId: request.id, sessionId, result })
      })()
        .catch((error) => {
          if (!signal.aborted) requestFailure = error instanceof Error ? error : new Error('host-request-failed')
        })
        .finally(() => {
          clearTimeout(timer)
          pending.delete(request.id)
        })
    }
    try {
      input.assertAvailable()
      const submission = binding ? null : prepareSubmission(input)
      connection = await connectResidentHost(binding?.endpoint ?? endpoint, controller.signal)
      const hello = await connection.request<{
        protocol: string
        nativeClient: boolean
        singleJob: boolean
        jobId?: string | null
        workspace: string
      }>('hello')
      if (
        hello.protocol !== 'remember-host-job-v1' ||
        hello.nativeClient !== true ||
        hello.singleJob !== true ||
        hello.workspace !== input.computer.workspace
      )
        throw new Error('unsupported-host-capability')
      input.assertAvailable()
      if (controller.signal.aborted) throw new Error('host-client-detached')
      if (!binding) {
        if (hello.jobId) throw new Error('host-single-job-only')
        if (!submission) throw new Error('host-invalid-spec')
        binding = {
          jobId: input.turnId,
          messageId: input.turnId,
          endpoint,
          cursor: 0,
          phase: 'starting',
          connection: 'connected',
        }
        input.onHostRun(binding)
        await connection.request('submit', submission)
      } else save({ connection: 'connected' })
      for (;;) {
        if (controller.signal.aborted) throw new Error('host-client-detached')
        input.assertAvailable()
        if (requestFailure) throw requestFailure
        const snapshot = await connection.request<Snapshot>('snapshot', { afterSeq: binding.cursor })
        input.assertAvailable()
        if (controller.signal.aborted) throw new Error('host-client-detached')
        if (!snapshot.job || snapshot.job.id !== binding.jobId) throw new Error('host-start-unconfirmed')
        const stopReason = parseStopReason(snapshot.job.stopReason)
        if (sessionId !== null && sessionId !== snapshot.sessionId) {
          cancelReviews()
          save({ phase: 'recovery-required' })
          throw new Error('host-recovery-required')
        }
        sessionId = snapshot.sessionId
        if (stopReason) save({ stopReason, stopRequested: true })
        if (snapshot.job.threadId) input.onThread(snapshot.job.threadId)
        for (const event of snapshot.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= binding.cursor) throw new Error('host-event-order')
          if (event.type === 'worker-report') {
            const { type, id, text } = event.payload
            if (
              !['response', 'status', 'reasoning'].includes(String(type)) ||
              typeof id !== 'string' ||
              typeof text !== 'string'
            )
              throw new Error('invalid-host-update')
            const update = {
              turnId: input.turnId,
              provider: 'codex',
              type,
              id,
              text,
              at: event.createdAt,
            } as AgentTurnUpdate
            input.onUpdate(update)
            if (type === 'response') response = text
            else {
              const step = { id, kind: type, text, at: event.createdAt } as AgentTurnStep
              const index = steps.findIndex((value) => value.id === id)
              if (index >= 0) steps[index] = step
              else steps.push(step)
              if (steps.length > 32) steps.shift()
            }
          }
          if (event.type === 'result-persisted') {
            const result = event.payload.result as { response?: unknown } | undefined
            if (typeof result?.response !== 'string') throw new Error('invalid-host-result')
            response = result.response
            input.onUpdate({
              turnId: input.turnId,
              provider: 'codex',
              type: 'response',
              id: 'host-result',
              text: response,
              at: event.createdAt,
            })
          }
          save({ cursor: event.seq })
        }
        const currentIds = new Set(snapshot.requests.map((request) => request.id))
        for (const [id, item] of pending)
          if (!currentIds.has(id)) {
            item.controller.abort()
            clearTimeout(item.timer)
            pending.delete(id)
          }
        const phase = snapshot.job.phase
        if (snapshot.events.length === 100) continue
        if (phase === 'completed') {
          if (typeof snapshot.result?.response !== 'string') throw new Error('invalid-host-result')
          response = snapshot.result.response
          input.onUpdate({
            turnId: input.turnId,
            provider: 'codex',
            type: 'response',
            id: 'host-result',
            text: response,
            at: Date.now(),
          })
          save({ phase: 'completed', connection: 'connected' })
          return {
            response,
            steps,
            durationMs: Date.now() - startedAt,
            threadId: snapshot.job.threadId ?? undefined,
            provider: 'codex' as const,
          }
        }
        if (phase === 'stopped') {
          save({ phase: 'stopped', connection: 'connected' })
          throw new Error('agent-cancelled')
        }
        if (phase === 'recovery-required') {
          save({ phase, connection: 'connected' })
          throw new Error('host-recovery-required')
        }
        save({
          phase: phase === 'waiting' ? 'waiting' : phase === 'running' ? 'running' : 'starting',
          connection: 'connected',
        })
        for (const request of snapshot.requests) handleRequest(request, snapshot.sessionId, snapshot.job)
        await delay(250, undefined, { signal: controller.signal })
      }
    } catch (error) {
      if (binding && !['completed', 'stopped'].includes(binding.phase)) save({ connection: 'disconnected' })
      if (controller.signal.aborted) throw new Error('host-client-detached')
      throw error
    } finally {
      cancelReviews()
      connection?.close()
      active.delete(input.turnId)
    }
  }

  async function stop(binding: ResidentHostRun, onStopReason?: (reason: AssistantHostStopReason) => void) {
    const connection = await connectResidentHost(binding.endpoint)
    try {
      const snapshot = await connection.request<Snapshot>('snapshot')
      if (snapshot.job?.id !== binding.jobId) throw new Error('host-stop-unconfirmed')
      const previousReason = parseStopReason(snapshot.job.stopReason)
      if (previousReason) onStopReason?.(previousReason)
      const result = await connection.request<{ phase: string; stopReason?: AssistantHostStopReason }>('stop')
      const stopReason = parseStopReason(result.stopReason) ?? previousReason
      if (!['completed', 'stopped'].includes(result.phase)) throw new Error('host-stop-unconfirmed')
      if (result.phase === 'completed') {
        const completed = await connection.request<Snapshot>('snapshot')
        if (
          completed.job?.id !== binding.jobId ||
          completed.job.phase !== 'completed' ||
          typeof completed.result?.response !== 'string'
        )
          throw new Error('host-result-unconfirmed')
        return { phase: 'completed' as const, response: completed.result.response }
      }
      return { phase: 'stopped' as const, ...(stopReason ? { stopReason } : {}) }
    } finally {
      connection.close()
    }
  }
  return { run, stop, detach: (turnId: string) => active.get(turnId)?.abort() }
}
