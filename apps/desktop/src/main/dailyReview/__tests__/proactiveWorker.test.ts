import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProactiveCommit, ProactiveDecision, ProactiveSource } from '../proactiveStore'
import { createProactiveWorker } from '../proactiveWorker'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  let now = 100_000
  let policy: string | null = 'allowed'
  let generation = 1
  let enabled = true
  let sourceCurrent = true
  let considered = false
  let modelCalls = 0
  let effectCalls = 0
  let applyCalls = 0
  let failure: unknown = null
  let failAck = false
  const decisions: ProactiveDecision[] = []
  const receipts = new Map<string, string>()
  const conversation = {
    generation: 1,
    available: true,
    recentMessages: [],
    dismissedTopics: [] as { topicKey: string; dismissedAt: number; expiresAt: number | null }[],
    recentInitiatives: [] as { decisionId: string; topicKey: string; createdAt: number }[],
  }
  const source: ProactiveSource = {
    eventId: 'event-1',
    sequence: 1,
    eventRevision: 'metadata-1',
    acceptedAt: 90_000,
    contentKey: 'content-1',
    kind: 'context',
    sourceId: 'screen-1',
    revision: 'text-1',
    workdayId: 'day-1',
    observedAt: 90_000,
    evidenceId: 'screen-1',
    text: 'Build failed: the configuration file is missing.',
    source: 'screen',
    appName: 'Terminal',
    bundleId: 'com.apple.Terminal',
    windowTitle: 'Build',
    url: '',
    provenance: { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'screen' },
  }
  const result = {
    taskPlan: { proposed: [], changes: [], notifyTitles: [], consideredEvidenceIds: [source.evidenceId] },
    initiative: {
      kind: 'observe' as const,
      text: 'The build needs its configuration file.',
      topicKey: 'build-config',
      sourceIds: [source.evidenceId],
      supportingQuotes: [{ sourceId: source.evidenceId, quote: source.text }],
    },
  }
  let analyze = async (_signal: AbortSignal) => result
  const options = {
    store: {
      configureConsumer(next: boolean) {
        if (next !== enabled) generation++
        enabled = next
        return generation
      },
      generation: () => generation,
      invalidate() {
        generation++
        for (const d of decisions) if (!d.deliveredMessageId) d.invalidatedAt = now
        return generation
      },
      batch: () => (!considered && sourceCurrent && enabled ? [source] : []),
      resolve: () => (sourceCurrent ? source : null),
      pendingDeliveries: () =>
        decisions.filter((d) => !d.deliveredMessageId && !d.invalidatedAt && d.kind !== 'silent' && d.expiresAt > now),
      acknowledgeDelivery(id: string, _hash: string, messageId: string) {
        if (failAck) {
          failAck = false
          throw new Error('ack-lost')
        }
        const decision = decisions.find((entry) => entry.id === id)!
        decision.deliveredMessageId = messageId
      },
    },
    policy: () => policy,
    allowed: () => true,
    accept: () => true,
    items: () => [],
    conversation: () => structuredClone(conversation),
    analyze: async (_sources: ProactiveSource[], _items: unknown[], _conversation: unknown, signal: AbortSignal) => {
      modelCalls++
      return analyze(signal)
    },
    apply: (commit: ProactiveCommit) => {
      applyCalls++
      assert.equal(commit.consumerGeneration, generation)
      assert(sourceCurrent)
      considered = true
      decisions.push({
        ...commit.decision,
        inputHash: `hash-${commit.decision.id}`,
        sourceRefs: [source],
        consumerGeneration: generation,
        deletionRevision: 0,
        deliveredMessageId: null,
        invalidatedAt: null,
      })
    },
    deliver: (decision: ProactiveDecision) => {
      effectCalls++
      assert.equal(decision.conversationGeneration, conversation.generation)
      const messageId = `message-${decision.id}`
      receipts.set(decision.id, messageId)
      conversation.recentInitiatives.push({ decisionId: decision.id, topicKey: decision.topicKey, createdAt: now })
      return messageId
    },
    delivered: (decision: ProactiveDecision) => receipts.get(decision.id) ?? null,
    changed: () => {},
    error: (error: unknown) => {
      failure = error
    },
    now: () => now,
  }
  return {
    options,
    source,
    result,
    decisions,
    conversation,
    get calls() {
      return { modelCalls, effectCalls, applyCalls }
    },
    get failure() {
      return failure
    },
    analyze(fn: typeof analyze) {
      analyze = fn
    },
    policy(value: string | null) {
      policy = value
    },
    deleteSource() {
      sourceCurrent = false
    },
    loseAck() {
      failAck = true
    },
    advance(ms: number) {
      now += ms
    },
  }
}

test('fresh source produces one initiative and never submits a chat turn', async () => {
  const f = fixture()
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  await worker.tick()
  assert.deepEqual(f.calls, { modelCalls: 1, effectCalls: 1, applyCalls: 1 })
  assert.equal(f.decisions[0]?.deliveredMessageId, `message-${f.decisions[0]?.id}`)
  await worker.stop()
})

test('source read scopes are fresh after model work and never span its await', async () => {
  const f = fixture()
  const pending = deferred<typeof f.result>()
  let activeScope = 0
  let scopes = 0
  const validationScopes: number[] = []
  f.analyze(async () => {
    assert.equal(activeScope, 0)
    return pending.promise
  })
  const worker = createProactiveWorker({
    ...f.options,
    withSourceValidation: <T>(operation: () => T): T => {
      assert.equal(activeScope, 0)
      activeScope = ++scopes
      try {
        return operation()
      } finally {
        activeScope = 0
      }
    },
    accept: () => {
      validationScopes.push(activeScope)
      return true
    },
    store: {
      ...f.options.store,
      batch: () => {
        assert(activeScope > 0)
        return f.options.store.batch()
      },
    },
  })
  const running = worker.tick()
  assert.equal(activeScope, 0)
  f.deleteSource()
  pending.resolve(f.result)
  await running
  assert.equal(f.calls.applyCalls, 0)
  assert(validationScopes.every((scope) => scope > 0))
  assert(scopes >= 2)
  await worker.stop()
})

test('idle ticks do not reread private chat history after the source is acknowledged', async () => {
  const f = fixture()
  let historyReads = 0
  const worker = createProactiveWorker({
    ...f.options,
    conversation: () => {
      historyReads++
      return f.options.conversation()
    },
  })
  await worker.tick()
  assert(historyReads > 0)
  historyReads = 0
  await worker.tick()
  await worker.tick()
  assert.equal(historyReads, 0)
  assert.equal(f.calls.modelCalls, 1)
  await worker.stop()
})

test('ticks neither select a batch nor read private history while the conversation cannot receive', async () => {
  const f = fixture()
  let accepted = 0
  let historyReads = 0
  const worker = createProactiveWorker({
    ...f.options,
    accept: () => {
      accepted++
      return true
    },
    attention: () => ({ generation: f.conversation.generation, available: false }),
    conversation: () => {
      historyReads++
      return f.options.conversation()
    },
  })
  await worker.tick()
  await worker.tick()
  assert.equal(accepted, 0)
  assert.equal(historyReads, 0)
  assert.equal(f.calls.modelCalls, 0)
  await worker.stop()
})

test('active interruption checks attention without repeatedly reading private history', async () => {
  const f = fixture()
  f.source.kind = 'day'
  const pending = deferred<typeof f.result>()
  f.analyze(() => pending.promise)
  let historyReads = 0
  let attentionReads = 0
  const worker = createProactiveWorker({
    ...f.options,
    attention: () => {
      attentionReads++
      return { generation: f.conversation.generation, available: f.conversation.available }
    },
    conversation: () => {
      historyReads++
      return f.options.conversation()
    },
  })
  const running = worker.tick()
  assert.equal(historyReads, 1)
  f.conversation.available = false
  const interrupted = worker.tick()
  // One read before the batch was selected, one for the interruption.
  assert.equal(attentionReads, 2)
  assert.equal(historyReads, 1)
  await Promise.all([running, interrupted])
  assert.equal(f.calls.applyCalls, 0)
  assert.equal(f.calls.effectCalls, 0)
  pending.resolve(f.result)
  await worker.stop()
})

test('Send while interpreting suppresses the old source, including later ticks', async () => {
  const f = fixture()
  const held = deferred<typeof f.result>()
  f.analyze(async () => held.promise)
  const worker = createProactiveWorker(f.options)
  const pending = worker.tick()
  f.conversation.generation++
  void worker.tick()
  held.resolve(f.result)
  await pending
  await worker.tick()
  assert.equal(f.calls.modelCalls, 1)
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.decisions[0]?.kind, 'silent')
  await worker.stop()
})

test('a Day interrupted by user work remains pending and is reconsidered with the new chat', async () => {
  const f = fixture()
  f.source.kind = 'day'
  const held = deferred<typeof f.result>()
  f.analyze(async () => held.promise)
  const worker = createProactiveWorker(f.options)
  const pending = worker.tick()
  f.conversation.generation++
  f.conversation.available = false
  void worker.tick()
  held.resolve(f.result)
  await pending
  assert.equal(f.decisions.length, 0)
  await worker.tick()
  assert.equal(f.calls.modelCalls, 1)
  f.conversation.available = true
  f.analyze(async () => f.result)
  await worker.tick()
  assert.equal(f.calls.modelCalls, 2)
  assert.equal(f.calls.effectCalls, 1)
  await worker.stop()
})

test('typing or review while interpreting suppresses the old answer', async () => {
  const f = fixture()
  const held = deferred<typeof f.result>()
  f.analyze(async () => held.promise)
  const worker = createProactiveWorker(f.options)
  const pending = worker.tick()
  f.conversation.available = false
  void worker.tick()
  held.resolve(f.result)
  await pending
  f.conversation.available = true
  await worker.tick()
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.calls.modelCalls, 1)
  await worker.stop()
})

test('policy revoke and regrant before model completion cannot restore its generation', async () => {
  const f = fixture()
  const held = deferred<typeof f.result>()
  f.analyze(async () => held.promise)
  const worker = createProactiveWorker(f.options)
  const pending = worker.tick()
  f.policy(null)
  void worker.tick()
  f.policy('allowed')
  void worker.tick()
  held.resolve(f.result)
  await pending
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.calls.applyCalls, 0)
  await worker.stop()
})

test('source deletion during analysis prevents the transaction and delivery', async () => {
  const f = fixture()
  const held = deferred<typeof f.result>()
  f.analyze(async () => held.promise)
  const worker = createProactiveWorker(f.options)
  const pending = worker.tick()
  f.deleteSource()
  held.resolve(f.result)
  await pending
  assert.equal(f.calls.applyCalls, 0)
  assert.equal(f.calls.effectCalls, 0)
  await worker.stop()
})

test('lost Evidence ACK reconciles the same Resident receipt after recreation without reanalysis or delivery', async () => {
  const f = fixture()
  f.loseAck()
  const first = createProactiveWorker(f.options)
  await first.tick()
  assert.match(String(f.failure), /ack-lost/)
  await first.stop()
  f.conversation.generation++
  const reopened = createProactiveWorker(f.options)
  await reopened.tick()
  assert.deepEqual(f.calls, { modelCalls: 1, effectCalls: 1, applyCalls: 1 })
  assert(f.decisions[0]?.deliveredMessageId)
  await reopened.stop()
})

test('analysis failure is durably withheld and is not automatically retried', async () => {
  const f = fixture()
  f.analyze(async () => {
    throw new Error('invalid-model-output')
  })
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  await worker.tick()
  assert.equal(f.calls.modelCalls, 1)
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.decisions[0]?.kind, 'silent')
  assert.match(String(f.failure), /invalid-model-output/)
  await worker.stop()
})

test('attention budget postpones a different topic until one minute without another model call', async () => {
  const f = fixture()
  f.conversation.recentInitiatives.push({ decisionId: 'prior', topicKey: 'other', createdAt: 99_000 })
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  assert.equal(f.calls.effectCalls, 0)
  f.advance(60_000)
  await worker.tick()
  assert.equal(f.calls.modelCalls, 1)
  assert.equal(f.calls.effectCalls, 1)
  await worker.stop()
})

test('recent dismissal prevents attention but retains the considered-source receipt', async () => {
  const f = fixture()
  f.conversation.dismissedTopics.push({ topicKey: 'build-config', dismissedAt: 99_000, expiresAt: 200_000 })
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.calls.applyCalls, 1)
  await worker.stop()
})

test('stop aborts a cooperative interpretation and never commits it', async () => {
  const f = fixture()
  f.analyze(
    async (signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  )
  const worker = createProactiveWorker(f.options)
  const pending = worker.tick()
  await worker.stop()
  await pending
  assert.equal(f.calls.applyCalls, 0)
  assert.equal(f.calls.effectCalls, 0)
})

test('a partially considered batch acknowledges only evaluated sources and leaves the rest pending', async () => {
  const f = fixture()
  const other: ProactiveSource = {
    ...f.source,
    eventId: 'event-2',
    evidenceId: 'screen-2',
    sourceId: 'screen-2',
    contentKey: 'content-2',
    eventRevision: 'metadata-2',
    text: 'A second independent source.',
  }
  let pending = [f.source, other]
  const committed: ProactiveSource[][] = []
  const originalApply = f.options.apply
  f.options.store.batch = () => pending
  f.options.apply = (commit) => {
    committed.push(commit.sources)
    pending = pending.filter((source) => !commit.sources.some((considered) => considered.eventId === source.eventId))
    originalApply(commit)
  }
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  assert.deepEqual(
    committed.map((sources) => sources.map((source) => source.eventId)),
    [['event-1']]
  )
  assert.deepEqual(
    pending.map((source) => source.eventId),
    ['event-2']
  )
  assert.equal(f.calls.modelCalls, 1)
  await worker.stop()
})

test('invalid considered IDs become one durable analysis error rather than a model retry loop', async () => {
  const f = fixture()
  f.result.taskPlan.consideredEvidenceIds = ['invented']
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  await worker.tick()
  assert.equal(f.calls.modelCalls, 1)
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.decisions[0]?.reason, 'analysis-error')
  assert.match(String(f.failure), /proactive-invalid-considered-sources/)
  await worker.stop()
})

test('deferred pending decisions use a fresh conversation snapshot for the shared delivery budget', async () => {
  const f = fixture()
  f.conversation.recentInitiatives.push({ decisionId: 'prior', topicKey: 'other', createdAt: 99_000 })
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  const first = f.decisions[0]
  assert(first)
  f.decisions.push({ ...first, id: 'second-decision', inputHash: 'second-hash', topicKey: 'second-topic' })
  f.advance(60_000)
  await worker.tick()
  assert.equal(f.calls.effectCalls, 1)
  assert.equal(f.decisions.filter((decision) => decision.deliveredMessageId).length, 1)
  await worker.stop()
})

test('budget-delayed delivery rechecks source age rather than extending freshness from analysis time', async () => {
  const f = fixture()
  f.conversation.recentInitiatives.push({ decisionId: 'prior', topicKey: 'other', createdAt: 99_000 })
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  assert.equal(f.calls.effectCalls, 0)
  f.advance(111_000)
  await worker.tick()
  assert.equal(f.calls.effectCalls, 0)
  assert.equal(f.calls.modelCalls, 1)
  await worker.stop()
})

test('Day reminder delivery respects the durable sparse budget without re-running the model', async () => {
  for (const sameTopic of [false, true]) {
    const f = fixture()
    f.source.kind = 'day'
    f.advance(4 * 60 * 60_000)
    f.source.observedAt = f.options.now() - 1_000
    f.conversation.recentInitiatives.push({
      decisionId: 'prior',
      topicKey: sameTopic ? f.result.initiative.topicKey : 'other',
      createdAt: f.options.now() - (sameTopic ? 4 * 60 * 60_000 : 2 * 60 * 60_000),
    })
    const worker = createProactiveWorker(f.options)
    await worker.tick()
    await worker.tick()
    assert.deepEqual(f.calls, { modelCalls: 1, effectCalls: 0, applyCalls: 1 })
    await worker.stop()
  }
})

test('failed Day interpretation commits complete silent metadata once for scheduling', async () => {
  const f = fixture()
  f.source.kind = 'day'
  f.analyze(async () => {
    throw new Error('provider-failure')
  })
  const worker = createProactiveWorker(f.options)
  await worker.tick()
  await worker.tick()
  assert.deepEqual(f.decisions[0]?.taskIds, [])
  assert.deepEqual(f.decisions[0]?.followUps, [])
  assert.equal(f.decisions[0]?.reason, 'analysis-error')
  assert.deepEqual(f.calls, { modelCalls: 1, applyCalls: 1, effectCalls: 0 })
  await worker.stop()
})
