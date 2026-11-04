import path from 'node:path'
import type { AgentProvider } from '@remember/shared'
import { discoverAgentActivitySources, readAgentActivitySource } from './agentActivitySources'
import type { AgentActivitySpan, AgentActivityStore } from './agentActivityStore'
import { contextSourceKey } from './contextImportChanges'
import type { AgentContextDocument } from './contextImportSources'

export type AgentActivityPolicy = {
  enabled: boolean
  enabledSince: number | null
  paused: boolean
  inferenceEnabled: boolean
  allowedProviders?: AgentProvider[]
}
export type AgentActivityTrackingStatus = ReturnType<AgentActivityStore['status']> & {
  state: 'disabled' | 'paused' | 'watching' | 'processing' | 'waiting' | 'error'
  lastCheckedAt: number | null
  error: string | null
}

type TrackingOptions = {
  store: AgentActivityStore
  homeDirectory: string
  codexDirectory?: string
  claudeDirectory?: string
  excludedDirectories?: string[]
  getPolicy: () => AgentActivityPolicy
  process: (
    documents: AgentContextDocument[]
  ) => Promise<{ processedSourceKeys: string[]; deferredSourceKeys: string[] }>
  changed?: (status: AgentActivityTrackingStatus) => void
  now?: () => number
  pollIntervalMs?: number
}

const PROVIDERS: AgentProvider[] = ['codex', 'claude']
const MAX_SOURCES_PER_TICK = 16
const RETENTION_CHECK_INTERVAL_MS = 60 * 60_000

export function createAgentActivityTracking(options: TrackingOptions) {
  const now = options.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null
  let pendingScan: Promise<void> | null = null
  let pendingInference: Promise<void> | null = null
  let stopped = false
  let processing = false
  let ingestionError: string | null = null
  let inferenceError: string | null = null
  let previousStatus = ''
  let lastRetentionCheckAt: number | null = null

  function status(): AgentActivityTrackingStatus {
    const policy = options.getPolicy()
    const stored = options.store.status()
    const error = ingestionError ?? inferenceError
    const lastCheckedAt = options.store.state('lastCheckedAt')
    return {
      ...stored,
      state: !policy.enabled
        ? 'disabled'
        : policy.paused
          ? 'paused'
          : processing
            ? 'processing'
            : error || stored.errors.length
              ? 'error'
              : !policy.inferenceEnabled && stored.pendingSpans
                ? 'waiting'
                : 'watching',
      lastCheckedAt: lastCheckedAt === null ? null : Number(lastCheckedAt),
      error: error ?? stored.errors[0]?.error ?? null,
    }
  }

  function notify() {
    const current = status()
    const serialized = JSON.stringify(current)
    if (serialized === previousStatus) return
    previousStatus = serialized
    options.changed?.(current)
  }

  async function scanSources() {
    const startedAt = now()
    const policy = options.getPolicy()
    const allowedProviders = policy.enabled && !policy.paused ? (policy.allowedProviders ?? PROVIDERS) : []
    options.store.capturePolicy(allowedProviders, startedAt)
    if (
      lastRetentionCheckAt === null ||
      startedAt < lastRetentionCheckAt ||
      startedAt - lastRetentionCheckAt >= RETENTION_CHECK_INTERVAL_MS
    ) {
      options.store.expire(startedAt)
      lastRetentionCheckAt = startedAt
    }
    if (!policy.enabled || policy.enabledSince === null || policy.paused || !allowedProviders.length) {
      notify()
      return
    }
    try {
      const sources = await discoverAgentActivitySources(options.homeDirectory, {
        codexDirectory: options.codexDirectory,
        claudeDirectory: options.claudeDirectory,
        after: policy.enabledSince,
      })
      const changedSources = sources
        .filter((source) => {
          if (!allowedProviders.includes(source.provider)) return false
          const previous = options.store.cursor(source.path)
          return (
            !previous ||
            previous.identity !== source.identity ||
            previous.modifiedAt !== source.modifiedAt ||
            previous.readThrough !== source.size
          )
        })
        .sort((left, right) => left.path.localeCompare(right.path))
      const lastSource = options.store.state('lastSource')
      const pivot = lastSource === null ? 0 : changedSources.findIndex((source) => source.path > lastSource)
      const ordered = pivot > 0 ? [...changedSources.slice(pivot), ...changedSources.slice(0, pivot)] : changedSources
      for (const source of ordered.slice(0, MAX_SOURCES_PER_TICK)) {
        if (stopped) break
        const current = options.getPolicy()
        if (
          !current.enabled ||
          current.paused ||
          current.enabledSince !== policy.enabledSince ||
          !(current.allowedProviders ?? PROVIDERS).includes(source.provider)
        )
          break
        try {
          const read = await readAgentActivitySource(source, options.store.cursor(source.path), {
            excludedDirectories: options.excludedDirectories,
          })
          // Consent may change while an asynchronous file read is in progress.
          const afterRead = options.getPolicy()
          if (
            !afterRead.enabled ||
            afterRead.paused ||
            afterRead.enabledSince !== policy.enabledSince ||
            !(afterRead.allowedProviders ?? PROVIDERS).includes(source.provider)
          )
            break
          options.store.recordRead(source, read, policy.enabledSince, now())
        } catch (failure) {
          options.store.sourceError(source, errorText(failure), now())
        }
        options.store.setState('lastSource', source.path)
      }
      options.store.setState('lastCheckedAt', String(now()))
      ingestionError = null
      notify()
    } catch (failure) {
      ingestionError = errorText(failure)
      notify()
    }
  }

  async function processBatch(batch: AgentActivitySpan[], enabledSince: number) {
    processing = true
    notify()
    try {
      const documents = agentActivityDocuments(batch).map((document) => {
        const beforeEventId = document.messages?.[0]?.eventId
        if (!beforeEventId) return document
        const contextMessages = options.store
          .conversationContext({
            provider: document.provider,
            sessionId: document.sourceId,
            beforeEventId,
            enabledSince,
          })
          .map((event) => ({
            content: event.text,
            observedAt: event.observedAt,
            role: event.role,
            eventId: event.id,
          }))
        return { ...document, contextMessages }
      })
      const result = await options.process(documents)
      if (stopped) return
      const processed = new Set(result.processedSourceKeys)
      const processedIds = batch.filter((span) => processed.has(spanSourceKey(span))).map((span) => span.spanId)
      const deferredIds = batch.filter((span) => !processed.has(spanSourceKey(span))).map((span) => span.spanId)
      options.store.acknowledge(processedIds, now())
      options.store.defer(deferredIds, 'analysis-deferred', now())
      inferenceError = null
    } catch (failure) {
      inferenceError = errorText(failure)
      options.store.defer(
        batch.map((span) => span.spanId),
        inferenceError,
        now()
      )
    } finally {
      processing = false
      notify()
    }
  }

  function tick() {
    if (stopped) return Promise.resolve()
    if (!pendingScan) {
      pendingScan = scanSources().finally(() => {
        pendingScan = null
      })
    }
    return pendingScan.then(() => {
      const policy = options.getPolicy()
      if (
        pendingInference ||
        stopped ||
        !policy.enabled ||
        policy.enabledSince === null ||
        policy.paused ||
        !policy.inferenceEnabled
      )
        return
      const batch = options.store.pendingBatch({ now: now(), allowedProviders: policy.allowedProviders ?? PROVIDERS })
      if (!batch.length) return
      pendingInference = processBatch(batch, policy.enabledSince).finally(() => {
        pendingInference = null
      })
      return pendingInference
    })
  }

  function policyChanged() {
    const policy = options.getPolicy()
    options.store.capturePolicy(policy.enabled && !policy.paused ? (policy.allowedProviders ?? PROVIDERS) : [], now())
    notify()
    return tick()
  }

  function start() {
    if (timer) return
    stopped = false
    void tick()
    timer = setInterval(() => void tick(), options.pollIntervalMs ?? 15_000)
    timer.unref?.()
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    await Promise.all([pendingScan, pendingInference])
  }

  return { start, tick, stop, status, policyChanged }
}

export function agentActivityPolicyToken(policy: AgentActivityPolicy) {
  return JSON.stringify({
    enabled: policy.enabled,
    enabledSince: policy.enabledSince,
    paused: policy.paused,
    inferenceEnabled: policy.inferenceEnabled,
    allowedProviders: [...(policy.allowedProviders ?? ['codex', 'claude'])].sort(),
  })
}

export function agentActivityDocuments(spans: AgentActivitySpan[]): AgentContextDocument[] {
  const groups = new Map<string, AgentActivitySpan[]>()
  for (const span of spans) {
    const key = spanSourceKey(span)
    groups.set(key, [...(groups.get(key) ?? []), span])
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0]
    if (!first) return []
    const messages = [...group]
      .sort(
        (left, right) =>
          left.observedAt - right.observedAt ||
          left.sourceOffset - right.sourceOffset ||
          left.partIndex - right.partIndex
      )
      .map((span) => ({
        role: span.role,
        content: span.content,
        observedAt: span.observedAt,
        eventId: span.id,
        partIndex: span.partIndex,
        partCount: span.partCount,
      }))
    return {
      provider: first.provider,
      kind: 'session' as const,
      sourceId: first.sessionId,
      project: first.projectPath ? path.basename(first.projectPath) : 'Unknown project',
      workingDirectory: first.projectPath,
      updatedAt: Math.max(...group.map((span) => span.observedAt)),
      content: messages
        .map(
          (message) =>
            `[${message.role === 'user' ? 'User' : 'Agent'}]${message.partCount > 1 ? ` (part ${message.partIndex + 1}/${message.partCount} of the original message)` : ''}\n${message.content}`
        )
        .join('\n\n'),
      messages,
    }
  })
}

function spanSourceKey(span: AgentActivitySpan) {
  return contextSourceKey({
    provider: span.provider,
    kind: 'session',
    sourceId: span.sessionId,
    project: '',
    updatedAt: span.observedAt,
    content: '',
  })
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
