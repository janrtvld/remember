import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createAgentInteractions } from '../agentInteractions'
import type { ProactiveDecision } from '../dailyReview/proactiveStore'
import { createResidentAgentService } from '../residentAgentService'
import { ResidentAgentStore } from '../residentAgentStore'
import {
  deliverProactiveInitiative,
  getDeliveredProactiveInitiative,
  getProactiveConversationState,
  registerProactiveConversation,
  subscribeProactiveConversationChanges,
} from '../residentProactive'

const NOW = 1_800_000_000_000
const result = { provider: 'codex' as const, response: 'Ready', durationMs: 20, steps: [] }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'remember-proactive-chat-'))
  const file = join(directory, 'conversation.sqlite')
  let time = NOW
  const store = new ResidentAgentStore(file, { now: () => time })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    file,
    store,
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
  }
}

function decision(overrides: Partial<ProactiveDecision> = {}): ProactiveDecision {
  return {
    id: 'initiative-one',
    kind: 'offer',
    text: 'Ik zie een fout in de build. Zal ik de oorzaak bekijken?',
    topicKey: 'build-error',
    sourceIds: ['context-one'],
    supportingQuotes: [{ sourceId: 'context-one', quote: 'Build failed: missing import.' }],
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    policyToken: 'policy-one',
    conversationGeneration: 0,
    inputHash: 'a'.repeat(64),
    consumerGeneration: 1,
    deletionRevision: 0,
    deliveredMessageId: null,
    invalidatedAt: null,
    sourceRefs: [
      {
        eventId: 'event-one',
        kind: 'context',
        sourceId: 'context-one',
        evidenceId: 'context-one',
        workdayId: 'day-one',
        eventRevision: 'b'.repeat(64),
        revision: 'c'.repeat(64),
        contentKey: 'd'.repeat(64),
        observedAt: NOW - 100,
        appName: 'Terminal',
        windowTitle: 'Atlas build',
        url: '',
      },
    ],
    ...overrides,
  }
}

function serviceFixture(t: { after(fn: () => void | Promise<void>): void }) {
  const state = fixture(t)
  let permitted = true
  let review = false
  let changes = 0
  const service = createResidentAgentService({
    store: state.store,
    context: () => '{}',
    assertAvailable: () => {
      if (!permitted) throw new Error('offline')
    },
    changed: () => {},
    proactive: {
      now: state.now,
      canPublish: () => !review,
      messagePermitted: () => permitted,
      changed: () => {
        changes++
      },
    },
    driver: { run: async () => result, cancel: () => {} },
  })
  t.after(() => service.dispose())
  return {
    ...state,
    service,
    changes: () => changes,
    permit: (value: boolean) => {
      permitted = value
    },
    review: (value: boolean) => {
      review = value
    },
  }
}

test('source-backed initiative commits message and immutable receipt with no user message or tool turn', (t) => {
  const { store } = fixture(t)
  const id = store.appendProactiveInitiative(decision())
  assert(id)
  const chat = store.conversation(null)
  assert.equal(chat.activeTurnId, null)
  assert.equal(chat.messages.length, 1)
  assert.equal(chat.messages[0]?.role, 'assistant')
  assert.equal(chat.messages[0]?.replyTo, null)
  assert.equal(chat.messages[0]?.createdAt, NOW)
  assert.deepEqual(chat.messages[0]?.steps, [])
  assert.deepEqual(chat.messages[0]?.initiative?.sources, [
    {
      id: 'context-one',
      kind: 'context',
      quote: 'Build failed: missing import.',
      observedAt: NOW - 100,
      appName: 'Terminal',
      windowTitle: 'Atlas build',
    },
  ])
  assert.equal(store.deliveredProactiveInitiative('initiative-one', 'a'.repeat(64)), id)
  assert.throws(() => store.update(id, { text: 'changed', steps: [], status: 'completed' }), /initiative-immutable/)
  store.close()
})

test('lost delivery ACK and reopened store redeliver only the exact original receipt', (t) => {
  const { file, store } = fixture(t)
  const original = decision()
  const id = store.appendProactiveInitiative(original)
  const before = store.conversation(null)
  store.close()
  const reopened = new ResidentAgentStore(file, { now: () => NOW + 120_000 })
  assert.equal(reopened.appendProactiveInitiative({ ...original, deliveredMessageId: id, invalidatedAt: NOW + 10 }), id)
  assert.deepEqual(reopened.conversation(null), before)
  assert.throws(() => reopened.appendProactiveInitiative({ ...original, text: 'Changed text' }), /initiative-conflict/)
  assert.throws(
    () =>
      reopened.appendProactiveInitiative({
        ...original,
        supportingQuotes: [{ sourceId: 'context-one', quote: 'Changed quote' }],
      }),
    /initiative-conflict/
  )
  assert.throws(() => reopened.deliveredProactiveInitiative(original.id, 'b'.repeat(64)), /initiative-conflict/)
  reopened.close()
})

test('expired, future, invalidated and stale-conversation decisions cannot create a message', (t) => {
  const { store } = fixture(t)
  assert.equal(store.appendProactiveInitiative(decision({ createdAt: NOW - 100, expiresAt: NOW })), null)
  assert.equal(store.appendProactiveInitiative(decision({ createdAt: NOW + 1 })), null)
  assert.equal(store.appendProactiveInitiative(decision({ invalidatedAt: NOW })), null)
  assert.equal(store.appendProactiveInitiative(decision({ conversationGeneration: 1 })), null)
  assert.deepEqual(store.conversation(null).messages, [])
  store.close()
})

test('silent and unbound source payloads reject before any chat row is written', (t) => {
  const { store } = fixture(t)
  assert.throws(() => store.appendProactiveInitiative(decision({ kind: 'silent' })), /invalid-proactive-initiative/)
  assert.throws(
    () => store.appendProactiveInitiative(decision({ supportingQuotes: [] })),
    /invalid-proactive-initiative/
  )
  assert.throws(
    () => store.appendProactiveInitiative(decision({ sourceIds: ['other'] })),
    /invalid-proactive-initiative/
  )
  assert.throws(() => store.appendProactiveInitiative(decision({ inputHash: '' })), /invalid-proactive-initiative/)
  assert.deepEqual(store.conversation(null).messages, [])
  store.close()
})

for (const table of ['assistant_proactive_initiative', 'assistant_message']) {
  test(`zero-row ${table} insertion rolls back both receipt and message`, (t) => {
    const { file, store } = fixture(t)
    const probe = new DatabaseSync(file)
    probe.exec(`CREATE TRIGGER ignore_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END;`)
    assert.throws(() => store.appendProactiveInitiative(decision()), /proactive-write-not-persisted/)
    assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM assistant_message').get()?.n, 0)
    assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM assistant_proactive_initiative').get()?.n, 0)
    probe.close()
    store.close()
  })
}

test('explicit Send persists generation and signals busy before awaiting context; late initiative cannot publish', async (t) => {
  const { file, store } = fixture(t)
  let resolveContext: ((value: string) => void) | undefined
  const held = new Promise<string>((resolve) => {
    resolveContext = resolve
  })
  const observations: { generation: number; available: boolean }[] = []
  const service = createResidentAgentService({
    store,
    context: () => {
      assert.equal(store.proactiveConversationGeneration(), 1)
      return held
    },
    assertAvailable: () => {},
    changed: () => {},
    proactive: {
      now: () => NOW,
      canPublish: () => true,
      changed: () => {
        const state = service.proactiveState()
        observations.push({ generation: state.generation, available: state.available })
      },
    },
    driver: { run: async () => result, cancel: () => {} },
  })
  service.send({ text: 'Mijn eigen vraag', provider: 'codex' })
  assert.deepEqual(observations[0], { generation: 1, available: false })
  assert.equal(service.deliverProactiveInitiative(decision()), null)
  resolveContext?.('{}')
  await tick()
  assert.equal(service.proactiveState().available, true)
  assert.equal(service.deliverProactiveInitiative(decision()), null)
  assert.equal(service.snapshot().messages.length, 2)
  await service.dispose()
  const reopened = new ResidentAgentStore(file)
  assert.equal(reopened.proactiveConversationGeneration(), 1)
  reopened.close()
})

test('failed generation write cannot persist a user turn or start its provider', (t) => {
  const { file, store } = fixture(t)
  const probe = new DatabaseSync(file)
  probe.exec(
    "CREATE TRIGGER ignore_generation BEFORE INSERT ON assistant_state WHEN NEW.key = 'proactive-generation' BEGIN SELECT RAISE(IGNORE); END;"
  )
  assert.throws(() => store.start('Question', 'codex', undefined, true), /proactive-write-not-persisted/)
  assert.equal(store.proactiveConversationGeneration(), 0)
  assert.deepEqual(store.conversation(null).messages, [])
  probe.close()
  store.close()
})

test('typing leases defer delivery, renew by owner, expire, and do not change the conversation generation', async (t) => {
  const f = serviceFixture(t)
  f.service.setComposing(1, true)
  assert.equal(f.service.proactiveState().available, false)
  assert.equal(f.service.deliverProactiveInitiative(decision()), null)
  f.advance(10_000)
  f.service.setComposing(1, true)
  f.service.setComposing(2, true)
  f.service.setComposing(1, false)
  assert.equal(f.service.proactiveState().available, false)
  f.advance(15_001)
  assert.equal(f.service.proactiveState().available, true)
  assert.equal(f.service.proactiveState().generation, 0)
  assert(f.service.deliverProactiveInitiative(decision()))
  assert.throws(() => f.service.setComposing(1, 'yes'), /invalid-assistant-composing/)
})

test('permission and review guards block new publication but exact prior receipt stays readable', (t) => {
  const f = serviceFixture(t)
  f.review(true)
  assert.equal(f.service.deliverProactiveInitiative(decision()), null)
  f.review(false)
  f.permit(false)
  assert.equal(f.service.deliverProactiveInitiative(decision()), null)
  f.permit(true)
  const id = f.service.deliverProactiveInitiative(decision())
  assert(id)
  f.review(true)
  f.permit(false)
  assert.equal(f.service.deliverProactiveInitiative(decision()), id)
  assert.equal(f.service.deliveredProactiveInitiative('initiative-one', 'a'.repeat(64)), id)
  assert.equal(f.service.snapshot().messages.length, 1)
})

test('dismissal binds the exact message, lasts thirty minutes, and survives restart without removing evidence', async (t) => {
  const { file, store, advance, now } = fixture(t)
  const id = store.appendProactiveInitiative(decision())
  assert(id)
  assert.throws(() => store.dismissProactiveInitiative('unknown'), /initiative-not-found/)
  store.dismissProactiveInitiative(id)
  assert.equal(store.proactiveConversationGeneration(), 1)
  store.dismissProactiveInitiative(id)
  assert.equal(store.proactiveConversationGeneration(), 1)
  assert.equal(store.get(id)?.initiative?.dismissed, true)
  assert.equal(store.get(id)?.initiative?.sources.length, 1)
  store.close()
  const reopened = new ResidentAgentStore(file, { now })
  assert.deepEqual(reopened.proactiveConversationContext().dismissedTopics, [
    { topicKey: 'build-error', dismissedAt: NOW, expiresAt: NOW + 30 * 60_000 },
  ])
  assert.equal(reopened.appendProactiveInitiative(decision({ id: 'second', conversationGeneration: 1 })), null)
  advance(30 * 60_000)
  assert.deepEqual(reopened.proactiveConversationContext().dismissedTopics, [])
  assert.equal(reopened.get(id)?.initiative?.dismissed, false)
  reopened.close()
})

test('receiver bus reports unavailable with no owner and releases exactly its registered owner', (t) => {
  const f = serviceFixture(t)
  assert.equal(getProactiveConversationState().available, false)
  assert.equal(deliverProactiveInitiative(decision()), null)
  let changes = 0
  const unsubscribe = subscribeProactiveConversationChanges(() => {
    changes++
  })
  const unregister = registerProactiveConversation({
    state: f.service.proactiveState,
    deliver: f.service.deliverProactiveInitiative,
    delivered: f.service.deliveredProactiveInitiative,
  })
  assert.equal(getProactiveConversationState().available, true)
  const id = deliverProactiveInitiative(decision())
  assert(id)
  assert.equal(getDeliveredProactiveInitiative('initiative-one', 'a'.repeat(64)), id)
  assert.deepEqual(getProactiveConversationState().recentInitiatives, [
    { decisionId: 'initiative-one', topicKey: 'build-error', createdAt: NOW },
  ])
  unregister()
  assert.equal(getProactiveConversationState().available, false)
  assert.equal(changes, 2)
  unsubscribe()
})

test('pending interaction subscriptions fire for creation and resolution without changing existing notification callback', async () => {
  let changes = 0
  let observed = 0
  const interactions = createAgentInteractions(() => {
    changes++
  })
  const stop = interactions.subscribe(() => {
    observed++
  })
  const controller = new AbortController()
  const answer = interactions.ask(
    {
      turnId: 'review',
      title: 'Review',
      detail: '',
      fields: [],
      actions: [{ id: 'accept', label: 'Accept' }],
    },
    controller.signal
  )
  const id = interactions.list()[0]?.id
  assert(id)
  interactions.answer({ id, action: 'accept', values: {} })
  await answer
  assert.equal(changes, 2)
  assert.equal(observed, 2)
  stop()
})

test('delayed delivery pins the actual attention time once, including duplicate after restart', (t) => {
  const { file, store, advance, now } = fixture(t)
  const pending = decision({ expiresAt: NOW + 5 * 60_000 })
  advance(90_000)
  const id = store.appendProactiveInitiative(pending)
  assert(id)
  assert.equal(store.get(id)?.createdAt, NOW + 90_000)
  assert.equal(store.get(id)?.updatedAt, NOW + 90_000)
  assert.equal(store.proactiveConversationContext().recentInitiatives[0]?.createdAt, NOW + 90_000)
  store.close()
  advance(90_000)
  const reopened = new ResidentAgentStore(file, { now })
  assert.equal(reopened.appendProactiveInitiative(pending), id)
  assert.equal(reopened.get(id)?.createdAt, NOW + 90_000)
  reopened.close()
})

test('current source permission filters rendered initiative, proactive context and ordinary Send history while keeping the receipt', async (t) => {
  const { store } = fixture(t)
  let sourcePermitted = true
  let sourceChecks = 0
  let prompt = ''
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    proactive: {
      now: () => NOW,
      canPublish: () => true,
      messagePermitted: () => {
        sourceChecks++
        return sourcePermitted
      },
      changed: () => {},
    },
    driver: {
      run: async (input) => {
        prompt = input.prompt
        return result
      },
      cancel: () => {},
    },
  })
  const item = decision({ text: 'PRIVATE_SOURCE_NONCE: check this error.' })
  const id = service.deliverProactiveInitiative(item)
  assert(id)
  assert.match(service.snapshot().messages[0]?.text ?? '', /PRIVATE_SOURCE_NONCE/)
  assert.equal(service.proactiveState().recentMessages.length, 1)
  sourcePermitted = false
  sourceChecks = 0
  assert.deepEqual(service.proactiveAttention(), { generation: 0, available: true })
  assert.equal(sourceChecks, 0)
  const hidden = service.snapshot().messages[0]
  assert(sourceChecks > 0)
  assert.equal(hidden?.text, '')
  assert.equal(hidden?.initiative, undefined)
  assert.equal(hidden?.error, 'assistant-proactive-source-unavailable')
  assert.equal(service.proactiveState().recentMessages.length, 0)
  service.send({ text: 'Beantwoord alleen deze nieuwe vraag.', provider: 'codex' })
  await tick()
  assert.doesNotMatch(prompt, /PRIVATE_SOURCE_NONCE|Build failed/)
  assert.match(prompt, /Beantwoord alleen deze nieuwe vraag/)
  assert.equal(service.deliveredProactiveInitiative(item.id, item.inputHash), id)
  assert.match(
    store.get(id)?.text ?? '',
    /PRIVATE_SOURCE_NONCE/,
    'Logical withholding preserves immutable receipt; this is not erasure'
  )
  await service.dispose()
})

test('source loss during explicit context preparation withholds previously snapshotted initiative text', async (t) => {
  const { store } = fixture(t)
  let sourcePermitted = true
  let resolveContext: ((value: string) => void) | undefined
  let prompt = ''
  const held = new Promise<string>((resolve) => {
    resolveContext = resolve
  })
  const service = createResidentAgentService({
    store,
    context: () => held,
    assertAvailable: () => {},
    changed: () => {},
    proactive: { now: () => NOW, canPublish: () => true, messagePermitted: () => sourcePermitted, changed: () => {} },
    driver: {
      run: async (input) => {
        prompt = input.prompt
        return result
      },
      cancel: () => {},
    },
  })
  assert(service.deliverProactiveInitiative(decision({ text: 'PRIVATE_DURING_CONTEXT_NONCE' })))
  service.send({ text: 'Een nieuwe vraag', provider: 'codex' })
  sourcePermitted = false
  resolveContext?.('{}')
  await tick()
  assert.doesNotMatch(prompt, /PRIVATE_DURING_CONTEXT_NONCE/)
  assert.match(prompt, /Een nieuwe vraag/)
  await service.dispose()
})

test('context policy changes latch conversation ownership before awaits, including revoke then regrant', async (t) => {
  const f = fixture(t)
  const service = createResidentAgentService({
    store: f.store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    proactive: { now: f.now, canPublish: () => true, changed: () => {} },
    driver: { run: async () => result, cancel: () => {} },
  })
  await service.setContextPolicy('account-one')
  const pending = decision({ conversationGeneration: service.proactiveState().generation })
  const revoked = service.setContextPolicy('account-two')
  assert.equal(service.proactiveState().generation, pending.conversationGeneration + 1)
  assert.equal(service.deliverProactiveInitiative(pending), null)
  await revoked
  await service.setContextPolicy('account-one')
  assert.equal(service.proactiveState().generation, pending.conversationGeneration + 2)
  assert.equal(service.proactiveState().available, true)
  assert.equal(service.deliverProactiveInitiative(pending), null)
  assert.deepEqual(service.snapshot().messages, [])
  await service.dispose()
  const reopened = new ResidentAgentStore(f.file)
  assert.equal(reopened.proactiveConversationGeneration(), pending.conversationGeneration + 2)
  reopened.close()
})

test('context reset rolls back its history cutoff and ownership latch together on a zero-row generation write', (t) => {
  const { file, store } = fixture(t)
  store.appendProactiveInitiative(decision())
  const before = store.history()
  const probe = new DatabaseSync(file)
  probe.exec(
    "CREATE TRIGGER ignore_generation BEFORE INSERT ON assistant_state WHEN NEW.key = 'proactive-generation' BEGIN SELECT RAISE(IGNORE); END;"
  )
  assert.throws(() => store.resetContext(), /proactive-write-not-persisted/)
  assert.deepEqual(store.history(), before)
  assert.equal(store.proactiveConversationGeneration(), 0)
  probe.close()
  store.close()
})

test('Day reminders retain a three-hour budget and daily task dismissal across restart', (t) => {
  const f = fixture(t)
  const dayDecision = (id: string, topicKey: string) => {
    const base = decision({ id, topicKey, createdAt: f.now(), expiresAt: f.now() + 60_000 })
    base.sourceIds = ['day:state']
    base.supportingQuotes = [{ sourceId: 'day:state', quote: 'A genuine recorded commitment.' }]
    const source = base.sourceRefs[0]
    assert(source)
    base.sourceRefs = [{ ...source, kind: 'day', sourceId: 'state', evidenceId: 'day:state' }]
    return base
  }
  const first = f.store.appendProactiveInitiative(dayDecision('first', 'task:one'))
  assert(first)
  f.advance(2 * 60 * 60_000)
  assert.equal(f.store.appendProactiveInitiative(dayDecision('too-soon', 'task:two')), null)
  f.store.close()
  const reopened = new ResidentAgentStore(f.file, { now: f.now })
  f.advance(60 * 60_000)
  assert.equal(reopened.appendProactiveInitiative(dayDecision('repeat-task', 'task:one')), null)
  assert(reopened.appendProactiveInitiative(dayDecision('new-task', 'task:two')))
  reopened.dismissProactiveInitiative(first)
  assert.deepEqual(reopened.proactiveConversationContext().dismissedTopics, [
    { topicKey: 'task:one', dismissedAt: f.now(), expiresAt: f.now() + 86_400_000 },
  ])
  reopened.close()
})

test('ordinary refusal of the latest contextual offer persists an atomic local reply and daily dismissal', async (t) => {
  const f = fixture(t)
  const base = decision({ topicKey: 'context:filmavond-keuze', taskIds: [], followUps: [] })
  base.sourceIds = ['day:state']
  base.supportingQuotes = [{ sourceId: 'day:state', quote: 'Drie films voor een avond met vrienden.' }]
  base.sourceRefs = base.sourceRefs.map((source) => ({
    ...source,
    kind: 'day',
    sourceId: 'state',
    evidenceId: 'day:state',
  }))
  const id = f.store.appendProactiveInitiative(base)
  assert(id)
  let runs = 0
  const service = createResidentAgentService({
    store: f.store,
    context: () => '{}',
    assertAvailable() {},
    changed() {},
    proactive: { now: f.now, canPublish: () => true, messagePermitted: () => true, changed() {} },
    driver: {
      run: async () => {
        runs++
        return result
      },
      cancel() {},
    },
  })
  const generation = f.store.proactiveConversationGeneration()
  service.send({ text: 'Nu even niet.', provider: 'codex' })
  assert.equal(runs, 0)
  assert.equal(f.store.proactiveConversationGeneration(), generation + 1)
  const before = service.snapshot().messages
  assert.equal(before.at(-2)?.text, 'Nu even niet.')
  assert.equal(before.at(-1)?.text, 'Goed, ik laat het voor nu rusten.')
  assert.equal(before.at(-1)?.replyTo, before.at(-2)?.id)
  assert.equal(before[0]?.initiative?.dismissed, true)
  await service.dispose()
  const reopened = new ResidentAgentStore(f.file, { now: f.now })
  assert.deepEqual(reopened.conversation(null).messages, before)
  assert.deepEqual(reopened.proactiveConversationContext().dismissedTopics, [
    {
      topicKey: base.topicKey,
      dismissedAt: NOW,
      expiresAt: NOW + 86_400_000,
    },
  ])
  f.advance(4 * 60 * 60_000)
  assert.equal(
    reopened.appendProactiveInitiative({
      ...base,
      id: 'repeat',
      conversationGeneration: generation + 1,
      createdAt: f.now(),
      expiresAt: f.now() + 60_000,
    }),
    null
  )
  reopened.close()
})

test('thanks, ambiguous refusals, dated reminders and affirmative replies retain the normal provider turn', async (t) => {
  for (const text of [
    'Bedankt',
    'Ja graag',
    'Nee',
    'Niet nu even niet',
    'Nee, maar maak wel een opzet',
    'Nu even niet, herinner me morgen',
    'Not now; remind me Friday',
  ]) {
    const f = fixture(t)
    assert(f.store.appendProactiveInitiative(decision()))
    let instruction = ''
    const service = createResidentAgentService({
      store: f.store,
      context: () => '{}',
      assertAvailable() {},
      changed() {},
      proactive: { now: f.now, canPublish: () => true, messagePermitted: () => true, changed() {} },
      driver: {
        run: async (input) => {
          instruction = input.instruction
          return result
        },
        cancel() {},
      },
    })
    service.send({ text, provider: 'codex' })
    await tick()
    assert.equal(instruction, text)
    assert.deepEqual(f.store.proactiveConversationContext().dismissedTopics, [])
    await service.dispose()
  }
})

test('a refusal after intervening ordinary chat cannot dismiss an earlier offer', async (t) => {
  const f = serviceFixture(t)
  const id = f.service.deliverProactiveInitiative(decision())
  assert(id)
  f.service.send({ text: 'Wat bedoel je precies?', provider: 'codex' })
  await tick()
  f.service.send({ text: 'Nu even niet', provider: 'codex' })
  await tick()
  assert.deepEqual(f.store.proactiveConversationContext().dismissedTopics, [])
  assert.equal(f.store.get(id)?.initiative?.dismissed, false)
})

test('failed dismissal storage rolls back both conversational rows and suppression', (t) => {
  const f = fixture(t)
  const id = f.store.appendProactiveInitiative(decision())
  assert(id)
  const probe = new DatabaseSync(f.file)
  probe.exec(
    "CREATE TRIGGER reject_dismissal BEFORE INSERT ON assistant_proactive_dismissal BEGIN SELECT RAISE(ABORT, 'synthetic-failure'); END"
  )
  assert.throws(
    () => f.store.dismissProactiveInitiative(id, { text: 'Nu even niet', provider: 'codex', acknowledgement: 'Goed.' }),
    /synthetic-failure/
  )
  assert.equal(f.store.conversation(null).messages.length, 1)
  assert.equal(f.store.proactiveConversationGeneration(), 0)
  assert.deepEqual(f.store.proactiveConversationContext().dismissedTopics, [])
  probe.close()
  f.store.close()
})

test('conversation rendering groups source checks in one fresh synchronous scope', (t) => {
  const { store } = fixture(t)
  assert(store.appendProactiveInitiative(decision()))
  assert(store.appendProactiveInitiative(decision({ id: 'initiative-two', text: 'Second retained offer.' })))
  let active = false
  let permitted = true
  let scopes = 0
  let checks = 0
  const service = createResidentAgentService({
    store,
    context: () => '{}',
    assertAvailable: () => {},
    changed: () => {},
    withSourceValidation: (operation) => {
      assert.equal(active, false)
      active = true
      scopes++
      try {
        return operation()
      } finally {
        active = false
      }
    },
    proactive: {
      now: () => NOW,
      canPublish: () => true,
      changed: () => {},
      messagePermitted: () => {
        assert.equal(active, true)
        checks++
        return permitted
      },
    },
    driver: { run: async () => result, cancel: () => {} },
  })
  t.after(() => service.dispose())
  assert.equal(service.snapshot().messages.filter((message) => message.initiative).length, 2)
  assert.deepEqual({ active, scopes, checks }, { active: false, scopes: 1, checks: 2 })
  permitted = false
  const hidden = service.snapshot().messages
  assert(hidden.every((message) => message.text === '' && message.error === 'assistant-proactive-source-unavailable'))
  assert.deepEqual({ active, scopes, checks }, { active: false, scopes: 2, checks: 4 })
  assert.equal(service.proactiveState().recentMessages.length, 0)
  assert.deepEqual({ active, scopes, checks }, { active: false, scopes: 3, checks: 6 })
  service.proactiveAttention()
  assert.equal(scopes, 3)
})

test('initiative projection exposes only selected task references, not internal follow-up notes', (t) => {
  const { store } = fixture(t)
  const original = decision({
    taskIds: ['selected-task'],
    followUps: [{ taskId: 'unrelated-follow-up', note: 'Internal assessment', nextReviewAt: NOW + 86_400_000 }],
  })
  store.appendProactiveInitiative(original)
  const initiative = store.conversation(null).messages[0]?.initiative
  assert.equal(initiative?.kind, 'offer')
  assert.deepEqual(initiative?.taskIds, ['selected-task'])
  assert(!JSON.stringify(initiative).includes('unrelated-follow-up'))
  assert(!JSON.stringify(initiative).includes('Internal assessment'))
  store.close()
})
