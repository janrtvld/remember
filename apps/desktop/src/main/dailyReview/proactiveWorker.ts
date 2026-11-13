import { randomUUID } from 'node:crypto'
import type { WorkItem } from '@remember/shared'
import type { AmbientTaskPlan } from './ambientTaskPolicy'
import {
  PROACTIVE_DAY_REVIEW_INTERVAL_MS,
  PROACTIVE_DAY_TASK_INTERVAL_MS,
  type ProactiveCommit,
  type ProactiveDecision,
  type ProactiveDecisionInput,
  type ProactiveFollowUp,
  type ProactiveSource,
  type ProactiveSourceKind,
  type ProactiveStore,
  proactiveSourceMaxAgeMs,
} from './proactiveStore'

export interface ProactiveConversation {
  generation: number
  available: boolean
  recentMessages: { id: string; role: 'user' | 'assistant'; text: string; createdAt: number }[]
  recentInitiatives: { decisionId: string; topicKey: string; createdAt: number }[]
  dismissedTopics: { topicKey: string; dismissedAt: number; expiresAt: number | null }[]
}

export interface ProactiveAnalysisResult {
  taskPlan: AmbientTaskPlan
  initiative: Pick<ProactiveDecisionInput, 'kind' | 'text' | 'topicKey' | 'sourceIds' | 'supportingQuotes' | 'taskIds'>
  followUps?: ProactiveFollowUp[]
}

type Options = {
  store: Pick<
    ProactiveStore,
    | 'configureConsumer'
    | 'generation'
    | 'invalidate'
    | 'batch'
    | 'resolve'
    | 'pendingDeliveries'
    | 'acknowledgeDelivery'
  >
  policy: () => string | null
  allowed: (kind: ProactiveSourceKind) => boolean
  accept: (source: ProactiveSource) => boolean
  withSourceValidation?: <T>(operation: () => T) => T
  items: () => WorkItem[]
  beforeBatch?: () => void
  attention?: () => Pick<ProactiveConversation, 'generation' | 'available'> | null
  conversation: () => ProactiveConversation | null
  analyze: (
    sources: ProactiveSource[],
    items: WorkItem[],
    conversation: ProactiveConversation,
    signal: AbortSignal
  ) => Promise<ProactiveAnalysisResult>
  apply: (commit: ProactiveCommit, plan: AmbientTaskPlan, startedAt: number) => void
  deliver: (decision: ProactiveDecision) => string | null
  delivered: (decision: ProactiveDecision) => string | null
  changed: () => void
  error: (error: unknown) => void
  now?: () => number
}

const ATTENTION_INTERVAL = 60_000
const TOPIC_INTERVAL = 10 * 60_000
const DECISION_LIFETIME = 120_000
const ANALYSIS_DEADLINE = 45_000

function interpretedWithin<T>(operation: () => Promise<T>, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const abort = () => finish(new Error('proactive-analysis-aborted'))
    const timer = setTimeout(() => {
      finish(new Error('proactive-analysis-timeout'))
      controller.abort()
    }, ANALYSIS_DEADLINE)
    controller.signal.addEventListener('abort', abort, { once: true })
    if (controller.signal.aborted) return abort()
    try {
      operation().then(
        (result) => finish(null, result),
        (error) => finish(error)
      )
    } catch (error) {
      finish(error)
    }
  })
}

export function createProactiveWorker(options: Options) {
  const now = options.now ?? Date.now
  const validateSources = options.withSourceValidation ?? ((operation) => operation())
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  let controller: AbortController | null = null
  let activeConversation: number | null = null
  let activePolicy: string | null | undefined
  let stopped = false
  let userInterrupted = false

  function synchronize() {
    const policy = options.policy()
    if (activePolicy !== undefined && policy !== activePolicy) {
      controller?.abort()
      options.store.invalidate(now())
    }
    activePolicy = policy
    options.store.configureConsumer(policy !== null, now())
    if (controller) {
      const attention = options.attention ? options.attention() : options.conversation()
      if (!attention?.available || attention.generation !== activeConversation) {
        userInterrupted = true
        controller.abort()
      }
    }
    return policy
  }

  function sourcesCurrent(sources: ProactiveSource[]) {
    return validateSources(() =>
      sources.every((source) => options.allowed(source.kind) && options.accept(source) && options.store.resolve(source))
    )
  }

  /** The inexpensive check, where the owner offers one, for whether the conversation can take anything right now. */
  function conversationCanReceive() {
    return !options.attention || options.attention()?.available === true
  }

  function canDeliver(decision: ProactiveDecision, policy: string) {
    if (!conversationCanReceive()) return false
    const conversation = options.conversation()
    if (
      !conversation?.available ||
      conversation.generation !== decision.conversationGeneration ||
      decision.policyToken !== policy ||
      options.policy() !== policy ||
      decision.expiresAt <= now()
    )
      return false
    if (
      conversation.dismissedTopics.some(
        (entry) => entry.topicKey === decision.topicKey && (entry.expiresAt === null || entry.expiresAt > now())
      )
    )
      return false
    if (
      conversation.recentInitiatives.some(
        (entry) =>
          now() - entry.createdAt <
            (decision.sourceRefs.every((source) => source.kind === 'day')
              ? PROACTIVE_DAY_REVIEW_INTERVAL_MS
              : ATTENTION_INTERVAL) ||
          (entry.topicKey === decision.topicKey &&
            now() - entry.createdAt <
              (decision.sourceRefs.every((source) => source.kind === 'day')
                ? PROACTIVE_DAY_TASK_INTERVAL_MS
                : TOPIC_INTERVAL))
      )
    )
      return false
    return true
  }

  function deliverPending(policy: string) {
    for (const decision of options.store.pendingDeliveries(
      now(),
      (decision) => Boolean(options.delivered(decision)) || canDeliver(decision, policy)
    )) {
      const existing = options.delivered(decision)
      if (existing) {
        options.store.acknowledgeDelivery(decision.id, decision.inputHash, existing, now())
        continue
      }
      if (!canDeliver(decision, policy)) continue
      const sources = decision.sourceRefs.map((reference) => options.store.resolve(reference))
      if (sources.some((source) => !source) || !sourcesCurrent(sources as ProactiveSource[])) continue
      if (
        sources.some(
          (source) =>
            source && (source.observedAt > now() || now() - source.observedAt > proactiveSourceMaxAgeMs(source))
        )
      )
        continue
      // Receiver admission and its message/receipt transaction are synchronous.
      const messageId = options.deliver(decision)
      if (messageId) {
        options.store.acknowledgeDelivery(decision.id, decision.inputHash, messageId, now())
        options.changed()
      }
    }
  }

  async function run(policy: string) {
    options.beforeBatch?.()
    deliverPending(policy)
    // Selecting a batch validates every candidate against its current sources. With nowhere to hand the batch, the
    // next tick would select and validate the same candidates again, once a second for as long as that lasts.
    if (!conversationCanReceive()) return
    const sources = validateSources(() => options.store.batch(now(), options.allowed, options.accept))
    if (!sources.length) return
    const conversation = options.conversation()
    if (!conversation?.available) return
    const items = options.items()
    const generation = options.store.generation()
    const startedAt = now()
    const localController = new AbortController()
    controller = localController
    activeConversation = conversation.generation
    userInterrupted = false
    let result: ProactiveAnalysisResult | null = null
    let reason: ProactiveDecisionInput['reason'] = 'interpreted'
    try {
      result = await interpretedWithin(
        () => options.analyze(sources, items, conversation, localController.signal),
        localController
      )
      const considered = result.taskPlan.consideredEvidenceIds
      if (!considered.length || considered.some((id) => !sources.some((source) => source.evidenceId === id))) {
        throw new Error('proactive-invalid-considered-sources')
      }
    } catch (error) {
      result = null
      reason = userInterrupted ? 'user-interaction' : 'analysis-error'
      if (!stopped && !userInterrupted && options.policy() === policy && options.store.generation() === generation)
        options.error(error)
    }
    const currentConversation = options.conversation()
    if (stopped || options.policy() !== policy || options.store.generation() !== generation || !sourcesCurrent(sources))
      return
    if (
      !currentConversation?.available ||
      currentConversation.generation !== conversation.generation ||
      userInterrupted
    ) {
      reason = 'user-interaction'
      result = null
    }
    if (reason === 'user-interaction' && sources.every((source) => source.kind === 'day')) return
    const currentItems = new Set(options.items().map((item) => item.id))
    if (items.some((item) => !currentItems.has(item.id))) return
    const completedAt = now()
    const initiative = result?.initiative ?? {
      kind: 'silent' as const,
      text: '',
      topicKey: `suppressed:${sources[0]!.contentKey}`,
      sourceIds: [],
      supportingQuotes: [],
      ...(sources.every((source) => source.kind === 'day') ? { taskIds: [] } : {}),
    }
    const commit: ProactiveCommit = {
      consumerGeneration: generation,
      sources: result
        ? sources.filter((source) => result.taskPlan.consideredEvidenceIds.includes(source.evidenceId))
        : sources,
      decision: {
        ...initiative,
        ...(sources.every((source) => source.kind === 'day') ? { followUps: result?.followUps ?? [] } : {}),
        reason,
        id: `initiative:${randomUUID()}`,
        createdAt: completedAt,
        expiresAt: completedAt + DECISION_LIFETIME,
        policyToken: policy,
        conversationGeneration: conversation.generation,
      },
    }
    options.apply(
      commit,
      result?.taskPlan ?? {
        proposed: [],
        changes: [],
        notifyTitles: [],
        consideredEvidenceIds: sources.map((source) => source.evidenceId),
      },
      startedAt
    )
    options.changed()
    deliverPending(policy)
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve()
    let policy: string | null
    try {
      policy = synchronize()
    } catch (error) {
      controller?.abort()
      options.error(error)
      return Promise.resolve()
    }
    if (running) return running
    if (!policy) return Promise.resolve()
    // A synchronous delivery can notify the owner before run reaches its first await.
    running = Promise.resolve()
    running = run(policy)
      .catch(options.error)
      .finally(() => {
        controller = null
        activeConversation = null
        running = null
      })
    return running
  }

  return {
    tick,
    start() {
      stopped = false
      timer ??= setInterval(() => void tick(), 1_000)
      timer.unref?.()
      void tick()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      controller?.abort()
      await running
    },
  }
}
